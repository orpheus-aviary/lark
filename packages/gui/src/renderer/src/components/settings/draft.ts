// The settings form's draft (M5-1, split out of SettingsDialog in v0.2 T4).
//
// THE DRAFT IS LOCAL. Typing must not write; only [保存] does, and it sends
// ONLY THE FIELDS SOMEBODY TOUCHED — a PATCH is a whitelist, so a field left
// out is a field left alone.
//
// 🔴 TOUCHED, NOT "DIFFERENT FROM THE CONFIG", and the difference is a bug
// this page had: the draft is built once, when the page opens, while the
// config keeps moving under it — the lyric window writes its own geometry as
// it is dragged, and its control bar writes the font size and the scheme. A
// diff-based save therefore sent the values from the moment the page opened
// back over everything that happened since, and the window jumped back to
// where it had been. Nobody touched those fields; they should not travel.
//
// THE API KEY IS WRITE-ONLY. `GET /config` answers `has_api_key`, never the
// key (R14). Leaving the field empty keeps whatever is stored; the explicit
// [清除] button is the only way to remove it, and it sends `''`.

import {
  type ConfigPatchRequest,
  DESKTOP_LYRICS_BOUNDS,
  type DesktopLyricsPreset,
  type LogLevel,
  type PublicLarkConfig,
  type ThemeMode,
} from '@lark/shared';
import type { DesktopLyricsPreview } from '../../../../shared/desktop-lyrics.js';

/** Everything the form edits, as strings where the input is a text field. */
export interface Draft {
  llmUrl: string;
  llmModel: string;
  llmFormat: string;
  /** Empty means "leave the stored key alone" — never the stored value (R14). */
  apiKey: string;
  clearApiKey: boolean;
  theme: ThemeMode;
  globalFontSize: string;
  lyricsFontSize: string;
  cacheLimitMb: number;
  /** Rule 3's second half (0.1.1 ⑥) — shared with the phone. */
  autoDownloadNext: boolean;
  retryLimit: number;
  /**
   * The floating lyric window (0.5.0 ⑤).
   *
   * ALL OF IT is here, geometry included, because the settings page is the
   * only way back once the window is locked — a page that could not put it
   * back where it belongs would leave somebody with a strip of text they can
   * neither move nor reach.
   */
  desktopLyricsEnabled: boolean;
  desktopLyricsLines: 1 | 2;
  desktopLyricsFontSize: string;
  desktopLyricsPreset: DesktopLyricsPreset;
  desktopLyricsLocked: boolean;
  desktopLyricsX: string;
  desktopLyricsY: string;
  desktopLyricsWidth: string;
  desktopLyricsHeight: string;
  syncIntervalMin: number;
  windowWidth: string;
  windowHeight: string;
  logLevel: LogLevel;
  logMaxSizeMb: string;
  logMaxBackups: string;
}

export function toDraft(config: PublicLarkConfig): Draft {
  return {
    llmUrl: config.llm.url,
    llmModel: config.llm.model,
    llmFormat: config.llm.api_format,
    apiKey: '',
    clearApiKey: false,
    theme: config.theme.mode,
    globalFontSize: String(config.font.global_font_size),
    lyricsFontSize: String(config.font.lyrics_font_size),
    cacheLimitMb: config.storage.cache_limit_mb,
    autoDownloadNext: config.playback.auto_download_next,
    retryLimit: config.download.retry_limit,
    desktopLyricsEnabled: config.desktop_lyrics.enabled,
    desktopLyricsLines: config.desktop_lyrics.lines,
    desktopLyricsFontSize: String(config.desktop_lyrics.font_size),
    desktopLyricsPreset: config.desktop_lyrics.preset,
    desktopLyricsLocked: config.desktop_lyrics.locked,
    desktopLyricsX: String(config.desktop_lyrics.x),
    desktopLyricsY: String(config.desktop_lyrics.y),
    desktopLyricsWidth: String(config.desktop_lyrics.width),
    desktopLyricsHeight: String(config.desktop_lyrics.height),
    syncIntervalMin: config.sync.interval_min,
    windowWidth: String(config.window.width),
    windowHeight: String(config.window.height),
    logLevel: config.log.level,
    logMaxSizeMb: String(config.log.max_size_mb),
    logMaxBackups: String(config.log.max_backups),
  };
}

