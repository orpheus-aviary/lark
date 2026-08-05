// The download queue: one worker, a task state machine, and the bookkeeping
// that keeps concurrent requests from tripping over each other (M3-5).
//
// Everything public here is SYNCHRONOUS. That is the central rule: enqueueing,
// merging, cancelling and capacity checks all run to completion without an
// await, so between a check and the write it justifies nothing else can run.
// Network work happens before the call (route-level preflight) or inside the
// worker — never in between. The Go version's queue blocked the HTTP handler
// when its channel filled; this one answers immediately and reports state.
//
// Three pieces of bookkeeping, each solving a specific failure:
//
//   dedupe index    two tabs asking for the same video make ONE download, with
//                   the playlist targets merged. Covers pending tasks only:
//                   a terminal task releases its key, and a repeat then hits
//                   the key lookup in the database and reuses the song.
//   claims          arbitrates the three writers of a song directory
//                   (see claims.ts).
//   revision        every visible change bumps it, including ones with no
//                   state transition, so a client can dedupe events without
//                   dropping a real update.
//
// Batch snapshots live in batches.ts; the task shape and error mapping in
// task-data.ts.

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import type {
  DownloadBatchData,
  DownloadBatchGroupInput,
  DownloadStage,
  DownloadTaskData,
  DownloadTaskInput,
  DownloadTaskKind,
  DownloadTasksData,
  LlmConfig,
  SongData,
  TaskState,
} from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import type { LarkDatabase } from '../db/index.js';
import { playlists, songs } from '../db/schema.js';
import {
  DownloadQueueFullError,
  InvalidSourceError,
  NotFoundError,
  TaskNotCancellableError,
  TaskNotFoundError,
} from '../errors.js';
import { songAudioPath, songDirPath } from '../library/lyrics.js';
import { addSongsToPlaylistInTx, createPlaylist } from '../library/playlists.js';
import {
  createFileBackedSongInTx,
  getSong,
  setFileOrigin,
  updateSongInTx,
} from '../library/songs.js';
import { BatchRegistry, resolveBatchTarget, toTarget } from './batches.js';
import { type BilibiliClient, createBilibiliClient } from './bilibili.js';
import { ClaimRegistry } from './claims.js';
import { isLlmConfigured } from './llm.js';
import type { LyricsOrigins } from './lyrics/shared.js';
import {
  type DownloadTarget,
  type PipelineDeps,
  type ResolvedTarget,
  type StepContext,
  fetchAudio,
  findSongByKey,
  probeSourceKey,
  reidentifySource,
  resolveTarget,
  runLyrics,
} from './pipeline.js';
import { landSongFile } from './resolve.js';
import {
  POINT_OF_NO_RETURN,
  type TaskRecord,
  claimTypeFor,
  describeTaskError,
  downloadDedupeKey,
  isTerminal,
  toTaskData,
} from './task-data.js';
import { DEFAULT_TIMEOUTS, type DownloadTimeouts } from './timeouts.js';

export { describeTaskError, downloadDedupeKey } from './task-data.js';

/** Pending (queued + running) tasks allowed at once. */
export const DEFAULT_QUEUE_CAPACITY = 1000;
/** Terminal tasks kept for `GET /download/tasks`. */
const TERMINAL_RING = 100;

export interface EngineLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

const NOOP_LOGGER: EngineLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface EngineCallbacks {
  onStatus?(task: DownloadTaskData): void;
  onSucceeded?(task: DownloadTaskData): void;
  onFailed?(task: DownloadTaskData): void;
  onCancelled?(task: DownloadTaskData): void;
  onBatchesChanged?(batchId: string): void;
}

