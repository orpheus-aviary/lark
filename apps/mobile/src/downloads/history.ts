// Which downloads have already happened, kept across launches (0.1.1 ⑦⑧⑨).
//
// WHAT THIS REPLACES. The engine keeps a ring of the last 100 terminal tasks
// IN MEMORY (`portable/download/engine.ts`), and the list showed the newest 20
// of them. Both numbers are the engine's own business and neither survives the
// process — so a download that failed while you were on the bus was gone by
// the time you looked, with no way to see what happened or to ask for it
// again. Nothing here changes the ring; the screen simply reads finished work
// from this instead.
//
// 🔴 NOT IN `songs.db`. schema v3 is shared with the desktop, so a table would
// be a migration plus a matching desktop change, and this is a fact about one
// phone's downloads rather than about anybody's library. One JSON file per
// workspace, written atomically, alongside the library it belongs to.
//
// SEEN IS NOT KEPT. `known` remembers every task id this process has already
// decided about, and 清空记录 / 删除一条 do NOT forget them: the engine's ring
// still holds those tasks, so a store that re-derived from it would put back
// what somebody just deleted, on the next status event, for the rest of the
// launch.
//
// WHAT A RECORD CARRIES is what re-running it needs, and no more. Notably NOT
// the naming mode: it is not on `DownloadTaskData`, and a retry runs under
// whatever 命名 is chosen now — the honest reading of a button pressed today.
//
// 🔴 A LYRICS FETCH THAT WORKED IS NOT A RECORD. The engine spawns one after
// every successful download (`engine.ts` `#deriveLyrics`), and since those
// tasks carry the song's name the two read as the same row twice —
// `@lark/shared`'s own `KIND_LABELS` says so. In the old list that was twenty
// transient rows; in a file that keeps 200 entries forever it would be half
// the space, saying nothing the download's own row does not.
//
// A lyrics fetch that FAILED is kept, and it is the only place in the app that
// fact exists: the song is in the library with no words, no screen mentions
// it, and 重下 on that row is the only way to ask again.

import type { StructuredLogger } from '@lark/core/portable';
import type { DownloadTaskData, DownloadTaskInput, DownloadTaskKind } from '@lark/shared';
import { DOWNLOAD_TASK_KINDS } from '@lark/shared';
import { isActive } from './cancel';

/**
 * How many finished downloads are kept.
 *
 * A cap and not a window: nothing here expires, and the only reason there is a
 * number at all is that the file is read whole at launch. 200 is roughly a
 * year of somebody's library at the rate one gets built.
 */
export const HISTORY_LIMIT = 200;

/** The three ways a task ends. `queued`/`running` never reach this file. */
export const RECORD_STATES = ['succeeded', 'failed', 'cancelled'] as const;
export type RecordState = (typeof RECORD_STATES)[number];

export interface DownloadRecord {
  /** The engine task it came from — the row key, and how "already seen" works. */
  id: string;
  kind: DownloadTaskKind;
  state: RecordState;
  /** What to call it. `null` for a task that failed before naming ran. */
  title: string | null;
  artist: string | null;
  /** Everything re-running it needs, minus the naming mode (see the header). */
  input: DownloadTaskInput;
  playlist_ids: readonly string[];
  song_id: string | null;
  error_code: string | null;
  error_message: string | null;
  finished_at: number;
}

export interface DownloadHistoryDeps {
  /** The file's text, or `null` when there is no file. May throw. */
  load: () => string | null;
  /** Replace the file, atomically. Rejects if it could not. */
  save: (text: string) => Promise<void>;
  logger?: StructuredLogger;
  limit?: number;
}

export interface DownloadHistory {
  subscribe(listener: () => void): () => void;
  /** Newest first. A stable reference between changes (`useSyncExternalStore`). */
  getRecords(): readonly DownloadRecord[];
  /** Fold the engine's snapshot in. Idempotent; fed by every hub refresh. */
  observe(tasks: readonly DownloadTaskData[]): void;
  /**
   * Put in rows no task produced (0.1.1 ⑤).
   *
   * One caller: a batch that stopped at the cache limit. Those songs never
   * reached the engine, so without this the limit would be a toast that
   * scrolls away — and the songs that did not come down would look exactly
   * like songs nobody asked for.
   *
   * BY ID, replacing: tapping 全部下载 twice is one answer about the same
   * songs, not two.
   */
  add(records: readonly DownloadRecord[]): void;
  remove(id: string): void;
  clear(): void;
  /**
   * Resolve once every write asked for so far has landed.
   *
   * A test seam, like `ui/back.ts`'s reset: nothing in the app waits for this
   * file, because nothing in the app is worse off if it lands a moment later.
   */
  flush(): Promise<void>;
}

