/**
 * Fake Lykia `/v1` server for tests: Node built-ins only, listens on 127.0.0.1.
 *
 * ```js
 * const { createFakeLykia, fakeError, chatChunks } = require('@lykia/sdk/testing'); // or ./lykia-fake-server.cjs
 * const fake = await createFakeLykia({ apiKey: 'lyk-v1-test' });
 * const lykia = new Lykia({ apiKey: 'lyk-v1-test', baseURL: fake.url });
 * fake.enqueue('POST /chat/completions', fakeError(429, { reason: 'rate_limited', retry_after: 2 }));
 * fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'Hi', toolCalls: [...] }) });
 * fake.requests;   // everything received, with `generationId` and contract `violations`
 * await fake.close();
 * ```
 *
 * Strict mode (the default) enforces the contract the real gateway enforces: bearer credentials (also for queued
 * responses), preset names and their endpoint kind, `user` / `metadata` limits, at most 8 file parts per chat
 * request; unknown top-level body fields are recorded in `request.violations`. `strict: false` is permissive.
 * Without a queued response every endpoint answers with realistic defaults.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ERROR_CODE_BY_STATUS, reasonForStatus } from '../errors.js';
import { PRESET_MODALITY, TAG_LIMITS, type PresetModality } from '../tags.js';

export interface FakeRequest {
  method: string;
  /** Path below the base URL, e.g. `/chat/completions` (the `/v1` prefix removed). */
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  /** Parsed JSON, `{ fields, files }` for multipart, a string otherwise, `undefined` when empty. */
  body: unknown;
  /** Raw body as a UTF-8 string (binary uploads may not round-trip). */
  rawBody: string;
  /** The `X-Generation-Id` this request was answered with. */
  generationId: string;
  /** Contract problems: fields the real gateway drops on Lykia's keys (unknown to it). */
  violations: string[];
  /** Fields the gateway accepts but overrides or only honours conditionally (e.g. `store`, `web_search_options`). */
  notes: string[];
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body. */
  json?: unknown;
  /** Raw body. */
  body?: string | Uint8Array;
  /** SSE: each item becomes one `data:` event (objects are JSON-encoded). `[DONE]` is appended unless `done: false`. */
  stream?: Array<unknown>;
  done?: boolean;
  /** Delay before the response headers: a slow first byte (ms). */
  delayMs?: number;
  /** Delay between SSE events (ms). */
  eventDelayMs?: number;
  /** Never answer (or, with `stream`, never finish the stream). */
  hang?: boolean;
  /** Drop the connection: before any header is sent, or in the middle of the body / stream. */
  drop?: 'before-headers' | 'mid-body';
  /** With `drop: 'mid-body'` and `stream`: how many events are sent before the drop (default 1). */
  dropAfter?: number;
}

export type FakeHandler = FakeResponse | ((req: FakeRequest) => FakeResponse | Promise<FakeResponse>);

export interface FakeLykiaOptions {
  /** Port to listen on (default: a free ephemeral port). */
  port?: number;
  /** Enforce the contract (default true). */
  strict?: boolean;
  /**
   * Require exactly this bearer credential. Without it, strict mode requires the documented shapes (`lyk-v1-…` project
   * keys, `lyk-oat-…` OAuth access tokens) or another token-looking value (16+ URL-safe characters); permissive mode any bearer.
   */
  apiKey?: string;
  /**
   * Defined presets and the endpoint kind each is for. Default: {@link FAKE_DEFAULT_PRESETS} (the suggested `PRESETS`
   * except `search`, which the real gateway does not have yet). Add it with `presets: { ...FAKE_DEFAULT_PRESETS, search: 'chat' }`.
   */
  presets?: Record<string, PresetModality>;
  /**
   * Preset defaults by preset name, applied like the gateway (request fields win). Used today for the speech voice:
   * `presetDefaults: { tts: { voice: 'JBFqnCBsd6RMkjVDRZzb' } }` lets `@tts` requests omit `voice`. Default: none.
   */
  presetDefaults?: Record<string, Record<string, unknown>>;
  /** `GET /credits` mode (default `prepaid`). */
  billingMode?: 'prepaid' | 'internal';
  /**
   * Video job clock: a job is `queued` for `queuedMs`, then `in_progress` for `runningMs`, then `completed` (default
   * 100 / 300 ms). Scripted outcomes by prompt: `#fail` → `failed`, `#expired` → completed but content 410 `video_expired`,
   * `#output-unavailable` → completed (and billed) with `output: null` + `error.code: video_output_unavailable`, content 502.
   */
  videoTimeline?: { queuedMs?: number; runningMs?: number };
}

export interface FakeGeneration {
  id: string;
  created_at: string;
  endpoint: string;
  model: string;
  preset: string | null;
  user: string | null;
  metadata: Record<string, string>;
  streamed: boolean;
  status: 'ok' | 'error' | 'cancelled';
  http_status: number;
  cost: number;
  /** `chat`, `embedding`, `image`, `video`, `speech`, `transcription` or `voice`. */
  kind: string;
}

export interface FakeLykia {
  /** Base URL to pass as `baseURL`, e.g. `http://127.0.0.1:53111/v1`. */
  url: string;
  origin: string;
  port: number;
  /** Every request received, in order. */
  requests: FakeRequest[];
  /** Generation records created from the requests (retrievable with `GET /generation?id=`). */
  generations: FakeGeneration[];
  /**
   * Queues a response for the next request matching `route`: `"POST /chat/completions"`, `"GET /videos/:id"`, or a
   * bare path for any method. A `/v1` prefix is accepted. Queued responses are used once, first in first out.
   */
  enqueue(route: string, response: FakeHandler): void;
  /** Clears queued responses, recorded requests, generations, video jobs and voices. */
  reset(): void;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------------------------------------ */

/** Builds a Lykia error response: `{ error: { message, type, code, status, metadata: { reason, provider?, retry_after? } } }`. */
export function fakeError(
  status: number,
  opts: {
    message?: string;
    code?: string;
    type?: string;
    reason?: string;
    provider?: string;
    retry_after?: number;
    /** `metadata.param`: the rejected request field. */
    param?: string;
    headers?: Record<string, string>;
  } = {},
): FakeResponse {
  const metadata: Record<string, unknown> = {};
  if (opts.param) metadata['param'] = opts.param;
  const reason = opts.reason ?? reasonForStatus(status);
  if (reason) metadata['reason'] = reason;
  if (opts.provider) metadata['provider'] = opts.provider;
  if (opts.retry_after !== undefined) metadata['retry_after'] = opts.retry_after;
  const headers = { ...(opts.headers ?? {}) };
  if (opts.retry_after !== undefined && headers['Retry-After'] === undefined) headers['Retry-After'] = String(opts.retry_after);
  return {
    status,
    headers,
    json: {
      error: {
        message: opts.message ?? `Fake error ${status}`,
        type: opts.type ?? errorTypeFor(status),
        code: opts.code ?? ERROR_CODE_BY_STATUS[status] ?? (status >= 500 ? 'server_error' : 'http_error'),
        status,
        metadata,
      },
    },
  };
}

/** `error.type` by status, as the gateway sets it. */
function errorTypeFor(status: number): string {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 502 || status === 504) return 'provider_error';
  if (status >= 500) return 'server_error';
  return 'invalid_request_error';
}

export interface FakeUsageOptions {
  prompt?: number;
  completion?: number;
  reasoning?: number;
  cached?: number;
  cost?: number;
}

export function fakeUsage(o: FakeUsageOptions = {}) {
  const prompt = o.prompt ?? 12;
  const completion = o.completion ?? 5;
  const cost = o.cost ?? 0.000123;
  const upstream = Math.round(cost * 0.8 * 1e12) / 1e12;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    cost,
    is_byok: false,
    cost_details: { upstream_cost: upstream, platform_fee: Math.round((cost - upstream) * 1e12) / 1e12, is_byok: false },
    prompt_tokens_details: { cached_tokens: o.cached ?? 0, cache_write_tokens: 0 },
    completion_tokens_details: { reasoning_tokens: o.reasoning ?? 0 },
  };
}

