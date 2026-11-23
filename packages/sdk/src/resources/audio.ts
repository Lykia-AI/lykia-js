import type { HttpCore, RequestOptions } from '../core.js';
import { invalidRequest } from '../errors.js';
import type {
  BinaryResult,
  SpeechCreateParams,
  Transcription,
  TranscriptionCreateParams,
  Voice,
  VoiceCreateParams,
  VoiceDeleted,
  VoiceList,
  VoiceListParams,
} from '../media-types.js';
import { appendTags, encodeId, resolveUpload, withMeta } from './shared.js';

export type SpeechFn = ((body: SpeechCreateParams, opts?: RequestOptions) => Promise<BinaryResult>) & {
  /** Same as calling `audio.speech(...)`. */
  create: (body: SpeechCreateParams, opts?: RequestOptions) => Promise<BinaryResult>;
};

export class Voices {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /**
   * `GET /audio/voices`: preset voices of a model plus the project's clones.
   */
  async list(params: VoiceListParams = {}, opts?: RequestOptions): Promise<VoiceList> {
    return (await this.#core.json<VoiceList>({ method: 'GET', path: '/audio/voices', query: { model: params.model } }, opts)).data;
  }

  /**
   * `POST /audio/voices` (multipart): instant voice clone. `consent: true` is required.
   */
  async create(params: VoiceCreateParams, opts?: RequestOptions): Promise<Voice> {
    if (params.consent !== true) {
      throw invalidRequest("Voice cloning requires consent: true (you confirm you have the speaker's consent).");
    }
    const files = Array.isArray(params.file) ? params.file : [params.file];
    if (files.length === 0) throw invalidRequest('At least one recording is required.');
    const form = new FormData();
    form.append('model', params.model);
    form.append('name', params.name);
    form.append('consent', 'true');
    if (params.description) form.append('description', params.description);
    if (params.language) form.append('language', params.language);
    for (const f of files) {
      const { blob, filename } = await resolveUpload(f, 'voice-sample');
      form.append('file', blob, filename);
    }
    return (await this.#core.json<Voice>({ method: 'POST', path: '/audio/voices', form }, opts)).data;
  }

  /**
   * `DELETE /audio/voices/{id}`: deletes a clone (also at the provider).
   */
  async delete(id: string, opts?: RequestOptions): Promise<VoiceDeleted> {
    return (await this.#core.json<VoiceDeleted>({ method: 'DELETE', path: `/audio/voices/${encodeId(id)}` }, opts)).data;
  }
}

export class Transcriptions {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /**
   * `POST /audio/transcriptions` (multipart): speech to text. With `response_format` `text`, `srt` or `vtt`
   * resolves to a string; otherwise to a {@link Transcription}.
   */
  create(params: TranscriptionCreateParams & { response_format: 'text' | 'srt' | 'vtt' }, opts?: RequestOptions): Promise<string>;
  create(params: TranscriptionCreateParams, opts?: RequestOptions): Promise<Transcription>;
  async create(params: TranscriptionCreateParams, opts?: RequestOptions): Promise<Transcription | string> {
    const { blob, filename } = await resolveUpload(params.file, 'audio');
    const form = new FormData();
    form.append('model', params.model);
    if (params.language) form.append('language', params.language);
    if (params.prompt) form.append('prompt', params.prompt);
    if (params.response_format) form.append('response_format', params.response_format);
    if (params.temperature !== undefined) form.append('temperature', String(params.temperature));
    for (const g of params.timestamp_granularities ?? []) form.append('timestamp_granularities[]', g);
    if (params.provider_options) form.append('provider_options', JSON.stringify(params.provider_options));
    if (params.provider) form.append('provider', JSON.stringify(params.provider));
    appendTags(form, params);
    // The file goes LAST: the gateway then streams it to the provider instead of spooling it to a temporary file.
    form.append('file', blob, filename);
    const fmt = params.response_format;
    if (fmt === 'text' || fmt === 'srt' || fmt === 'vtt') {
      // Plain-text formats: the cost is still in `X-Lykia-Cost` (not returned here; use generations.get()).
      return (await this.#core.text({ method: 'POST', path: '/audio/transcriptions', form }, opts)).data;
    }
    const { data, meta } = await this.#core.json<Transcription>({ method: 'POST', path: '/audio/transcriptions', form }, opts);
    return withMeta(data, meta);
  }
}

export class Audio {
  /**
   * `POST /audio/speech`: text to speech → `{ data: Uint8Array, contentType }`.
   * Callable directly (`audio.speech({...})`) or as `audio.speech.create({...})`.
   */
  readonly speech: SpeechFn;
  readonly voices: Voices;
  readonly transcriptions: Transcriptions;

  constructor(core: HttpCore) {
    const create = (body: SpeechCreateParams, opts?: RequestOptions): Promise<BinaryResult> =>
      core.binary({ method: 'POST', path: '/audio/speech', body, accept: 'audio/*, application/octet-stream' }, opts);
    this.speech = Object.assign(create, { create });
    this.voices = new Voices(core);
    this.transcriptions = new Transcriptions(core);
  }
}
