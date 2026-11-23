/**
 * Credentials must not leak through serialisation or inspection of the bridge's objects.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiKeyAuthProvider, sessionAuthProvider } from '../src/auth.js';
import { Bridge } from '../src/bridge.js';
import { loadSettings, type Settings } from '../src/config.js';
import { login } from '../src/oauth.js';
import { loadSession } from '../src/session.js';
import { startBackend, TEST_API_KEY, type FakeBackend } from './fakes/backend.js';

let backend: FakeBackend;
let dir: string;
let settings: Settings;

beforeAll(async () => {
  backend = await startBackend();
  dir = mkdtempSync(join(tmpdir(), 'lykia-leaks-'));
  const saved = { ...process.env };
  Object.assign(process.env, { LYKIA_MCP_URL: backend.mcpUrl, LYKIA_BASE_URL: backend.baseUrl, LYKIA_CONFIG_DIR: dir, LYKIA_API_KEY: TEST_API_KEY });
  settings = loadSettings({ noBrowser: true });
  process.env = saved;
});
afterAll(async () => {
  await backend.close();
  rmSync(dir, { recursive: true, force: true });
});

function views(value: unknown): string[] {
  return [JSON.stringify(value) ?? '', inspect(value, { depth: Infinity, showHidden: true }), JSON.stringify({ ...(value as object) })];
}

describe('no credential leaks', () => {
  it('settings keep the API key usable but hidden', () => {
    expect(settings.apiKey).toBe(TEST_API_KEY);
    for (const v of views(settings)) expect(v).not.toContain(TEST_API_KEY);
    expect(Object.keys(settings)).not.toContain('apiKey');
  });

  it('auth providers and a connected bridge (API key) do not reveal the key', async () => {
    for (const v of views(apiKeyAuthProvider(TEST_API_KEY))) expect(v).not.toContain(TEST_API_KEY);
    const bridge = new Bridge({ settings, auth: apiKeyAuthProvider(TEST_API_KEY), cwd: dir });
    try {
      const tools = await bridge.upstream.run((c) => c.listTools(), 'idempotent');
      expect(tools.tools.length).toBeGreaterThan(0);
      for (const v of views(bridge)) expect(v).not.toContain(TEST_API_KEY);
    } finally {
      await bridge.close();
    }
  });

  it('an OAuth-session bridge does not reveal access or refresh tokens', async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { LYKIA_MCP_URL: backend.mcpUrl, LYKIA_BASE_URL: backend.baseUrl, LYKIA_CONFIG_DIR: dir });
    delete process.env['LYKIA_API_KEY'];
    const oauthSettings = loadSettings({ noBrowser: true });
    process.env = saved;
    await login(oauthSettings, {
      onAuthorizationUrl: async (url) =>
        void setTimeout(async () => {
          const r = await fetch(url, { redirect: 'manual' });
          await fetch(r.headers.get('location')!);
        }, 10),
    });
    const session = (await loadSession(dir, backend.mcpUrl))!;
    const auth = sessionAuthProvider(oauthSettings);
    const bridge = new Bridge({ settings: oauthSettings, auth, cwd: dir });
    try {
      await bridge.upstream.run((c) => c.listTools(), 'idempotent');
      for (const v of [...views(bridge), ...views(auth)]) {
        expect(v).not.toContain(session.tokens.access_token);
        expect(v).not.toContain(session.tokens.refresh_token!);
      }
    } finally {
      await bridge.close();
    }
  });
});