export interface ChatChunksOptions {
  /** Chunk id; by default the server fills in the request's `X-Generation-Id`. */
  id?: string;
  model?: string;
  provider?: string;
  /** Assistant text, sent in pieces (string → split in two; array → one piece each). */
  text?: string | string[];
  /** Reasoning text pieces (sent as `delta.reasoning`). */
  reasoning?: string | string[];
  /** `reasoning_details` fragments, one chunk each. */
  reasoningDetails?: Array<Record<string, unknown>>;
  /** Tool calls; `arguments` given as string pieces are streamed one piece per chunk. */
  toolCalls?: Array<{ id: string; name: string; arguments: string | string[] }>;
  finishReason?: string;
  usage?: Record<string, unknown> | null;
  /** Shorthand for `usage: fakeUsage({ cost })`: the USD cost of the final usage chunk (ignored when `usage` is given). */
  cost?: number;
  /** Fail after the content with this error chunk (no usage chunk follows). */
  error?: { message: string; code?: string; type?: string; reason?: string; status?: number };
  /**
   * Shape of the error event: `standalone` (default; what the gateway sends: `{ id, object, created, model, provider,
   * error }` without `choices`), `bare` (only `{ error }`), or `chunk` (older gateways: the error rides on a chunk with
   * `choices[].finish_reason: "error"`).
   */
  errorFormat?: 'standalone' | 'bare' | 'chunk';
}

const pieces = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : v.length > 1 ? [v.slice(0, Math.ceil(v.length / 2)), v.slice(Math.ceil(v.length / 2))] : [v];

/** Builds the `chat.completion.chunk` objects of a stream (pass as `stream` of a queued response). */
export function chatChunks(o: ChatChunksOptions = {}): Array<Record<string, unknown>> {
  const base = { ...(o.id ? { id: o.id } : {}), object: 'chat.completion.chunk', created: 1, model: o.model ?? 'openai/gpt-4o-mini', provider: o.provider ?? 'openai' };
  const ch = (delta: Record<string, unknown>, finish: string | null = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const out: Array<Record<string, unknown>> = [ch({ role: 'assistant', content: '' })];
  for (const r of pieces(o.reasoning)) out.push(ch({ reasoning: r }));
  for (const d of o.reasoningDetails ?? []) out.push(ch({ reasoning_details: [d] }));
  for (const t of pieces(o.text)) out.push(ch({ content: t }));
  (o.toolCalls ?? []).forEach((tc, index) => {
    const args = Array.isArray(tc.arguments) ? tc.arguments : [tc.arguments];
    args.forEach((a, i) =>
      out.push(
        ch({
          tool_calls: [i === 0 ? { index, id: tc.id, type: 'function', function: { name: tc.name, arguments: a } } : { index, function: { arguments: a } }],
        }),
      ),
    );
  });
  if (o.error) {
    const status = o.error.status ?? 502;
    const error = {
      message: o.error.message,
      type: o.error.type ?? 'provider_error',
      code: o.error.code ?? ERROR_CODE_BY_STATUS[status] ?? 'provider_error',
      status,
      metadata: { reason: o.error.reason ?? reasonForStatus(status) ?? 'provider_error' },
    };
    const fmt = o.errorFormat ?? 'standalone';
    out.push(fmt === 'bare' ? { error } : fmt === 'chunk' ? { ...base, error, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] } : { ...base, error });
    return out;
  }
  out.push(ch({}, o.finishReason ?? (o.toolCalls?.length ? 'tool_calls' : 'stop')));
  if (o.usage !== null) out.push({ ...base, choices: [], usage: o.usage ?? fakeUsage(o.cost !== undefined ? { cost: o.cost } : {}) });
  return out;
}

/* ------------------------------------------------------------------------------------------------ */

/** A valid 1×1 PNG. */
const PNG_1X1_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const ENDPOINT_MODALITY: Record<string, PresetModality> = {
  '/chat/completions': 'chat',
  '/embeddings': 'embedding',
  '/images/generations': 'image',
  '/videos': 'video',
  '/audio/speech': 'speech',
  '/audio/transcriptions': 'transcription',
};

const DEFAULT_MODEL: Record<PresetModality, string> = {
  chat: 'openai/gpt-4o-mini',
  embedding: 'openai/text-embedding-3-small',
  image: 'recraft/recraftv4_1',
  video: 'bytedance/seedance-1.0-pro',
  speech: 'elevenlabs/eleven_multilingual_v2',
  transcription: 'elevenlabs/scribe_v2',
};

/**
 * Default preset table of the fake: the suggested `PRESETS` except `search` (no web-search preset on the real gateway
 * yet; giving it a default here would only create false confidence).
 */
export const FAKE_DEFAULT_PRESETS: Readonly<Record<string, PresetModality>> = Object.freeze(
  Object.fromEntries(Object.entries(PRESET_MODALITY).filter(([name]) => name !== 'search')),
);

/**
 * Chat fields the gateway forwards on Lykia's keys (backend `PLATFORM_BODY_FIELDS`) plus Lykia's own fields
 * (`models`, `provider`, and the tags `user` / `metadata`, which are stored and never forwarded).
 */
const CHAT_FIELDS = new Set(
  'model messages stream stream_options max_tokens max_completion_tokens temperature top_p top_k min_p top_a frequency_penalty presence_penalty repetition_penalty seed stop tools tool_choice parallel_tool_calls response_format structured_outputs logprobs top_logprobs logit_bias user reasoning reasoning_effort include_reasoning verbosity transforms usage prompt_cache_key cache models provider metadata'.split(' '),
);

/** Chat fields the gateway accepts but overrides or honours only conditionally. */
const CHAT_NOTES: Record<string, string> = {
  store: '"store" is accepted but never enabled: the gateway always sends store: false (no provider-side storage)',
  web_search_options: '"web_search_options" is accepted but dropped: web search is not available on the gateway yet',
};

/** Top-level body fields the gateway knows per endpoint (others are dropped; the fake records them as violations). */
const KNOWN_FIELDS: Record<string, Set<string>> = {
  '/chat/completions': CHAT_FIELDS,
  '/embeddings': new Set('model input dimensions encoding_format user metadata provider models'.split(' ')),
  '/images/generations': new Set('model prompt n size aspect_ratio resolution quality seed output_format response_format images mask provider_options models provider user metadata'.split(' ')),
  '/videos': new Set('model prompt image last_frame reference_images duration duration_seconds seconds aspect_ratio resolution audio seed provider_options models provider user metadata'.split(' ')),
  '/audio/speech': new Set('model input voice response_format speed language instructions provider_options user metadata'.split(' ')),
  '/audio/transcriptions': new Set('file model language prompt response_format timestamp_granularities[] temperature provider_options provider user metadata'.split(' ')),
};

const PRESET_RE = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_FILE_PARTS = 8;
const MAX_TRANSCRIPTION_BYTES = 25 * 1024 * 1024;

let counter = 0;
const newGenerationId = () => `gen-${Math.floor(Date.now() / 1000)}-fake${String(++counter).padStart(12, '0')}`;

/** FNV-1a 32-bit. */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** Deterministic, normalised vector from character trigrams: same text → same vector, similar texts → close vectors. */
export function fakeEmbedding(text: string, dims = 16): number[] {
  const v = new Array<number>(dims).fill(0);
  const t = ` ${String(text).toLowerCase().replace(/\s+/g, ' ').trim()} `;
  for (let i = 0; i + 3 <= t.length; i++) {
    const h = fnv(t.slice(i, i + 3));
    v[h % dims]! += h & 0x100 ? 1 : -1;
  }
  let norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  if (norm === 0) {
    v[0] = 1;
    norm = 1;
  }
  return v.map((x) => Math.round((x / norm) * 1e9) / 1e9);
}

type Schema = Record<string, unknown>;

