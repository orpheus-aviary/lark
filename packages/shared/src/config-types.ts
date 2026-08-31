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

/**
 * The closed domain of `llm.api_format` (§7 F5).
 *
 * `''` first because it is the default and the one that means something other
 * than a protocol: follow aviary's shared config. The client branches on
 * `anthropic` and treats everything else as OpenAI, so an unvalidated string
 * here is a request that silently speaks the wrong protocol.
 */
export const LLM_API_FORMATS = ['', 'openai', 'anthropic'] as const;

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

/**
 * Playback preferences (0.1.1 ⑥).
 *
 * One field, and it is rule 3's second half (`play-queue.ts`): may a song that
 * simply ran out name a neighbour whose file is not here, and fetch it? On by
 * default. The rule it feeds is shared with the phone, so the two hosts play a
 * list the same way — and both read the answer from something the person owns
 * rather than from a constant.
 */
export interface PlaybackConfig {
  auto_download_next: boolean;
}

/**
 * Download preferences (2026-08-31 对齐).
 *
 * One field, and it is the number half of a rule the phone has had since
 * 0.1.1 ⑧: how many EXTRA attempts a failure that could plausibly go the other
 * way gets by itself. WHICH failures those are is not a setting and never will
 * be — that judgement is `@lark/core/portable`'s `download/retry.ts`, shared
 * with the phone, because an allowlist that exists twice will say two things.
 *
 * `0` turns the feature off. The domain is `RETRY_LIMITS`, and it is closed
 * for the same two-consumer reason as {@link LOG_LEVELS}: core's `sanitize`
 * converges an out-of-domain disk value to the default, the daemon's
 * `PATCH /config` validator rejects it.
 */
export interface DownloadConfig {
  retry_limit: number;
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
 * The four desktop-lyrics colour schemes (0.5.0 ⑤).
 *
 * A closed domain for the same two-consumer reason as {@link THEME_MODES}:
 * core's `sanitize` converges an unknown one back to `classic`, the daemon's
 * `PATCH /config` rejects it. What is frozen HERE is the four names; the
 * colours themselves are the renderer's, and every scheme owes three of them
 * — see {@link DesktopLyricsPalette}.
 */
export const DESKTOP_LYRICS_PRESETS = ['classic', 'night', 'warm', 'plain'] as const;

export type DesktopLyricsPreset = (typeof DESKTOP_LYRICS_PRESETS)[number];

/**
 * What a scheme owes, and the reason it is three colours rather than one.
 *
 * The window floats over whatever is underneath it — a white document, a dark
 * editor, a video — so filled text alone is unreadable half the time. An
 * OUTLINE behind the fill is what makes it legible on both, and the third is
 * the line that is playing, which is the only thing on that window that means
 * something on its own.
 */
export interface DesktopLyricsPalette {
  outline: string;
  fill: string;
  active: string;
}

/**
 * Bounds for the floating lyric window's own numbers.
 *
 * They exist because this is the first section whose values are written BACK
 * by a window rather than typed by a person (0.5.0 P9c): a stale or
 * hand-edited file must not be able to produce a window nobody can find or
 * read. `x`/`y` are deliberately unbounded — a second display can be to the
 * left of the first, which is a negative coordinate and not a mistake.
 */
export const DESKTOP_LYRICS_BOUNDS = {
  fontSize: { min: 12, max: 96 },
  width: { min: 200 },
  height: { min: 40 },
} as const;

/**
 * Where the window starts, and where 「恢复默认位置」 puts it back.
 *
 * In shared rather than in core's `DEFAULT_CONFIG` alone because the settings
 * page needs the same numbers: a window dragged onto a display that is no
 * longer attached is somewhere nobody can reach, and this is the way back.
 * `DEFAULT_CONFIG` spreads these, so there is one set of numbers.
 */
export const DESKTOP_LYRICS_DEFAULT_BOUNDS = { x: 0, y: 0, width: 900, height: 120 } as const;

/**
 * The floating lyric window (0.5.0 ⑤).
 *
 * ALL OF IT IS CONFIG, geometry included, and that is the M4-12 / M5-2 line
 * held rather than bent: appearance goes in the config, view state stays in
 * localStorage. Where a window is and how big it is has been config since
 * `[window]`, and this one has no localStorage to fall back on anyway — it is
 * a second renderer with one job.
 */
export interface DesktopLyricsConfig {
  enabled: boolean;
  /** 1 or 2. Two shows the line after the one playing, dimmed. */
  lines: 1 | 2;
  font_size: number;
  preset: DesktopLyricsPreset;
  /**
   * Click-through. The WHOLE window, not a region: macOS gives no finer grain
   * (electron#23042), and that is also the shape the user asked for — with the
   * consequence that unlocking has to happen back in the settings page.
   */
  locked: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
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
  playback: PlaybackConfig;
  download: DownloadConfig;
  desktop_lyrics: DesktopLyricsConfig;
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
  playback?: Partial<PlaybackConfig>;
  download?: Partial<DownloadConfig>;
  desktop_lyrics?: Partial<DesktopLyricsConfig>;
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
  playback: PlaybackConfig;
  download: DownloadConfig;
  desktop_lyrics: DesktopLyricsConfig;
  sync: SyncConfig;
}
