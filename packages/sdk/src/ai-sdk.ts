/**
 * `createAiSdkFetch()`: a `fetch` wrapper for the Vercel AI SDK's OpenAI-compatible provider pointed at Lykia.
 *
 * That provider (a) ends a stream "successfully" when the gateway sends a mid-stream error chunk, (b) drops
 * `usage.cost`, and (c) has no place for Lykia's request tags. The wrapper fixes all three without changing what the
 * provider sees otherwise: request tags are merged into the JSON body, response bytes pass through unchanged (streams
 * are re-chunked at event boundaries only), cost and response headers are reported through `onResult`, and a
 * mid-stream error becomes an AI SDK `error` part (default `streamErrors: "part"`) or a stream error with a
 * {@link LykiaError} (`streamErrors: "throw"`), so the AI SDK surfaces the failure.
 *
 * It never retries, and never logs bodies or headers.
 */
import { metaFrom, type FetchLike } from './core.js';
import { LykiaError, httpError, streamChunkError } from './errors.js';
import { sanitizeTags } from './tags.js';
import type { CostDetails, Usage } from './types.js';

export interface AiSdkTags {
  user?: string;
  metadata?: Record<string, string>;
}

/** What the wrapper learned about one generation request. */
export interface AiSdkResultInfo {
  url: string;
  status: number;
  streamed: boolean;
  /** `X-Generation-Id` (falls back to the response / chunk `id`). */
  generationId: string | undefined;
  /** `X-Lykia-Preset`. */
  preset: string | undefined;
  /** `X-Max-Tokens-Applied`. */
  maxTokensApplied: number | undefined;
  /** `X-Lykia-Reasoning: dropped`. */
  reasoningDropped: boolean;
  /** The model that served the request (from the response body, or the stream chunks). */
  model: string | undefined;
  /** The provider that served the request (from the response body, or the stream chunks). */
  provider: string | undefined;
  /** `usage` as Lykia sent it (with `cost`, `cost_details`); for streams from the final chunk. */
  usage: Usage | undefined;
  /** `usage.cost` in USD. */
  cost: number | undefined;
  costDetails: CostDetails | undefined;
  /** The caller aborted the request before the response was complete. */
  aborted?: boolean;
  /** What `options.context()` returned when this request started (see {@link AiSdkFetchOptions.context}). */
  context: unknown;
  /** The tags resolved for this request (`options.tags` or its function's result), before sanitizing. */
  tags: AiSdkTags | undefined;
}

/** The request an `onError` call belongs to (second argument of `onError`). */
export interface AiSdkRequestInfo {
  url: string;
  /** What `options.context()` returned when this request started. */
  context: unknown;
  /** The tags resolved for this request. */
  tags: AiSdkTags | undefined;
  /** `X-Generation-Id`, when a response arrived. */
  generationId: string | undefined;
}

export interface AiSdkFetchOptions {
  /** The fetch to wrap (default: the global `fetch`). */
  fetch?: FetchLike;
  /** Request tags added to every generation request (sanitized; tags already in the body win). */
  tags?: AiSdkTags | (() => AiSdkTags | undefined);
  /** Called once per generation request that got a 2xx response: after the JSON body, or when a stream ends or is aborted. */
  onResult?: (info: AiSdkResultInfo) => void;
  /**
   * Called with the parsed error of an HTTP error response, or (once per stream) of a mid-stream error chunk. The
   * second argument says which request it belongs to (`context`, `tags`, `url`, `generationId`).
   */
  onError?: (error: LykiaError, request: AiSdkRequestInfo) => void;
  /**
   * Called once per generation request, synchronously when the request starts (in the async context of the code that
   * called `generateText` / `streamText`). Its value is handed back as `info.context` in `onResult` and as
   * `request.context` in `onError`, for that request only, also when the callback runs elsewhere (an abort runs
   * `onResult` in the context of whoever called `abort()`, where an `AsyncLocalStorage` store is empty). Kept only for
   * the request's lifetime.
   */
  context?: () => unknown;
  /**
   * What a mid-stream gateway error does to the stream handed to the AI SDK:
   * - `"part"` (default): the error event is passed on in the shape the AI SDK turns into an `error` part
   *   (`data: {"error":{"message","type","code"}}`); the stream then ends normally. The AI SDK delivers the partial
   *   text, then an `error` part; `onError` gets the full `LykiaError`.
   * - `"throw"`: the stream errors with the `LykiaError` after the text before it (reads reject).
   */
  streamErrors?: 'part' | 'throw';
}

const GENERATION_PATHS = ['/chat/completions', '/embeddings', '/images/generations', '/videos', '/audio/speech'];

function isGeneration(url: string): boolean {
  try {
    const p = new URL(url).pathname.replace(/\/+$/, '');
    return GENERATION_PATHS.some((g) => p.endsWith(g));
  } catch {
    return false;
  }
}

function safely(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {
    // Callbacks must never break the request.
  }
}

