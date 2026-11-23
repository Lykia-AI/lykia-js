/** Content sniffing for the media types the Lykia tools accept as input. */

export type MediaKind = 'image' | 'audio';

export interface Sniffed {
  mime: string;
  kind: MediaKind;
}

const ascii = (b: Uint8Array, start: number, end: number) => String.fromCharCode(...b.subarray(start, end));

export function sniff(b: Uint8Array): Sniffed | undefined {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a) return { mime: 'image/png', kind: 'image' };
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (b.length >= 6 && (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a')) return { mime: 'image/gif', kind: 'image' };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE') return { mime: 'audio/wav', kind: 'audio' };
  if (b.length >= 3 && ascii(b, 0, 3) === 'ID3') return { mime: 'audio/mpeg', kind: 'audio' };
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) !== 0) return { mime: 'audio/mpeg', kind: 'audio' };
  if (b.length >= 4 && ascii(b, 0, 4) === 'OggS') return { mime: 'audio/ogg', kind: 'audio' };
  if (b.length >= 4 && ascii(b, 0, 4) === 'fLaC') return { mime: 'audio/flac', kind: 'audio' };
  if (b.length >= 12 && ascii(b, 4, 8) === 'ftyp') {
    const brand = ascii(b, 8, 12);
    if (/^(M4A |M4B )$/.test(brand)) return { mime: 'audio/mp4', kind: 'audio' };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'audio/webm', kind: 'audio' };
  return undefined;
}

const EXT_KIND: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  opus: 'audio',
  flac: 'audio',
  m4a: 'audio',
  mp4: 'audio',
  aac: 'audio',
  webm: 'audio',
};

/** The media kind implied by a file extension, if it is one we know. */
export function kindFromExtension(fileName: string): MediaKind | undefined {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  return EXT_KIND[ext];
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'video/mp4': 'mp4',
};

export function extensionForMime(mime: string | undefined): string | undefined {
  return mime ? MIME_EXT[mime.split(';')[0]!.trim().toLowerCase()] : undefined;
}
