import { httpError, LykiaError, parseRetryAfter } from './errors.js';
import type { BinaryResult } from './media-types.js';

export const DEFAULT_BASE_URL = 'https://api.getlykia.com/v1';
export const DEFAULT_TIMEOUT_MS = 60_000;
/** A `Retry-After` longer than this is never waited out automatically. */
const MAX_RETRY_AFTER_SECONDS = 60;

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LykiaOptions {
  /** Project API key (`lyk-v1-…`). Defaults to the `LYKIA_API_KEY` environment variable where one exists. */
  apiKey?: string;
  /** Default `https://api.getlykia.com/v1` (or `LYKIA_BASE_URL`). */
  baseURL?: string;
  /**
   * Per-request timeout in ms (default 60000). Non-streaming: until the whole response is read.
   * Streaming: until the response headers, then the longest silence allowed between two chunks.
   */
  timeoutMs?: number;
  /** Custom `fetch` (defaults to the global one). */
  fetch?: FetchLike;
  /** Extra headers sent with every request (e.g. `HTTP-Referer`, `X-Title` for attribution). */
  defaultHeaders?: Record<string, string>;
  /**
   * Automatic retries (default 0: none). When > 0, only idempotent GETs are retried (network errors, 408, 429, 5xx),
   * plus any request that got a 429 carrying `Retry-After` (rejected before any work, so nothing was billed).
   */
  maxRetries?: number;
  /**
   * The SDK refuses to run in a browser page by default because that would expose your API key to anyone who
   * opens it. Set this only if you accept that risk.
   */
  dangerouslyAllowBrowser?: boolean;
}

export interface RequestOptions {
  /** Overrides the client timeout for this call (ms). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra headers for this call. */
  headers?: Record<string, string>;
}

/** Response metadata attached as `_meta` to generation results. */
export interface ResponseMeta {
  /** `X-Generation-Id` (equals the chat completion `id`). */
  generationId: string | undefined;
  /** `X-Lykia-Preset`: the preset name when `model` was `@name`. */
  preset: string | undefined;
  /** `X-Max-Tokens-Applied`: the output limit Lykia sent to the provider, when it set or lowered it. */
  maxTokensApplied: number | undefined;
  /**
   * `X-Lykia-Reasoning: dropped`: thinking was turned off for this request because an assistant message came back
   * without its `reasoning_details` and the provider requires them.
   */
  reasoningDropped: boolean;
  /** `X-Lykia-Cost` (USD), sent by media endpoints. */
  cost: number | undefined;
  /** `X-Lykia-Ignored-Fields`: multipart fields sent after the file that a streaming upload could not apply. */
  ignoredFields: string[];
}

export function metaFrom(headers: Headers): ResponseMeta {
  const raw = headers.get('x-max-tokens-applied');
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return {
    generationId: headers.get('x-generation-id') ?? undefined,
    preset: headers.get('x-lykia-preset') ?? undefined,
    maxTokensApplied: Number.isFinite(n) ? n : undefined,
    reasoningDropped: (headers.get('x-lykia-reasoning') ?? '').toLowerCase() === 'dropped',
    cost: costFrom(headers),
    ignoredFields: (headers.get('x-lykia-ignored-fields') ?? '')
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean),
  };
}

