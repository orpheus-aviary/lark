// The skybridge credential file (v0.2 T3a, §4.5 / D1 / D2).
//
// `~/orpheus-aviary-nest/lark/skybridge.toml`, mode 0600, rewritten whole.
// Four sections, and what each one means when it is MISSING matters as much as
// what it says:
//
//   [server]     where to sync, and whether plaintext http was explicitly
//                allowed. Absent → this install is not configured at all.
//   [auth]       the session. Absent → logged out but still configured; the
//                status reports `auth_required` with a reason, not an error.
//   [device]     the id the server issued this machine. Survives a logout, so
//                logging back in reuses the registration instead of leaving a
//                dead device behind on every login.
//   [workspace]  which workspace the device joined.
//
// The file is credential material, so three rules hold everywhere below: it is
// written atomically at 0600 (never opened for in-place editing), it is never
// logged (use `publicSkybridgeCredentials`), and it is never copied by a nest
// backup (§4.5 — a backup is disaster recovery, not a clone).
//
// Parsing is TOLERANT in one direction only: a section that does not carry
// everything it needs is DROPPED rather than half-adopted. A `[auth]` with a
// token but no user id cannot authenticate anything, and carrying it forward
// would produce a session that fails at the first request instead of a clean
// "log in again".

import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { SKYBRIDGE_TEMP_PREFIX, skybridgeConfigPath } from '../paths.js';

export interface SkybridgeServerSection {
  url: string;
  /** The plaintext-http breaker (§3.7). Only ever set by an explicit opt-in. */
  allow_insecure_http?: boolean;
}

export interface SkybridgeAuthSection {
  user_id: string;
  email: string;
  token: string;
  refresh_token?: string;
  /** Access-token expiry, Unix ms. Absent on a server that does not issue one. */
  expires_at?: number;
}

export interface SkybridgeDeviceSection {
  id: string;
  name: string;
}

export interface SkybridgeWorkspaceSection {
  id: string;
}

export interface SkybridgeCredentials {
  server: SkybridgeServerSection;
  auth?: SkybridgeAuthSection;
  device?: SkybridgeDeviceSection;
  workspace?: SkybridgeWorkspaceSection;
}

/** Everything but the secrets — what a status route, a log line or `config-show` may see. */
export interface PublicSkybridgeCredentials {
  server_url: string;
  allow_insecure_http: boolean;
  user_id: string | null;
  email: string | null;
  has_token: boolean;
  has_refresh_token: boolean;
  expires_at: number | null;
  device_id: string | null;
  device_name: string | null;
  workspace_id: string | null;
}

/**
 * Read the credentials, or `null` when this install has none to speak of.
 *
 * `null` covers both "the file is not there" and "the file is there but names
 * no server", because the daemon does the same thing with either: report
 * `configured: false` and wait for a login. A file that cannot be PARSED is a
 * different story and throws — silently treating a syntax error as "logged
 * out" would wipe a working session on the next write.
 *
 * Reading tightens the mode to 0600, exactly like `loadConfig`: every caller
 * (daemon boot, `--direct` unbind) holds the writer lock, and a file this
 * sensitive must not be left world-readable just because nobody wrote to it.
 */
export function readSkybridgeCredentials(path?: string): SkybridgeCredentials | null {
  const filePath = path ?? skybridgeConfigPath();
  if (!existsSync(filePath)) return null;

  tightenPermissions(filePath);
  const parsed = parse(readFileSync(filePath, 'utf-8'));

  const server = readServer(parsed.server);
  if (server === null) return null;

  const credentials: SkybridgeCredentials = { server };
  const auth = readAuth(parsed.auth);
  if (auth !== null) credentials.auth = auth;
  const device = readDevice(parsed.device);
  if (device !== null) credentials.device = device;
  const workspace = readWorkspace(parsed.workspace);
  if (workspace !== null) credentials.workspace = workspace;
  return credentials;
}

/**
 * Replace the file atomically at 0600.
 *
 * Whole-file rewrite, no merge with what is on disk: the caller holds the
 * complete truth (it just logged in, refreshed a token, or dropped a session),
 * and merging would let a stale `[auth]` outlive the logout that removed it.
 */
export function writeSkybridgeCredentials(credentials: SkybridgeCredentials, path?: string): void {
  const filePath = path ?? skybridgeConfigPath();
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `${SKYBRIDGE_TEMP_PREFIX}${randomUUID()}`);
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    writeSync(fd, stringify(toTable(credentials)));
    fchmodSync(fd, 0o600); // against a permissive umask
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  try {
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort temp cleanup — the rename error is the one that matters */
    }
    throw err;
  }

  const finalMode = statSync(filePath).mode & 0o777;
  if (finalMode !== 0o600) {
    throw new Error(
      `${filePath} ended up with mode 0${finalMode.toString(8)}, expected 0600 — it holds a token`,
    );
  }
}

