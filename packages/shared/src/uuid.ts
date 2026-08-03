// UUID format gate (R10). Every id that reaches a file path (`songs/<id>/`,
// `trash/<id>-<ts>/`) must pass this first — daemon routes, GUI, CLI and
// core's own path-joining functions all share this single predicate.

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * Lowercase hyphenated UUID v4 — the only id shape lark ever generates
 * (`crypto.randomUUID()`; the Go library used `google/uuid`, same shape).
 * Uppercase, other UUID versions, and anything path-traversal-ish all fail.
 */
export function isUuidV4(value: string): boolean {
  return UUID_V4_RE.test(value);
}