export interface DownloadEngineOptions {
  db: LarkDatabase;
  sqlite: BetterSqlite3.Database;
  /**
   * The EFFECTIVE llm config, read fresh per call. Snapshotted once when a
   * task starts, so a config change mid-download cannot swap models halfway
   * (M3-4).
   */
  getLlmConfig: () => LlmConfig;
  bilibili?: BilibiliClient;
  logger?: EngineLogger;
  timeouts?: DownloadTimeouts;
  /** Aborts every in-flight task when the daemon stops (M3-13). */
  shutdownSignal?: AbortSignal;
  fetchImpl?: typeof fetch;
  lyricsOrigins?: Partial<LyricsOrigins>;
  callbacks?: EngineCallbacks;
  capacity?: number;
}

export interface EnqueueDownloadInput {
  target: DownloadTarget;
  /** Playlists the finished song joins. Empty means the library only. */
  playlistIds?: readonly string[];
  /** Normalised display URL, when the input was one. */
  url?: string;
}

export class DownloadEngine {
  readonly #options: DownloadEngineOptions;
  readonly #logger: EngineLogger;
  readonly #timeouts: DownloadTimeouts;
  readonly #capacity: number;
  readonly #bilibili: BilibiliClient;

  readonly #tasks = new Map<string, TaskRecord>();
  readonly #queue: string[] = [];
  readonly #dedupe = new Map<string, string>();
  readonly #batchRegistry = new BatchRegistry();
  readonly claims = new ClaimRegistry();

  #worker: Promise<void> | null = null;
  #stopping = false;

  constructor(options: DownloadEngineOptions) {
    this.#options = options;
    this.#logger = options.logger ?? NOOP_LOGGER;
    this.#timeouts = options.timeouts ?? DEFAULT_TIMEOUTS;
    this.#capacity = options.capacity ?? DEFAULT_QUEUE_CAPACITY;
    this.#bilibili =
      options.bilibili ??
      createBilibiliClient({
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        timeouts: this.#timeouts,
      });
  }

  // ─── Enqueue ─────────────────────────────────────────

