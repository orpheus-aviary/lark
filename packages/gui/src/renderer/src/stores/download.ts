// The download queue as the GUI sees it (M3-5/M3-6 + D17/D18).
//
// `GET /download/tasks` is the whole truth; the `download:*` events carry just
// enough to move a row without a refetch, and anything richer is a refresh.
// `download:status` is deduped PER TASK on (state, stage, revision), because
// two parallel tasks legitimately agree on that tuple (M4-13③).
//
// Cancelling is a local overlay on purpose: `POST /download/cancel` usually
// answers while the task is STILL running (the abort is set, the worker
// finishes on its own), so the button needs a state between "clicked" and the
// terminal event that actually confirms it.

// The record and the one predicate over it, from the Node-free slice the phone
// links (P8a). The renderer is the second host of both.
import { type DownloadHistoryData, type DownloadRecord, isTerminal } from '@lark/core/portable';
import type {
  DownloadBatchData,
  DownloadBatchGroupInput,
  DownloadBatchesData,
  DownloadCancelAllData,
  DownloadCancelRequest,
  DownloadNamingMode,
  DownloadParseRequest,
  DownloadSongRequest,
  DownloadTaskAcceptedData,
  DownloadTaskData,
  DownloadTasksData,
  FetchListData,
  FetchListRequest,
  ImportResultData,
  ImportSongsRequest,
  LarkEvent,
  ParseResultData,
} from '@lark/shared';
import { API_PATHS, ApiError, createDownloadStatusDedupe, request } from '@lark/shared';
import { create } from 'zustand';
import { createLane } from '../lib/lanes.js';
import { reconcilePending, setPendingTaskRefresher } from '../player/pending.js';

const tasksLane = createLane();
const historyLane = createLane();
const dedupe = createDownloadStatusDedupe();

interface DownloadState {
  tasks: readonly DownloadTaskData[];
  batches: readonly DownloadBatchData[];
  /** Tasks the user asked to cancel that have not reached a terminal state. */
  cancelling: readonly string[];
  /**
   * What has already finished, from the daemon's FILE (0.5.0 P8b).
   *
   * Not derived from `tasks`: the engine's ring is a launch's memory and ages
   * out, while this outlives the process — which is the whole of ④'s second
   * half. 「已结束」 reads this and nothing else.
   */
  history: readonly DownloadRecord[];
  refresh: () => void;
  refreshHistory: () => void;
  /** Feed one `download:*` event in. */
  applyEvent: (event: LarkEvent) => void;
  /**
   * Forget the dedupe history. Called on every `hello`: a reconnect may have
   * missed events, and the tuples remembered from the previous connection
   * must not suppress the ones that describe the state now (M4-13③).
   */
  resetEventStream: () => void;
  cancel: (taskId: string) => Promise<void>;
  /** Ask every active task to stop; answers per task (§4-f). */
  cancelAll: () => Promise<DownloadCancelAllData>;
  /**
   * 清除记录 — really clears it (0.5.0 P8c).
   *
   * It used to hide rows in this window, because the only history there was
   * lived in the daemon's ring and another window had its own idea of what it
   * had read. Now there is a file, one library has one record, and hiding a
   * row from one window would be the lie.
   */
  clearHistory: () => Promise<void>;
  parse: (input: string) => Promise<ParseResultData>;
  /**
   * `naming` is required for a video link and refused for a keyword — the
   * daemon decides which the input is, so the caller passes what it knows and
   * `undefined` means "a keyword" (§3.6-1).
   */
  downloadSong: (
    input: string,
    playlistId?: string,
    naming?: DownloadNamingMode,
  ) => Promise<string>;
  fetchList: (query: FetchListRequest) => Promise<FetchListData>;
  submitBatch: (groups: readonly DownloadBatchGroupInput[]) => Promise<DownloadBatchData[]>;
  importFiles: (paths: readonly string[]) => Promise<ImportResultData>;
}

