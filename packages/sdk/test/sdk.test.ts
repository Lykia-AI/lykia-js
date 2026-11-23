import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Lykia, LykiaError, isPreset, preset, type ChatStreamEvent } from '../src/index.js';
import { chatChunks, createFakeLykia, fakeError, fakeUsage, type FakeLykia } from '../src/testing/index.js';

const KEY = 'lyk-v1-' + 'a'.repeat(64);
let fake: FakeLykia;
let lykia: Lykia;

beforeAll(async () => {
  fake = await createFakeLykia({ apiKey: KEY });
  lykia = new Lykia({ apiKey: KEY, baseURL: fake.url, defaultHeaders: { 'X-Title': 'SDK tests' } });
});
afterAll(() => fake.close());
afterEach(() => fake.reset());

const last = () => fake.requests.at(-1)!;
const catchErr = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as LykiaError);

describe('client setup', () => {
  it('requires an API key', () => {
    const err = (() => {
      try {
        new Lykia({ apiKey: '' });
      } catch (e) {
        return e as LykiaError;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(LykiaError);
    expect(err?.code).toBe('invalid_request');
  });

  it('refuses to run in a browser page unless allowed', () => {
    const g = globalThis as Record<string, unknown>;
    g['window'] = {};
    g['document'] = {};
    try {
      expect(() => new Lykia({ apiKey: KEY })).toThrow(/browser/);
      expect(() => new Lykia({ apiKey: KEY, dangerouslyAllowBrowser: true })).not.toThrow();
    } finally {
      delete g['window'];
      delete g['document'];
    }
  });

  it('defaults the base URL and trims trailing slashes', () => {
    expect(new Lykia({ apiKey: KEY, baseURL: 'https://x.test/v1/' }).baseURL).toBe('https://x.test/v1');
  });
});

describe('chat.completions.create', () => {
  it('returns the completion with _meta from the response headers', async () => {
    const res = await lykia.chat.completions.create({
      model: preset('text'),
      messages: [{ role: 'system', content: [{ type: 'text', text: 'be brief', cache_control: { type: 'ephemeral' } }] }, { role: 'user', content: 'hello' }],
      user: 'u-1',
      metadata: { tenant: 't1' },
      reasoning: { effort: 'low' },
      provider: { only: ['anthropic'], allow_fallbacks: false },
    });
    expect(res.choices[0]!.message.content).toBe('echo: hello');
    expect(res._meta).toEqual({ generationId: res.id, preset: 'text', maxTokensApplied: 4096, reasoningDropped: false, cost: undefined, ignoredFields: [] });
    expect(res.usage?.cost_details?.platform_fee).toBeGreaterThan(0);
    expect(res.usage?.prompt_tokens_details?.cached_tokens).toBe(0);
    const req = last();
    expect(req.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(req.headers['x-title']).toBe('SDK tests');
    expect(req.body).toMatchObject({ model: '@text', user: 'u-1', metadata: { tenant: 't1' }, provider: { only: ['anthropic'], allow_fallbacks: false } });
  });

  it('round-trips reasoning_details unchanged in the next turn', async () => {
    const details = [{ type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: 'think', signature: 'sig==' }];
    fake.enqueue('POST /chat/completions', {
      json: {
        id: 'gen-x',
        object: 'chat.completion',
        created: 1,
        model: 'anthropic/claude-sonnet-4.5',
        choices: [{ index: 0, message: { role: 'assistant', content: null, reasoning: 'think', reasoning_details: details, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: 'tool_calls' }],
        usage: fakeUsage({ reasoning: 3 }),
      },
    });
    const first = await lykia.chat.completions.create({ model: 'anthropic/claude-sonnet-4.5', messages: [{ role: 'user', content: 'go' }] });
    const msg = first.choices[0]!.message;
    await lykia.chat.completions.create({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [{ role: 'user', content: 'go' }, { ...msg }, { role: 'tool', tool_call_id: 'c1', content: 'ok' }],
    });
    const sent = last().body as { messages: Array<Record<string, unknown>> };
    expect(sent.messages[1]!['reasoning_details']).toEqual(details);
  });

  it('refuses stream: true (use stream())', async () => {
    const err = await catchErr(lykia.chat.completions.create({ messages: [], stream: true } as never));
    expect(err?.code).toBe('invalid_request');
  });

  it('maps the error body to LykiaError (code, reason, retryable, retryAfter, generationId)', async () => {
    fake.enqueue('POST /chat/completions', fakeError(429, { code: 'rate_limited', reason: 'rate_limited', retry_after: 7, message: 'Slow down' }));
    const e1 = await catchErr(lykia.chat.completions.create({ messages: [{ role: 'user', content: 'x' }] }));
    expect(e1).toBeInstanceOf(LykiaError);
    expect(e1).toMatchObject({ status: 429, code: 'rate_limited', reason: 'rate_limited', retryable: true, retryAfter: 7 });
    expect(e1?.generationId).toMatch(/^gen-/);
    expect(e1?.message).toContain('Slow down');

    // Strict fake: an undefined preset is rejected before any queued response is used.
    const e2 = await catchErr(lykia.chat.completions.create({ model: '@nope', messages: [{ role: 'user', content: 'x' }] }));
    expect(e2).toMatchObject({ status: 400, code: 'preset_not_found', reason: 'invalid_request', retryable: false });

    fake.enqueue('POST /chat/completions', fakeError(502, { reason: 'provider_error', provider: 'openai' }));
    const e3 = await catchErr(lykia.chat.completions.create({ messages: [{ role: 'user', content: 'x' }] }));
    expect(e3).toMatchObject({ status: 502, reason: 'provider_error', retryable: true, provider: 'openai' });

    fake.enqueue('POST /chat/completions', { status: 400, json: { error: { message: 'old shape' } } });
    const e4 = await catchErr(lykia.chat.completions.create({ messages: [{ role: 'user', content: 'x' }] }));
    expect(e4).toMatchObject({ status: 400, code: 'bad_request', retryable: false });

    const unauth = new Lykia({ apiKey: 'lyk-v1-wrong', baseURL: fake.url });
    expect(await catchErr(unauth.key.get())).toMatchObject({ status: 401, code: 'invalid_api_key' });
  });

  it('reports network failures and timeouts with status 0', async () => {
    const dead = new Lykia({ apiKey: KEY, baseURL: 'http://127.0.0.1:9/v1' });
    expect(await catchErr(dead.models.list())).toMatchObject({ status: 0, code: 'network_error', retryable: true });

    fake.enqueue('GET /providers', { delayMs: 400, json: { data: [] } });
    expect(await catchErr(lykia.providers.list({ timeoutMs: 50 }))).toMatchObject({ status: 0, code: 'timeout', reason: 'timeout', retryable: true });

    fake.enqueue('GET /key', { delayMs: 400, json: { data: {} } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(await catchErr(lykia.key.get({ signal: controller.signal }))).toMatchObject({ status: 0, code: 'aborted', retryable: false });
  });

  it('does not retry by default; with maxRetries retries GETs and 429 + Retry-After only', async () => {
    fake.enqueue('GET /models', fakeError(503, { reason: 'overloaded', retry_after: 0 }));
    expect(await catchErr(lykia.models.list())).toMatchObject({ status: 503 });
    expect(fake.requests.length).toBe(1);

    fake.reset();
    const retrying = new Lykia({ apiKey: KEY, baseURL: fake.url, maxRetries: 2 });
    fake.enqueue('GET /models', fakeError(503, { reason: 'overloaded', retry_after: 0 }));
    fake.enqueue('GET /models', fakeError(503, { reason: 'overloaded', retry_after: 0 }));
    expect((await retrying.models.list()).data.length).toBeGreaterThan(0);
    expect(fake.requests.length).toBe(3);

    fake.reset();
    fake.enqueue('POST /chat/completions', fakeError(502, { reason: 'provider_error' }));
    expect(await catchErr(retrying.chat.completions.create({ messages: [{ role: 'user', content: 'x' }] }))).toMatchObject({ status: 502 });
    expect(fake.requests.length).toBe(1);

    fake.reset();
    fake.enqueue('POST /chat/completions', fakeError(429, { reason: 'rate_limited', retry_after: 0 }));
    const ok = await retrying.chat.completions.create({ messages: [{ role: 'user', content: 'again' }] });
    expect(ok.choices[0]!.message.content).toBe('echo: again');
    expect(fake.requests.length).toBe(2);
  });
});

describe('chat.completions.stream', () => {
  it('yields text events and a done event with usage', async () => {
    const stream = lykia.chat.completions.stream({ model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'stream me' }] });
    const events: ChatStreamEvent[] = [];
    for await (const e of stream) events.push(e);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('echo: stream me');
    const done = events.at(-1)!;
    expect(done.type).toBe('done');
    if (done.type !== 'done') throw new Error('unreachable');
    expect(done.message).toEqual({ role: 'assistant', content: 'echo: stream me' });
    expect(done.finishReason).toBe('stop');
    expect(done.usage?.cost).toBeGreaterThan(0);
    expect(done.generationId).toMatch(/^gen-/);
    expect(stream.meta?.maxTokensApplied).toBe(4096);
    expect((last().body as { stream: boolean }).stream).toBe(true);
    expect(last().headers['accept']).toBe('text/event-stream');
  });

  it('merges tool call fragments and reasoning_details; final() returns the assembled message', async () => {
    const details = [
      { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: 'Let me ' },
      { type: 'reasoning.text', index: 0, text: 'think.', signature: 'sig==' },
      { type: 'reasoning.encrypted', index: 1, format: 'anthropic-claude-v1', data: 'opaque' },
    ];
    fake.enqueue('POST /chat/completions', {
      stream: chatChunks({
        reasoning: ['Let me ', 'think.'],
        reasoningDetails: details,
        text: 'Calling tools.',
        toolCalls: [
          { id: 'call_1', name: 'get_weather', arguments: ['{"city":', '"Antalya"}'] },
          { id: 'call_2', name: 'get_time', arguments: '{}' },
        ],
      }),
    });
    const stream = lykia.chat.completions.stream({ model: '@assistant', messages: [{ role: 'user', content: 'weather?' }] });
    const toolEvents: Array<Extract<ChatStreamEvent, { type: 'tool_call' }>> = [];
    let reasoning = '';
    for await (const e of stream) {
      if (e.type === 'tool_call') toolEvents.push(e);
      if (e.type === 'reasoning') reasoning += e.delta;
    }
    expect(reasoning).toBe('Let me think.');
    expect(toolEvents.map((e) => [e.index, e.id, e.name, e.argumentsDelta])).toEqual([
      [0, 'call_1', 'get_weather', '{"city":'],
      [0, 'call_1', 'get_weather', '"Antalya"}'],
      [1, 'call_2', 'get_time', '{}'],
    ]);
    const final = await stream.final();
    expect(final.finishReason).toBe('tool_calls');
    expect(final.message.tool_calls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Antalya"}' } },
      { id: 'call_2', type: 'function', function: { name: 'get_time', arguments: '{}' } },
    ]);
    expect(final.message.reasoning).toBe('Let me think.');
    expect(final.message.reasoning_details).toEqual([
      { type: 'reasoning.text', index: 0, format: 'anthropic-claude-v1', text: 'Let me think.', signature: 'sig==' },
      { type: 'reasoning.encrypted', index: 1, format: 'anthropic-claude-v1', data: 'opaque' },
    ]);
  });

  it('final() alone drains the stream', async () => {
    const final = await lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'only final' }] }).final();
    expect(final.message.content).toBe('echo: only final');
  });

  it('throws LykiaError for an in-stream error chunk', async () => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'partial', error: { message: 'Provider died', reason: 'provider_error', status: 502 } }) });
    const stream = lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] });
    const err = await catchErr(stream.final());
    expect(err).toMatchObject({ status: 502, reason: 'provider_error', retryable: true });
    expect(err?.generationId).toBe(stream.generationId);
  });

  it('reports a stream cut short as network_error and supports abort / idle timeout', async () => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'cut' }).slice(0, 2), done: false });
    expect(await catchErr(lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] }).final())).toMatchObject({ code: 'network_error' });

    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'hang' }).slice(0, 2), hang: true });
    const controller = new AbortController();
    const s = lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    expect(await catchErr(s.final())).toMatchObject({ status: 0, code: 'aborted' });

    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'hang' }).slice(0, 2), hang: true });
    const t = lykia.chat.completions.stream({ messages: [{ role: 'user', content: 'x' }] }, { timeoutMs: 100 });
    expect(await catchErr(t.final())).toMatchObject({ status: 0, code: 'timeout' });
  });
});

