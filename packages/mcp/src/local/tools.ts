/**
 * Local-only tools added by the bridge on top of the remote Lykia tools:
 *
 * - `file_input`: reads a local image or audio file (inside the allowed directories) and registers it under a short
 *   handle (`lykia-file:<id>`). When a later remote tool call carries the handle as an argument value, the bridge
 *   replaces it with the file as a `data:<mime>;base64,…` URI, the form Lykia tools accept for file inputs. This keeps
 *   megabytes of base64 out of the model's context.
 * - `output_save`: downloads a result (https link on a Lykia host, or a `data:` URI) to a local file.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Settings } from '../config.js';
import { FsAccessError, type FsGuard } from './fs-guard.js';
import { kindFromExtension, sniff, type MediaKind } from './mime.js';

export const FILE_HANDLE_PREFIX = 'lykia-file:';
const HANDLE_RE = /^lykia-file:([a-f0-9]{24})$/;
/** Total bytes of file inputs kept in memory; the oldest are dropped beyond it. */
const STORE_LIMIT_BYTES = 256 * 1024 * 1024;

export class LocalToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LocalToolError';
  }
}

interface StoredFile {
  name: string;
  mime: string;
  bytes: number;
  dataUri: string;
}

/** How many result links are remembered (the oldest are dropped). */
const RESULT_LINKS_LIMIT = 1000;

/**
 * Result links Lykia's own tools returned in this session: string values under a `url` key of a remote tool's
 * `structuredContent` (signed storage links of images, videos, speech). `output_save` accepts exactly these links
 * even when their storage host is not on the download allow-list. Free text (e.g. a chat answer) is never scanned,
 * so a model cannot make a URL "trusted" by writing it.
 */
export class ResultLinks {
  private readonly links = new Set<string>();

  collect(result: unknown): void {
    const sc = result && typeof result === 'object' ? (result as { structuredContent?: unknown }).structuredContent : undefined;
    this.walk(sc, 0);
  }

  has(url: string): boolean {
    return this.links.has(url);
  }

  private walk(value: unknown, depth: number): void {
    if (depth > 8 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const v of value) this.walk(v, depth + 1);
      return;
    }
    for (const [k, v] of Object.entries(value)) {
      if (k === 'url' && typeof v === 'string' && /^https?:\/\//i.test(v) && v.length <= 8192) this.add(v);
      else this.walk(v, depth + 1);
    }
  }

  private add(url: string): void {
    this.links.delete(url);
    this.links.add(url);
    if (this.links.size > RESULT_LINKS_LIMIT) this.links.delete(this.links.values().next().value as string);
  }
}

export class FileHandleStore {
  private readonly files = new Map<string, StoredFile>();
  private total = 0;

  add(file: Omit<StoredFile, 'dataUri'> & { data: Buffer }): string {
    const id = randomBytes(12).toString('hex');
    const dataUri = `data:${file.mime};base64,${file.data.toString('base64')}`;
    this.files.set(id, { name: file.name, mime: file.mime, bytes: file.bytes, dataUri });
    this.total += dataUri.length;
    for (const [key, f] of this.files) {
      if (this.total <= STORE_LIMIT_BYTES || key === id) break;
      this.files.delete(key);
      this.total -= f.dataUri.length;
    }
    return `${FILE_HANDLE_PREFIX}${id}`;
  }

  /** Replaces every string equal to a known handle (at any depth) with its data URI. */
  expand(value: unknown): unknown {
    if (typeof value === 'string') {
      const m = HANDLE_RE.exec(value);
      if (!m) return value;
      const f = this.files.get(m[1]!);
      if (!f) throw new LocalToolError(`Unknown or expired file handle ${value}. Call file_input again for that file.`);
      return f.dataUri;
    }
    if (Array.isArray(value)) return value.map((v) => this.expand(v));
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.expand(v);
      return out;
    }
    return value;
  }
}

export const LOCAL_TOOLS = [
  {
    name: 'file_input',
    title: 'Use a local file as input',
    description:
      'Reads a local image (PNG, JPEG, WebP, GIF) or audio file (MP3, WAV, OGG, FLAC, M4A, WebM) from the working directory ' +
      'or an allowed directory so it can be used as input to Lykia tools: the image to edit, the first or last frame of a ' +
      'video, a voice sample. Returns a short handle such as "lykia-file:…". Put the handle where the Lykia tool expects the ' +
      'file (for example images: ["lykia-file:…"], image, last_frame); the bridge replaces it with the file contents ' +
      '(a data: URI) when it forwards the call. Set inline to true to get the data: URI itself (small files only).',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the working directory.' },
        kind: { type: 'string', enum: ['image', 'audio', 'any'], description: 'Expected kind (default any).' },
        inline: { type: 'boolean', description: 'Return the data: URI instead of a handle (files up to 256 KB).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    annotations: { title: 'Use a local file as input', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'output_save',
    title: 'Save a Lykia result to disk',
    description:
      'Downloads a result returned by a Lykia tool (an https link on a Lykia host, or a data: URI) and saves it to a local ' +
      'file inside the working directory or an allowed directory. Missing parent folders are created. An existing file is ' +
      'not replaced unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The result link (https on a Lykia host) or a data: URI.' },
        path: { type: 'string', description: 'Destination file path, absolute or relative to the working directory.' },
        overwrite: { type: 'boolean', description: 'Replace an existing file (default false).' },
      },
      required: ['url', 'path'],
      additionalProperties: false,
    },
    annotations: { title: 'Save a Lykia result to disk', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
] as const;

