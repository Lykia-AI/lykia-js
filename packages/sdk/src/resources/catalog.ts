import type { HttpCore, RequestOptions } from '../core.js';
import { LykiaError } from '../errors.js';
import type { Model, ModelList, ModelListParams, ProviderList } from '../types.js';

export class Models {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /**
   * `GET /models`: the catalog. The default list holds chat models; pass `kind` (`image`, `video`, `speech`,
   * `transcription`) or `output_modalities` (`embedding`, `image`, `video`, `audio`, `transcription`, `all`) for others.
   */
  async list(params: ModelListParams = {}, opts?: RequestOptions): Promise<ModelList> {
    const sp = params.supported_parameters;
    const supported = Array.isArray(sp) ? sp.join(',') : sp;
    const { data } = await this.#core.json<ModelList>(
      {
        method: 'GET',
        path: '/models',
        query: { supported_parameters: supported || undefined, kind: params.kind, output_modalities: params.output_modalities },
      },
      opts,
    );
    return data;
  }

  /**
   * One model by id (chat, embedding or media). The API has no single-model endpoint, so this reads the full catalog
   * (`output_modalities=all`); 404 `not_found` if absent.
   */
  async get(id: string, opts?: RequestOptions): Promise<Model> {
    const list = await this.list({ output_modalities: 'all' }, opts);
    const model = list.data.find((m) => m.id === id || m.canonical_slug === id);
    if (!model) throw new LykiaError(`404 Model ${id} not found`, { status: 404, code: 'not_found', retryable: false });
    return model;
  }
}

export class Providers {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /** `GET /providers`. */
  async list(opts?: RequestOptions): Promise<ProviderList> {
    return (await this.#core.json<ProviderList>({ method: 'GET', path: '/providers' }, opts)).data;
  }
}
