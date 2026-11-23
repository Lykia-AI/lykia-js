# Single-file artifacts (@lykia/sdk 0.2.2)

Built by `npm run build -w @lykia/sdk` (tsdown). Both are self-contained CommonJS files: no dependencies, only Node.js
built-ins and globals (`fetch`, `FormData`, `Blob`), target Node.js >= 18. Each starts with a header comment naming the
version and marking it as generated. Tested by copying them alone into an empty directory and running them there, and
by type-checking a strict TypeScript consumer against the `.d.cts` files (`packages/sdk/test/vendored.test.ts`).

| File | Absolute path |
|---|---|
| Client | `/Users/ahmetaksungur/Desktop/lykia/lykia-js/packages/sdk/dist/lykia-client.cjs` |
| Client types | `/Users/ahmetaksungur/Desktop/lykia/lykia-js/packages/sdk/dist/lykia-client.d.cts` |
| Fake server | `/Users/ahmetaksungur/Desktop/lykia/lykia-js/packages/sdk/dist/lykia-fake-server.cjs` |
| Fake server types | `/Users/ahmetaksungur/Desktop/lykia/lykia-js/packages/sdk/dist/lykia-fake-server.d.cts` |

> **TypeScript consumers: `tsc` does not copy `lykia-client.cjs` into `dist`.** When the `.cjs` sits in `src/` next to
> its `.d.cts`, `tsc` takes the types and emits nothing for the file, so the compiled server fails with
> `Cannot find module './lykia-client.cjs'`. Copy it in a `postbuild` step, or keep it outside `src/` and require it by
> a path that is the same from `src/` and `dist/`; both recipes are in the SDK README ("Vendoring without npm").

Client exports: `Lykia`, `LykiaError`, `ERROR_CODE_BY_STATUS`, `preset`, `isPreset`, `PRESET_NAME_PATTERN`, `PRESETS`,
`PRESET_MODALITY`, `TAG_LIMITS`, `sanitizeTags`, `createAiSdkFetch`, `ChatCompletionStream`, `mergeReasoningDetails`,
`parseSSE`, `DEFAULT_BASE_URL`, `DEFAULT_TIMEOUT_MS`. Fake server exports (same as `@lykia/sdk/testing`): `createFakeLykia`,
`fakeError`, `fakeUsage`, `chatChunks`, `fakeEmbedding`, `sampleFromSchema`, `FAKE_DEFAULT_PRESETS`.

```js
const { Lykia, LykiaError } = require('./lykia-client.cjs');
const { createFakeLykia, fakeError, chatChunks } = require('./lykia-fake-server.cjs');

const fake = await createFakeLykia({ apiKey: 'lyk-v1-test' }); // { url, origin, port, requests, generations, enqueue, reset, close }
const lykia = new Lykia({ apiKey: 'lyk-v1-test', baseURL: fake.url });
fake.enqueue('POST /chat/completions', fakeError(429, { reason: 'rate_limited', retry_after: 2 }));
fake.enqueue('POST /chat/completions', { stream: chatChunks({ text: 'Hi', toolCalls: [{ id: 'c1', name: 'f', arguments: ['{"a"', ':1}'] }] }) });
await fake.close();
```

`createFakeLykia({ strict = true, apiKey?, presets?, presetDefaults?, billingMode?, port?, videoTimeline? })` returns a Promise. Queued responses
(`{ status, headers, json | body | stream, done, delayMs, eventDelayMs, hang, drop, dropAfter }` or a function of the
request) are used once, first in first out, for the first matching `"METHOD /path"` route (`:param` and `*` allowed).

## Changelog

### 0.2.2

Follows the gateway changes of 2026-11-24. Only one item can change an existing test (fake records, first below).

**Fake server**
- **Generation records carry exactly the cost the client saw** (`X-Lykia-Cost`, else `usage.cost` of the JSON body,
  else of the last stream chunk that has one; 0 when none was sent). 0.2.1 wrote a fixed 0.000123 for speech
  (whose `X-Lykia-Cost` differed) and for streams scripted with their own usage. A test that pinned 0.000123 on those
  records needs the real value. A test checks record = client cost for chat (JSON, stream, scripted stream, queued),
  embeddings, images, speech, transcription and video.