/** Minimal value that satisfies a JSON Schema: required properties, enums/const, basic types, local `$ref`s. */
export function sampleFromSchema(schema: unknown, root: unknown = schema, depth = 0): unknown {
  if (!schema || typeof schema !== 'object' || depth > 12) return null;
  const s = schema as Schema;
  if (typeof s['$ref'] === 'string' && s['$ref'].startsWith('#/')) {
    const target = s['$ref']
      .slice(2)
      .split('/')
      .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Schema)[k.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined), root);
    return sampleFromSchema(target, root, depth + 1);
  }
  if ('const' in s) return s['const'];
  if (Array.isArray(s['enum']) && s['enum'].length) return s['enum'][0];
  for (const k of ['anyOf', 'oneOf']) {
    const list = s[k];
    if (Array.isArray(list) && list.length) {
      const nonNull = list.find((x) => !(x && typeof x === 'object' && (x as Schema)['type'] === 'null')) ?? list[0];
      return sampleFromSchema(nonNull, root, depth + 1);
    }
  }
  if (Array.isArray(s['allOf'])) {
    const merged: Schema = { type: 'object', properties: {}, required: [] };
    for (const part of s['allOf'] as Schema[]) {
      Object.assign(merged['properties'] as Schema, part['properties'] ?? {});
      (merged['required'] as string[]).push(...((part['required'] as string[]) ?? []));
    }
    return sampleFromSchema(merged, root, depth + 1);
  }
  let type = s['type'];
  if (Array.isArray(type)) type = type.find((t) => t !== 'null') ?? type[0];
  if (type === undefined) type = s['properties'] ? 'object' : s['items'] ? 'array' : 'string';
  switch (type) {
    case 'object': {
      const out: Record<string, unknown> = {};
      const props = (s['properties'] ?? {}) as Record<string, unknown>;
      for (const key of (s['required'] as string[] | undefined) ?? []) out[key] = sampleFromSchema(props[key] ?? {}, root, depth + 1);
      return out;
    }
    case 'array': {
      const n = Math.max(1, Number(s['minItems'] ?? 1));
      return Array.from({ length: n }, () => sampleFromSchema(s['items'] ?? {}, root, depth + 1));
    }
    case 'integer': {
      const min = typeof s['minimum'] === 'number' ? Math.ceil(s['minimum']) : typeof s['exclusiveMinimum'] === 'number' ? Math.floor(s['exclusiveMinimum']) + 1 : 1;
      return typeof s['maximum'] === 'number' ? Math.min(min, s['maximum']) : min;
    }
    case 'number': {
      const min = typeof s['minimum'] === 'number' ? s['minimum'] : typeof s['exclusiveMinimum'] === 'number' ? s['exclusiveMinimum'] + 0.5 : 1.5;
      return typeof s['maximum'] === 'number' ? Math.min(min, s['maximum']) : min;
    }
    case 'boolean':
      return true;
    case 'null':
      return null;
    default: {
      const format = s['format'];
      let v =
        format === 'date-time' ? '2026-01-01T00:00:00Z' : format === 'date' ? '2026-01-01' : format === 'email' ? 'fake@example.com' : format === 'uri' || format === 'url' ? 'https://example.com' : format === 'uuid' ? '00000000-0000-4000-8000-000000000000' : 'fake';
      if (typeof s['minLength'] === 'number' && v.length < s['minLength']) v += 'x'.repeat(s['minLength'] - v.length);
      if (typeof s['maxLength'] === 'number' && v.length > s['maxLength']) v = v.slice(0, s['maxLength']);
      return v;
    }
  }
}

function parseQuery(url: URL): Record<string, string> {
  const q: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (q[k] = v));
  return q;
}

async function parseBody(req: IncomingMessage, raw: Buffer, origin: string): Promise<unknown> {
  if (raw.length === 0) return undefined;
  const type = String(req.headers['content-type'] ?? '');
  if (type.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return raw.toString('utf8');
    }
  }
  if (type.startsWith('multipart/form-data')) {
    const form = await new Request(`${origin}/upload`, { method: 'POST', headers: { 'content-type': type }, body: new Uint8Array(raw) }).formData();
    const fields: Record<string, string | string[]> = {};
    const files: Array<{ field: string; filename: string; contentType: string; size: number }> = [];
    const order: string[] = [];
    for (const [k, v] of form.entries()) {
      order.push(k);
      if (typeof v === 'string') {
        const prev = fields[k];
        fields[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      } else {
        const file = v as File;
        files.push({ field: k, filename: file.name, contentType: file.type, size: file.size });
      }
    }
    return { fields, files, order };
  }
  return raw.toString('utf8');
}

