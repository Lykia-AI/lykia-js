import type { OpenResponse, ResponseMeta } from './core.js';
import { networkError } from './core.js';
import { LykiaError, streamChunkError } from './errors.js';
import { parseSSE } from './sse.js';
import type { AssistantMessage, ChatCompletionChunk, ReasoningDetail, ToolCall, Usage } from './types.js';

/** Events yielded by `chat.completions.stream()`. */
export type ChatStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'reasoning'; delta: string }
  | {
      type: 'tool_call';
      index: number;
      /** Tool call id (known from the first fragment on). */
      id: string | undefined;
      /** Function name (known from the first fragment on). */
      name: string | undefined;
      /** The next piece of the JSON arguments string. */
      argumentsDelta: string;
    }
  | ({ type: 'done' } & ChatStreamFinal);

export interface ChatStreamFinal {
  /**
   * The complete assistant message: `content`, `reasoning`, `reasoning_details` (opaque; send the message back
   * unchanged in the next turn of a tool loop) and `tool_calls` with complete argument strings.
   */
  message: AssistantMessage;
  /** From the final chunk (includes `cost` and `cost_details`). */
  usage: Usage | undefined;
  finishReason: string | null;
  generationId: string | undefined;
  /** The model that actually served the request (from the stream chunks; a preset resolves to a concrete model). */
  model: string | undefined;
  /** The provider that served the request (from the stream chunks). */
  provider: string | undefined;
  /** `X-Lykia-Preset`: the preset name when the request used `@name`. */
  preset: string | undefined;
}

const MERGEABLE_TEXT = new Set(['text', 'summary', 'data']);

/**
 * Accumulates streamed `reasoning_details` fragments. Entries carrying the same `index` (and type) are one block
 * streamed in pieces: string fields `text`/`summary`/`data` are concatenated, other fields take the latest value.
 * Entries without an index are appended as they are.
 */
export function mergeReasoningDetails(target: ReasoningDetail[], incoming: unknown): void {
  if (!Array.isArray(incoming)) return;
  for (const raw of incoming) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as ReasoningDetail;
    const existing =
      typeof item.index === 'number' ? target.find((d) => d.index === item.index && d.type === item.type) : undefined;
    if (!existing) {
      target.push({ ...item });
      continue;
    }
    for (const [k, v] of Object.entries(item)) {
      if (v === undefined || v === null) continue;
      if (MERGEABLE_TEXT.has(k) && typeof v === 'string' && typeof existing[k] === 'string') existing[k] = (existing[k] as string) + v;
      else existing[k] = v;
    }
  }
}

/**
 * A streamed chat completion: `for await (const event of stream)` and/or `await stream.final()`.
 * The request starts on first use. It can be iterated once.
 */
export class ChatCompletionStream implements AsyncIterable<ChatStreamEvent> {
  private started = false;
  private readonly controller = new AbortController();
  private finalResult: ChatStreamFinal | undefined;
  private finalError: unknown;
  private waiters: Array<{ resolve: (f: ChatStreamFinal) => void; reject: (e: unknown) => void }> = [];
  /** Response metadata, available once the response headers arrived. */
  meta: ResponseMeta | undefined;

  constructor(
    private readonly start: (signal: AbortSignal) => Promise<OpenResponse>,
    private readonly userSignal: AbortSignal | undefined,
  ) {
    userSignal?.addEventListener('abort', () => this.controller.abort(userSignal.reason), { once: true });
  }

  /** `X-Generation-Id`, once the response started. */
  get generationId(): string | undefined {
    return this.meta?.generationId;
  }

  /** Cancels the request (Lykia cancels the provider request too; tokens produced so far are billed). */
  abort(): void {
    this.controller.abort();
  }

