import type { HttpCore, RequestOptions } from '../core.js';
import type { CreateEmbeddingResponse, EmbeddingCreateParams } from '../types.js';
import { withMeta } from './shared.js';

export class Embeddings {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /** `POST /embeddings` (OpenAI compatible); `usage.cost` is the cost in USD. */
  async create(body: EmbeddingCreateParams, opts?: RequestOptions): Promise<CreateEmbeddingResponse> {
    const { data, meta } = await this.#core.json<CreateEmbeddingResponse>({ method: 'POST', path: '/embeddings', body }, opts);
    return withMeta(data, meta);
  }
}