/** `X-Lykia-Cost` (USD decimal string) as a number. */
export function costFrom(headers: Headers): number | undefined {
  const raw = headers.get('x-lykia-cost');
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** `util.inspect.custom` without importing `node:util` (keeps the client free of Node built-ins). */
export const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export interface FinalRequest {
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  form?: FormData;
  stream?: boolean;
  accept?: string;
  /**
   * Follow redirects by hand so that the first response's headers (generation id, cost) are kept and the
   * credentials are never sent to the redirect target.
   */
  manualRedirect?: boolean;
}

/** A 2xx response whose headers arrived. */
export interface OpenResponse {
  response: Response;
  meta: ResponseMeta;
  /** Aborts on user abort and on timeout. */
  signal: AbortSignal;
  /** Re-arms the timeout (stream idle timer). */
  touch: () => void;
  /** Releases the timer and listeners. */
  done: () => void;
  /** Converts a body-read failure into a LykiaError (timeout / aborted / network_error). */
  wrapReadError: (err: unknown) => LykiaError;
}

function readEnv(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const value = proc?.env?.[name];
  return value === undefined || value === '' ? undefined : value;
}

function isBrowserPage(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
}

class TimeoutReason extends Error {}

export const networkError = (message: string, cause: unknown, generationId?: string) =>
  new LykiaError(message, { status: 0, code: 'network_error', retryable: true, cause, generationId });
export const timeoutError = (ms: number, cause?: unknown) =>
  new LykiaError(`Request timed out after ${ms} ms`, { status: 0, code: 'timeout', reason: 'timeout', retryable: true, cause });
export const abortedError = (cause?: unknown) =>
  new LykiaError('Request was aborted', { status: 0, code: 'aborted', retryable: false, cause });

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortedError());
    const onAbort = () => {
      clearTimeout(t);
      reject(abortedError());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class HttpCore {
  readonly baseURL: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  // Credentials and headers live in private fields: never enumerable, never serialised, never inspected.
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #defaultHeaders: Record<string, string>;

  constructor(options: LykiaOptions = {}) {
    if (isBrowserPage() && !options.dangerouslyAllowBrowser) {
      throw new LykiaError(
        'Refusing to run in a browser page: your Lykia API key would be visible to anyone who opens it. ' +
          'Call Lykia from your server, or pass dangerouslyAllowBrowser: true if you accept the risk.',
        { status: 0, code: 'invalid_request', retryable: false },
      );
    }
    const apiKey = options.apiKey ?? readEnv('LYKIA_API_KEY');
    if (!apiKey) {
      throw new LykiaError('Missing API key: pass { apiKey } or set the LYKIA_API_KEY environment variable.', {
        status: 0,
        code: 'invalid_request',
        retryable: false,
      });
    }
    this.#apiKey = apiKey;
    this.baseURL = (options.baseURL ?? readEnv('LYKIA_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? 0);
    if (!options.fetch && typeof globalThis.fetch !== 'function') {
      throw new LykiaError('No global fetch available; pass { fetch } to the client.', { status: 0, code: 'invalid_request', retryable: false });
    }
    this.#fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    // An Authorization header in defaultHeaders would override nothing (the key wins) and must not leak either.
    this.#defaultHeaders = Object.fromEntries(Object.entries(options.defaultHeaders ?? {}).filter(([k]) => k.toLowerCase() !== 'authorization'));
  }

  /** Redacted view for `JSON.stringify`. */
  toJSON(): Record<string, unknown> {
    return { baseURL: this.baseURL, timeoutMs: this.timeoutMs, maxRetries: this.maxRetries, apiKey: '[redacted]' };
  }

  [INSPECT](): string {
    return `HttpCore { baseURL: '${this.baseURL}', apiKey: '[redacted]' }`;
  }

  buildURL(path: string, query?: FinalRequest['query']): string {
    const url = new URL(this.baseURL + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    return url.toString();
  }

  private shouldRetry(req: FinalRequest, err: LykiaError): boolean {
    if (err.code === 'aborted') return false;
    if (req.method === 'GET') return err.retryable;
    return err.status === 429 && err.retryAfter !== undefined;
  }

  private delayFor(attempt: number, err: LykiaError): number | undefined {
    if (err.retryAfter !== undefined) return err.retryAfter > MAX_RETRY_AFTER_SECONDS ? undefined : err.retryAfter * 1000;
    return Math.min(500 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5);
  }

  /** Sends the request (with the configured retries) and resolves once a 2xx response's headers arrived. */
  async open(req: FinalRequest, options: RequestOptions = {}): Promise<OpenResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.openOnce(req, options);
      } catch (err) {
        if (!(err instanceof LykiaError) || attempt >= this.maxRetries || !this.shouldRetry(req, err)) throw err;
        const delay = this.delayFor(attempt, err);
        if (delay === undefined) throw err;
        await sleep(delay, options.signal);
      }
    }
  }

  private async openOnce(req: FinalRequest, options: RequestOptions): Promise<OpenResponse> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const userSignal = options.signal;
    if (userSignal?.aborted) throw abortedError(userSignal.reason);
    const controller = new AbortController();
    const onUserAbort = () => controller.abort(userSignal?.reason);
    userSignal?.addEventListener('abort', onUserAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new TimeoutReason('timeout')), timeoutMs);
    };
    const done = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      userSignal?.removeEventListener('abort', onUserAbort);
    };
    const wrap = (err: unknown, generationId?: string): LykiaError => {
      if (err instanceof LykiaError) return err;
      if (userSignal?.aborted) return abortedError(err);
      if (controller.signal.reason instanceof TimeoutReason) return timeoutError(timeoutMs, err);
      return networkError(`Network error: ${(err as Error)?.message ?? String(err)}`, err, generationId);
    };
    arm();

    const headers: Record<string, string> = {
      Accept: req.accept ?? (req.stream ? 'text/event-stream' : 'application/json'),
      ...this.#defaultHeaders,
      ...(options.headers ?? {}),
      Authorization: `Bearer ${this.#apiKey}`,
    };
    let body: BodyInit | undefined;
    if (req.form) body = req.form;
    else if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.body);
    }

    let res: Response;
    try {
      res = await this.#fetch(this.buildURL(req.path, req.query), {
        method: req.method,
        headers,
        body,
        signal: controller.signal,
        ...(req.manualRedirect ? { redirect: 'manual' as const } : {}),
      });
      if (req.manualRedirect) res = await this.followRedirects(res, controller.signal);
    } catch (err) {
      done();
      throw wrap(err);
    }
    if (res.type === 'opaqueredirect') {
      // Browser with redirect: 'manual': the caller repeats the request with automatic redirects.
      return { response: res, meta: metaFrom(res.headers), signal: controller.signal, touch: arm, done, wrapReadError: (e) => wrap(e) };
    }
    if (!res.ok) {
      let text: string | undefined;
      let parsed: unknown;
      try {
        text = await res.text();
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = undefined;
      }
      done();
      throw httpError(res.status, parsed, text, res.headers);
    }
    const meta = metaFrom(res.headers);
    if (req.stream) arm(); // from here on the timer measures silence between chunks
    return { response: res, meta, signal: controller.signal, touch: arm, done, wrapReadError: (e) => wrap(e, meta.generationId) };
  }

  async json<T>(req: FinalRequest, options?: RequestOptions): Promise<{ data: T; meta: ResponseMeta }> {
    const open = await this.open(req, options);
    try {
      let text: string;
      try {
        text = await open.response.text();
      } catch (err) {
        throw open.wrapReadError(err);
      }
      try {
        return { data: (text === '' ? undefined : JSON.parse(text)) as T, meta: open.meta };
      } catch (err) {
        throw new LykiaError(`Invalid JSON in response from ${req.method} ${req.path}`, {
          status: open.response.status,
          code: 'invalid_response',
          retryable: false,
          generationId: open.meta.generationId,
          body: text,
          cause: err,
        });
      }
    } finally {
      open.done();
    }
  }

  async text(req: FinalRequest, options?: RequestOptions): Promise<{ data: string; meta: ResponseMeta }> {
    const open = await this.open({ ...req, accept: req.accept ?? 'text/plain, */*' }, options);
    try {
      return { data: await open.response.text().catch((e: unknown) => Promise.reject(open.wrapReadError(e))), meta: open.meta };
    } finally {
      open.done();
    }
  }

  /**
   * Follows up to 5 redirects without credentials or default headers, keeping the Lykia headers of the first
   * response (`X-Generation-Id`, `X-Lykia-Cost`, …). In a browser `redirect: 'manual'` yields an opaque response;
   * then the request is repeated with automatic redirects (browsers strip credentials across origins themselves).
   */
  private async followRedirects(first: Response, signal: AbortSignal): Promise<Response> {
    if (first.type === 'opaqueredirect') return first;
    let res = first;
    const lykiaHeaders = new Headers();
    first.headers.forEach((v, k) => {
      if (k.startsWith('x-lykia-') || k === 'x-generation-id') lykiaHeaders.set(k, v);
    });
    for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400 && res.headers.get('location'); hop++) {
      const next = new URL(res.headers.get('location')!, res.url || this.baseURL);
      await res.body?.cancel().catch(() => undefined);
      res = await this.#fetch(next.toString(), { method: 'GET', redirect: 'manual', signal });
    }
    if (res === first) return res;
    const headers = new Headers(res.headers);
    lykiaHeaders.forEach((v, k) => {
      if (!headers.has(k)) headers.set(k, v);
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }

  async binary(req: FinalRequest, options?: RequestOptions): Promise<BinaryResult> {
    let open = await this.open({ ...req, accept: req.accept ?? '*/*', manualRedirect: true }, options);
    if (open.response.type === 'opaqueredirect') {
      open.done();
      open = await this.open({ ...req, accept: req.accept ?? '*/*' }, options);
    }
    try {
      const buf = await open.response.arrayBuffer().catch((e: unknown) => Promise.reject(open.wrapReadError(e)));
      return {
        data: new Uint8Array(buf),
        contentType: open.response.headers.get('content-type') ?? 'application/octet-stream',
        generationId: open.meta.generationId,
        cost: costFrom(open.response.headers),
        _meta: open.meta,
      };
    } finally {
      open.done();
    }
  }
}

export { parseRetryAfter };
