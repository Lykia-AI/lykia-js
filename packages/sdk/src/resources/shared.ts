import type { ResponseMeta } from '../core.js';
import { invalidRequest } from '../errors.js';
import type { FileInput, UploadInput } from '../media-types.js';

/** Unwraps `{ data: {...} }` single-object envelopes (not `{ data: [...] }` lists). */
export function unwrapData<T>(raw: unknown): T {
  if (raw && typeof raw === 'object' && 'data' in raw && !Array.isArray((raw as { data: unknown }).data)) {
    return (raw as { data: T }).data;
  }
  return raw as T;
}

/** Attaches the response metadata as `_meta`. */
export function withMeta<T>(data: T, meta: ResponseMeta): T & { _meta: ResponseMeta } {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return Object.assign(data as object, { _meta: meta }) as T & { _meta: ResponseMeta };
  }
  return data as T & { _meta: ResponseMeta };
}

export function encodeId(id: string): string {
  if (!id || typeof id !== 'string') throw invalidRequest('An id is required.');
  return encodeURIComponent(id);
}

export function toBlob(file: FileInput): Blob {
  const { data, contentType } = file;
  if (data instanceof Blob) return contentType && !data.type ? new Blob([data], { type: contentType }) : data;
  const bytes = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data);
  return new Blob([bytes], { type: contentType ?? 'application/octet-stream' });
}

const EXT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  mpga: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  webm: 'audio/webm',
};

function mimeFromName(name: string): string | undefined {
  return EXT_MIME[name.toLowerCase().split('.').pop() ?? ''];
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || 'audio';
}

/** Loads `node:fs` only when `{ path }` is used, so the client still loads in browsers and on Node 18. */
async function openAsBlob(path: string, type: string | undefined): Promise<Blob> {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown; versions?: { node?: string } } }).process;
  if (!proc?.versions?.node) throw invalidRequest('{ path } uploads need Node.js; pass a Blob or { data, filename } instead.');
  let fs = proc.getBuiltinModule?.('node:fs') as { openAsBlob?: (p: string, o?: { type?: string }) => Promise<Blob> } | undefined;
  if (!fs) {
    const specifier = 'node:fs';
    fs = (await import(/* @vite-ignore */ specifier)) as typeof fs;
  }
  if (typeof fs?.openAsBlob !== 'function') {
    throw invalidRequest('{ path } uploads need fs.openAsBlob (Node.js 20 or newer); pass { data, filename } instead.');
  }
  return fs.openAsBlob(path, type ? { type } : undefined);
}

/**
 * Normalises the accepted upload shapes: `{ data, filename, contentType? }`, a `Blob`/`File`, or (Node.js only)
 * `{ path, filename?, contentType? }`, which streams the file from disk instead of reading it into memory.
 */
export async function resolveUpload(file: UploadInput | undefined, fallbackName: string): Promise<{ blob: Blob; filename: string }> {
  if (file instanceof Blob) {
    const name = (file as { name?: unknown }).name;
    return { blob: file, filename: typeof name === 'string' && name ? name : fallbackName };
  }
  if (file && typeof file === 'object' && 'path' in file && typeof file.path === 'string') {
    const filename = file.filename ?? baseName(file.path);
    const type = file.contentType ?? mimeFromName(filename);
    return { blob: await openAsBlob(file.path, type), filename };
  }
  if (!file || typeof file !== 'object' || !('data' in file) || !file.filename) {
    throw invalidRequest('file must be a Blob/File, { data, filename, contentType? } or { path } (Node.js).');
  }
  return { blob: toBlob(file), filename: file.filename };
}

/** Request tags on multipart uploads: `user` as a field, `metadata` as a JSON string field. */
export function appendTags(form: FormData, tags: { user?: string; metadata?: Record<string, string> }): void {
  if (tags.user !== undefined) form.append('user', tags.user);
  if (tags.metadata !== undefined) form.append('metadata', JSON.stringify(tags.metadata));
}

export function sleep(ms: number, signal: AbortSignal | undefined, onAbort: () => Error): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(onAbort());
    const abort = () => {
      clearTimeout(t);
      reject(onAbort());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
