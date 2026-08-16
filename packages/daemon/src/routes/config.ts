// `GET /config` (redacted) and `PATCH /config` (whitelisted) — R14 / M2-12.
//
// The write path is clone → save → swap, in that order:
//
//   1. `structuredClone(ctx.config)` — never mutate the live config,
//   2. validate + assign field by field into the CLONE,
//   3. `saveConfig(clone)` — disk is the commit point,
//   4. only then `ctx.config = clone`.
//
// owl mutated memory first and saved after, so a failed write left the daemon
// serving a config that does not exist on disk — and the next reader (a GUI
// restart) silently disagreed with the running daemon.
//
// The commit point is narrower than "saveConfig returned": the rename is
// atomic, but the final 0600 permission assertion happens AFTER it. So a
// failure can mean either "disk untouched" or "disk already updated", and the
// recovery cannot assume which — it RELOADS from disk and adopts whatever is
// really there. If even that fails, the daemon has no idea what its own
// config is: it answers the request first, then asks to die (never awaiting
// the teardown, which would deadlock against this very request).

import { loadConfig, redactConfig, saveConfig } from '@lark/core';
import { API_PATHS, LLM_API_FORMATS, LOG_LEVELS, type LarkConfig, THEME_MODES } from '@lark/shared';
import type { FastifyInstance } from 'fastify';
import { scheduleEvictionInBackground } from '../cache.js';
import type { AppContext } from '../context.js';
import { fail, ok } from '../response.js';
import { InvalidRequestError } from '../validation.js';

const URL_MAX = 2048;
const STRING_MAX = 500;

/**
 * `path` rides along in the envelope's `details` (M5-20) so the settings page
 * can mark the offending field without parsing the English message. It is the
 * dotted config path wherever one exists — `'log.level'`, or just `'log'` for
 * a malformed section; a whole-body complaint carries none.
 */
const invalidConfig = (message: string, path?: string): InvalidRequestError =>
  new InvalidRequestError('INVALID_CONFIG', message, path === undefined ? undefined : { path });

type FieldValidator = (value: unknown, path: string) => unknown;

function text(maxLength: number): FieldValidator {
  return (value, path) => {
    if (typeof value !== 'string') throw invalidConfig(`${path} must be a string`, path);
    if (value.length > maxLength) {
      throw invalidConfig(`${path} must be at most ${maxLength} characters`, path);
    }
    return value;
  };
}

function number(options: { min: number; integer?: boolean }): FieldValidator {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw invalidConfig(`${path} must be a finite number`, path);
    }
    if (options.integer && !Number.isInteger(value)) {
      throw invalidConfig(`${path} must be an integer`, path);
    }
    if (value < options.min) throw invalidConfig(`${path} must be >= ${options.min}`, path);
    return value;
  };
}

function oneOf(domain: readonly string[]): FieldValidator {
  return (value, path) => {
    if (typeof value !== 'string' || !domain.includes(value)) {
      throw invalidConfig(`${path} must be one of: ${domain.join(', ')}`, path);
    }
    return value;
  };
}

/**
 * The patchable surface. Being a whitelist is the point: unknown keys
 * round-tripped from the Go-era file stay on disk but can never be written
 * through the API, and a typo is a 400 instead of a silently dropped setting.
 *
 * The domains here MIRROR core's loader with the opposite policy — the loader
 * converges an out-of-range disk value to the default (a config file must
 * never block startup), this rejects it (a caller who asked for something
 * impossible deserves to hear so). `LOG_LEVELS` is shared outright; the
 * numeric bounds are simple enough to state twice and are cross-checked
 * against the loader in the tests.
 */
