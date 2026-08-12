// skybridge sync as the GUI sees it (v0.2 T4, §4.7).
//
// The daemon owns every decision here — when to run, what to push, what a
// failed file effect means. This store only mirrors what it says and forwards
// the three actions a person can take: run a round now, retry a stuck file
// operation, or abandon one.
//
// Two feeds, deliberately unequal (§4.4):
//
//   `sync:status_changed` carries the STATE and nothing else, so it is a
//     refetch trigger — every number the popover shows still comes from
//     `GET /sync/status`. Duplicating counters onto the event would give the
//     renderer two sources for the same figure and no rule for which is newer.
//   `conflicts:changed` carries its count, because that is the whole of what
//     the badge needs and a round-trip per resolve would buy nothing.
//
// The failed-file-op list is fetched separately and only when something is
// looking at it: it is the one read whose rows carry per-op detail, and its
// ids are what `retry` and `discard` take.

import type {
  ConflictCountData,
  SyncDeviceData,
  SyncDevicesData,
  SyncFileOpRunData,
  SyncFileOpSummary,
  SyncFileOpsData,
  SyncLoginRequest,
  SyncLoginResultData,
  SyncLogoutResultData,
  SyncRevokeDeviceRequest,
  SyncRunResultData,
  SyncStatusData,
} from '@lark/shared';
import { API_PATHS, request } from '@lark/shared';
import { create } from 'zustand';
import { errorMessage } from '../lib/errors.js';
import { createLane } from '../lib/lanes.js';

const statusLane = createLane();
const conflictsLane = createLane();
const fileOpsLane = createLane();
const devicesLane = createLane();

interface SyncState {
  /** `null` until the first answer — "unknown", never rendered as "off". */
  status: SyncStatusData | null;
  conflicts: number;
  /**
   * Only the rows that gave up (`attempts >= 5`). Pending ops need no human,
   * and `status.pending_file_ops` already counts them.
   */
  failedFileOps: readonly SyncFileOpSummary[];
  /** True while a manual round is in flight — the button must not re-arm. */
  running: boolean;
  /**
   * The account's devices. Unlike everything else here this is a REMOTE read
   * (the daemon proxies it to skybridge), so it is fetched only when the sync
   * settings are on screen, and its failure is reported next to the list
   * rather than as a toast — an offline laptop is not an error the user asked
   * for.
   */
  devices: readonly SyncDeviceData[];
  devicesError: string | null;
  refresh: () => void;
  refreshConflicts: () => void;
  /** Adopt the count off a `conflicts:changed` frame. */
  adoptConflicts: (count: number) => void;
  refreshFileOps: () => void;
  /** Run a round now. Throws; the caller decides how to say so. */
  run: () => Promise<SyncRunResultData>;
  /** Retry one failed op, or every failed op when `id` is omitted. */
  retryFileOps: (id?: number) => Promise<SyncFileOpRunData>;
  /** Abandon one permanently-failed op. Destructive: confirm before calling. */
  discardFileOp: (id: number) => Promise<void>;
  refreshDevices: () => void;
  /** The whole install sequence, daemon-side. Throws — the form shows why. */
  login: (body: SyncLoginRequest) => Promise<SyncLoginResultData>;
  logout: () => Promise<SyncLogoutResultData>;
  revokeDevice: (deviceId: string) => Promise<void>;
}

export const useSync = create<SyncState>((set, get) => ({
  status: null,
  conflicts: 0,
  failedFileOps: [],
  running: false,
  devices: [],
  devicesError: null,

  refresh: () => {
    void statusLane
      .run((signal) => request<SyncStatusData>('GET', API_PATHS.syncStatus, undefined, { signal }))
      .then((envelope) => {
        if (envelope === null) return; // superseded; the newer run owns the state
        if (envelope.data) set({ status: envelope.data });
      })
      .catch(() => {
        // An unreachable daemon is already said out loud by the session dot;
        // a stale mirror beats blanking the badge on one failed poll.
      });
  },

  refreshConflicts: () => {
    void conflictsLane
      .run((signal) =>
        request<ConflictCountData>('GET', API_PATHS.conflictsCount, undefined, { signal }),
      )
      .then((envelope) => {
        if (envelope === null) return;
        if (envelope.data) set({ conflicts: envelope.data.count });
      })
      .catch(() => {
        // Same reasoning as the status poll.
      });
  },

  adoptConflicts: (conflicts) => set({ conflicts }),

  refreshFileOps: () => {
    void fileOpsLane
      .run((signal) =>
        request<SyncFileOpsData>('GET', `${API_PATHS.syncFileOps}?state=failed`, undefined, {
          signal,
        }),
      )
      .then((envelope) => {
        if (envelope === null) return;
        if (envelope.data) set({ failedFileOps: envelope.data.file_ops });
      })
      .catch(() => {
        // Leave the last list up; the counter in the status says how many
        // there really are.
      });
  },

  run: async () => {
    set({ running: true });
    try {
      const envelope = await request<SyncRunResultData>('POST', API_PATHS.syncRun);
      get().refresh();
      return envelope.data as SyncRunResultData;
    } finally {
      set({ running: false });
    }
  },

  retryFileOps: async (id) => {
    const envelope = await request<SyncFileOpRunData>(
      'POST',
      API_PATHS.syncFileOpsRetry,
      id === undefined ? {} : { id },
    );
    // A retry either drains the row or fails it again with a fresh error, and
    // both change what the list and the counters should show.
    get().refresh();
    get().refreshFileOps();
    return envelope.data as SyncFileOpRunData;
  },

  discardFileOp: async (id) => {
    await request('POST', API_PATHS.syncFileOpsDiscard, { id });
    get().refresh();
    get().refreshFileOps();
  },

  refreshDevices: () => {
    void devicesLane
      .run((signal) =>
        request<SyncDevicesData>('GET', API_PATHS.syncDevices, undefined, { signal }),
      )
      .then((envelope) => {
        if (envelope === null) return;
        if (envelope.data) set({ devices: envelope.data.devices, devicesError: null });
      })
      .catch((err: unknown) => {
        // Kept, not swallowed: "the device list is empty" and "we could not
        // ask" look identical on screen otherwise, and only one of them means
        // this machine is the only device.
        set({ devices: [], devicesError: errorMessage(err) });
      });
  },

  login: async (body) => {
    const envelope = await request<SyncLoginResultData>('POST', API_PATHS.syncLogin, body);
    get().refresh();
    get().refreshConflicts();
    get().refreshDevices();
    return envelope.data as SyncLoginResultData;
  },

  logout: async () => {
    const envelope = await request<SyncLogoutResultData>('POST', API_PATHS.syncLogout);
    // The binding, the cursor and the outbox all survive a logout (§3.7) — the
    // only thing that changed is that nothing can be sent until the next login.
    set({ devices: [], devicesError: null });
    get().refresh();
    return envelope.data as SyncLogoutResultData;
  },

  revokeDevice: async (deviceId) => {
    await request('POST', API_PATHS.syncRevokeDevice, {
      device_id: deviceId,
    } satisfies SyncRevokeDeviceRequest);
    get().refreshDevices();
    // Revoking THIS device ends the session on the next round, so the status
    // is worth re-reading even though the call was about a device.
    get().refresh();
  },
}));
