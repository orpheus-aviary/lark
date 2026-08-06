// IPC channel names, shared by main (handler) and preload (invoker).

export const IPC_CHANNELS = {
  /** Native multi-select mp3 picker → absolute path array ([] on cancel). */
  pickMp3: 'dialog:pick-mp3',
  /** Open an http(s) link in the user's browser (R10); false when refused. */
  openExternal: 'shell:open-external',
  /** Single-select .json picker for an import file → path, or null on cancel. */
  pickJsonFile: 'dialog:pick-json',
  /** Save dialog + atomic write for an export file; false on cancel. */
  saveExportFile: 'dialog:save-export',
} as const;
