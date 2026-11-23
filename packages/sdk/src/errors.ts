/**
 * The one error class of the SDK.
 *
 * Lykia error bodies: `{ "error": { "message", "type", "code", "metadata": { "reason", "provider"?, "retry_after"? } } }`
 * plus an `X-Generation-Id` header. {@link LykiaError} exposes the HTTP status, the string `code`, the stable
 * `reason`, whether retrying makes sense, `retryAfter`, the generation id and the parsed body.
 */

/** Stable failure reasons (`error.metadata.reason`). */
export type LykiaErrorReason =
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'context_length_exceeded'
  | 'content_policy'
  | 'rate_limited'
  | 'overloaded'
  | 'timeout'
  | 'provider_auth'
  | 'provider_error'
  | 'no_provider'
  | 'insufficient_credits'
  | 'limit_exceeded'
  | 'unsupported_input'
  | (string & {});

const RETRYABLE_REASONS = new Set(['rate_limited', 'overloaded', 'timeout', 'provider_error']);

export interface LykiaErrorInit {
  status: number;
  code: string;
  reason?: LykiaErrorReason | undefined;
  retryable?: boolean;
  generationId?: string | undefined;
  body?: unknown;
  /** Seconds to wait before retrying, when the server said so. */
  retryAfter?: number | undefined;
  provider?: string | undefined;
  /** `error.type` (`invalid_request_error`, `authentication_error`, …). */
  type?: string | undefined;
  /** `error.metadata`: the whole object as sent. */
  metadata?: Record<string, unknown> | undefined;
  cause?: unknown;
}

export class LykiaError extends Error {
  /** HTTP status; `0` when no HTTP response was received (network failure, timeout, abort, local misuse). */
  readonly status: number;
  /**
   * Machine-readable code: `error.code` from the body when it is a string; otherwise derived from the status
   * (`bad_request`, `unauthorized`, `insufficient_credits`, `forbidden`, `not_found`, `request_timeout`,
   * `payload_too_large`, `rate_limited`, `provider_error`, `service_unavailable`, `server_error`).
   * Without an HTTP response: `network_error`, `timeout`, `aborted`, `invalid_request`.
   */
  readonly code: string;
  /** `error.metadata.reason`: the stable failure class (see {@link LykiaErrorReason}). */
  readonly reason: LykiaErrorReason | undefined;
  /** True for reasons `rate_limited | overloaded | timeout | provider_error` and for network errors and timeouts. */
  readonly retryable: boolean;
  /** `X-Generation-Id` of the failed request, when known. */
  readonly generationId: string | undefined;
  /** Parsed response body (or the stream error chunk / failed job), when there was one. */
  readonly body: unknown;
  /** Seconds from `error.metadata.retry_after` or the `Retry-After` header. */
  readonly retryAfter: number | undefined;
  /** `error.metadata.provider`, when the failure came from a provider. */
  readonly provider: string | undefined;
  /** `error.type`: `invalid_request_error`, `authentication_error`, `permission_error`, `rate_limit_error`, `provider_error`, `server_error`. */
  readonly type: string | undefined;
  /** `error.metadata` as sent (`reason`, `param`, `provider_code`, `billed_by_provider`, `cost`, `retry_after`, …). */
  readonly metadata: Record<string, unknown> | undefined;
  /** `error.metadata.param`: the request field that was rejected (e.g. `n`, `provider_options.strength`). */
  get param(): string | undefined {
    return typeof this.metadata?.['param'] === 'string' ? (this.metadata['param'] as string) : undefined;
  }
  /** `error.metadata.provider_code`: the provider's own error code, when known. */
  get providerCode(): string | undefined {
    return typeof this.metadata?.['provider_code'] === 'string' ? (this.metadata['provider_code'] as string) : undefined;
  }
  /** `error.metadata.billed_by_provider`: the provider charged for the failed request (e.g. a content rejection). */
  get billedByProvider(): boolean {
    return this.metadata?.['billed_by_provider'] === true;
  }
  /** `error.metadata.cost`: what the failed request cost (USD), when it was billed. */
  get cost(): number | undefined {
    return typeof this.metadata?.['cost'] === 'number' ? (this.metadata['cost'] as number) : undefined;
  }

  constructor(message: string, init: LykiaErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'LykiaError';
    this.status = init.status;
    this.code = init.code;
    this.reason = init.reason;
    this.retryable = init.retryable ?? (init.reason !== undefined ? RETRYABLE_REASONS.has(init.reason) : false);
    this.generationId = init.generationId;
    this.body = init.body;
    this.retryAfter = init.retryAfter;
    this.provider = init.provider;
    this.type = init.type;
    this.metadata = init.metadata;
  }
}

export function isRetryableReason(reason: string | undefined): boolean {
  return reason !== undefined && RETRYABLE_REASONS.has(reason);
}

/**
 * Fallback `code` for an error body that carries no string code, by HTTP status. The fake server
 * (`@lykia/sdk/testing`) uses the same table for `fakeError()` defaults.
 *
 * | Status | Code | | Status | Code |
 * |---|---|---|---|---|
 * | 400 | `bad_request` | | 413 | `payload_too_large` |
 * | 401 | `unauthorized` | | 429 | `rate_limited` |
 * | 402 | `insufficient_credits` | | 500 | `server_error` |
 * | 403 | `forbidden` | | 502 | `provider_error` |
 * | 404 | `not_found` | | 503 | `no_provider` |
 * | 408 | `request_timeout` | | 504 | `gateway_timeout` |
 * | 409 | `conflict` | | 410 | `gone` |
 *
 * Any other 5xx → `server_error`, any other 4xx → `http_error`.
 */