const SCHEMA: Record<string, Record<string, FieldValidator>> = {
  llm: {
    url: text(URL_MAX),
    model: text(STRING_MAX),
    // '' clears the key — the only way to remove it through the API.
    api_key: text(STRING_MAX),
    // A closed domain (§7 F5): the LLM client branches on `anthropic` and
    // treats EVERYTHING else as OpenAI, so a typo used to be accepted, saved,
    // and then silently talk the wrong protocol. `''` is a real value — it
    // means "whatever aviary's shared config says".
    api_format: oneOf(LLM_API_FORMATS),
  },
  window: { width: number({ min: 1 }), height: number({ min: 1 }) },
  theme: { mode: oneOf(THEME_MODES) },
  font: { global_font_size: number({ min: 1 }), lyrics_font_size: number({ min: 1 }) },
  log: {
    level: oneOf(LOG_LEVELS),
    max_size_mb: number({ min: 1 }),
    max_backups: number({ min: 1, integer: true }),
  },
  storage: { cache_limit_mb: number({ min: 0 }) },
  // Only the cadence is patchable. Server URL, session and device identity are
  // credentials: they live in skybridge.toml and are written by `/sync/login`,
  // never by a config patch (D1/D2).
  sync: { interval_min: number({ min: 1, integer: true }) },
};

function asObject(value: unknown, path: string, detailPath?: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidConfig(`${path} must be an object`, detailPath);
  }
  return value as Record<string, unknown>;
}

/** Validate `patch` and write it into `target`. Throws before any assignment. */
function applyPatch(target: LarkConfig, patch: unknown): void {
  const body = asObject(patch, 'config patch');
  if (Object.keys(body).length === 0) throw invalidConfig('config patch must not be empty');

  const sections = target as unknown as Record<string, Record<string, unknown>>;
  for (const [section, rawValues] of Object.entries(body)) {
    const schema = SCHEMA[section];
    if (!schema) throw invalidConfig(`unknown config section: ${section}`, section);
    const values = asObject(rawValues, section, section);
    for (const [key, value] of Object.entries(values)) {
      const validate = schema[key];
      if (!validate)
        throw invalidConfig(`unknown config field: ${section}.${key}`, `${section}.${key}`);
      sections[section][key] = validate(value, `${section}.${key}`);
    }
  }
}

/**
 * Did the cache limit get tighter? `0` is "unlimited", so it is the largest
 * value there is — and moving OFF it is the one shrink that a plain `<`
 * comparison would read as growth.
 */
function isSmallerLimit(next: number, previous: number): boolean {
  if (next === 0) return false;
  return previous === 0 || next < previous;
}

export function registerConfigRoutes(app: FastifyInstance, ctx: AppContext): void {
  const save = (config: LarkConfig): void =>
    (ctx.saveConfigImpl ?? saveConfig)(config, ctx.configPath);

  app.get(API_PATHS.config, async (_req, reply) => {
    ok(reply, redactConfig(ctx.config));
  });

  app.patch(API_PATHS.config, async (req, reply) => {
    const next = structuredClone(ctx.config);
    applyPatch(next, req.body); // 400 before anything is touched

    try {
      save(next);
    } catch (err) {
      ctx.logger.error({ err }, 'failed to save config');
      try {
        // Whatever is on disk is the truth — adopt it, whichever side of the
        // rename the failure landed on.
        ctx.config = loadConfig(ctx.configPath);
      } catch (reloadErr) {
        fail(
          reply,
          500,
          'failed to save the config AND to reload it; the daemon is shutting down',
          'SAVE_FAILED',
        );
        // Non-awaited by contract: teardown closes the server, which waits for
        // THIS request to finish (M2-1 ①).
        ctx.requestFatal(reloadErr);
        return;
      }
      return fail(
        reply,
        500,
        'failed to save the config; the in-memory config was reloaded from disk — read GET /config for the effective values',
        'SAVE_FAILED',
      );
    }

    const previous = ctx.config;
    ctx.config = next;

    // Settings that something is ALREADY holding have to be handed over, or
    // the field, the file and the running daemon disagree with each other and
    // only a restart resolves it (§7 F1/F7).
    if (next.sync.interval_min !== previous.sync.interval_min) {
      ctx.sync.rearmScheduler();
    }
    // Only when it SHRANK: raising the limit cannot make the library over it,
    // and an eviction run that has nothing to do is still a disk walk.
    if (isSmallerLimit(next.storage.cache_limit_mb, previous.storage.cache_limit_mb)) {
      scheduleEvictionInBackground(ctx, 'config-changed');
    }

    // log.* only takes effect on the next boot: the logger was built at start-up.
    ok(reply, redactConfig(ctx.config), 'config saved (log settings apply after a restart)');
  });
}
