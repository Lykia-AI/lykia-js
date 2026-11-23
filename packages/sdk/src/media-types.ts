/**
 * Types for the media endpoints: images, video, speech, voices, transcriptions (backend `docs/MEDIA.md`).
 */

import type { ResponseMeta } from './core.js';
import type { CostDetails, ModelId, ProviderPreferences, RequestTags } from './types.js';

/** A file to upload: raw bytes (or a Blob) with a file name and MIME type. */
export interface FileInput {
  data: Uint8Array | ArrayBuffer | Blob;
  filename: string;
  contentType?: string;
}

/** A file on disk (Node.js only): streamed with `fs.openAsBlob`, not read into memory. */
export interface PathInput {
  path: string;
  filename?: string;
  contentType?: string;
}

/** Accepted upload shapes. */
export type UploadInput = FileInput | PathInput | Blob;

/** Binary result (audio, video). */
export interface BinaryResult {
  data: Uint8Array;
  contentType: string;
  /** `X-Generation-Id` of the request. */
  generationId: string | undefined;
  /** `X-Lykia-Cost`: what the request cost in USD. */
  cost: number | undefined;
  /** `X-Lykia-Model`: the model that served the request (speech; a preset resolves to a concrete model). */
  model: string | undefined;
  /** `X-Lykia-Provider`: the provider that served the request (speech). */
  provider: string | undefined;
  _meta: ResponseMeta;
}

/** Media usage block (`usage` of image, video and transcription results). */
export interface MediaUsage {
  /** USD charged (0 for BYOK, failed or cancelled jobs). */
  cost: number;
  is_byok: boolean;
  cost_details: CostDetails;
  /** Images: how many were billed. */
  images?: number;
  /** Billing units reported by the provider (e.g. `{ image: 1 }`, `{ tokens: 108000 }`). */
  units?: Record<string, number>;
  [key: string]: unknown;
}

/**
 * An input image: an https URL, a `data:<mime>;base64,…` URI, `{ url }`, `{ image_url: { url } }` or
 * `{ b64_json, mime_type }`.
 */
export type ImageInput = string | { url: string } | { image_url: { url: string } } | { b64_json: string; mime_type: string };

/** `POST /images/generations`: generate images, or edit/reference when `images` is given. */
export interface ImageGenerateParams extends RequestTags {
  /** Image model (`author/model`) or an image preset (`@image`). */
  model: ModelId;
  prompt: string;
  /** 1–16 (the model's `maxN`). */
  n?: number;
  /** e.g. `1024x1024` (model dependent; unsupported values → 400 `unsupported_input` with `metadata.param`). */
  size?: string;
  /** e.g. `16:9`. */
  aspect_ratio?: string;
  /** e.g. `1K`, `2K`, `4K`. */
  resolution?: string;
  quality?: string;
  seed?: number;
  /** e.g. `png`, `jpeg`, `webp`. */
  output_format?: string;
  /** `url` (default when storage is enabled: signed, about 1 hour) or `b64_json`. */
  response_format?: 'url' | 'b64_json';
  /** Source images for editing / reference (at most 16). */
  images?: ImageInput[];
  /** Mask for models that support it (same forms as `images`). */
  mask?: ImageInput;
  /** Provider-specific settings from the model's allow-list (others → 400 `unsupported_input`). */
  provider_options?: Record<string, unknown>;
  models?: ModelId[];
  provider?: ProviderPreferences;
  [key: string]: unknown;
}

export interface ImageData {
  /** Signed URL of the stored image (about 1 hour). */
  url?: string;
  /** ISO time when `url` expires. */
  expires_at?: string;
  /** The provider's bytes, base64 (with `response_format: "b64_json"` or when storage is off). */
  b64_json?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  revised_prompt?: string;
  [key: string]: unknown;
}

export interface ImagesResponse {
  /** Generation id (also `X-Generation-Id`). */
  id: string;
  object: 'image.generation';
  created: number;
  /** The model that produced the images. */
  model: string;
  provider: string;
  data: ImageData[];
  usage: MediaUsage;
  _meta: ResponseMeta;
  [key: string]: unknown;
}

/** `POST /videos`: an asynchronous job. */
export interface VideoCreateParams extends RequestTags {
  /** Video model or a video preset (`@video`). */
  model: ModelId;
  prompt: string;
  /** First frame (https URL or `data:` URI). */
  image?: string;
  last_frame?: string;
  /** Reference images (at most 32). */
  reference_images?: string[];
  /** Seconds. */
  duration?: number;
  aspect_ratio?: string;
  resolution?: string;
  /** Generate an audio track where the model supports it. */
  audio?: boolean;
  seed?: number;
  provider_options?: Record<string, unknown>;
  models?: ModelId[];
  provider?: ProviderPreferences;
  [key: string]: unknown;
}

export type VideoStatus = 'queued' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface VideoOutput {
  /** Signed URL (about 1 hour; a new one on every read), or `null` when storage is off (use `content`). */
  url: string | null;
  /** ISO time when `url` expires. */
  expires_at?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  bytes?: number;
  /** When `url` is null: the path to stream the file from (`GET /v1/videos/{id}/content`). */
  content?: string;
  [key: string]: unknown;
}

