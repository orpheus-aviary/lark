// Cache usage as the settings page sees it (M5-18).
//
// Its own lane (`cache-status`): reopening the dialog while a status request
// is in flight supersedes that one, and nothing else's refresh may abort it.

import type { CacheEvictResultData, CacheStatusData } from '@lark/shared';
import { API_PATHS, request } from '@lark/shared';
import { create } from 'zustand';
import { createLane } from '../lib/lanes.js';

const statusLane = createLane();

interface CacheState {
  status: CacheStatusData | null;
  loading: boolean;
  /**
   * True while the settings page is showing these numbers. `cache:evicted`
   * refreshes them only then — nobody else displays cache usage, and the
   * event arrives once per evicted song (M5-19).
   */
  watching: boolean;
  /** True while a manual eviction runs — it can take a while (it probes). */
  evicting: boolean;
  setWatching: (watching: boolean) => void;
  refresh: () => void;
  /** Run an eviction and adopt the status it answers with. Throws on failure. */
  evict: () => Promise<CacheEvictResultData>;
}

export const useCache = create<CacheState>((set) => ({
  status: null,
  loading: false,
  evicting: false,
  watching: false,

  setWatching: (watching) => set({ watching }),

  refresh: () => {
    set({ loading: true });
    void statusLane
      .run((signal) =>
        request<CacheStatusData>('GET', API_PATHS.cacheStatus, undefined, { signal }),
      )
      .then((envelope) => {
        if (envelope === null) return; // superseded; the newer run owns the state
        if (envelope.data) set({ status: envelope.data, loading: false });
      })
      .catch(() => {
        set({ loading: false });
      });
  },

  evict: async () => {
    set({ evicting: true });
    try {
      const envelope = await request<CacheEvictResultData>('POST', API_PATHS.cacheEvict);
      const result = envelope.data as CacheEvictResultData;
      // The response already carries the recomputed status — no second fetch.
      set({ status: result });
      return result;
    } finally {
      set({ evicting: false });
    }
  },
}));