  /** Queue one download. Merges into an equivalent pending task if there is one. */
  enqueueDownload(input: EnqueueDownloadInput): DownloadTaskData {
    const key = downloadDedupeKey(input.target);
    const targets = [...new Set(input.playlistIds ?? [])];
    const merged = this.#mergeInto(key, targets);
    if (merged !== null) return merged;

    this.#assertCapacity(1);
    return this.#register({
      kind: 'download',
      dedupeKey: key,
      target: input.target,
      input:
        input.target.kind === 'keyword'
          ? { type: 'keyword', query: input.target.query }
          : {
              type: 'url',
              url: input.url ?? `https://www.bilibili.com/video/${input.target.bvid}`,
            },
      playlistIds: targets,
    });
  }

  /** Force a fresh download of an existing song's audio. */
  enqueueRedownload(songId: string): DownloadTaskData {
    getSong(this.#options.db, this.#options.sqlite, songId); // 404 before anything else
    const key = `redownload:${songId}`;
    const merged = this.#mergeInto(key, []);
    if (merged !== null) return merged;

    this.#assertCapacity(1);
    return this.#register({
      kind: 'redownload',
      dedupeKey: key,
      songId,
      input: { type: 'song', song_id: songId },
      playlistIds: [],
    });
  }

  /** Queue a lyrics fetch. Also how a finished download spawns its own. */
  enqueueLyrics(songId: string, options: { exemptFromCapacity?: boolean } = {}): DownloadTaskData {
    const key = `lyrics:${songId}`;
    const merged = this.#mergeInto(key, []);
    if (merged !== null) return merged;

    // A download's own lyrics continuation is exempt: refusing it would make a
    // full queue silently drop lyrics for every song it just fetched (M3-5).
    if (options.exemptFromCapacity !== true) this.#assertCapacity(1);
    return this.#register({
      kind: 'lyrics',
      dedupeKey: key,
      songId,
      input: { type: 'song', song_id: songId },
      playlistIds: [],
    });
  }

  /**
   * Queue several groups as ONE unit (third review ③).
   *
   * Either every group commits or none does. Half-applying a batch is the
   * worst outcome available: the user sees some new playlists, some tasks, and
   * no way to tell what is missing. So the order is validate → count →
   * capacity → create playlists in one transaction → register, with the
   * capacity decision made BEFORE any write (fourth review ⑦).
   */
  enqueueBatches(groups: readonly DownloadBatchGroupInput[]): DownloadBatchData[] {
    const plans = groups.map((group) => ({
      target: group.target,
      items: group.items.map((item) => ({ item, key: downloadDedupeKey(toTarget(item)) })),
    }));

    for (const plan of plans) {
      if (plan.target.kind === 'playlist') this.#assertPlaylistExists(plan.target.playlist_id);
      if (plan.target.kind === 'new' && plan.target.name.trim() === '') {
        throw new InvalidSourceError('新歌单名称不能为空');
      }
    }

    // Net new = items that will not merge onto something already pending, and
    // that are not duplicates of each other within this request.
    const willCreate = new Set<string>();
    for (const plan of plans) {
      for (const { key } of plan.items) if (!this.#dedupe.has(key)) willCreate.add(key);
    }
    this.#assertCapacity(willCreate.size);

    const createdIds = this.#options.sqlite
      .transaction(() => {
        const ids = new Map<number, string>();
        plans.forEach((plan, index) => {
          if (plan.target.kind !== 'new') return;
          const created = createPlaylist(
            this.#options.db,
            this.#options.sqlite,
            plan.target.name.trim(),
          );
          ids.set(index, created.id);
        });
        return ids;
      })
      .immediate();

    const now = Date.now();
    return plans.map((plan, index) => {
      const resolved = resolveBatchTarget(this.#options.db, plan.target, createdIds.get(index));
      const playlistIds = resolved.kind === 'playlist' ? [resolved.playlist_id] : [];
      const batch = this.#batchRegistry.open(randomUUID(), resolved, now);

      plan.items.forEach(({ item, key }, itemIndex) => {
        const target = toTarget(item);
        const merged = this.#mergeInto(key, playlistIds);
        const data =
          merged ??
          this.#register({
            kind: 'download',
            dedupeKey: key,
            target,
            input:
              target.kind === 'keyword'
                ? { type: 'keyword', query: target.query }
                : { type: 'url', url: `https://www.bilibili.com/video/${target.bvid}` },
            playlistIds,
          });
        const record = this.#tasks.get(data.id);
        if (record !== undefined) batch.add(itemIndex, record);
      });

      // Announced even when every item merged: that case produces no task
      // transition at all, so this is the only refresh signal (fourth ⑧).
      this.#options.callbacks?.onBatchesChanged?.(batch.id);
      return batch.data();
    });
  }

  // ─── Query / control ─────────────────────────────────

  snapshot(): DownloadTasksData {
    return {
      tasks: [...this.#tasks.values()].map(toTaskData),
      batches: this.#batchRegistry.snapshot(),
    };
  }

  get(taskId: string): DownloadTaskData {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    return toTaskData(task);
  }

  /** Song ids with a pending task attached — M5's eviction reads this. */
  pendingSongIds(): Set<string> {
    const out = new Set<string>();
    for (const task of this.#tasks.values()) {
      if (!isTerminal(task.state) && task.songId !== null) out.add(task.songId);
    }
    return out;
  }

  /**
   * Three outcomes, deliberately distinct: a queued or early-running task is
   * cancelled, one past the commit point is refused, and a terminal one is a
   * no-op the caller can retry safely.
   */
  cancel(taskId: string): DownloadTaskData {
    const task = this.#tasks.get(taskId);
    if (task === undefined) throw new TaskNotFoundError(taskId);
    if (isTerminal(task.state)) return toTaskData(task);

    if (task.state === 'queued') {
      const at = this.#queue.indexOf(task.id);
      if (at !== -1) this.#queue.splice(at, 1);
      this.#finish(task, 'cancelled');
      return toTaskData(task);
    }

    if (task.stage === POINT_OF_NO_RETURN) {
      throw new TaskNotCancellableError(task.id, task.stage);
    }
    task.cancelRequested = true;
    task.controller.abort(new Error('cancelled by user'));
    return toTaskData(task);
  }

  /**
   * Stop accepting work, abort everything in flight, and wait for the worker
   * to actually exit — including any ffmpeg child it has open (M3-13).
   */
  async close(): Promise<void> {
    this.#stopping = true;
    for (const task of this.#tasks.values()) {
      if (!isTerminal(task.state)) task.controller.abort(new Error('daemon shutting down'));
    }
    await this.#worker;
  }

  // ─── Registration internals ──────────────────────────

  #assertCapacity(incoming: number): void {
    if (this.#stopping) throw new DownloadQueueFullError(this.#capacity);
    let pending = 0;
    for (const task of this.#tasks.values()) if (!isTerminal(task.state)) pending++;
    if (pending + incoming > this.#capacity) throw new DownloadQueueFullError(this.#capacity);
  }

  #assertPlaylistExists(id: string): void {
    const row = this.#options.db
      .select({ id: playlists.id })
      .from(playlists)
      .where(eq(playlists.id, id))
      .get();
    if (row === undefined) throw new NotFoundError('playlist', id);
  }

  /**
   * Fold new targets into an equivalent pending task, or return null.
   *
   * After the freeze the targets go to the late set instead — the commit is
   * already reading the frozen list, and mutating it there would add a
   * membership the transaction never saw.
   */
  #mergeInto(dedupeKey: string, playlistIds: readonly string[]): DownloadTaskData | null {
    const taskId = this.#dedupe.get(dedupeKey);
    if (taskId === undefined) return null;
    const task = this.#tasks.get(taskId);
    if (task === undefined || isTerminal(task.state)) {
      this.#dedupe.delete(dedupeKey);
      return null;
    }

    const sink = task.targetsFrozen ? task.latePlaylistIds : task.playlistIds;
    let changed = false;
    for (const id of playlistIds) {
      if (task.playlistIds.includes(id) || task.latePlaylistIds.includes(id)) continue;
      sink.push(id);
      changed = true;
    }
    if (changed) this.#bump(task);
    return toTaskData(task);
  }

  #register(seed: {
    kind: DownloadTaskKind;
    dedupeKey: string;
    input: DownloadTaskInput;
    playlistIds: string[];
    target?: DownloadTarget;
    songId?: string;
  }): DownloadTaskData {
    const task: TaskRecord = {
      id: randomUUID(),
      kind: seed.kind,
      state: 'queued',
      stage: null,
      revision: 1,
      input: seed.input,
      songId: seed.songId ?? null,
      playlistIds: seed.playlistIds,
      latePlaylistIds: [],
      failedPlaylistIds: [],
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      result: null,
      dedupeKey: seed.dedupeKey,
      target: seed.target ?? null,
      targetsFrozen: false,
      cancelRequested: false,
      controller: new AbortController(),
      llm: null,
      claims: [],
    };

    this.#tasks.set(task.id, task);
    this.#dedupe.set(task.dedupeKey, task.id);
    this.#queue.push(task.id);
    this.#options.callbacks?.onStatus?.(toTaskData(task));
    this.#pump();
    return toTaskData(task);
  }

  #bump(task: TaskRecord): void {
    task.revision++;
    this.#options.callbacks?.onStatus?.(toTaskData(task));
  }

  #setStage(task: TaskRecord, stage: DownloadStage): void {
    // Re-reporting the stage a task is already in is not a change, and
    // emitting for it would put duplicate events on the bus: the worker sets
    // the opening stage and the pipeline reports it again on entry. The
    // contract is one event per transition (M3-6).
    if (task.stage === stage) return;
    task.stage = stage;
    // Entering `saving` freezes the target list: the commit transaction is
    // about to read it, and a merge landing mid-transaction would be invisible
    // to it (second review ⑫).
    if (stage === POINT_OF_NO_RETURN) task.targetsFrozen = true;
    this.#bump(task);
  }

  // ─── Worker ──────────────────────────────────────────

  #pump(): void {
    if (this.#worker !== null || this.#stopping) return;
    this.#worker = this.#loop().finally(() => {
      this.#worker = null;
      // A task queued while the loop was finishing would otherwise wait for
      // the next enqueue to notice it.
      if (this.#queue.length > 0 && !this.#stopping) this.#pump();
    });
  }

  async #loop(): Promise<void> {
    while (this.#queue.length > 0) {
      const id = this.#queue.shift();
      if (id === undefined) break;
      const task = this.#tasks.get(id);
      if (task === undefined || isTerminal(task.state)) continue;
      await this.#execute(task);
    }
  }

  /**
   * Run one task to a terminal state, whatever happens.
   *
   * The try/catch/finally is load-bearing (fourth review ⑨): an unexpected
   * throw anywhere in the pipeline must still release the claims and the
   * dedupe key, write back the batch snapshot, and let the worker continue —
   * otherwise one bad task wedges the queue and leaks a claim that blocks the
   * song forever.
   */
  async #execute(task: TaskRecord): Promise<void> {
    try {
      task.state = 'running';
      task.startedAt = Date.now();
      task.llm = this.#llmSnapshot();
      if (task.songId !== null) {
        // Promotion: same owner as the reservation, so it cannot block itself.
        task.claims.push(this.claims.acquire(task.songId, claimTypeFor(task.kind), task.id));
      }
      this.#setStage(task, task.kind === 'lyrics' ? 'lyrics' : 'resolving');

      if (task.kind === 'lyrics') await this.#runLyrics(task);
      else await this.#runDownload(task);
    } catch (err) {
      if (task.cancelRequested || this.#stopping) this.#finish(task, 'cancelled');
      else this.#fail(task, err);
    } finally {
      this.claims.releaseOwner(task.id);
      task.claims = [];
      if (this.#dedupe.get(task.dedupeKey) === task.id) this.#dedupe.delete(task.dedupeKey);
      this.#batchRegistry.recordTerminal(task);
      this.#discardUncommittedSongDir(task);
      this.#trim();
    }
  }

  /**
   * Remove the song directory a task created but never committed.
   *
   * A new song's directory has to exist before the download starts — that is
   * where the staging happens — so a cancel mid-transfer leaves an empty one
   * behind. `landSongFile` only compensates for failures it saw, and nothing
   * else claims it: recovery ignores a directory with no audio in it. One per
   * cancelled download adds up.
   *
   * "No database row" is the safety condition, and it is exact: a redownload
   * or a reuse binds to a song that HAS a row, so their directories are never
   * touched, and nothing after the commit point can reach this path.
   */
  #discardUncommittedSongDir(task: TaskRecord): void {
    if (task.state === 'succeeded' || task.songId === null) return;
    const row = this.#options.db
      .select({ id: songs.id })
      .from(songs)
      .where(eq(songs.id, task.songId))
      .get();
    if (row !== undefined) return;
    try {
      rmSync(songDirPath(task.songId), { recursive: true, force: true });
    } catch (err) {
      this.#logger.warn({ task: task.id, err }, 'could not remove an uncommitted song directory');
    }
  }

  #llmSnapshot(): LlmConfig | null {
    const config = this.#options.getLlmConfig();
    return isLlmConfigured(config) ? config : null;
  }

  #deps(task: TaskRecord): PipelineDeps {
    return {
      db: this.#options.db,
      sqlite: this.#options.sqlite,
      bilibili: this.#bilibili,
      llm: task.llm,
      timeouts: this.#timeouts,
      ...(this.#options.fetchImpl === undefined ? {} : { fetchImpl: this.#options.fetchImpl }),
      ...(this.#options.lyricsOrigins === undefined
        ? {}
        : { lyricsOrigins: this.#options.lyricsOrigins }),
    };
  }

  #context(task: TaskRecord): StepContext {
    const signals = [task.controller.signal];
    if (this.#options.shutdownSignal !== undefined) signals.push(this.#options.shutdownSignal);
    return {
      signal: AbortSignal.any(signals),
      reportStage: (stage) => this.#setStage(task, stage),
    };
  }

  /**
   * Identify the target, bind the song, and take the claim — the last two in
   * one synchronous step so nothing can delete the song in between.
   */
  async #bindTarget(
    task: TaskRecord,
    deps: PipelineDeps,
    ctx: StepContext,
  ): Promise<{ resolved: ResolvedTarget; existing: SongData | null }> {
    const { db, sqlite } = this.#options;

    if (task.kind === 'redownload') {
      const song = getSong(db, sqlite, task.songId as string);
      const live =
        song.source_key === null ? null : await probeSourceKey(deps, song.source_key, ctx);
      return {
        existing: song,
        resolved:
          live === null
            ? await reidentifySource(deps, song, ctx)
            : { source: live, name: song.name, artist: song.artist },
      };
    }

    const resolved = await resolveTarget(deps, task.target as DownloadTarget, ctx);
    const hit = findSongByKey(db, 'bilibili', resolved.source.source_key);
    if (hit !== undefined) {
      task.songId = hit.id;
      task.claims.push(this.claims.acquire(hit.id, 'file', task.id));
      this.#bump(task);
      return { resolved, existing: getSong(db, sqlite, hit.id) };
    }

    // A brand-new song's id has to exist before the file does — the file lands
    // at songs/<id>/ (R22). It takes a claim too, even though nothing else
    // knows the id yet, so "a running download holds a file claim on its song"
    // is true without exception.
    task.songId = randomUUID();
    task.claims.push(this.claims.acquire(task.songId, 'file', task.id));
    this.#bump(task);
    return { resolved, existing: null };
  }

  async #runDownload(task: TaskRecord): Promise<void> {
    const deps = this.#deps(task);
    const ctx = this.#context(task);
    const { db, sqlite } = this.#options;
    const { resolved, existing } = await this.#bindTarget(task, deps, ctx);

    const songId = task.songId as string;
    // `force` for a redownload, "only if missing" otherwise — the
    // resolveSongFile decision tree (M3-7).
    const needsFile = task.kind === 'redownload' || !existsSync(songAudioPath(songId));
    const staged = needsFile
      ? await fetchAudio(
          deps,
          { songId, taskId: task.id, bvid: resolved.source.bvid, cid: resolved.source.cid },
          ctx,
        )
      : null;

    this.#setStage(task, POINT_OF_NO_RETURN);
    const targets = [...task.playlistIds];
    const failed: string[] = [];

    if (staged === null) {
      // Nothing to land: the song and its file are already here, so this is a
      // membership-only merge.
      sqlite.transaction(() => this.#addMemberships(targets, songId, failed)).immediate();
    } else {
      const result = landSongFile(db, sqlite, {
        taskId: task.id,
        songId,
        stagedPath: staged.path,
        mode: existing === null ? 'new' : 'replace',
        commit: () => {
          if (existing === null) {
            createFileBackedSongInTx(db, {
              id: songId,
              name: resolved.name,
              artist: resolved.artist,
              duration: staged.duration,
              file_origin: 'downloaded',
              source_url: resolved.source.source_url,
              source_provider: resolved.source.source_provider,
              source_key: resolved.source.source_key,
            });
          } else {
            updateSongInTx(db, songId, {
              duration: staged.duration,
              source_url: resolved.source.source_url,
              source_provider: resolved.source.source_provider,
              source_key: resolved.source.source_key,
            });
            setFileOrigin(db, sqlite, songId, 'downloaded');
          }
          this.#addMemberships(targets, songId, failed);
        },
      });
      for (const warning of result.warnings) {
        this.#logger.warn({ task: task.id, warning }, 'post-commit cleanup step failed');
      }
    }

    // ─── Past the commit point: nothing below may fail the task ───
    task.failedPlaylistIds = failed;
    this.#applyLateTargets(task, songId);
    task.result = { song_id: songId };
    this.#finish(task, 'succeeded');
    this.#deriveLyrics(task, songId);
  }

  #addMemberships(playlistIds: readonly string[], songId: string, failed: string[]): void {
    for (const playlistId of playlistIds) {
      try {
        addSongsToPlaylistInTx(this.#options.db, playlistId, [songId]);
      } catch (err) {
        // A playlist deleted while the task ran is a soft failure: the song is
        // downloaded either way, and the GUI needs to be told which target was
        // lost (fifth review ⑥).
        if (!(err instanceof NotFoundError)) throw err;
        failed.push(playlistId);
      }
    }
  }

  #applyLateTargets(task: TaskRecord, songId: string): void {
    if (task.latePlaylistIds.length === 0) return;
    const late = [...task.latePlaylistIds];
    task.latePlaylistIds = [];
    const failed = [...task.failedPlaylistIds];
    try {
      this.#options.sqlite
        .transaction(() => this.#addMemberships(late, songId, failed))
        .immediate();
      task.playlistIds.push(...late.filter((id) => !failed.includes(id)));
    } catch (err) {
      failed.push(...late);
      this.#logger.warn({ task: task.id, err }, 'late playlist targets could not be applied');
    }
    task.failedPlaylistIds = failed;
  }

  /** Spawn the lyrics continuation. A failure here is a warning, never a fail. */
  #deriveLyrics(task: TaskRecord, songId: string): void {
    try {
      this.enqueueLyrics(songId, { exemptFromCapacity: true });
    } catch (err) {
      this.#logger.warn({ task: task.id, err }, 'could not queue the lyrics continuation');
    }
  }

  async #runLyrics(task: TaskRecord): Promise<void> {
    const song = getSong(this.#options.db, this.#options.sqlite, task.songId as string);
    const outcome = await runLyrics(this.#deps(task), song, this.#context(task));
    if (!outcome.written) {
      task.errorCode = 'NOT_FOUND';
      task.errorMessage = outcome.reason ?? '没有找到歌词';
      this.#finish(task, 'failed');
      return;
    }
    task.result = { song_id: song.id };
    this.#finish(task, 'succeeded');
  }

  // ─── Terminal states ─────────────────────────────────

  #fail(task: TaskRecord, err: unknown): void {
    const { code, message } = describeTaskError(err);
    task.errorCode = code;
    task.errorMessage = message;
    if (code === 'INTERNAL_ERROR') {
      this.#logger.error({ task: task.id, err }, 'download task failed unexpectedly');
    } else {
      this.#logger.info({ task: task.id, code }, 'download task failed');
    }
    this.#finish(task, 'failed');
  }

  #finish(task: TaskRecord, state: Extract<TaskState, 'succeeded' | 'failed' | 'cancelled'>): void {
    task.state = state;
    task.stage = null;
    task.finishedAt = Date.now();
    task.revision++;
    const data = toTaskData(task);
    const callbacks = this.#options.callbacks;
    callbacks?.onStatus?.(data);
    if (state === 'succeeded') callbacks?.onSucceeded?.(data);
    else if (state === 'failed') callbacks?.onFailed?.(data);
    else callbacks?.onCancelled?.(data);
  }

  /** Keep the terminal ring bounded; pending tasks are never evicted. */
  #trim(): void {
    const terminal = [...this.#tasks.values()].filter((t) => isTerminal(t.state));
    const excess = terminal.length - TERMINAL_RING;
    for (let i = 0; i < excess; i++) {
      const victim = terminal[i];
      if (victim !== undefined) this.#tasks.delete(victim.id);
    }
  }
}
