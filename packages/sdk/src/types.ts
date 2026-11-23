import type { ResponseMeta } from './core.js';

/**
 * Request and response types for the Lykia `/v1` API.
 *
 * Field names follow the wire format (`snake_case`). Money fields are USD decimals. New fields may appear
 * in responses at any time; every object type allows unknown extra fields.
 */

/* ----------------------------------------------------------------------------------------------- *
 * Shared
 * ----------------------------------------------------------------------------------------------- */

/**
 * A model id in `author/model` form (e.g. `openai/gpt-4o-mini`) or a preset reference `@name`
 * (e.g. `@text`; see the `preset()` helper). Any string is accepted.
 */
export type ModelId = string;

/**
 * Request tags accepted by every generation endpoint. They are stored with the request record for
 * usage breakdowns and are never sent to the provider.
 */
export interface RequestTags {
  /** Your end user or tenant id (≤ 128 characters). Send a pseudonymous id, not personal data. */
  user?: string;
  /** Up to 16 keys (≤ 64 characters each); values are strings (≤ 512 characters). */
  metadata?: Record<string, string>;
}

/** Cost breakdown returned with `usage.cost`. */
export interface CostDetails {
  upstream_cost?: number;
  platform_fee?: number;
  is_byok?: boolean;
  [key: string]: unknown;
}

/* ----------------------------------------------------------------------------------------------- *
 * Chat completions
 * ----------------------------------------------------------------------------------------------- */

export type ChatRole = 'system' | 'developer' | 'user' | 'assistant' | 'tool';

/** Prompt-cache marker: passed to Anthropic as is; ignored (not an error) by providers that do not know it. */
export interface CacheControl {
  type: 'ephemeral';
  /** e.g. `5m`, `1h`. */
  ttl?: string;
}

export interface TextContentPart {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

export interface ImageContentPart {
  type: 'image_url';
  image_url: { url: string; detail?: 'auto' | 'low' | 'high' };
  cache_control?: CacheControl;
}

export interface InputAudioContentPart {
  type: 'input_audio';
  input_audio: { data: string; format: string };
}

/** PDF or image file input (at most 8 per request). `file_data` is a `data:<mime>;base64,…` URI. */
export interface FileContentPart {
  type: 'file';
  file: { filename: string; file_data: string };
  cache_control?: CacheControl;
}

export type ContentPart = TextContentPart | ImageContentPart | InputAudioContentPart | FileContentPart;

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * One opaque reasoning block (provider specific). Send assistant messages back with `reasoning_details` unchanged
 * in the next turn of a tool loop; Lykia turns them back into the provider's native (signed) thinking blocks.
 */
export interface ReasoningDetail {
  type: string;
  id?: string | null;
  index?: number;
  format?: string;
  text?: string;
  signature?: string | null;
  data?: string;
  summary?: string;
  [key: string]: unknown;
}

export interface ChatMessage {
  role: ChatRole;
  /** Text, or an array of parts (text, images, files, audio). Optional on assistant messages that only carry `tool_calls`. */
  content?: string | ContentPart[] | null;
  name?: string;
  /** Assistant messages: tool calls requested in an earlier turn, sent back unchanged. */
  tool_calls?: ToolCall[];
  /** Assistant messages: reasoning text from an earlier turn. */
  reasoning?: string | null;
  /** Assistant messages: opaque reasoning blocks from an earlier turn, sent back unchanged. */
  reasoning_details?: ReasoningDetail[];
  /** System messages given as a string can carry a cache marker too. */
  cache_control?: CacheControl;
  /** Tool messages: id of the tool call whose result this is. */
  tool_call_id?: string;
  [key: string]: unknown;
}

export interface FunctionTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown>; strict?: boolean };
}

export type ToolChoice = 'none' | 'auto' | 'required' | { type: 'function'; function: { name: string } };

export type ResponseFormat =
  | { type: 'text' }
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema?: Record<string, unknown>; description?: string } };

export interface ReasoningOptions {
  effort?: 'low' | 'medium' | 'high' | (string & {});
  max_tokens?: number;
  enabled?: boolean;
  exclude?: boolean;
  [key: string]: unknown;
}

/** Lykia provider routing preferences. */
export interface ProviderPreferences {
  /** Providers to try first, in this order. */
  order?: string[];
  /** Use these providers and no others. */
  only?: string[];
  /** Never use these providers. */
  ignore?: string[];
  /** Only `price` (all candidates by list price, then `order`); other values → 400 `unsupported_sort`. */
  sort?: 'price';
  /** Defaults to `true`. */
  allow_fallbacks?: boolean;
}

