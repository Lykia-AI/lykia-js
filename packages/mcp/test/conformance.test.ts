/**
 * Opt-in conformance run of the BUILT `lykia-mcp` bridge against a REAL Lykia gateway (skipped unless both are set):
 *
 *   LYKIA_CONFORMANCE_URL=http://127.0.0.1:7821/v1 LYKIA_CONFORMANCE_KEY=lyk-v1-… npx vitest run packages/mcp/test/conformance.test.ts
 *
 * Optional: LYKIA_CONFORMANCE_MCP_URL (default: the origin of LYKIA_CONFORMANCE_URL + /mcp),
 * LYKIA_CONFORMANCE_DOWNLOAD_HOSTS (passed to the bridge as LYKIA_MCP_DOWNLOAD_HOSTS for this run only, e.g. a local
 * storage host), LYKIA_CONFORMANCE_IMAGE_OPTIONS (JSON provider_options for the image edit, e.g. {"strength":0.5}).
 * The project behind the key needs the presets @text, @image, @video and @tts, and credits. It spends a little money.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const URL_ = process.env['LYKIA_CONFORMANCE_URL'];
const KEY = process.env['LYKIA_CONFORMANCE_KEY'];
const enabled = Boolean(URL_ && KEY);
const MCP_URL = process.env['LYKIA_CONFORMANCE_MCP_URL'] ?? (URL_ ? `${new URL(URL_).origin}/mcp` : '');
const IMAGE_OPTIONS = JSON.parse(process.env['LYKIA_CONFORMANCE_IMAGE_OPTIONS'] ?? '{}') as Record<string, unknown>;
const CLI = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));
const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const REMOTE_TOOLS = [
  'models_list', 'model_get', 'cost_estimate', 'chat', 'credits_get', 'usage_summary', 'generation_get', 'workflows_list', 'workflow_get',
  'image_generate', 'video_generate', 'video_status', 'video_wait', 'speech_generate', 'voices_list',
];
const PROMPTS = [
  'product-ad', 'ad-variants', 'ad-resize', 'ad-localize', 'logo-concepts', 'social-pack', 'storyboard', 'product-video', 'ugc-video',
  'explainer-video', 'voiceover', 'model-compare', 'cost-report',
];

type Result = { content?: Array<{ text?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };
const text = (r: Result) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

let home = '';
let work = '';
let client: Client;
let stderr = '';

describe.skipIf(!enabled)('conformance: lykia-mcp against a real gateway', { timeout: 240_000 }, () => {
  beforeAll(async () => {
    if (!existsSync(CLI)) throw new Error('Build first: npm run build');
    home = mkdtempSync(join(tmpdir(), 'lykia-mcp-conf-'));
    work = mkdtempSync(join(home, 'work-'));
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? '',
      HOME: home,
      LYKIA_CONFIG_DIR: join(home, 'config'),
      LYKIA_MCP_URL: MCP_URL,
      LYKIA_BASE_URL: URL_!,
      LYKIA_API_KEY: KEY!,
      LYKIA_NO_BROWSER: '1',
    };
    if (process.env['LYKIA_CONFORMANCE_DOWNLOAD_HOSTS']) env['LYKIA_MCP_DOWNLOAD_HOSTS'] = process.env['LYKIA_CONFORMANCE_DOWNLOAD_HOSTS'];
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI], env, cwd: work, stderr: 'pipe' });
    transport.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    client = new Client({ name: 'conformance', version: '1.0.0' });
    await client.connect(transport);
  });
  afterAll(async () => {
    await client?.close().catch(() => undefined);
    if (home) rmSync(home, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as Result;
    if (r.isError) throw new Error(`${name} failed: ${text(r)}`);
    return r;
  };

  it('lists the 15 remote tools, the 2 local tools and the ready-made commands; the key never reaches stderr', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect([...tools].sort()).toEqual([...REMOTE_TOOLS, 'file_input', 'output_save'].sort());
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(expect.arrayContaining(PROMPTS));
    expect(stderr).not.toContain(KEY!);
  });

  it('models_list and cost_estimate', async () => {
    const models = await call('models_list', { limit: 5 });
    expect(models.structuredContent).toMatchObject({ total: expect.any(Number), returned: expect.any(Number) });
    const est = await call('cost_estimate', { model: '@text', prompt: 'Merhaba', max_tokens: 64 });
    expect(est.structuredContent).toMatchObject({ currency: 'USD', estimated_max_cost_usd: expect.any(Number) });
  });

  it('file_input handle feeds image_generate; output_save stores the result', async () => {
    writeFileSync(join(work, 'product.png'), PNG_1X1);
    const input = await call('file_input', { path: 'product.png', kind: 'image' });
    const handle = (input.structuredContent as { handle: string }).handle;
    expect(handle).toMatch(/^lykia-file:/);
    const plain = await call('image_generate', { prompt: 'a red fox' });
    expect(plain.structuredContent).toMatchObject({ id: expect.stringMatching(/^gen-/), cost_usd: expect.any(Number) });
    const edit = await call('image_generate', { prompt: 'same product, studio light', images: [handle], provider_options: IMAGE_OPTIONS });
    const images = (edit.structuredContent as { images: Array<{ url: string | null }> }).images;
    expect(images.length).toBeGreaterThan(0);
    const url = images[0]!.url;
    expect(url).toBeTruthy();
    const saved = await call('output_save', { url, path: 'out/edit.png' });
    expect(text(saved)).toContain('edit.png');
    expect(statSync(join(work, 'out/edit.png')).size).toBeGreaterThan(0);
  });

  it('video_generate + video_wait, then output_save of the video', async () => {
    const job = await call('video_generate', { prompt: 'a cat on a roof', duration: 5 });
    const id = (job.structuredContent as { id: string }).id;
    expect(id).toMatch(/^gen-/);
    const status = await call('video_status', { id });
    expect(status.structuredContent).toMatchObject({ id });
    const done = await call('video_wait', { id, timeout_seconds: 120 });
    expect(done.structuredContent).toMatchObject({ id, status: 'completed', done: true });
    const url = JSON.stringify(done.structuredContent).match(/"url":"([^"]+)"/)?.[1];
    if (url) {
      await call('output_save', { url, path: 'out/video.mp4' });
      expect(statSync(join(work, 'out/video.mp4')).size).toBeGreaterThan(0);
    }
  });

  it('voices_list and speech_generate', async () => {
    const voices = await call('voices_list', {});
    const list = (voices.structuredContent as { voices: Array<{ id: string }> }).voices;
    expect(list.length).toBeGreaterThan(0);
    const speech = await call('speech_generate', { input: 'Merhaba dünya', voice: list[0]!.id });
    const sc = speech.structuredContent as { cost_usd: number; mime_type: string; bytes: number; url: string | null };
    expect(sc).toMatchObject({ cost_usd: expect.any(Number), mime_type: expect.stringMatching(/^audio\//) });
    expect(sc.bytes).toBeGreaterThan(0);
    if (sc.url) {
      await call('output_save', { url: sc.url, path: 'out/speech.mp3' });
      expect(readFileSync(join(work, 'out/speech.mp3')).length).toBeGreaterThan(0);
    }
    expect(stderr).not.toContain(KEY!);
  });
});
