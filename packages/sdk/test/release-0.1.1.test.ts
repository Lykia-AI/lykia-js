import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODE_BY_STATUS, Lykia, LykiaError, PRESETS, PRESET_MODALITY, preset, sanitizeTags } from '../src/index.js';
import { FAKE_DEFAULT_PRESETS, chatChunks, createFakeLykia, fakeEmbedding, fakeError, sampleFromSchema, type FakeLykia } from '../src/testing/index.js';

const KEY = 'lyk-v1-' + 'S3CR3T'.repeat(8);
let fake: FakeLykia;
let lykia: Lykia;
let dir: string;

beforeAll(async () => {
  fake = await createFakeLykia({ apiKey: KEY });
  lykia = new Lykia({ apiKey: KEY, baseURL: fake.url });
  dir = mkdtempSync(join(tmpdir(), 'lykia-sdk-'));
});
afterAll(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => fake.reset());

const catchErr = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as LykiaError);
const last = () => fake.requests.at(-1)!;

/** Every value reachable through enumerable keys and for...in. */
function walk(value: unknown, seen = new Set<unknown>(), out: unknown[] = []): unknown[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) {
    out.push(value);
    return out;
  }
  seen.add(value);
  for (const k of Object.keys(value as object)) walk((value as Record<string, unknown>)[k], seen, out);
  for (const k in value as object) walk((value as Record<string, unknown>)[k], seen, out);
  return out;
}

describe('the API key cannot leak', () => {
  it('through JSON.stringify, util.inspect (any depth), Object.keys or for...in', () => {
    const client = new Lykia({ apiKey: KEY, baseURL: fake.url, defaultHeaders: { Authorization: 'Bearer lyk-v1-HEADERSECRET', 'X-Title': 'app' } });
    const texts = [
      JSON.stringify(client),
      JSON.stringify(client.chat),
      JSON.stringify(client.audio),
      inspect(client, { depth: Infinity, showHidden: true }),
      inspect(client.chat.completions, { depth: Infinity, showHidden: true }),
      inspect(client.videos, { depth: Infinity, showHidden: true }),
      inspect(client.audio.speech, { depth: Infinity, showHidden: true }),
      String(client),
    ];
    for (const t of texts) {
      expect(t).not.toContain('S3CR3T');
      expect(t).not.toContain('HEADERSECRET');
    }
    for (const v of walk(client)) {
      if (typeof v === 'string') {
        expect(v).not.toContain('S3CR3T');
        expect(v).not.toContain('HEADERSECRET');
      }
    }
    expect(JSON.stringify(client)).toContain('[redacted]');
    expect(inspect(client)).toBe(`Lykia { baseURL: '${fake.url}', apiKey: '[redacted]' }`);
  });

  it('a stream object and an error do not carry the key either', async () => {
    const stream = lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] });
    await stream.final();
    expect(inspect(stream, { depth: Infinity, showHidden: true })).not.toContain('S3CR3T');
    expect(JSON.stringify(stream)).not.toContain('S3CR3T');
    fake.enqueue('GET /key', fakeError(500));
    const err = await catchErr(lykia.key.get());
    expect(inspect(err, { depth: Infinity, showHidden: true })).not.toContain('S3CR3T');
  });

  it('an Authorization entry in defaultHeaders is ignored (the apiKey is what is sent)', async () => {
    const client = new Lykia({ apiKey: KEY, baseURL: fake.url, defaultHeaders: { authorization: 'Bearer other' } });
    await client.key.get();
    expect(last().headers['authorization']).toBe(`Bearer ${KEY}`);
  });
});

