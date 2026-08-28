// The settings form's draft (M5-1, split out of SettingsDialog in v0.2 T4).
//
// THE DRAFT IS LOCAL. Typing must not write; only [保存] does, and it sends
// ONLY the sections that actually changed — a PATCH is a whitelist, so sending
// everything would rewrite fields the user never touched.
//
// THE API KEY IS WRITE-ONLY. `GET /config` answers `has_api_key`, never the
// key (R14). Leaving the field empty keeps whatever is stored; the explicit
// [清除] button is the only way to remove it, and it sends `''`.

import type {
  ConfigPatchRequest,
  DesktopLyricsPreset,
  LogLevel,
  PublicLarkConfig,
  ThemeMode,
} from '@lark/shared';

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

/** Only what changed. An unchanged section is left out of the PATCH entirely. */
export function buildPatch(draft: Draft, config: PublicLarkConfig): ConfigPatchRequest {
  const patch: ConfigPatchRequest = {};

  const llm: NonNullable<ConfigPatchRequest['llm']> = {};
  if (draft.llmUrl !== config.llm.url) llm.url = draft.llmUrl;
  if (draft.llmModel !== config.llm.model) llm.model = draft.llmModel;
  if (draft.llmFormat !== config.llm.api_format) llm.api_format = draft.llmFormat;
  if (draft.clearApiKey) llm.api_key = '';
  else if (draft.apiKey !== '') llm.api_key = draft.apiKey;
  if (Object.keys(llm).length > 0) patch.llm = llm;

  if (draft.theme !== config.theme.mode) patch.theme = { mode: draft.theme };

  const font: NonNullable<ConfigPatchRequest['font']> = {};
  if (num(draft.globalFontSize) !== config.font.global_font_size) {
    font.global_font_size = num(draft.globalFontSize);
  }
  if (num(draft.lyricsFontSize) !== config.font.lyrics_font_size) {
    font.lyrics_font_size = num(draft.lyricsFontSize);
  }
  if (Object.keys(font).length > 0) patch.font = font;

  if (draft.cacheLimitMb !== config.storage.cache_limit_mb) {
    patch.storage = { cache_limit_mb: draft.cacheLimitMb };
  }

  if (draft.autoDownloadNext !== config.playback.auto_download_next) {
    patch.playback = { auto_download_next: draft.autoDownloadNext };
  }

  const lyrics: NonNullable<ConfigPatchRequest['desktop_lyrics']> = {};
  const dl = config.desktop_lyrics;
  if (draft.desktopLyricsEnabled !== dl.enabled) lyrics.enabled = draft.desktopLyricsEnabled;
  if (draft.desktopLyricsLines !== dl.lines) lyrics.lines = draft.desktopLyricsLines;
  if (num(draft.desktopLyricsFontSize) !== dl.font_size) {
    lyrics.font_size = num(draft.desktopLyricsFontSize);
  }
  if (draft.desktopLyricsPreset !== dl.preset) lyrics.preset = draft.desktopLyricsPreset;
  if (draft.desktopLyricsLocked !== dl.locked) lyrics.locked = draft.desktopLyricsLocked;
  // The geometry is normally the WINDOW's to write (it is dragged there), and
  // it is in the draft for one reason: 「恢复默认位置」 is the only way back to
  // a window that was dragged onto a display that is no longer attached.
  if (num(draft.desktopLyricsX) !== dl.x) lyrics.x = num(draft.desktopLyricsX);
  if (num(draft.desktopLyricsY) !== dl.y) lyrics.y = num(draft.desktopLyricsY);
  if (num(draft.desktopLyricsWidth) !== dl.width) lyrics.width = num(draft.desktopLyricsWidth);
  if (num(draft.desktopLyricsHeight) !== dl.height) lyrics.height = num(draft.desktopLyricsHeight);
  if (Object.keys(lyrics).length > 0) patch.desktop_lyrics = lyrics;

  if (draft.syncIntervalMin !== config.sync.interval_min) {
    patch.sync = { interval_min: draft.syncIntervalMin };
  }

  const window: NonNullable<ConfigPatchRequest['window']> = {};
  if (num(draft.windowWidth) !== config.window.width) window.width = num(draft.windowWidth);
  if (num(draft.windowHeight) !== config.window.height) window.height = num(draft.windowHeight);
  if (Object.keys(window).length > 0) patch.window = window;

  const log: NonNullable<ConfigPatchRequest['log']> = {};
  if (draft.logLevel !== config.log.level) log.level = draft.logLevel;
  if (num(draft.logMaxSizeMb) !== config.log.max_size_mb) log.max_size_mb = num(draft.logMaxSizeMb);
  if (num(draft.logMaxBackups) !== config.log.max_backups) {
    log.max_backups = num(draft.logMaxBackups);
  }
  if (Object.keys(log).length > 0) patch.log = log;

  return patch;
}
