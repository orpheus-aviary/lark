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
  /**
   * Read one of the two shipped licence documents (M7-9). The renderer names
   * a document from a closed set, never a path — an IPC that took a filename
   * would be an arbitrary-file-read primitive.
   */
  readLegal: 'legal:read',
} as const;
