// TOML config runtime (M1-6): defaults, load with permission tightening and
// value-domain validation, atomic 0600 save, aviary LLM fallback, and the
// whitelist Public projection. Canonical types live in @lark/shared.

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
import {
  LOG_LEVELS,
  type LarkConfig,
  type LlmConfig,
  type LogLevel,
  type PublicLarkConfig,
  THEME_MODES,
  type ThemeMode,
} from '@lark/shared';
import { parse, stringify } from 'smol-toml';
import { ConfigUnsafePermissionsError } from '../errors.js';
import { aviaryConfigPath, configPath } from '../paths.js';

export const DEFAULT_CONFIG: LarkConfig = {
  // Every llm field defaults to '' — including api_format. A concrete default
  // ('openai') would make deepMerge mask "absent on disk", so the aviary value
  // could never be adopted; resolveLlmConfig backstops 'openai' at output.
  llm: { url: '', model: '', api_key: '', api_format: '' },
  window: { width: 1024, height: 768 },
  theme: { mode: 'system' },
  font: { global_font_size: 14, lyrics_font_size: 14 },
  log: { level: 'info', max_size_mb: 10, max_backups: 5 },
  storage: { cache_limit_mb: 0 },
  sync: { interval_min: 5 },
};

/**
 * Load config from disk, creating the default file if missing.
 *
 * Existing files are chmod-tightened to 0600 BEFORE parsing — the real Go-era
 * `lark_config.toml` sits at 0644 with a live api_key in it, and load-only
 * code paths (daemon startup) must not leave it that way. A chmod failure is
 * fatal: running on with known-unsafe permissions is not an option.
 *
 * Unknown keys (Go-era `display`/`download`/`daemon` sections, `max_age_days`)
 * are carried on the returned object so saveConfig round-trips them; they
 * never take effect and never enter the Public projection. Known fields with
 * the wrong type or an out-of-domain value converge back to defaults —
 * tolerant, never throwing.
 */
export function loadConfig(path?: string): LarkConfig {
  const filePath = path ?? configPath();

  if (!existsSync(filePath)) {
    const defaults = structuredClone(DEFAULT_CONFIG);
    saveConfig(defaults, filePath);
    return defaults;
  }

  tightenPermissions(filePath);

  const parsed = parse(readFileSync(filePath, 'utf-8'));
  const merged = deepMerge(
    structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
    parsed,
  ) as unknown as LarkConfig;
  return sanitize(merged);
}

/**
 * Read the config WITHOUT touching the disk (M6-23).
 *
 * `loadConfig` is a write path in two ways — it creates a default file when
 * none exists, and it chmods an unsafe one to 0600 — which is exactly right
 * for the daemon and exactly wrong for `lark songs list --direct`: a read
 * command holds no writer lock, so both of those would land behind a running
 * backup's back.
 *
 * So: missing file yields the in-memory defaults and creates nothing, and an
 * unsafe file is REFUSED rather than repaired. The permission rule is the same
 * one `loadConfig` enforces (`mode & 0o077`, so 0700 passes) — a read command
 * that quietly accepted a world-readable api_key would make the whole
 * tightening pointless.
 */
export function loadConfigReadonly(path?: string): LarkConfig {
  const filePath = path ?? configPath();

  if (!existsSync(filePath)) return structuredClone(DEFAULT_CONFIG);

  const mode = statSync(filePath).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new ConfigUnsafePermissionsError(filePath, mode);
  }

  const parsed = parse(readFileSync(filePath, 'utf-8'));
  const merged = deepMerge(
    structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>,
    parsed,
  ) as unknown as LarkConfig;
  return sanitize(merged);
}

/**
 * Atomic 0600 save: write a random-named sibling temp file (`'wx'`, fchmod
 * 0600 against umask surprises, fsync), rename over the target, then assert
 * the final mode really is 0600 — the file holds a real api_key.
 */
export function saveConfig(config: LarkConfig, path?: string): void {
  const filePath = path ?? configPath();
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = join(dir, `.lark_config.${randomUUID()}.tmp`);
  const fd = openSync(tmpPath, 'wx', 0o600);
  try {
    writeSync(fd, stringify(config as unknown as Record<string, unknown>));
    fchmodSync(fd, 0o600);
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
      `config file ${filePath} ended up with mode 0${finalMode.toString(8)}, expected 0600`,
    );
  }
}

/**
 * Resolve the effective LLM config with the aviary fallback (M1-6): `''`
 * means "unset" for every field (they are all strings — `??` would never
 * fire on `''`). When all four lark-side fields are set, aviary is not even
 * read. Otherwise each empty field falls back to the aviary value, and
 * api_format gets the final `'openai'` backstop. A missing or corrupt aviary
 * file silently yields the lark-side values.
 */
export function resolveLlmConfig(config: LarkConfig): LlmConfig {
  const local = config.llm;
  if (local.url !== '' && local.model !== '' && local.api_key !== '' && local.api_format !== '') {
    return { ...local };
  }

  const aviary = readAviaryLlm();
  const resolved: LlmConfig = {
    url: local.url !== '' ? local.url : aviary.url,
    model: local.model !== '' ? local.model : aviary.model,
    api_key: local.api_key !== '' ? local.api_key : aviary.api_key,
    api_format: local.api_format !== '' ? local.api_format : aviary.api_format,
  };
  if (resolved.api_format === '') {
    resolved.api_format = 'openai';
  }
  return resolved;
}