export const LOCAL_TOOL_NAMES = new Set<string>(LOCAL_TOOLS.map((t) => t.name));

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

const ok = (data: Record<string, unknown>, text: string): ToolResult => ({ content: [{ type: 'text', text }], structuredContent: data });
export const toolError = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

const INLINE_LIMIT = 256 * 1024;

export async function fileInput(
  args: Record<string, unknown>,
  deps: { guard: FsGuard; store: FileHandleStore; settings: Settings },
): Promise<ToolResult> {
  const path = args['path'];
  const kind = (args['kind'] ?? 'any') as MediaKind | 'any';
  if (typeof path !== 'string' || !path) return toolError('path is required.');
  if (!['image', 'audio', 'any'].includes(kind)) return toolError('kind must be image, audio or any.');
  try {
    const real = await deps.guard.resolveReadable(path);
    const st = await stat(real);
    if (st.size > deps.settings.maxFileBytes) {
      return toolError(
        `File is too large: ${st.size} bytes (limit ${deps.settings.maxFileBytes}; raise it with LYKIA_MCP_MAX_FILE_MB). ` +
          'Large inputs can also be passed as an https link.',
      );
    }
    if (st.size === 0) return toolError('File is empty.');
    const data = await readFile(real);
    const sniffed = sniff(data);
    if (!sniffed) return toolError('Unsupported file type: only PNG, JPEG, WebP, GIF images and MP3, WAV, OGG, FLAC, M4A, WebM audio are accepted.');
    const extKind = kindFromExtension(real);
    if (extKind && extKind !== sniffed.kind) return toolError(`The file extension says ${extKind} but the content is ${sniffed.mime}; refusing a mislabelled file.`);
    if (kind !== 'any' && sniffed.kind !== kind) return toolError(`Expected ${kind}, but the file is ${sniffed.mime}.`);
    const name = basename(real);
    const sha256 = createHash('sha256').update(data).digest('hex');
    if (args['inline'] === true) {
      if (data.length > INLINE_LIMIT) return toolError(`inline is limited to ${INLINE_LIMIT} bytes; use the handle instead.`);
      const dataUri = `data:${sniffed.mime};base64,${data.toString('base64')}`;
      return ok({ data_uri: dataUri, file_name: name, mime_type: sniffed.mime, bytes: data.length, sha256 }, dataUri);
    }
    const handle = deps.store.add({ name, mime: sniffed.mime, bytes: data.length, data });
    const result = { handle, file_name: name, mime_type: sniffed.mime, kind: sniffed.kind, bytes: data.length, sha256 };
    return ok(
      result,
      `${JSON.stringify(result)}\nPass "${handle}" as the file value in the next Lykia tool call (it becomes a data: URI).`,
    );
  } catch (err) {
    return toolError(err instanceof FsAccessError || err instanceof LocalToolError ? err.message : `Could not read the file: ${(err as Error).message}`);
  }
}

function hostAllowed(host: string, allowList: string[]): boolean {
  const h = host.toLowerCase();
  return allowList.some((entry) => (entry.startsWith('*.') ? h.endsWith(entry.slice(1)) && h.length > entry.length - 1 : h === entry));
}

const isLoopback = (host: string) => host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';

export interface OutputSaveDeps {
  guard: FsGuard;
  settings: Settings;
  /** Bearer for requests to the Lykia API origin (never sent elsewhere). */
  bearer: () => Promise<string | undefined>;
  /** Links returned by Lykia tools in this session: accepted even when their host is not on the allow-list. */
  resultLinks?: Pick<ResultLinks, 'has'>;
  signal?: AbortSignal;
}

