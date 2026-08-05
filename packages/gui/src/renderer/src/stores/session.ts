// Session store — the two epochs (M4-8), NEVER conflated:
//
// - `connectionEpoch` increments on every `hello` (each SSE connection start,
//   including plain reconnects). It triggers full refreshes only — no
//   component may remount on it.
// - `daemonGeneration` increments only when the daemon PROCESS is observed to
//   have changed (token content or /status pid changed across a reconnect).
//   It is what allows the media pipeline to remount (M4-9).

import { create } from 'zustand';

export type SseStatus = 'connecting' | 'online' | 'offline';

interface SessionState {
  connectionEpoch: number;
  daemonGeneration: number;
  sseStatus: SseStatus;
  bumpEpoch: () => void;
  bumpGeneration: () => void;
  setSseStatus: (status: SseStatus) => void;
}

export const useSession = create<SessionState>((set) => ({
  connectionEpoch: 0,
  daemonGeneration: 0,
  sseStatus: 'connecting',
  bumpEpoch: () => set((s) => ({ connectionEpoch: s.connectionEpoch + 1 })),
  bumpGeneration: () => set((s) => ({ daemonGeneration: s.daemonGeneration + 1 })),
  setSseStatus: (sseStatus) => set({ sseStatus }),
}));