/** Remove the file. Returns whether there was one. */
export function deleteSkybridgeCredentials(path?: string): boolean {
  const filePath = path ?? skybridgeConfigPath();
  try {
    unlinkSync(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * A credential file moved aside, and the two ways to end that.
 *
 * Both the login installer and `unbind` need the same guarantee: they are
 * about to write (or delete) this file as part of a longer sequence that can
 * still fail, and the disk must never be left holding credentials that no
 * longer describe anything. A rename-away is the only move that gives that —
 * a copy could be interrupted halfway.
 */
export interface SkybridgeStash {
  /** True when there was a file to move aside. */
  existed: boolean;
  /** Put it back, discarding whatever the failed sequence wrote. */
  restore(): void;
  /** The sequence committed — drop the old copy. */
  discard(): void;
}

export function stashSkybridgeCredentials(path?: string): SkybridgeStash {
  const filePath = path ?? skybridgeConfigPath();
  if (!existsSync(filePath)) {
    return {
      existed: false,
      // There was nothing here before, so "put it back" means "leave nothing".
      restore: () => {
        try {
          unlinkSync(filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      },
      discard: () => {},
    };
  }

  const stashPath = join(dirname(filePath), `${SKYBRIDGE_TEMP_PREFIX}${randomUUID()}`);
  renameSync(filePath, stashPath);
  return {
    existed: true,
    restore: () => renameSync(stashPath, filePath),
    discard: () => {
      try {
        unlinkSync(stashPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}

/** The projection every log line, status field and `config-show` uses. */
export function publicSkybridgeCredentials(
  credentials: SkybridgeCredentials | null,
): PublicSkybridgeCredentials {
  return {
    server_url: credentials?.server.url ?? '',
    allow_insecure_http: credentials?.server.allow_insecure_http === true,
    user_id: credentials?.auth?.user_id ?? null,
    email: credentials?.auth?.email ?? null,
    has_token: (credentials?.auth?.token.length ?? 0) > 0,
    has_refresh_token: (credentials?.auth?.refresh_token?.length ?? 0) > 0,
    expires_at: credentials?.auth?.expires_at ?? null,
    device_id: credentials?.device?.id ?? null,
    device_name: credentials?.device?.name ?? null,
    workspace_id: credentials?.workspace?.id ?? null,
  };
}

// ─── Internals ─────────────────────────────────────────

function tightenPermissions(filePath: string): void {
  const mode = statSync(filePath).mode & 0o777;
  if ((mode & 0o077) === 0) return;
  try {
    chmodSync(filePath, 0o600);
  } catch (err) {
    throw new Error(
      `${filePath} has unsafe mode 0${mode.toString(8)} and tightening to 0600 failed — refusing to read a token out of it`,
      { cause: err },
    );
  }
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readServer(value: unknown): SkybridgeServerSection | null {
  if (!isTable(value)) return null;
  const url = nonEmptyString(value.url);
  if (url === null) return null;
  const server: SkybridgeServerSection = { url };
  if (value.allow_insecure_http === true) server.allow_insecure_http = true;
  return server;
}

function readAuth(value: unknown): SkybridgeAuthSection | null {
  if (!isTable(value)) return null;
  const userId = nonEmptyString(value.user_id);
  const email = nonEmptyString(value.email);
  const token = nonEmptyString(value.token);
  // All three or nothing: two of them cannot authenticate a request, and a
  // half-session would fail at the first call instead of at the login.
  if (userId === null || email === null || token === null) return null;

  const auth: SkybridgeAuthSection = { user_id: userId, email, token };
  const refresh = nonEmptyString(value.refresh_token);
  if (refresh !== null) auth.refresh_token = refresh;
  if (typeof value.expires_at === 'number' && Number.isFinite(value.expires_at)) {
    auth.expires_at = value.expires_at;
  }
  return auth;
}

function readDevice(value: unknown): SkybridgeDeviceSection | null {
  if (!isTable(value)) return null;
  const id = nonEmptyString(value.id);
  if (id === null) return null;
  return { id, name: nonEmptyString(value.name) ?? '' };
}

function readWorkspace(value: unknown): SkybridgeWorkspaceSection | null {
  if (!isTable(value)) return null;
  const id = nonEmptyString(value.id);
  return id === null ? null : { id };
}

/**
 * Serializable form. Optional fields are omitted rather than written as
 * `undefined` — smol-toml has no representation for that, and an explicit
 * empty string would read back as a real (broken) value.
 */
function toTable(credentials: SkybridgeCredentials): Record<string, unknown> {
  const server: Record<string, unknown> = { url: credentials.server.url };
  if (credentials.server.allow_insecure_http === true) server.allow_insecure_http = true;

  const table: Record<string, unknown> = { server };

  if (credentials.auth !== undefined) {
    const auth: Record<string, unknown> = {
      user_id: credentials.auth.user_id,
      email: credentials.auth.email,
      token: credentials.auth.token,
    };
    if (credentials.auth.refresh_token !== undefined) {
      auth.refresh_token = credentials.auth.refresh_token;
    }
    if (credentials.auth.expires_at !== undefined) auth.expires_at = credentials.auth.expires_at;
    table.auth = auth;
  }

  if (credentials.device !== undefined) {
    table.device = { id: credentials.device.id, name: credentials.device.name };
  }
  if (credentials.workspace !== undefined) {
    table.workspace = { id: credentials.workspace.id };
  }
  return table;
}
