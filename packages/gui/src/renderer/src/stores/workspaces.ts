// The libraries this device holds (N7e-3).
//
// Since N7 one install can have several: `local`, where the library has always
// been, and one per account under `libraries/<id>/`. Which one is OPEN is
// decided at launch and never changes under a running process — so this store
// mirrors two different facts and must not collapse them:
//
//   `serving`  the library this daemon actually has open. What the song list,
//              the player and every count on screen are about.
//   `active`   the one the NEXT launch will open. Equal to `serving` except in
//              the window between a switch and the restart that honours it.
//
// A switcher that showed only one of them would either lie about what is on
// screen or lose the fact that a switch already happened.

import type { WorkspaceData, WorkspaceSwitchData, WorkspacesData } from '@lark/shared';
import { API_PATHS, request } from '@lark/shared';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors.js';
import { createLane } from '../lib/lanes.js';

const listLane = createLane();

interface WorkspacesState {
  /** `null` until the first answer — "unknown", never rendered as "only local". */
  workspaces: readonly WorkspaceData[] | null;
  /** What this daemon has open. `null` until the first answer. */
  serving: string | null;
  /** Leftover sync state in the library being served (owl's B8 warning). */
  servingHasSyncTraces: boolean;
  error: string | null;
  refresh: () => void;
  /** Write the switch. The caller decides whether to restart. */
  switchTo: (id: string) => Promise<WorkspaceSwitchData>;
}

export const useWorkspaces = create<WorkspacesState>((set, get) => ({
  workspaces: null,
  serving: null,
  servingHasSyncTraces: false,
  error: null,

  refresh: () => {
    void listLane
      .run((signal) => request<WorkspacesData>('GET', API_PATHS.workspaces, undefined, { signal }))
      .then((envelope) => {
        if (envelope === null || !envelope.data) return;
        // Shape-checked rather than trusted: this route arrived at wire
        // version 7, and an older daemon answers 404 — but a NEWER one, or a
        // reverse proxy with an opinion, can answer 200 with something else.
        // Rendering `undefined.map` would take the whole settings tab down.
        if (!Array.isArray(envelope.data.workspaces)) {
          set({ error: 'daemon 没有报出曲库列表' });
          return;
        }
        set({
          workspaces: envelope.data.workspaces,
          serving: envelope.data.serving,
          servingHasSyncTraces: envelope.data.serving_has_sync_traces,
          error: null,
        });
      })
      .catch((err: unknown) => {
        // Kept rather than swallowed: "one library" and "we could not ask"
        // look identical on screen otherwise.
        set({ error: errorMessage(err) });
      });
  },

  switchTo: async (id) => {
    const envelope = await request<WorkspaceSwitchData>('POST', API_PATHS.workspacesSwitch, {
      workspace_id: id,
    });
    get().refresh();
    return envelope.data as WorkspaceSwitchData;
  },
}));