describe('catalog, account, embeddings', () => {
  it('lists and gets models, providers', async () => {
    const filtered = await lykia.models.list({ supported_parameters: ['tools'] });
    expect(filtered.data.every((m) => m.supported_parameters?.includes('tools'))).toBe(true);
    expect(last().query['supported_parameters']).toBe('tools');
    expect((await lykia.models.get('anthropic/claude-sonnet-4.5')).context_length).toBe(200000);
    expect(await catchErr(lykia.models.get('missing/model'))).toMatchObject({ status: 404, code: 'not_found' });
    expect((await lykia.providers.list()).data[0]!.slug).toBe('openai');
  });

  it('reads key (company/project), credits and generations', async () => {
    const key = await lykia.key.get();
    expect(key.company).toEqual({ id: 'cmp_fake', name: 'Fake Company' });
    expect(key.project?.name).toBe('Fake Project');
    fake.enqueue('GET /credits', { json: { data: { balance: 0, total_usage: 3, billing_mode: 'internal', period_cost: 3.25 } } });
    expect(await lykia.credits.get()).toMatchObject({ billing_mode: 'internal', period_cost: 3.25 });
    const made = await lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'x' }], user: 'u-1', metadata: { tenant: 't1' } });
    const gen = await lykia.generations.get(made._meta.generationId!);
    expect(gen).toMatchObject({ id: made.id, preset: 'text', user: 'u-1', metadata: { tenant: 't1' }, status: 'ok' });
    expect(last().query).toEqual({ id: made.id });
    expect(await catchErr(lykia.generations.get('gen-unknown'))).toMatchObject({ status: 404, code: 'not_found' });
    await lykia.chat.completions.create({ model: '@fast', messages: [{ role: 'user', content: 'y' }], user: 'u-2' });
    const list = await lykia.generations.list({ limit: 2, user: 'u-1', preset: 'text', metadata: { tenant: 't1' } });
    expect(list.data.map((g) => g.id)).toEqual([made.id]);
    expect(last().path).toBe('/generations');
    expect(last().query).toEqual({ limit: '2', user: 'u-1', preset: 'text', 'metadata.tenant': 't1' });
  });

  it('creates embeddings with cost and _meta', async () => {
    const res = await lykia.embeddings.create({ model: preset('embedding'), input: ['a', 'b'], metadata: { app: 'search' } });
    expect(res.data).toHaveLength(2);
    expect(res.usage?.cost_details?.upstream_cost).toBeGreaterThan(0);
    expect(res._meta.preset).toBe('embedding');
  });
});

