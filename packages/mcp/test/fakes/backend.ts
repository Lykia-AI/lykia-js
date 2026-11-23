/**
 * Fake Lykia backend for the MCP tests, on one ephemeral 127.0.0.1 port, following CORE_MODEL.md §12:
 *
 * - OAuth 2.1 authorization server: RFC 8414 metadata (with `iss` support, RFC 9207), dynamic client registration
 *   (RFC 7591), Client ID Metadata Documents (the bridge's well-known URL is accepted without fetching it),
 *   authorization code + PKCE S256 with exact redirect_uri matching (loopback port may vary for CIMD clients),
 *   resource indicators (RFC 8707), refresh-token rotation with reuse detection (reuse revokes the grant), RFC 7009
 *   revocation. The authorize endpoint auto-approves (it stands in for the consent page).
 * - Protected resource metadata (RFC 9728) for `/mcp`, 401 + `WWW-Authenticate: Bearer resource_metadata=…, scope=…`.
 * - Remote MCP server (Streamable HTTP, both protocol eras) built with the official SDK: tools with progress,
 *   cancellation, large results, file inputs; prompts; resources; list-changed notifications.
 * - `GET /v1/key` returning company and project for API keys and OAuth access tokens; `/files/*` downloads.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

export const TEST_API_KEY = 'lyk-v1-' + 'b'.repeat(64);
export const CIMD_URL = 'https://getlykia.com/oauth/clients/lykia-mcp.json';
const SCOPES = ['models:read', 'chat', 'images', 'videos', 'speech', 'usage:read'];

export interface BackendOptions {
  /** Advertise Client ID Metadata Document support (default true). */
  cimd?: boolean;
  /** Offer dynamic client registration (default true). */
  dcr?: boolean;
  /** Access token lifetime in seconds (default 3600). */
  accessTtl?: number;
  /** Fixed port (for restart tests). */
  port?: number;
}

interface Client {
  client_id: string;
  redirect_uris: string[];
  application_type?: string;
}
interface Grant {
  id: string;
  clientId: string;
  scope: string;
  revoked: boolean;
}
interface Token {
  grantId: string;
  expiresAt: number;
  used?: boolean;
}

export interface BackendState {
  clients: Map<string, Client>;
  registrations: Array<Record<string, unknown>>;
  authorizeRequests: URLSearchParams[];
  tokenRequests: URLSearchParams[];
  revocations: URLSearchParams[];
  grants: Map<string, Grant>;
  refreshCount: number;
  reuseDetected: number;
  cancelled: string[];
  mcpAuthHeaders: string[];
  /** Tools added at runtime (to exercise list_changed). */
  extraTools: string[];
  deny: boolean;
  badIss: boolean;
}

export interface FakeBackend {
  origin: string;
  mcpUrl: string;
  baseUrl: string;
  port: number;
  state: BackendState;
  /** Revokes every access token (the next MCP request gets 401 and must refresh). */
  expireAccessTokens(): void;
  /** Adds a tool and notifies subscribed clients. */
  addTool(name: string): void;
  /** Stops and restarts the HTTP server on the same port (state kept). */
  restart(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

const b64url = (b: Buffer) => b.toString('base64url');

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }).end(JSON.stringify(body));
}