export const useDownloads = create<DownloadState>((set, get) => ({
  tasks: [],
  batches: [],
  cancelling: [],
  history: [],

  refresh: () => {
    void tasksLane
      .run((signal) =>
        request<DownloadTasksData>('GET', API_PATHS.downloadTasks, undefined, { signal }),
      )
      .then((envelope) => {
        if (envelope === null || !envelope.data) return;
        const { tasks, batches } = envelope.data;
        set({
          tasks,
          batches,
          // A task that reached a terminal state is no longer cancelling.
          cancelling: get().cancelling.filter((id) =>
            tasks.some(
              (task) => task.id === id && (task.state === 'queued' || task.state === 'running'),
            ),
          ),
        });
        // Every snapshot is a settlement point for the pending play intent —
        // the SSE terminal events funnel here too, so there is one reducer and
        // no dependence on an event nobody replays (M5-9).
        reconcilePending(tasks);
      })
      .catch(() => {
        // The connection indicator already says the daemon is unreachable.
      });
  },

  refreshHistory: () => {
    void historyLane
      .run((signal) =>
        request<DownloadHistoryData>('GET', API_PATHS.downloadHistory, undefined, { signal }),
      )
      .then((envelope) => {
        if (envelope === null || !envelope.data) return;
        set({ history: envelope.data.records });
      })
      .catch(() => {
        // Same as the snapshot's: the connection indicator speaks for this.
      });
  },

  applyEvent: (event) => {
    switch (event.type) {
      case 'download:status': {
        if (!dedupe.isFresh(event)) return;
        // A task that just ended is a new row in the RECORD, which is a file
        // rather than the snapshot this event patches. The lane coalesces, so
        // a batch of forty settling at once costs one round trip.
        if (isTerminal(event.state)) get().refreshHistory();
        const known = get().tasks.some((task) => task.id === event.task_id);
        // An unseen task id means a task appeared while we were not looking —
        // only the snapshot has its input, kind and targets.
        if (!known) {
          get().refresh();
          return;
        }
        set({
          tasks: get().tasks.map((task) =>
            task.id === event.task_id
              ? {
                  ...task,
                  state: event.state,
                  stage: event.stage,
                  revision: event.revision,
                  // Every field the event carries has to be copied here. These
                  // four were the whole point of two events — byte progress
                  // (§3.5) and the resolved name (§3.6-1) — and a task updated
                  // in place from a snapshot's values would report the transfer
                  // that was running when the panel last refetched.
                  received_bytes: event.received_bytes,
                  total_bytes: event.total_bytes,
                  title: event.title,
                  artist: event.artist,
                }
              : task,
          ),
        });
        return;
      }
      case 'download:complete':
      case 'download:error':
      case 'download:cancelled':
      case 'download:batches-changed':
        // Terminal detail (error text, failed playlist targets, batch finals)
        // only exists in the snapshot.
        get().refresh();
        return;
      default:
        return;
    }
  },

  resetEventStream: () => {
    dedupe.clear();
  },

  cancel: async (taskId) => {
    if (!get().cancelling.includes(taskId)) set({ cancelling: [...get().cancelling, taskId] });
    try {
      const envelope = await request<DownloadTaskData>('POST', API_PATHS.downloadCancel, {
        task_id: taskId,
      } satisfies DownloadCancelRequest);
      // The answer is usually still `running`: the abort is set and the worker
      // settles on its own, so the terminal state arrives as an event.
      if (envelope.data) {
        const updated = envelope.data;
        set({ tasks: get().tasks.map((task) => (task.id === taskId ? updated : task)) });
      }
    } catch (err) {
      set({ cancelling: get().cancelling.filter((id) => id !== taskId) });
      if (err instanceof ApiError && err.errorCode === 'TASK_NOT_CANCELLABLE') {
        throw new ApiError(err.status, err.errorCode, '当前阶段不可取消，请等它结束');
      }
      throw err;
    }
  },

  cancelAll: async () => {
    const active = get()
      .tasks.filter((task) => task.state === 'queued' || task.state === 'running')
      .map((task) => task.id);
    set({ cancelling: [...new Set([...get().cancelling, ...active])] });
    try {
      const envelope = await request<DownloadCancelAllData>('POST', API_PATHS.downloadCancelAll);
      get().refresh();
      return envelope.data ?? { cancelled: 0, results: [] };
    } catch (err) {
      set({ cancelling: get().cancelling.filter((id) => !active.includes(id)) });
      throw err;
    }
  },

  clearHistory: async () => {
    await request<DownloadHistoryData>('DELETE', API_PATHS.downloadHistory);
    set({ history: [] });
  },

  parse: async (input) => {
    const envelope = await request<ParseResultData>('POST', API_PATHS.downloadParse, {
      input,
    } satisfies DownloadParseRequest);
    return envelope.data ?? { items: [] };
  },

  downloadSong: async (input, playlistId, naming) => {
    const body: DownloadSongRequest = { input };
    // §4.1: the virtual `all` view sends no playlist at all — never `'all'`.
    if (playlistId !== undefined) body.playlist_id = playlistId;
    if (naming !== undefined) body.naming_mode = naming;
    const envelope = await request<DownloadTaskAcceptedData>('POST', API_PATHS.downloadSong, body);
    get().refresh();
    return envelope.data?.task_id ?? '';
  },

  fetchList: async (query) => {
    const envelope = await request<FetchListData>('POST', API_PATHS.downloadFetchList, query);
    // Normalised at the wire boundary: the dialog renders this directly, and a
    // missing `videos` there would take the whole dialog down.
    const data = envelope.data;
    return {
      title: data?.title ?? '',
      videos: data?.videos ?? [],
      error: data?.error ?? null,
    };
  },

  submitBatch: async (groups) => {
    const envelope = await request<DownloadBatchesData>('POST', API_PATHS.downloadBatch, {
      groups,
    });
    get().refresh();
    return [...(envelope.data?.batches ?? [])];
  },

  importFiles: async (paths) => {
    const envelope = await request<ImportResultData>('POST', API_PATHS.songImport, {
      file_paths: paths,
    } satisfies ImportSongsRequest);
    return envelope.data ?? { imported: [], failed: [] };
  },
}));

/** The task the status line is about: what is running now, else what is next. */
export function activeTask(tasks: readonly DownloadTaskData[]): DownloadTaskData | null {
  const running = tasks.filter((task) => task.state === 'running');
  if (running.length > 0) {
    return running.reduce((latest, task) =>
      (task.started_at ?? 0) > (latest.started_at ?? 0) ? task : latest,
    );
  }
  const queued = tasks.filter((task) => task.state === 'queued');
  if (queued.length === 0) return null;
  return queued.reduce((earliest, task) =>
    task.created_at < earliest.created_at ? task : earliest,
  );
}

// `requestPendingPlay` needs a snapshot right after it queues its task; the
// lane that owns snapshots lives here.
setPendingTaskRefresher(() => {
  useDownloads.getState().refresh();
});
