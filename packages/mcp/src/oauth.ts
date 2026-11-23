/**
 * OAuth 2.1 for the Lykia MCP server (MCP authorization spec 2026-07-28):
 * protected resource metadata (RFC 9728) → authorization server metadata (RFC 8414 / OIDC discovery) →
 * client registration (pre-registered id, Client ID Metadata Document, or dynamic registration RFC 7591) →
 * authorization code + PKCE S256 with a loopback redirect on 127.0.0.1 and a random port, `state`, `iss`
 * (RFC 9207) and resource indicator (RFC 8707) → token exchange. Discovery, registration, PKCE, `iss` and
 * `resource` handling come from the official MCP TypeScript SDK (`auth()`); this module drives it from a CLI.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  auth,
  extractWWWAuthenticateParams,
  refreshAuthorization,
  validateAuthorizationResponseIssuer,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/client';
import { canonicalResource, type Settings } from './config.js';
import { LoginRequiredError } from './errors.js';
import { log, registerSecret, sdkLogger } from './log.js';
import {
  deleteSession,
  loadSession,
  saveSession,
  withSessionLock,
  type Session,
  type StoredTokens,
} from './session.js';
import { VERSION } from './version.js';

function toStored(tokens: { access_token: string; token_type?: string; refresh_token?: string; scope?: string; expires_in?: number }): StoredTokens {
  registerSecret(tokens.access_token);
  registerSecret(tokens.refresh_token);
  return {
    access_token: tokens.access_token,
    token_type: tokens.token_type ?? 'Bearer',
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.scope ? { scope: tokens.scope } : {}),
    ...(typeof tokens.expires_in === 'number' ? { expires_at: Date.now() + tokens.expires_in * 1000 } : {}),
  };
}

/** Opens a URL in the default browser. Never throws; returns false if it could not. */
export async function openBrowser(url: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args as string[], { stdio: 'ignore', detached: true });
      child.on('error', () => resolve(false));
      child.on('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

const CALLBACK_HTML = (ok: boolean) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Lykia</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111}</style></head>
<body><h1>lykia.</h1><p>${ok ? 'Signed in. You can close this window and return to your terminal.' : 'Sign-in did not complete. Return to your terminal for details.'}</p>
<p lang="tr">${ok ? 'Giriş yapıldı. Bu pencereyi kapatıp terminale dönebilirsiniz.' : 'Giriş tamamlanmadı. Ayrıntı için terminale dönün.'}</p></body></html>`;

interface LoopbackServer {
  redirectUrl: string;
  waitForCallback: (timeoutMs: number) => Promise<URLSearchParams>;
  close: () => Promise<void>;
}

/** Loopback redirect receiver on 127.0.0.1 with an OS-assigned port (RFC 8252 §7.3). */
async function startLoopback(): Promise<LoopbackServer> {
  let deliver: ((p: URLSearchParams) => void) | undefined;
  const received = new Promise<URLSearchParams>((resolve) => (deliver = resolve));
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const ok = url.searchParams.has('code') && !url.searchParams.has('error');
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(CALLBACK_HTML(ok));
    deliver?.(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    redirectUrl: `http://127.0.0.1:${port}/callback`,
    waitForCallback: (timeoutMs) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`No browser callback within ${Math.round(timeoutMs / 1000)} s; login cancelled.`)), timeoutMs);
        void received.then((p) => {
          clearTimeout(t);
          resolve(p);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** In-memory provider for one interactive login; the result is persisted as a {@link Session}. */
class LoginProvider implements OAuthClientProvider {
  sdkLogger = sdkLogger;
  lastState: string | undefined;
  authorizationUrl: URL | undefined;
  client: Record<string, unknown> | undefined;
  tokenSet: Record<string, unknown> | undefined;
  discovery: OAuthDiscoveryState | undefined;
  resource: string | undefined;
  private verifier: string | undefined;

  constructor(
    readonly redirectUrl: string,
    private readonly settings: Settings,
    private readonly onRedirect: (url: URL) => Promise<void>,
  ) {
    if (settings.oauthClientMetadataUrl) this.clientMetadataUrl = settings.oauthClientMetadataUrl;
  }

  clientMetadataUrl?: string;

  get clientMetadata() {
    return {
      client_name: 'Lykia MCP bridge (@lykia/mcp)',
      client_uri: 'https://getlykia.com',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      application_type: 'native' as const,
      software_id: 'lykia-mcp',
      software_version: VERSION,
    };
  }

  state(): string {
    this.lastState = randomBytes(32).toString('base64url');
    return this.lastState;
  }

  clientInformation() {
    if (this.settings.oauthClientId) return { client_id: this.settings.oauthClientId };
    return this.client as { client_id: string } | undefined;
  }

  saveClientInformation(info: Record<string, unknown>) {
    registerSecret(info['client_secret'] as string | undefined);
    this.client = info;
  }

  tokens() {
    return this.tokenSet as { access_token: string; token_type: string } | undefined;
  }

  saveTokens(tokens: Record<string, unknown>) {
    registerSecret(tokens['access_token'] as string);
    registerSecret(tokens['refresh_token'] as string | undefined);
    this.tokenSet = tokens;
  }

  async redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
    await this.onRedirect(url);
  }

  saveCodeVerifier(v: string) {
    registerSecret(v);
    this.verifier = v;
  }

  codeVerifier() {
    if (!this.verifier) throw new Error('PKCE code verifier missing');
    return this.verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState) {
    this.discovery = state;
  }

  discoveryState() {
    return this.discovery;
  }

  saveResourceUrl(url: string) {
    this.resource = url;
  }
}

/** Unauthenticated probe of the MCP endpoint to read the `WWW-Authenticate` challenge (resource metadata URL, scope). */
async function probeChallenge(mcpUrl: string): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const res = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Method': 'server/discover' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 401) return {};
    const params = extractWWWAuthenticateParams(res);
    return {
      ...(params.resourceMetadataUrl ? { resourceMetadataUrl: params.resourceMetadataUrl } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
    };
  } catch (err) {
    throw new Error(`Cannot reach the Lykia MCP server at ${mcpUrl}: ${(err as Error).message}`, { cause: err });
  }
}

