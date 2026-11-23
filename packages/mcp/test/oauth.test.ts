import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sessionAuthProvider } from '../src/auth.js';
import { loadSettings, type Settings } from '../src/config.js';
import { LoginRequiredError } from '../src/errors.js';
import { login, refreshSession, revokeSession } from '../src/oauth.js';
import { loadSession, sessionPath } from '../src/session.js';
import { CIMD_URL, startBackend, type FakeBackend } from './fakes/backend.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(opts: Parameters<typeof startBackend>[0] = {}): Promise<{ backend: FakeBackend; settings: Settings; dir: string }> {
  const backend = await startBackend(opts);
  const dir = mkdtempSync(join(tmpdir(), 'lykia-oauth-'));
  cleanups.push(() => backend.close(), () => rmSync(dir, { recursive: true, force: true }));
  const saved = { ...process.env };
  process.env['LYKIA_MCP_URL'] = backend.mcpUrl;
  process.env['LYKIA_BASE_URL'] = backend.baseUrl;
  process.env['LYKIA_CONFIG_DIR'] = dir;
  const settings = loadSettings({ noBrowser: true });
  process.env = saved;
  return { backend, settings, dir };
}

/** Plays the browser: follows the authorization URL to the loopback redirect. */
async function browser(url: URL): Promise<void> {
  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location');
  if (!location) throw new Error(`authorize answered ${res.status}: ${await res.text()}`);
  await fetch(location);
}

describe('login', () => {
  it('uses the Client ID Metadata Document when the server supports it (PKCE S256, state, iss, resource)', async () => {
    const { backend, settings, dir } = await setup({ cimd: true });
    const session = await login(settings, { onAuthorizationUrl: async (url) => void setTimeout(() => void browser(url), 10) });
    expect(session.client.client_id).toBe(CIMD_URL);
    expect(backend.state.registrations).toHaveLength(0);
    const q = backend.state.authorizeRequests[0]!;
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('resource')).toBe(backend.mcpUrl);
    expect(q.get('state')!.length).toBeGreaterThan(20);
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(q.get('scope')).toBe('models:read chat images videos speech usage:read');
    expect(backend.state.tokenRequests[0]!.get('code_verifier')).toBeTruthy();
    const path = sessionPath(dir, backend.mcpUrl);
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'sessions')).mode & 0o777).toBe(0o700);
    }
    expect((await loadSession(dir, backend.mcpUrl))?.tokens.refresh_token).toMatch(/^rt_/);
  });

  it('falls back to dynamic client registration as a native app with a loopback redirect', async () => {
    const { backend, settings } = await setup({ cimd: false });
    const session = await login(settings, { onAuthorizationUrl: async (url) => void setTimeout(() => void browser(url), 10) });
    expect(backend.state.registrations).toHaveLength(1);
    const reg = backend.state.registrations[0]!;
    expect(reg['application_type']).toBe('native');
    expect(reg['token_endpoint_auth_method']).toBe('none');
    expect(reg['grant_types']).toEqual(['authorization_code', 'refresh_token']);
    expect((reg['redirect_uris'] as string[])[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(session.client.client_id).toMatch(/^cl_/);
  });

  it('rejects a callback whose iss does not match (RFC 9207 mix-up defence)', async () => {
    const { backend, settings, dir } = await setup();
    backend.state.badIss = true;
    await expect(login(settings, { onAuthorizationUrl: async (url) => void setTimeout(() => void browser(url), 10) })).rejects.toThrow(/iss|issuer/i);
    expect(await loadSession(dir, backend.mcpUrl)).toBeUndefined();
    expect(backend.state.tokenRequests).toHaveLength(0);
  });

  it('reports a denied consent', async () => {
    const { backend, settings } = await setup();
    backend.state.deny = true;
    await expect(login(settings, { onAuthorizationUrl: async (url) => void setTimeout(() => void browser(url), 10) })).rejects.toThrow(/access_denied/);
  });

  it('times out when the browser never comes back', async () => {
    const { settings } = await setup();
    await expect(login(settings, { timeoutMs: 200, onAuthorizationUrl: async () => undefined })).rejects.toThrow(/No browser callback/);
  });
});

describe('refresh and revoke', () => {
  async function loggedIn(opts: Parameters<typeof startBackend>[0] = {}) {
    const ctx = await setup(opts);
    await login(ctx.settings, { onAuthorizationUrl: async (url) => void setTimeout(() => void browser(url), 10) });
    return ctx;
  }

  it('rotates refresh tokens and adopts a rotation done by another process instead of reusing the old token', async () => {
    const { backend, settings, dir } = await loggedIn();
    const before = (await loadSession(dir, backend.mcpUrl))!;
    // Two concurrent refreshes with the same (old) access token: exactly one refresh request must happen.
    const [a, b] = await Promise.all([refreshSession(settings, before.tokens.access_token), refreshSession(settings, before.tokens.access_token)]);
    expect(backend.state.refreshCount).toBe(1);
    expect(backend.state.reuseDetected).toBe(0);
    expect(a.tokens.access_token).toBe(b.tokens.access_token);
    expect(a.tokens.refresh_token).not.toBe(before.tokens.refresh_token);
  });

  it('proactively refreshes an expired token before a request', async () => {
    const { backend, settings, dir } = await loggedIn({ accessTtl: 1 });
    await new Promise((r) => setTimeout(r, 50));
    const provider = sessionAuthProvider(settings);
    const token = await provider.token();
    expect(backend.state.refreshCount).toBe(1);
    expect(token).toBe((await loadSession(dir, backend.mcpUrl))!.tokens.access_token);
  });

  it('deletes the session and asks to log in again when the grant was revoked', async () => {
    const { backend, settings, dir } = await loggedIn();
    for (const g of backend.state.grants.values()) g.revoked = true;
    const session = (await loadSession(dir, backend.mcpUrl))!;
    await expect(refreshSession(settings, session.tokens.access_token)).rejects.toBeInstanceOf(LoginRequiredError);
    await expect(refreshSession(settings, session.tokens.access_token)).rejects.toThrow(/npx @lykia\/mcp login/);
    expect(await loadSession(dir, backend.mcpUrl)).toBeUndefined();
  });

  it('revokes both tokens at the revocation endpoint', async () => {
    const { backend, dir } = await loggedIn();
    const session = (await loadSession(dir, backend.mcpUrl))!;
    expect(await revokeSession(session)).toBe(true);
    expect(backend.state.revocations.map((f) => f.get('token_type_hint'))).toEqual(['refresh_token', 'access_token']);
    expect(backend.state.revocations[0]!.get('client_id')).toBe(session.client.client_id);
  });
});
