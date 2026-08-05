// Public config mirror (M4-12): font sizes land as CSS variables; the rest is
// read by whoever needs it. Refreshed on every connectionEpoch (hello includes
// config — a daemon restart may have reloaded the file) and after a PATCH.

import type { PublicLarkConfig } from '@lark/shared';
import { API_PATHS, request } from '@lark/shared';
import { create } from 'zustand';
import { createLane } from '../lib/lanes.js';

interface ConfigState {
  config: PublicLarkConfig | null;
  refresh: () => void;
  /** Adopt a config the caller already holds (PATCH responses carry it). */
  adopt: (config: PublicLarkConfig) => void;
}

const configLane = createLane();

export const useConfig = create<ConfigState>((set) => ({
  config: null,
  refresh: () => {
    void configLane
      .run((signal) => request<PublicLarkConfig>('GET', API_PATHS.config, undefined, { signal }))
      .then((envelope) => {
        if (envelope?.data) set({ config: envelope.data });
      })
      .catch(() => {
        // Offline is a visible state already; the stale mirror stays.
      });
  },
  adopt: (config) => set({ config }),
}));