export interface VideoJob {
  /** Job id = generation id (`gen-…`). */
  id: string;
  object: 'video';
  status: VideoStatus | (string & {});
  /** 0–100. */
  progress: number;
  model: string;
  provider: string;
  /** Unix seconds. */
  created_at: number;
  completed_at: number | null;
  /** Unix seconds when the stored output is deleted (retention). */
  expires_at: number | null;
  /** Seconds of video, once completed. */
  duration_seconds: number | null;
  params?: Record<string, unknown>;
  /**
   * For failed or cancelled jobs, and for a completed job whose output could not be stored (`output: null`,
   * code `video_output_unavailable`, reason `provider_error`; `content` then answers 502 with that code).
   */
  error?: {
    message: string;
    code: 'video_output_unavailable' | (string & {});
    reason?: string;
    retryable?: boolean;
    billed_by_provider?: boolean;
    [key: string]: unknown;
  };
  /** In a final state. */
  usage?: MediaUsage;
  /** Once completed; `null` when the completed output could not be stored (see `error`). */
  output?: VideoOutput | null;
  /** Present on the result of `videos.create`. */
  _meta?: ResponseMeta;
  [key: string]: unknown;
}

export interface VideoList {
  object: 'list';
  data: VideoJob[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface VideoListParams {
  /** 1–100 (default 20). */
  limit?: number;
  /** Cursor: a job id from `next_cursor`. */
  after?: string;
  status?: VideoStatus;
}

/** `GET /videos/{id}/content?redirect=false`. */
export interface VideoContentUrl {
  url: string;
  expires_at: string;
  mime_type: string;
  [key: string]: unknown;
}

export interface VideoWaitOptions {
  /** Poll interval in milliseconds (default 5000). */
  intervalMs?: number;
  /** Give up after this many milliseconds (default 60 minutes, the server-side job cap). */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called after every poll. */
  onPoll?: (job: VideoJob) => void;
  /** Per-poll request options. */
  headers?: Record<string, string>;
}

/** `POST /audio/speech` (OpenAI compatible). */
export interface SpeechCreateParams extends RequestTags {
  /** Speech model or a speech preset (`@tts`). */
  model: ModelId;
  input: string;
  /**
   * A preset voice id or one of this project's clones (`lvc_…`). Optional: without it the gateway uses the preset's
   * default voice (`defaults.voice` of a `@tts` preset). When neither gives one: 400 `bad_request` (`param: "voice"`).
   */
  voice?: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
  language?: string;
  /** Style instructions, on models that support them. */
  instructions?: string;
  provider_options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Voice {
  /** Preset voice id, or `lvc_…` for this project's clones. */
  id: string;
  object: 'voice';
  name: string;
  /** `premade`, `cloned`, … */
  category: string;
  provider: string;
  language?: string | null;
  description?: string | null;
  labels?: Record<string, string>;
  /** Clones. */
  model?: string;
  /** Clones, unix seconds. */
  created_at?: number;
  /** Clones. */
  requires_verification?: boolean;
  [key: string]: unknown;
}

export interface VoiceList {
  object: 'list';
  /** The model the list is for. */
  model: string;
  /** The provider of that model. */
  provider: string;
  data: Voice[];
}

export interface VoiceListParams {
  /** Default: the `@tts` preset's model. */
  model?: string;
}

/** `POST /audio/voices`: instant voice clone. */
export interface VoiceCreateParams {
  model: ModelId;
  /** At most 100 characters. */
  name: string;
  /** The recording(s): at most 25 files, 10 MB each, audio. */
  file: UploadInput | UploadInput[];
  /** Must be `true`: you confirm you have the speaker's permission (written to the audit log). Missing → 400 `consent_required`. */
  consent: true;
  description?: string;
  language?: string;
}

export interface VoiceDeleted {
  id: string;
  object: 'voice';
  deleted: true;
  [key: string]: unknown;
}

export type TranscriptionFormat = 'json' | 'text' | 'srt' | 'verbose_json' | 'vtt' | 'diarized_json';

/** `POST /audio/transcriptions` (OpenAI compatible, multipart; at most 25 MB). */
export interface TranscriptionCreateParams extends RequestTags {
  /** Transcription model or a preset (`@stt`). */
  model: ModelId;
  /** The audio: `{ data, filename }`, a `Blob`/`File`, or `{ path }` on Node.js. Sent as the LAST multipart part so the gateway can stream it. */
  file: UploadInput;
  language?: string;
  prompt?: string;
  response_format?: TranscriptionFormat;
  timestamp_granularities?: Array<'word' | 'segment'>;
  temperature?: number;
  /** Sent as a JSON string field. */
  provider_options?: Record<string, unknown>;
  /** Sent as a JSON string field. */
  provider?: ProviderPreferences;
}

export interface Transcription {
  text: string;
  language?: string;
  duration?: number;
  segments?: Array<{ id?: number; start: number; end: number; text: string; [key: string]: unknown }>;
  words?: Array<{ word: string; start: number; end: number; [key: string]: unknown }>;
  usage?: MediaUsage;
  _meta: ResponseMeta;
  [key: string]: unknown;
}
