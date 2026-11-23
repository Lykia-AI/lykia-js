import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { LykiaError, createAiSdkFetch, type AiSdkResultInfo } from '../src/index.js';
import { sseEventEnds } from '../src/ai-sdk.js';
import { chatChunks, createFakeLykia, fakeError, type FakeLykia } from '../src/testing/index.js';

const KEY = 'lyk-v1-aisdktestkey';
let fake: FakeLykia;
beforeAll(async () => {
  fake = await createFakeLykia({ apiKey: KEY });
});
afterAll(() => fake.close());
afterEach(() => fake.reset());

const last = () => fake.requests.at(-1)!;
const post = (body: unknown, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  ...(signal ? { signal } : {}),
});
const chatUrl = () => `${fake.url}/chat/completions`;

async function readAll(res: Response): Promise<Uint8Array> {
  return new Uint8Array(await res.arrayBuffer());
}

/** A Response whose body arrives in the given byte chunks. */
function chunkedResponse(parts: Uint8Array[], headers: Record<string, string> = { 'content-type': 'text/event-stream', 'x-generation-id': 'gen-split' }): Response {
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < parts.length) c.enqueue(parts[i++]!);
      else c.close();
    },
  });
  return new Response(body, { status: 200, headers });
}

describe('createAiSdkFetch: requests', () => {
  it('merges sanitized tags into generation bodies without overriding body tags', async () => {
    const f = createAiSdkFetch({ tags: { user: 'u'.repeat(200), metadata: { product: 'kit', $bad: 'x', op: 'from-helper' } } });
    await (await f(chatUrl(), post({ model: '@text', messages: [{ role: 'user', content: 'x' }], metadata: { op: 'from-body' } }))).json();
    const body = last().body as Record<string, unknown>;
    expect((body['user'] as string).length).toBe(128);
    expect(body['metadata']).toEqual({ op: 'from-body', product: 'kit' });

    await (await f(chatUrl(), post({ model: '@text', messages: [{ role: 'user', content: 'x' }], user: 'mine' }))).json();
    expect((last().body as Record<string, unknown>)['user']).toBe('mine');

    let n = 0;
    const dynamic = createAiSdkFetch({ tags: () => ({ user: `call-${++n}` }) });
    await (await dynamic(`${fake.url}/embeddings`, post({ model: '@embedding', input: 'x' }))).json();
    expect((last().body as Record<string, unknown>)['user']).toBe('call-1');

    await (await f(`${fake.url}/models`, { headers: { Authorization: `Bearer ${KEY}` } })).json();
    expect(last().body).toBeUndefined();
  });
});