export async function outputSave(args: Record<string, unknown>, deps: OutputSaveDeps): Promise<ToolResult> {
  const url = args['url'];
  const path = args['path'];
  const overwrite = args['overwrite'] === true;
  if (typeof url !== 'string' || !url) return toolError('url is required.');
  if (typeof path !== 'string' || !path) return toolError('path is required.');
  let dest: { path: string; exists: boolean };
  try {
    dest = await deps.guard.resolveWritable(path);
  } catch (err) {
    return toolError((err as Error).message);
  }
  if (dest.exists && !overwrite) return toolError(`${path} already exists. Pass overwrite: true to replace it, or choose another name.`);

  const tmp = `${dest.path}.lykia-${randomBytes(6).toString('hex')}.part`;
  try {
    await mkdir(dirname(dest.path), { recursive: true });
    let contentType: string | undefined;
    let bytes: number;
    if (url.startsWith('data:')) {
      const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
      if (!m) return toolError('Malformed data: URI.');
      const data = m[2] ? Buffer.from(m[3]!, 'base64') : Buffer.from(decodeURIComponent(m[3]!), 'utf8');
      if (data.length > deps.settings.maxDownloadBytes) return toolError('Data is larger than the download limit.');
      contentType = m[1] || undefined;
      const ws = createWriteStream(tmp, { flags: 'wx', mode: 0o644 });
      await pipeline(Readable.from([data]), ws);
      bytes = data.length;
    } else {
      const res = await fetchAllowed(url, deps);
      contentType = res.headers.get('content-type') ?? undefined;
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > deps.settings.maxDownloadBytes) {
        await res.body?.cancel().catch(() => undefined);
        return toolError(`The file is ${declared} bytes, over the download limit (${deps.settings.maxDownloadBytes}; LYKIA_MCP_MAX_DOWNLOAD_MB).`);
      }
      if (!res.body) return toolError('The download had no body.');
      let count = 0;
      const limit = deps.settings.maxDownloadBytes;
      const counted = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>).on('data', (c: Buffer) => {
        count += c.length;
        if (count > limit) counted.destroy(new LocalToolError(`Download exceeded the limit of ${limit} bytes.`));
      });
      await pipeline(counted, createWriteStream(tmp, { flags: 'wx', mode: 0o644 }), deps.signal ? { signal: deps.signal } : {});
      bytes = count;
    }
    if (overwrite) {
      await rename(tmp, dest.path);
    } else {
      // link() fails if the destination appeared meanwhile: never replace a file without permission.
      try {
        await link(tmp, dest.path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return toolError(`${path} already exists. Pass overwrite: true to replace it.`);
        throw err;
      } finally {
        await unlink(tmp).catch(() => undefined);
      }
    }
    const result = { path: dest.path, bytes, mime_type: contentType ?? null };
    return ok(result, `Saved ${bytes} bytes to ${dest.path}`);
  } catch (err) {
    return toolError(err instanceof LocalToolError ? err.message : `Download failed: ${(err as Error).message}`);
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/**
 * Fetches only from allow-listed Lykia hosts over https (http only for loopback hosts listed explicitly, for local
 * development). Redirects are followed manually (at most 5): a redirect issued by an allow-listed host may point to
 * any https URL (signed storage links), and the bearer is only ever sent to the Lykia API origin itself.
 */
async function fetchAllowed(raw: string, deps: OutputSaveDeps): Promise<Response> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LocalToolError('Invalid URL.');
  }
  const apiOrigins = new Set([new URL(deps.settings.mcpUrl).origin, new URL(deps.settings.baseUrl).origin]);
  const checkFirst = (u: URL) => {
    if (u.username || u.password) throw new LocalToolError('URLs with credentials are not accepted.');
    if (deps.resultLinks?.has(raw) && (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname)))) return;
    const secure = u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback(u.hostname) && deps.settings.downloadHosts.includes(u.hostname));
    if (!secure) throw new LocalToolError('Only https links are accepted.');
    if (!hostAllowed(u.hostname, deps.settings.downloadHosts)) {
      throw new LocalToolError(
        `${u.hostname} is not a Lykia host, so output_save will not fetch it (allowed: ${deps.settings.downloadHosts.join(', ')}; extend with LYKIA_MCP_DOWNLOAD_HOSTS).`,
      );
    }
  };
  checkFirst(url);
  for (let hop = 0; hop <= 5; hop++) {
    const headers: Record<string, string> = { Accept: '*/*' };
    if (apiOrigins.has(url.origin)) {
      const token = await deps.bearer();
      if (token) headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(url, { headers, redirect: 'manual', ...(deps.signal ? { signal: deps.signal } : {}) });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      const next = new URL(res.headers.get('location')!, url);
      if (next.protocol !== 'https:' && !(next.protocol === 'http:' && isLoopback(next.hostname) && isLoopback(url.hostname))) {
        throw new LocalToolError('Refusing a redirect to a non-https URL.');
      }
      url = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new LocalToolError(`The server answered ${res.status} for the download (the link may have expired; signed links last about an hour).`);
    }
    return res;
  }
  throw new LocalToolError('Too many redirects.');
}