/** Merges sanitized tags into a JSON body; values already in the body are kept. */
function withTags(body: string, tags: AiSdkTags | undefined): string {
  if (!tags) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return body;
  const obj = parsed as Record<string, unknown>;
  const clean = sanitizeTags(tags);
  let changed = false;
  if (clean.user !== undefined && (obj['user'] === undefined || obj['user'] === null)) {
    obj['user'] = clean.user;
    changed = true;
  }
  if (clean.metadata) {
    const existing = obj['metadata'] && typeof obj['metadata'] === 'object' && !Array.isArray(obj['metadata']) ? (obj['metadata'] as Record<string, unknown>) : undefined;
    if (obj['metadata'] === undefined || obj['metadata'] === null || existing) {
      const merged: Record<string, unknown> = { ...(existing ?? {}) };
      for (const [k, v] of Object.entries(clean.metadata)) {
        if (k in merged) continue;
        if (Object.keys(merged).length >= 16) break;
        merged[k] = v;
      }
      obj['metadata'] = merged;
      changed = true;
    }
  }
  return changed ? JSON.stringify(obj) : body;
}

function baseInfo(url: string, res: Response, streamed: boolean, request: { context: unknown; tags: AiSdkTags | undefined }): AiSdkResultInfo {
  const meta = metaFrom(res.headers);
  return {
    context: request.context,
    tags: request.tags,
    url,
    status: res.status,
    streamed,
    generationId: meta.generationId,
    preset: meta.preset,
    maxTokensApplied: meta.maxTokensApplied,
    reasoningDropped: meta.reasoningDropped,
    model: undefined,
    provider: undefined,
    usage: undefined,
    cost: undefined,
    costDetails: undefined,
  };
}

function absorbUsage(info: AiSdkResultInfo, body: Record<string, unknown>): void {
  if (typeof body['model'] === 'string' && body['model']) info.model = body['model'];
  if (typeof body['provider'] === 'string' && body['provider']) info.provider = body['provider'];
  if (!info.generationId && typeof body['id'] === 'string') info.generationId = body['id'];
  const usage = body['usage'];
  if (usage && typeof usage === 'object') {
    info.usage = usage as Usage;
    const u = usage as { cost?: unknown; cost_details?: unknown };
    if (typeof u.cost === 'number') info.cost = u.cost;
    if (u.cost_details && typeof u.cost_details === 'object') info.costDetails = u.cost_details as CostDetails;
  }
}

/**
 * Finds complete SSE events in `buf` (an event ends with an empty line; LF, CRLF and CR line endings). Returns the
 * end offsets of complete events; bytes after the last offset are an incomplete event. Line terminators are ASCII,
 * so scanning bytes is safe for UTF-8.
 */
export function sseEventEnds(buf: Uint8Array, final = false): number[] {
  const ends: number[] = [];
  let lineEmpty = true;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b !== 10 && b !== 13) {
      lineEmpty = false;
      continue;
    }
    let end = i + 1;
    if (b === 13) {
      if (i + 1 >= buf.length && !final) break; // CR at the end: wait for the next byte (CRLF or not)
      if (buf[i + 1] === 10) {
        end = i + 2;
        i++;
      }
    }
    if (lineEmpty) ends.push(end);
    lineEmpty = true;
  }
  return ends;
}

