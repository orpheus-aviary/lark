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
  readonly pickMp3: () => Promise<string[]>;
  /**
   * Open a link in the user's browser. Only http(s) leaves the app (R10);
   * anything else answers `false` without opening anything.
   */
  readonly openExternal: (url: string) => Promise<boolean>;
}
