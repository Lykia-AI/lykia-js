/**
 * Opt-in conformance run of @lykia/sdk against a REAL Lykia gateway (skipped unless both are set):
 *
 *   LYKIA_CONFORMANCE_URL=http://127.0.0.1:7821/v1 LYKIA_CONFORMANCE_KEY=lyk-v1-… npx vitest run packages/sdk/test/conformance.test.ts
 *
 * The project behind the key needs the presets @text (chat), @embedding, @image, @video, @tts and @stt, and credits.
 * Optional: LYKIA_CONFORMANCE_VOICE (a preset voice id of the @tts model), LYKIA_CONFORMANCE_CONTROL (the control URL
 * of scripts/conformance/backend-env.mjs, to script a mid-stream provider failure), LYKIA_CONFORMANCE_VIDEO_FAIL_PROMPT
 * (a prompt the provider fails on; the backend's fake ByteDance uses "#fail-generic").
 * It spends a little money on a real deployment: run it against a staging or local gateway.
 */
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { describe, expect, it } from 'vitest';
import { Lykia, LykiaError, createAiSdkFetch, sanitizeTags, type AiSdkResultInfo } from '../src/index.js';

const URL_ = process.env['LYKIA_CONFORMANCE_URL'];
const KEY = process.env['LYKIA_CONFORMANCE_KEY'];
const CONTROL = process.env['LYKIA_CONFORMANCE_CONTROL'];
const VOICE = process.env['LYKIA_CONFORMANCE_VOICE'] ?? 'JBFqnCBsd6RMkjVDRZzb';
const FAIL_PROMPT = process.env['LYKIA_CONFORMANCE_VIDEO_FAIL_PROMPT'] ?? 'x #fail-generic';
const enabled = Boolean(URL_ && KEY);

const lykia = enabled ? new Lykia({ apiKey: KEY!, baseURL: URL_!, timeoutMs: 120_000 }) : (undefined as unknown as Lykia);
const catchErr = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as LykiaError);
const msg = [{ role: 'user' as const, content: 'Merhaba' }];
const scriptStreamError = async () => {
  if (!CONTROL) return false;
  await fetch(`${CONTROL}/script`, { method: 'POST', body: JSON.stringify({ flavor: 'together', behaviors: [{ streamError: true, after: 2 }] }) });
  return true;
};

