/**
 * stdio ↔ remote MCP bridge. Serves MCP over stdio (both the 2025 handshake era and the 2026-07-28 era) and
 * re-exposes whatever tools, prompts and resources the remote Lykia server lists, plus two local tools
 * (`file_input`, `output_save`). Nothing about the remote tool set is hard-coded here.
 */
import { fileURLToPath } from 'node:url';
import { ProtocolError, ProtocolErrorCode, Server } from '@modelcontextprotocol/server';
import { serveStdio, type StdioServerHandle } from '@modelcontextprotocol/server/stdio';
import type { AuthProvider } from '@modelcontextprotocol/client';
import type { Settings } from './config.js';
import { AuthRejectedError, LoginRequiredError } from './errors.js';
import { log } from './log.js';
import { FsGuard } from './local/fs-guard.js';
import { FileHandleStore, LOCAL_TOOL_NAMES, LOCAL_TOOLS, LocalToolError, ResultLinks, fileInput, outputSave, toolError } from './local/tools.js';
import { Upstream, UpstreamUnavailableError, type ListKind } from './upstream.js';
import { VERSION } from './version.js';

export interface BridgeOptions {
  settings: Settings;
  auth: AuthProvider;
  cwd?: string;
}

type Ctx = {
  mcpReq: {
    _meta?: Record<string, unknown>;
    signal: AbortSignal;
    notify: (n: { method: string; params?: Record<string, unknown> }) => Promise<void>;
  };
};

/** Rethrows an upstream MCP error with the same code, message and data; wraps anything else. */
function forwardError(err: unknown): never {
  const e = err as { code?: unknown; message?: string; data?: unknown };
  if (err instanceof ProtocolError) throw err;
  if (typeof e?.code === 'number' && Number.isInteger(e.code) && e.code < 0) {
    throw new ProtocolError(e.code, e.message ?? 'Remote error', e.data);
  }
  if (err instanceof LoginRequiredError || err instanceof AuthRejectedError || err instanceof UpstreamUnavailableError) {
    throw new ProtocolError(ProtocolErrorCode.InternalError, (err as Error).message);
  }
  throw new ProtocolError(ProtocolErrorCode.InternalError, `Lykia bridge: ${(err as Error)?.message ?? String(err)}`);
}

/** Drops keys the bridge owns (progress token) or the transport owns (protocol envelope) from a forwarded `_meta`. */
function forwardMeta(meta: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!meta) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'progressToken' || k.startsWith('io.modelcontextprotocol/')) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

export class Bridge {
  readonly upstream: Upstream;
  readonly store = new FileHandleStore();
  readonly resultLinks = new ResultLinks();
  private readonly servers = new Set<Server>();
  private readonly settings: Settings;
  private readonly auth: AuthProvider;
  private readonly guard: FsGuard;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private handle: StdioServerHandle | undefined;

  constructor(options: BridgeOptions) {
    this.settings = options.settings;
    this.auth = options.auth;
    this.upstream = new Upstream(options.settings, options.auth);
    this.guard = new FsGuard({
      cwd: options.cwd ?? process.cwd(),
      allowDirs: options.settings.allowDirs,
      clientRoots: () => this.clientRoots(),
    });
    if (this.guard.cwdExcluded) {
      log.warn(
        `The working directory (${this.guard.cwd}) is the filesystem root or the home directory, so it is not used for file_input/output_save. ` +
          'Pass --allow-dir <dir> to allow a folder.',
      );
    }
    this.upstream.onListChanged((kind) => this.broadcast(kind));
  }

  private broadcast(kind: ListKind) {
    for (const s of this.servers) {
      const send = kind === 'tools' ? s.sendToolListChanged() : kind === 'prompts' ? s.sendPromptListChanged() : s.sendResourceListChanged();
      void Promise.resolve(send).catch((err: unknown) => log.debug('could not forward list_changed', err));
    }
  }

  /** MCP roots from a 2025-era client that offers them (file:// only). */
  private async clientRoots(): Promise<string[]> {
    const out: string[] = [];
    for (const s of this.servers) {
      try {
        if (!s.getClientCapabilities()?.roots) continue;
        const { roots } = await s.listRoots(undefined, { timeout: 5000 });
        for (const r of roots) if (r.uri.startsWith('file://')) out.push(fileURLToPath(r.uri));
      } catch {
        // optional
      }
    }
    return out;
  }