/** `NaN` for anything the daemon would reject anyway — it answers with a path. */
const num = (value: string): number => Number(value.trim() === '' ? Number.NaN : value);

/** Which fields somebody actually edited on this visit to the page. */
export type TouchedFields = ReadonlySet<keyof Draft>;

/**
 * Only what was touched, and only where it differs from what is stored.
 *
 * Both halves earn their place: `touched` keeps a moving config from being
 * overwritten by a stale draft (see the header), and the comparison keeps a
 * value typed and then typed back from travelling as a change.
 */
export function buildPatch(
  draft: Draft,
  config: PublicLarkConfig,
  touched: TouchedFields,
): ConfigPatchRequest {
  const patch: ConfigPatchRequest = {};
  const edited = (field: keyof Draft): boolean => touched.has(field);

  const llm: NonNullable<ConfigPatchRequest['llm']> = {};
  if (edited('llmUrl') && draft.llmUrl !== config.llm.url) llm.url = draft.llmUrl;
  if (edited('llmModel') && draft.llmModel !== config.llm.model) llm.model = draft.llmModel;
  if (edited('llmFormat') && draft.llmFormat !== config.llm.api_format) {
    llm.api_format = draft.llmFormat;
  }
  if (draft.clearApiKey) llm.api_key = '';
  else if (draft.apiKey !== '') llm.api_key = draft.apiKey;
  if (Object.keys(llm).length > 0) patch.llm = llm;

  if (edited('theme') && draft.theme !== config.theme.mode) patch.theme = { mode: draft.theme };

  const font: NonNullable<ConfigPatchRequest['font']> = {};
  if (edited('globalFontSize') && num(draft.globalFontSize) !== config.font.global_font_size) {
    font.global_font_size = num(draft.globalFontSize);
  }
  if (edited('lyricsFontSize') && num(draft.lyricsFontSize) !== config.font.lyrics_font_size) {
    font.lyrics_font_size = num(draft.lyricsFontSize);
  }
  if (Object.keys(font).length > 0) patch.font = font;

  if (edited('cacheLimitMb') && draft.cacheLimitMb !== config.storage.cache_limit_mb) {
    patch.storage = { cache_limit_mb: draft.cacheLimitMb };
  }

  if (edited('autoDownloadNext') && draft.autoDownloadNext !== config.playback.auto_download_next) {
    patch.playback = { auto_download_next: draft.autoDownloadNext };
  }

  if (edited('retryLimit') && draft.retryLimit !== config.download.retry_limit) {
    patch.download = { retry_limit: draft.retryLimit };
  }

  const lyrics: NonNullable<ConfigPatchRequest['desktop_lyrics']> = {};
  const dl = config.desktop_lyrics;
  if (edited('desktopLyricsEnabled') && draft.desktopLyricsEnabled !== dl.enabled) {
    lyrics.enabled = draft.desktopLyricsEnabled;
  }
  if (edited('desktopLyricsLines') && draft.desktopLyricsLines !== dl.lines) {
    lyrics.lines = draft.desktopLyricsLines;
  }
  if (edited('desktopLyricsFontSize') && num(draft.desktopLyricsFontSize) !== dl.font_size) {
    lyrics.font_size = num(draft.desktopLyricsFontSize);
  }
  if (edited('desktopLyricsPreset') && draft.desktopLyricsPreset !== dl.preset) {
    lyrics.preset = draft.desktopLyricsPreset;
  }
  if (edited('desktopLyricsLocked') && draft.desktopLyricsLocked !== dl.locked) {
    lyrics.locked = draft.desktopLyricsLocked;
  }
  // The geometry is normally the WINDOW's to write (it is dragged there), and
  // it is in the draft for one reason: 「恢复默认位置」 is the only way back to
  // a window that was dragged onto a display that is no longer attached.
  if (edited('desktopLyricsX') && num(draft.desktopLyricsX) !== dl.x) {
    lyrics.x = num(draft.desktopLyricsX);
  }
  if (edited('desktopLyricsY') && num(draft.desktopLyricsY) !== dl.y) {
    lyrics.y = num(draft.desktopLyricsY);
  }
  if (edited('desktopLyricsWidth') && num(draft.desktopLyricsWidth) !== dl.width) {
    lyrics.width = num(draft.desktopLyricsWidth);
  }
  if (edited('desktopLyricsHeight') && num(draft.desktopLyricsHeight) !== dl.height) {
    lyrics.height = num(draft.desktopLyricsHeight);
  }
  if (Object.keys(lyrics).length > 0) patch.desktop_lyrics = lyrics;

  if (edited('syncIntervalMin') && draft.syncIntervalMin !== config.sync.interval_min) {
    patch.sync = { interval_min: draft.syncIntervalMin };
  }

  const window: NonNullable<ConfigPatchRequest['window']> = {};
  if (edited('windowWidth') && num(draft.windowWidth) !== config.window.width) {
    window.width = num(draft.windowWidth);
  }
  if (edited('windowHeight') && num(draft.windowHeight) !== config.window.height) {
    window.height = num(draft.windowHeight);
  }
  if (Object.keys(window).length > 0) patch.window = window;

  const log: NonNullable<ConfigPatchRequest['log']> = {};
  if (edited('logLevel') && draft.logLevel !== config.log.level) log.level = draft.logLevel;
  if (edited('logMaxSizeMb') && num(draft.logMaxSizeMb) !== config.log.max_size_mb) {
    log.max_size_mb = num(draft.logMaxSizeMb);
  }
  if (edited('logMaxBackups') && num(draft.logMaxBackups) !== config.log.max_backups) {
    log.max_backups = num(draft.logMaxBackups);
  }
  if (Object.keys(log).length > 0) patch.log = log;

  return patch;
}

