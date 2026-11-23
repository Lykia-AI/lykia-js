import { abortedError, type HttpCore, type RequestOptions } from '../core.js';
import { LykiaError } from '../errors.js';
import type { BinaryResult, VideoContentUrl, VideoCreateParams, VideoJob, VideoList, VideoListParams, VideoWaitOptions } from '../media-types.js';
import { encodeId, sleep, withMeta } from './shared.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class Videos {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /**
   * `POST /videos`: start an asynchronous video job → the job object (`status: "queued"`; `id` is the generation id).
   */
  async create(body: VideoCreateParams, opts?: RequestOptions): Promise<VideoJob> {
    const { data, meta } = await this.#core.json<VideoJob>({ method: 'POST', path: '/videos', body }, opts);
    return withMeta(data, meta);
  }

  /**
   * `GET /videos/{id}`: the job: `status` (`queued | in_progress | completed | failed | cancelled`), `progress`,
   * `error`; in a final state `usage.cost`; once completed `duration_seconds` and `output` (a signed URL valid about an
   * hour, re-signed on every read; `output.url` is null when storage is off: use {@link content}).
   */
  async get(id: string, opts?: RequestOptions): Promise<VideoJob> {
    return (await this.#core.json<VideoJob>({ method: 'GET', path: `/videos/${encodeId(id)}` }, opts)).data;
  }

  /**
   * Polls until the job is `completed` (resolves with the job), `failed` (throws `LykiaError` code `video_failed`) or
   * `cancelled` (code `video_cancelled`); the job is the error's `body`, its `error` the `metadata`.
   * Defaults: `intervalMs` 5000, `timeoutMs` 60 minutes (the server's job cap).
   */
  async wait(id: string, options: VideoWaitOptions = {}): Promise<VideoJob> {
    const interval = Math.max(100, options.intervalMs ?? 5000);
    const deadline = Date.now() + (options.timeoutMs ?? 60 * 60 * 1000);
    const opts: RequestOptions = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    };
    for (;;) {
      if (options.signal?.aborted) throw abortedError();
      const job = await this.get(id, opts);
      options.onPoll?.(job);
      if (TERMINAL.has(job.status)) {
        if (job.status === 'failed' || job.status === 'cancelled') {
          const reason = job.error?.reason;
          throw new LykiaError(`Video job ${id} ${job.status}: ${job.error?.message ?? 'unknown error'}`, {
            status: 0,
            code: job.status === 'failed' ? 'video_failed' : 'video_cancelled',
            reason,
            retryable: false,
            body: job,
            ...(job.error ? { metadata: { ...job.error } } : {}),
          });
        }
        return job;
      }
      if (Date.now() + interval > deadline) {
        throw new LykiaError(`Timed out waiting for video job ${id} (last status: ${job.status})`, {
          status: 0,
          code: 'timeout',
          reason: 'timeout',
          retryable: true,
          body: job,
        });
      }
      await sleep(interval, options.signal, () => abortedError());
    }
  }

  /**
   * `GET /videos`: this project's video jobs, newest first. Page with `limit` (≤ 100) and `after`.
   */
  async list(params: VideoListParams = {}, opts?: RequestOptions): Promise<VideoList> {
    return (
      await this.#core.json<VideoList>({ method: 'GET', path: '/videos', query: { limit: params.limit, after: params.after, status: params.status } }, opts)
    ).data;
  }

  /**
   * `POST /videos/{id}/cancel`: cancels a job that is still queued or running (free). A job that cannot be cancelled
   * (finished, or the provider has no cancel) → 409 `job_not_cancellable`.
   */
  async cancel(id: string, opts?: RequestOptions): Promise<VideoJob> {
    return (await this.#core.json<VideoJob>({ method: 'POST', path: `/videos/${encodeId(id)}/cancel` }, opts)).data;
  }

  /**
   * `GET /videos/{id}/content`: the video file. The server redirects to a signed URL (followed without your key) or,
   * when storage is off, streams it. Not finished → 409 `video_not_ready`; past retention → 410 `video_expired`.
   */
  async content(id: string, opts?: RequestOptions): Promise<BinaryResult> {
    return this.#core.binary({ method: 'GET', path: `/videos/${encodeId(id)}/content` }, opts);
  }

  /**
   * `GET /videos/{id}/content?redirect=false`: the signed URL instead of the file (`{ url, expires_at, mime_type }`;
   * about an hour). Only when storage is enabled; otherwise use {@link content}.
   */
  async contentUrl(id: string, opts?: RequestOptions): Promise<VideoContentUrl> {
    return (await this.#core.json<VideoContentUrl>({ method: 'GET', path: `/videos/${encodeId(id)}/content`, query: { redirect: 'false' } }, opts)).data;
  }
}