  /** Remote unreachable: keep serving local tools and retry in the background; announce the remote tools when back. */
  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    let delay = 5000;
    const attempt = () => {
      this.reconnectTimer = setTimeout(async () => {
        try {
          await this.upstream.get();
          this.reconnectTimer = undefined;
          log.info('[lykia] reconnected to the Lykia MCP server');
          this.broadcast('tools');
          this.broadcast('prompts');
          this.broadcast('resources');
        } catch (err) {
          if (err instanceof LoginRequiredError || err instanceof AuthRejectedError) {
            this.reconnectTimer = undefined;
            log.error(err.message);
            return;
          }
          delay = Math.min(delay * 2, 60_000);
          attempt();
        }
      }, delay);
      this.reconnectTimer.unref?.();
    };
    attempt();
  }

  /** Builds the downstream server for one stdio connection. */
  createServer = async (): Promise<Server> => {
    let instructions: string | undefined;
    try {
      const client = await Promise.race([
        this.upstream.get(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000).unref?.()),
      ]);
      instructions = client.getInstructions();
    } catch (err) {
      log.warn(`Lykia MCP server not reachable yet (${(err as Error).message}); local tools stay available.`);
    }
    const server = new Server(
      { name: 'lykia', version: VERSION, title: 'Lykia', websiteUrl: 'https://getlykia.com' },
      {
        capabilities: {
          tools: { listChanged: true },
          prompts: { listChanged: true },
          resources: { listChanged: true },
        },
        ...(instructions ? { instructions } : {}),
      },
    );
    this.servers.add(server);
    server.onclose = () => this.servers.delete(server);
    this.register(server);
    return server;
  };

  private register(server: Server) {
    const remoteKinds = async () => this.upstream.connected?.getServerCapabilities() ?? {};

    server.setRequestHandler('tools/list', async () => {
      let remote: Array<{ name: string }> = [];
      try {
        remote = (await this.upstream.run((c) => c.listTools(undefined, { cacheMode: 'refresh' }), 'idempotent')).tools;
      } catch (err) {
        if (err instanceof UpstreamUnavailableError) {
          log.warn(`${err.message}. Listing local tools only; retrying in the background.`);
          this.scheduleReconnect();
        } else {
          forwardError(err);
        }
      }
      const filtered = remote.filter((t) => {
        if (!LOCAL_TOOL_NAMES.has(t.name)) return true;
        log.warn(`The remote server defines "${t.name}", which is a local bridge tool; the local one is used.`);
        return false;
      });
      return { tools: [...filtered, ...LOCAL_TOOLS] } as never;
    });

    server.setRequestHandler('tools/call', async (request, ctx) => {
      const c = ctx as unknown as Ctx;
      const { name } = request.params;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      if (name === 'file_input') return (await fileInput(args, { guard: this.guard, store: this.store, settings: this.settings })) as never;
      if (name === 'output_save') {
        return (await outputSave(args, {
          guard: this.guard,
          settings: this.settings,
          bearer: () => this.auth.token(),
          resultLinks: this.resultLinks,
          signal: c.mcpReq.signal,
        })) as never;
      }
      let expanded: Record<string, unknown>;
      try {
        expanded = this.store.expand(args) as Record<string, unknown>;
      } catch (err) {
        if (err instanceof LocalToolError) return toolError(err.message) as never;
        throw err;
      }
      const progressToken = c.mcpReq._meta?.['progressToken'] as string | number | undefined;
      const meta = forwardMeta(c.mcpReq._meta);
      try {
        const result = await this.upstream.run(
          (client) =>
            client.callTool(
              { name, arguments: expanded, ...(meta ? { _meta: meta } : {}) },
              {
                signal: c.mcpReq.signal,
                timeout: this.settings.requestTimeoutMs,
                maxTotalTimeout: this.settings.requestTimeoutMs,
                resetTimeoutOnProgress: true,
                ...(progressToken !== undefined
                  ? {
                      onprogress: (p: { progress: number; total?: number; message?: string }) => {
                        void c.mcpReq
                          .notify({
                            method: 'notifications/progress',
                            params: {
                              progressToken,
                              progress: p.progress,
                              ...(p.total !== undefined ? { total: p.total } : {}),
                              ...(p.message !== undefined ? { message: p.message } : {}),
                            },
                          })
                          .catch(() => undefined);
                      },
                    }
                  : {}),
              },
            ),
          'unprocessed',
        );
        this.resultLinks.collect(result);
        return result as never;
      } catch (err) {
        if (c.mcpReq.signal.aborted) throw err;
        if (err instanceof LoginRequiredError || err instanceof AuthRejectedError || err instanceof UpstreamUnavailableError) {
          return toolError(err.message) as never;
        }
        forwardError(err);
      }
    });

    server.setRequestHandler('prompts/list', async () => {
      if ((await this.upstream.get().catch(() => undefined)) && !(await remoteKinds()).prompts) return { prompts: [] };
      try {
        return (await this.upstream.run((c) => c.listPrompts(undefined, { cacheMode: 'refresh' }), 'idempotent')) as never;
      } catch (err) {
        if (err instanceof UpstreamUnavailableError) return { prompts: [] };
        forwardError(err);
      }
    });

    server.setRequestHandler('prompts/get', async (request) => {
      try {
        return (await this.upstream.run((c) => c.getPrompt(request.params), 'idempotent')) as never;
      } catch (err) {
        forwardError(err);
      }
    });

    server.setRequestHandler('resources/list', async () => {
      if ((await this.upstream.get().catch(() => undefined)) && !(await remoteKinds()).resources) return { resources: [] };
      try {
        return (await this.upstream.run((c) => c.listResources(undefined, { cacheMode: 'refresh' }), 'idempotent')) as never;
      } catch (err) {
        if (err instanceof UpstreamUnavailableError) return { resources: [] };
        forwardError(err);
      }
    });

    server.setRequestHandler('resources/templates/list', async () => {
      if ((await this.upstream.get().catch(() => undefined)) && !(await remoteKinds()).resources) return { resourceTemplates: [] };
      try {
        return (await this.upstream.run((c) => c.listResourceTemplates(undefined, { cacheMode: 'refresh' }), 'idempotent')) as never;
      } catch (err) {
        if (err instanceof UpstreamUnavailableError) return { resourceTemplates: [] };
        forwardError(err);
      }
    });

    server.setRequestHandler('resources/read', async (request) => {
      try {
        return (await this.upstream.run((c) => c.readResource(request.params, { cacheMode: 'bypass' }), 'idempotent')) as never;
      } catch (err) {
        forwardError(err);
      }
    });
  }

  /** Serves the bridge on this process's stdio until the client disconnects. */
  serve(): StdioServerHandle {
    this.handle = serveStdio(this.createServer, { onerror: (err) => log.debug('stdio error', err) });
    return this.handle;
  }

  async close(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this.handle?.close().catch(() => undefined);
    await this.upstream.close();
  }
}
