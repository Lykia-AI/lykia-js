/**
 * The connection to the remote Lykia MCP server (Streamable HTTP), as an MCP client.
 *
 * - Connects lazily with protocol negotiation (`server/discover` probe, falls back to the 2025 handshake).
 * - Reconnects after connection-level failures (server restart, dropped session) and retries a request once when it
 *   is safe: list/read/get methods always, `tools/call` only when the request cannot have been processed
 *   (connection refused, or a legacy session the server no longer knows).
 * - Forwards list-changed notifications: unsolicited on 2025-era connections, through a `subscriptions/listen`
 *   stream (re-opened after drops) on 2026-07-28 connections.
 */
import { Client, StreamableHTTPClientTransport, type AuthProvider } from '@modelcontextprotocol/client';
import type { Settings } from './config.js';
import { AuthRejectedError, LoginRequiredError } from './errors.js';
import { log } from './log.js';
import { VERSION } from './version.js';

export type ListKind = 'tools' | 'prompts' | 'resources';

export class UpstreamUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UpstreamUnavailableError';
  }
}

/** Walks an error and its `cause` / `data.cause` chain. */
function chain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause ?? (cur as { data?: { cause?: unknown } }).data?.cause;
  }
  return out;
}

const NETWORK_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT']);
const UNSENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);

function errCodes(err: unknown): string[] {
  return chain(err)
    .map((e) => (e as { code?: unknown }).code)
    .filter((c): c is string => typeof c === 'string');
}

function errCode(err: unknown): string | undefined {
  return errCodes(err)[0];
}

function httpStatus(err: unknown): number | undefined {
  const s = (err as { status?: unknown; data?: { status?: unknown } })?.status ?? (err as { data?: { status?: unknown } })?.data?.status;
  return typeof s === 'number' ? s : undefined;
}

/** The request never reached the server (or the server rejected the session before processing it). */
export function isNotProcessed(err: unknown): boolean {
  return errCodes(err).some((c) => UNSENT_CODES.has(c)) || httpStatus(err) === 404;
}

/** Any connection-level failure (as opposed to an MCP protocol error or a tool error). */
export function isConnectionError(err: unknown): boolean {
  if (unwrapAuthError(err)) return false;
  if (isNotProcessed(err)) return true;
  const codes = errCodes(err);
  if (codes.some((c) => NETWORK_CODES.has(c) || c === 'CONNECTION_CLOSED' || c === 'NOT_CONNECTED' || c === 'SEND_FAILED')) return true;
  const status = httpStatus(err);
  if (status !== undefined && (status === 502 || status === 503 || status === 504)) return true;
  return chain(err).some((e) => e instanceof TypeError && /fetch failed/i.test(e.message));
}

export function isAuthError(err: unknown): boolean {
  if (err instanceof LoginRequiredError || err instanceof AuthRejectedError) return true;
  const status = httpStatus(err);
  return status === 401 || status === 403 || errCode(err) === 'CLIENT_HTTP_AUTHENTICATION' || errCode(err) === 'CLIENT_HTTP_FORBIDDEN';
}

/** Finds our own auth errors wrapped inside SDK errors. */
export function unwrapAuthError(err: unknown): Error | undefined {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof LoginRequiredError || cur instanceof AuthRejectedError) return cur;
    cur = (cur as { cause?: unknown }).cause ?? (cur as { data?: { cause?: unknown } }).data?.cause;
  }
  return undefined;
}

export class Upstream {
  private client: Client | undefined;
  private connecting: Promise<Client> | undefined;
  private closed = false;
  private listeners = new Set<(kind: ListKind) => void>();
  private listenAbort: AbortController | undefined;

  constructor(
    private readonly settings: Settings,
    private readonly auth: AuthProvider,
  ) {}