  /** Reads the stream to the end (if nobody else does) and resolves with the assembled result. */
  final(): Promise<ChatStreamFinal> {
    if (this.finalResult) return Promise.resolve(this.finalResult);
    if (this.finalError !== undefined) return Promise.reject(this.finalError);
    const p = new Promise<ChatStreamFinal>((resolve, reject) => this.waiters.push({ resolve, reject }));
    if (!this.started) {
      void (async () => {
        try {
          for await (const _ of this) {
            // drain
          }
        } catch {
          // delivered through the waiters
        }
      })();
    }
    return p;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<ChatStreamEvent> {
    if (this.started) throw new LykiaError('This stream has already been consumed.', { status: 0, code: 'invalid_request', retryable: false });
    this.started = true;
    let open: OpenResponse | undefined;
    try {
      open = await this.start(this.controller.signal);
      this.meta = open.meta;
      if (!open.response.body) throw networkError('Streaming response has no body', undefined, open.meta.generationId);

      let text = '';
      let reasoning = '';
      let sawReasoning = false;
      let reasoningField = false;
      const details: ReasoningDetail[] = [];
      const calls = new Map<number, { id?: string; name?: string; args: string; type: 'function' }>();
      let finishReason: string | null = null;
      let usage: Usage | undefined;
      let model: string | undefined;
      let provider: string | undefined;
      let sawDone = false;

      for await (const event of parseSSE(open.response.body, open.signal, open.touch)) {
        if (event.data === '[DONE]') {
          sawDone = true;
          break;
        }
        let chunk: ChatCompletionChunk;
        try {
          chunk = JSON.parse(event.data) as ChatCompletionChunk;
        } catch (err) {
          throw new LykiaError('Invalid JSON in stream chunk', { status: 200, code: 'invalid_response', retryable: false, generationId: this.generationId, body: event.data, cause: err });
        }
        if (chunk.error) {
          throw streamChunkError(chunk, this.generationId ?? (chunk.id as string | undefined));
        }
        if (chunk.usage) usage = chunk.usage;
        if (typeof chunk.model === 'string' && chunk.model) model = chunk.model;
        if (typeof chunk.provider === 'string' && chunk.provider) provider = chunk.provider;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.reasoning === 'string') reasoningField = true;
        if (typeof delta.reasoning === 'string' && delta.reasoning) {
          sawReasoning = true;
          reasoning += delta.reasoning;
          yield { type: 'reasoning', delta: delta.reasoning };
        } else if (!reasoningField && Array.isArray(delta.reasoning_details)) {
          // Only when the stream carries no plain `reasoning` text: derive it from readable detail blocks.
          for (const d of delta.reasoning_details as ReasoningDetail[]) {
            const piece = typeof d.text === 'string' ? d.text : typeof d.summary === 'string' ? d.summary : '';
            if (piece) {
              sawReasoning = true;
              reasoning += piece;
              yield { type: 'reasoning', delta: piece };
            }
          }
        }
        mergeReasoningDetails(details, delta.reasoning_details);
        if (typeof delta.content === 'string' && delta.content) {
          text += delta.content;
          yield { type: 'text', delta: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const index = typeof tc.index === 'number' ? tc.index : 0;
          const acc = calls.get(index) ?? { args: '', type: 'function' as const };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = (acc.name ?? '') + tc.function.name;
          const argumentsDelta = tc.function?.arguments ?? '';
          acc.args += argumentsDelta;
          calls.set(index, acc);
          yield { type: 'tool_call', index, id: acc.id, name: acc.name, argumentsDelta };
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      if (!sawDone) {
        // Aborted (by the caller or by the idle timeout) or the connection dropped.
        if (open.signal.aborted) throw open.wrapReadError(new Error('stream cancelled'));
        throw networkError('The stream ended before it was complete', undefined, this.generationId);
      }

      const toolCalls: ToolCall[] = [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => ({ id: c.id ?? '', type: 'function', function: { name: c.name ?? '', arguments: c.args } }));
      const message: AssistantMessage = {
        role: 'assistant',
        content: text.length > 0 ? text : null,
        ...(sawReasoning ? { reasoning } : {}),
        ...(details.length ? { reasoning_details: details } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      };
      this.finalResult = { message, usage, finishReason, generationId: this.generationId, model, provider, preset: this.meta?.preset };
      for (const w of this.waiters.splice(0)) w.resolve(this.finalResult);
      yield { type: 'done', ...this.finalResult };
    } catch (err) {
      const e = err instanceof LykiaError ? err : open ? open.wrapReadError(err) : networkError(String(err), err);
      this.finalError = e;
      for (const w of this.waiters.splice(0)) w.reject(e);
      throw e;
    } finally {
      open?.done();
    }
  }
}
