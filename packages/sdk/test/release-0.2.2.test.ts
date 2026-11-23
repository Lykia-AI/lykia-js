/**
 * 0.2.2: the fake's generation records carry exactly the cost the client saw, and the gateway changes of 2026-11-24
 * (speech X-Lykia-Model / X-Lykia-Provider, preset default voice, voices `provider`, video_output_unavailable).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Lykia, type LykiaError } from '../src/index.js';
import { chatChunks, createFakeLykia, fakeUsage, type FakeLykia } from '../src/testing/index.js';

const KEY = 'lyk-v1-' + 'e'.repeat(64);
let fake: FakeLykia;
let lykia: Lykia;
beforeAll(async () => {
  fake = await createFakeLykia({ apiKey: KEY, videoTimeline: { queuedMs: 30, runningMs: 60 }, presetDefaults: { narrator: { voice: 'JBFqnCBsd6RMkjVDRZzb' } }, presets: { text: 'chat', embedding: 'embedding', image: 'image', video: 'video', tts: 'speech', stt: 'transcription', narrator: 'speech' } });
  lykia = new Lykia({ apiKey: KEY, baseURL: fake.url });
});
afterAll(() => fake.close());
afterEach(() => fake.reset());

const catchErr = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as LykiaError);
const recorded = (id: string | undefined) => fake.generations.find((g) => g.id === id)?.cost;
const msg = [{ role: 'user' as const, content: 'hi' }];

describe('fake generation records: the cost the client saw', () => {
  it('chat (JSON, default stream, scripted stream cost, scripted usage, queued JSON)', async () => {
    const c = await lykia.chat.completions.create({ model: '@text', messages: msg });
    expect(recorded(c.id)).toBe(c.usage!.cost);

    const s = await lykia.chat.completions.stream({ model: '@text', messages: msg }).final();
    expect(recorded(s.generationId)).toBe(s.usage!.cost);

    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'x', cost: 0.4242 }) });
    const scripted = await lykia.chat.completions.stream({ model: '@text', messages: msg }).final();
    expect(scripted.usage!.cost).toBe(0.4242);
    expect(recorded(scripted.generationId)).toBe(0.4242);

    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'x', usage: fakeUsage({ cost: 0.17 }) }) });
    const viaUsage = await lykia.chat.completions.stream({ model: '@text', messages: msg }).final();
    expect(recorded(viaUsage.generationId)).toBe(0.17);

    fake.enqueue('POST /chat/completions', { json: { id: 'x', object: 'chat.completion', created: 1, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'q' }, finish_reason: 'stop' }], usage: fakeUsage({ cost: 0.9 }) } });
    const queued = await lykia.chat.completions.create({ model: '@text', messages: msg });
    expect(recorded(queued._meta.generationId)).toBe(0.9);
  });

  it('a stream without a usage chunk records 0 (nothing was reported to the client)', async () => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'x', usage: null }) });
    const f = await lykia.chat.completions.stream({ model: '@text', messages: msg }).final();
    expect(f.usage).toBeUndefined();
    expect(recorded(f.generationId)).toBe(0);
  });

  it('embeddings, images, speech, transcription, video', async () => {
    const e = await lykia.embeddings.create({ model: '@embedding', input: ['a', 'b'] });
    expect(recorded(e._meta.generationId)).toBe(e.usage!.cost);

    const i = await lykia.images.generate({ model: '@image', prompt: 'fox', n: 2 });
    expect(recorded(i.id)).toBe(i.usage.cost);
    expect(recorded(i.id)).toBe(i._meta.cost);

    const sp = await lykia.audio.speech({ model: '@tts', input: 'Merhaba dünya, nasılsın?', voice: 'JBFqnCBsd6RMkjVDRZzb' });
    expect(sp.cost).toBeGreaterThan(0);
    expect(recorded(sp.generationId)).toBe(sp.cost);

    const t = await lykia.audio.transcriptions.create({ model: '@stt', file: { data: new Uint8Array(32000), filename: 'a.mp3', contentType: 'audio/mpeg' } });
    expect(recorded(t._meta.generationId)).toBe(t._meta.cost);
    expect(t._meta.cost).toBe(t.usage!.cost);

    const job = await lykia.videos.create({ model: '@video', prompt: 'waves' });
    const done = await lykia.videos.wait(job.id, { intervalMs: 20 });
    const file = await lykia.videos.content(job.id);
    expect(recorded(job.id)).toBe(done.usage!.cost);
    expect(recorded(job.id)).toBe(file.cost);
  });
});

describe('speech: model / provider headers and the preset default voice', () => {
  it('returns model and provider from X-Lykia-Model / X-Lykia-Provider', async () => {
    const sp = await lykia.audio.speech({ model: '@tts', input: 'x', voice: 'JBFqnCBsd6RMkjVDRZzb' });
    expect(sp).toMatchObject({ model: 'elevenlabs/eleven_multilingual_v2', provider: 'elevenlabs' });
    expect(sp._meta.preset).toBe('tts');
  });

  it("falls back to the preset's default voice; 400 param voice only when neither gives one", async () => {
    const sp = await lykia.audio.speech({ model: '@narrator', input: 'x' });
    expect(sp.data.byteLength).toBeGreaterThan(0);
    expect(fake.requests.at(-1)!.violations).toEqual([]);
    expect(await catchErr(lykia.audio.speech({ model: '@tts', input: 'x' }))).toMatchObject({ status: 400, code: 'bad_request', param: 'voice' });
    expect(await catchErr(lykia.audio.speech({ model: 'elevenlabs/eleven_multilingual_v2', input: 'x' }))).toMatchObject({ status: 400, code: 'bad_request', param: 'voice' });
  });

  it('voices list carries the provider', async () => {
    expect(await lykia.audio.voices.list()).toMatchObject({ object: 'list', model: 'elevenlabs/eleven_multilingual_v2', provider: 'elevenlabs' });
  });
});

describe('video_output_unavailable', () => {
  it('a completed job whose output could not be stored: output null + error; content 502; still billed', async () => {
    const job = await lykia.videos.create({ model: '@video', prompt: 'waves #output-unavailable' });
    const done = await lykia.videos.wait(job.id, { intervalMs: 20 });
    expect(done).toMatchObject({ status: 'completed', output: null, error: { code: 'video_output_unavailable', reason: 'provider_error', retryable: false } });
    expect(done.usage!.cost).toBeGreaterThan(0);
    expect(recorded(job.id)).toBe(done.usage!.cost);
    expect(await catchErr(lykia.videos.content(job.id))).toMatchObject({ status: 502, code: 'video_output_unavailable', reason: 'provider_error', type: 'provider_error', provider: 'bytedance' });
    expect(await catchErr(lykia.videos.contentUrl(job.id))).toMatchObject({ status: 502, code: 'video_output_unavailable' });
  });

  it('410 video_expired stays for real expiry only', async () => {
    const job = await lykia.videos.create({ model: '@video', prompt: 'x #expired' });
    await lykia.videos.wait(job.id, { intervalMs: 20 });
    expect(await catchErr(lykia.videos.content(job.id))).toMatchObject({ status: 410, code: 'video_expired' });
  });
});