const isRecordState = (value: unknown): value is RecordState =>
  RECORD_STATES.some((state) => state === value);

const isKind = (value: unknown): value is DownloadTaskKind =>
  DOWNLOAD_TASK_KINDS.some((kind) => kind === value);

function readInput(value: unknown): DownloadTaskInput | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  if (input.type === 'url' && typeof input.url === 'string') {
    return { type: 'url', url: input.url };
  }
  if (input.type === 'keyword' && typeof input.query === 'string') {
    return { type: 'keyword', query: input.query };
  }
  if (input.type === 'song' && typeof input.song_id === 'string') {
    return { type: 'song', song_id: input.song_id };
  }
  return null;
}

const orNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/**
 * One stored entry, or `null` when it is not one this build understands.
 *
 * Dropping the entry rather than the file is the same rule `device-settings`
 * follows: what cannot be read may have been written by a build that is not
 * this one, and the first write after it replaces the file with what we do
 * understand.
 */
export function readRecord(value: unknown): DownloadRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const row = value as Record<string, unknown>;
  const input = readInput(row.input);
  if (typeof row.id !== 'string' || input === null) return null;
  if (!isKind(row.kind) || !isRecordState(row.state)) return null;
  if (typeof row.finished_at !== 'number' || !Number.isFinite(row.finished_at)) return null;
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    title: orNull(row.title),
    artist: orNull(row.artist),
    input,
    playlist_ids: Array.isArray(row.playlist_ids)
      ? row.playlist_ids.filter((id): id is string => typeof id === 'string')
      : [],
    song_id: orNull(row.song_id),
    error_code: orNull(row.error_code),
    error_message: orNull(row.error_message),
    finished_at: row.finished_at,
  };
}

/**
 * Whether a finished task is worth keeping, as opposed to merely worth having
 * decided about (see the header).
 *
 * The one rule: a lyrics continuation that worked. Everything else was asked
 * for by somebody, or went wrong.
 */
export function worthRecording(record: DownloadRecord): boolean {
  return !(record.kind === 'lyrics' && record.state === 'succeeded');
}

/**
 * Whether this row gets a 重下 button (user, 2026-08-27).
 *
 * NOT the successes, and the reason is not that re-fetching them is wrong —
 * it is that the song's ⋮ menu already carries 重新下载, and a second door to
 * one action is two places to keep in step. What a success needs from this
 * screen is to be listed; what a failure needs is a way to ask again, and
 * there is nowhere else to ask.
 *
 * Cancelled counts as "not succeeded": somebody stopped it, and changing your
 * mind back is the same request as retrying.
 */
export function canRetry(record: DownloadRecord): boolean {
  return record.state !== 'succeeded';
}

/** A finished task, as a record. `null` for one that is still running. */
export function recordOf(task: DownloadTaskData): DownloadRecord | null {
  if (isActive(task) || !isRecordState(task.state)) return null;
  return {
    id: task.id,
    kind: task.kind,
    state: task.state,
    title: task.title,
    artist: task.artist,
    input: task.input,
    playlist_ids: [...task.playlist_ids],
    song_id: task.song_id,
    error_code: task.error_code,
    error_message: task.error_message,
    // A terminal task always has one; `0` rather than a guess if it somehow
    // does not, which sorts it last instead of to the top.
    finished_at: task.finished_at ?? 0,
  };
}

/** Newest first, capped. The one place order and the cap are decided. */
export function ordered(
  records: readonly DownloadRecord[],
  limit: number,
): readonly DownloadRecord[] {
  return [...records].sort((a, b) => b.finished_at - a.finished_at).slice(0, limit);
}