- `chatChunks({ cost })`: shorthand for `usage: fakeUsage({ cost })`.
- Speech: `voice` falls back to the preset's default voice, set with the new option
  `presetDefaults: { tts: { voice: '…' } }` (default none); without either, 400 `bad_request` with `param: "voice"`,
  as the gateway. Responses carry `X-Lykia-Model` and `X-Lykia-Provider`.
- `GET /audio/voices` has a top-level `provider`.
- Video prompt `#output-unavailable`: the job completes (billed) with `output: null` and
  `error { code: "video_output_unavailable", reason: "provider_error", retryable }`; content / contentUrl answer 502
  `video_output_unavailable` (`metadata.provider`). 410 `video_expired` stays for `#expired` (real expiry).

**Client**
- `audio.speech()` result (and every binary result) gains `model` and `provider` from `X-Lykia-Model` /
  `X-Lykia-Provider` (`undefined` where an endpoint does not send them).
- `SpeechCreateParams.voice` doc: the gateway now applies the preset's `defaults.voice`; 400 `param: voice` only when
  neither the request nor the preset gives one. The 0.2.0 "pass `voice` explicitly" note is removed.
- `VideoJob.output` can be `null` for a completed job whose file could not be retrieved; `VideoJob.error.code`
  includes `video_output_unavailable` and `error.retryable`. `VoiceList.provider`.
- README: `video_output_unavailable` (502) in the error table and the video section; 410 `video_expired` only after
  real expiry; speech `model` / `provider`; the fake's `presetDefaults`, `#output-unavailable`, cost-matching records.

**MCP bridge**: version bump only.


### 0.2.1

Non-breaking.