export interface ChatCompletionCreateParamsBase extends RequestTags {
  /** Model id (`author/model`) or preset (`@text`). Required unless the project has a default model. */
  model?: ModelId;
  messages: ChatMessage[];
  /** Lykia: fallback models tried in order after `model`. */
  models?: string[];
  /** Lykia: provider routing preferences. */
  provider?: ProviderPreferences;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  repetition_penalty?: number;
  stop?: string | string[];
  seed?: number;
  tools?: FunctionTool[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  response_format?: ResponseFormat;
  logprobs?: boolean;
  top_logprobs?: number;
  logit_bias?: Record<string, number>;
  /** Thinking: `{ effort: 'low' | 'medium' | 'high' }`, `{ max_tokens }` or `{ enabled: false }`. */
  reasoning?: ReasoningOptions;
  reasoning_effort?: string;
  stream_options?: { include_usage?: boolean };
  /** OpenAI prompt-cache routing key; forwarded to OpenAI only (it changes cache hits, not price). */
  prompt_cache_key?: string;
  /**
   * Prompt caching: `auto` lets Lykia turn on the provider's automatic cache where it needs explicit breakpoints
   * (Anthropic) and the request has no `cache_control` markers; `off` (default) leaves it to your markers.
   */
  cache?: 'auto' | 'off';
  /** Accepted, but the gateway always sends `store: false`: providers never keep your requests. */
  store?: boolean;
  /** Web search on models that have a web-search price (else 400 `unsupported_input`); results in `message.annotations`. */
  web_search_options?: Record<string, unknown>;
  /** Other fields are passed through to the provider (see the API reference for what reaches it). */
  [key: string]: unknown;
}

export interface ChatCompletionCreateParamsNonStreaming extends ChatCompletionCreateParamsBase {
  stream?: false | null;
}

export interface ChatCompletionCreateParamsStreaming extends ChatCompletionCreateParamsBase {
  stream: true;
}

export type ChatCompletionCreateParams = ChatCompletionCreateParamsNonStreaming | ChatCompletionCreateParamsStreaming;

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** What the request cost, USD (the amount charged to you). `0` for requests sent with your own provider key. */
  cost?: number;
  /** Breakdown of `cost`. */
  cost_details?: CostDetails;
  is_byok?: boolean;
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  [key: string]: unknown;
}

export interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
  /** The model's reasoning text, when the provider returns it. */
  reasoning?: string | null;
  /** Opaque reasoning blocks; send back unchanged in the next turn. */
  reasoning_details?: ReasoningDetail[];
  refusal?: string | null;
  [key: string]: unknown;
}

export interface ChatCompletionChoice {
  index: number;
  message: AssistantMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | (string & {}) | null;
  logprobs?: unknown;
  [key: string]: unknown;
}

export interface ChatCompletion {
  /** `gen-<time>-<random>`; same as the `X-Generation-Id` header. */
  id: string;
  object: 'chat.completion';
  created: number;
  /** Model that actually served the request (differs from the requested one after a fallback). */
  model: string;
  /** Provider id the request was sent to (e.g. `openai`, `anthropic`). */
  provider?: string;
  choices: ChatCompletionChoice[];
  usage?: Usage;
  /** Added by the SDK from the response headers. */
  _meta: ResponseMeta;
  [key: string]: unknown;
}

export interface ChatCompletionChunkDelta {
  role?: 'assistant';
  content?: string | null;
  reasoning?: string | null;
  reasoning_details?: ReasoningDetail[];
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: 'function';
    function?: { name?: string; arguments?: string };
  }>;
  [key: string]: unknown;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  provider?: string;
  choices: Array<{
    index: number;
    delta: ChatCompletionChunkDelta;
    finish_reason: string | null;
    [key: string]: unknown;
  }>;
  /** Only in the final data chunk (whose `choices` is empty). */
  usage?: Usage;
  /** Only when the provider failed after the stream started (the SDK throws a `LykiaError`). */
  error?: { message: string; type?: string; code?: string; status?: number; metadata?: Record<string, unknown> };
  [key: string]: unknown;
}

/* ----------------------------------------------------------------------------------------------- *
 * Catalog, key, credits, generation
 * ----------------------------------------------------------------------------------------------- */

export interface Model {
  id: string;
  canonical_slug?: string;
  hugging_face_id?: string | null;
  name: string;
  created?: number;
  description?: string;
  context_length?: number | null;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    tokenizer?: string;
    [key: string]: unknown;
  };
  /** Only the defined price units, as USD decimal strings. */
  pricing?: Record<string, string>;
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null; [key: string]: unknown };
  supported_parameters?: string[];
  expiration_date?: string | null;
  /** `chat`, `embedding`, `image`, `video`, `speech` or `transcription`. */
  kind?: ModelKind;
  is_free?: boolean;
  /** Media models: capabilities, pricing and providers. */
  media?: ModelMedia;
  [key: string]: unknown;
}

export interface ModelList {
  data: Model[];
}

export type ModelKind = 'chat' | 'embedding' | 'image' | 'video' | 'speech' | 'transcription' | (string & {});

export interface ModelMedia {
  kind: ModelKind;
  /** Sizes, aspect ratios, resolutions, durations, formats, limits, `provider_options` allow-list … (model specific). */
  capabilities: Record<string, unknown>;
  pricing: {
    /** `per_image`, `per_megapixel`, `per_second`, `per_minute`, `per_video`, `per_character`, `per_token`. */
    unit: string;
    quantity?: number;
    tiers: Array<{ when: Record<string, unknown>; usd: string }>;
    surcharges?: Array<{ when: Record<string, unknown>; usd: string; per: string }>;
    note?: string;
  };
  providers: string[];
  [key: string]: unknown;
}

