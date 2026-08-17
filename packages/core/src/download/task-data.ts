// The task record and its translations to the wire (M3-5).
//
// Split out of `engine.ts` because none of it is scheduling: it is the shape a
// task has, the key two requests are compared by, and the code an error
// becomes. All pure — the engine holds the state, this decides what it looks
// like from outside.

import type {
  DownloadStage,
  DownloadTaskData,
  DownloadTaskInput,
  DownloadTaskKind,
  LlmConfig,
  TaskState,
} from '@lark/shared';
import {
  CodedError,
  InvalidSourceError,
  NotFoundError,
  SourceKeyConflictError,
} from '../errors.js';
import type { ClaimToken, ClaimType } from './claims.js';
import type { DownloadTarget } from './pipeline.js';

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/** The stage past which a task can no longer be cancelled (M3-5). */
export const POINT_OF_NO_RETURN: DownloadStage = 'saving';

export const isTerminal = (state: TaskState): boolean => TERMINAL_STATES.has(state);

/** Everything the engine tracks about one task; a superset of the wire shape. */
export interface TaskRecord {
  id: string;
  kind: DownloadTaskKind;
  state: TaskState;
  stage: DownloadStage | null;
  revision: number;
  input: DownloadTaskInput;
  songId: string | null;
  /** What to call this task in a list; see `DownloadTaskData.title`. */
  title: string | null;
  artist: string | null;
  playlistIds: string[];
  /** Targets merged in after the freeze; applied after the commit. */
  latePlaylistIds: string[];
  failedPlaylistIds: string[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  result: { song_id: string } | null;
  /** Bytes of THIS stage's transfer; zeroed on every stage change (§3.5). */
  receivedBytes: number;
  totalBytes: number | null;
  /** What the last EMITTED progress event said, for the throttle (§4-d). */
  progressEmittedAt: number;
  progressEmittedBytes: number;

  dedupeKey: string;
  target: DownloadTarget | null;
  targetsFrozen: boolean;
  cancelRequested: boolean;
  controller: AbortController;
  llm: LlmConfig | null;
  claims: ClaimToken[];
}

export function toTaskData(task: TaskRecord): DownloadTaskData {
  return {
    id: task.id,
    kind: task.kind,
    state: task.state,
    stage: task.stage,
    revision: task.revision,
    input: task.input,
    song_id: task.songId,
    playlist_ids: [...task.playlistIds],
    failed_playlist_ids: [...task.failedPlaylistIds],
    created_at: task.createdAt,
    started_at: task.startedAt,
    finished_at: task.finishedAt,
    error_code: task.errorCode,
    error_message: task.errorMessage,
    result: task.result,
    received_bytes: task.receivedBytes,
    total_bytes: task.totalBytes,
    title: task.title,
    artist: task.artist,
  };
}

/** Lyrics tasks and audio writers arbitrate over different files. */
export function claimTypeFor(kind: DownloadTaskKind): ClaimType {
  return kind === 'lyrics' ? 'lyrics' : 'file';
}

/**
 * The dedupe key.
 *
 * `bvid:auto` and `bvid:1` are deliberately DIFFERENT keys (fifth review ①).
 * "no page given" means the model may pick part 2, so merging it with an
 * explicit `?p=1` could hand the explicit request the wrong part. auto merges
 * only with auto.
 */
export function downloadDedupeKey(target: DownloadTarget): string {
  if (target.kind === 'keyword') {
    return `download:kw:${target.query.trim().toLowerCase().replace(/\s+/g, ' ')}`;
  }
  return `download:${target.bvid}:${target.page ?? 'auto'}`;
}

/**
 * Map a thrown value onto a task error code.
 *
 * The explicit cases matter (fifth review ④): batch items skip the route's
 * preflight, so an out-of-range `?p=` surfaces here as `InvalidSourceError`,
 * and a catch-all would report it as INTERNAL_ERROR — telling the user "lark
 * broke" about their own typo.
 *
 * The catch-all message is fixed text. A raw error can carry a SQLite path or
 * an upstream response body, and neither belongs on the wire (fifth review ⑩);
 * the real one goes to the log.
 */
export function describeTaskError(err: unknown): { code: string; message: string } {
  if (err instanceof CodedError) return { code: err.code, message: err.message };
  if (err instanceof InvalidSourceError) return { code: 'INVALID_SOURCE', message: err.message };
  if (err instanceof SourceKeyConflictError) {
    return { code: 'SOURCE_KEY_CONFLICT', message: err.message };
  }
  if (err instanceof NotFoundError) return { code: 'NOT_FOUND', message: err.message };
  return { code: 'INTERNAL_ERROR', message: '下载任务出现内部错误，详情见日志' };
}
