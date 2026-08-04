// Route input contract (M2-16).
//
// Two rules make everything else fall out:
//
//   1. UNKNOWN FIELDS ARE ERRORS — in bodies and in query strings alike. A
//      silently ignored `?srot=name` or `{ nmae: … }` looks like it worked and
//      quietly returns the default ordering / leaves the field unchanged; the
//      caller only finds out much later, from data.
//   2. LENGTH AND RANGE ARE GUARDRAILS, NOT PRODUCT LIMITS — 500-char names,
//      1000-item batches. They exist so a malformed or hostile request cannot
//      turn into unbounded work; the semantics of a value (is this a valid
//      source triple?) stay in core, which owns the invariant.
//
// Violations throw {@link InvalidRequestError}, whose `statusCode` puts it in
// the error handler's "expected 4xx" class: the envelope carries the code, and
// nothing lands in the error log.

import { isUuidV4 } from '@lark/shared';

export class InvalidRequestError extends Error {
  readonly statusCode = 400;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

const invalidBody = (msg: string): InvalidRequestError =>
  new InvalidRequestError('INVALID_BODY', msg);
const invalidQuery = (msg: string): InvalidRequestError =>
  new InvalidRequestError('INVALID_QUERY', msg);

// ─── Bodies ────────────────────────────────────────────

/** The request body as an object, rejecting arrays, null and non-JSON. */
export function objectBody(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalidBody('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).find((k) => !allowed.includes(k));
  if (unknown !== undefined) throw invalidBody(`unknown field: ${unknown}`);
  return record;
}

/** A patch body must actually patch something. */
export function requireFields(body: Record<string, unknown>): Record<string, unknown> {
  if (Object.keys(body).length === 0) throw invalidBody('request body must not be empty');
  return body;
}

export interface StringOptions {
  maxLength: number;
  /** Allow `''` after trimming (artist can be cleared; name cannot). */
  allowEmpty?: boolean;
  /** Allow an explicit `null` (clears an optional column). */
  nullable?: boolean;
}

/**
 * A trimmed string field. Trimming happens BEFORE the length check and the
 * trimmed value is what gets stored — `'  '` must not become a valid name and
 * a stray trailing space must not become part of the data.
 */
export function optionalString(
  body: Record<string, unknown>,
  key: string,
  options: StringOptions,
): string | null | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (value === null) {
    if (options.nullable) return null;
    throw invalidBody(`${key} must be a string`);
  }
  if (typeof value !== 'string') throw invalidBody(`${key} must be a string`);
  const trimmed = value.trim();
  if (trimmed === '' && options.allowEmpty !== true) {
    throw invalidBody(`${key} must not be empty`);
  }
  if (trimmed.length > options.maxLength) {
    throw invalidBody(`${key} must be at most ${options.maxLength} characters`);
  }
  return trimmed;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
  options: StringOptions,
): string {
  const value = optionalString(body, key, options);
  if (value === undefined || value === null) throw invalidBody(`${key} is required`);
  return value;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw invalidBody(`${key} must be a boolean`);
  return value;
}

export function requiredBoolean(body: Record<string, unknown>, key: string): boolean {
  const value = optionalBoolean(body, key);
  if (value === undefined) throw invalidBody(`${key} is required`);
  return value;
}

/** A finite number (never NaN / Infinity — both survive `typeof === 'number'`). */
export function optionalNumber(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number } = {},
): number | undefined {
  const value = body[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalidBody(`${key} must be a finite number`);
  }
  if (options.min !== undefined && value < options.min) {
    throw invalidBody(`${key} must be >= ${options.min}`);
  }
  return value;
}

export function requiredNumber(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number } = {},
): number {
  const value = optionalNumber(body, key, options);
  if (value === undefined) throw invalidBody(`${key} is required`);
  return value;
}

export function requiredSafeInteger(
  body: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalidBody(`${key} must be an integer`);
  }
  if (options.min !== undefined && value < options.min) {
    throw invalidBody(`${key} must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw invalidBody(`${key} must be <= ${options.max}`);
  }
  return value;
}

export function requiredUuid(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !isUuidV4(value)) {
    throw new InvalidRequestError('INVALID_ID', `${key} must be a UUID v4`);
  }
  return value;
}

export function optionalUuid(body: Record<string, unknown>, key: string): string | undefined {
  if (body[key] === undefined) return undefined;
  return requiredUuid(body, key);
}

/** A non-empty, bounded list of ids. */
export function requiredUuidList(
  body: Record<string, unknown>,
  key: string,
  maxLength: number,
): string[] {
  const value = body[key];
  if (!Array.isArray(value)) throw invalidBody(`${key} must be an array`);
  if (value.length === 0) throw invalidBody(`${key} must not be empty`);
  if (value.length > maxLength) throw invalidBody(`${key} must hold at most ${maxLength} ids`);
  for (const item of value) {
    if (typeof item !== 'string' || !isUuidV4(item)) {
      throw new InvalidRequestError('INVALID_ID', `${key} must contain only UUID v4 ids`);
    }
  }
  return value as string[];
}

// ─── Path params ───────────────────────────────────────

/** A `:id` path parameter that must be a UUID v4 before it reaches a file path (R10). */
export function pathUuid(value: string): string {
  if (!isUuidV4(value)) {
    throw new InvalidRequestError('INVALID_ID', `invalid id: ${JSON.stringify(value)}`);
  }
  return value;
}

// ─── Query strings ─────────────────────────────────────

/** Query values arrive as strings, so every check here is string-shaped. */
export function queryParams(
  query: unknown,
  allowed: readonly string[],
): Record<string, string | undefined> {
  const record = (query ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(record).find((k) => !allowed.includes(k));
  if (unknown !== undefined) throw invalidQuery(`unknown query field: ${unknown}`);
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (typeof value !== 'string') throw invalidQuery(`${key} must be given once`);
    out[key] = value;
  }
  return out;
}

export function queryEnum<T extends string>(
  query: Record<string, string | undefined>,
  key: string,
  domain: readonly T[],
): T | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  if (!(domain as readonly string[]).includes(value)) {
    throw invalidQuery(`${key} must be one of: ${domain.join(', ')}`);
  }
  return value as T;
}

export function queryString(
  query: Record<string, string | undefined>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = query[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw invalidQuery(`${key} must be at most ${maxLength} characters`);
  }
  return trimmed;
}

export function queryInteger(
  query: Record<string, string | undefined>,
  key: string,
  options: { min: number; max?: number },
): number | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw invalidQuery(`${key} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw invalidQuery(`${key} is out of range`);
  if (value < options.min) throw invalidQuery(`${key} must be >= ${options.min}`);
  if (options.max !== undefined && value > options.max) {
    throw invalidQuery(`${key} must be <= ${options.max}`);
  }
  return value;
}