export function createDownloadHistory(deps: DownloadHistoryDeps): DownloadHistory {
  const limit = deps.limit ?? HISTORY_LIMIT;
  const listeners = new Set<() => void>();

  let records: readonly DownloadRecord[] = load();
  /**
   * Every task id already decided about — INCLUDING ones since deleted.
   *
   * See the header: the engine's ring outlives a delete, so this is what stops
   * `observe` from putting them back.
   */
  const known = new Set(records.map((record) => record.id));

  function load(): readonly DownloadRecord[] {
    let text: string | null;
    try {
      text = deps.load();
    } catch (err) {
      deps.logger?.warn(
        { err: String(err) },
        'the download history could not be read — starting this launch with none',
      );
      return [];
    }
    if (text === null) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      deps.logger?.warn(
        { err: String(err) },
        'the download history is not JSON this build can read — leaving the file alone',
      );
      return [];
    }
    if (!Array.isArray(parsed)) {
      deps.logger?.warn({}, 'the download history is not a list — leaving the file alone');
      return [];
    }
    const rows = parsed.map(readRecord).filter((row): row is DownloadRecord => row !== null);
    if (rows.length !== parsed.length) {
      deps.logger?.warn(
        { kept: rows.length, found: parsed.length },
        'some download history entries are not entries this build understands — skipping them',
      );
    }
    return ordered(rows, limit);
  }

  // Writes take turns, for the reason `device-settings` does: two saves racing
  // to replace one file leave whichever finished last, with the other's rows
  // missing.
  let queue = Promise.resolve();

  const commit = (next: readonly DownloadRecord[]): void => {
    records = next;
    for (const listener of listeners) listener();
    queue = queue
      .catch(() => undefined)
      .then(() => deps.save(JSON.stringify(next, null, 2)))
      .catch((err: unknown) => {
        // Nothing is waiting for this and there is no form to report to. What
        // a failure costs is the next launch's list, not this one's.
        deps.logger?.warn({ err: String(err) }, 'could not save the download history');
      });
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getRecords: () => records,

    observe(tasks) {
      const fresh: DownloadRecord[] = [];
      for (const task of tasks) {
        if (known.has(task.id)) continue;
        const record = recordOf(task);
        if (record === null) continue; // still running — ask again next time
        // Decided about, whether or not it is kept: a succeeded lyrics fetch
        // must not be reconsidered on every tick for the rest of the launch.
        known.add(task.id);
        if (!worthRecording(record)) continue;
        fresh.push(record);
      }
      if (fresh.length === 0) return;
      commit(ordered([...fresh, ...records], limit));
    },

    add(incoming) {
      if (incoming.length === 0) return;
      const replaced = new Set(incoming.map((record) => record.id));
      for (const record of incoming) known.add(record.id);
      commit(ordered([...incoming, ...records.filter((r) => !replaced.has(r.id))], limit));
    },

    remove(id) {
      const next = records.filter((record) => record.id !== id);
      if (next.length === records.length) return;
      commit(next);
    },

    clear() {
      if (records.length === 0) return;
      commit([]);
    },

    flush: () => queue,
  };
}

/**
 * What re-running one of these means (0.1.1 ⑦⑨).
 *
 * A DECISION, not an action, for the same reason `decideNext` is: the two
 * answers reach different parts of the app — one goes back through the add
 * page's submit path, the other straight to the engine — and only one of them
 * can be checked without a network.
 *
 * `submit` hands back TEXT rather than a target, and that is deliberate: the
 * stored url or query is exactly what somebody typed, and running it through
 * the same recogniser the add page uses means one parser, one set of refusals,
 * one place that knows what a short link is.
 */
export type RetryPlan =
  | { kind: 'submit'; text: string; playlistIds: readonly string[] }
  | { kind: 'redownload'; songId: string }
  | { kind: 'lyrics'; songId: string };

export function planRetry(record: DownloadRecord): RetryPlan {
  if (record.input.type === 'url') {
    return { kind: 'submit', text: record.input.url, playlistIds: record.playlist_ids };
  }
  if (record.input.type === 'keyword') {
    return { kind: 'submit', text: record.input.query, playlistIds: record.playlist_ids };
  }
  // A task about a song already in the library: lyrics went looking for words,
  // everything else went looking for audio.
  return record.kind === 'lyrics'
    ? { kind: 'lyrics', songId: record.input.song_id }
    : { kind: 'redownload', songId: record.input.song_id };
}