describe('error contract (§14.1)', () => {
  it('reads the status from error.status, a string code, and the new reasons', async () => {
    fake.enqueue('GET /key', { status: 401, json: { error: { message: 'Key revoked', type: 'authentication_error', code: 'invalid_api_key', status: 401, metadata: { reason: 'unauthorized' } } } });
    expect(await catchErr(lykia.key.get())).toMatchObject({ status: 401, code: 'invalid_api_key', reason: 'unauthorized', retryable: false });
    fake.enqueue('GET /key', fakeError(403, { reason: 'forbidden' }));
    expect(await catchErr(lykia.key.get())).toMatchObject({ status: 403, code: 'forbidden', reason: 'forbidden', retryable: false });
  });

  it('treats a numeric code from an older server as the status and derives the code', async () => {
    fake.enqueue('GET /key', { status: 429, json: { error: { code: 429, message: 'old', metadata: {} } } });
    expect(await catchErr(lykia.key.get())).toMatchObject({ status: 429, code: 'rate_limited', reason: 'rate_limited', retryable: true });
    fake.enqueue('POST /chat/completions', { stream: [{ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'a' }, finish_reason: null }] }, { object: 'chat.completion.chunk', error: { code: 503, message: 'old stream' }, choices: [] }] });
    expect(await catchErr(lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] }).final())).toMatchObject({ status: 503, code: 'no_provider' });
  });

  it('client fallback codes and fakeError defaults agree for every status in the table', async () => {
    for (const status of Object.keys(ERROR_CODE_BY_STATUS).map(Number)) {
      fake.enqueue('GET /providers', fakeError(status));
      const viaFake = await catchErr(lykia.providers.list());
      fake.enqueue('GET /providers', { status, json: { error: { message: 'no code' } } });
      const viaFallback = await catchErr(lykia.providers.list());
      expect(viaFake?.code).toBe(ERROR_CODE_BY_STATUS[status]);
      expect(viaFallback?.code).toBe(viaFake?.code);
      expect(viaFallback?.reason).toBe(viaFake?.reason);
    }
    expect(ERROR_CODE_BY_STATUS[503]).toBe('no_provider');
  });

  it('a mid-stream error chunk carries the status in error.status', async () => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'part', error: { message: 'busy', reason: 'overloaded', status: 529 } }) });
    expect(await catchErr(lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] }).final())).toMatchObject({ status: 529, reason: 'overloaded', retryable: true });
  });
});

describe('binary results and headers', () => {
  it('speech exposes generationId and cost from the headers', async () => {
    const r = await lykia.audio.speech({ model: '@tts', input: 'x', voice: 'voice_ada' });
    expect(r.cost).toBe(0.00008); // 1 character × the fake's per-character price
    expect(r.generationId).toMatch(/^gen-/);
    expect(r.generationId).toBe(last().generationId);
  });

  it('video content follows the signed redirect without credentials and keeps generation id and cost', async () => {
    const job = await lykia.videos.create({ model: '@video', prompt: 'waves' });
    await lykia.videos.wait(job.id, { intervalMs: 100 });
    const file = await lykia.videos.content(job.id);
    expect(new TextDecoder().decode(file.data)).toBe('FAKEVIDEO');
    expect(file.contentType).toBe('video/mp4');
    expect(file.cost).toBe(0.27);
    expect(file.generationId).toBe(job._meta?.generationId);
  });

  it('_meta.reasoningDropped reflects X-Lykia-Reasoning', async () => {
    const r = await lykia.chat.completions.create({
      model: '@reasoning',
      reasoning: { effort: 'low' },
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ],
    });
    expect(r._meta.reasoningDropped).toBe(true);
    expect((await lykia.chat.completions.create({ messages: [{ role: 'user', content: 'x' }] }))._meta.reasoningDropped).toBe(false);
  });
});

describe('uploads', () => {
  it('accepts a Blob / File directly', async () => {
    await lykia.audio.transcriptions.create({ model: '@stt', file: new File([new Uint8Array([1, 2, 3])], 'kayit.webm', { type: 'audio/webm' }) });
    expect((last().body as { files: unknown[] }).files).toEqual([{ field: 'file', filename: 'kayit.webm', contentType: 'audio/webm', size: 3 }]);
    await lykia.audio.transcriptions.create({ model: '@stt', file: new Blob([new Uint8Array([1])]) });
    expect((last().body as { files: Array<{ filename: string }> }).files[0]!.filename).toBe('audio');
  });

  it('streams { path } from disk with fs.openAsBlob', async () => {
    const path = join(dir, 'clip.mp3');
    writeFileSync(path, Buffer.alloc(4096, 7));
    const r = await lykia.audio.transcriptions.create({ model: '@stt', file: { path } });
    expect(r.text).toBe('merhaba dünya');
    expect((last().body as { files: unknown[] }).files).toEqual([{ field: 'file', filename: 'clip.mp3', contentType: 'audio/mpeg', size: 4096 }]);
    expect(await catchErr(lykia.audio.transcriptions.create({ model: '@stt', file: { path: join(dir, 'missing.mp3') } }))).toBeDefined();
  });
});