export const ERROR_CODE_BY_STATUS: Readonly<Record<number, string>> = Object.freeze({
  400: 'bad_request',
  401: 'unauthorized',
  402: 'insufficient_credits',
  403: 'forbidden',
  404: 'not_found',
  408: 'request_timeout',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  429: 'rate_limited',
  500: 'server_error',
  502: 'provider_error',
  503: 'no_provider',
  504: 'gateway_timeout',
});

export function codeForStatus(status: number): string {
  return ERROR_CODE_BY_STATUS[status] ?? (status >= 500 ? 'server_error' : 'http_error');
}

/** Fallback reason when the body carries none (older or non-Lykia responses). */
export function reasonForStatus(status: number): LykiaErrorReason | undefined {
  switch (status) {
    case 400:
    case 413:
      return 'invalid_request';
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 402:
      return 'insufficient_credits';
    case 408:
      return 'timeout';
    case 429:
      return 'rate_limited';
    case 502:
      return 'provider_error';
    case 503:
      return 'no_provider';
    default:
      return status >= 500 ? 'provider_error' : undefined;
  }
}

export interface ParsedErrorBody {
  metadata?: Record<string, unknown>;
  message?: string;
  code?: string;
  /** `error.status`, or a numeric `error.code` sent by older servers. */
  status?: number;
  type?: string;
  reason?: string;
  provider?: string;
  retryAfter?: number;
}

export function parseErrorBody(body: unknown): ParsedErrorBody {
  if (!body || typeof body !== 'object') return {};
  const err = (body as { error?: unknown }).error;
  if (!err || typeof err !== 'object') return {};
  const e = err as Record<string, unknown>;
  const meta = e['metadata'] && typeof e['metadata'] === 'object' ? (e['metadata'] as Record<string, unknown>) : {};
  const retryAfter = Number(meta['retry_after']);
  // §14.1: `code` is a string; the HTTP status is `status`. A numeric `code` (older servers) is read as the status.
  const numericCode = typeof e['code'] === 'number' ? e['code'] : typeof e['code'] === 'string' && /^\d{3}$/.test(e['code']) ? Number(e['code']) : undefined;
  const status = typeof e['status'] === 'number' ? e['status'] : numericCode;
  return {
    ...(typeof e['message'] === 'string' ? { message: e['message'] } : {}),
    ...(typeof e['code'] === 'string' && e['code'] && numericCode === undefined ? { code: e['code'] } : {}),
    ...(status !== undefined && Number.isFinite(status) ? { status } : {}),
    ...(typeof e['type'] === 'string' ? { type: e['type'] } : {}),
    ...(e['metadata'] && typeof e['metadata'] === 'object' ? { metadata: meta } : {}),
    ...(typeof meta['reason'] === 'string' ? { reason: meta['reason'] } : {}),
    ...(typeof meta['provider'] === 'string' ? { provider: meta['provider'] } : {}),
    ...(meta['retry_after'] !== undefined && Number.isFinite(retryAfter) ? { retryAfter } : {}),
  };
}

export function httpError(status: number, body: unknown, rawText: string | undefined, headers: Headers): LykiaError {
  const parsed = parseErrorBody(body);
  const message = parsed.message ?? (rawText ? rawText.slice(0, 500) : `Request failed with status ${status}`);
  const reason = parsed.reason ?? reasonForStatus(status);
  return new LykiaError(`${status} ${message}`, {
    status,
    code: parsed.code ?? codeForStatus(status),
    reason,
    retryable: isRetryableReason(reason),
    generationId: headers.get('x-generation-id') ?? undefined,
    body: body ?? rawText,
    retryAfter: parsed.retryAfter ?? parseRetryAfter(headers.get('retry-after')),
    provider: parsed.provider,
    type: parsed.type,
    metadata: parsed.metadata,
  });
}

/** Parses `Retry-After` (seconds or HTTP date) into seconds. */
export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, (date - Date.now()) / 1000);
}

/**
 * The error carried by a mid-stream chunk (`{ error: { message, type, code, status, metadata } }`, sent with HTTP 200
 * after the stream started). The status is `error.status` (a numeric `code` from older servers is read the same way).
 */
export function streamChunkError(chunk: { error?: unknown }, generationId: string | undefined): LykiaError {
  const parsed = parseErrorBody({ error: chunk.error });
  const status = parsed.status !== undefined && parsed.status >= 400 ? parsed.status : 200;
  const reason = parsed.reason ?? reasonForStatus(status) ?? 'provider_error';
  return new LykiaError(parsed.message ?? 'The stream failed after it started', {
    status,
    code: parsed.code ?? (status >= 400 ? codeForStatus(status) : 'stream_error'),
    reason,
    retryable: isRetryableReason(reason),
    generationId,
    body: chunk,
    retryAfter: parsed.retryAfter,
    provider: parsed.provider,
    type: parsed.type,
    metadata: parsed.metadata,
  });
}

export const invalidRequest = (message: string) =>
  new LykiaError(message, { status: 0, code: 'invalid_request', reason: 'invalid_request', retryable: false });
