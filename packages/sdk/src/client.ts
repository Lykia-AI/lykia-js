import { HttpCore, INSPECT, type LykiaOptions } from './core.js';
import { CreditsResource, Generations, Key } from './resources/account.js';
import { Audio } from './resources/audio.js';
import { Models, Providers } from './resources/catalog.js';
import { Chat } from './resources/chat.js';
import { Embeddings } from './resources/embeddings.js';
import { Images } from './resources/images.js';
import { Videos } from './resources/videos.js';

/**
 * Client for the Lykia API (composition root; each resource lives in `resources/`).
 *
 * ```ts
 * import { Lykia } from '@lykia/sdk';
 * const lykia = new Lykia({ apiKey: process.env.LYKIA_API_KEY });
 * const res = await lykia.chat.completions.create({ model: '@text', messages: [{ role: 'user', content: 'Merhaba' }] });
 * ```
 */
export class Lykia {
  readonly chat: Chat;
  readonly embeddings: Embeddings;
  readonly models: Models;
  readonly providers: Providers;
  readonly key: Key;
  readonly credits: CreditsResource;
  readonly generations: Generations;
  readonly images: Images;
  readonly videos: Videos;
  readonly audio: Audio;
  /** The resolved base URL. */
  readonly baseURL: string;

  constructor(options: LykiaOptions = {}) {
    const core = new HttpCore(options);
    this.baseURL = core.baseURL;
    this.chat = new Chat(core);
    this.embeddings = new Embeddings(core);
    this.models = new Models(core);
    this.providers = new Providers(core);
    this.key = new Key(core);
    this.credits = new CreditsResource(core);
    this.generations = new Generations(core);
    this.images = new Images(core);
    this.videos = new Videos(core);
    this.audio = new Audio(core);
  }

  /** `JSON.stringify(lykia)` shows only non-secret settings. */
  toJSON(): Record<string, unknown> {
    return { baseURL: this.baseURL, apiKey: '[redacted]' };
  }

  /** `console.log(lykia)` / `util.inspect` show only non-secret settings. */
  [INSPECT](): string {
    return `Lykia { baseURL: '${this.baseURL}', apiKey: '[redacted]' }`;
  }
}
