import type { DesktopLyricsMessage } from './desktop-lyrics.js';

/** The two documents that ship inside the app bundle (M7-9). */
export type LegalDocument = 'license' | 'notices';

/** The preload bridge surface. Shared by preload (producer) and renderer (consumer). */
export interface LarkApi {
  /**
   * Daemon base URL, injected by main through `additionalArguments`. `null`
   * when main did not pass one — the renderer then falls back to the default
   * loopback port.
   */
  readonly daemonUrl: string | null;
  /**
   * The daemon's bearer token, read FRESH from the 0600 token file on every
   * call (R29) — a function, never a cached string, so a daemon restart's
   * rotated token is picked up without a reload. `null` when the token file
   * is unreadable or main passed no path.
   */
  readonly getDaemonToken: () => string | null;
  /** Renderer process pid — what `POST /gui/register` reports (M4-9). */
  readonly rendererPid: number;
  /** GUI package version, for the register call. */
  readonly guiVersion: string;
  /** Native multi-select mp3 picker (main-side dialog). `[]` on cancel. */
  readonly pickAudio: () => Promise<string[]>;
  /**
   * Open a link in the user's browser. Only http(s) leaves the app (R10);
   * anything else answers `false` without opening anything.
   */
  readonly openExternal: (url: string) => Promise<boolean>;
  /** Pick a playlist file to import. `null` on cancel (M5-15). */
  readonly pickJsonFile: () => Promise<string | null>;
  /**
   * Ask where to save an export and write it there. `default_name` is only a
   * suggestion — main sanitises it and the user picks the real path. `false`
   * means the dialog was cancelled; a failed write rejects (M5-12).
   */
  readonly saveExportFile: (input: {
    default_name: string;
    content: string;
  }) => Promise<boolean>;
  /**
   * lark's own licence, and the third-party notices for everything shipped
   * with it. `null` means the document is not there — which is the truth in a
   * dev checkout that has never generated one, and should never be true of a
   * packaged build (the acceptance gate checks that).
   */
  readonly readLegal: (document: LegalDocument) => Promise<string | null>;
  /**
   * Open the migration backup directory in the file manager (0.3.0 T3c).
   * `false` when the OS refused — including "there is nothing there", which is
   * the honest answer once the backups have been cleared.
   */
  readonly openMigrationBackup: () => Promise<boolean>;
  /**
   * Tell main what the floating lyric window should draw (0.5.0 ⑤). Fire and
   * forget from the MAIN window; there is nothing to wait for and a message
   * that arrives with no window open is dropped.
   */
  readonly publishDesktopLyrics: (state: DesktopLyricsMessage) => void;
  /**
   * Subscribe to that, in the LYRIC window. Returns the unsubscribe — the
   * window is torn down whole, but a subscription that cannot be undone is a
   * leak waiting for the first person who reloads it in dev.
   */
  readonly onDesktopLyrics: (listener: (state: DesktopLyricsMessage) => void) => () => void;
  /**
   * The lyric window was closed by the person looking at it (0.5.0 ⑤).
   * Heard in the MAIN window, which owns the config and writes the answer
   * down. Returns the unsubscribe.
   */
  readonly onDesktopLyricsClosed: (listener: () => void) => () => void;
  /**
   * Relaunch the app so it opens the workspace that is now active (N7e).
   *
   * Never resolves in the ordinary case — the process it was called from is
   * the one going away. It goes through the same quit sequence a menu quit
   * does, so the window size is flushed and the daemon this app started is
   * stopped before anything is relaunched.
   */
  readonly restartApp: () => Promise<void>;
}
