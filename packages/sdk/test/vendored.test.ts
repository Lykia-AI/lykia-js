/**
 * The two single-file CommonJS builds must work when copied alone into a directory without node_modules:
 * the fake server is started from `lykia-fake-server.cjs`, the client from `lykia-client.cjs`, in a bare child process.
 */
import { execFile, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const FILES = ['lykia-client.cjs', 'lykia-fake-server.cjs'];
const TYPINGS = ['lykia-client.d.cts', 'lykia-fake-server.d.cts'];
const version = (JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string }).version;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'lykia-vendor-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Strips comments so that usage examples in doc comments are not mistaken for requires. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe.each(FILES)('dist/%s', (file) => {
  it('has a generated-file header with the version and requires only Node built-ins', () => {
    const src = readFileSync(join(DIST, file), 'utf8');
    expect(src.slice(0, 500)).toContain(`@lykia/sdk ${version}`);
    expect(src.slice(0, 500)).toContain('GENERATED FILE');
    const required = [...code(src).matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)].map((m) => m[1]!);
    for (const name of required) expect(builtinModules).toContain(name.replace(/^node:/, ''));
    expect(src).not.toMatch(/sourceMappingURL/);
  });
});

describe('vendored files in isolation', () => {
  it('start the fake server and call it with the client from an empty directory', async () => {
    for (const f of [...FILES, ...TYPINGS]) copyFileSync(join(DIST, f), join(dir, f));
    writeFileSync(
      join(dir, 'main.js'),
      `
const { Lykia, LykiaError } = require('./lykia-client.cjs');
const { createFakeLykia, fakeError, chatChunks } = require('./lykia-fake-server.cjs');
(async () => {
  const fake = await createFakeLykia();
  try {
    const lykia = new Lykia({ apiKey: 'lyk-v1-vendored', baseURL: fake.url });
    const res = await lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'vendored' }] });
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'stre', toolCalls: [{ id: 'c1', name: 'f', arguments: ['{"a"', ':1}'] }] }) });
    const final = await lykia.chat.completions.stream({ messages: [{ role: 'user', content: 's' }] }).final();
    fake.enqueue('GET /key', fakeError(401, { code: 'invalid_api_key' }));
    let err;
    try { await lykia.key.get(); } catch (e) { err = e; }
    const speech = await lykia.audio.speech({ model: '@tts', input: 'x', voice: 'v' });
    const secret = new Lykia({ apiKey: 'lyk-v1-TOPSECRETKEY', baseURL: fake.url });
    const leaks = [JSON.stringify(secret), require('util').inspect(secret, { depth: Infinity, showHidden: true }), JSON.stringify(Object.values(secret))].some((t) => t.includes('TOPSECRET'));
    console.log(JSON.stringify({
      content: res.choices[0].message.content,
      meta: res._meta,
      tool: final.message.tool_calls[0].function,
      finish: final.finishReason,
      err: { isLykia: err instanceof LykiaError, status: err.status, code: err.code },
      speech: speech.data.byteLength,
      speechCost: speech.cost,
      leaks,
      requests: fake.requests.length,
    }));
  } finally {
    await fake.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
`,
    );
    const out = await new Promise<string>((resolve, reject) => {
      execFile(
        process.execPath,
        ['main.js'],
        // A bare environment: no NODE_PATH and no node_modules anywhere up the tree of the temp dir.
        { cwd: dir, env: { PATH: process.env['PATH'] ?? '' }, timeout: 20_000 },
        (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)),
      );
    });
    const result = JSON.parse(out) as Record<string, unknown>;
    expect(result).toMatchObject({
      content: 'echo: vendored',
      meta: { preset: 'text', maxTokensApplied: 4096 },
      tool: { name: 'f', arguments: '{"a":1}' },
      finish: 'tool_calls',
      err: { isLykia: true, status: 401, code: 'invalid_api_key' },
      speech: 12,
      speechCost: 0.00008,
      leaks: false,
      requests: 4,
    });
  });
});

describe('vendored typings', () => {
  it('a strict TypeScript consumer type-checks against the copied .d.cts files', () => {
    for (const f of [...FILES, ...TYPINGS]) copyFileSync(join(DIST, f), join(dir, f));
    writeFileSync(
      join(dir, 'product.ts'),
      [
        'import { Lykia, LykiaError, preset, sanitizeTags, PRESETS, type ChatMessage } from "./lykia-client.cjs";',
        'import { createFakeLykia, fakeError, chatChunks } from "./lykia-fake-server.cjs";',
        'export async function run(): Promise<string | undefined> {',
        '  const fake = await createFakeLykia({ apiKey: "lyk-v1-k" });',
        '  fake.enqueue("POST /chat/completions", fakeError(429, { reason: "rate_limited", retry_after: 2 }));',
        '  fake.enqueue("POST /chat/completions", { stream: chatChunks({ text: "hi" }) });',
        '  fake.enqueue("POST /chat/completions", (req) => ({ json: { echo: req.path } }));',
        '  const lykia = new Lykia({ apiKey: "lyk-v1-k", baseURL: fake.url, timeoutMs: 1000 });',
        '  const tags = sanitizeTags({ user: "t", metadata: { product: "p" } });',
        '  const messages: ChatMessage[] = [{ role: "user", content: "x" }];',
        '  const r = await lykia.chat.completions.create({ model: preset(PRESETS[0]), messages, user: tags.user, metadata: tags.metadata });',
        '  const f = await lykia.chat.completions.stream({ model: "@assistant", messages }).final();',
        '  messages.push(f.message);',
        '  const sp = await lykia.audio.speech({ model: "@tts", input: "x", voice: "v" });',
        '  const cost: number | undefined = sp.cost;',
        '  try { await lykia.key.get(); } catch (err) { if (err instanceof LykiaError) return err.reason; }',
        '  // @ts-expect-error wrong option name is rejected (types are real, not any)',
        '  new Lykia({ apiKey: "k", timeout: 1 });',
        '  await fake.close();',
        '  return String(r._meta.generationId) + String(r._meta.reasoningDropped) + String(cost);',
        '}',
      ].join('\n'),
    );
    const tsc = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));
    const typeRoots = fileURLToPath(new URL('../../../node_modules/@types', import.meta.url));
    const combos = [
      { module: 'node16', moduleResolution: 'node16', strict: true },
      { module: 'commonjs', moduleResolution: 'node10', strict: true, ignoreDeprecations: '6.0' },
      { module: 'esnext', moduleResolution: 'bundler', strict: true },
    ];
    for (const c of combos) {
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { noEmit: true, target: 'es2022', lib: ['es2022', 'dom'], typeRoots: [typeRoots], types: ['node'], skipLibCheck: false, ...c }, files: ['product.ts'] }),
      );
      const r = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { encoding: 'utf8' });
      expect(r.status, `${JSON.stringify(c)}\n${r.stdout}${r.stderr}`).toBe(0);
    }
  }, 120_000);
});