export async function startBackend(opts: BackendOptions = {}): Promise<FakeBackend> {
  const cimd = opts.cimd ?? true;
  const dcr = opts.dcr ?? true;
  const accessTtl = opts.accessTtl ?? 3600;
  const state: BackendState = {
    clients: new Map(),
    registrations: [],
    authorizeRequests: [],
    tokenRequests: [],
    revocations: [],
    grants: new Map(),
    refreshCount: 0,
    reuseDetected: 0,
    cancelled: [],
    mcpAuthHeaders: [],
    extraTools: [],
    deny: false,
    badIss: false,
  };
  const codes = new Map<string, { clientId: string; redirectUri: string; challenge: string; resource: string; scope: string }>();
  const accessTokens = new Map<string, Token>();
  const refreshTokens = new Map<string, Token>();
  let origin = '';
  const resource = () => `${origin}/mcp`;

  const mcpHandler = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'lykia-fake', version: '9.9.9' },
      { instructions: 'Fake Lykia server for tests.', capabilities: { tools: { listChanged: true }, prompts: { listChanged: true }, resources: { listChanged: true } } },
    );
    server.registerTool(
      'echo',
      { description: 'Echo the text back', inputSchema: z.object({ text: z.string() }), annotations: { readOnlyHint: true } },
      async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
    );
    server.registerTool(
      'slow',
      { description: 'Reports progress, honours cancellation', inputSchema: z.object({ steps: z.number().int(), id: z.string() }) },
      async ({ steps, id }, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken;
        for (let i = 1; i <= steps; i++) {
          if (ctx.mcpReq.signal.aborted) {
            state.cancelled.push(id);
            return { content: [{ type: 'text', text: 'cancelled' }] };
          }
          if (token !== undefined) {
            await ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: steps, message: `step ${i}` } });
          }
          await new Promise((r) => setTimeout(r, 60));
        }
        if (ctx.mcpReq.signal.aborted) state.cancelled.push(id);
        return { content: [{ type: 'text', text: `done ${steps}` }] };
      },
    );
    server.registerTool('big', { description: 'Large result', inputSchema: z.object({ mb: z.number() }) }, async ({ mb }) => ({
      content: [{ type: 'text', text: 'x'.repeat(Math.round(mb * 1024 * 1024)) }],
    }));
    server.registerTool(
      'image_generate',
      { description: 'Accepts an input image (data: URI or https URL)', inputSchema: z.object({ prompt: z.string(), images: z.array(z.string()).optional() }) },
      async ({ prompt, images }) => ({
        content: [
          { type: 'text', text: JSON.stringify({ prompt, inputs: (images ?? []).map((s) => s.slice(0, 30)), sizes: (images ?? []).map((s) => s.length) }) },
          { type: 'text', text: `${origin}/files/result.png` },
          // Free text: never trusted by output_save, even though it looks like a result link.
          { type: 'text', text: `${origin.replace('127.0.0.1', 'localhost')}/files/result.png?from=text` },
        ],
        // A signed storage link on a host that is not on the bridge's download allow-list.
        structuredContent: { id: 'gen-fake', images: [{ url: `${origin.replace('127.0.0.1', 'localhost')}/files/result.png?sig=1`, mime_type: 'image/png' }] },
      }),
    );
    server.registerTool('fails', { description: 'Always a tool error', inputSchema: z.object({}) }, async () => ({
      content: [{ type: 'text', text: 'Insufficient credits' }],
      isError: true,
    }));
    for (const name of state.extraTools) {
      server.registerTool(name, { description: `Added at runtime: ${name}`, inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: name }] }));
    }
    server.registerPrompt(
      'product-ad',
      { description: 'Ad from a product image', argsSchema: { product: z.string() } },
      async ({ product }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `Make an ad for ${product}` } }] }),
    );
    server.registerResource('readme', 'lykia://docs/readme', { mimeType: 'text/markdown' }, async (uri) => ({
      contents: [{ uri: uri.href, text: '# Lykia' }],
    }));
    return server;
  });
  const mcpNode = toNodeHandler(mcpHandler);

  const bearerOk = (header: string | undefined): boolean => {
    const m = /^Bearer\s+(\S+)$/.exec(header ?? '');
    if (!m) return false;
    if (m[1] === TEST_API_KEY) return true;
    const t = accessTokens.get(m[1]!);
    if (!t || t.expiresAt < Date.now()) return false;
    const g = state.grants.get(t.grantId);
    return Boolean(g && !g.revoked);
  };

  const challenge = (res: ServerResponse) =>
    json(res, 401, { error: 'invalid_token', error_description: 'Missing or invalid access token' }, {
      'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${SCOPES.join(' ')}"`,
    });

  const issue = (grantId: string, scope: string) => {
    const access = `at_${b64url(randomBytes(24))}`;
    const refresh = `rt_${b64url(randomBytes(24))}`;
    accessTokens.set(access, { grantId, expiresAt: Date.now() + accessTtl * 1000 });
    refreshTokens.set(refresh, { grantId, expiresAt: Date.now() + 60 * 24 * 3600 * 1000 });
    return { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, scope };
  };

  const isLoopbackRedirect = (uri: string) => {
    try {
      const u = new URL(uri);
      return u.protocol === 'http:' && u.hostname === '127.0.0.1';
    } catch {
      return false;
    }
  };

  const clientFor = (clientId: string): Client | undefined => {
    if (cimd && clientId === CIMD_URL) {
      return { client_id: CIMD_URL, redirect_uris: ['http://127.0.0.1/callback'], application_type: 'native' };
    }
    return state.clients.get(clientId);
  };

  const redirectAllowed = (client: Client, uri: string) =>
    client.client_id === CIMD_URL
      ? isLoopbackRedirect(uri) && new URL(uri).pathname === '/callback' // RFC 8252: any loopback port
      : client.redirect_uris.includes(uri);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', origin);
    const p = url.pathname;

    if (p === '/.well-known/oauth-protected-resource/mcp' || p === '/.well-known/oauth-protected-resource') {
      return json(res, 200, { resource: resource(), authorization_servers: [origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'] });
    }
    if (p === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: origin,
        authorization_endpoint: `${origin}/oauth/authorize`,
        token_endpoint: `${origin}/oauth/token`,
        revocation_endpoint: `${origin}/oauth/revoke`,
        ...(dcr ? { registration_endpoint: `${origin}/oauth/register` } : {}),
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: SCOPES,
        authorization_response_iss_parameter_supported: true,
        client_id_metadata_document_supported: cimd,
      });
    }
    if (p === '/oauth/register' && req.method === 'POST' && dcr) {
      const body = JSON.parse((await readBody(req)).toString()) as Record<string, unknown>;
      state.registrations.push(body);
      const uris = body['redirect_uris'] as string[];
      if (!Array.isArray(uris) || !uris.every(isLoopbackRedirect)) return json(res, 400, { error: 'invalid_redirect_uri' });
      const client: Client = { client_id: `cl_${b64url(randomBytes(9))}`, redirect_uris: uris, application_type: body['application_type'] as string };
      state.clients.set(client.client_id, client);
      return json(res, 201, { ...body, client_id: client.client_id, client_id_issued_at: Math.floor(Date.now() / 1000) });
    }
    if (p === '/oauth/authorize' && req.method === 'GET') {
      const q = url.searchParams;
      state.authorizeRequests.push(q);
      const client = clientFor(q.get('client_id') ?? '');
      const redirectUri = q.get('redirect_uri') ?? '';
      if (!client || !redirectAllowed(client, redirectUri)) return json(res, 400, { error: 'invalid_request', error_description: 'unknown client or redirect_uri' });
      const back = new URL(redirectUri);
      back.searchParams.set('state', q.get('state') ?? '');
      back.searchParams.set('iss', state.badIss ? 'https://evil.example' : origin);
      if (state.deny) {
        back.searchParams.set('error', 'access_denied');
      } else if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || q.get('resource') !== resource()) {
        back.searchParams.set('error', 'invalid_request');
      } else {
        const code = `code_${b64url(randomBytes(16))}`;
        codes.set(code, { clientId: client.client_id, redirectUri, challenge: q.get('code_challenge')!, resource: q.get('resource')!, scope: q.get('scope') ?? SCOPES.join(' ') });
        back.searchParams.set('code', code);
      }
      res.writeHead(302, { Location: back.toString() }).end();
      return;
    }
    if (p === '/oauth/token' && req.method === 'POST') {
      const form = new URLSearchParams((await readBody(req)).toString());
      state.tokenRequests.push(form);
      if (form.get('resource') !== resource()) return json(res, 400, { error: 'invalid_target' });
      if (form.get('grant_type') === 'authorization_code') {
        const c = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!c || c.clientId !== form.get('client_id') || c.redirectUri !== form.get('redirect_uri') || b64url(createHash('sha256').update(verifier).digest()) !== c.challenge) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        const grant: Grant = { id: `gr_${b64url(randomBytes(6))}`, clientId: c.clientId, scope: c.scope, revoked: false };
        state.grants.set(grant.id, grant);
        return json(res, 200, issue(grant.id, c.scope));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const t = refreshTokens.get(form.get('refresh_token') ?? '');
        const g = t ? state.grants.get(t.grantId) : undefined;
        if (!t || !g || g.revoked || g.clientId !== form.get('client_id')) return json(res, 400, { error: 'invalid_grant' });
        if (t.used) {
          state.reuseDetected++;
          g.revoked = true; // refresh-token reuse: revoke the whole grant
          return json(res, 400, { error: 'invalid_grant', error_description: 'refresh token reuse' });
        }
        t.used = true;
        state.refreshCount++;
        return json(res, 200, issue(g.id, g.scope));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/oauth/revoke' && req.method === 'POST') {
      const form = new URLSearchParams((await readBody(req)).toString());
      state.revocations.push(form);
      const token = form.get('token') ?? '';
      const t = refreshTokens.get(token) ?? accessTokens.get(token);
      if (t) {
        const g = state.grants.get(t.grantId);
        if (g) g.revoked = true;
      }
      return json(res, 200, {});
    }
    if (p === '/v1/key') {
      const auth = req.headers.authorization;
      if (!bearerOk(auth)) return json(res, 401, { error: { message: 'Invalid credential', type: 'authentication_error', code: 'invalid_api_key', metadata: { reason: 'invalid_request' } } });
      const isKey = auth === `Bearer ${TEST_API_KEY}`;
      return json(res, 200, {
        data: {
          label: isKey ? 'lyk-v1-bbbb…bbbb' : 'Connected app: Lykia MCP bridge',
          limit: null,
          limit_reset: null,
          usage: 0.42,
          limit_remaining: null,
          company: { id: 'cmp_1', name: 'Acme' },
          project: { id: 'prj_1', name: 'Ads' },
          ...(isKey ? {} : { scopes: SCOPES }),
        },
      });
    }
    if (p.startsWith('/files/')) {
      if (p === '/files/redirect') {
        res.writeHead(302, { Location: `${origin}/files/result.png` }).end();
        return;
      }
      if (p === '/files/needs-auth') {
        if (!bearerOk(req.headers.authorization)) return json(res, 401, { error: 'auth' });
      }
      if (p === '/files/huge') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end(Buffer.alloc(3 * 1024 * 1024));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'image/png', 'X-Saw-Authorization': req.headers.authorization ? 'yes' : 'no' });
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
      return;
    }
    if (p === '/mcp') {
      state.mcpAuthHeaders.push(req.headers.authorization ?? '');
      if (!bearerOk(req.headers.authorization)) {
        await readBody(req);
        return challenge(res);
      }
      return void mcpNode(req, res);
    }
    json(res, 404, { error: 'not found' });
  };

  let server: Server;
  const listen = async (port: number) => {
    server = createServer((req, res) => {
      handle(req, res).catch((err: unknown) => {
        if (!res.headersSent) json(res, 500, { error: String(err) });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    return (server.address() as AddressInfo).port;
  };
  const port = await listen(opts.port ?? 0);
  origin = `http://127.0.0.1:${port}`;
  const stopServer = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    baseUrl: `${origin}/v1`,
    port,
    state,
    expireAccessTokens() {
      for (const t of accessTokens.values()) t.expiresAt = 0;
    },
    addTool(name) {
      state.extraTools.push(name);
      mcpHandler.notify.toolsChanged();
    },
    async restart() {
      await stopServer();
      await listen(port);
    },
    stop: stopServer,
    async close() {
      await mcpHandler.close().catch(() => undefined);
      await stopServer();
    },
  };
}
