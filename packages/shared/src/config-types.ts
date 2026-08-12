// Config schema v1 (M1-6). Node-free: the renderer settings page and the CLI
// consume these shapes; the TOML runtime (load/save/merge/redact) lives in
// @lark/core.

/**
 * LLM connection settings. Every field is a string and `''` means "unset" —
 * `resolveLlmConfig` falls back per-field to the shared aviary config, and
 * backstops `api_format` with `'openai'` at output time. `api_format`
 * deliberately defaults to `''` too: a concrete default in DEFAULT_CONFIG
 * would make deepMerge mask "absent on disk" and the aviary value could
 * never be adopted.
 */
export interface LlmConfig {
  url: string;
  model: string;
  api_key: string;
  api_format: string;
}

export interface WindowConfig {
  width: number;
  height: number;
}

/** Font sizes in pixels (Go-version parity). */
export interface FontConfig {
  global_font_size: number;
  lyrics_font_size: number;
}

/**
 * Log levels as a runtime constant (M2-12): core's `sanitize` (converge an
 * out-of-domain disk value back to the default) and the daemon's `PATCH
 * /config` validator (reject it with a 400) enforce OPPOSITE policies over
 * the SAME domain, so the domain itself lives here — one definition, two
 * consumers. `LogLevel` is derived from it.
 */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export interface LogConfig {
  level: LogLevel;
  max_size_mb: number;
  max_backups: number;
}

export interface StorageConfig {
  /** Cache limit in MB; 0 = unlimited (no automatic eviction). */
  cache_limit_mb: number;
}

/**
 * Sync preferences (v0.2). Only the periodic-sync cadence lives here: the
 * server URL, the session and the device identity are credentials and belong
 * to `skybridge.toml` (D1/D2), which never crosses the `/config` channel.
 *
 * The interval is a floor on background pulls, not the whole trigger story —
 * SSE and push-on-mutation both fire sooner.
 */
export interface SyncConfig {
  interval_min: number;
}

/**
 * Theme modes as a runtime constant, same two-consumer reason as
 * {@link LOG_LEVELS} (M5-2): core's `sanitize` converges an out-of-domain disk
 * value to `'system'`, the daemon's `PATCH /config` validator rejects it.
 * `'system'` follows the OS; `'light'`/`'dark'` override it.
 */
export const THEME_MODES = ['system', 'light', 'dark'] as const;

export type ThemeMode = (typeof THEME_MODES)[number];

/**
 * Appearance lives in the config, view state (sort / column visibility / play
 * mode) stays in localStorage — the frozen line from M4-12, restated in M5-2
 * so a third home never grows.
 */
export interface ThemeConfig {
  mode: ThemeMode;
}

/**
 * The full on-disk config (`lark/lark_config.toml`). The daemon port is NOT
 * config — 47100 is a constant baked into the renderer CSP. Unknown keys in
 * the file (Go-era `display`/`download`/`daemon` sections, `max_age_days`)
 * are preserved on save but carried outside this type and never take effect.
 */
export interface LarkConfig {
  llm: LlmConfig;
  window: WindowConfig;
  theme: ThemeConfig;
  font: FontConfig;
  log: LogConfig;
  storage: StorageConfig;
  sync: SyncConfig;
}

/**
 * `PATCH /config` body — the whitelisted patchable surface (M2-12). Sections
 * and fields are each optional; unknown keys are a 400, never silently
 * dropped. `llm.api_key` IS writable here (`''` clears it) even though reads
 * only ever see `has_api_key`.
 */
export interface ConfigPatchRequest {
  llm?: Partial<LlmConfig>;
  window?: Partial<WindowConfig>;
  theme?: Partial<ThemeConfig>;
  font?: Partial<FontConfig>;
  log?: Partial<LogConfig>;
  storage?: Partial<StorageConfig>;
  sync?: Partial<SyncConfig>;
}

/** `api_key` never crosses the wire — `has_api_key` flags presence (R14/M2). */
export interface PublicLlmConfig {
  url: string;
  model: string;
  api_format: string;
  has_api_key: boolean;
}

/**
 * Whitelist projection for `GET /config` and logging: known fields only, so
 * unknown keys round-tripped from disk can never leak.
 */
export interface PublicLarkConfig {
  llm: PublicLlmConfig;
  window: WindowConfig;
  theme: ThemeConfig;
  font: FontConfig;
  log: LogConfig;
  storage: StorageConfig;
  sync: SyncConfig;
}
