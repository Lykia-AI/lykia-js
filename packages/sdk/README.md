# @lykia/sdk

TypeScript client for the [Lykia](https://getlykia.com) API. **One Key. Every AI.** One API key, prepaid USD credits,
many AI providers behind an OpenAI-compatible `/v1` API.

- No runtime dependencies; uses the global `fetch` (Node.js ≥ 20, modern browsers, edge runtimes).
- ESM and CommonJS builds with type declarations.
- A single-file CommonJS build you can copy into a project without npm ([below](#vendoring-without-npm)).
- A fake Lykia server for your tests (`@lykia/sdk/testing`).

```sh
npm install @lykia/sdk
```

## Quick start

```ts
import { Lykia } from '@lykia/sdk';

const lykia = new Lykia({ apiKey: process.env.LYKIA_API_KEY }); // lyk-v1-…

const res = await lykia.chat.completions.create({
  model: 'openai/gpt-4o-mini', // or a preset: '@text'
  messages: [{ role: 'user', content: 'Merhaba!' }],
});
console.log(res.choices[0].message.content);
console.log(res.usage?.cost, res._meta.generationId); // USD cost, request id
```

Options: `new Lykia({ apiKey, baseURL = 'https://api.getlykia.com/v1', timeoutMs = 60000, fetch?, defaultHeaders?, maxRetries = 0 })`.
Every method takes per-call options `{ timeoutMs, signal, headers }` as its last argument.
`defaultHeaders` is the place for the attribution headers `HTTP-Referer` and `X-Title`.

## Streaming

`chat.completions.stream()` returns an async iterable of simple events, and `.final()` with the assembled message:

```ts
const stream = lykia.chat.completions.stream({ model: '@assistant', messages, tools });

for await (const event of stream) {
  if (event.type === 'text') process.stdout.write(event.delta);
  if (event.type === 'reasoning') {/* thinking text */}
  if (event.type === 'tool_call') {/* event.index, event.id, event.name, event.argumentsDelta */}
  if (event.type === 'done') {/* event.message, event.usage, event.finishReason, event.generationId, event.model, event.provider, event.preset */}
}
// or, without iterating:
const { message, usage, finishReason, model, provider, preset } = await lykia.chat.completions.stream(body).final();
```

`model` and `provider` are the ones that actually served the request (read from the stream chunks; with `@text` the
model is the concrete model the preset resolved to, or the fallback that answered). `preset` is the preset name from
`X-Lykia-Preset` (`undefined` without a preset). Write `model` into a usage ledger, not the preset name.

`message.tool_calls` carries complete argument strings. `message.reasoning_details` is an opaque array: in a tool loop,
send the assistant message back **unchanged** in the next turn so the provider can continue its signed thinking.

## Presets, tags and cost

- **Presets.** `model: '@text'` (or `preset('text')`, which validates the name) uses the model, fallbacks and defaults
  configured for your company or project. The response's `model` is the real model; `_meta.preset` is the preset name
  (from the `X-Lykia-Preset` header). `PRESETS` lists the suggested names (`text`, `fast`, `reasoning`, `vision`,
  `image`, `video`, `embedding`, `tts`, `stt`, `assistant`, `writer`, `translate`, `search`); `PRESET_MODALITY` says
  which kind of endpoint each is meant for.
- **Tags.** Every generation method accepts `user` (your end user or tenant id, ≤ 128 characters) and `metadata`
  (≤ 16 keys, key ≤ 64, string values ≤ 512). They are stored with the request record for usage breakdowns and are
  never sent to the provider. `sanitizeTags({ user, metadata })` fits arbitrary input to these limits without
  throwing and returns `{ user, metadata, warnings, dropped? }`.
  Look records up with `generations.get(id)` and `generations.list({ user, preset, metadata: { tenant: 't1' } })`.
- **Thinking.** `_meta.reasoningDropped` is `true` when Lykia turned thinking off for a request because an assistant
  message came back without its `reasoning_details` (`X-Lykia-Reasoning: dropped`).
- **Cost.** `usage.cost` (USD charged) and `usage.cost_details { upstream_cost, platform_fee, is_byok }` come with every
  generation (in the final stream event too). Binary and media responses also carry `X-Lykia-Cost`, exposed as
  `_meta.cost` (and `cost` on binary results). `_meta.maxTokensApplied` shows when Lykia set or lowered the output limit.
- **Routing.** `provider: { order, only, ignore, allow_fallbacks, sort: 'price' }`: `sort` accepts only `"price"`
  (anything else is 400 `unsupported_sort`). `models: [...]` lists fallback models. `cache: 'auto' | 'off'` controls
  Lykia's automatic prompt caching for chat.

## Other endpoints

```ts
await lykia.embeddings.create({ model: '@embedding', input: ['a', 'b'] });
await lykia.models.list();                                  // chat models only (kind: 'chat')
await lykia.models.list({ kind: 'image' });                 // 'chat' | 'embedding' | 'image' | 'video' | 'speech' | 'transcription'
await lykia.models.list({ output_modalities: 'video' });    // or 'all'
await lykia.models.list({ supported_parameters: ['tools'] });
await lykia.models.get('anthropic/claude-sonnet-4.5');      // finds media models too
await lykia.providers.list();
await lykia.key.get();      // label, limit, usage, company, project; with an OAuth token also scopes and app { client_id, name }
await lykia.credits.get();  // balance, total_usage, reserved, available (billing_mode: 'internal' for internal use)
await lykia.generations.get('gen-…');                        // kind, endpoint, cost_details, media { units, job_id, … }
await lykia.generations.list({ limit: 50, after: 'gen-…' });
```

Every model carries `kind` and `is_free`; media models also `media { kind, capabilities, pricing { unit, quantity,
tiers, surcharges, note }, providers }` (their token `pricing` is `{}`).

## Media: images, video, speech, voices, transcription

Media methods take a media model (`author/model`) or a preset of the matching kind (`@image`, `@video`, `@tts`,
`@stt`); a chat preset there is 400 `preset_modality_mismatch`, a model of the wrong kind 400 `unsupported_model`.
They accept the tags `user` / `metadata` like every generation. Results and their files are stored by Lykia: links are
**signed and last about 1 hour**, a new link is signed on every read, and the stored file is kept for **7 days**
(`expires_at` of a video job). Download what you want to keep.

### Images

```ts
const img = await lykia.images.generate({
  model: '@image',
  prompt: 'a red bicycle on a cobbled street',
  n: 2,                     // 1–16 (model dependent)
  aspect_ratio: '16:9',     // or size: '1024x1024'; resolution: '2K'; output_format: 'png'
});
img.data[0].url;           // signed link (≈ 1 h), img.data[0].expires_at (ISO), mime_type
img.usage.cost;            // USD; also img._meta.cost (X-Lykia-Cost)
img.id;                    // generation id

// Edit / reference: images accepts https URLs, data: URIs, { url }, { image_url: { url } } or { b64_json, mime_type }
await lykia.images.generate({ model: '@image', prompt: 'same, at night', images: [img.data[0].url], provider_options: { strength: 0.5 } });

// Raw bytes instead of a link:
const b64 = await lykia.images.generate({ model: '@image', prompt: 'logo', response_format: 'b64_json' });
```

Model-specific settings go in `provider_options` (the model's allow-list in `models.get(id).media.capabilities`;
others are 400 `unsupported_input` with `error.param` naming the field).

### Video (asynchronous jobs)

```ts
const job = await lykia.videos.create({ model: '@video', prompt: 'waves at dusk', duration: 5, aspect_ratio: '16:9' });
// job.id is a generation id (gen-…); status 'queued'

const done = await lykia.videos.wait(job.id, { intervalMs: 5000, timeoutMs: 15 * 60_000, onPoll: (j) => console.log(j.progress) });
done.output?.url;          // signed link (≈ 1 h, re-signed on every read); done.expires_at: unix seconds (retention, 7 days)
done.usage?.cost;          // USD (0 for failed or cancelled jobs)

const { url, expires_at } = await lykia.videos.contentUrl(job.id);   // a fresh signed link (GET …/content?redirect=false)
const file = await lykia.videos.content(job.id);                     // { data: Uint8Array, contentType, cost, generationId }

await lykia.videos.get(job.id);                                      // one poll
await lykia.videos.list({ limit: 20, status: 'completed' });         // { data, next_cursor, has_more }
await lykia.videos.cancel(otherJob.id);                              // queued / in_progress only; else 409 job_not_cancellable
```

Statuses: `queued` → `in_progress` → `completed` | `failed` | `cancelled`. `videos.wait` resolves on `completed` and
throws a `LykiaError` with `code: 'video_failed'` or `'video_cancelled'` (the job is the error's `body`, its `error`
the `metadata`), or `code: 'timeout'` (retryable; the job keeps running, call `wait` again). Before completion
`content` / `contentUrl` answer 409 `video_not_ready`; after the retention period (or when the file can no longer be
fetched) 410 `video_expired`. Poll every few seconds: each poll is a cheap read, and the server caps a job at 60 minutes.

### Speech and voices

```ts
const speech = await lykia.audio.speech({ model: '@tts', input: 'Merhaba dünya', voice: 'JBFqnCBsd6RMkjVDRZzb', response_format: 'mp3' });
speech.data;               // Uint8Array; speech.contentType 'audio/mpeg'; speech.cost (X-Lykia-Cost)

const voices = await lykia.audio.voices.list();       // { model, data: [{ id, name, category: 'premade' | 'cloned', language, labels, … }] }
const clone = await lykia.audio.voices.create({
  model: voices.model,
  name: 'Narrator',
  file: { path: '/recordings/sample.mp3' },           // or [..] up to 25 files, 10 MB each, audio only
  consent: true,
});                                                   // { id: 'lvc_…', category: 'cloned', requires_verification }
await lykia.audio.speech({ model: '@tts', input: 'Hello', voice: clone.id });
await lykia.audio.voices.delete(clone.id);            // 404 voice_not_found when it does not exist
```

**Voice.** `voice` is optional in the type because a `@tts` preset can carry a default voice (`defaults.voice`). A
request with no voice at all is 400 `bad_request` (`error.param: 'voice'`). The gateway checked for this release still
answers that 400 when the voice comes only from the preset's defaults, so pass `voice` explicitly for now.

**Voice-clone consent.** `consent: true` states that you have the speaker's permission to clone their voice; it is
written to Lykia's audit log with your key and project. Without it the request is 400 `consent_required`
(`error.param: 'consent'`). Clones belong to the project of the key that made them.

### Transcription

```ts
const t = await lykia.audio.transcriptions.create({
  model: '@stt',
  file: { path: '/recordings/call.mp3' },             // or { data, filename, contentType }, a Blob / File
  language: 'tr',
  response_format: 'verbose_json',                    // json | text | srt | vtt | verbose_json | diarized_json (model dependent)
  provider_options: { diarize: true },                // sent as a JSON string field
});
t.text; t.usage?.cost; t._meta.cost;
t._meta.ignoredFields;                                // [] unless the gateway ignored fields (see below)
```

**Multipart order.** The gateway streams the upload to the provider as it arrives, so it reads the form fields first
and the **file must be the last part**. The SDK always sends it last (also for voice clones). If you build the form
yourself, append `file` after every other field: fields after the file are ignored and listed in the
`X-Lykia-Ignored-Fields` response header (`_meta.ignoredFields`). Files are limited to 25 MB.

## Using the Vercel AI SDK

Lykia works with both of the Vercel AI SDK's OpenAI providers; the chat model is spelled differently:

| Package | Chat model |
|---|---|
| `@ai-sdk/openai` (`createOpenAI({ baseURL, apiKey })`) | `provider.chat('@text')` (not `provider('@text')`, which uses the Responses API) |
| `@ai-sdk/openai-compatible` (`createOpenAICompatible({ name, baseURL, apiKey })`) | `provider.chatModel('@text')` or `provider('@text')` |

Lykia has no `/v1/responses` endpoint, so always use the Chat Completions model. Also:

- Pass **`maxRetries: 0`** to `generateText` / `streamText` and decide on retries yourself (see Errors below); the
  AI SDK's automatic retries can re-send a generation that was already billed.
- The AI SDK **drops `usage.cost`** (and `cost_details`), has **no place for Lykia's tags** (`user`, `metadata`), and
  when the gateway fails **after a stream started** the text stream can look like a normal finish with partial text.
- **`cache_control` markers** on messages or content parts cannot be sent through it; use this SDK when you need
  prompt caching with Anthropic models.

`createAiSdkFetch()` fixes the first three. Pass it as the provider's `fetch` (works with both packages):

```ts
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { streamText } from 'ai';
import { createAiSdkFetch, type LykiaError } from '@lykia/sdk';

let streamError: LykiaError | undefined;
const lykia = createOpenAICompatible({
  name: 'lykia',
  baseURL: 'https://api.getlykia.com/v1',
  apiKey: process.env.LYKIA_API_KEY,
  includeUsage: true,
  fetch: createAiSdkFetch({
    tags: () => ({ user: currentTenantId(), metadata: { product: 'support-bot' } }), // or a plain object
    onResult: (r) => recordCost(r.generationId, r.model, r.cost),  // r.provider, r.preset, r.usage, r.maxTokensApplied, r.aborted
    onError: (e, request) => { streamError = e; },                 // HTTP errors and mid-stream errors (once per stream)
    streamErrors: 'part',                                          // default; or 'throw'
  }),
});

const result = streamText({ model: lykia.chatModel('@text'), prompt: 'Merhaba', maxRetries: 0 });
for await (const part of result.fullStream) {
  if (part.type === 'text-delta') process.stdout.write(part.text);
  if (part.type === 'error') {/* the gateway failed mid-stream; streamError has status, code, reason, generationId */}
}
```

**Mid-stream errors: `streamErrors`**
- `"part"` (default): the gateway's error event is handed to the AI SDK in the shape it turns into an **`error`
  part** (`data: {"error":{"message","type","code"}}`), and the stream ends normally. You get the partial text, then
  the `error` part (`fullStream`, `onError` of `streamText`, `finishReason: 'error'`); the helper's `onError` gets the
  full `LykiaError`, so you can throw or map it after the stream. Pick this when you render partial output or use
  `fullStream` / `toUIMessageStreamResponse()`, where an error part is the AI SDK's normal way of reporting failure.
- `"throw"`: the stream fails: after the text before the error, reads reject with the `LykiaError` and
  `textStream` throws. Pick this when you only consume `textStream` / `await result.text` and want a failure to be an
  exception you cannot miss.

Both gateway formats are recognised: the gateway's standalone error event (`{ id, object, model, provider, error }`
with no `choices`, passed through untouched in `"part"` mode) and an error carried by a chunk with
`choices[].finish_reason: "error"` (re-shaped in `"part"` mode).

`onResult` gets `model` and `provider` (the ones that served the request, from the JSON body or the stream chunks),
`preset` (`X-Lykia-Preset`), `usage`, `cost`, `costDetails`, `generationId`, `streamed`, `aborted`, and the request's
own `context` and `tags`, for streams and non-streaming calls alike. `onError(error, request)` gets the same `context`,
`tags`, `url` and `generationId` as its second argument. For per-request tags see [`AsyncLocalStorage`](#per-request-tags-with-the-ai-sdk-asynclocalstorage).

**Versions verified.** `ai` 7.0.179 with `@ai-sdk/openai-compatible` 3.0.94 (this repository's tests, streaming and
non-streaming, including mid-stream errors). Reported by consumers: `ai` 6.x with `@ai-sdk/openai` 3.x for
non-streaming calls, and `ai` 6.0.197 in a streaming tool loop with both gateway error formats (partial text kept,
the mapped error returned).

What else it does: tags are sanitized (`sanitizeTags`) and merged into JSON bodies of generation requests (tags
already in the body win). Responses reach the AI SDK unchanged apart from the error event above: JSON bodies are read
from a copy, streams pass through byte for byte (re-chunked at event boundaries only) while `usage` is read from the
final chunk. An aborted request still calls `onResult` with what is known (`aborted: true`). HTTP error responses
are left to the AI SDK and also reported to `onError`. `fetch` wraps a custom fetch. No retries, no logging. Without
the helper, cost is still available afterwards through `lykia.generations.get(id)`.

## Per-request tags with the AI SDK (`AsyncLocalStorage`)

The AI SDK fixes a provider's `fetch` when the provider is created, so `createAiSdkFetch` cannot receive per-call
values directly. The recommended pattern: keep the current request in an `AsyncLocalStorage`, give `tags` as a
function that reads it, and give **`context`** as a function that returns your own correlation value (a request id,
an object). Both are read once per request, when the request starts, in the caller's async context; `onResult` gets
them back as `info.tags` and `info.context`, and `onError` as the second argument `request.tags` / `request.context`.

```ts
import { AsyncLocalStorage } from 'node:async_hooks';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { generateText } from 'ai';
import { createAiSdkFetch, type AiSdkTags } from '@lykia/sdk';

interface LykiaCall { requestId: string; tags: AiSdkTags }
const lykiaCall = new AsyncLocalStorage<LykiaCall>();

export const lykia = createOpenAICompatible({
  name: 'lykia',
  baseURL: 'https://api.getlykia.com/v1',
  apiKey: process.env.LYKIA_API_KEY,
  includeUsage: true,
  fetch: createAiSdkFetch({
    tags: () => lykiaCall.getStore()?.tags,                 // sent with the request
    context: () => lykiaCall.getStore()?.requestId,         // handed back with every callback of this request
    onResult: (r) => ledger.record(r.context, r.generationId, r.model, r.cost, r.aborted),
    onError: (e, request) => log.warn({ requestId: request.context, code: e.code }),
  }),
});

// In a request handler:
const { text } = await lykiaCall.run({ requestId: reqId, tags: { user: tenant.id, metadata: { feature: 'summary' } } }, () =>
  generateText({ model: lykia.chatModel('@text'), prompt, maxRetries: 0 }),
);
```

**Do not read the `AsyncLocalStorage` inside `onResult` / `onError`.** Callbacks can run outside the request's
context: when a stream is aborted, `onResult({ aborted: true })` runs in the context of whoever called `abort()`, where
the store is empty. `info.context` and `info.tags` always belong to the request. The captured values live only as long
as the request (no global map).

Alternative without `context`: correlate by `X-Generation-Id`. `info.generationId` (and `request.generationId` in
`onError`) is the id of the generation record, which also carries the tags you sent (`lykia.generations.get(id)`).

## Errors

Every failure is a `LykiaError` with:

| Field | Meaning |
|---|---|
| `status` | HTTP status (for a mid-stream error: `error.status`); `0` when there was no response |
| `code` | `error.code` from the body (always a string, see below), else from the fallback table; `network_error`, `timeout`, `aborted` without a response |
| `type` | `error.type`: `invalid_request_error`, `authentication_error` (401), `permission_error` (403), `rate_limit_error` (429), `provider_error` (502/504), `server_error` (other 5xx) |
| `reason` | stable class from `error.metadata.reason`: `invalid_request`, `unauthorized`, `forbidden`, `context_length_exceeded`, `content_policy`, `rate_limited`, `overloaded`, `timeout`, `provider_auth`, `provider_error`, `no_provider`, `insufficient_credits`, `limit_exceeded`, `unsupported_input` |
| `retryable` | `true` for `rate_limited`, `overloaded`, `timeout`, `provider_error` and network errors |
| `retryAfter` | seconds, from `error.metadata.retry_after` or `Retry-After` |
| `param` | the request field that was rejected (`error.metadata.param`), e.g. `n`, `response_format`, `consent` |
| `provider`, `providerCode`, `billedByProvider`, `cost` | provider details of a failed generation (`metadata.provider`, `provider_code`, `billed_by_provider`, `cost`) |
| `metadata`, `generationId`, `body` | `error.metadata` as sent, request id, parsed body |

A provider failure after a stream started arrives as a `LykiaError` thrown from the iteration (HTTP status stays 200).

Codes you will meet (non-exhaustive; branch on `reason` for classes, on `code` for specific cases):

| Status | Code | When |
|---|---|---|
| 400 | `bad_request`, `invalid_request` | malformed body; `param` names the field |
| 400 | `preset_not_found` / `preset_modality_mismatch` | `@name` is not defined / is defined for another kind of endpoint |
| 400 | `unsupported_model` | the model's kind does not fit the endpoint (e.g. an image model on chat) |
| 400 | `unsupported_input` | a value or `provider_options` key the model does not accept (`param`) |
| 400 | `unsupported_sort` | `provider.sort` other than `price` |
| 400 | `invalid_tags` | `user` / `metadata` over the limits (use `sanitizeTags`) |
| 400 | `too_many_files` | more than 8 file parts in a chat request |
| 400 | `consent_required` | voice clone without `consent: true` |
| 401 | `missing_api_key`, `invalid_api_key` | no / unknown credential |
| 402 | `insufficient_credits` | balance too low for the reservation |
| 403 | `platform_sales_disabled` | Lykia credits cannot be used for this provider yet; add your own key (BYOK) |
| 403 | `byok_only_no_key` | the project allows only its own provider keys and none fits (`reason: no_provider`) |
| 404 | `not_found`, `voice_not_found` | unknown generation / video job / voice |
| 409 | `video_not_ready`, `job_not_cancellable` | content before completion; cancel after a final state |
| 410 | `video_expired` | the stored video is no longer available |
| 413 | `payload_too_large` | upload over the limit (25 MB for transcription) |
| 429 | `rate_limited`, `provider_busy`, `media_queue_full` | rate limit; provider concurrency full (`Retry-After: 5`); too many queued media jobs in the project (`Retry-After: 30`) |
| 502 / 503 / 504 | `provider_error`, `no_provider`, `gateway_timeout` | provider failure; no provider available; timeout |
| – | `video_failed`, `video_cancelled` | thrown by `videos.wait` (status 0; the job in `body`) |

Fallback codes when a body carries no string `code` (`ERROR_CODE_BY_STATUS`; the fake server's `fakeError()` uses
the same table): 400 `bad_request`, 401 `unauthorized`, 402 `insufficient_credits`, 403 `forbidden`, 404 `not_found`,
408 `request_timeout`, 409 `conflict`, 410 `gone`, 413 `payload_too_large`, 429 `rate_limited`, 500 `server_error`,
502 `provider_error`, 503 `no_provider`, 504 `gateway_timeout`; any other 5xx `server_error`, other 4xx `http_error`.
A numeric `code` sent by an older server is read as the status.

**Retries.** None by default (`maxRetries: 0`). With `maxRetries > 0` the SDK retries idempotent GETs (network
errors, 408, 429, 5xx), and any request whose 429 carries `Retry-After` (rejected before any work, so nothing was
billed). It never re-sends a generation that may have run. Waits longer than 60 s are not taken automatically.

## Vendoring without npm

`dist/lykia-client.cjs` is the whole client in one CommonJS file with no dependencies (Node.js ≥ 18). Copy it into any
plain-JS project:

```js
const { Lykia, LykiaError } = require('./lykia-client.cjs');
```

The file starts with a header naming the SDK version; it is generated by `npm run build` and must not be edited.
Copy `dist/lykia-client.d.cts` next to it for TypeScript types (and `dist/lykia-fake-server.d.cts` for the fake).

> [!WARNING]
> **TypeScript builds do not copy the `.cjs` file.** If you put `lykia-client.cjs` + `lykia-client.d.cts` inside
> `src/` and compile with `tsc`, `tsc` uses the `.d.cts` for types and emits nothing for the `.cjs`: `dist/` has no
> `lykia-client.cjs`, and the compiled server fails at start with `Cannot find module './lykia-client.cjs'`.
> Pick one of these:

**A. Copy it after the build** (keep the file in `src/vendor/`):

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "postbuild": "node -e \"require('fs').cpSync('src/vendor', 'dist/vendor', { recursive: true })\""
  }
}
```

```ts
// src/lykia.ts  →  dist/lykia.js; both resolve ./vendor/lykia-client.cjs next to themselves
import { createRequire } from 'node:module';
import type * as LykiaClient from './vendor/lykia-client.cjs';
const require = createRequire(import.meta.url);           // in a CommonJS build use the global require instead
export const { Lykia, LykiaError } = require('./vendor/lykia-client.cjs') as typeof LykiaClient;
```

**B. Keep it outside `src/`** (e.g. `vendor/lykia-client.cjs` at the project root, next to `src/` and `dist/`) and
require it by a path that is the same from `src/` and from `dist/`:

```ts
// CommonJS output (package "type": "commonjs"); in an ESM build add createRequire as in A
// src/lykia.ts compiles to dist/lykia.js: '../vendor/…' points to the same file from both
import type * as LykiaClient from '../vendor/lykia-client.cjs';
export const { Lykia, LykiaError } = require('../vendor/lykia-client.cjs') as typeof LykiaClient;
```

Both recipes were checked with TypeScript 6.0 (`module: nodenext`). Either way, check once with `node dist/<entry>.js` after a clean build (`rm -rf dist`). Deployments that ship only
`dist/` need option A (or the `vendor/` folder shipped too). Bundlers (esbuild, tsdown, webpack) inline the file and are
not affected.

## Testing with the fake server

`@lykia/sdk/testing` (also as the single file `dist/lykia-fake-server.cjs`) starts a local fake of the Lykia API:

```ts
import { createFakeLykia, fakeError, chatChunks } from '@lykia/sdk/testing';

const fake = await createFakeLykia();
const lykia = new Lykia({ apiKey: 'lyk-v1-test', baseURL: fake.url });
fake.enqueue('POST /chat/completions', fakeError(429, { reason: 'rate_limited', retry_after: 2 }));
fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'Hi', toolCalls: [{ id: 'c1', name: 'f', arguments: '{}' }] }) });
// … fake.requests holds what was received
await fake.close();
```

`createFakeLykia({ strict = true, apiKey?, presets?, billingMode?, port?, videoTimeline? })`. The fake answers with
the gateway's field names, statuses, error `type` / `code` / `metadata.param` and headers (`X-Generation-Id`,
`X-Lykia-Preset`, `X-Lykia-Cost`, `X-Lykia-Ignored-Fields`).

Strict mode enforces what the real gateway enforces: a bearer credential on every request (401 `missing_api_key` /
`invalid_api_key`; without `apiKey` the `lyk-v1-…` key or `lyk-oat-…` access-token shape), defined presets and their
endpoint kind (`preset_not_found`, `preset_modality_mismatch`), the model kind (`unsupported_model`), the tag limits
(`invalid_tags`), at most 8 file parts (`too_many_files`), `provider.sort` (`unsupported_sort`), image `n` (1–16) and
`response_format`, voice-clone consent and file limits, and multipart parsing with size limits. Unknown top-level body
fields the gateway would drop are listed in `request.violations`; fields it accepts but overrides or honours only
conditionally (`store`, `web_search_options`) are in `request.notes`, and so is a transcription file sent before
`model` or fields after the file. `strict: false` accepts anything.

The fake's default preset table is `FAKE_DEFAULT_PRESETS`: the suggested `PRESETS` except `search`, which the real
gateway does not offer yet, mapped to a default model each (chat, embedding, and the media models
`recraft/recraftv4_1`, `bytedance/seedance-1.0-pro`, `elevenlabs/eleven_multilingual_v2`, `elevenlabs/scribe_v2`).
Add presets explicitly: `createFakeLykia({ presets: { ...FAKE_DEFAULT_PRESETS, search: 'chat', support: 'chat' } })`.
`GET /models` lists chat models by default and the media models with `?kind=` / `?output_modalities=`.

Without an enqueued response every endpoint answers with realistic defaults: JSON that satisfies a requested
`json_schema`, deterministic embeddings (honouring `dimensions`, arrays, `base64`), images with signed-looking links
(`X-Amz-Expires=3600`, a new signature on every read) or a real 1×1 PNG for `b64_json`, speech bytes per format,
voices (a premade voice and your `lvc_…` clones), transcriptions, usage with cost, and generation records retrievable
by their `X-Generation-Id` (`GET /generation`, `GET /generations`), `billingMode: 'internal'` credits.

**Video jobs follow a clock**: `queued` for `videoTimeline.queuedMs` (default 100), `in_progress` with rising
`progress` for `runningMs` (default 300), then `completed` with a signed output link; `cancel` works while the job runs.
Script outcomes through the prompt: a prompt containing `#fail` ends `failed` (cost 0), `#expired` completes but its
content answers 410 `video_expired`.

