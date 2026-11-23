import type { HttpCore, RequestOptions } from '../core.js';
import type { ImageGenerateParams, ImagesResponse } from '../media-types.js';
import { withMeta } from './shared.js';

export class Images {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /**
   * `POST /images/generations`: generate images, or edit when `images` is given.
   */
  async generate(body: ImageGenerateParams, opts?: RequestOptions): Promise<ImagesResponse> {
    const { data, meta } = await this.#core.json<ImagesResponse>({ method: 'POST', path: '/images/generations', body }, opts);
    return withMeta(data, meta);
  }
}
