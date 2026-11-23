import { invalidRequest } from './errors.js';

/** Allowed preset names: lowercase letter first, then up to 31 lowercase letters, digits or hyphens. */
export const PRESET_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Builds a model preset reference: `preset('text')` → `'@text'`.
 *
 * Presets are defined in the Lykia dashboard (company or project level) and map a name to a model,
 * fallbacks and default parameters. Use the result anywhere a `model` is accepted. The response's
 * `model` field carries the real model id, and the `X-Lykia-Preset` header (`response.preset`) the name.
 *
 * Throws if the name does not match {@link PRESET_NAME_PATTERN}. A leading `@` is accepted.
 */
export function preset(name: string): `@${string}` {
  const bare = name.startsWith('@') ? name.slice(1) : name;
  if (!PRESET_NAME_PATTERN.test(bare)) {
    throw invalidRequest(
      `Invalid preset name "${name}": use 1–32 characters, a lowercase letter first, then lowercase letters, digits or hyphens.`,
    );
  }
  return `@${bare}`;
}

/** Whether a model string is a preset reference (`@name`). */
export function isPreset(model: string): boolean {
  return model.startsWith('@') && PRESET_NAME_PATTERN.test(model.slice(1));
}
