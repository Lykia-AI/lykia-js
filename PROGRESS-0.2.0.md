# 0.2.0 progress (temporary; the coordinator removes this after the release)

Task: align `lykia-js` with the real backend (frozen copy: `$FROZEN` =
`/private/tmp/claude-501/-Users-ahmetaksungur-Desktop-lykia-lykia-backend/fe159d0d-f216-461d-8362-847d032f2228/scratchpad/frozen-backend-media`),
drop "preview" where the endpoint exists, fake server parity, opt-in conformance suite, MCP conformance, READMEs, 0.2.0.

Load rule: one heavy command at a time; stop backend + mongod right after a check.

## Harness
- `scripts/conformance/backend-env.mjs`: boots mongod :27221 + frozen backend :7821 + its fake providers (chat :7822,
  media proxy :7823, CDN :7824, S3 :7825), provisions company/project/presets/key, control server :7826
  (`POST /script {flavor, behaviors}`, `POST /stop`). Writes `env.json` (key) next to itself (0600). Stop: `curl -X POST :7826/stop`.
- Needs option `mediaExtraHosts.bytedance = ark-content.example` (added) else video output copy fails.

## Real contract observed (probe 1, 2026-11-23)
- Chat: headers X-Generation-Id, X-Lykia-Preset, X-Max-Tokens-Applied. Stream error = standalone
  `{id, object:"chat.completion.chunk", created, model, provider, error{message,type,code,status,metadata{reason,provider_name,raw,provider}}}` then [DONE].
- Errors: type by status (authentication_error 401, permission_error 403, rate_limit_error 429, provider_error 502/504,
  server_error 5xx, invalid_request_error 4xx). Codes seen: missing_api_key, invalid_api_key, preset_not_found,
  preset_modality_mismatch, invalid_tags, unsupported_sort, too_many_files, unsupported_model, bad_request (+param),
  video_not_ready 409, job_not_cancellable 409, video_expired 410, not_found 404 ("Video not found"), consent_required (+param consent),
  voice_not_found 404, unsupported_input (+param).
- Embeddings: + `provider`; usage cost/cost_details.
- Models: default list = chat only; items have `kind`, `is_free`; media: `kind`, `media{kind,capabilities,pricing{unit,quantity,tiers,surcharges,note},providers}`, `pricing: {}`; `?kind=` and `?output_modalities=`.
- Key: `limit_reset` string ("none"), company, project (OAuth: scopes, app{client_id,name}).
- Generation: + endpoint, preset, metadata, cost_details, kind, media{units,units_estimated,billed_by_provider,job_id,outputs}.
- Images: `{id, object:"image.generation", created, model, provider, data[{mime_type, url, expires_at(ISO)} | {mime_type, b64_json}], usage{images,cost,is_byok,cost_details,units}}`, X-Lykia-Cost.
- Videos: job `{id:gen-…, object:"video", status queued|in_progress|completed|failed|cancelled, progress, model, provider, created_at(unix s), completed_at, expires_at(unix s), duration_seconds, params{…}, error{message,code,reason}, usage{cost,is_byok,cost_details}, output{url, expires_at(ISO), mime_type, bytes} | {url:null, content:"/v1/videos/{id}/content"}}`.
  content: 302 Location + X-Lykia-Cost + X-Generation-Id; `?redirect=false` → `{url, expires_at, mime_type}`. list → `{object:"list", data, next_cursor, has_more}`, `?status=`. cancel → job with status cancelled.
- Speech: binary, content-type audio/mpeg, X-Lykia-Cost, X-Lykia-Preset.
- Voices list `{object:"list", model, data[{id, object:"voice", name, category:"premade", language, description, labels, provider}]}`; create 201 `{id:"lvc_…", object, name, category:"cloned", provider, model, created_at, requires_verification}`; delete `{id, object, deleted:true}`.
- Transcription json `{text, usage{cost,…}}`, X-Lykia-Cost; scribe rejects srt (unsupported_input, param response_format); field after file → `X-Lykia-Ignored-Fields: language`.