describe('createAiSdkFetch: responses', () => {
  it('reports usage, cost and headers of a non-stream response and leaves the body untouched', async () => {
    const results: AiSdkResultInfo[] = [];
    const f = createAiSdkFetch({ onResult: (r) => results.push(r) });
    const res = await f(chatUrl(), post({ model: '@text', messages: [{ role: 'user', content: 'x' }] }));
    const json = (await res.json()) as { id: string; usage: { cost: number } };
    await new Promise((r) => setTimeout(r, 10));
    expect(json.usage.cost).toBe(0.000123);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ streamed: false, status: 200, generationId: json.id, preset: 'text', maxTokensApplied: 4096, reasoningDropped: false, cost: 0.000123 });
    expect(results[0]!.costDetails).toBeDefined();
  });

  it('passes a stream through byte for byte and reports the final usage', async () => {
    const stream = chatChunks({ id: 'gen-fixed', text: ['Merhaba ', 'dünya ☀'], toolCalls: [{ id: 'c1', name: 'f', arguments: ['{"a"', ':1}'] }] });
    fake.enqueue('POST /chat/completions', { stream });
    const raw = await readAll(await fetch(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }], stream: true })));
    fake.enqueue('POST /chat/completions', { stream, eventDelayMs: 2 });
    const results: AiSdkResultInfo[] = [];
    const wrapped = await readAll(await createAiSdkFetch({ onResult: (r) => results.push(r) })(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }], stream: true })));
    expect(Buffer.from(wrapped).equals(Buffer.from(raw))).toBe(true);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ streamed: true, cost: 0.000123, model: 'openai/gpt-4o-mini' });
    expect(results[0]!.generationId).toBe(last().generationId);
  });

  it.each(['chunk', 'standalone'] as const)('"throw" mode, %s format: a rejected read with the right LykiaError, after the text before it', async (errorFormat) => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'partial', errorFormat, error: { message: 'upstream died', reason: 'overloaded', status: 502, code: 'provider_overloaded' } }) });
    const errors: LykiaError[] = [];
    const results: AiSdkResultInfo[] = [];
    const res = await createAiSdkFetch({ streamErrors: 'throw', onError: (e) => errors.push(e), onResult: (r) => results.push(r) })(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }], stream: true }));
    const reader = res.body!.getReader();
    let text = '';
    let failure: unknown;
    for (;;) {
      try {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
      } catch (err) {
        failure = err;
        break;
      }
    }
    expect(text).toContain('"content":"part"');
    expect(text).toContain('"content":"ial"');
    expect(text).not.toContain('upstream died');
    expect(failure).toBeInstanceOf(LykiaError);
    expect(failure).toMatchObject({ status: 502, code: 'provider_overloaded', reason: 'overloaded', retryable: true, generationId: last().generationId });
    expect(errors.map((e) => e.code)).toEqual(['provider_overloaded']);
    expect(results).toHaveLength(1);
  });

  it('"part" mode (default), chunk format: the error event is re-shaped, the stream ends normally', async () => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'partial', errorFormat: 'chunk', error: { message: 'upstream died', reason: 'overloaded', status: 502, code: 'provider_overloaded', type: 'provider_error' } }) });
    const errors: LykiaError[] = [];
    const results: AiSdkResultInfo[] = [];
    const res = await createAiSdkFetch({ onError: (e) => errors.push(e), onResult: (r) => results.push(r) })(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }], stream: true }));
    const text = new TextDecoder().decode(await readAll(res));
    expect(text).toContain('"content":"part"');
    expect(text).toContain('data: {"error":{"message":"upstream died","type":"provider_error","code":"provider_overloaded"}}\n\n');
    expect(text).not.toContain('"finish_reason":"error"');
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(LykiaError);
    expect(errors[0]).toMatchObject({ status: 502, code: 'provider_overloaded', reason: 'overloaded', retryable: true, generationId: last().generationId });
    expect(errors[0]!.body).toMatchObject({ error: { message: 'upstream died' } });
    expect(results).toHaveLength(1);
  });

  it('"part" mode, standalone format: the event passes through untouched and onError is called once', async () => {
    const stream = chatChunks({ id: 'gen-fixed', text: 'partial', errorFormat: 'standalone', error: { message: 'gone', reason: 'no_provider', status: 503 } });
    fake.enqueue('POST /chat/completions', { stream });
    const raw = await readAll(await fetch(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }], stream: true })));
    fake.enqueue('POST /chat/completions', { stream: [...stream, { error: { message: 'second', code: 'x', status: 502 } }] });
    const errors: LykiaError[] = [];
    const res = await createAiSdkFetch({ onError: (e) => errors.push(e) })(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }], stream: true }));
    const wrapped = new TextDecoder().decode(await readAll(res));
    expect(wrapped.startsWith(new TextDecoder().decode(raw).replace(/data: \[DONE\]\n\n$/, ''))).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ status: 503, reason: 'no_provider', message: 'gone' });
  });

  it('propagates a client abort and still reports what is known', async () => {
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'hang' }).slice(0, 2), hang: true });
    const results: AiSdkResultInfo[] = [];
    const controller = new AbortController();
    const res = await createAiSdkFetch({ onResult: (r) => results.push(r) })(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }], stream: true }, controller.signal));
    const reader = res.body!.getReader();
    await reader.read();
    setTimeout(() => controller.abort(), 20);
    await expect((async () => {
      for (;;) if ((await reader.read()).done) return;
    })()).rejects.toBeDefined();
    expect(results).toEqual([expect.objectContaining({ aborted: true, generationId: last().generationId, streamed: true })]);
  });

  it('leaves HTTP errors to the caller and reports them through onError', async () => {
    fake.enqueue('POST /chat/completions', fakeError(429, { reason: 'rate_limited', retry_after: 3 }));
    const errors: LykiaError[] = [];
    const res = await createAiSdkFetch({ onError: (e) => errors.push(e) })(chatUrl(), post({ messages: [{ role: 'user', content: 'x' }] }));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    await new Promise((r) => setTimeout(r, 10));
    expect(errors[0]).toMatchObject({ status: 429, code: 'rate_limited', reason: 'rate_limited', retryAfter: 3 });
  });
});