describe('tags and presets', () => {
  it('sanitizeTags fits the limits without throwing and reports what changed', () => {
    const md: Record<string, unknown> = { product: 'kit', op: 'x'.repeat(600), n: 3, obj: { a: 1 }, ['k'.repeat(70)]: 'long key' };
    for (let i = 0; i < 20; i++) md[`e${i}`] = 'v';
    const t = sanitizeTags({ user: 'u'.repeat(200), metadata: md });
    expect(t.user).toHaveLength(128);
    expect(Object.keys(t.metadata!)).toHaveLength(16);
    expect(t.metadata!['op']).toHaveLength(512);
    expect(t.metadata!['n']).toBe('3');
    expect(t.metadata!['obj']).toBeUndefined();
    expect(t.warnings.length).toBeGreaterThanOrEqual(5);
    expect(t.dropped!['user']).toHaveLength(200);
    expect(t.dropped!['metadata.obj']).toEqual({ a: 1 });
    expect(sanitizeTags(undefined)).toEqual({ warnings: [] });
    expect(sanitizeTags({ user: 42, metadata: 'nope' })).toMatchObject({ user: '42', dropped: { metadata: 'nope' } });
  });

  it('a sanitized request passes the strict fake', async () => {
    const md: Record<string, unknown> = {};
    for (let i = 0; i < 30; i++) md[`k${i}`] = 'v'.repeat(600);
    const t = sanitizeTags({ user: 'u'.repeat(300), metadata: md });
    const r = await lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }], user: t.user, metadata: t.metadata });
    expect(r.choices[0]!.message.content).toBe('echo: x');
  });

  it('PRESETS are the suggested names and all valid', () => {
    expect([...PRESETS].sort()).toEqual(['assistant', 'embedding', 'fast', 'image', 'reasoning', 'search', 'stt', 'text', 'translate', 'tts', 'video', 'vision', 'writer']);
    for (const p of PRESETS) {
      expect(preset(p)).toBe(`@${p}`);
      expect(PRESET_MODALITY[p]).toBeDefined();
    }
  });
});

describe('0.1.2: chat fields and default presets', () => {
  it('accepts every field the gateway forwards or owns, and notes the overridden ones', async () => {
    await lykia.chat.completions.create({
      model: '@text',
      messages: [{ role: 'system', content: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: 'x' }],
      models: ['openai/gpt-4o-mini'],
      provider: { only: ['openai'], allow_fallbacks: false },
      user: 'u',
      metadata: { a: 'b' },
      reasoning: { effort: 'low' },
      stream_options: { include_usage: true },
      prompt_cache_key: 'tenant-42',
      max_completion_tokens: 100,
      response_format: { type: 'text' },
      top_k: 40,
      verbosity: 'low',
    });
    expect(last().violations).toEqual([]);
    expect(last().notes).toEqual([]);
    await lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }], store: true, web_search_options: {} });
    expect(last().violations).toEqual([]);
    expect(last().notes).toEqual([
      '"store" is accepted but never enabled: the gateway always sends store: false (no provider-side storage)',
      '"web_search_options" is accepted but dropped: web search is not available on the gateway yet',
    ]);
  });

  it('leaves search out of the default presets; it can be added through presets', async () => {
    expect(PRESETS).toContain('search');
    expect(Object.keys(FAKE_DEFAULT_PRESETS)).not.toContain('search');
    expect(Object.keys(FAKE_DEFAULT_PRESETS)).toHaveLength(PRESETS.length - 1);
    const withSearch = await createFakeLykia({ apiKey: KEY, presets: { ...FAKE_DEFAULT_PRESETS, search: 'chat' } });
    try {
      const c = new Lykia({ apiKey: KEY, baseURL: withSearch.url });
      expect((await c.chat.completions.create({ model: '@search', messages: [{ role: 'user', content: 'x' }] }))._meta.preset).toBe('search');
    } finally {
      await withSearch.close();
    }
  });

  it('sanitizeTags drops metadata keys the gateway rejects', async () => {
    const t = sanitizeTags({ metadata: { $where: '1', 'a.b': '2', ok: '3' } });
    expect(t.metadata).toEqual({ ok: '3' });
    expect(t.warnings).toHaveLength(2);
    await lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }], metadata: t.metadata });
  });
});

