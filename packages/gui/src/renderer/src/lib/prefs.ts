// Renderer-local view preferences (M4-12). Sort order, visible columns and
// column widths live in localStorage, NOT in `lark_config.toml`: they are
// per-window display state, and M2 deliberately dropped the Go version's
// `[display]` config section. M5's settings page reads and writes THIS store
// too — there must not be a second source of truth.
//
// Every entry is `{version, value}` under a `lark.gui.` key. A version bump
// (or anything unparseable) falls back to the default instead of feeding a
// stale shape into the UI.

const PREFIX = 'lark.gui.';

interface Envelope {
  version: number;
  value: unknown;
}

/**
 * Read a preference. `parse` validates the stored value and returns `null` to
 * reject it; a rejection, a version mismatch, malformed JSON and an
 * unavailable localStorage all yield `fallback`.
 */
export function readPref<T>(
  key: string,
  version: number,
  parse: (value: unknown) => T | null,
  fallback: T,
): T {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PREFIX + key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;

  let envelope: Envelope;
  try {
    envelope = JSON.parse(raw) as Envelope;
  } catch {
    return fallback;
  }
  if (typeof envelope !== 'object' || envelope === null) return fallback;
  if (envelope.version !== version) return fallback;
  return parse(envelope.value) ?? fallback;
}

/** Persist a preference. Storage failures (quota, private mode) are ignored:
 * losing a column width must never break the interaction that changed it. */
export function writePref(key: string, version: number, value: unknown): void {
  try {
    window.localStorage.setItem(
      PREFIX + key,
      JSON.stringify({ version, value } satisfies Envelope),
    );
  } catch {
    // Preferences are a convenience; the session works without them.
  }
}

/** Narrow an unknown to a record of finite positive numbers (column widths). */
export function asWidthMap(value: unknown): Record<string, number> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, width] of Object.entries(value)) {
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0) return null;
    out[key] = width;
  }
  return out;
}