export interface LoginOptions {
  /** Called with the authorization URL (print it; open a browser). */
  onAuthorizationUrl: (url: URL) => Promise<void>;
  /** How long to wait for the browser callback (default 5 minutes). */
  timeoutMs?: number;
  /** Requested scope (default: the server's challenge or `scopes_supported`). */
  scope?: string;
}

/** Interactive login. Persists and returns the new session. */
export async function login(settings: Settings, options: LoginOptions): Promise<Session> {
  const loopback = await startLoopback();
  try {
    const challenge = await probeChallenge(settings.mcpUrl);
    const provider = new LoginProvider(loopback.redirectUrl, settings, options.onAuthorizationUrl);
    const common = {
      serverUrl: settings.mcpUrl,
      ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
    };
    const first = await auth(provider, { ...common, ...(options.scope ?? challenge.scope ? { scope: options.scope ?? challenge.scope } : {}) });
    if (first !== 'REDIRECT' || !provider.authorizationUrl) {
      throw new Error('The authorization server did not start a browser sign-in.');
    }
    const params = await loopback.waitForCallback(options.timeoutMs ?? 5 * 60 * 1000);
    const metadata = provider.discovery?.authorizationServerMetadata;
    const iss = params.get('iss') ?? undefined;
    // RFC 9207: validate `iss` before acting on the response, including error responses.
    validateAuthorizationResponseIssuer({
      iss,
      expectedIssuer: metadata?.issuer,
      issParameterSupported: metadata?.authorization_response_iss_parameter_supported === true,
    });
    if (params.get('state') !== provider.lastState) {
      throw new Error('OAuth state mismatch: the browser response does not belong to this login. Try again.');
    }
    const error = params.get('error');
    if (error) {
      throw new Error(error === 'access_denied' ? 'Sign-in was cancelled in the browser (access_denied).' : `Authorization failed: ${error}`);
    }
    const code = params.get('code');
    if (!code) throw new Error('The browser response carried no authorization code.');
    registerSecret(code);
    const result = await auth(provider, { ...common, authorizationCode: code, ...(iss ? { iss } : {}) });
    if (result !== 'AUTHORIZED' || !provider.tokenSet) throw new Error('Token exchange did not complete.');

    const asMeta = (provider.discovery?.authorizationServerMetadata ?? {}) as Record<string, unknown>;
    const now = new Date().toISOString();
    const session: Session = {
      version: 1,
      mcpUrl: settings.mcpUrl,
      resource: provider.resource ?? canonicalResource(settings.mcpUrl),
      issuer: String(asMeta['issuer'] ?? provider.discovery?.authorizationServerUrl ?? ''),
      authorizationServerUrl: String(provider.discovery?.authorizationServerUrl ?? asMeta['issuer'] ?? ''),
      tokenEndpoint: String(asMeta['token_endpoint'] ?? ''),
      ...(typeof asMeta['revocation_endpoint'] === 'string' ? { revocationEndpoint: asMeta['revocation_endpoint'] } : {}),
      authorizationServerMetadata: asMeta,
      client: provider.clientInformation() as Session['client'],
      tokens: toStored(provider.tokenSet as unknown as Parameters<typeof toStored>[0]),
      createdAt: now,
      updatedAt: now,
    };
    await saveSession(settings.configDir, session);
    return session;
  } finally {
    await loopback.close();
  }
}

