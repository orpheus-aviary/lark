// Host adapter — a thin, live pass-through over the preload-injected
// `window.larkAPI` (owl's form). Every field is a live getter rather than a
// captured value: renderer tests mutate `window.larkAPI.*` between cases, and
// live reads keep the cached adapter in step with those mutations.
//
// lark is Electron-only (no web build), so there is exactly one adapter; the
// jsdom test environment provides a fake `window.larkAPI` in test-setup.

import { defaultDaemonBaseUrl } from '@lark/shared';
import type {
  DesktopLyricsChange,
  DesktopLyricsGesture,
  DesktopLyricsMessage,
} from '../../../shared/desktop-lyrics.js';

export interface PlatformAdapter {
  daemonBaseUrl(): string;
  /** Fresh token per call (R29); `null` when unavailable. */
  getDaemonToken(): string | null;
  readonly rendererPid: number;
  readonly guiVersion: string;
  pickAudio(): Promise<string[]>;
  /** Open an http(s) link in the browser; false if it was refused (R10). */
  openExternal(url: string): Promise<boolean>;
  /** Pick a playlist file to import; null on cancel. */
  pickJsonFile(): Promise<string | null>;
  /** Save an export through a native dialog; false on cancel. */
  saveExportFile(input: { default_name: string; content: string }): Promise<boolean>;
  /** Reveal the migration backup directory; false when there is nothing to open. */
  openMigrationBackup(): Promise<boolean>;
  /** Push a frame to the floating lyric window (0.5.0 ⑤). */
  publishDesktopLyrics(state: DesktopLyricsMessage): void;
  /** Receive them, in that window. Returns the unsubscribe. */
  onDesktopLyrics(listener: (state: DesktopLyricsMessage) => void): () => void;
  /** From the lyric window: change something about me (0.5.0 ⑤). */
  requestDesktopLyricsChange(change: DesktopLyricsChange): void;
  /** Drag or resize that window with the pointer, from that window. */
  sendDesktopLyricsGesture(gesture: DesktopLyricsGesture): void;
  /** Heard in the main window, which owns the config. */
  onDesktopLyricsChange(listener: (change: DesktopLyricsChange) => void): () => void;
}

let cached: PlatformAdapter | undefined;

export function getPlatform(): PlatformAdapter {
  if (cached) return cached;
  cached = {
    daemonBaseUrl: () => window.larkAPI?.daemonUrl ?? defaultDaemonBaseUrl(),
    getDaemonToken: () => window.larkAPI.getDaemonToken(),
    get rendererPid() {
      return window.larkAPI.rendererPid;
    },
    get guiVersion() {
      return window.larkAPI.guiVersion;
    },
    pickAudio: () => window.larkAPI.pickAudio(),
    openExternal: (url) => window.larkAPI.openExternal(url),
    pickJsonFile: () => window.larkAPI.pickJsonFile(),
    saveExportFile: (input) => window.larkAPI.saveExportFile(input),
    openMigrationBackup: () => window.larkAPI.openMigrationBackup(),
    publishDesktopLyrics: (state) => window.larkAPI.publishDesktopLyrics(state),
    onDesktopLyrics: (listener) => window.larkAPI.onDesktopLyrics(listener),
    requestDesktopLyricsChange: (change) => window.larkAPI.requestDesktopLyricsChange(change),
    sendDesktopLyricsGesture: (gesture) => window.larkAPI.sendDesktopLyricsGesture(gesture),
    onDesktopLyricsChange: (listener) => window.larkAPI.onDesktopLyricsChange(listener),
  };
  return cached;
}