function eventData(bytes: Uint8Array, decoder: TextDecoder): string | undefined {
  const text = decoder.decode(bytes);
  const data: string[] = [];
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return data.length ? data.join('\n') : undefined;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Wraps an SSE body: passes bytes through, reports usage, and turns an error chunk into a stream error. */
function wrapStream(res: Response, info: AiSdkResultInfo, options: AiSdkFetchOptions, signal: AbortSignal | undefined): ReadableStream<Uint8Array> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let pending: Uint8Array = new Uint8Array(0);
  let reported = false;
  const report = (extra: Partial<AiSdkResultInfo> = {}) => {
    if (reported) return;
    reported = true;
    safely(() => options.onResult?.({ ...info, ...extra }));
  };
  const onAbort = () => report({ aborted: true });
  signal?.addEventListener('abort', onAbort, { once: true });
  const cleanup = () => signal?.removeEventListener('abort', onAbort);

  const mode = options.streamErrors ?? 'part';
  let errorReported = false;
  const reportError = (err: LykiaError) => {
    if (errorReported) return;
    errorReported = true;
    safely(() => options.onError?.(err, { url: info.url, context: info.context, tags: info.tags, generationId: info.generationId ?? err.generationId }));
  };

  /** Handles complete events; returns how many were passed on, and an error to raise if an error chunk was found. */
  const handle = (controller: ReadableStreamDefaultController<Uint8Array>, bytes: Uint8Array, final = false): { sent: number; error?: LykiaError } => {
    const ends = sseEventEnds(bytes, final);
    let sent = 0;
    let start = 0;
    for (const end of ends) {
      let event = bytes.subarray(start, end);
      const data = eventData(event, decoder);
      if (data !== undefined && data !== '[DONE]') {
        let chunk: Record<string, unknown> | undefined;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          chunk = undefined; // Not JSON: pass it on untouched.
        }
        if (chunk && chunk['error']) {
          // Both gateway formats: an error carried by a chunk with `choices[].finish_reason: "error"`, and a
          // standalone `{ "error": { … } }` event.
          const err = streamChunkError(chunk, info.generationId ?? (chunk['id'] as string | undefined));
          if (mode === 'throw') {
            // Bytes before the error event have been passed on; the error event itself is not.
            pending = new Uint8Array(0);
            return { sent, error: err };
          }
          reportError(err);
          if ('choices' in chunk) {
            // Re-shape into the standalone error event the AI SDK maps to an `error` part.
            const e = chunk['error'] as Record<string, unknown>;
            const standalone = { error: { message: err.message, type: typeof e['type'] === 'string' ? e['type'] : 'server_error', code: err.code } };
            event = new TextEncoder().encode(`data: ${JSON.stringify(standalone)}\n\n`);
          }
        } else if (chunk) {
          absorbUsage(info, chunk);
        }
      }
      controller.enqueue(event);
      sent++;
      start = end;
    }
    pending = bytes.slice(start);
    return { sent };
  };

  // An error chunk is raised on the pull AFTER the events before it were enqueued: `controller.error()` would
  // otherwise discard text that is already queued but not yet read.
  let deferred: LykiaError | undefined;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (deferred) {
        controller.error(deferred);
        return;
      }
      // Keep reading until something was passed on: a pull that enqueues nothing would stall the stream.
      for (;;) {
        let result: ReadableStreamReadResult<Uint8Array>;
        try {
          result = await reader.read();
        } catch (err) {
          cleanup();
          report(signal?.aborted ? { aborted: true } : {});
          controller.error(err);
          return;
        }
        if (result.done) {
          const { error } = pending.length ? handle(controller, pending, true) : { error: undefined };
          if (error) {
            cleanup();
            report();
            reportError(error);
            controller.error(error);
            return;
          }
          if (pending.length) controller.enqueue(pending);
          pending = new Uint8Array(0);
          cleanup();
          report();
          controller.close();
          return;
        }
        const { sent, error } = handle(controller, concat(pending, result.value));
        if (error) {
          cleanup();
          report();
          reportError(error);
          await reader.cancel(error).catch(() => undefined);
          if (sent > 0) deferred = error;
          else controller.error(error);
          return;
        }
        if (sent > 0) return;
      }
    },
    async cancel(reason) {
      cleanup();
      report({ aborted: true });
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * Returns a `fetch` for the AI SDK's OpenAI-compatible provider:
 *
 * ```ts
 * const lykia = createOpenAICompatible({
 *   name: 'lykia',
 *   baseURL: 'https://api.getlykia.com/v1',
 *   apiKey: process.env.LYKIA_API_KEY,
 *   fetch: createAiSdkFetch({ tags: { user: 'tenant-42' }, onResult: (r) => record(r.generationId, r.cost) }),
 * });
 * ```
 */
export function createAiSdkFetch(options: AiSdkFetchOptions = {}): FetchLike {
  const inner: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const generation = isGeneration(url);
    let nextInit = init;
    // Captured synchronously, in the caller's async context, and held only by this request's closures.
    let tags: AiSdkTags | undefined;
    let context: unknown;
    if (generation) {
      try {
        tags = typeof options.tags === 'function' ? options.tags() : options.tags;
      } catch {
        tags = undefined;
      }
      try {
        context = options.context?.();
      } catch {
        context = undefined;
      }
    }
    if (generation && init && typeof init.body === 'string' && (init.method ?? 'GET').toUpperCase() === 'POST') {
      nextInit = { ...init, body: withTags(init.body, tags) };
    }
    const res = await inner(input, nextInit);
    if (!generation) return res;
    const request = { context, tags };

    if (!res.ok) {
      if (options.onError) {
        void res
          .clone()
          .text()
          .then((text) => {
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              parsed = undefined;
            }
            const err = httpError(res.status, parsed, text, res.headers);
            safely(() => options.onError?.(err, { url, context, tags, generationId: err.generationId }));
          })
          .catch(() => undefined);
      }
      return res;
    }

    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream') && res.body) {
      const info = baseInfo(url, res, true, request);
      const body = wrapStream(res, info, options, nextInit?.signal ?? undefined);
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    if (type.includes('json') && options.onResult) {
      const info = baseInfo(url, res, false, request);
      void res
        .clone()
        .json()
        .then((body: unknown) => {
          if (body && typeof body === 'object') absorbUsage(info, body as Record<string, unknown>);
          safely(() => options.onResult?.(info));
        })
        .catch(() => safely(() => options.onResult?.({ ...info, aborted: Boolean(nextInit?.signal?.aborted) })));
    }
    return res;
  };
}
