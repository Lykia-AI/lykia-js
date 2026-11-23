import type { HttpCore, RequestOptions } from '../core.js';
import { invalidRequest } from '../errors.js';
import type { Credits, Generation, GenerationList, GenerationListParams, KeyInfo } from '../types.js';
import { unwrapData } from './shared.js';

export class Key {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /** `GET /key`: label, limit, usage and remaining amount of the credential in use, plus its company and project. */
  async get(opts?: RequestOptions): Promise<KeyInfo> {
    return unwrapData<KeyInfo>((await this.#core.json({ method: 'GET', path: '/key' }, opts)).data);
  }
}

export class CreditsResource {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /** `GET /credits`: balance, total usage, reserved, available (USD); `billing_mode: "internal"` for internal-use companies. */
  async get(opts?: RequestOptions): Promise<Credits> {
    return unwrapData<Credits>((await this.#core.json({ method: 'GET', path: '/credits' }, opts)).data);
  }
}

export class Generations {
  readonly #core: HttpCore;
  constructor(core: HttpCore) {
    this.#core = core;
  }

  /** `GET /generation?id=`: one request record (cost, tokens, provider, timing, tags). */
  async get(id: string, opts?: RequestOptions): Promise<Generation> {
    if (!id) throw invalidRequest('A generation id is required.');
    return unwrapData<Generation>((await this.#core.json({ method: 'GET', path: '/generation', query: { id } }, opts)).data);
  }

  /**
   * `GET /generations`: request records, newest first, filtered by `user`, `preset`, `model`, time range and
   * `metadata` tags (`metadata.<key>=<value>`). Page with `limit` and `after`.
   */
  async list(params: GenerationListParams = {}, opts?: RequestOptions): Promise<GenerationList> {
    const query: Record<string, string | number | boolean | undefined> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === 'metadata' && v && typeof v === 'object') {
        for (const [mk, mv] of Object.entries(v)) query[`metadata.${mk}`] = mv;
      } else if (v !== undefined && typeof v !== 'object') {
        query[k] = v;
      }
    }
    return (await this.#core.json<GenerationList>({ method: 'GET', path: '/generations', query }, opts)).data;
  }
}
