/**
 * 0.2.0: the media endpoints, catalog kinds and error details as the real gateway serves them (backend docs/MEDIA.md),
 * against the fake server that mirrors them.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import { Lykia, LykiaError, createAiSdkFetch, type AiSdkResultInfo, type ChatStreamEvent } from '../src/index.js';
import { createFakeLykia, fakeError, type FakeLykia } from '../src/testing/index.js';

const KEY = 'lyk-v1-' + 'c'.repeat(64);
let fake: FakeLykia;
let lykia: Lykia;
beforeAll(async () => {
  fake = await createFakeLykia({ apiKey: KEY, videoTimeline: { queuedMs: 60, runningMs: 120 } });
  lykia = new Lykia({ apiKey: KEY, baseURL: fake.url });
});
afterAll(() => fake.close());
afterEach(() => fake.reset());

const last = () => fake.requests.at(-1)!;
const catchErr = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as LykiaError);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('images', () => {
  it('returns the gateway shape: id, object, model, provider, data with signed url, usage, X-Lykia-Cost', async () => {
    const r = await lykia.images.generate({ model: '@image', prompt: 'a red fox', n: 2, aspect_ratio: '1:1', output_format: 'png', resolution: '1K' });
    expect(r).toMatchObject({ object: 'image.generation', model: 'recraft/recraftv4_1', provider: 'recraft', usage: { images: 2, cost: 0.07, is_byok: false, units: { image: 2 } } });
    expect(r.id).toBe(r._meta.generationId);
    expect(r._meta).toMatchObject({ preset: 'image', cost: 0.07 });
    expect(r.data[0]).toMatchObject({ mime_type: 'image/png' });
    expect(new URL(r.data[0]!.url!).searchParams.get('X-Amz-Expires')).toBe('3600');
    expect(Date.parse(r.data[0]!.expires_at!)).toBeGreaterThan(Date.now());
    expect(last().violations).toEqual([]);
    const file = await fetch(r.data[0]!.url!);
    expect(file.headers.get('content-type')).toBe('image/png');
  });

  it('accepts every input image form and b64_json; validates n with metadata.param', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const r = await lykia.images.generate({
      model: '@image',
      prompt: 'edit',
      images: [png, { url: 'https://example.com/a.png' }, { image_url: { url: png } }, { b64_json: 'AA==', mime_type: 'image/png' }],
      mask: png,
      response_format: 'b64_json',
    });
    expect(r.data[0]).toMatchObject({ mime_type: 'image/png' });
    expect(r.data[0]!.b64_json).toBeTruthy();
    const err = await catchErr(lykia.images.generate({ model: '@image', prompt: 'x', n: 99 }));
    expect(err).toMatchObject({ status: 400, code: 'bad_request', reason: 'invalid_request', param: 'n', type: 'invalid_request_error' });
    expect(await catchErr(lykia.images.generate({ model: 'elevenlabs/eleven_multilingual_v2', prompt: 'x' }))).toMatchObject({ status: 400, code: 'unsupported_model' });
  });
});

describe('videos', () => {
  it('create → poll → completed: output re-signed on every read, content 302 / contentUrl, list', async () => {
    const job = await lykia.videos.create({ model: '@video', prompt: 'waves', duration: 5, reference_images: [], metadata: { scene: '1' } });
    expect(job).toMatchObject({ object: 'video', status: 'queued', progress: 0, model: 'bytedance/seedance-1.0-pro', provider: 'bytedance', duration_seconds: null });
    expect(job.id).toMatch(/^gen-/);
    expect(job.id).toBe(job._meta?.generationId);
    expect(await catchErr(lykia.videos.content(job.id))).toMatchObject({ status: 409, code: 'video_not_ready' });
    const done = await lykia.videos.wait(job.id, { intervalMs: 50 });
    expect(done).toMatchObject({ status: 'completed', progress: 100, duration_seconds: 5, usage: { cost: 0.27, is_byok: false }, output: { mime_type: 'video/mp4' } });
    expect(typeof done.created_at).toBe('number');
    expect(done.expires_at).toBeGreaterThan(Date.now() / 1000);
    const again = await lykia.videos.get(job.id);
    expect(again.output!.url).not.toBe(done.output!.url);
    const url = await lykia.videos.contentUrl(job.id);
    expect(url).toMatchObject({ mime_type: 'video/mp4' });
    expect(url.url).toContain('X-Amz-Signature=');
    const file = await lykia.videos.content(job.id);
    expect(file).toMatchObject({ contentType: 'video/mp4', cost: 0.27, generationId: job.id });
    expect(new TextDecoder().decode(file.data)).toBe('FAKEVIDEO');
    const record = await lykia.generations.get(job.id);
    expect(record).toMatchObject({ kind: 'video', endpoint: 'videos', cost: 0.27, media: { job_id: job.id } });

    await lykia.videos.create({ model: '@video', prompt: 'second' });
    const page = await lykia.videos.list({ limit: 1 });
    expect(page).toMatchObject({ object: 'list', has_more: true });
    expect(page.data).toHaveLength(1);
    expect(page.next_cursor).toBe(page.data[0]!.id);
    const completed = await lykia.videos.list({ status: 'completed' });
    expect(completed.data.map((j) => j.id)).toEqual([job.id]);
    expect(last().query).toEqual({ status: 'completed' });
  });

  it('cancel: a queued job is cancelled (free); a finished one is 409 job_not_cancellable; wait() rejects with video_cancelled', async () => {
    const job = await lykia.videos.create({ model: '@video', prompt: 'cancel me' });
    const cancelled = await lykia.videos.cancel(job.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', error: { code: 'cancelled' }, usage: { cost: 0 } });
    const err = await catchErr(lykia.videos.wait(job.id, { intervalMs: 50 }));
    expect(err).toMatchObject({ code: 'video_cancelled', status: 0, retryable: false });
    expect((err!.body as { status: string }).status).toBe('cancelled');
    expect(await catchErr(lykia.videos.cancel(job.id))).toMatchObject({ status: 409, code: 'job_not_cancellable' });
  });

  it('failure, expiry and unknown jobs', async () => {
    const failing = await lykia.videos.create({ model: '@video', prompt: 'x #fail' });
    const err = await catchErr(lykia.videos.wait(failing.id, { intervalMs: 50 }));
    expect(err).toMatchObject({ code: 'video_failed', reason: 'provider_error' });
    expect(err!.metadata).toMatchObject({ code: 'provider_error' });
    const old = await lykia.videos.create({ model: '@video', prompt: 'x #expired' });
    await lykia.videos.wait(old.id, { intervalMs: 50 });
    expect(await catchErr(lykia.videos.content(old.id))).toMatchObject({ status: 410, code: 'video_expired' });
    expect(await catchErr(lykia.videos.get('gen-nope'))).toMatchObject({ status: 404, code: 'not_found' });
  });
});

describe('audio', () => {
  it('speech accepts language and instructions; cost header; unknown clone 404 voice_not_found', async () => {
    const r = await lykia.audio.speech({ model: '@tts', input: 'Merhaba', voice: 'JBFqnCBsd6RMkjVDRZzb', language: 'tr', instructions: 'calm', response_format: 'wav' });
    expect(r).toMatchObject({ contentType: 'audio/wav', cost: 0.00056 });
    expect(last().violations).toEqual([]);
    expect(await catchErr(lykia.audio.speech({ model: '@tts', input: 'x', voice: 'lvc_doesnotexist0000000' }))).toMatchObject({ status: 404, code: 'voice_not_found' });
  });

  it('voice clone: 201 lvc_ id, category cloned; consent is enforced by the gateway; delete; unknown 404', async () => {
    const v = await lykia.audio.voices.create({
      model: 'elevenlabs/eleven_multilingual_v2',
      name: 'Me',
      file: [{ data: new Uint8Array(100), filename: 'a.mp3', contentType: 'audio/mpeg' }, new File([new Uint8Array(50)], 'b.mp3', { type: 'audio/mpeg' })],
      consent: true,
    });
    expect(v).toMatchObject({ object: 'voice', name: 'Me', category: 'cloned', provider: 'elevenlabs', requires_verification: false });
    expect(v.id).toMatch(/^lvc_[0-9A-Za-z]{20}$/);
    const body = last().body as { files: unknown[]; order: string[] };
    expect(body.files).toHaveLength(2);
    expect(body.order.slice(-2)).toEqual(['file', 'file']);
    const list = await lykia.audio.voices.list({ model: 'elevenlabs/eleven_multilingual_v2' });
    expect(list.data.map((x) => x.id)).toContain(v.id);
    const form = new FormData();
    form.append('model', 'm');
    form.append('name', 'n');
    form.append('file', new Blob([new Uint8Array(10)], { type: 'audio/mpeg' }), 'a.mp3');
    const raw = await fetch(`${fake.url}/audio/voices`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form });
    expect(raw.status).toBe(400);
    expect(((await raw.json()) as { error: { code: string; metadata: { param: string } } }).error).toMatchObject({ code: 'consent_required', metadata: { param: 'consent' } });
    expect(await lykia.audio.voices.delete(v.id)).toEqual({ id: v.id, object: 'voice', deleted: true });
    expect(await catchErr(lykia.audio.voices.delete(v.id))).toMatchObject({ status: 404, code: 'voice_not_found' });
  });

  it('transcriptions send the file as the LAST part, JSON fields as strings, and surface cost and ignored fields', async () => {
    const t = await lykia.audio.transcriptions.create({
      model: '@stt',
      file: { data: new Uint8Array(4000), filename: 'a.mp3', contentType: 'audio/mpeg' },
      language: 'tr',
      response_format: 'verbose_json',
      provider_options: { diarize: true },
      provider: { only: ['elevenlabs'] },
      metadata: { t: '1' },
    });
    const body = last().body as { order: string[]; fields: Record<string, string> };
    expect(body.order.at(-1)).toBe('file');
    expect(body.fields).toMatchObject({ provider_options: '{"diarize":true}', provider: '{"only":["elevenlabs"]}', metadata: '{"t":"1"}' });
    expect(last().notes).toEqual([]);
    expect(t).toMatchObject({ text: 'merhaba dünya', language: 'tr', usage: { is_byok: false } });
    expect(t._meta.cost).toBe(t.usage!.cost);
    expect(t._meta.ignoredFields).toEqual([]);

    fake.enqueue('POST /audio/transcriptions', { headers: { 'X-Lykia-Ignored-Fields': 'language,prompt' }, json: { text: 'x' } });
    const ignored = await lykia.audio.transcriptions.create({ model: '@stt', file: new Blob([new Uint8Array(10)]) });
    expect(ignored._meta.ignoredFields).toEqual(['language', 'prompt']);
  });

  it('the fake reports fields after the file and a file sent first, like the gateway', async () => {
    const send = async (parts: Array<[string, string | Blob]>) => {
      const form = new FormData();
      for (const [k, v] of parts) {
        if (typeof v === 'string') form.append(k, v);
        else form.append(k, v, 'a.mp3');
      }
      return fetch(`${fake.url}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form });
    };
    const blob = new Blob([new Uint8Array(100)], { type: 'audio/mpeg' });
    const after = await send([['model', '@stt'], ['file', blob], ['language', 'tr']]);
    expect(after.headers.get('x-lykia-ignored-fields')).toBe('language');
    await send([['file', blob], ['model', '@stt']]);
    expect(last().notes[0]).toMatch(/spools the upload/);
  });
});

describe('catalog, key and errors', () => {
  it('models: chat by default; kind / output_modalities filters; media details; get() finds media models', async () => {
    expect((await lykia.models.list()).data.every((m) => m.kind === 'chat')).toBe(true);
    const images = await lykia.models.list({ kind: 'image' });
    expect(images.data.map((m) => m.id)).toEqual(['recraft/recraftv4_1']);
    expect(images.data[0]).toMatchObject({ is_free: false, media: { kind: 'image', pricing: { unit: 'per_image' }, providers: ['recraft'] } });
    expect(last().query).toEqual({ kind: 'image' });
    expect((await lykia.models.list({ output_modalities: 'embedding' })).data.map((m) => m.kind)).toEqual(['embedding']);
    expect((await lykia.models.list({ output_modalities: 'all' })).data.length).toBeGreaterThan(4);
    expect((await lykia.models.get('elevenlabs/scribe_v2')).kind).toBe('transcription');
  });

  it('key: OAuth tokens carry scopes and the connected app', async () => {
    const loose = await createFakeLykia();
    try {
      const k = await new Lykia({ apiKey: 'lyk-oat-' + 'x'.repeat(40), baseURL: loose.url }).key.get();
      expect(k.app).toEqual({ client_id: 'https://getlykia.com/oauth/clients/lykia-mcp.json', name: 'Lykia MCP bridge (@lykia/mcp)' });
      expect(k.scopes).toContain('images');
    } finally {
      await loose.close();
    }
  });

  it('errors expose type, param, provider_code, billed_by_provider and cost from metadata', async () => {
    fake.enqueue('POST /images/generations', {
      status: 400,
      json: { error: { message: 'Rejected', type: 'invalid_request_error', code: 'content_policy', status: 400, metadata: { reason: 'content_policy', provider: 'xai', provider_code: 'moderation_blocked', billed_by_provider: true, cost: 0.02, param: 'prompt' } } },
    });
    const e = await catchErr(lykia.images.generate({ model: '@image', prompt: 'x' }));
    expect(e).toMatchObject({ code: 'content_policy', reason: 'content_policy', type: 'invalid_request_error', provider: 'xai', param: 'prompt', providerCode: 'moderation_blocked', billedByProvider: true, cost: 0.02, retryable: false });
    expect(await catchErr(lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }], provider: { sort: 'latency' as never } }))).toMatchObject({ code: 'unsupported_sort' });
    expect(await catchErr(lykia.embeddings.create({ model: 'openai/gpt-4o-mini', input: 'x' }))).toMatchObject({ code: 'unsupported_model' });
    const anon = await fetch(`${fake.url}/key`);
    expect(((await anon.json()) as { error: { code: string; type: string } }).error).toMatchObject({ code: 'missing_api_key', type: 'authentication_error' });
    fake.enqueue('GET /key', fakeError(403, { code: 'project_archived' }));
    expect(await catchErr(lykia.key.get())).toMatchObject({ status: 403, type: 'permission_error', reason: 'forbidden' });
    await sleep(0);
  });
});

describe('stream summary: the model, provider and preset that served the request', () => {
  it('final() and the done event carry model, provider (from the chunks) and preset (X-Lykia-Preset)', async () => {
    const stream = lykia.chat.completions.stream({ model: '@text', messages: [{ role: 'user', content: 'hi' }] });
    const events: ChatStreamEvent[] = [];
    for await (const e of stream) events.push(e);
    const done = events.at(-1)!;
    expect(done).toMatchObject({ type: 'done', model: 'openai/gpt-4o-mini', provider: 'openai', preset: 'text' });
    expect(await stream.final()).toMatchObject({ model: 'openai/gpt-4o-mini', provider: 'openai', preset: 'text' });
    const direct = await lykia.chat.completions.stream({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }).final();
    expect(direct).toMatchObject({ model: 'openai/gpt-4o-mini', provider: 'openai', preset: undefined });
  });

  it('createAiSdkFetch onResult carries model, provider and preset for streams and JSON responses', async () => {
    const results: AiSdkResultInfo[] = [];
    const provider = createOpenAICompatible({ name: 'lykia', baseURL: fake.url, apiKey: KEY, includeUsage: true, fetch: createAiSdkFetch({ onResult: (r) => results.push(r) }) });
    const run = streamText({ model: provider.chatModel('@text'), prompt: 'hi', maxRetries: 0 });
    for await (const _ of run.textStream) {
      // drain
    }
    await generateText({ model: provider.chatModel('@text'), prompt: 'hi', maxRetries: 0 });
    await sleep(20);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ streamed: true, model: 'openai/gpt-4o-mini', provider: 'openai', preset: 'text' });
    expect(results[1]).toMatchObject({ streamed: false, model: 'openai/gpt-4o-mini', provider: 'openai', preset: 'text' });
  });
});

describe('multipart order on the wire (raw body)', () => {
  /** Captures the raw multipart body the SDK sends and returns the part names in order. */
  async function partsOf(send: (l: Lykia) => Promise<unknown>, reply: unknown): Promise<string[]> {
    let raw = '';
    const capture = new Lykia({
      apiKey: KEY,
      baseURL: 'http://127.0.0.1:9/v1',
      fetch: async (_url, init) => {
        raw = await new Response(init!.body as BodyInit, { headers: init!.headers as HeadersInit }).text();
        return new Response(JSON.stringify(reply), { status: 200, headers: { 'Content-Type': 'application/json' } });
      },
    });
    await send(capture);
    return [...raw.matchAll(/Content-Disposition: form-data; name="([^"]+)"/g)].map((m) => m[1]!);
  }

  it('transcriptions: every field first, the file part last', async () => {
    const names = await partsOf(
      (l) => l.audio.transcriptions.create({ model: '@stt', file: { data: new Uint8Array(10), filename: 'a.mp3', contentType: 'audio/mpeg' }, language: 'tr', prompt: 'p', response_format: 'json', temperature: 0, timestamp_granularities: ['word'], provider_options: { a: 1 }, provider: { only: ['x'] }, user: 'u', metadata: { k: 'v' } }),
      { text: '' },
    );
    expect(names).toEqual(['model', 'language', 'prompt', 'response_format', 'temperature', 'timestamp_granularities[]', 'provider_options', 'provider', 'user', 'metadata', 'file']);
  });

  it('voice clone: every field first, all file parts last', async () => {
    const f = { data: new Uint8Array(10), filename: 's.mp3', contentType: 'audio/mpeg' };
    const names = await partsOf((l) => l.audio.voices.create({ model: 'm', name: 'n', file: [f, f, f], consent: true, description: 'd', language: 'en' }), { id: 'lvc_x' });
    expect(names).toEqual(['model', 'name', 'consent', 'description', 'language', 'file', 'file', 'file']);
  });
});

describe('speech without a voice', () => {
  it('the type allows it (preset default voice); without one the fake answers like the gateway: 400 bad_request, param voice', async () => {
    const err = await catchErr(lykia.audio.speech({ model: '@tts', input: 'Merhaba' }));
    expect(err).toMatchObject({ status: 400, code: 'bad_request', param: 'voice', type: 'invalid_request_error' });
  });
});