/**
 * Whitelist projection (M1-6): every field is copied by name, so unknown keys
 * round-tripped from disk can never leak into `GET /config` or a log line.
 * Config objects must never be logged whole — log this projection instead.
 */
export function redactConfig(config: LarkConfig): PublicLarkConfig {
  return {
    llm: {
      url: config.llm.url,
      model: config.llm.model,
      api_format: config.llm.api_format,
      has_api_key: config.llm.api_key.length > 0,
    },
    window: { width: config.window.width, height: config.window.height },
    theme: { mode: config.theme.mode },
    font: {
      global_font_size: config.font.global_font_size,
      lyrics_font_size: config.font.lyrics_font_size,
    },
    log: {
      level: config.log.level,
      max_size_mb: config.log.max_size_mb,
      max_backups: config.log.max_backups,
    },
    storage: { cache_limit_mb: config.storage.cache_limit_mb },
    sync: { interval_min: config.sync.interval_min },
  };
}

// ─── Internals ─────────────────────────────────────────

function tightenPermissions(filePath: string): void {
  const mode = statSync(filePath).mode & 0o777;
  if ((mode & 0o077) === 0) return; // already private (0600, 0400, ...)
  try {
    chmodSync(filePath, 0o600);
  } catch (err) {
    throw new Error(
      `config file ${filePath} has unsafe mode 0${mode.toString(8)} and tightening to 0600 failed — refusing to continue`,
      { cause: err },
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge `overrides` (parsed TOML) into `base` (a structuredClone of
 * DEFAULT_CONFIG — no shared references, unlike owl's shallow copy). Known
 * sections recurse; a section present as a non-table keeps the defaults;
 * unknown keys are carried over verbatim for the save round-trip.
 */
function deepMerge(
  base: Record<string, unknown>,
  overrides: Record<string, unknown>,
): Record<string, unknown> {
  for (const key of Object.keys(overrides)) {
    const baseVal = base[key];
    const overrideVal = overrides[key];
    if (isPlainObject(baseVal)) {
      if (isPlainObject(overrideVal)) {
        deepMerge(baseVal, overrideVal);
      }
      // section exists in defaults but the file has a scalar here: keep defaults
    } else if (overrideVal !== undefined) {
      base[key] = overrideVal;
    }
  }
  return base;
}

/** The log-level domain is shared with the daemon's PATCH validator (M2-12). */
const LOG_LEVEL_SET: ReadonlySet<string> = new Set(LOG_LEVELS);

/** Same arrangement for the theme mode (M5-2). */
const THEME_MODE_SET: ReadonlySet<string> = new Set(THEME_MODES);

function str(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt;
}

function num(v: unknown, dflt: number, opts: { min: number; integer?: boolean }): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt;
  if (opts.integer && !Number.isInteger(v)) return dflt;
  if (v < opts.min) return dflt;
  return v;
}

/**
 * Runtime value-domain validation — the TS types can't reach what's on disk.
 * Mutates in place (unknown keys must survive) and converges every invalid
 * known field back to its default.
 */
function sanitize(cfg: LarkConfig): LarkConfig {
  const d = DEFAULT_CONFIG;
  cfg.llm.url = str(cfg.llm.url, d.llm.url);
  cfg.llm.model = str(cfg.llm.model, d.llm.model);
  cfg.llm.api_key = str(cfg.llm.api_key, d.llm.api_key);
  cfg.llm.api_format = str(cfg.llm.api_format, d.llm.api_format);
  cfg.window.width = num(cfg.window.width, d.window.width, { min: 1 });
  cfg.window.height = num(cfg.window.height, d.window.height, { min: 1 });
  cfg.theme.mode = (
    THEME_MODE_SET.has(cfg.theme.mode) ? cfg.theme.mode : d.theme.mode
  ) as ThemeMode;
  cfg.font.global_font_size = num(cfg.font.global_font_size, d.font.global_font_size, { min: 1 });
  cfg.font.lyrics_font_size = num(cfg.font.lyrics_font_size, d.font.lyrics_font_size, { min: 1 });
  cfg.log.level = (LOG_LEVEL_SET.has(cfg.log.level) ? cfg.log.level : d.log.level) as LogLevel;
  cfg.log.max_size_mb = num(cfg.log.max_size_mb, d.log.max_size_mb, { min: 1 });
  cfg.log.max_backups = num(cfg.log.max_backups, d.log.max_backups, { min: 1, integer: true });
  cfg.storage.cache_limit_mb = num(cfg.storage.cache_limit_mb, d.storage.cache_limit_mb, {
    min: 0,
  });
  cfg.sync.interval_min = num(cfg.sync.interval_min, d.sync.interval_min, {
    min: 1,
    integer: true,
  });
  return cfg;
}

function readAviaryLlm(): LlmConfig {
  const empty: LlmConfig = { url: '', model: '', api_key: '', api_format: '' };
  const path = aviaryConfigPath();
  if (!existsSync(path)) return empty;
  try {
    const parsed = parse(readFileSync(path, 'utf-8'));
    const llm = isPlainObject(parsed) && isPlainObject(parsed.llm) ? parsed.llm : {};
    return {
      url: str(llm.url, ''),
      model: str(llm.model, ''),
      api_key: str(llm.api_key, ''),
      api_format: str(llm.api_format, ''),
    };
  } catch {
    // Corrupt aviary file: silently fall back to lark-side values (M1-6).
    return empty;
  }
}