describe('createAiSdkFetch: SSE parsing on arbitrary boundaries', () => {
  const events = [
    `data: ${JSON.stringify({ id: 'g', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: 'çğüş ☀ 你好' }, finish_reason: null }] })}\r\n\r\n`,
    ': comment\n\n',
    `data: ${JSON.stringify({ id: 'g', object: 'chat.completion.chunk', model: 'm', choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.5 } })}\r\r`,
    'data: [DONE]\n\n',
  ];
  const all = new TextEncoder().encode(events.join(''));

  it.each([1, 2, 3, 5, 7, 64])('chunk size %i: bytes identical, usage found', async (size) => {
    const parts: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += size) parts.push(all.slice(i, i + size));
    const results: AiSdkResultInfo[] = [];
    const f = createAiSdkFetch({ fetch: async () => chunkedResponse(parts), onResult: (r) => results.push(r) });
    const out = await readAll(await f('https://api.getlykia.com/v1/chat/completions', { method: 'POST', body: '{}' }));
    expect(Buffer.from(out).equals(Buffer.from(all))).toBe(true);
    expect(results).toEqual([expect.objectContaining({ cost: 0.5, model: 'm', generationId: 'gen-split' })]);
  });

  it('detects an error chunk split across many reads', async () => {
    const err = new TextEncoder().encode(
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok ☀' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ error: { message: 'boom ☀', code: 'provider_error', status: 503, metadata: { reason: 'no_provider' } }, choices: [] })}\n\n`,
    );
    const parts: Uint8Array[] = [];
    for (let i = 0; i < err.length; i += 3) parts.push(err.slice(i, i + 3));
    const f = createAiSdkFetch({ streamErrors: 'throw', fetch: async () => chunkedResponse(parts) });
    const res = await f('https://api.getlykia.com/v1/chat/completions', { method: 'POST', body: '{}' });
    await expect(readAll(res)).rejects.toMatchObject({ status: 503, reason: 'no_provider', generationId: 'gen-split' });

    const errors: LykiaError[] = [];
    const asPart = createAiSdkFetch({ fetch: async () => chunkedResponse(parts), onError: (e) => errors.push(e) });
    const text = new TextDecoder().decode(await readAll(await asPart('https://api.getlykia.com/v1/chat/completions', { method: 'POST', body: '{}' })));
    expect(text).toContain('ok ☀');
    expect(text).toContain('data: {"error":{"message":"boom ☀","type":"server_error","code":"provider_error"}}\n\n');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ status: 503, reason: 'no_provider' });
  });

  it('finds event ends for LF, CRLF and CR, and waits on a trailing CR', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(sseEventEnds(enc('data: a\n\ndata: b\r\n\r\ndata: c\r\rdata: d'))).toEqual([9, 20, 29]);
    expect(sseEventEnds(enc('data: a\r\n\r'))).toEqual([]);
    expect(sseEventEnds(enc('data: a\r\n\r'), true)).toEqual([10]);
    expect(sseEventEnds(enc('data: c\r\r'))).toEqual([]);
    expect(sseEventEnds(enc('data: c\r\r'), true)).toEqual([9]);
  });
});

describe('Vercel AI SDK integration (dev dependency only)', () => {
  it('streamText: cost via onResult; a mid-stream error becomes an error part (default) or a throw', async () => {
    const results: AiSdkResultInfo[] = [];
    const errors: LykiaError[] = [];
    const provider = createOpenAICompatible({
      name: 'lykia',
      baseURL: fake.url,
      apiKey: KEY,
      includeUsage: true,
      fetch: createAiSdkFetch({ tags: { user: 'tenant-7', metadata: { product: 'kit' } }, onResult: (r) => results.push(r), onError: (e) => errors.push(e) }),
    });

    const ok = streamText({ model: provider.chatModel('@text'), prompt: 'Merhaba', maxRetries: 0 });
    let text = '';
    for await (const t of ok.textStream) text += t;
    expect(text).toBe('echo: Merhaba');
    expect(last().body).toMatchObject({ user: 'tenant-7', metadata: { product: 'kit' } });
    expect(results.at(-1)).toMatchObject({ streamed: true, cost: 0.000123, preset: 'text' });

    // Default "part" mode: text deltas, then an error part; onError once; onResult still called.
    for (const errorFormat of ['chunk', 'standalone'] as const) {
      errors.length = 0;
      const before = results.length;
      fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'partial', errorFormat, error: { message: 'upstream died', reason: 'overloaded', status: 502 } }) });
      const run = streamText({ model: provider.chatModel('@text'), prompt: 'x', maxRetries: 0, onError: () => undefined });
      const parts: Array<{ type: string; text?: string; error?: unknown }> = [];
      for await (const part of run.fullStream) parts.push(part as { type: string });
      const types = parts.map((p) => p.type);
      const firstError = types.indexOf('error');
      expect(parts.filter((p) => p.type === 'text-delta').map((p) => p.text).join('')).toBe('partial');
      expect(firstError).toBeGreaterThan(types.lastIndexOf('text-delta'));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ status: 502, reason: 'overloaded' });
      expect(results.length).toBe(before + 1);
    }

    // "throw" mode: textStream throws, with the LykiaError in the cause chain.
    const throwing = createOpenAICompatible({ name: 'lykia', baseURL: fake.url, apiKey: KEY, includeUsage: true, fetch: createAiSdkFetch({ streamErrors: 'throw' }) });
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'partial', error: { message: 'upstream died', reason: 'overloaded', status: 502 } }) });
    const failing = streamText({ model: throwing.chatModel('@text'), prompt: 'x', maxRetries: 0, onError: () => undefined });
    let partial = '';
    const thrown = await (async () => {
      try {
        for await (const t of failing.textStream) partial += t;
      } catch (err) {
        return err;
      }
      return undefined;
    })();
    expect(partial).toBe('partial');
    expect(thrown).toBeDefined();
    const chain: unknown[] = [];
    for (let e: unknown = thrown; e; e = (e as { cause?: unknown }).cause) chain.push(e);
    expect(chain.some((e) => e instanceof LykiaError && e.status === 502 && e.reason === 'overloaded')).toBe(true);
  });
});