**Client**
- `createAiSdkFetch({ context })`: a function called once per generation request, synchronously when the request
  starts (in the caller's async context). Its value comes back as `info.context` in `onResult` and as
  `request.context` in `onError`, for that request only, also when the callback runs in another context: on an
  aborted stream `onResult({ aborted: true })` runs in the context of whoever called `abort()`, where an
  `AsyncLocalStorage` store is empty. The value is held by the request's own closures for its lifetime (no global map).
- `onResult` info also carries `tags`: the tags resolved for that request (`options.tags` or its function's result).
- `onError(error, request)`: new second argument `AiSdkRequestInfo { url, context, tags, generationId }` for HTTP
  errors and mid-stream errors. Existing one-argument handlers keep working.
- README: the per-request tags section now recommends `context` for correlation, warns not to read the
  `AsyncLocalStorage` inside callbacks, and keeps `X-Generation-Id` correlation as the alternative.
- Tests: an abort from a different async context, an AI SDK `abortSignal` abort, two concurrent streams, non-stream
  results, HTTP and mid-stream errors each carry their own request's context and tags.

**MCP bridge**: version bump only (kept in step with the SDK).


### 0.2.0

Aligned with the real Lykia gateway: every method was checked against a running backend (opt-in conformance suites,
below). The media methods are no longer marked preview.

**Breaking changes for 0.1.4 consumers** (most likely to hit first):

1. **Fake server defaults changed to the gateway's values**, so tests that pin fake numbers or ids need updating:
   default media models are now `recraft/recraftv4_1` (image), `bytedance/seedance-1.0-pro` (video),
   `elevenlabs/eleven_multilingual_v2` (speech), `elevenlabs/scribe_v2` (transcription), was `openai/gpt-image-2`,
   `google/gemini-omni-flash`, `elevenlabs/eleven-v3`, `openai/gpt-4o-transcribe`. Costs: image $0.035 each (was
   $0.04), video $0.27 (was $0.5), speech characters × $0.00008 (was a flat $0.0003), transcription per duration. Video
   job ids are generation ids `gen-…` (was `vid_fake_N`); voices are the premade `JBFqnCBsd6RMkjVDRZzb` ("George") and
   clones `lvc_` + 20 characters (was `voice_ada` / `voice_clone_N`). The fake chat response's `provider` now follows
   the model (`anthropic/…` → `anthropic`).
2. **Fake video jobs follow a clock, not a poll count.** 0.1.4 answered `queued`, `in_progress`, then a final state on
   the 1st, 2nd and 3rd poll; now `queued` for `videoTimeline.queuedMs` (100 ms), `in_progress` for `runningMs`
   (300 ms), then final, however often you poll. A failure is scripted with `#fail` in the prompt (0.1.4: any prompt
   containing `fail`, which also caught words like "failure"); `#expired` gives 410 `video_expired` on content.
3. **`chatChunks({ error })` now emits the gateway's standalone error event by default**
   (`{ id, object: "chat.completion.chunk", created, model, provider, error }`, no `choices`); 0.1.4 defaulted to a
   chunk with `finish_reason: "error"`. Use `errorFormat: 'chunk'` for the old shape, `'bare'` for `{ error }` only.
   `chat.completions.stream()` and `createAiSdkFetch` handle all three.
4. **`Voice.type` is now `Voice.category`** (`"premade"`, `"cloned"`, …: the gateway's field); `voices.list()` returns
   `{ object: "list", model, data }`; a clone is `{ id: "lvc_…", object: "voice", category: "cloned", provider,
   model, created_at, requires_verification }` (HTTP 201); `preview_url` is gone from the type.
5. **`images.generate()` result: the cost is `usage.cost`, not a top-level `cost`** (0.1.4 typed both; the gateway
   sends only `usage`). The result now has `id`, `object: "image.generation"`, `model`, `provider` and
   `usage { images, cost, is_byok, cost_details, units }`; each `data[]` item has `url` + `expires_at` (signed, about
   1 hour) or `b64_json`, and `mime_type`. `_meta.cost` repeats `X-Lykia-Cost`.
6. **`videos.wait()` stops on `cancelled`** and throws `LykiaError` code `video_cancelled` (0.1.4 kept polling until the
   timeout). A failed job still throws `video_failed`; both now carry the job's `error` as `metadata` and its `reason`.
7. **`VideoJob` is typed as the gateway sends it**: `created_at` / `completed_at` / `expires_at` are unix seconds,
   `progress`, `model`, `provider`, `duration_seconds` are always present, the result link is `output.url`
   (+ `output.expires_at`, `mime_type`, `bytes`), `usage` on final states, `params`, and `error.code` is a string.
   Code that read optional fields with `?.` keeps working; strict comparisons of the old optional types may not.
8. **`models.list()` without filters lists chat models only** (gateway behaviour; the 0.1.4 fake also listed the
   embedding model). Use `models.list({ kind: 'embedding' })` / `{ output_modalities: 'all' }`. Items carry `kind`,
   `is_free` and, for media models, `media`.
9. **`ProviderPreferences.sort` is typed `'price'` only**: the gateway answers 400 `unsupported_sort` to
   `throughput` / `latency`, so code passing those no longer compiles.
10. **Fake strict 401 without an `Authorization` header is `missing_api_key`** (was `invalid_api_key`); a wrong key is
    still `invalid_api_key`. Error `type` follows the status like the gateway: 403 `permission_error`, 429
    `rate_limit_error`, 502/504 `provider_error` (0.1.4: `invalid_request_error` / `server_error`).
11. **Exact-shape assertions on result objects**: `_meta` gains `cost` and `ignoredFields`; `stream().final()` and the
    `done` event gain `model`, `provider`, `preset`; `createAiSdkFetch`'s `onResult` gains `provider`; `LykiaError`
    gains `type`, `metadata`, `param`, `providerCode`, `billedByProvider`, `cost`. `toEqual` on these breaks;
    `toMatchObject` does not.
12. **Fallback codes for 409 / 410** without a body code are `conflict` / `gone` (was `http_error`).
13. **Multipart uploads send the file part(s) last**: transcriptions and voice clones now append every other field
    first (`provider_options` and `provider` as JSON string fields). 0.1.4 appended `file` first in both, which sent
    every upload down the gateway's temp-file path. Matters for your code only if you inspect the raw form (e.g.
    `fake.requests`); a test now checks the order on the wire.
14. **Fake OAuth credentials**: `lyk-oat-…` access tokens are accepted, and `GET /key` answers with the OAuth shape
    (`scopes`, `app { client_id, name }`) for anything but a `lyk-v1-…` key; `limit_reset` is `"none"` / `"monthly"`.
15. **Fake notes wording**: the `web_search_options` note now reads that web search is not available on the gateway yet.

**Client: new**
- Stream summary: `final()` and the `done` event carry `model` and `provider` (from the chunks: the model that actually
  served the request, also behind a preset or after a fallback) and `preset` (`X-Lykia-Preset`). `createAiSdkFetch`'s
  `onResult` carries `model`, `provider`, `preset` for streams and JSON responses.
- Videos: `videos.list({ limit, after, status })`, `videos.cancel(id)`, `videos.contentUrl(id)` (a fresh signed link
  via `?redirect=false`); `VideoStatus` includes `cancelled`.
- Images: `resolution`, `output_format`, `mask`, `models`, `provider`; input images as URL, `data:` URI, `{ url }`,
  `{ image_url: { url } }` or `{ b64_json, mime_type }`.
- Speech: `voice` is optional in the type (a `@tts` preset can carry `defaults.voice`; with no voice at all the
  gateway answers 400 `bad_request`, `param: "voice"`, and the fake does the same); `language`, `instructions`.
  Transcriptions: `diarized_json`, `provider_options`, `provider`;
  `_meta.ignoredFields` from `X-Lykia-Ignored-Fields`.
- Models: `kind` / `output_modalities` filters; `Model.kind`, `is_free`, `media`. `models.get()` finds media models.
- Chat: `cache: 'auto' | 'off'`. Key: `app` for OAuth tokens. Generations: `kind`, `endpoint`, `media`,
  `usage_type: 'internal'`.
- `LykiaError`: `type`, `metadata`, and the getters `param`, `providerCode`, `billedByProvider`, `cost`.
- README: media guide (examples, URL lifetime, video polling, the file-last multipart rule, voice-clone consent), the
  error code table (`unsupported_model`, `platform_sales_disabled`, `byok_only_no_key`, `provider_busy`,
  `media_queue_full`, `video_not_ready`, `video_expired`, `job_not_cancellable`, `voice_not_found`,
  `consent_required`, `preset_modality_mismatch`, `unsupported_sort`, `invalid_tags`, `too_many_files`, …), a warning
  that `tsc` does not copy the vendored `.cjs` (with a `postbuild` copy and an outside-`src` recipe, both verified with
  TypeScript 6.0), and per-request AI SDK tags with `AsyncLocalStorage` (`tags` as a function). AI SDK versions
  verified: `ai` 7.0.179 + `@ai-sdk/openai-compatible` 3.0.94 here; consumers report `ai` 6.x + `@ai-sdk/openai` 3.x
  for non-streaming calls and `ai` 6.0.197 in a streaming tool loop with both error formats.

**Fake server: new**
- Gateway field names, statuses, error `type` / `code` / `metadata.param` and headers (`X-Lykia-Cost`,
  `X-Lykia-Ignored-Fields`) for images, videos (create / get / list / cancel / content with 302 or
  `?redirect=false`, 409 `video_not_ready` / `job_not_cancellable`, 410, 404), speech (content type per format, 404
  `voice_not_found`), voices (consent, name, 1–25 audio files of ≤ 10 MB) and transcriptions (file order checks).
- Signed-looking links (`X-Amz-Expires=3600`, a new signature on every read). Multipart parsing with limits.
- Strict validation adds `unsupported_model`, `unsupported_sort`, image `n` / `response_format` with `param`, video and
  speech required fields. Media models in the catalog (`?kind=`, `?output_modalities=`), media presets in the default
  table.

**MCP bridge**
- `output_save` also accepts the exact links Lykia's own tools returned in the session (string `url` fields of their
  structured results), so signed storage links work when the storage host is not a `*.getlykia.com` host. Free text
  (e.g. a chat answer) is never trusted; the bearer is still sent only to the Lykia API origin.
- README: the 15 remote tools, the 13 ready-made commands (prompts), a typical file flow.

**Conformance (repository only, not shipped)**
- `npm run conformance` (`packages/sdk/test/conformance.test.ts`, `packages/mcp/test/conformance.test.ts`), skipped
  unless `LYKIA_CONFORMANCE_URL` and `LYKIA_CONFORMANCE_KEY` are set; `scripts/conformance/backend-env.mjs` boots a
  local gateway from a backend checkout. Run against the backend on 2026-11-23: SDK 8/8, MCP 5/5.


### 0.1.4

**Client**
- **Behaviour change from 0.1.3:** `createAiSdkFetch()` no longer errors the stream on a mid-stream gateway error by
  default. New option `streamErrors: "part" | "throw"`, default **`"part"`**: the error event is handed to the AI SDK
  as a standalone `data: {"error":{"message","type","code"}}` event (the AI SDK emits an `error` part after the
  partial text), the stream ends normally (`[DONE]` kept), and `onError` receives the full `LykiaError` once
  (status, code, reason, generationId, body). `streamErrors: "throw"` keeps the 0.1.3 behaviour (text, then the read
  rejects with the `LykiaError`; `textStream` throws).
- Both gateway formats are recognised in both modes: the error on a chunk with `choices[].finish_reason: "error"`
  (re-shaped in `"part"` mode) and a standalone `{"error":{…}}` event (passed through untouched in `"part"` mode).
  `chat.completions.stream()` already handled both.
- README: both AI SDK spellings: `@ai-sdk/openai` → `provider.chat(id)`; `@ai-sdk/openai-compatible` →
  `provider.chatModel(id)` or `provider(id)`; when to pick each `streamErrors` mode.

**Fake server**
- `chatChunks({ error, errorFormat: 'standalone' })` emits the standalone `{"error":{…}}` event (default `'chunk'`).

### 0.1.3

**Client**
- New `createAiSdkFetch({ tags?, onResult?, onError?, fetch? })`: a `fetch` for the Vercel AI SDK's OpenAI-compatible
  provider. It merges sanitized Lykia tags into generation bodies (tags already in the body win); reports usage, cost,
  `X-Generation-Id`, `X-Lykia-Preset`, `X-Max-Tokens-Applied`, `X-Lykia-Reasoning` through `onResult` (streams: when
  the final chunk arrives, or with `aborted: true` on abort); passes response bytes through unchanged; turns a
  mid-stream error chunk into a stream error with a `LykiaError` (the text before it is still delivered; the error
  event itself is not passed on), so `streamText(...).textStream` throws instead of finishing with partial text; reports
  HTTP errors to `onError` and leaves them to the AI SDK. No retries, no logging. Tested against `ai` 7.0.179 +
  `@ai-sdk/openai-compatible` 3.0.94 (dev dependencies only).
- README "Using the Vercel AI SDK": the current provider method is `chatModel(id)` (or `provider(id)`); 0.1.2 said
  `.chat(id)`, which does not exist in `@ai-sdk/openai-compatible` 3.x.
- Internal: the mid-stream error mapping is shared (`streamChunkError`) between `chat.completions.stream()` and the
  helper; behaviour unchanged.

### 0.1.2

**Fake server**
- The chat field list now matches the real gateway (backend `PLATFORM_BODY_FIELDS` plus Lykia's `models`,
  `provider`, `user`, `metadata`): **`prompt_cache_key` is no longer a violation**. `store` and `web_search_options`
  are not violations either; they go to the new `request.notes` (`store` is always sent as `false`;
  `web_search_options` only works on models with a web-search price, else the real gateway answers 400
  `unsupported_input`). Other unknown fields stay in `request.violations`, now worded "dropped on Lykia's keys; passed
  through only with your own provider key".
- **`search` is no longer in the fake's default preset table** (`FAKE_DEFAULT_PRESETS`, exported); `@search` is now
  400 `preset_not_found` unless you add it: `createFakeLykia({ presets: { ...FAKE_DEFAULT_PRESETS, search: 'chat' } })`.
  `PRESETS` (the suggestion list) still contains `search`.
- Like the real gateway: tag errors use `code: invalid_tags`; metadata keys starting with `$` or containing `.` are
  rejected; chat requests need a non-empty `messages` array with valid roles (`tool` messages need `tool_call_id`).

**Client**
- `sanitizeTags()` also drops metadata keys starting with `$` or containing `.`.
- Chat request type documents `prompt_cache_key`, `store`, `web_search_options`.
- README: "Using the Vercel AI SDK" (`.chat(model)`, `maxRetries: 0`, `usage.cost` is stripped there, no `cache_control`).

### 0.1.1

Changes a consumer will notice:

**Client (`lykia-client.cjs`, `@lykia/sdk`)**
- **Security fix:** the API key no longer appears in `JSON.stringify(lykia)`, `console.log(lykia)` / `util.inspect`
  (any depth), `Object.keys` or `for…in` over the client and its resources. An `Authorization` entry in
  `defaultHeaders` is ignored (the `apiKey` is always what is sent) and never stored.
- `LykiaError.code` is the body's string `error.code`; the status comes from the HTTP status, or for a mid-stream error
  chunk from `error.status`. A numeric `code` from an older server is read as the status.
- Fallback codes (no string code in the body) follow `ERROR_CODE_BY_STATUS`; **503 is now `no_provider`** (was
  `service_unavailable`), and 500 `server_error`, 504 `gateway_timeout` were added. The fake's `fakeError()` uses the
  same table. When the body has no `reason`, 400/413 → `invalid_request`, 401 → `unauthorized`, 403 → `forbidden`.
- New reasons: `unauthorized`, `forbidden`.
- `audio.speech()` and `videos.content()` results have `generationId` and `cost` (from `X-Generation-Id` /
  `X-Lykia-Cost`); `videos.content()` follows the signed-URL redirect itself and never sends the key to it.
- `_meta.reasoningDropped` (from `X-Lykia-Reasoning: dropped`) on every result with `_meta`.
- Uploads (`audio.transcriptions.create`, `audio.voices.create`) accept a `Blob`/`File`, `{ data, filename }`, or on
  Node.js 20+ `{ path }` (streamed with `fs.openAsBlob`; on Node 18 the file still loads, only `{ path }` fails).
- New: `sanitizeTags()`, `PRESETS`, `PRESET_MODALITY`, `TAG_LIMITS`. `credits.get()` types: `billing_mode`,
  `period_cost`, `period_start` are final.
- Typings for the single files are now shipped (`lykia-client.d.cts`, `lykia-fake-server.d.cts`).

**Fake server (`lykia-fake-server.cjs`, `@lykia/sdk/testing`)**: **strict by default**. Tests that relied on the
permissive 0.1.0 behaviour either fix the requests or pass `strict: false`.
- Every request needs a valid bearer, **including queued responses**. Without `apiKey`, a `lyk-v1-…` key or an
  access-token-looking value (16+ URL-safe characters) is required. 401 has `code: invalid_api_key`,
  `reason: unauthorized`.
- `@name` models are checked against the preset table (default: `PRESETS` with their modalities; `presets` option to
  configure): 400 `preset_not_found` / `preset_modality_mismatch`. The check runs before any queued response, so an
  undefined preset is rejected even when a response is queued for it (the queued response stays queued).
- `user` > 128 characters, `metadata` beyond 16 keys / 64-character keys / non-string or > 512-character values, more
  than 8 file parts or a file part without a `data:` URI → 400 `invalid_request` (`too_many_files` for the file
  count). Unknown top-level body fields are recorded in `request.violations` (not rejected).
- `GET /generation?id=` returns the record of a request the fake actually answered (by its `X-Generation-Id`); an
  unknown id is **404** in strict mode (0.1.0 returned a synthetic record for any id). `GET /generations` lists and
  filters the real records. `fake.generations` exposes them.
- Default answers are realistic: `json_schema` → JSON satisfying the schema; embeddings deterministic from the input
  (default 16 dimensions, `dimensions`, arrays and `base64` honoured; 0.1.0 returned a fixed 3-number vector);
  `b64_json` → a valid 1×1 PNG; video content → 302 to a signed-looking URL served by the fake; speech and video
  content carry `X-Lykia-Cost`; `billingMode: 'internal'` credits; `X-Lykia-Reasoning: dropped` when thinking is
  requested and an assistant tool-call message lacks `reasoning_details`.
- Stream chunks without an `id` (e.g. `chatChunks()` without `id`) get the request's `X-Generation-Id`.
- Error bodies now carry `status`; `chatChunks({ error })` puts the HTTP equivalent in `error.status` and a string code.
- Failure scenarios: `{ drop: 'before-headers' }`, `{ drop: 'mid-body', dropAfter }`, `{ delayMs }`, `{ hang }`.
- `reset()` also clears generation records, video jobs and voices.

### 0.1.0

First release.
