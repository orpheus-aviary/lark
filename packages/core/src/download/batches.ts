// Batch bookkeeping (M3-5).
//
// A batch exists because a task ring cannot answer "how did my 60-video
// import go?". Terminal tasks age out, so each item keeps its own terminal
// snapshot, written back the moment its task finishes — the batch survives
// its tasks.
//
// Kept separate from the engine because it is pure record-keeping: no queue,
// no claims, no worker. The engine tells it what happened.

import type { DownloadBatchData, DownloadBatchGroupInput } from '@lark/shared';
import { eq } from 'drizzle-orm';
import { NotFoundError } from '../errors.js';
import type { PortableDrizzle } from '../portable/db.js';
import { playlists } from '../portable/schema.js';
import type { DownloadTarget } from './target.js';
import { type TaskRecord, isTerminal } from './task-data.js';

/** Batches retained for `GET /download/tasks`. */
const BATCH_RING = 20;

export type BatchItemFinal = DownloadBatchData['items'][number]['final'];

interface BatchRecord {
  id: string;
  target: DownloadBatchData['target'];
  createdAt: number;
  items: { index: number; taskId: string; final: BatchItemFinal }[];
}

export class BatchRegistry {
  readonly #batches: BatchRecord[] = [];

  /** Start a batch. Items are appended as their tasks are registered. */
  open(id: string, target: DownloadBatchData['target'], createdAt: number): BatchBuilder {
    const record: BatchRecord = { id, target, createdAt, items: [] };
    this.#batches.push(record);
    while (this.#batches.length > BATCH_RING) this.#batches.shift();
    return {
      id,
      add: (index, task) => {
        record.items.push({ index, taskId: task.id, final: finalOf(task) });
      },
      data: () => toBatchData(record),
    };
  }

  /** Stamp a finished task's outcome onto every batch item referencing it. */
  recordTerminal(task: TaskRecord): void {
    for (const batch of this.#batches) {
      for (const item of batch.items) {
        if (item.taskId === task.id) item.final = finalOf(task);
      }
    }
  }

  snapshot(): DownloadBatchData[] {
    return this.#batches.map(toBatchData);
  }
}

export interface BatchBuilder {
  readonly id: string;
  add(index: number, task: TaskRecord): void;
  data(): DownloadBatchData;
}

function finalOf(task: TaskRecord | undefined): BatchItemFinal {
  if (task === undefined || !isTerminal(task.state)) return null;
  return {
    state: task.state as 'succeeded' | 'failed' | 'cancelled',
    error_code: task.errorCode,
    song_id: task.result?.song_id ?? null,
  };
}

function toBatchData(batch: BatchRecord): DownloadBatchData {
  return {
    id: batch.id,
    target: batch.target,
    total: batch.items.length,
    items: batch.items.map((item) => ({
      index: item.index,
      task_id: item.taskId,
      final: item.final,
    })),
    created_at: batch.createdAt,
  };
}

/** A request item as the pipeline's target type. */
export function toTarget(item: DownloadBatchGroupInput['items'][number]): DownloadTarget {
  return item.kind === 'keyword'
    ? { kind: 'keyword', query: item.query }
    : {
        kind: 'video',
        bvid: item.bvid,
        page: item.page,
        title: item.title,
        naming: item.naming,
      };
}

/**
 * Resolve a requested target into the snapshot form, which always carries a
 * concrete playlist id and name — that is what M4 navigates to after a
 * `{kind: 'new'}` request (fourth review ⑤).
 */
export function resolveBatchTarget(
  db: PortableDrizzle,
  target: DownloadBatchGroupInput['target'],
  createdId: string | undefined,
): DownloadBatchData['target'] {
  if (target.kind === 'all') return { kind: 'all' };
  const id = target.kind === 'new' ? (createdId as string) : target.playlist_id;
  const row = db.select().from(playlists).where(eq(playlists.id, id)).get();
  if (row === undefined) throw new NotFoundError('playlist', id);
  return { kind: 'playlist', playlist_id: row.id, name: row.name };
}