export interface ModelListParams {
  /** Media models: `image`, `video`, `speech` or `transcription` (the default list holds chat models). */
  kind?: 'image' | 'video' | 'speech' | 'transcription' | (string & {});
  /** e.g. `embedding`, `image`, `video`, `audio`, `transcription` or `all`. */
  output_modalities?: string;
  /** Only models that support all of these parameters. */
  supported_parameters?: string[] | string;
}

export interface Provider {
  name: string;
  slug: string;
  privacy_policy_url?: string | null;
  terms_of_service_url?: string | null;
  status_page_url?: string | null;
  headquarters?: string | null;
  datacenters?: string[] | null;
  [key: string]: unknown;
}

export interface ProviderList {
  data: Provider[];
}

/** `GET /key`: the key used for the request. */
export interface KeyInfo {
  label: string;
  /** USD, or `null` for no limit. */
  limit: number | null;
  /** e.g. `none`, `monthly`. */
  limit_reset?: string | null;
  /** Usage in the current window, USD. */
  usage: number;
  /** USD, or `null` for no limit. */
  limit_remaining: number | null;
  /** The company the credential belongs to. */
  company?: { id: string; name: string };
  /** The project the credential belongs to (where spending is recorded). */
  project?: { id: string; name: string };
  /** OAuth access tokens only: the granted scopes. */
  scopes?: string[];
  /** OAuth access tokens only: the connected app. */
  app?: { client_id: string; name: string };
  [key: string]: unknown;
}

/** `GET /credits`: company balance (USD). */
export interface Credits {
  balance: number;
  total_usage: number;
  /** Held by in-flight requests. */
  reserved?: number;
  /** `balance − reserved`: what a new request can use. */
  available?: number;
  /** `internal` for internal-use companies (no balance checks; cost is still tracked). */
  billing_mode?: 'prepaid' | 'internal' | (string & {});
  /** Internal mode: cost of the current period, USD. */
  period_cost?: number;
  /** Internal mode: start of the current period (ISO date). */
  period_start?: string;
  [key: string]: unknown;
}

/** `GET /generation?id=`: the record of one request. */
export interface Generation {
  id: string;
  created_at: string;
  model: string;
  model_resolved?: string;
  provider?: string;
  streamed?: boolean;
  usage_type?: 'credits' | 'byok' | 'free' | 'internal' | (string & {});
  /** `chat`, `embedding`, `image`, `video`, `speech`, `transcription` or `voice`. */
  kind?: string;
  /** e.g. `chat.completions`, `embeddings`, `images.generations`, `videos`, `audio.speech`. */
  endpoint?: string;
  /** Media records only. */
  media?: { units: Record<string, number>; units_estimated: boolean; billed_by_provider: boolean; job_id: string | null; outputs: number; [key: string]: unknown } | null;
  status?: 'ok' | 'error' | 'cancelled' | (string & {});
  finish_reason?: string | null;
  tokens?: { prompt?: number; completion?: number; reasoning?: number; cache_read?: number; cache_write?: number };
  cost?: number;
  list_cost?: number;
  byok_fee?: number;
  latency_ms?: number;
  ttft_ms?: number | null;
  attempts?: Array<{ provider: string; status: string; latency_ms?: number; error?: string | null }>;
  app?: { referer?: string | null; title?: string | null };
  user?: string | null;
  metadata?: Record<string, string> | null;
  /** Preset name when the request used `@name`. */
  preset?: string | null;
  cost_details?: CostDetails;
  [key: string]: unknown;
}

/* ----------------------------------------------------------------------------------------------- *
 * Embeddings
 * ----------------------------------------------------------------------------------------------- */

/** `POST /embeddings` (OpenAI compatible). */
export interface EmbeddingCreateParams extends RequestTags {
  model: ModelId;
  /** Text or array of texts (at most 2048 items). */
  input: string | string[];
  dimensions?: number;
  encoding_format?: 'float' | 'base64';
  [key: string]: unknown;
}

export interface Embedding {
  object: 'embedding';
  index: number;
  /** Numbers, or a base64 string with `encoding_format: "base64"`. */
  embedding: number[] | string;
}

export interface CreateEmbeddingResponse {
  object: 'list';
  data: Embedding[];
  model: string;
  _meta: ResponseMeta;
  usage?: { prompt_tokens: number; total_tokens: number; cost?: number; cost_details?: CostDetails; [key: string]: unknown };
  [key: string]: unknown;
}

/** `GET /generations` filters. */
export interface GenerationListParams {
  /** Page size. */
  limit?: number;
  /** Cursor: return records after this one (from `next_cursor`). */
  after?: string;
  /** ISO date-time bounds. */
  from?: string;
  to?: string;
  /** Filter by `user` tag. */
  user?: string;
  /** Filter by preset name. */
  preset?: string;
  model?: string;
  /** `metadata.<key>=<value>` filters. */
  metadata?: Record<string, string>;
  [key: string]: string | number | boolean | Record<string, string> | undefined;
}

export interface GenerationList {
  data: Generation[];
  next_cursor?: string | null;
  [key: string]: unknown;
}
