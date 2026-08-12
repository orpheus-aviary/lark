// Payload validation primitives (v0.2 T1, §3.1).
//
// This is the external-data boundary: everything here runs on JSON another
// device wrote, possibly a build newer or older than this one. Two rules shape
// the style:
//
//   Required fields are checked, unknown fields are IGNORED. A peer that
//   learned a new field must not have its changes rejected wholesale — that
//   would be a permanent divergence between two libraries that both work.
//
//   A rejection is never a throw that kills the batch. The caller turns it
//   into an inbound dead letter, skips the change, and lets the cursor move
//   on (§3.8) — one bad change cannot wedge the pull forever.

/** A payload field failed validation. Carries the field for the archive. */
export class PayloadValidationError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`${field} ${detail}`);
    this.name = 'PayloadValidationError';
    this.field = field;
  }
}

// A declaration, not a const arrow: only declared functions get TypeScript's
// never-returns narrowing, which is what lets the checks below read as guards
// instead of casts.
function fail(field: string, detail: string): never {
  throw new PayloadValidationError(field, detail);
}

export function asObject(raw: unknown, field = 'payload'): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail(field, 'must be an object');
  }
  return raw as Record<string, unknown>;
}

export interface StringOptions {
  maxLength: number;
  /** Allow `''`. Off by default — an empty name is not a name. */
  allowEmpty?: boolean;
}

export function reqString(
  obj: Record<string, unknown>,
  field: string,
  options: StringOptions,
): string {
  const value = obj[field];
  if (typeof value !== 'string') fail(field, 'must be a string');
  if (!options.allowEmpty && value === '') fail(field, 'must not be empty');
  if (value.length > options.maxLength) {
    fail(field, `must be at most ${options.maxLength} characters`);
  }
  return value;
}

/** A string field that is allowed to be explicitly null (never undefined). */
export function reqNullableString(
  obj: Record<string, unknown>,
  field: string,
  options: StringOptions,
): string | null {
  if (obj[field] === null) return null;
  return reqString(obj, field, options);
}

export interface IntOptions {
  min?: number;
}

export function reqSafeInt(
  obj: Record<string, unknown>,
  field: string,
  options: IntOptions = {},
): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    // Beyond 2^53 the arithmetic that orders keys stops being exact, so an
    // unsafe integer is not "a big timestamp" — it is a number this build
    // cannot compare correctly.
    fail(field, 'must be a safe integer');
  }
  if (options.min !== undefined && value < options.min) fail(field, `must be >= ${options.min}`);
  return value;
}

export function reqFinite(
  obj: Record<string, unknown>,
  field: string,
  options: IntOptions = {},
): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(field, 'must be a finite number');
  }
  if (options.min !== undefined && value < options.min) fail(field, `must be >= ${options.min}`);
  return value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function reqUuid(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail(field, 'must be a UUIDv4');
  return value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The LWW key every put and tombstone carries. */
export interface ParsedLwwFields {
  updated_at_ms: number;
  lww_counter: number;
}

export function reqLwwFields(obj: Record<string, unknown>): ParsedLwwFields {
  return {
    updated_at_ms: reqSafeInt(obj, 'updated_at_ms', { min: 0 }),
    lww_counter: reqSafeInt(obj, 'lww_counter', { min: 0 }),
  };
}