  onListChanged(fn: (kind: ListKind) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(kind: ListKind) {
    for (const fn of this.listeners) {
      try {
        fn(kind);
      } catch (err) {
        log.debug('list-changed listener failed', err);
      }
    }
  }

  get connected(): Client | undefined {
    return this.client;
  }

  /** Returns a connected client, connecting if needed. */
  get(): Promise<Client> {
    if (this.closed) return Promise.reject(new UpstreamUnavailableError('The bridge is shutting down.'));
    if (this.client) return Promise.resolve(this.client);
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect(): Promise<Client> {
    const client = new Client(
      { name: 'lykia-mcp', version: VERSION, title: 'Lykia MCP bridge' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = new StreamableHTTPClientTransport(new URL(this.settings.mcpUrl), {
      authProvider: this.auth,
      requestInit: { headers: { 'User-Agent': `lykia-mcp/${VERSION}` } },
    });
    for (const kind of ['tools', 'prompts', 'resources'] as const) {
      client.setNotificationHandler(`notifications/${kind}/list_changed`, () => this.emit(kind));
    }
    client.onclose = () => {
      if (this.client === client) {
        log.debug('remote MCP connection closed');
        this.client = undefined;
        this.listenAbort?.abort();
      }
    };
    try {
      await client.connect(transport);
    } catch (err) {
      await client.close().catch(() => undefined);
      throw this.describe(err);
    }
    this.client = client;
    const info = client.getServerVersion();
    log.debug(`connected to ${info?.name ?? 'remote'} ${info?.version ?? ''} (${client.getProtocolEra() ?? '?'} era)`);
    if (client.getProtocolEra() === 'modern') this.startListening(client);
    return client;
  }

  /** Opens (and re-opens after drops) the 2026-07-28 change-notification stream. */
  private startListening(client: Client) {
    const caps = client.getServerCapabilities() ?? {};
    const filter = {
      ...(caps.tools?.listChanged ? { toolsListChanged: true } : {}),
      ...(caps.prompts?.listChanged ? { promptsListChanged: true } : {}),
      ...(caps.resources?.listChanged ? { resourcesListChanged: true } : {}),
    };
    if (Object.keys(filter).length === 0) return;
    const abort = new AbortController();
    this.listenAbort = abort;
    void (async () => {
      let delay = 1000;
      while (!abort.signal.aborted && this.client === client) {
        try {
          const sub = await client.listen(filter, { signal: abort.signal });
          delay = 1000;
          const reason = await sub.closed;
          if (reason !== 'remote') return;
        } catch (err) {
          if (abort.signal.aborted) return;
          log.debug('subscriptions/listen failed', err);
        }
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    })();
  }

  private describe(err: unknown): Error {
    const auth = unwrapAuthError(err);
    if (auth) return auth;
    if (isAuthError(err)) {
      return new AuthRejectedError(`The Lykia MCP server rejected the credentials (${(err as Error).message}).`);
    }
    if (isConnectionError(err) || err instanceof TypeError) {
      return new UpstreamUnavailableError(`Cannot reach the Lykia MCP server at ${this.settings.mcpUrl}: ${(err as Error).message}`, { cause: err });
    }
    return err as Error;
  }

  private async drop(client: Client) {
    if (this.client === client) this.client = undefined;
    this.listenAbort?.abort();
    await client.close().catch(() => undefined);
  }

  /**
   * Runs `fn` with a connected client. On a connection-level failure the connection is dropped and, if `retry`
   * allows it for that error, re-established and `fn` retried once.
   */
  async run<T>(fn: (client: Client) => Promise<T>, retry: 'idempotent' | 'unprocessed' | 'never'): Promise<T> {
    const client = await this.get();
    try {
      return await fn(client);
    } catch (err) {
      const auth = unwrapAuthError(err);
      if (auth) throw auth;
      if (!isConnectionError(err)) throw err;
      await this.drop(client);
      const canRetry = retry === 'idempotent' || (retry === 'unprocessed' && isNotProcessed(err));
      if (!canRetry) throw this.describe(err);
      log.debug('retrying after a connection failure', err);
      const again = await this.get();
      try {
        return await fn(again);
      } catch (err2) {
        if (isConnectionError(err2)) await this.drop(again);
        throw this.describe(err2);
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.listenAbort?.abort();
    const c = this.client;
    this.client = undefined;
    if (c) await c.close().catch(() => undefined);
  }
}