Queued responses can simulate failures: `{ drop: 'before-headers' }`, `{ stream, drop: 'mid-body', dropAfter: 2 }`,
`{ delayMs }` (slow first byte), `{ hang: true }`, and `chatChunks({ error })` for a mid-stream error:
`errorFormat: 'standalone'` (default, the gateway's event: `{ id, object, created, model, provider, error }`),
`'bare'` (`{ error }` only) or `'chunk'` (an error carried by a chunk with `finish_reason: "error"`).

## Conformance against a real gateway

`packages/sdk/test/conformance.test.ts` (in this repository, not in the package) runs the SDK against a real Lykia
gateway when `LYKIA_CONFORMANCE_URL` and `LYKIA_CONFORMANCE_KEY` are set (`npm run conformance`); otherwise it is
skipped. It spends a little money: use a staging or local gateway.

## Security

- Keep API keys on the server. The SDK refuses to run in a browser page unless you pass `dangerouslyAllowBrowser: true`.
- The key is held in private fields: `JSON.stringify(lykia)`, `console.log(lykia)` and `Object.keys` never show it.
  An `Authorization` entry in `defaultHeaders` is ignored.
- Keys are only sent to `baseURL`; redirects to another origin never carry the key.
- The SDK sends no telemetry.

---

## Türkçe

Lykia API'si için bağımlılıksız TypeScript istemcisi: tek anahtar, ön ödemeli USD kredi, OpenAI uyumlu `/v1`.
`npm install @lykia/sdk` ile kurulur; `new Lykia({ apiKey })` ile başlar. Akış için `chat.completions.stream()`
olayları (`text`, `reasoning`, `tool_call`, `done`) ve `.final()`; hazır ayarlar için `model: '@text'`; kullanım
kırılımı için her üretimde `user` ve `metadata`; maliyet `usage.cost` ve `usage.cost_details` alanlarındadır.
Hatalar `LykiaError` (`status`, `code`, `type`, `reason`, `retryable`, `retryAfter`, `param`, `generationId`).
Görsel (`images.generate`), video (`videos.create` / `wait` / `content` / `contentUrl` / `list` / `cancel`), ses
(`audio.speech`, `audio.voices`) ve yazıya dökme (`audio.transcriptions`) yöntemleri gerçek uçlarla uyumludur;
bağlantılar imzalıdır (yaklaşık 1 saat), dosyalar 7 gün saklanır. Ses klonu için `consent: true` zorunludur; dosya çok
parçalı formun son parçası olmalıdır (SDK bunu kendisi yapar). npm olmadan kullanmak için tek dosyalık
`dist/lykia-client.cjs` projeye kopyalanır; `tsc` bu dosyayı `dist`'e kopyalamaz, `postbuild` ile kopyalayın.
Testler için `@lykia/sdk/testing` sahte sunucuyu verir.
API anahtarını tarayıcıya koymayın.