describe('media', () => {
  it('generates images', async () => {
    const res = await lykia.images.generate({ model: 'openai/gpt-image-2', prompt: 'a cat', aspect_ratio: '1:1', user: 'u-2' });
    expect(res.data[0]!.url).toContain('/fake-files/');
    expect(last().body).toMatchObject({ user: 'u-2', aspect_ratio: '1:1' });
  });

  it('creates, waits for and downloads a video', async () => {
    const job = await lykia.videos.create({ model: '@video', prompt: 'waves', duration: 4 });
    expect(job.status).toBe('queued');
    expect(job._meta?.preset).toBe('video');
    const polled: string[] = [];
    const done = await lykia.videos.wait(job.id, { intervalMs: 100, onPoll: (j) => polled.push(j.status) });
    // The fake's clock: queued, then in_progress, then completed (each status may be seen several times).
    expect(polled.at(-1)).toBe('completed');
    expect([...new Set(polled)].every((x, i, a) => ['queued', 'in_progress', 'completed'].indexOf(x) >= ['queued', 'in_progress', 'completed'].indexOf(a[i - 1] ?? 'queued'))).toBe(true);
    expect(done.duration_seconds).toBe(4);
    expect(done.usage?.cost).toBe(0.27);
    const content = await lykia.videos.content(job.id);
    expect(content.contentType).toBe('video/mp4');
    expect(new TextDecoder().decode(content.data)).toBe('FAKEVIDEO');
  });

  it('throws video_failed for a failed job and honours the wait timeout and signal', async () => {
    const failing = await lykia.videos.create({ model: 'x/y', prompt: 'please fail #fail' });
    expect(await catchErr(lykia.videos.wait(failing.id, { intervalMs: 100 }))).toMatchObject({ code: 'video_failed', reason: 'provider_error' });
    const slow = await lykia.videos.create({ model: 'x/y', prompt: 'slow' });
    expect(await catchErr(lykia.videos.wait(slow.id, { intervalMs: 200, timeoutMs: 100 }))).toMatchObject({ code: 'timeout' });
    const c = new AbortController();
    c.abort();
    expect(await catchErr(lykia.videos.wait(slow.id, { signal: c.signal }))).toMatchObject({ code: 'aborted' });
  });

  it('synthesizes speech as bytes (callable and .create)', async () => {
    const a = await lykia.audio.speech({ model: '@tts', input: 'merhaba', voice: 'voice_ada' });
    expect(a.contentType).toBe('audio/mpeg');
    expect(new TextDecoder().decode(a.data)).toBe('ID3FAKEAUDIO');
    expect((await lykia.audio.speech.create({ model: '@tts', input: 'x', voice: 'voice_ada' })).data.byteLength).toBe(12);
  });

  it('lists, clones (multipart, consent required) and deletes voices', async () => {
    const voicesList = await lykia.audio.voices.list({ model: 'elevenlabs/v3' });
    expect(voicesList).toMatchObject({ object: 'list', model: 'elevenlabs/v3' });
    expect(voicesList.data[0]).toMatchObject({ id: 'JBFqnCBsd6RMkjVDRZzb', object: 'voice', category: 'premade' });
    expect(await catchErr(lykia.audio.voices.create({ model: 'm', name: 'n', file: { data: new Uint8Array([1]), filename: 'a.mp3' }, consent: false as never }))).toMatchObject({ code: 'invalid_request' });
    const voice = await lykia.audio.voices.create({
      model: 'elevenlabs/v3',
      name: 'Me',
      file: { data: new Uint8Array([1, 2, 3, 4]), filename: 'me.mp3', contentType: 'audio/mpeg' },
      consent: true,
    });
    const body = last().body as { fields: Record<string, string>; files: Array<{ filename: string; size: number; contentType: string }> };
    expect(body.fields).toMatchObject({ model: 'elevenlabs/v3', name: 'Me', consent: 'true' });
    expect(body.files[0]).toMatchObject({ filename: 'me.mp3', size: 4, contentType: 'audio/mpeg' });
    expect((await lykia.audio.voices.delete(voice.id)).deleted).toBe(true);
  });

  it('transcribes audio as JSON or text, with tags as form fields', async () => {
    const json = await lykia.audio.transcriptions.create({
      model: '@stt',
      file: { data: new Uint8Array([1, 2, 3]), filename: 'clip.mp3', contentType: 'audio/mpeg' },
      language: 'tr',
      timestamp_granularities: ['word'],
      user: 'u-3',
      metadata: { tenant: 't9' },
    });
    expect(json.text).toBe('merhaba dünya');
    const body = last().body as { fields: Record<string, string> };
    expect(body.fields).toMatchObject({ model: '@stt', language: 'tr', user: 'u-3', metadata: '{"tenant":"t9"}', 'timestamp_granularities[]': 'word' });
    const srt = await lykia.audio.transcriptions.create({ model: '@stt', file: { data: new Uint8Array([1]), filename: 'a.wav' }, response_format: 'srt' });
    expect(srt).toContain('merhaba');
    expect(await catchErr(lykia.audio.transcriptions.create({ model: 'm', file: undefined as never }))).toMatchObject({ code: 'invalid_request' });
  });
});

describe('preset()', () => {
  it('validates names', () => {
    expect(preset('text')).toBe('@text');
    expect(preset('@fast-2')).toBe('@fast-2');
    for (const bad of ['Text', '1abc', 'a'.repeat(33), '']) expect(() => preset(bad)).toThrow(LykiaError);
    expect(isPreset('@vision')).toBe(true);
    expect(isPreset('openai/gpt-4o')).toBe(false);
  });
});