describe.skipIf(!enabled)('conformance: @lykia/sdk against a real gateway', { timeout: 180_000 }, () => {
  it('chat: completion, _meta headers, usage cost and cost_details', async () => {
    const r = await lykia.chat.completions.create({ model: '@text', messages: msg, ...sanitizeTags({ user: 'conformance', metadata: { suite: 'sdk' } }) });
    expect(r).toMatchObject({ object: 'chat.completion', id: expect.stringMatching(/^gen-/) });
    expect(r._meta).toMatchObject({ generationId: r.id, preset: 'text', reasoningDropped: false });
    expect(typeof r.usage?.cost).toBe('number');
    expect(r.usage?.cost_details).toMatchObject({ is_byok: false });
  });

  it('chat stream: events, final usage; a mid-stream provider failure throws a LykiaError with error.status', async () => {
    const f = await lykia.chat.completions.stream({ model: '@text', messages: msg }).final();
    expect(f.finishReason).toBeTruthy();
    expect(typeof f.usage?.cost).toBe('number');
    expect(f.preset).toBe('text');
    expect(f.model).toMatch(/\//);
    expect(f.provider).toBeTruthy();
    if (await scriptStreamError()) {
      const err = await catchErr(lykia.chat.completions.stream({ model: '@text', messages: msg }).final());
      expect(err).toBeInstanceOf(LykiaError);
      expect(err).toMatchObject({ status: 502, code: 'provider_error', reason: 'provider_error', retryable: true, generationId: expect.stringMatching(/^gen-/) });
    }
  });

  it('createAiSdkFetch + the real AI SDK: cost reported; a mid-stream failure becomes an error part', async () => {
    const results: AiSdkResultInfo[] = [];
    const errors: LykiaError[] = [];
    const provider = createOpenAICompatible({ name: 'lykia', baseURL: URL_!, apiKey: KEY!, includeUsage: true, fetch: createAiSdkFetch({ onResult: (r) => results.push(r), onError: (e) => errors.push(e) }) });
    const ok = streamText({ model: provider.chatModel('@text'), prompt: 'Merhaba', maxRetries: 0 });
    let text = '';
    for await (const t of ok.textStream) text += t;
    expect(text.length).toBeGreaterThan(0);
    expect(results.at(-1)).toMatchObject({ streamed: true, preset: 'text', model: expect.stringMatching(/\//), provider: expect.any(String), cost: expect.any(Number) });
    if (await scriptStreamError()) {
      const run = streamText({ model: provider.chatModel('@text'), prompt: 'x', maxRetries: 0, onError: () => undefined });
      const types: string[] = [];
      for await (const part of run.fullStream) types.push(part.type);
      expect(types).toContain('error');
      expect(errors.at(-1)).toMatchObject({ status: 502, reason: 'provider_error' });
    }
  });

  it('errors: preset_not_found, preset_modality_mismatch, invalid_tags, unsupported_sort, too_many_files, invalid key', async () => {
    expect(await catchErr(lykia.chat.completions.create({ model: '@conformance-undefined', messages: msg }))).toMatchObject({ status: 400, code: 'preset_not_found', type: 'invalid_request_error' });
    expect(await catchErr(lykia.chat.completions.create({ model: '@image', messages: msg }))).toMatchObject({ status: 400, code: 'preset_modality_mismatch' });
    expect(await catchErr(lykia.chat.completions.create({ model: '@text', messages: msg, user: 'u'.repeat(129) }))).toMatchObject({ code: 'invalid_tags' });
    expect(await catchErr(lykia.chat.completions.create({ model: '@text', messages: msg, provider: { sort: 'latency' as never } }))).toMatchObject({ code: 'unsupported_sort' });
    const pdf = { type: 'file' as const, file: { filename: 'a.pdf', file_data: 'data:application/pdf;base64,AA==' } };
    expect(await catchErr(lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: Array(9).fill(pdf) }] }))).toMatchObject({ code: 'too_many_files' });
    const bad = new Lykia({ apiKey: 'lyk-v1-' + '0'.repeat(64), baseURL: URL_! });
    expect(await catchErr(bad.key.get())).toMatchObject({ status: 401, code: 'invalid_api_key', reason: 'unauthorized', type: 'authentication_error', retryable: false });
  });

  it('embeddings, models (kinds), key, credits, generations', async () => {
    const e = await lykia.embeddings.create({ model: '@embedding', input: ['a', 'b'], dimensions: 4 });
    expect(e.data).toHaveLength(2);
    expect(e._meta.preset).toBe('embedding');
    expect(await catchErr(lykia.embeddings.create({ model: (await lykia.models.list()).data[0]!.id, input: 'a' }))).toMatchObject({ code: 'unsupported_model' });
    const chat = await lykia.models.list();
    expect(chat.data.every((m) => m.kind === 'chat')).toBe(true);
    const images = await lykia.models.list({ kind: 'image' });
    expect(images.data.length).toBeGreaterThan(0);
    expect(images.data[0]).toMatchObject({ kind: 'image', media: { kind: 'image' } });
    expect(images.data[0]!.media!.pricing.unit).toBeTruthy();
    expect((await lykia.models.list({ output_modalities: 'video' })).data.every((m) => m.kind === 'video')).toBe(true);
    const key = await lykia.key.get();
    expect(key.company?.id).toBeTruthy();
    expect(key.project?.id).toBeTruthy();
    const credits = await lykia.credits.get();
    expect(['prepaid', 'internal']).toContain(credits.billing_mode);
    const list = await lykia.generations.list({ limit: 2 });
    expect(Array.isArray(list.data)).toBe(true);
    expect('next_cursor' in list).toBe(true);
    const g = await lykia.generations.get(list.data[0]!.id);
    expect(g).toMatchObject({ id: list.data[0]!.id, kind: expect.any(String), endpoint: expect.any(String), cost_details: expect.any(Object) });
  });

  it('images: gateway shape, X-Lykia-Cost, b64_json; n validated with metadata.param', async () => {
    const r = await lykia.images.generate({ model: '@image', prompt: 'a red fox', user: 'conformance' });
    expect(r).toMatchObject({ object: 'image.generation', id: r._meta.generationId, usage: { images: 1, is_byok: false } });
    expect(r._meta.cost).toBe(r.usage.cost);
    expect(r.data[0]!.url ?? r.data[0]!.b64_json).toBeTruthy();
    const b = await lykia.images.generate({ model: '@image', prompt: 'x', response_format: 'b64_json' });
    expect(b.data[0]!.b64_json).toBeTruthy();
    expect(await catchErr(lykia.images.generate({ model: '@image', prompt: 'x', n: 99 }))).toMatchObject({ status: 400, param: 'n' });
  });

  it('videos: lifecycle, content / contentUrl, list, cancel, failure, not-ready and unknown', async () => {
    const job = await lykia.videos.create({ model: '@video', prompt: 'a cat on a roof', duration: 5 });
    expect(job).toMatchObject({ object: 'video', status: 'queued', id: expect.stringMatching(/^gen-/) });
    expect(await catchErr(lykia.videos.content(job.id))).toMatchObject({ status: 409, code: 'video_not_ready' });
    const done = await lykia.videos.wait(job.id, { intervalMs: 500, timeoutMs: 150_000 });
    expect(done).toMatchObject({ status: 'completed', progress: 100, usage: { is_byok: false } });
    expect(typeof done.duration_seconds).toBe('number');
    if (done.output?.url) {
      const url = await lykia.videos.contentUrl(job.id);
      expect(url).toMatchObject({ mime_type: 'video/mp4' });
    }
    const file = await lykia.videos.content(job.id);
    expect(file.data.byteLength).toBeGreaterThan(0);
    expect(file.cost).toBe(done.usage!.cost);
    expect(file.generationId).toBe(job.id);
    const page = await lykia.videos.list({ limit: 1 });
    expect(page).toMatchObject({ object: 'list' });
    expect(typeof page.has_more).toBe('boolean');
    expect(await catchErr(lykia.videos.cancel(job.id))).toMatchObject({ status: 409, code: 'job_not_cancellable' });
    const c = await lykia.videos.create({ model: '@video', prompt: 'cancel me', duration: 5 });
    expect(await lykia.videos.cancel(c.id)).toMatchObject({ status: 'cancelled' });
    expect(await catchErr(lykia.videos.wait(c.id, { intervalMs: 500 }))).toMatchObject({ code: 'video_cancelled' });
    const f = await lykia.videos.create({ model: '@video', prompt: FAIL_PROMPT, duration: 5 });
    expect(await catchErr(lykia.videos.wait(f.id, { intervalMs: 500, timeoutMs: 150_000 }))).toMatchObject({ code: 'video_failed' });
    expect(await catchErr(lykia.videos.get('gen-conformance-unknown'))).toMatchObject({ status: 404, code: 'not_found' });
  });

  it('audio: speech bytes + cost, voices list / clone / delete, consent and unknown voice errors, transcription (file last)', async () => {
    const s = await lykia.audio.speech({ model: '@tts', input: 'Merhaba dünya', voice: VOICE });
    expect(s.data.byteLength).toBeGreaterThan(0);
    expect(s.contentType).toMatch(/^audio\//);
    expect(typeof s.cost).toBe('number');
    expect(await catchErr(lykia.audio.speech({ model: '@tts', input: 'x' }))).toMatchObject({ status: 400, code: 'bad_request', param: 'voice' });
    const voices = await lykia.audio.voices.list();
    expect(voices).toMatchObject({ object: 'list' });
    expect(voices.data[0]).toMatchObject({ object: 'voice', category: expect.any(String) });
    const clone = await lykia.audio.voices.create({ model: voices.model, name: 'Conformance', file: { data: new Uint8Array(2000).fill(3), filename: 's.mp3', contentType: 'audio/mpeg' }, consent: true });
    expect(clone).toMatchObject({ object: 'voice', category: 'cloned' });
    expect(clone.id).toMatch(/^lvc_/);
    expect(await lykia.audio.voices.delete(clone.id)).toMatchObject({ id: clone.id, deleted: true });
    expect(await catchErr(lykia.audio.voices.delete(clone.id))).toMatchObject({ status: 404, code: 'voice_not_found' });
    const form = new FormData();
    form.append('model', voices.model);
    form.append('name', 'x');
    form.append('file', new Blob([new Uint8Array(100)], { type: 'audio/mpeg' }), 'a.mp3');
    const raw = await fetch(`${URL_}/audio/voices`, { method: 'POST', headers: { Authorization: `Bearer ${KEY}` }, body: form });
    expect(((await raw.json()) as { error: { code: string } }).error.code).toBe('consent_required');
    const t = await lykia.audio.transcriptions.create({ model: '@stt', file: { data: new Uint8Array(4000).fill(7), filename: 'a.mp3', contentType: 'audio/mpeg' }, metadata: { suite: 'sdk' } });
    expect(typeof t.text).toBe('string');
    expect(typeof t.usage?.cost).toBe('number');
    expect(t._meta.cost).toBe(t.usage!.cost);
    expect(t._meta.ignoredFields).toEqual([]);
  });
});