function isFatalOAuthError(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  return code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client';
}

/**
 * Refreshes the session's tokens (with rotation) under the cross-process lock. If another process already
 * rotated the tokens, its result is adopted instead of refreshing again (refresh-token reuse revokes the grant).
 * On a definitive refusal the session is deleted and {@link LoginRequiredError} is thrown.
 */
export async function refreshSession(settings: Settings, usedAccessToken: string | undefined): Promise<Session> {
  return withSessionLock(settings.configDir, settings.mcpUrl, async () => {
    const current = await loadSession(settings.configDir, settings.mcpUrl);
    if (!current) throw new LoginRequiredError('You are not signed in to Lykia.');
    const stillFresh = !current.tokens.expires_at || current.tokens.expires_at - 60_000 > Date.now();
    if (usedAccessToken !== undefined && current.tokens.access_token !== usedAccessToken && stillFresh) {
      return current; // someone else refreshed already
    }
    if (!current.tokens.refresh_token) {
      await deleteSession(settings.configDir, settings.mcpUrl);
      throw new LoginRequiredError('Your Lykia session expired.');
    }
    try {
      const tokens = await refreshAuthorization(current.authorizationServerUrl, {
        metadata: current.authorizationServerMetadata as never,
        clientInformation: current.client as never,
        refreshToken: current.tokens.refresh_token,
        resource: current.resource,
      });
      const next: Session = {
        ...current,
        tokens: toStored(tokens as Parameters<typeof toStored>[0]),
        updatedAt: new Date().toISOString(),
      };
      await saveSession(settings.configDir, next);
      log.debug('session refreshed');
      return next;
    } catch (err) {
      if (isFatalOAuthError(err)) {
        await deleteSession(settings.configDir, settings.mcpUrl);
        throw new LoginRequiredError('Your Lykia session expired or was revoked, so it was removed.');
      }
      throw new Error(`Could not refresh the Lykia session: ${(err as Error).message}`, { cause: err });
    }
  });
}

/** RFC 7009 token revocation. Returns false when the server has no revocation endpoint or refused. */
export async function revokeSession(session: Session): Promise<boolean> {
  if (!session.revocationEndpoint) return false;
  let ok = true;
  for (const [token, hint] of [
    [session.tokens.refresh_token, 'refresh_token'],
    [session.tokens.access_token, 'access_token'],
  ] as const) {
    if (!token) continue;
    const body = new URLSearchParams({ token, token_type_hint: hint });
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    const { client_id, client_secret, token_endpoint_auth_method } = session.client;
    if (client_secret && token_endpoint_auth_method !== 'client_secret_post') {
      headers['Authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(client_id)}:${encodeURIComponent(client_secret)}`).toString('base64')}`;
    } else {
      body.set('client_id', client_id);
      if (client_secret) body.set('client_secret', client_secret);
    }
    try {
      const res = await fetch(session.revocationEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) ok = false;
      await res.body?.cancel().catch(() => undefined);
    } catch {
      ok = false;
    }
  }
  return ok;
}
