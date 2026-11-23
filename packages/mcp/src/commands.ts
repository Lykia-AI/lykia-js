/**
 * CLI subcommands. Human-readable output goes to stderr; only machine output that the user asked for
 * (`config` snippets, `--json`) is written to stdout. The bridge itself never writes to stdout except MCP messages.
 */
import { stat } from 'node:fs/promises';
import type { AuthProvider } from '@modelcontextprotocol/client';
import { apiKeyAuthProvider, resolveAuthSource, sessionAuthProvider, type AuthSource } from './auth.js';
import { Bridge } from './bridge.js';
import { CLIENTS, buildSnippet, writeSnippet, type ClientName } from './clients.js';
import type { Settings } from './config.js';
import { AuthRejectedError, CliError, LOGIN_HINT, LoginRequiredError } from './errors.js';
import { log } from './log.js';
import { login, openBrowser, revokeSession } from './oauth.js';
import { deleteSession, loadSession, sessionPath } from './session.js';
import { Upstream } from './upstream.js';
import { VERSION } from './version.js';

const stdout = (text: string) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);

export async function cmdServe(settings: Settings): Promise<void> {
  let source: AuthSource;
  try {
    source = await resolveAuthSource(settings);
  } catch (err) {
    throw new CliError(`[lykia] ${(err as Error).message}`);
  }
  const auth: AuthProvider = source.kind === 'api-key' ? apiKeyAuthProvider(settings.apiKey!) : sessionAuthProvider(settings);
  const bridge = new Bridge({ settings, auth });
  log.debug(`bridge ${VERSION} → ${settings.mcpUrl} (${source.kind === 'api-key' ? 'API key' : 'OAuth session'})`);
  bridge.serve();
  let closing = false;
  const shutdown = async (code: number) => {
    if (closing) return;
    closing = true;
    await bridge.close();
    process.exit(code);
  };
  process.stdin.on('end', () => void shutdown(0));
  process.stdin.on('close', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
}

export async function cmdLogin(settings: Settings, opts: { scope?: string }): Promise<void> {
  if (settings.apiKey) {
    log.warn('LYKIA_API_KEY is set; the bridge uses it instead of a login session as long as it is set.');
  }
  log.info(`Signing in to Lykia (${settings.mcpUrl})…`);
  const session = await login(settings, {
    ...(opts.scope ? { scope: opts.scope } : {}),
    onAuthorizationUrl: async (url) => {
      const opened = settings.noBrowser ? false : await openBrowser(url.toString());
      log.info(opened ? 'Your browser was opened. If it did not open, visit this URL:' : 'Open this URL in your browser to sign in:');
      log.info(`  ${url.toString()}`);
      log.info('Waiting for the browser sign-in to finish (up to 5 minutes)…');
    },
  });
  log.info('Signed in. Choose the company and project in the browser; the session is stored at:');
  log.info(`  ${sessionPath(settings.configDir, settings.mcpUrl)}`);
  if (session.tokens.scope) log.info(`Granted scopes: ${session.tokens.scope}`);
  log.info('Run `npx @lykia/mcp whoami` to see which company and project this session uses.');
}

export async function cmdLogout(settings: Settings): Promise<void> {
  const session = await loadSession(settings.configDir, settings.mcpUrl);
  if (!session) {
    log.info('No stored Lykia session for this server; nothing to do.');
  } else {
    const revoked = await revokeSession(session);
    await deleteSession(settings.configDir, settings.mcpUrl);
    log.info(revoked ? 'Signed out: tokens revoked at Lykia and removed from this computer.' : 'Signed out: tokens removed from this computer (the server did not confirm revocation; you can also revoke the app under Settings → Connected apps).');
  }
  if (settings.apiKey) log.info('Note: LYKIA_API_KEY is still set in this environment and will keep working.');
}

interface KeyData {
  label?: string;
  limit?: number | null;
  usage?: number;
  limit_remaining?: number | null;
  company?: { id?: string; name?: string };
  project?: { id?: string; name?: string };
  scopes?: string[];
  [k: string]: unknown;
}

/** `GET {base}/key` with the bridge's credential (refreshing an OAuth token once on 401). */
async function fetchKey(settings: Settings, auth: AuthProvider): Promise<KeyData> {
  const call = async () =>
    fetch(`${settings.baseUrl}/key`, {
      headers: { Authorization: `Bearer ${await auth.token()}`, Accept: 'application/json', 'User-Agent': `lykia-mcp/${VERSION}` },
      signal: AbortSignal.timeout(20_000),
    });
  let res = await call();
  if (res.status === 401 && auth.onUnauthorized) {
    await auth.onUnauthorized({ response: res, serverUrl: new URL(settings.mcpUrl), fetchFn: fetch });
    res = await call();
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!res.ok) {
    const msg = (body as { error?: { message?: string } } | undefined)?.error?.message ?? text.slice(0, 200);
    if (res.status === 401) throw new AuthRejectedError(`Lykia rejected the credential (401: ${msg}). ${LOGIN_HINT}`);
    throw new Error(`GET ${settings.baseUrl}/key failed: ${res.status} ${msg}`);
  }
  return ((body as { data?: KeyData })?.data ?? body) as KeyData;
}

export async function cmdWhoami(settings: Settings, opts: { json: boolean }): Promise<void> {
  let source: AuthSource;
  try {
    source = await resolveAuthSource(settings);
  } catch (err) {
    throw new CliError((err as Error).message);
  }
  const auth = source.kind === 'api-key' ? apiKeyAuthProvider(settings.apiKey!) : sessionAuthProvider(settings);
  const key = await fetchKey(settings, auth);
  const session = source.kind === 'oauth' ? await loadSession(settings.configDir, settings.mcpUrl) : undefined;
  const info = {
    auth: source.kind === 'api-key' ? 'api_key' : 'oauth',
    mcp_url: settings.mcpUrl,
    company: key.company ?? null,
    project: key.project ?? null,
    label: key.label ?? null,
    limit: key.limit ?? null,
    usage: key.usage ?? null,
    limit_remaining: key.limit_remaining ?? null,
    scopes: key.scopes ?? (session?.tokens.scope ? session.tokens.scope.split(' ') : null),
    ...(session
      ? {
          issuer: session.issuer,
          client_id: session.client.client_id,
          access_token_expires_at: session.tokens.expires_at ? new Date(session.tokens.expires_at).toISOString() : null,
        }
      : {}),
  };
  if (opts.json) {
    stdout(JSON.stringify(info, null, 2));
    return;
  }
  const name = (x: { id?: string; name?: string } | null) => (x ? `${x.name ?? '?'}${x.id ? ` (${x.id})` : ''}` : 'unknown');
  log.info(`Signed in with ${info.auth === 'api_key' ? 'the API key in LYKIA_API_KEY' : 'a Lykia login session'}`);
  log.info(`  Company:  ${name(info.company)}`);
  log.info(`  Project:  ${name(info.project)}  (spending is recorded here)`);
  if (info.label) log.info(`  Label:    ${info.label}`);
  if (info.limit !== null) log.info(`  Limit:    $${info.limit} (used $${info.usage ?? 0}, remaining $${info.limit_remaining ?? '?'})`);
  if (info.scopes) log.info(`  Scopes:   ${info.scopes.join(' ')}`);
  if ('access_token_expires_at' in info && info.access_token_expires_at) log.info(`  Token expires: ${info.access_token_expires_at} (renewed automatically)`);
  log.info(`  Server:   ${info.mcp_url}`);
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export async function cmdDoctor(settings: Settings, opts: { json: boolean }): Promise<void> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('Node.js', major >= 20, `v${process.versions.node}${major >= 20 ? '' : ' (20 or newer required)'}`);

  try {
    const st = await stat(settings.configDir);
    const mode = st.mode & 0o777;
    add('Config directory', process.platform === 'win32' || (mode & 0o077) === 0, `${settings.configDir} (mode ${mode.toString(8)})`);
  } catch {
    add('Config directory', true, `${settings.configDir} (not created yet)`);
  }

  let source: AuthSource | undefined;
  try {
    source = await resolveAuthSource(settings);
    if (source.kind === 'oauth') {
      const st = await stat(sessionPath(settings.configDir, settings.mcpUrl));
      const mode = st.mode & 0o777;
      add('Credentials', process.platform === 'win32' || (mode & 0o077) === 0, `login session (file mode ${mode.toString(8)})`);
    } else {
      add('Credentials', true, 'LYKIA_API_KEY');
    }
  } catch (err) {
    add('Credentials', false, (err as Error).message);
  }

  try {
    const prm = new URL(settings.mcpUrl);
    const url = `${prm.origin}/.well-known/oauth-protected-resource${prm.pathname === '/' ? '' : prm.pathname}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    await res.body?.cancel().catch(() => undefined);
    add('Server reachable', res.status < 500, `${url} → ${res.status}`);
  } catch (err) {
    add('Server reachable', false, `${settings.mcpUrl}: ${(err as Error).message}`);
  }

  if (source) {
    const auth = source.kind === 'api-key' ? apiKeyAuthProvider(settings.apiKey!) : sessionAuthProvider(settings);
    const upstream = new Upstream(settings, auth);
    try {
      const client = await upstream.get();
      const info = client.getServerVersion();
      add('MCP connection', true, `${info?.name ?? 'server'} ${info?.version ?? ''}, protocol ${client.getNegotiatedProtocolVersion?.() ?? client.getProtocolEra() ?? '?'}`);
      const { tools } = await client.listTools();
      add('Tools', tools.length > 0, `${tools.length} remote tools (+ file_input, output_save local)`);
      const caps = client.getServerCapabilities() ?? {};
      if (caps.prompts) {
        const { prompts } = await client.listPrompts();
        add('Workflows (prompts)', true, `${prompts.length}`);
      }
    } catch (err) {
      add('MCP connection', false, (err as Error).message);
    } finally {
      await upstream.close();
    }
    try {
      const key = await fetchKey(settings, auth);
      add('Project', true, `${key.company?.name ?? '?'} / ${key.project?.name ?? '?'}`);
    } catch (err) {
      add('Project', false, (err as Error).message);
    }
  }

  if (opts.json) {
    stdout(JSON.stringify({ ok: checks.every((c) => c.ok), version: VERSION, checks }, null, 2));
  } else {
    log.info(`@lykia/mcp ${VERSION} doctor`);
    for (const c of checks) log.info(`  ${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  }
  if (!checks.every((c) => c.ok)) throw new CliError(opts.json ? '' : 'Some checks failed.', 1);
}

export async function cmdConfig(
  settings: Settings,
  opts: { client: string | undefined; remote: boolean; write: boolean; path?: string; name: string; project: boolean; allowDirs: string[] },
): Promise<void> {
  if (!opts.client || !(CLIENTS as readonly string[]).includes(opts.client)) {
    throw new CliError(`Usage: lykia-mcp config <${CLIENTS.join('|')}> [--remote] [--write] [--path <file>]`);
  }
  const snippet = buildSnippet({
    client: opts.client as ClientName,
    remote: opts.remote,
    mcpUrl: settings.mcpUrl,
    name: opts.name,
    allowDirs: opts.allowDirs,
    project: opts.project,
    cwd: process.cwd(),
  });
  if (snippet.json) stdout(JSON.stringify(snippet.json, null, 2));
  const target = opts.path ?? snippet.path;
  if (!opts.write) {
    if (target) log.info(`Add this to ${target} (or rerun with --write to merge it there, with a backup).`);
  } else {
    const result = await writeSnippet(snippet, opts.path);
    log.info(`${result.replaced ? 'Updated' : 'Added'} "${opts.name}" in ${result.path}${result.backup ? ` (backup: ${result.backup})` : ''}.`);
  }
  for (const n of snippet.notes) log.info(n);
}

export { LoginRequiredError };
