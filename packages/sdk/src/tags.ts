import { PRESET_NAME_PATTERN } from './preset.js';

/** Suggested preset names (CORE_MODEL §13.1 + §13.7). Companies may define others. */
export const PRESETS = Object.freeze([
  'text',
  'fast',
  'reasoning',
  'vision',
  'image',
  'video',
  'embedding',
  'tts',
  'stt',
  'assistant',
  'writer',
  'translate',
  'search',
] as const);

export type PresetName = (typeof PRESETS)[number];

/** Endpoint kind each suggested preset is meant for (a preset used on another kind of endpoint is a 400). */
export type PresetModality = 'chat' | 'embedding' | 'image' | 'video' | 'speech' | 'transcription';

export const PRESET_MODALITY: Readonly<Record<PresetName, PresetModality>> = Object.freeze({
  text: 'chat',
  fast: 'chat',
  reasoning: 'chat',
  vision: 'chat',
  assistant: 'chat',
  writer: 'chat',
  translate: 'chat',
  search: 'chat',
  image: 'image',
  video: 'video',
  embedding: 'embedding',
  tts: 'speech',
  stt: 'transcription',
});

/** Request tag limits (CORE_MODEL §13.4). */
export const TAG_LIMITS = Object.freeze({ userMaxLength: 128, metadataMaxKeys: 16, metadataKeyMaxLength: 64, metadataValueMaxLength: 512 });

export interface SanitizedTags {
  user?: string;
  metadata?: Record<string, string>;
  /** One line per change, e.g. `user truncated from 200 to 128 characters`. */
  warnings: string[];
  /** The original values that were removed or shortened (`user`, `metadata.<key>`); present only when something was. */
  dropped?: Record<string, unknown>;
}

/**
 * Fits `user` / `metadata` to the request tag limits without ever throwing, so a bad tag never breaks a generation:
 * `user` becomes a string cut at 128 characters; in `metadata` numbers and booleans become strings, other values,
 * keys longer than 64 characters and keys starting with `$` or containing `.` are dropped, values are cut at
 * 512 characters and only the first 16 keys are kept.
 */
export function sanitizeTags(tags: { user?: unknown; metadata?: unknown } | undefined | null): SanitizedTags {
  const warnings: string[] = [];
  const dropped: Record<string, unknown> = {};
  const out: SanitizedTags = { warnings };
  const t = tags ?? {};
  if (t.user !== undefined && t.user !== null) {
    if (typeof t.user === 'string' || typeof t.user === 'number' || typeof t.user === 'bigint') {
      let u = String(t.user);
      if (u.length > TAG_LIMITS.userMaxLength) {
        warnings.push(`user truncated from ${u.length} to ${TAG_LIMITS.userMaxLength} characters`);
        dropped['user'] = u;
        u = u.slice(0, TAG_LIMITS.userMaxLength);
      }
      if (u) out.user = u;
    } else {
      warnings.push('user dropped: must be a string');
      dropped['user'] = t.user;
    }
  }
  if (t.metadata !== undefined && t.metadata !== null) {
    if (typeof t.metadata !== 'object' || Array.isArray(t.metadata)) {
      warnings.push('metadata dropped: must be an object of strings');
      dropped['metadata'] = t.metadata;
    } else {
      const md: Record<string, string> = {};
      let count = 0;
      for (const [k, v] of Object.entries(t.metadata as Record<string, unknown>)) {
        if (v === undefined) continue;
        if (k.length === 0 || k.length > TAG_LIMITS.metadataKeyMaxLength) {
          warnings.push(`metadata key dropped (length ${k.length}): ${k.slice(0, 32)}`);
          dropped[`metadata.${k}`] = v;
          continue;
        }
        if (k.startsWith('$') || k.includes('.')) {
          warnings.push(`metadata key dropped (must not start with "$" or contain "."): ${k.slice(0, 32)}`);
          dropped[`metadata.${k}`] = v;
          continue;
        }
        let s: string;
        if (typeof v === 'string') s = v;
        else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') s = String(v);
        else {
          warnings.push(`metadata.${k} dropped: value must be a string`);
          dropped[`metadata.${k}`] = v;
          continue;
        }
        if (count >= TAG_LIMITS.metadataMaxKeys) {
          warnings.push(`metadata.${k} dropped: more than ${TAG_LIMITS.metadataMaxKeys} keys`);
          dropped[`metadata.${k}`] = v;
          continue;
        }
        if (s.length > TAG_LIMITS.metadataValueMaxLength) {
          warnings.push(`metadata.${k} truncated from ${s.length} to ${TAG_LIMITS.metadataValueMaxLength}`);
          dropped[`metadata.${k}`] = s;
          s = s.slice(0, TAG_LIMITS.metadataValueMaxLength);
        }
        md[k] = s;
        count++;
      }
      if (count > 0) out.metadata = md;
    }
  }
  if (Object.keys(dropped).length) out.dropped = dropped;
  return out;
}

/** Whether a preset name has the valid shape (it may still be undefined for your company). */
export function isValidPresetName(name: string): boolean {
  return PRESET_NAME_PATTERN.test(name);
}
