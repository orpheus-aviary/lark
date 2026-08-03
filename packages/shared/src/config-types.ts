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

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

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
 * The full on-disk config (`lark/lark_config.toml`). The daemon port is NOT
 * config — 47100 is a constant baked into the renderer CSP. Unknown keys in
 * the file (Go-era `display`/`download`/`daemon` sections, `max_age_days`)
 * are preserved on save but carried outside this type and never take effect.
 */
export interface LarkConfig {
  llm: LlmConfig;
  window: WindowConfig;
  font: FontConfig;
  log: LogConfig;
  storage: StorageConfig;
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
  font: FontConfig;
  log: LogConfig;
  storage: StorageConfig;
}