## Mismatches 0.1.4 → found (fix list)
1. videos.wait: no `cancelled` terminal state (would poll until timeout).
2. videos.list / videos.cancel / content `?redirect=false` missing.
3. VideoJob type: no output/params/created_at numbers/cancelled.
4. Images response type: top-level `cost` (wrong; it's usage.cost), missing id/object/model/provider/mime_type/expires_at; request lacks mask/resolution/output_format/models/provider.
5. Transcriptions: SDK sent `file` FIRST (gateway then spools to a temp file); must be last. diarized_json missing; X-Lykia-Ignored-Fields not surfaced.
6. Voice type `type` → real `category`; list has `object`,`model`; create returns 201 object with `requires_verification`.
7. Speech params: language, instructions missing.
8. Models: kind/media/is_free + `kind` / `output_modalities` filters missing.
9. provider.sort type allowed throughput/latency (gateway: only price → 400 unsupported_sort). Chat `cache: auto|off` missing.
10. Error metadata param/provider_code/billed_by_provider/cost not surfaced; type not surfaced.
11. Key `app` (OAuth) missing; Generation kind/media/endpoint/usage_type internal missing.

## Backend observations (do not edit backend)
- Completed video whose output copy failed (host not allow-listed) answers `/content` with 410 `video_expired`
  ("no longer available from the provider") although `expires_at` is 7 days ahead: misleading code for a fetch-policy failure.
- `GET /videos/{id}` output URL was identical on two consecutive reads within the same second (docs say re-signed each read;
  probably same signature because same second; not a defect).

## Status
- [x] SDK changes (types, videos list/cancel/contentUrl, wait cancelled, file-last, meta cost/ignoredFields, error type/param)  - [x] fake server (media parity) + unit tests green (sdk, release-0.1.1, release-0.2.0, ai-sdk, vendored)
- [x] `packages/sdk/test/conformance.test.ts` written (typechecks); env script now needs `LYKIA_BACKEND_DIR` + `LYKIA_CONFORMANCE_WORK` (scratch)
- [x] SDK conformance run vs frozen backend: 8/8 passed (control set => mid-stream error scripted)  - [x] `packages/mcp/test/conformance.test.ts`: 5/5 passed
  (17 tools, 13 prompts, models_list, cost_estimate, file_input→image_generate edit (strength 0.5), output_save image+video+speech from S3 :7825, video_wait, speech)
  Backend observation: MCP `speech_generate` returns `model: null` (preset resolved to elevenlabs); image `width/height: null`, `preview: true`.
- [x] coordinator note #1 (stream final/done: model, provider, preset; onResult provider) done + tests (SDK unit 88 passed)
- [x] note #2 README tsc/.cjs warning (both recipes verified with tsc 6 in scratch) + ARTIFACTS  - [x] note #3 AsyncLocalStorage pattern + versions
- [x] MCP: output_save trusts exact `url` values from remote tools' structuredContent (prod storage host is S3_ENDPOINT, not *.getlykia.com); e2e test added (MCP 42 passed)
- [x] READMEs (sdk, mcp, root)  - [x] 0.2.0 bump (both packages, version.ts, lockfile workspace entries)  - [x] ARTIFACTS 0.2.0 changelog (15 breaking items, compared against the 0.1.4 single files in integration-kit)
- [x] coordinator round 3: raw multipart order test (transcription + voice clone, file parts last); `SpeechCreateParams.voice` optional;
  backend probe: missing voice → 400 bad_request param voice even when the preset has `defaults.voice` (DEFECT: speech.ts
  parses the raw body before preset resolution); fake matches the 400; README notes ai 6.0.197 streaming report.
- [x] conformance rerun (narrator preset added to env script): SDK 8 + MCP 5 = 13/13 passed; backend + mongod stopped
- [x] npm run check: exit 0, 133 passed / 13 skipped (conformance), pack: sdk 15 files, mcp 8 files. RELEASE 0.2.0 DONE.

## 0.2.1 (coordinator follow-up)
- [x] `createAiSdkFetch({ context })` captured per request at start; `info.context` + `info.tags` in onResult; `onError(err, { url, context, tags, generationId })`
- [x] tests `packages/sdk/test/release-0.2.1.test.ts` (6): abort from another context, AI SDK abortSignal, 2 concurrent streams, non-stream, HTTP + mid-stream errors, throwing context
- [x] README per-request section rewritten; ARTIFACTS 0.2.1 entry; both packages 0.2.1; npm run check exit 0 (139 passed / 13 skipped)

## 0.2.2 (coordinator follow-up)
- [x] fake records cost = what was sent (sentCost: X-Lykia-Cost > JSON usage.cost > last stream usage.cost; else 0); chatChunks({ cost })
- [x] speech X-Lykia-Model/Provider → BinaryResult.model/provider; preset default voice (fake option presetDefaults); voices list provider
- [x] video `#output-unavailable`: completed, output null, error video_output_unavailable; content 502
- [x] tests release-0.2.2.test.ts (8); README + ARTIFACTS; 0.2.2; npm run check exit 0 (147 passed / 13 skipped). No real-backend run (load).
