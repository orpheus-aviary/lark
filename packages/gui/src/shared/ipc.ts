// IPC channel names, shared by main (handler) and preload (invoker).

export const IPC_CHANNELS = {
  /** Native multi-select mp3 picker → absolute path array ([] on cancel). */
  pickAudio: 'dialog:pick-audio',
  /** Open an http(s) link in the user's browser (R10); false when refused. */
  openExternal: 'shell:open-external',
  /** Single-select .json picker for an import file → path, or null on cancel. */
  pickJsonFile: 'dialog:pick-json',
  /** Save dialog + atomic write for an export file; false on cancel. */
  saveExportFile: 'dialog:save-export',
  /**
   * Read one of the two shipped licence documents (M7-9). The renderer names
   * a document from a closed set, never a path — an IPC that took a filename
   * would be an arbitrary-file-read primitive.
   */
  readLegal: 'legal:read',
  /**
   * Reveal `migration-backup/` in the file manager (0.3.0 §4-m). Takes NO
   * path: main derives the one directory this may open, so the renderer never
   * gets to name a target.
   */
  openMigrationBackup: 'shell:open-migration-backup',
  /**
   * Relaunch the app (N7e-3). Takes no arguments and can do nothing else:
   * opening a different library means re-entering every once-per-process gate
   * the boot sequence owns, and a restart is the only way to do that honestly.
   */
  restartApp: 'app:restart',
  /**
   * The main window telling main what the floating lyric window should draw
   * (0.5.0 ⑤). One way, fire and forget: nothing waits for it, and a message
   * that arrives after the window closed is simply dropped.
   */
  desktopLyricsPublish: 'desktop-lyrics:publish',
  /** …and main handing that on to the window itself. */
  desktopLyricsState: 'desktop-lyrics:state',
  /**
   * The lyric window went away without anybody asking main to take it — the
   * person closed it. Closing it IS turning the feature off, so the main
   * window hears about it and writes `enabled = false` back.
   */
  desktopLyricsClosed: 'desktop-lyrics:closed',
} as const;
