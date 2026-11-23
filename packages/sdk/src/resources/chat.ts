import { ChatCompletionStream } from '../chat-stream.js';
import type { HttpCore, RequestOptions } from '../core.js';
import { invalidRequest } from '../errors.js';
import type { ChatCompletion, ChatCompletionCreateParams } from '../types.js';
import { withMeta } from './shared.js';

export class Completions {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /** `POST /chat/completions` (non-streaming). The result carries `_meta: { generationId, preset, maxTokensApplied }`. */
  async create(body: ChatCompletionCreateParams, opts?: RequestOptions): Promise<ChatCompletion> {
    if ((body as { stream?: unknown }).stream) throw invalidRequest('create() does not stream; use chat.completions.stream().');
    const { data, meta } = await this.#core.json<ChatCompletion>({ method: 'POST', path: '/chat/completions', body }, opts);
    return withMeta(data, meta);
  }

  /**
   * `POST /chat/completions` with `stream: true`. Returns an async iterable of events
   * (`text`, `reasoning`, `tool_call`, then `done`) that also offers `.final()`. The request starts on first use.
   */
  stream(body: ChatCompletionCreateParams, opts?: RequestOptions): ChatCompletionStream {
    const payload = { ...body, stream: true };
    return new ChatCompletionStream(
      (signal) =>
        this.#core.open(
          { method: 'POST', path: '/chat/completions', body: payload, stream: true },
          {
            ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
            ...(opts?.headers ? { headers: opts.headers } : {}),
            signal,
          },
        ),
      opts?.signal,
    );
  }
}

export class Chat {
  readonly completions: Completions;
  constructor(core: HttpCore) {
    this.completions = new Completions(core);
  }
}
