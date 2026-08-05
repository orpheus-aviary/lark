// IPC channel names, shared by main (handler) and preload (invoker).

export const IPC_CHANNELS = {
  /** Native multi-select mp3 picker → absolute path array ([] on cancel). */
  pickMp3: 'dialog:pick-mp3',
} as const;