describe('strict fake server', () => {
  it('requires credentials even for queued responses', async () => {
    fake.enqueue('GET /key', { json: { data: { label: 'queued' } } });
    const anon = new Lykia({ apiKey: 'lyk-v1-wrongwrong', baseURL: fake.url });
    expect(await catchErr(anon.key.get())).toMatchObject({ status: 401, code: 'invalid_api_key', reason: 'unauthorized' });
    expect((await lykia.key.get()).label).toBe('queued');
  });

  it('without apiKey checks the credential shape; strict: false accepts anything', async () => {
    const shaped = await createFakeLykia();
    const loose = await createFakeLykia({ strict: false });
    try {
      expect(await catchErr(new Lykia({ apiKey: 'nope', baseURL: shaped.url }).key.get())).toMatchObject({ status: 401 });
      await new Lykia({ apiKey: 'lyk-v1-abcd', baseURL: shaped.url }).key.get();
      await new Lykia({ apiKey: 'at_oauthAccessToken0123456789', baseURL: shaped.url }).key.get();
      await new Lykia({ apiKey: 'nope', baseURL: loose.url }).key.get();
      const r = await new Lykia({ apiKey: 'nope', baseURL: loose.url }).chat.completions.create({ model: '@undefined-one', messages: [{ role: 'user', content: 'x' }] });
      expect(r.choices[0]!.message.content).toBe('echo: x');
    } finally {
      await shaped.close();
      await loose.close();
    }
  });

  it('enforces presets and their endpoint kind', async () => {
    const msg = [{ role: 'user' as const, content: 'x' }];
    expect(await catchErr(lykia.chat.completions.create({ model: '@nope', messages: msg }))).toMatchObject({ status: 400, code: 'preset_not_found', reason: 'invalid_request' });
    expect(await catchErr(lykia.chat.completions.create({ model: '@image', messages: msg }))).toMatchObject({ status: 400, code: 'preset_modality_mismatch' });
    expect(await catchErr(lykia.chat.completions.create({ model: '@search', messages: msg }))).toMatchObject({ status: 400, code: 'preset_not_found' });
    expect(await catchErr(lykia.chat.completions.create({ model: '@text', messages: [] }))).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await catchErr(lykia.embeddings.create({ model: '@text', input: 'x' }))).toMatchObject({ code: 'preset_modality_mismatch' });
    const custom = await createFakeLykia({ apiKey: KEY, presets: { support: 'chat' } });
    try {
      const c = new Lykia({ apiKey: KEY, baseURL: custom.url });
      expect((await c.chat.completions.create({ model: '@support', messages: [{ role: 'user', content: 'x' }] }))._meta.preset).toBe('support');
      expect(await catchErr(c.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }] }))).toMatchObject({ code: 'preset_not_found' });
    } finally {
      await custom.close();
    }
  });

  it('enforces tag limits and the 8-file limit, and records unknown fields', async () => {
    const m = (extra: Record<string, unknown>) => lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }], ...extra });
    expect(await catchErr(m({ user: 'u'.repeat(129) }))).toMatchObject({ status: 400, reason: 'invalid_request' });
    const big: Record<string, string> = {};
    for (let i = 0; i < 17; i++) big[`k${i}`] = 'v';
    expect(await catchErr(m({ metadata: big }))).toMatchObject({ status: 400 });
    expect(await catchErr(m({ metadata: { k: 1 } as never }))).toMatchObject({ status: 400 });
    const pdf = { type: 'file' as const, file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AA==' } };
    expect(await catchErr(lykia.chat.completions.create({ model: '@vision', messages: [{ role: 'user', content: Array(9).fill(pdf) }] }))).toMatchObject({ status: 400, code: 'too_many_files' });
    await lykia.chat.completions.create({ model: '@vision', messages: [{ role: 'user', content: Array(8).fill(pdf) }] });
    await m({ future_field: { x: 1 }, n: 2 });
    expect(last().violations).toEqual([
      `unknown field "future_field" (dropped on Lykia's keys; passed through only with your own provider key)`,
      `unknown field "n" (dropped on Lykia's keys; passed through only with your own provider key)`,
    ]);
    expect(await catchErr(m({ metadata: { $where: 'x' } }))).toMatchObject({ status: 400, code: 'invalid_tags' });
    expect(await catchErr(m({ metadata: { 'a.b': 'x' } }))).toMatchObject({ status: 400, code: 'invalid_tags' });
    expect(await catchErr(lykia.audio.transcriptions.create({ model: '@stt', file: { data: new Uint8Array(1), filename: 'a.mp3' }, metadata: { a: 'x'.repeat(513) } }))).toMatchObject({ status: 400 });
  });

  it('answers json_schema requests with JSON that satisfies the schema', async () => {
    const schema = {
      type: 'object',
      properties: {
        category: { type: 'string', enum: ['billing', 'tech'] },
        urgent: { type: 'boolean' },
        score: { type: 'number', minimum: 0, maximum: 1 },
        count: { type: 'integer', minimum: 3 },
        tags: { type: 'array', items: { type: 'string' }, minItems: 2 },
        owner: { $ref: '#/$defs/person' },
        note: { type: 'string' },
      },
      required: ['category', 'urgent', 'score', 'count', 'tags', 'owner'],
      additionalProperties: false,
      $defs: { person: { type: 'object', properties: { email: { type: 'string', format: 'email' } }, required: ['email'] } },
    };
    const r = await lykia.chat.completions.create({ model: '@fast', messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_schema', json_schema: { name: 't', strict: true, schema } } });
    expect(JSON.parse(r.choices[0]!.message.content!)).toEqual({ category: 'billing', urgent: true, score: 0, count: 3, tags: ['fake', 'fake'], owner: { email: 'fake@example.com' } });
    const s = await lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }], response_format: { type: 'json_object' } }).final();
    expect(JSON.parse(s.message.content!)).toEqual({ result: 'fake' });
    expect(sampleFromSchema({ anyOf: [{ type: 'null' }, { type: 'integer' }] })).toBe(1);
  });

  it('returns deterministic embeddings that honour dimensions, arrays and base64', async () => {
    const a = await lykia.embeddings.create({ model: '@embedding', input: ["Antalya'da hava güneşli", "Antalya'da hava çok güneşli", 'Fatura ödeme tarihi'], dimensions: 64 });
    const b = await lykia.embeddings.create({ model: '@embedding', input: "Antalya'da hava güneşli", dimensions: 64 });
    const v = (i: number) => a.data[i]!.embedding as number[];
    const cos = (x: number[], y: number[]) => x.reduce((s, n, i) => s + n * y[i]!, 0);
    expect(v(0)).toHaveLength(64);
    expect(b.data[0]!.embedding).toEqual(v(0));
    expect(cos(v(0), v(1))).toBeGreaterThan(cos(v(0), v(2)));
    const b64 = await lykia.embeddings.create({ model: '@embedding', input: 'x', dimensions: 4, encoding_format: 'base64' });
    const f = new Float32Array(Uint8Array.from(Buffer.from(b64.data[0]!.embedding as string, 'base64')).buffer);
    expect(Array.from(f).map((n) => Math.round(n * 1e6))).toEqual(fakeEmbedding('x', 4).map((n) => Math.round(n * 1e6)));
  });

  it('returns a real PNG for b64_json', async () => {
    const r = await lykia.images.generate({ model: '@image', prompt: 'cat', response_format: 'b64_json' });
    const png = Buffer.from(r.data[0]!.b64_json!, 'base64');
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(1);
    expect(png.readUInt32BE(20)).toBe(1);
  });

  it('stream chunk ids equal X-Generation-Id, also for queued streams', async () => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'queued' }) });
    const s = lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] });
    await s.final();
    expect(s.generationId).toBe(last().generationId);
  });

  it('records generations and internal billing; reset() clears jobs too', async () => {
    const internal = await createFakeLykia({ apiKey: KEY, billingMode: 'internal' });
    try {
      const c = new Lykia({ apiKey: KEY, baseURL: internal.url });
      await c.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }] });
      const credits = await c.credits.get();
      expect(credits).toMatchObject({ billing_mode: 'internal', period_cost: 0.000123 });
      expect(credits.period_start).toMatch(/^\d{4}-\d{2}-01$/);
      expect(internal.generations).toHaveLength(1);
    } finally {
      await internal.close();
    }
    const job = await lykia.videos.create({ model: '@video', prompt: 'x' });
    fake.reset();
    expect(await catchErr(lykia.videos.get(job.id))).toMatchObject({ status: 404 });
    expect(fake.generations).toEqual([]);
  });

  it('simulates dropped connections and slow first bytes', async () => {
    fake.enqueue('GET /key', { drop: 'before-headers' });
    expect(await catchErr(lykia.key.get())).toMatchObject({ status: 0, code: 'network_error', retryable: true });
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'cut short' }), drop: 'mid-body', dropAfter: 2 });
    expect(await catchErr(lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] }).final())).toMatchObject({ code: 'network_error' });
    fake.enqueue('GET /credits', { json: { data: { balance: 1 } }, drop: 'mid-body' });
    expect(await catchErr(lykia.credits.get())).toMatchObject({ status: 0, code: 'network_error' });
    fake.enqueue('GET /providers', { delayMs: 300, json: { data: [] } });
    expect(await catchErr(lykia.providers.list({ timeoutMs: 100 }))).toMatchObject({ code: 'timeout' });
  });
});