function routeMatches(route: string, method: string, path: string): boolean {
  const parts = route.trim().split(/\s+/);
  const [m, p] = parts.length === 2 ? [parts[0]!.toUpperCase(), parts[1]!] : [undefined, parts[0]!];
  if (m && m !== method) return false;
  const pattern = p.replace(/^\/v1(?=\/)/, '');
  const re = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]+/g, '[^/]+').replace(/\*/g, '.*')}$`);
  return re.test(path);
}

type FakeModel = Record<string, unknown> & { id: string; kind: PresetModality; supported_parameters: string[]; architecture: { output_modalities: string[]; [key: string]: unknown } };

const mediaModel = (id: string, name: string, kind: PresetModality, out: string, unit: string, usd: string, provider: string, capabilities: Record<string, unknown>): FakeModel => ({
  id,
  canonical_slug: id,
  hugging_face_id: null,
  name,
  created: 1795400000,
  description: '',
  context_length: null,
  architecture: { modality: `text->${out}`, input_modalities: ['text'], output_modalities: [out], tokenizer: null },
  pricing: {},
  top_provider: { context_length: null, max_completion_tokens: null },
  supported_parameters: Object.keys(capabilities),
  is_free: false,
  expiration_date: null,
  kind,
  media: { kind, capabilities, pricing: { unit, quantity: 1, tiers: [{ when: {}, usd }], surcharges: [] }, providers: [provider] },
});

const MODELS: FakeModel[] = [
  {
    id: 'openai/gpt-4o-mini',
    canonical_slug: 'openai/gpt-4o-mini-2024-07-18',
    hugging_face_id: null,
    name: 'OpenAI: GPT-4o-mini',
    created: 1721260800,
    description: '',
    context_length: 128000,
    architecture: { modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text'], tokenizer: 'GPT' },
    pricing: { prompt: '0.00000015', completion: '0.0000006' },
    top_provider: { context_length: 128000, max_completion_tokens: 16384 },
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'tool_choice', 'response_format'],
    is_free: false,
    expiration_date: null,
    kind: 'chat',
  },
  {
    id: 'anthropic/claude-sonnet-4.5',
    canonical_slug: 'anthropic/claude-sonnet-4.5',
    hugging_face_id: null,
    name: 'Anthropic: Claude Sonnet 4.5',
    created: 1759104000,
    description: '',
    context_length: 200000,
    architecture: { modality: 'text+image->text', input_modalities: ['text', 'image', 'file'], output_modalities: ['text'], tokenizer: 'Claude' },
    pricing: { prompt: '0.000003', completion: '0.000015' },
    top_provider: { context_length: 200000, max_completion_tokens: 64000 },
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'],
    is_free: false,
    expiration_date: null,
    kind: 'chat',
  },
  {
    id: 'openai/text-embedding-3-small',
    canonical_slug: 'openai/text-embedding-3-small',
    hugging_face_id: null,
    name: 'OpenAI: Text Embedding 3 Small',
    created: 1706000000,
    description: '',
    context_length: 8192,
    architecture: { modality: 'text->embedding', input_modalities: ['text'], output_modalities: ['embedding'], tokenizer: null },
    pricing: { prompt: '0.00000002' },
    top_provider: { context_length: 8192, max_completion_tokens: null },
    supported_parameters: ['dimensions'],
    is_free: false,
    expiration_date: null,
    kind: 'embedding',
  },
  mediaModel('recraft/recraftv4_1', 'Recraft V4.1', 'image', 'image', 'per_image', '0.035', 'recraft', {
    operations: ['generate'], mode: 'sync', maxN: 6, sizes: ['1024x1024', '1365x1024', '1024x1365'], outputFormats: ['webp', 'png'],
  }),
  mediaModel('bytedance/seedance-1.0-pro', 'Seedance 1.0 Pro', 'video', 'video', 'per_token', '0.0000025', 'bytedance', {
    durations: [5, 10], resolutions: ['480p', '720p', '1080p'], firstFrame: true, lastFrame: true, audio: false,
  }),
  mediaModel('elevenlabs/eleven_multilingual_v2', 'Eleven Multilingual v2', 'speech', 'audio', 'per_character', '0.00008', 'elevenlabs', {
    formats: ['mp3', 'opus', 'pcm', 'wav'], speed: true, voices: true, cloning: true,
  }),
  mediaModel('elevenlabs/scribe_v2', 'Scribe v2', 'transcription', 'transcription', 'per_second', '0.0000167', 'elevenlabs', {
    formats: ['json', 'text', 'verbose_json'], maxBytes: 26214400,
  }),
];

const MODEL_BY_ID = new Map(MODELS.map((m) => [m.id, m]));

const OUTPUT_KIND: Record<string, PresetModality> = { embedding: 'embedding', image: 'image', video: 'video', audio: 'speech', transcription: 'transcription' };

interface Video {
  id: string;
  createdAt: number;
  model: string;
  provider: string;
  duration: number;
  fail: boolean;
  expired: boolean;
  outputUnavailable: boolean;
  cancelledAt?: number;
  failedAt?: number;
}

const bad = (message: string, code = 'invalid_request') => fakeError(400, { message, code, reason: 'invalid_request' });

/** Adds `metadata.param` to an error response (the field that was rejected). */
function withParam(r: FakeResponse, param: string): FakeResponse {
  const err = (r.json as { error: { metadata: Record<string, unknown> } }).error;
  err.metadata['param'] = param;
  return r;
}

export async function createFakeLykia(options: FakeLykiaOptions = {}): Promise<FakeLykia> {
  const strict = options.strict ?? true;
  const presets: Record<string, PresetModality> = { ...(options.presets ?? FAKE_DEFAULT_PRESETS) };
  const requests: FakeRequest[] = [];
  const generations: FakeGeneration[] = [];
  const queue: Array<{ route: string; handler: FakeHandler }> = [];
  const videos = new Map<string, Video>();
  const voices = new Map<string, Record<string, unknown>>();
  let origin = '';

  const authorized = (header: string | undefined): boolean => {
    const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
    if (!m) return false;
    if (options.apiKey !== undefined) return m[1] === options.apiKey;
    if (!strict) return true;
    // Project API keys `lyk-v1-…`; OAuth access tokens `lyk-oat-…` (or any other token-looking value).
    return /^lyk-(v1|oat)-[A-Za-z0-9_-]{4,}$/.test(m[1]!) || (!m[1]!.startsWith('lyk-') && /^[A-Za-z0-9._~+/=-]{16,}$/.test(m[1]!));
  };

  /** Strict contract checks for generation endpoints. Returns an error response, or undefined. */
  const validate = (req: FakeRequest): FakeResponse | undefined => {
    const endpoint = req.method === 'POST' ? ENDPOINT_MODALITY[req.path] : undefined;
    if (!endpoint) return undefined;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const fields = body['fields'] && typeof body['fields'] === 'object' && req.path === '/audio/transcriptions' ? (body['fields'] as Record<string, unknown>) : undefined;
    const known = KNOWN_FIELDS[req.path];
    if (known) {
      for (const k of Object.keys(fields ?? body)) {
        if (known.has(k)) continue;
        if (req.path === '/chat/completions' && CHAT_NOTES[k]) req.notes.push(CHAT_NOTES[k]);
        else req.violations.push(`unknown field "${k}" (dropped on Lykia's keys; passed through only with your own provider key)`);
      }
    }
    if (req.path === '/chat/completions') {
      const msgs = body['messages'];
      if (!Array.isArray(msgs) || msgs.length === 0) return bad('`messages` must be a non-empty array');
      for (const [i, m] of (msgs as Array<Record<string, unknown>>).entries()) {
        if (!m || typeof m !== 'object' || typeof m['role'] !== 'string' || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(m['role'])) {
          return bad(`\`messages[${i}].role\` must be one of system, developer, user, assistant, tool`);
        }
        if (m['role'] === 'tool' && typeof m['tool_call_id'] !== 'string') return bad(`\`messages[${i}].tool_call_id\` is required for tool messages`);
      }
    }
    const model = fields ? fields['model'] : body['model'];
    if (typeof model === 'string' && model.startsWith('@')) {
      const name = model.slice(1);
      const defined = Object.keys(presets).map((p) => `@${p}`).join(', ');
      if (!PRESET_RE.test(name) || !(name in presets)) {
        return bad(`Preset ${model} is not defined. Defined presets: ${defined}`, 'preset_not_found');
      }
      if (presets[name] !== endpoint) {
        return bad(`Preset ${model} is a ${presets[name]} preset and cannot be used for ${endpoint}`, 'preset_modality_mismatch');
      }
    }
    if (typeof model === 'string' && !model.startsWith('@')) {
      const known = MODEL_BY_ID.get(model);
      if (known && known.kind !== endpoint) {
        return endpoint === 'embedding'
          ? bad(`Model ${model} does not produce embeddings. Use a model whose output modality is "embedding".`, 'unsupported_model')
          : bad(`Model ${model} is not a ${endpoint} model`, 'unsupported_model');
      }
    }
    const provider = body['provider'] as { sort?: unknown } | undefined;
    if (provider && typeof provider === 'object' && provider.sort !== undefined && provider.sort !== null && provider.sort !== 'price') {
      return bad('`provider.sort` supports only "price" (throughput and latency are not measured)', 'unsupported_sort');
    }
    if (endpoint === 'image') {
      if (typeof body['prompt'] !== 'string' || !body['prompt']) return withParam(bad('`prompt` is required', 'bad_request'), 'prompt');
      const n = body['n'];
      if (n !== undefined && (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 16)) return withParam(bad('`n` must be an integer ≥ 1 ≤ 16', 'bad_request'), 'n');
      const rf = body['response_format'];
      if (rf !== undefined && rf !== 'url' && rf !== 'b64_json') return withParam(bad('`response_format` must be url or b64_json', 'bad_request'), 'response_format');
    }
    if (endpoint === 'video' && (typeof body['prompt'] !== 'string' || !body['prompt'])) return withParam(bad('`prompt` is required', 'bad_request'), 'prompt');
    if (endpoint === 'speech') {
      if (typeof body['input'] !== 'string' || !body['input']) return withParam(bad('`input` is required', 'bad_request'), 'input');
      if (!speechVoice(body)) return withParam(bad('`voice` is required', 'bad_request'), 'voice');
    }
    if (endpoint === 'transcription') {
      const fmt = fields?.['response_format'];
      if (fmt !== undefined && !['json', 'text', 'srt', 'verbose_json', 'vtt', 'diarized_json'].includes(String(fmt))) {
        return fakeError(400, { message: 'Unsupported response_format', code: 'unsupported_input', reason: 'unsupported_input', param: 'response_format' });
      }
    }
    const user = fields ? fields['user'] : body['user'];
    if (user !== undefined && user !== null) {
      if (typeof user !== 'string') return bad('user must be a string', 'invalid_tags');
      if (user.length > TAG_LIMITS.userMaxLength) return bad(`user is longer than ${TAG_LIMITS.userMaxLength} characters`, 'invalid_tags');
    }
    let metadata = fields ? fields['metadata'] : body['metadata'];
    if (typeof metadata === 'string' && fields) {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        return bad('metadata must be a JSON object');
      }
    }
    if (metadata !== undefined && metadata !== null) {
      const t = 'invalid_tags';
      if (typeof metadata !== 'object' || Array.isArray(metadata)) return bad('metadata must be an object of strings', t);
      const entries = Object.entries(metadata as Record<string, unknown>);
      if (entries.length > TAG_LIMITS.metadataMaxKeys) return bad(`metadata has ${entries.length} keys (at most ${TAG_LIMITS.metadataMaxKeys})`, t);
      for (const [k, v] of entries) {
        if (!k || k.length > TAG_LIMITS.metadataKeyMaxLength || k.startsWith('$') || k.includes('.')) {
          return bad(`metadata keys must be 1–${TAG_LIMITS.metadataKeyMaxLength} characters, must not start with "$" and must not contain "."`, t);
        }
        if (typeof v !== 'string') return bad(`metadata.${k} must be a string`, t);
        if (v.length > TAG_LIMITS.metadataValueMaxLength) return bad(`metadata.${k} is longer than ${TAG_LIMITS.metadataValueMaxLength} characters`, t);
      }
    }
    if (endpoint === 'chat' && Array.isArray(body['messages'])) {
      let files = 0;
      for (const m of body['messages'] as Array<{ content?: unknown }>) {
        if (!Array.isArray(m?.content)) continue;
        for (const p of m.content as Array<{ type?: string; file?: { file_data?: unknown; filename?: unknown } }>) {
          if (p?.type !== 'file') continue;
          files++;
          if (typeof p.file?.file_data !== 'string' || !p.file.file_data.startsWith('data:')) return bad('file parts need file.file_data as a data: URI');
          if (!p.file.filename) return bad('file parts need file.filename');
        }
      }
      if (files > MAX_FILE_PARTS) return bad(`${files} file parts (at most ${MAX_FILE_PARTS} per request)`, 'too_many_files');
    }
    if (req.path === '/audio/transcriptions') {
      const files = (body['files'] as Array<{ size: number }> | undefined) ?? [];
      if (files.length !== 1) return bad('exactly one file is required');
      if (files[0]!.size > MAX_TRANSCRIPTION_BYTES) return fakeError(413, { message: 'File larger than 25 MB', code: 'payload_too_large', reason: 'invalid_request' });
    }
    return undefined;
  };

  const ENDPOINT_NAME: Record<string, string> = {
    '/chat/completions': 'chat.completions',
    '/embeddings': 'embeddings',
    '/images/generations': 'images.generations',
    '/videos': 'videos',
    '/audio/speech': 'audio.speech',
    '/audio/transcriptions': 'audio.transcriptions',
  };

  /** The request's voice, else the `@preset`'s default voice (like the gateway); `undefined` when neither gives one. */
  const speechVoice = (body: Record<string, unknown>): string | undefined => {
    if (typeof body['voice'] === 'string' && body['voice']) return body['voice'];
    const model = body['model'];
    const d = typeof model === 'string' && model.startsWith('@') ? options.presetDefaults?.[model.slice(1)]?.['voice'] : undefined;
    return typeof d === 'string' && d ? d : undefined;
  };

  const record = (req: FakeRequest, status: number, extra: { cost?: number; streamed?: boolean } = {}) => {
    const endpoint = req.method === 'POST' ? ENDPOINT_MODALITY[req.path] : undefined;
    if (!endpoint) return;
    // A video's generation record is written when the job ends (see videoView).
    if (endpoint === 'video') return;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const src = req.path === '/audio/transcriptions' ? ((body['fields'] ?? {}) as Record<string, unknown>) : body;
    const model = typeof src['model'] === 'string' ? src['model'] : DEFAULT_MODEL[endpoint];
    let metadata = src['metadata'];
    if (typeof metadata === 'string') {
      try {
        metadata = JSON.parse(metadata);
      } catch {
        metadata = {};
      }
    }
    generations.push({
      id: req.generationId,
      created_at: new Date().toISOString(),
      endpoint: ENDPOINT_NAME[req.path] ?? req.path,
      model: model.startsWith('@') ? DEFAULT_MODEL[presets[model.slice(1)] ?? endpoint] : model,
      preset: model.startsWith('@') ? model.slice(1) : null,
      user: typeof src['user'] === 'string' ? src['user'] : null,
      metadata: (metadata && typeof metadata === 'object' ? metadata : {}) as Record<string, string>,
      streamed: extra.streamed ?? false,
      status: status < 400 ? 'ok' : 'error',
      http_status: status,
      cost: status < 400 ? (extra.cost ?? 0) : 0,
      kind: endpoint,
    });
  };

  const timeline = { queuedMs: options.videoTimeline?.queuedMs ?? 100, runningMs: options.videoTimeline?.runningMs ?? 300 };
  const VIDEO_COST = 0.27;

  /** Signed-looking URL served by the fake (`/fake-files/signed/…`), different on every call (re-signed). */
  const signedUrl = (name: string) => {
    const sig = fnv(`${name}:${Date.now()}:${Math.random()}`).toString(16).padStart(8, '0');
    return { url: `${origin}/fake-files/signed/${name}?X-Amz-Expires=3600&X-Amz-Signature=${sig}${sig}${sig}${sig}`, expires_at: new Date(Date.now() + 3600_000).toISOString() };
  };

  /** The job object at this moment (status from the clock). Writes the generation record when the job ends. */
  const videoView = (v: Video): Record<string, unknown> => {
    const now = Date.now();
    const age = now - v.createdAt;
    let status: string;
    let completedAt: number | null = null;
    if (v.cancelledAt) {
      status = 'cancelled';
      completedAt = v.cancelledAt;
    } else if (age < timeline.queuedMs) status = 'queued';
    else if (age < timeline.queuedMs + timeline.runningMs) status = 'in_progress';
    else {
      status = v.fail ? 'failed' : 'completed';
      completedAt = v.createdAt + timeline.queuedMs + timeline.runningMs;
    }
    const progress = status === 'completed' ? 100 : status === 'in_progress' ? Math.min(99, Math.floor(((age - timeline.queuedMs) / timeline.runningMs) * 100)) : 0;
    const final = status === 'completed' || status === 'failed' || status === 'cancelled';
    const cost = status === 'completed' ? VIDEO_COST : 0;
    if (final && !generations.some((g) => g.id === v.id)) {
      generations.push({
        id: v.id,
        created_at: new Date(v.createdAt).toISOString(),
        endpoint: 'videos',
        model: v.model,
        preset: null,
        user: null,
        metadata: {},
        streamed: false,
        status: status === 'completed' ? 'ok' : status === 'cancelled' ? 'cancelled' : 'error',
        http_status: 200,
        cost,
        kind: 'video',
      });
    }
    const sec = (ms: number | null) => (ms === null ? null : Math.floor(ms / 1000));
    return {
      id: v.id,
      object: 'video',
      status,
      progress,
      model: v.model,
      provider: v.provider,
      created_at: sec(v.createdAt),
      completed_at: sec(completedAt),
      expires_at: status === 'completed' ? sec((completedAt ?? now) + 7 * 86_400_000) : null,
      duration_seconds: status === 'completed' ? v.duration : null,
      params: { duration: v.duration, image: false, last_frame: false, reference_images: 0 },
      ...(status === 'failed' ? { error: { message: `${v.provider}: internal error`, code: 'provider_error', reason: 'provider_error' } } : {}),
      ...(status === 'cancelled' ? { error: { message: 'The job was cancelled', code: 'cancelled', reason: 'invalid_request' } } : {}),
      ...(status === 'completed' && v.outputUnavailable
        ? { error: { message: 'The video was generated, but Lykia could not copy the file from the provider.', code: 'video_output_unavailable', reason: 'provider_error', retryable: false } }
        : {}),
      ...(final ? { usage: { cost, is_byok: false, cost_details: fakeUsage({ cost }).cost_details } } : {}),
      ...(status === 'completed'
        ? { output: v.outputUnavailable ? null : { ...signedUrl(`${encodeURIComponent(v.id)}.mp4`), mime_type: 'video/mp4', width: 1280, height: 720, bytes: 9 } }
        : {}),
    };
  };

  const send = async (req: IncomingMessage, res: ServerResponse, r: FakeResponse, generationId: string) => {
    if (r.delayMs) await new Promise((x) => setTimeout(x, r.delayMs));
    if (r.drop === 'before-headers') {
      req.socket.destroy();
      return;
    }
    if (r.hang && !r.stream) return;
    const headers: Record<string, string> = { 'X-Generation-Id': generationId, 'Cache-Control': 'no-store', ...(r.headers ?? {}) };
    if (r.stream) {
      res.writeHead(r.status ?? 200, { 'Content-Type': 'text/event-stream; charset=utf-8', ...headers });
      res.write(': lykia fake stream\n\n');
      let sent = 0;
      for (const item of r.stream) {
        if (r.eventDelayMs) await new Promise((x) => setTimeout(x, r.eventDelayMs));
        if (res.destroyed) return;
        if (r.drop === 'mid-body' && sent >= (r.dropAfter ?? 1)) {
          res.socket?.destroy();
          return;
        }
        const event = item && typeof item === 'object' && !('id' in item) && 'object' in item ? { id: generationId, ...item } : item;
        res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`);
        sent++;
      }
      if (r.drop === 'mid-body') {
        res.socket?.destroy();
        return;
      }
      if (r.hang) return;
      if (r.done !== false) res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    const payload = r.json !== undefined ? Buffer.from(JSON.stringify(r.json)) : r.body === undefined ? undefined : typeof r.body === 'string' ? Buffer.from(r.body) : Buffer.from(r.body);
    if (r.json !== undefined) headers['Content-Type'] ??= 'application/json; charset=utf-8';
    res.writeHead(r.status ?? 200, headers);
    if (r.drop === 'mid-body') {
      if (payload) res.write(payload.subarray(0, Math.floor(payload.length / 2)));
      res.socket?.destroy();
      return;
    }
    res.end(payload);
  };

  const defaults = (req: FakeRequest): FakeResponse => {
    const { method, path } = req;
    const generationId = req.generationId;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const presetOf = (model: unknown) => (typeof model === 'string' && model.startsWith('@') ? model.slice(1) : undefined);
    const realModel = (model: unknown, kind: PresetModality) =>
      typeof model === 'string' && !model.startsWith('@') ? model : DEFAULT_MODEL[kind];
    const presetHeaders = (model: unknown): Record<string, string> => {
      const p = presetOf(model);
      return p ? { 'X-Lykia-Preset': p } : {};
    };

    if (method === 'POST' && path === '/chat/completions') {
      if (!Array.isArray(body['messages'])) return bad('messages is required', 'invalid_body');
      const model = realModel(body['model'], 'chat');
      const messages = body['messages'] as Array<{ role?: string; content?: unknown; tool_calls?: unknown; reasoning_details?: unknown }>;
      const last = messages.at(-1)?.content;
      let text = `echo: ${typeof last === 'string' ? last : Array.isArray(last) ? last.map((p: { text?: string }) => p.text ?? '').join('') : ''}`;
      const rf = body['response_format'] as { type?: string; json_schema?: { schema?: unknown } } | undefined;
      if (rf?.type === 'json_schema') text = JSON.stringify(sampleFromSchema(rf.json_schema?.schema ?? { type: 'object' }));
      else if (rf?.type === 'json_object') text = JSON.stringify({ result: 'fake' });
      const headers: Record<string, string> = { ...presetHeaders(body['model']) };
      if (body['max_tokens'] === undefined && body['max_completion_tokens'] === undefined) headers['X-Max-Tokens-Applied'] = '4096';
      const reasoning = body['reasoning'] as { enabled?: boolean } | undefined;
      if (reasoning && reasoning.enabled !== false && messages.some((m) => m?.role === 'assistant' && m.tool_calls && !m.reasoning_details)) {
        headers['X-Lykia-Reasoning'] = 'dropped';
      }
      if (body['stream']) return { headers, stream: chatChunks({ id: generationId, model, provider: model.split('/')[0] ?? 'openai', text }) };
      return {
        headers,
        json: {
          id: generationId,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          provider: model.split('/')[0] ?? 'openai',
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: fakeUsage(),
        },
      };
    }
    if (method === 'POST' && path === '/embeddings') {
      const input = Array.isArray(body['input']) ? (body['input'] as unknown[]) : [body['input']];
      const dims = Number(body['dimensions']) > 0 ? Number(body['dimensions']) : 16;
      const u = fakeUsage({ cost: 0.00000002 * input.length * 3 });
      return {
        headers: presetHeaders(body['model']),
        json: {
          object: 'list',
          model: realModel(body['model'], 'embedding'),
          provider: 'openai',
          data: input.map((t, index) => {
            const vec = fakeEmbedding(String(t ?? ''), dims);
            if (body['encoding_format'] !== 'base64') return { object: 'embedding', index, embedding: vec };
            const buf = Buffer.alloc(dims * 4);
            vec.forEach((x, j) => buf.writeFloatLE(x, j * 4));
            return { object: 'embedding', index, embedding: buf.toString('base64') };
          }),
          usage: { prompt_tokens: 3 * input.length, total_tokens: 3 * input.length, cost: u.cost, cost_details: u.cost_details },
        },
      };
    }
    if (method === 'GET' && path === '/models') {
      const wanted = req.query['supported_parameters']?.split(',').filter(Boolean) ?? [];
      const kind = req.query['kind'];
      const out = req.query['output_modalities'];
      let list = MODELS;
      if (kind) list = list.filter((m) => m.kind === kind);
      else if (out === 'all') list = MODELS;
      else if (out) list = list.filter((m) => out.split(',').some((o) => m.kind === (OUTPUT_KIND[o] ?? o) || m.architecture.output_modalities.includes(o)));
      else list = list.filter((m) => m.kind === 'chat');
      return { json: { data: list.filter((m) => wanted.every((p) => m.supported_parameters.includes(p))) } };
    }
    if (method === 'GET' && path === '/providers') {
      return {
        json: {
          data: [
            { name: 'OpenAI', slug: 'openai', privacy_policy_url: 'https://openai.com/policies/privacy-policy', terms_of_service_url: null, status_page_url: null, headquarters: 'US', datacenters: null },
            { name: 'Anthropic', slug: 'anthropic', privacy_policy_url: null, terms_of_service_url: null, status_page_url: null, headquarters: 'US', datacenters: null },
          ],
        },
      };
    }
    if (method === 'GET' && path === '/key') {
      const bearer = (req.headers['authorization'] ?? '').replace(/^Bearer\s+/i, '');
      const isApiKey = bearer.startsWith('lyk-v1-');
      return {
        json: {
          data: {
            label: isApiKey ? `${bearer.slice(0, 11)}…${bearer.slice(-4)}` : 'Connected app',
            limit: 10,
            limit_reset: isApiKey ? 'none' : 'monthly',
            usage: 1.5,
            limit_remaining: 8.5,
            company: { id: 'cmp_fake', name: 'Fake Company' },
            project: { id: 'prj_fake', name: 'Fake Project' },
            ...(isApiKey ? {} : { scopes: ['models:read', 'chat', 'images', 'videos', 'speech', 'usage:read'], app: { client_id: 'https://getlykia.com/oauth/clients/lykia-mcp.json', name: 'Lykia MCP bridge (@lykia/mcp)' } }),
          },
        },
      };
    }
    if (method === 'GET' && path === '/credits') {
      if (options.billingMode === 'internal') {
        const now = new Date();
        const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
        const cost = generations.reduce((n, g) => n + g.cost, 0);
        return { json: { data: { balance: 0, total_usage: cost, reserved: 0, available: 0, billing_mode: 'internal', period_cost: cost, period_start: periodStart } } };
      }
      return { json: { data: { balance: 25, total_usage: 12.5, reserved: 0.25, available: 24.75, billing_mode: 'prepaid' } } };
    }
    if (method === 'GET' && path === '/generation') {
      const id = req.query['id'];
      if (!id) return bad('id is required');
      const g = generations.find((x) => x.id === id);
      if (g) return { json: { data: generationRecord(g) } };
      if (strict) return fakeError(404, { message: `Generation ${id} not found`, code: 'not_found' });
      return { json: { data: generationRecord({ ...syntheticGeneration(), id }) } };
    }
    if (method === 'GET' && path === '/generations') {
      let list = [...generations].reverse();
      const q = req.query;
      if (q['user']) list = list.filter((g) => g.user === q['user']);
      if (q['preset']) list = list.filter((g) => g.preset === q['preset']);
      if (q['model']) list = list.filter((g) => g.model === q['model']);
      for (const [k, v] of Object.entries(q)) if (k.startsWith('metadata.')) list = list.filter((g) => g.metadata[k.slice(9)] === v);
      if (q['after']) {
        const i = list.findIndex((g) => g.id === q['after']);
        list = i >= 0 ? list.slice(i + 1) : list;
      }
      const limit = Math.min(Math.max(Number(q['limit'] ?? 50) || 50, 1), 200);
      const page = list.slice(0, limit);
      return { json: { data: page.map(generationRecord), next_cursor: list.length > limit ? page.at(-1)!.id : null } };
    }
    if (method === 'POST' && path === '/images/generations') {
      const n = typeof body['n'] === 'number' ? body['n'] : 1;
      const cost = Math.round(0.035 * n * 1e6) / 1e6;
      const b64 = body['response_format'] === 'b64_json';
      return {
        headers: { ...presetHeaders(body['model']), 'X-Lykia-Cost': String(cost) },
        json: {
          id: generationId,
          object: 'image.generation',
          created: Math.floor(Date.now() / 1000),
          model: realModel(body['model'], 'image'),
          provider: 'recraft',
          data: Array.from({ length: n }, (_, i) =>
            b64
              ? { mime_type: 'image/png', b64_json: PNG_1X1_BASE64 }
              : { mime_type: 'image/png', ...signedUrl(`${generationId}-${i}.png`), width: 1, height: 1 },
          ),
          usage: { images: n, cost, is_byok: false, cost_details: fakeUsage({ cost }).cost_details, units: { image: n } },
        },
      };
    }
    if (method === 'POST' && path === '/videos') {
      const model = realModel(body['model'], 'video');
      const prompt = String(body['prompt'] ?? '');
      const duration = Number(body['duration'] ?? body['duration_seconds'] ?? body['seconds'] ?? 5) || 5;
      const v: Video = { id: generationId, createdAt: Date.now(), model, provider: model.split('/')[0] ?? 'bytedance', duration, fail: /#fail/.test(prompt), expired: /#expired/.test(prompt), outputUnavailable: /#output-unavailable/.test(prompt) };
      videos.set(v.id, v);
      return { headers: presetHeaders(body['model']), json: videoView(v) };
    }
    if (method === 'GET' && path === '/videos') {
      const limit = Math.min(Math.max(Number(req.query['limit'] ?? 20) || 20, 1), 100);
      let list = [...videos.values()].reverse().map(videoView);
      if (req.query['status']) list = list.filter((j) => j['status'] === req.query['status']);
      if (req.query['after']) {
        const i = list.findIndex((j) => j['id'] === req.query['after']);
        list = i >= 0 ? list.slice(i + 1) : list;
      }
      const page = list.slice(0, limit);
      return { json: { object: 'list', data: page, next_cursor: list.length > limit ? (page.at(-1)!['id'] as string) : null, has_more: list.length > limit } };
    }
    const vm = /^\/videos\/([^/]+)(\/content|\/cancel)?$/.exec(path);
    if (vm) {
      const id = decodeURIComponent(vm[1]!);
      const v = videos.get(id);
      if (!v) return fakeError(404, { message: 'Video not found', code: 'not_found' });
      const job = videoView(v);
      if (vm[2] === '/cancel' && method === 'POST') {
        if (job['status'] !== 'queued' && job['status'] !== 'in_progress') return fakeError(409, { message: `This job is already ${String(job['status'])}`, code: 'job_not_cancellable' });
        v.cancelledAt = Date.now();
        return { json: videoView(v) };
      }
      if (vm[2] === '/content' && method === 'GET') {
        if (job['status'] !== 'completed') return fakeError(409, { message: `The video is ${String(job['status'])}; content is available once it is completed`, code: 'video_not_ready' });
        const headers = { 'X-Generation-Id': v.id, 'X-Lykia-Cost': String(VIDEO_COST) };
        if (v.expired) return { ...fakeError(410, { message: 'The video file is no longer available', code: 'video_expired' }), headers };
        if (v.outputUnavailable) {
          const e = fakeError(502, { message: 'The video was generated, but its file could not be retrieved. The output has not expired (expires_at is still ahead).', code: 'video_output_unavailable', reason: 'provider_error' });
          (e.json as { error: { metadata: Record<string, unknown> } }).error.metadata['provider'] = v.provider;
          return { ...e, headers: { ...e.headers, 'X-Generation-Id': v.id } };
        }
        const signed = signedUrl(`${encodeURIComponent(v.id)}.mp4`);
        if (req.query['redirect'] === 'false') return { headers, json: { url: signed.url, expires_at: signed.expires_at, mime_type: 'video/mp4' } };
        return { status: 302, headers: { ...headers, Location: signed.url } };
      }
      if (!vm[2] && method === 'GET') return { json: job };
    }
    if (method === 'POST' && path === '/audio/speech') {
      const fmt = String(body['response_format'] ?? 'mp3');
      const types: Record<string, string> = { mp3: 'audio/mpeg', opus: 'audio/ogg', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
      if (!types[fmt]) return fakeError(400, { message: 'response_format must be one of mp3, opus, aac, flac, wav, pcm', code: 'unsupported_input', reason: 'unsupported_input', param: 'response_format' });
      const voice = speechVoice(body) ?? '';
      if (voice.startsWith('lvc_') && !voices.has(voice)) return fakeError(404, { message: `Voice ${voice} not found`, code: 'voice_not_found', param: 'voice' });
      const cost = Math.ceil(String(body['input'] ?? '').length * 80) / 1e6;
      const model = realModel(body['model'], 'speech');
      return {
        headers: { 'Content-Type': types[fmt]!, 'X-Lykia-Cost': String(cost), 'X-Lykia-Model': model, 'X-Lykia-Provider': model.split('/')[0] ?? 'elevenlabs', ...presetHeaders(body['model']) },
        body: 'ID3FAKEAUDIO',
      };
    }
    if (method === 'GET' && path === '/audio/voices') {
      const model = req.query['model'] ?? DEFAULT_MODEL.speech;
      return {
        json: {
          object: 'list',
          model,
          provider: String(model).split('/')[0] ?? 'elevenlabs',
          data: [
            { id: 'JBFqnCBsd6RMkjVDRZzb', object: 'voice', name: 'George', category: 'premade', language: 'en', description: 'Warm', labels: { accent: 'british', language: 'en' }, provider: 'elevenlabs' },
            ...[...voices.values()].filter((x) => x['model'] === model || !req.query['model']),
          ],
        },
      };
    }
    const form = (req.body ?? {}) as { fields?: Record<string, string>; files?: Array<{ field: string; size: number; contentType: string }>; order?: string[] };
    if (method === 'POST' && path === '/audio/voices') {
      if (form.fields?.['consent'] !== 'true') {
        return fakeError(400, { message: "Voice cloning requires `consent=true`: you confirm you have the speaker's permission to clone this voice", code: 'consent_required', param: 'consent' });
      }
      const name = form.fields?.['name'];
      if (!name || name.length > 100) return fakeError(400, { message: '`name` is required (at most 100 characters)', code: 'bad_request', param: 'name' });
      const files = form.files ?? [];
      if (files.length === 0 || files.length > 25) return fakeError(400, { message: '1–25 audio files are required', code: 'bad_request', param: 'file' });
      for (const f of files) {
        if (f.size > 10 * 1024 * 1024) return fakeError(413, { message: 'Each sample may be at most 10 MB', code: 'payload_too_large', param: 'file' });
        if (f.contentType && !f.contentType.startsWith('audio/') && f.contentType !== 'application/octet-stream') {
          return fakeError(400, { message: 'Voice samples must be audio files', code: 'unsupported_input', reason: 'unsupported_input', param: 'file' });
        }
      }
      let id = 'lvc_';
      while (id.length < 24) id += 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)];
      const voice = { id, object: 'voice', name, category: 'cloned', provider: 'elevenlabs', model: form.fields?.['model'] ?? DEFAULT_MODEL.speech, created_at: Math.floor(Date.now() / 1000), requires_verification: false };
      voices.set(id, voice);
      return { status: 201, json: voice };
    }
    const vd = /^\/audio\/voices\/([^/]+)$/.exec(path);
    if (method === 'DELETE' && vd) {
      const id = decodeURIComponent(vd[1]!);
      if (!voices.delete(id)) return fakeError(404, { message: `Voice ${id} not found`, code: 'voice_not_found' });
      return { json: { id, object: 'voice', deleted: true } };
    }
    if (method === 'POST' && path === '/audio/transcriptions') {
      // Multipart order like the gateway: once `model` and the file are known the upload streams; text fields after the
      // file cannot be applied then (X-Lykia-Ignored-Fields). A file before `model` is spooled to a temp file instead.
      const order = form.order ?? [];
      const fileAt = order.indexOf('file');
      const modelAt = order.indexOf('model');
      const headers: Record<string, string> = { ...presetHeaders(form.fields?.['model']) };
      const ignored = fileAt >= 0 && modelAt >= 0 && modelAt < fileAt ? order.slice(fileAt + 1).filter((f) => f !== 'file') : [];
      if (ignored.length) headers['X-Lykia-Ignored-Fields'] = [...new Set(ignored)].join(',');
      if (fileAt >= 0 && (modelAt < 0 || modelAt > fileAt)) req.notes.push('"file" came before "model": the gateway spools the upload to a temporary file instead of streaming it (send the file last)');
      const applied = (k: string) => (ignored.includes(k) ? undefined : form.fields?.[k]);
      const seconds = Math.max(1, Math.round(((form.files?.[0]?.size ?? 0) / 2000) * 10) / 10);
      const cost = Math.round(seconds * 0.0000167 * 1e6) / 1e6;
      headers['X-Lykia-Cost'] = String(cost);
      const fmt = applied('response_format') ?? 'json';
      if (fmt === 'srt' || fmt === 'vtt' || fmt === 'text') {
        return { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' }, body: fmt === 'text' ? 'merhaba dünya' : '1\n00:00:00,000 --> 00:00:01,000\nmerhaba dünya\n' };
      }
      return {
        headers,
        json: {
          text: 'merhaba dünya',
          ...(fmt === 'verbose_json' ? { language: applied('language') ?? 'tr', duration: seconds, segments: [{ id: 0, start: 0, end: seconds, text: 'merhaba dünya' }] } : {}),
          usage: { cost, is_byok: false, cost_details: fakeUsage({ cost }).cost_details },
        },
      };
    }
    return fakeError(404, { message: `Unknown endpoint ${method} ${path}`, code: 'not_found' });
  };

  const serveFile = (path: string, res: ServerResponse) => {
    if (path.startsWith('/fake-files/signed/') && /\.mp4$/.test(path)) {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'X-Saw-Authorization': 'no' });
      res.end('FAKEVIDEO');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(Buffer.from(PNG_1X1_BASE64, 'base64'));
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', origin);
        const path = url.pathname.replace(/^\/v1(?=\/|$)/, '') || '/';
        if (path.startsWith('/fake-files/')) {
          if (req.headers.authorization) res.setHeader('X-Saw-Authorization', 'yes');
          return serveFile(path, res);
        }
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(', ') : v;
        const fakeReq: FakeRequest = {
          method: (req.method ?? 'GET').toUpperCase(),
          path,
          query: parseQuery(url),
          headers,
          body: await parseBody(req, raw, origin).catch(() => raw.toString('utf8')),
          rawBody: raw.toString('utf8'),
          generationId: newGenerationId(),
          violations: [],
          notes: [],
        };
        requests.push(fakeReq);
        try {
          const idx = queue.findIndex((q) => routeMatches(q.route, fakeReq.method, fakeReq.path));
          let response: FakeResponse | undefined;
          if (!authorized(fakeReq.headers['authorization']) && (strict || idx < 0)) {
            response = fakeReq.headers['authorization']
              ? fakeError(401, { message: 'Invalid API key', code: 'invalid_api_key', reason: 'unauthorized' })
              : fakeError(401, { message: 'Missing API key. Send it as: Authorization: Bearer <key>', code: 'missing_api_key', reason: 'unauthorized' });
          } else if (strict) {
            response = validate(fakeReq);
          }
          if (!response && idx >= 0) {
            const handler = queue.splice(idx, 1)[0]!.handler;
            response = typeof handler === 'function' ? await handler(fakeReq) : handler;
          }
          response ??= defaults(fakeReq);
          const cost = sentCost(response);
          record(fakeReq, response.status ?? 200, { streamed: Boolean(response.stream), ...(cost !== undefined ? { cost } : {}) });
          await send(req, res, response, fakeReq.generationId);
        } catch (err) {
          await send(req, res, fakeError(500, { message: `Fake handler failed: ${(err as Error).message}` }), fakeReq.generationId);
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: `${origin}/v1`,
    origin,
    port,
    requests,
    generations,
    enqueue(route, response) {
      queue.push({ route, handler: response });
    },
    reset() {
      queue.length = 0;
      requests.length = 0;
      generations.length = 0;
      videos.clear();
      voices.clear();
    },
    close() {
      return new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}

/**
 * The cost a response tells the client: `X-Lykia-Cost`, else `usage.cost` of a JSON body, else `usage.cost` of the
 * last stream event that has one. The generation record stores exactly this, so `fake.generations` agrees with what
 * the client saw.
 */
function sentCost(response: FakeResponse): number | undefined {
  for (const [k, v] of Object.entries(response.headers ?? {})) {
    if (k.toLowerCase() === 'x-lykia-cost') {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  const usageCost = (value: unknown): number | undefined => {
    let v = value;
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        return undefined;
      }
    }
    const c = (v as { usage?: { cost?: unknown } } | null | undefined)?.usage?.cost;
    return typeof c === 'number' ? c : undefined;
  };
  const fromJson = usageCost(response.json);
  if (fromJson !== undefined) return fromJson;
  for (const event of [...(response.stream ?? [])].reverse()) {
    const c = usageCost(event);
    if (c !== undefined) return c;
  }
  return undefined;
}

function syntheticGeneration(): FakeGeneration {
  return {
    id: '',
    created_at: '2026-11-23T00:00:00.000Z',
    endpoint: '/chat/completions',
    model: 'openai/gpt-4o-mini',
    preset: null,
    user: null,
    metadata: {},
    streamed: false,
    status: 'ok',
    http_status: 200,
    cost: 0.000123,
    kind: 'chat',
  };
}

function generationRecord(g: FakeGeneration) {
  const ok = g.status === 'ok';
  return {
    id: g.id,
    created_at: g.created_at,
    model: g.model,
    model_resolved: g.model,
    provider: g.model.split('/')[0] ?? 'openai',
    streamed: g.streamed,
    usage_type: 'credits',
    status: g.status,
    finish_reason: g.kind === 'chat' ? (ok ? 'stop' : 'error') : null,
    tokens: g.kind === 'chat' || g.kind === 'embedding' ? { prompt: 12, completion: ok && g.kind === 'chat' ? 5 : 0, reasoning: 0, cache_read: 0, cache_write: 0 } : { prompt: 0, completion: 0, reasoning: 0, cache_read: 0, cache_write: 0 },
    cost: g.cost,
    cost_details: fakeUsage({ cost: g.cost }).cost_details,
    list_cost: g.cost,
    byok_fee: 0,
    latency_ms: 420,
    ttft_ms: g.streamed ? 120 : null,
    attempts: [{ provider: g.model.split('/')[0] ?? 'openai', status: ok ? 'ok' : 'error', latency_ms: 420, error: null }],
    app: { referer: null, title: null },
    user: g.user,
    endpoint: g.endpoint,
    preset: g.preset,
    metadata: g.metadata,
    kind: g.kind,
    ...(g.kind === 'chat' || g.kind === 'embedding'
      ? {}
      : { media: { units: g.kind === 'image' ? { image: 1 } : g.kind === 'video' ? { tokens: 108000 } : {}, units_estimated: false, billed_by_provider: false, job_id: g.id, outputs: g.status === 'ok' ? 1 : 0 } }),
  };
}
