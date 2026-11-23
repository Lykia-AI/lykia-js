/**
 * 0.2.1: `createAiSdkFetch({ context })` hands the request's own context (captured when the request starts) back with
 * every callback, also when the callback runs elsewhere (an abort runs in the context of whoever called `abort()`).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText, streamText } from 'ai';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAiSdkFetch, type AiSdkRequestInfo, type AiSdkResultInfo, type AiSdkTags, type LykiaError } from '../src/index.js';
import { chatChunks, createFakeLykia, fakeError, type FakeLykia } from '../src/testing/index.js';

const KEY = 'lyk-v1-' + 'd'.repeat(64);
let fake: FakeLykia;
beforeAll(async () => {
  fake = await createFakeLykia({ apiKey: KEY });
});
afterAll(() => fake.close());
afterEach(() => fake.reset());

interface Call {
  call: string;
  tags: AiSdkTags;
}
const als = new AsyncLocalStorage<Call>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup() {
  const results: Array<AiSdkResultInfo & { storeInCallback: Call | undefined }> = [];
  const errors: Array<{ error: LykiaError; request: AiSdkRequestInfo; storeInCallback: Call | undefined }> = [];
  const fetch = createAiSdkFetch({
    tags: () => als.getStore()?.tags,
    context: () => als.getStore()?.call,
    onResult: (r) => results.push({ ...r, storeInCallback: als.getStore() }),
    onError: (error, request) => errors.push({ error, request, storeInCallback: als.getStore() }),
  });
  const provider = createOpenAICompatible({ name: 'lykia', baseURL: fake.url, apiKey: KEY, includeUsage: true, fetch });
  return { results, errors, fetch, provider };
}

describe('createAiSdkFetch: per-request context', () => {
  it('an abort from another async context still reports the context and tags of the request that started', async () => {
    const { results, fetch } = setup();
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'hang' }).slice(0, 2), hang: true });
    const controller = new AbortController();
    const res = await als.run({ call: 'call-A', tags: { user: 'tenant-a' } }, () =>
      fetch(`${fake.url}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', content: 'x' }], stream: true }),
        signal: controller.signal,
      }),
    );
    const reader = res.body!.getReader();
    await reader.read();
    // Outside als.run: the store is empty here, as in a real abort handler.
    expect(als.getStore()).toBeUndefined();
    controller.abort();
    await reader.read().catch(() => undefined);
    await sleep(10);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ aborted: true, streamed: true, context: 'call-A', tags: { user: 'tenant-a' } });
    expect(results[0]!.storeInCallback).toBeUndefined(); // why `context` is needed
    expect(fake.requests.at(-1)!.body).toMatchObject({ user: 'tenant-a' });
  });

  it('an AI SDK stream aborted through abortSignal reports its own context', async () => {
    const { results, provider } = setup();
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'hang' }).slice(0, 2), hang: true });
    const controller = new AbortController();
    const run = als.run({ call: 'call-S', tags: { user: 'tenant-s' } }, () =>
      streamText({ model: provider.chatModel('@text'), prompt: 'x', maxRetries: 0, abortSignal: controller.signal, onError: () => undefined }),
    );
    const iterator = run.textStream[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await (async () => {
      for (;;) if ((await iterator.next()).done) return;
    })().catch(() => undefined);
    await sleep(20);
    expect(results).toEqual([expect.objectContaining({ aborted: true, context: 'call-S', tags: { user: 'tenant-s' } })]);
  });

  it('two concurrent streams each get their own context and tags', async () => {
    const { results, provider } = setup();
    const go = (call: string, user: string) =>
      als.run({ call, tags: { user, metadata: { call } } }, async () => {
        const r = streamText({ model: provider.chatModel('@text'), prompt: call, maxRetries: 0 });
        let text = '';
        for await (const t of r.textStream) text += t;
        return text;
      });
    const [a, b] = await Promise.all([go('call-1', 'tenant-1'), go('call-2', 'tenant-2')]);
    expect(a).toBe('echo: call-1');
    expect(b).toBe('echo: call-2');
    await sleep(10);
    const byContext = Object.fromEntries(results.map((r) => [r.context as string, r]));
    expect(Object.keys(byContext).sort()).toEqual(['call-1', 'call-2']);
    expect(byContext['call-1']).toMatchObject({ streamed: true, tags: { user: 'tenant-1', metadata: { call: 'call-1' } }, preset: 'text' });
    expect(byContext['call-2']).toMatchObject({ streamed: true, tags: { user: 'tenant-2', metadata: { call: 'call-2' } }, preset: 'text' });
    const sent = fake.requests.map((r) => (r.body as { user?: string }).user).sort();
    expect(sent).toEqual(['tenant-1', 'tenant-2']);
  });

  it('non-stream results carry context and tags', async () => {
    const { results, provider } = setup();
    await als.run({ call: 'call-N', tags: { user: 'tenant-n' } }, () => generateText({ model: provider.chatModel('@text'), prompt: 'x', maxRetries: 0 }));
    await sleep(10);
    expect(results).toEqual([expect.objectContaining({ streamed: false, context: 'call-N', tags: { user: 'tenant-n' } })]);
  });

  it('HTTP errors and mid-stream errors give onError the request context', async () => {
    const { errors, provider } = setup();
    fake.enqueue('POST /chat/completions', fakeError(503, { reason: 'no_provider', message: 'none' }));
    await als
      .run({ call: 'call-H', tags: { user: 'tenant-h' } }, () => generateText({ model: provider.chatModel('@text'), prompt: 'x', maxRetries: 0 }))
      .catch(() => undefined);
    fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'partial', error: { status: 502, message: 'boom', reason: 'provider_error' } }) });
    await als.run({ call: 'call-M', tags: { user: 'tenant-m' } }, async () => {
      const r = streamText({ model: provider.chatModel('@text'), prompt: 'x', maxRetries: 0, onError: () => undefined });
      for await (const _ of r.fullStream) {
        // drain
      }
    });
    await sleep(10);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({ error: { status: 503 }, request: { context: 'call-H', tags: { user: 'tenant-h' } } });
    expect(errors[1]).toMatchObject({ error: { status: 502, reason: 'provider_error' }, request: { context: 'call-M', tags: { user: 'tenant-m' } } });
    expect(errors[1]!.request.generationId).toMatch(/^gen-/);
  });

  it('context is optional and a throwing context function is ignored', async () => {
    const results: AiSdkResultInfo[] = [];
    const fetch = createAiSdkFetch({
      context: () => {
        throw new Error('no');
      },
      onResult: (r) => results.push(r),
    });
    const provider = createOpenAICompatible({ name: 'lykia', baseURL: fake.url, apiKey: KEY, fetch });
    await generateText({ model: provider.chatModel('@text'), prompt: 'x', maxRetries: 0 });
    await sleep(10);
    expect(results[0]).toMatchObject({ context: undefined, tags: undefined, streamed: false });
  });
});