/**
 * What the floating window should show while this page is open (0.5.0 ⑤ 的续).
 *
 * ONLY THE TOUCHED FIELDS, which is the same rule a save follows and it buys
 * the same thing: a scheme somebody picked from the window's own control bar
 * goes on showing through this page, because this page never expressed an
 * opinion about it.
 *
 * 🔴 A HALF-TYPED NUMBER IS NOT A PREVIEW. The font size is a text field, so
 * clearing it to type 48 passes through '' and '4' — and previewing those
 * would flick the window to nothing and then to unreadable on the way. Out of
 * range reads as "not yet", and the saved size stays until it is a size.
 */
export function previewFrom(draft: Draft, touched: TouchedFields): DesktopLyricsPreview {
  const preview: DesktopLyricsPreview = {};
  if (touched.has('desktopLyricsEnabled')) preview.enabled = draft.desktopLyricsEnabled;
  if (touched.has('desktopLyricsLines')) preview.lines = draft.desktopLyricsLines;
  if (touched.has('desktopLyricsPreset')) preview.preset = draft.desktopLyricsPreset;
  if (touched.has('desktopLyricsFontSize')) {
    const size = num(draft.desktopLyricsFontSize);
    const { min, max } = DESKTOP_LYRICS_BOUNDS.fontSize;
    if (Number.isFinite(size) && size >= min && size <= max) preview.font_size = size;
  }
  return preview;
}

/**
 * Take the fresh config, but keep what somebody is in the middle of editing.
 *
 * 🔴 THE PAGE USED TO GO DEAF ONCE IT WAS OPEN. That was one rule doing two
 * jobs: "a background refresh must not discard what was typed" is right, but
 * it was implemented as "ignore the config entirely", so a size or a scheme
 * chosen on the lyric window's own control bar — or the position it was just
 * dragged to — did not show up in the fields describing that same window.
 *
 * `touched` already says which is which: an untouched field has no opinion of
 * its own and follows, an edited one stays as it was typed until saved or
 * cancelled.
 */
export function followConfig(
  draft: Draft,
  config: PublicLarkConfig,
  touched: TouchedFields,
): Draft {
  const next = toDraft(config);
  for (const field of touched) keepEdited(next, draft, field);
  return next;
}

/** Generic so the index write typechecks: both sides are `Draft[K]`. */
function keepEdited<K extends keyof Draft>(target: Draft, edited: Draft, field: K): void {
  target[field] = edited[field];
}
