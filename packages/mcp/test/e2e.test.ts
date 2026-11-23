/**
 * End-to-end: spawns the BUILT `lykia-mcp` binary (dist/cli.mjs) over stdio, connects to it with the official MCP
 * client, and drives it against the fake Lykia backend (remote MCP server + OAuth server + /v1).
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadSettings } from '../src/config.js';
import { login } from '../src/oauth.js';
import { loadSession, sessionPath } from '../src/session.js';
import { startBackend, TEST_API_KEY, type FakeBackend } from './fakes/backend.js';

const CLI = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);

let backend: FakeBackend;
let home: string;
const closers: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error('Build first: npm run build (the e2e test runs dist/cli.mjs)');
  backend = await startBackend();
  home = mkdtempSync(join(tmpdir(), 'lykia-e2e-'));
});
afterEach(async () => {
  for (const c of closers.splice(0)) await c();
});
afterAll(async () => {
  await backend.close();
  rmSync(home, { recursive: true, force: true });
});

interface Env {
  apiKey?: string;
  configDir?: string;
  mcpUrl?: string;
  baseUrl?: string;
}

function childEnv(e: Env): Record<string, string> {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: home,
    LYKIA_CONFIG_DIR: e.configDir ?? join(home, 'config-none'),
    LYKIA_MCP_URL: e.mcpUrl ?? backend.mcpUrl,
    LYKIA_BASE_URL: e.baseUrl ?? backend.baseUrl,
    LYKIA_NO_BROWSER: '1',
    ...(e.apiKey ? { LYKIA_API_KEY: e.apiKey } : {}),
  };
}

async function connectBridge(e: Env, opts: { cwd?: string; args?: string[]; modern?: boolean } = {}) {
  const cwd = opts.cwd ?? mkdtempSync(join(home, 'work-'));
  const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, ...(opts.args ?? [])], env: childEnv(e), cwd, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const client = new Client({ name: 'e2e', version: '1.0.0' }, opts.modern ? { versionNegotiation: { mode: 'auto' } } : {});
  await client.connect(transport);
  closers.push(() => client.close());
  return { client, cwd, stderr: () => stderr };
}

function runCli(args: string[], e: Env, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: childEnv(e), cwd: cwd ?? home, timeout: 30_000 }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

const textOf = (r: unknown) => ((r as { content: Array<{ text?: string }> }).content ?? []).map((c) => c.text ?? '').join('\n');

async function waitFor(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('bridge with an API key', () => {
  it('re-exposes the remote tools, prompts and resources plus the two local tools', async () => {
    const { client } = await connectBridge({ apiKey: TEST_API_KEY });
    expect(client.getServerVersion()?.name).toBe('lykia');
    expect(client.getInstructions()).toBe('Fake Lykia server for tests.');
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['echo', 'slow', 'big', 'image_generate', 'fails', 'file_input', 'output_save']));
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'merhaba' } }))).toBe('echo: merhaba');
    expect(backend.state.mcpAuthHeaders.at(-1)).toBe(`Bearer ${TEST_API_KEY}`);

    const failed = await client.callTool({ name: 'fails', arguments: {} });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe('Insufficient credits');

    expect((await client.listPrompts()).prompts.map((p) => p.name)).toContain('product-ad');
    const prompt = await client.getPrompt({ name: 'product-ad', arguments: { product: 'mug' } });
    expect(JSON.stringify(prompt.messages)).toContain('Make an ad for mug');
    const res = await client.readResource({ uri: 'lykia://docs/readme' });
    expect((res.contents[0] as { text: string }).text).toBe('# Lykia');
    await expect(client.readResource({ uri: 'lykia://docs/missing' })).rejects.toMatchObject({ code: -32602 });
  });

  it('forwards progress notifications and cancellation', async () => {
    const { client } = await connectBridge({ apiKey: TEST_API_KEY });
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];
    const r = await client.callTool({ name: 'slow', arguments: { steps: 3, id: 'p1' } }, { onprogress: (p) => progress.push(p) });
    expect(textOf(r)).toBe('done 3');
    expect(progress.map((p) => p.progress)).toEqual([1, 2, 3]);
    expect(progress[0]).toMatchObject({ total: 3, message: 'step 1' });

    const controller = new AbortController();
    const call = client.callTool({ name: 'slow', arguments: { steps: 40, id: 'c1' } }, { signal: controller.signal, onprogress: () => controller.abort('user stop') });
    await expect(call).rejects.toBeDefined();
    await waitFor(() => backend.state.cancelled.includes('c1'));
  });

  it('passes large results through', async () => {
    const { client } = await connectBridge({ apiKey: TEST_API_KEY });
    const r = await client.callTool({ name: 'big', arguments: { mb: 3 } });
    expect(textOf(r).length).toBe(3 * 1024 * 1024);
  });

  it('forwards tools/list_changed from the remote server', async () => {
    const { client } = await connectBridge({ apiKey: TEST_API_KEY });
    let changed = 0;
    client.setNotificationHandler('notifications/tools/list_changed', () => void changed++);
    await client.listTools();
    await new Promise((r) => setTimeout(r, 300)); // let the bridge open its subscription stream
    backend.addTool('brand_new');
    await waitFor(() => changed > 0);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('brand_new');
  });

  it('works for a 2026-07-28 client too', async () => {
    const { client } = await connectBridge({ apiKey: TEST_API_KEY }, { modern: true });
    expect(client.getProtocolEra()).toBe('modern');
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'modern' } }))).toBe('echo: modern');
  });

  it('survives a remote restart', async () => {
    const { client } = await connectBridge({ apiKey: TEST_API_KEY });
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'before' } }))).toBe('echo: before');
    await backend.restart();
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'after' } }))).toBe('echo: after');
  });
});

describe('local tools', () => {
  it('file_input turns a local image into a handle that reaches the remote tool as a data: URI', async () => {
    const work = mkdtempSync(join(home, 'files-'));
    writeFileSync(join(work, 'product.png'), PNG);
    writeFileSync(join(work, 'fake.png'), 'not really a png');
    const { client } = await connectBridge({ apiKey: TEST_API_KEY }, { cwd: work });
    const input = await client.callTool({ name: 'file_input', arguments: { path: 'product.png', kind: 'image' } });
    const handle = (input.structuredContent as { handle: string }).handle;
    expect(handle).toMatch(/^lykia-file:/);
    const out = await client.callTool({ name: 'image_generate', arguments: { prompt: 'ad', images: [handle] } });
    const parsed = JSON.parse(textOf(out).split('\n')[0]!) as { inputs: string[]; sizes: number[] };
    expect(parsed.inputs[0]).toBe('data:image/png;base64,iVBORw0KGgoAAAAN'.slice(0, 30));
    expect(parsed.sizes[0]).toBe(`data:image/png;base64,${PNG.toString('base64')}`.length);

    const bad = await client.callTool({ name: 'file_input', arguments: { path: 'fake.png' } });
    expect(bad.isError).toBe(true);
    const outside = await client.callTool({ name: 'file_input', arguments: { path: '/etc/hosts' } });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/outside the allowed directories/);
  });

  it('output_save downloads only from allowed hosts into allowed directories, without overwriting', async () => {
    const work = mkdtempSync(join(home, 'save-'));
    const { client } = await connectBridge({ apiKey: TEST_API_KEY }, { cwd: work });
    const ok = await client.callTool({ name: 'output_save', arguments: { url: `${backend.origin}/files/redirect`, path: 'out/result.png' } });
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(join(work, 'out', 'result.png')).subarray(0, 4)).toEqual(PNG.subarray(0, 4));

    const again = await client.callTool({ name: 'output_save', arguments: { url: `${backend.origin}/files/result.png`, path: 'out/result.png' } });
    expect(again.isError).toBe(true);
    expect(textOf(again)).toMatch(/already exists/);
    const replace = await client.callTool({ name: 'output_save', arguments: { url: `${backend.origin}/files/result.png`, path: 'out/result.png', overwrite: true } });
    expect(replace.isError).toBeFalsy();

    const authed = await client.callTool({ name: 'output_save', arguments: { url: `${backend.origin}/files/needs-auth`, path: 'auth.png' } });
    expect(authed.isError).toBeFalsy();

    const foreign = await client.callTool({ name: 'output_save', arguments: { url: 'https://example.com/x.png', path: 'x.png' } });
    expect(textOf(foreign)).toMatch(/not a Lykia host/);
    const escape = await client.callTool({ name: 'output_save', arguments: { url: `${backend.origin}/files/result.png`, path: '../escape.png' } });
    expect(textOf(escape)).toMatch(/outside the allowed directories/);
    // A link Lykia's own tool returned (structuredContent `url`) is accepted although its host is not allow-listed;
    // the same host from free text, or a link that was not returned, is not.
    const storage = backend.origin.replace('127.0.0.1', 'localhost');
    const before = await client.callTool({ name: 'output_save', arguments: { url: `${storage}/files/result.png?sig=1`, path: 'signed.png' } });
    expect(before.isError).toBe(true); // http on a loopback host that is not listed: refused
    await client.callTool({ name: 'image_generate', arguments: { prompt: 'x' } });
    const signed = await client.callTool({ name: 'output_save', arguments: { url: `${storage}/files/result.png?sig=1`, path: 'signed.png' } });
    expect(signed.isError).toBeFalsy();
    expect(readFileSync(join(work, 'signed.png')).subarray(0, 4)).toEqual(PNG.subarray(0, 4));
    const fromText = await client.callTool({ name: 'output_save', arguments: { url: `${storage}/files/result.png?from=text`, path: 'text.png' } });
    expect(fromText.isError).toBe(true);
    const data = await client.callTool({ name: 'output_save', arguments: { url: `data:image/png;base64,${PNG.toString('base64')}`, path: 'inline.png' } });
    expect(data.isError).toBeFalsy();
    expect(readFileSync(join(work, 'inline.png'))).toEqual(PNG);
    expect(existsSync(join(home, 'escape.png'))).toBe(false);
  });

  it('--allow-dir extends the allowed directories', async () => {
    const extra = mkdtempSync(join(home, 'extra-'));
    writeFileSync(join(extra, 'voice.wav'), Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.alloc(16)]));
    const { client } = await connectBridge({ apiKey: TEST_API_KEY }, { args: ['--allow-dir', extra] });
    const r = await client.callTool({ name: 'file_input', arguments: { path: join(extra, 'voice.wav'), kind: 'audio' } });
    expect((r.structuredContent as { mime_type: string }).mime_type).toBe('audio/wav');
  });
});

describe('bridge with an OAuth session', () => {
  let configDir: string;

  beforeAll(async () => {
    configDir = mkdtempSync(join(home, 'cfg-'));
    const saved = { ...process.env };
    Object.assign(process.env, { LYKIA_MCP_URL: backend.mcpUrl, LYKIA_BASE_URL: backend.baseUrl, LYKIA_CONFIG_DIR: configDir });
    const settings = loadSettings({ noBrowser: true });
    process.env = saved;
    await login(settings, {
      onAuthorizationUrl: async (url) => {
        setTimeout(async () => {
          const r = await fetch(url, { redirect: 'manual' });
          await fetch(r.headers.get('location')!);
        }, 10);
      },
    });
  });

  it('uses the session, refreshes once on 401 and keeps working', async () => {
    const { client } = await connectBridge({ configDir });
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'oauth' } }))).toBe('echo: oauth');
    expect(backend.state.mcpAuthHeaders.at(-1)).toMatch(/^Bearer at_/);
    const before = backend.state.refreshCount;
    backend.expireAccessTokens();
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'after refresh' } }))).toBe('echo: after refresh');
    expect(backend.state.refreshCount).toBe(before + 1);
    expect(backend.state.reuseDetected).toBe(0);
  });

  it('whoami reads company and project from /v1/key with the session token', async () => {
    const r = await runCli(['whoami', '--json'], { configDir });
    expect(r.code).toBe(0);
    const info = JSON.parse(r.stdout) as Record<string, unknown>;
    expect(info).toMatchObject({ auth: 'oauth', company: { id: 'cmp_1', name: 'Acme' }, project: { id: 'prj_1', name: 'Ads' } });
    expect(r.stdout + r.stderr).not.toMatch(/at_[A-Za-z0-9_-]{10,}|rt_[A-Za-z0-9_-]{10,}/);
  });

  it('surfaces a revoked grant as a tool error telling the user to log in, and clears the session', async () => {
    const { client } = await connectBridge({ configDir });
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'x' } }))).toBe('echo: x');
    for (const g of backend.state.grants.values()) g.revoked = true;
    const r = await client.callTool({ name: 'echo', arguments: { text: 'y' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/npx @lykia\/mcp login/);
    expect(await loadSession(configDir, backend.mcpUrl)).toBeUndefined();
  });
});

describe('failure behaviour and CLI', () => {
  it('exits with a clear message and an empty stdout when there are no credentials', async () => {
    const r = await runCli([], { configDir: mkdtempSync(join(home, 'empty-')) });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/npx @lykia\/mcp login.*LYKIA_API_KEY/s);
  });

  it('serves local tools while the remote server is unreachable, and recovers when it comes back', async () => {
    const down = await startBackend();
    const port = down.port;
    await down.stop();
    const { client, stderr } = await connectBridge({ apiKey: TEST_API_KEY, mcpUrl: `http://127.0.0.1:${port}/mcp` });
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(['file_input', 'output_save']);
    const r = await client.callTool({ name: 'echo', arguments: { text: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Cannot reach the Lykia MCP server/);
    expect(stderr()).toMatch(/not reachable|Cannot reach/);
    const up = await startBackend({ port });
    closers.push(() => up.close());
    expect(textOf(await client.callTool({ name: 'echo', arguments: { text: 'back' } }))).toBe('echo: back');
  });

  it('rejects an invalid API key with a clear tool error', async () => {
    const { client } = await connectBridge({ apiKey: 'lyk-v1-' + 'c'.repeat(64) });
    const r = await client.callTool({ name: 'echo', arguments: { text: 'x' } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/rejected the API key/);
    expect(textOf(r)).not.toContain('cccccccc');
  });

  it('whoami (API key) and doctor report the project and the server', async () => {
    const who = await runCli(['whoami', '--json'], { apiKey: TEST_API_KEY });
    expect(JSON.parse(who.stdout)).toMatchObject({ auth: 'api_key', project: { name: 'Ads' } });
    const doc = await runCli(['doctor', '--json'], { apiKey: TEST_API_KEY });
    const report = JSON.parse(doc.stdout) as { ok: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> };
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.name === 'MCP connection')?.detail).toContain('lykia-fake 9.9.9');
    expect(report.checks.find((c) => c.name === 'Tools')?.detail).toMatch(/^\d+ remote tools/);
    expect(doc.stdout + doc.stderr).not.toContain(TEST_API_KEY);
  });

  it('config prints a snippet and writes only with --write (merging, with a backup)', async () => {
    const dir = mkdtempSync(join(home, 'cfgfile-'));
    const file = join(dir, 'claude_desktop_config.json');
    writeFileSync(file, JSON.stringify({ mcpServers: { keep: { command: 'x' } } }));
    const dry = await runCli(['config', 'claude-desktop', '--path', file], {});
    expect(JSON.parse(dry.stdout).mcpServers.lykia.command).toBe('npx');
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.lykia).toBeUndefined();
    const wrote = await runCli(['config', 'claude-desktop', '--path', file, '--write'], {});
    expect(wrote.code).toBe(0);
    const merged = JSON.parse(readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(merged.mcpServers).sort()).toEqual(['keep', 'lykia']);
    expect(wrote.stderr).toMatch(/backup/);
    const remote = await runCli(['config', 'vscode', '--remote'], {});
    expect(JSON.parse(remote.stdout)).toEqual({ servers: { lykia: { type: 'http', url: backend.mcpUrl } } });
  });

  it('login (browser flow from the CLI) and logout (revocation) work end to end', async () => {
    const configDir = mkdtempSync(join(home, 'cli-login-'));
    const child = spawn(process.execPath, [CLI, 'login', '--no-browser'], { env: childEnv({ configDir }), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    await waitFor(() => /https?:\/\/\S+\/oauth\/authorize\S+/.test(stderr), 10_000);
    const url = /(https?:\/\/\S+\/oauth\/authorize\S+)/.exec(stderr)![1]!;
    const r = await fetch(url, { redirect: 'manual' });
    await fetch(r.headers.get('location')!);
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
    expect(code).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/Signed in/);
    expect(existsSync(sessionPath(configDir, backend.mcpUrl))).toBe(true);

    const revocationsBefore = backend.state.revocations.length;
    const out = await runCli(['logout'], { configDir });
    expect(out.stderr).toMatch(/Signed out: tokens revoked/);
    expect(backend.state.revocations.length).toBe(revocationsBefore + 2);
    expect(existsSync(sessionPath(configDir, backend.mcpUrl))).toBe(false);
    mkdirSync(configDir, { recursive: true });
  });
});
