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

import type {
  DownloadBatchData,
  DownloadBatchGroupInput,
  DownloadNamingMode,
  DownloadOrigin,
  DownloadStage,
  DownloadTaskData,
  DownloadTaskInput,
  DownloadTaskKind,
  DownloadTasksData,
  LlmConfig,
  SongData,
  TaskState,
} from '@lark/shared';
import { eq } from 'drizzle-orm';
import type { PortableDb } from '../db.js';
import {
  DownloadQueueFullError,
  InvalidSourceError,
  NamingModeConflictError,
  NotFoundError,
  TaskNotCancellableError,
  TaskNotFoundError,
} from '../errors.js';
import { addSongsToPlaylistInTx, createPlaylistInTx } from '../library/playlists.js';
import {
  createFileBackedSongInTx,
  getSong,
  setFileOrigin,
  updateSongInTx,
} from '../library/songs.js';
import { findSongByKey } from '../library/source.js';
import type { AudioLandingPort, LandedAudio } from '../ports/audio-landing.js';
import type { FileContext } from '../ports/fs.js';
import { uuid } from '../runtime/random.js';
import { playlists, songs } from '../schema.js';
import { BatchRegistry, batchOrigin, resolveBatchTarget, toTarget, videoUrl } from './batches.js';
import { type BilibiliClient, createBilibiliClient } from './bilibili.js';
import { ClaimRegistry } from './claims.js';
import { isLlmConfigured } from './llm.js';
import type { LyricsOrigins } from './lyrics/shared.js';
import {
  type PipelineDeps,
  type ResolvedTarget,
  type StepContext,
  probeSourceKey,
  reidentifySource,
  resolveTarget,
  runLyrics,
} from './pipeline.js';
import type { DownloadTarget } from './target.js';
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

/** How the two naming modes read in a refusal. */
const NAMING_LABEL: Record<DownloadNamingMode, string> = {
  original: '原标题',
  clean: '清洗命名',
};

// Progress event throttle (§4-d): at most one per 500ms, and only when the
// transfer moved by 1% or a quarter of a megabyte since the last one. Both
// halves matter — the time floor bounds a fast local transfer, and the size
// floor keeps a slow one from emitting a pixel of change every half second.
const PROGRESS_MIN_INTERVAL_MS = 500;
const PROGRESS_MIN_BYTES = 256 * 1024;
const PROGRESS_MIN_FRACTION = 0.01;

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
  /** The library, as one connection (N1c) — drizzle and the raw handle together. */
  store: PortableDb;
  /** Where song files live, and how to touch them (N1c). */
  files: FileContext;
  /**
   * The EFFECTIVE llm config, read fresh per call. Snapshotted once when a
   * task starts, so a config change mid-download cannot swap models halfway
   * (M3-4).
   */
  getLlmConfig: () => LlmConfig;
  /**
   * How this device gets a song's audio onto its storage (N1h).
   *
   * Required, and the last Node-shaped thing the engine used to do itself: it
   * called `existsSync`, `rmSync` and a six-step landing protocol directly.
   * A phone answers all three differently — it stores bilibili's fMP4 as it
   * arrives (D17) — while the queue, the state machine and the commit contents
   * above it are the same everywhere.
   */
  audio: AudioLandingPort;
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

/**
 * What `#bindTarget` settled on. `needsSource: false` is the ensure-file
 * short circuit: no key was looked up, no LLM was consulted, and there is no
 * `ResolvedTarget` to construct — a song with a file but no source key (every
 * Go-era import) could not produce one anyway.
 */
type TargetBinding =
  | { needsSource: true; resolved: ResolvedTarget; existing: SongData | null }
  | { needsSource: false; existing: SongData };

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
    this.#assertNamingCompatible([{ key, target: input.target }]);
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
          : { type: 'url', url: input.url ?? videoUrl(input.target) },
      origin:
        input.target.kind === 'keyword'
          ? { kind: 'keyword', query: input.target.query }
          : { kind: 'video', url: input.url ?? videoUrl(input.target) },
      playlistIds: targets,
    });
  }

  /** Force a fresh download of an existing song's audio. */
  enqueueRedownload(songId: string): DownloadTaskData {
    getSong(this.#options.store.drizzle, this.#options.store.sqlite, songId); // 404 before anything else
    const key = `redownload:${songId}`;
    const merged = this.#mergeInto(key, []);
    if (merged !== null) return merged;

    this.#assertCapacity(1);
    return this.#register({
      kind: 'redownload',
      dedupeKey: key,
      songId,
      input: { type: 'song', song_id: songId },
      origin: { kind: 'song', song_id: songId },
      playlistIds: [],
    });
  }

  /**
   * Make sure a song's audio is on disk, fetching it only if it is missing
   * (M5-8). Its own dedupe key: merging it into a pending `redownload` would
   * silently downgrade a forced refetch, and merging a redownload into it
   * would skip the refetch the user asked for.
   */
  enqueueEnsureFile(songId: string): DownloadTaskData {
    getSong(this.#options.store.drizzle, this.#options.store.sqlite, songId); // 404 before anything else
    const key = `ensure-file:${songId}`;
    const merged = this.#mergeInto(key, []);
    if (merged !== null) return merged;

    // Regular capacity, unlike the lyrics continuation: these come from user
    // clicks, and an exemption would make the queue unbounded (M5-8).
    this.#assertCapacity(1);
    return this.#register({
      kind: 'ensure-file',
      dedupeKey: key,
      songId,
      input: { type: 'song', song_id: songId },
      origin: { kind: 'song', song_id: songId },
      playlistIds: [],
    });
  }

  /**
   * Do a finished task's work again, as a NEW task (2026-08-31 对齐).
   *
   * 🔴 IT REPLAYS THE TASK'S OWN `target`, not the text somebody typed. That
   * is the whole reason this is a method rather than four lines in each host:
   * a `DownloadRecord` deliberately does not carry the naming mode
   * (`history.ts`), so re-submitting its input means answering "which naming?"
   * again — and an automatic retry has nobody to ask. The phone used to answer
   * it with whatever the 命名 chip was showing AT THE MOMENT OF THE RETRY, so
   * a song submitted under 原标题 could land under 清洗命名 because somebody
   * moved a chip in between. A retry is the continuation of one request, not a
   * new decision about it, and the target it already resolved says so exactly.
   *
   * The other half of the same argument is cost: the target is resolved, so
   * this costs no network at all — no short-link hop, no page list, no LLM.
   *
   * 🔴 LYRICS ARE NEVER REPLAYED HERE (`null`). The engine spawns a lyrics
   * task after every download, nobody asked for it on its own, and hammering
   * three providers for each failed fetch is a cost with no consumer. Its
   * record keeps a 重下 for the person who does want it.
   *
   * `null` also for a task this engine has never heard of — terminal tasks age
   * out of the ring, and a caller holding an old id is asking about something
   * that no longer exists rather than making a mistake.
   */
  enqueueRetry(taskId: string): DownloadTaskData | null {
    const task = this.#tasks.get(taskId);
    if (task === undefined) return null;
    switch (task.kind) {
      case 'lyrics':
        return null;
      case 'redownload':
        return task.songId === null ? null : this.enqueueRedownload(task.songId);
      case 'ensure-file':
        return task.songId === null ? null : this.enqueueEnsureFile(task.songId);
      case 'download': {
        // A download task always bound a target before it could run; a `null`
        // one means it died before that, and there is nothing to replay.
        if (task.target === null) return null;
        return this.enqueueDownload({
          target: task.target,
          playlistIds: task.playlistIds,
          // The normalised URL this task was registered with, so the new one
          // shows the same link rather than a rebuilt `bilibili.com/video/BV…`.
          ...(task.input.type === 'url' ? { url: task.input.url } : {}),
        });
      }
    }
  }

  /**
   * Queue a lyrics fetch. Also how a finished download spawns its own.
   *
   * The two callers want different queue positions, which is what `runNext`
   * is: a continuation finishes the song the queue is already in the middle
   * of, while a hand-queued fetch takes its turn like everything else.
   */
  enqueueLyrics(
    songId: string,
    options: { exemptFromCapacity?: boolean; runNext?: boolean } = {},
  ): DownloadTaskData {
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
      origin: { kind: 'song', song_id: songId },
      playlistIds: [],
      ...(options.runNext === true ? { runNext: true } : {}),
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
      ...(group.source === undefined ? {} : { source: group.source }),
      items: group.items.map((item) => ({ item, key: downloadDedupeKey(toTarget(item)) })),
    }));

    for (const plan of plans) {
      if (plan.target.kind === 'playlist') this.#assertPlaylistExists(plan.target.playlist_id);
      if (plan.target.kind === 'new' && plan.target.name.trim() === '') {
        throw new InvalidSourceError('新歌单名称不能为空');
      }
    }

    // Before the capacity check and before the playlist transaction, over
    // every item of every group at once (§3.6-1). A conflict found later —
    // while merging item 40 of 50 — would already have created playlists and
    // registered tasks, and "every group commits or none does" would be a
    // sentence in a comment rather than a property.
    this.#assertNamingCompatible(
      plans.flatMap((plan) => plan.items.map(({ item, key }) => ({ key, target: toTarget(item) }))),
    );

    // Net new = items that will not merge onto something already pending, and
    // that are not duplicates of each other within this request.
    const willCreate = new Set<string>();
    for (const plan of plans) {
      for (const { key } of plan.items) if (!this.#dedupe.has(key)) willCreate.add(key);
    }
    this.#assertCapacity(willCreate.size);

    // `createPlaylistInTx`, NOT `createPlaylist` — we are already inside a
    // transaction, and the wrapping variant opens a second one.
    //
    // MEASURED on the phone (N4f-2, 2026-08-24): every batch submission died
    // here. better-sqlite3 hides it — its `transaction()` notices it is nested
    // and degrades to a SAVEPOINT — so the desktop, the daemon, the CLI and
    // every test in this file ran the bug for months without a symptom. The
    // portable SqliteLike contract does not promise that nicety (decision c2,
    // `portable/sqlite.ts`), and the phone's shim answers a nested
    // `BEGIN IMMEDIATE` the way SQLite does: by refusing.
    //
    // This is the one shape the `…InTx` split exists for, and the site right
    // next door already gets it right (`library/transfer.ts:393`).
    const createdIds = this.#options.store.sqlite
      .transaction(() => {
        const ids = new Map<number, string>();
        plans.forEach((plan, index) => {
          if (plan.target.kind !== 'new') return;
          const created = createPlaylistInTx(this.#options.store, plan.target.name.trim());
          ids.set(index, created.id);
        });
        return ids;
      })
      .immediate();

    const now = Date.now();
    return plans.map((plan, index) => {
      const resolved = resolveBatchTarget(
        this.#options.store.drizzle,
        plan.target,
        createdIds.get(index),
      );
      const playlistIds = resolved.kind === 'playlist' ? [resolved.playlist_id] : [];
      const batch = this.#batchRegistry.open(uuid(), resolved, now);

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
                : { type: 'url', url: videoUrl(target) },
            origin: batchOrigin(plan.source, target, itemIndex, plan.items.length),
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

  /**
   * Song ids a non-terminal task is going to write a FILE for — eviction's
   * pre-filter (M5-5).
   *
   * Read off the task table rather than the claim registry on purpose: a
   * queued task holds only a reservation and takes its claim when it starts
   * running, so a registry query would miss everything still in the queue.
   *
   * Lyrics tasks are excluded because they write `lyrics.lrc`, not the audio,
   * and one is spawned by every finished download — counting them would make
   * a just-downloaded song permanently unevictable while its lyrics run.
   *
   * A plain download that has not bound a song id yet cannot be excluded here
   * at all. That is accepted, not worked around: it takes the song's `file`
   * claim before touching anything, and the delete critical section loses to
   * whoever holds that claim.
   */
  pendingFileSongIds(): Set<string> {
    const out = new Set<string>();
    for (const task of this.#tasks.values()) {
      if (isTerminal(task.state) || task.kind === 'lyrics' || task.songId === null) continue;
      out.add(task.songId);
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

  /**
   * Refuse a submission that would merge onto a different naming mode.
   *
   * Checked against BOTH the pending task for that key and the rest of this
   * request: a paste holding the same link twice, once cleaned and once not,
   * has the same problem as two tabs — one of the two answers would be thrown
   * away silently, and the dedupe key deliberately does not include the mode
   * (that would download the audio twice to store two names, §3.6-1).
   */
  #assertNamingCompatible(entries: readonly { key: string; target: DownloadTarget }[]): void {
    const withinRequest = new Map<string, DownloadNamingMode>();
    for (const { key, target } of entries) {
      if (target.kind !== 'video') continue;
      const claimed = this.#pendingNaming(key) ?? withinRequest.get(key);
      if (claimed !== undefined && claimed !== target.naming) {
        throw new NamingModeConflictError(
          `${target.bvid} 已经在队列里，命名方式是「${NAMING_LABEL[claimed]}」，这次要「${NAMING_LABEL[target.naming]}」——等它下完再提交，或者先取消它`,
        );
      }
      withinRequest.set(key, target.naming);
    }
  }

  /** The naming mode a pending task for this key is already committed to. */
  #pendingNaming(dedupeKey: string): DownloadNamingMode | undefined {
    const taskId = this.#dedupe.get(dedupeKey);
    if (taskId === undefined) return undefined;
    const task = this.#tasks.get(taskId);
    if (task === undefined || isTerminal(task.state)) return undefined;
    return task.target?.kind === 'video' ? task.target.naming : undefined;
  }

  #assertPlaylistExists(id: string): void {
    const row = this.#options.store.drizzle
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
    /** Required, so a new way to enqueue cannot forget to say where it came from. */
    origin: DownloadOrigin;
    playlistIds: string[];
    target?: DownloadTarget;
    songId?: string;
    /** Run before whatever is already waiting; see `enqueueLyrics`. */
    runNext?: boolean;
  }): DownloadTaskData {
    const task: TaskRecord = {
      id: uuid(),
      kind: seed.kind,
      state: 'queued',
      stage: null,
      revision: 1,
      input: seed.input,
      origin: seed.origin,
      songId: seed.songId ?? null,
      ...this.#songLabel(seed.songId ?? null),
      playlistIds: seed.playlistIds,
      latePlaylistIds: [],
      failedPlaylistIds: [],
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      result: null,
      receivedBytes: 0,
      totalBytes: null,
      progressEmittedAt: 0,
      progressEmittedBytes: 0,
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
    // A lyrics continuation belongs to the song that just finished, not behind
    // the other thirty-nine links someone pasted: it runs NEXT, so each song
    // is done — audio and lyrics — before the next one starts. Queued by hand
    // (`POST /songs/:id/download-lyrics`) it is an ordinary task and waits.
    if (seed.runNext === true) this.#queue.unshift(task.id);
    else this.#queue.push(task.id);
    this.#options.callbacks?.onStatus?.(toTaskData(task));
    this.#pump();
    return toTaskData(task);
  }

  /**
   * What to call a task that starts from a song — a redownload, an ensure-file
   * or a lyrics fetch, all of which would otherwise show up in a list as "已有
   * 歌曲" forty times over.
   *
   * Tolerant by design: `enqueueLyrics` is also how a finished download spawns
   * its own continuation, and a queued task can outlive a song someone deleted
   * while it waited. Neither is a reason to fail an enqueue over a label.
   */
  #songLabel(songId: string | null): { title: string | null; artist: string | null } {
    if (songId === null) return { title: null, artist: null };
    try {
      const song = getSong(this.#options.store.drizzle, this.#options.store.sqlite, songId);
      return { title: song.name, artist: song.artist };
    } catch (err) {
      if (err instanceof NotFoundError) return { title: null, artist: null };
      throw err;
    }
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
    // The throttle can be holding the last few percent when the transfer ends,
    // and a progress line frozen at 97% is worse than none (§3.5).
    this.#flushProgress(task);
    task.stage = stage;
    // Progress belongs to ONE stage: carrying the transfer's bytes into
    // `converting` would show a client a percentage of the wrong thing.
    this.#resetProgress(task);
    // Entering `saving` freezes the target list: the commit transaction is
    // about to read it, and a merge landing mid-transaction would be invisible
    // to it (second review ⑫).
    if (stage === POINT_OF_NO_RETURN) task.targetsFrozen = true;
    this.#bump(task);
  }

  /**
   * Record transferred bytes, and decide whether anyone hears about it (§4-d).
   *
   * Throttled HERE rather than at the transfer or at each receiver: the engine
   * is the only place that knows what it last emitted, and an un-throttled
   * chunk callback on a 5MB file is thousands of SSE frames for a line of text
   * that changes by a pixel.
   */
  #setProgress(task: TaskRecord, received: number, total: number | null): void {
    task.receivedBytes = received;
    task.totalBytes = total;

    const now = Date.now();
    if (now - task.progressEmittedAt < PROGRESS_MIN_INTERVAL_MS) return;
    const delta = received - task.progressEmittedBytes;
    const enoughBytes = delta >= PROGRESS_MIN_BYTES;
    const enoughPercent = total !== null && delta >= total * PROGRESS_MIN_FRACTION;
    if (!enoughBytes && !enoughPercent) return;
    this.#emitProgress(task, now);
  }

  /** Send the value the throttle is holding, if it is holding one. */
  #flushProgress(task: TaskRecord): void {
    if (task.receivedBytes === task.progressEmittedBytes) return;
    this.#emitProgress(task, Date.now());
  }

  #emitProgress(task: TaskRecord, at: number): void {
    task.progressEmittedAt = at;
    task.progressEmittedBytes = task.receivedBytes;
    this.#bump(task);
  }

  #resetProgress(task: TaskRecord): void {
    task.receivedBytes = 0;
    task.totalBytes = null;
    task.progressEmittedAt = 0;
    task.progressEmittedBytes = 0;
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
    const row = this.#options.store.drizzle
      .select({ id: songs.id })
      .from(songs)
      .where(eq(songs.id, task.songId))
      .get();
    if (row !== undefined) return;
    try {
      this.#options.audio.discardUncommitted(task.songId);
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
      store: this.#options.store,
      files: this.#options.files,
      bilibili: this.#bilibili,
      llm: task.llm,
      timeouts: this.#timeouts,
      logger: this.#logger,
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
      reportProgress: (received, total) => this.#setProgress(task, received, total),
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
  ): Promise<TargetBinding> {
    const { drizzle: db, sqlite } = this.#options.store;

    if (task.kind === 'redownload' || task.kind === 'ensure-file') {
      const song = getSong(db, sqlite, task.songId as string);
      // The short circuit happens BEFORE any source work (M5-8): a song whose
      // file is already there needs no key, no probe and no LLM — and a song
      // that has a file but no key (every Go-era import) could not produce a
      // ResolvedTarget at all.
      if (task.kind === 'ensure-file' && this.#options.audio.hasAudio(song.id)) {
        return { needsSource: false, existing: song };
      }
      const live =
        song.source_key === null ? null : await probeSourceKey(deps, song.source_key, ctx);
      return {
        needsSource: true,
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
      const existing = getSong(db, sqlite, hit.id);
      // The song's OWN name, not the one we just resolved: a download that
      // lands on a song already in the library does not rename it, and a list
      // saying otherwise would be describing a rename that never happens.
      task.title = existing.name;
      task.artist = existing.artist;
      this.#bump(task);
      return { needsSource: true, resolved, existing };
    }

    // A new song: the name the submitter's naming mode produced is what this
    // task is about, and it is the first moment anyone can say so.
    task.title = resolved.name;
    task.artist = resolved.artist;

    // A brand-new song's id has to exist before the file does — the file lands
    // at songs/<id>/ (R22). It takes a claim too, even though nothing else
    // knows the id yet, so "a running download holds a file claim on its song"
    // is true without exception.
    task.songId = uuid();
    task.claims.push(this.claims.acquire(task.songId, 'file', task.id));
    this.#bump(task);
    return { needsSource: true, resolved, existing: null };
  }

  async #runDownload(task: TaskRecord): Promise<void> {
    const deps = this.#deps(task);
    const ctx = this.#context(task);
    const { drizzle: db, sqlite } = this.#options.store;
    const binding = await this.#bindTarget(task, deps, ctx);
    const { existing } = binding;
    // `null` = an ensure-file that found the file already in place: there is
    // nothing to fetch and nothing to write, only a task to finish (M5-8).
    const resolved = binding.needsSource ? binding.resolved : null;

    const songId = task.songId as string;
    // `force` for a redownload, "only if missing" otherwise — the
    // resolveSongFile decision tree (M3-7).
    const needsFile = task.kind === 'redownload' || !this.#options.audio.hasAudio(songId);
    const failed: string[] = [];

    if (resolved === null || !needsFile) {
      // Nothing to land: the song and its file are already here, so this is a
      // membership-only merge (and for an ensure-file, not even that).
      this.#setStage(task, POINT_OF_NO_RETURN);
      const targets = [...task.playlistIds];
      sqlite.transaction(() => this.#addMemberships(targets, songId, failed)).immediate();
    } else {
      // Which stream to open is the CLIENT's question and stays here; what to
      // do with the bytes is the host's (N1h). The DASH pick still prefers an
      // AAC candidate, and the landing still decides by probing what actually
      // arrived rather than by trusting this.
      const stream = await this.#bilibili.audioStream(resolved.source.bvid, resolved.source.cid, {
        signal: ctx.signal,
      });
      // Two descriptions of the same authenticated request: `openStream` for a
      // host that reads the body in JS (desktop), `request` for one that hands
      // the URL, headers and deadline to a native downloader (the phone, N4).
      // The client owns both, so its error normalisation and its transfer
      // deadline are not re-invented per host (§2.2).
      const audioRequest = await this.#bilibili.describeAudioRequest(stream.url, {
        signal: ctx.signal,
      });
      // The selected part's duration, from the page list `resolveTarget` /
      // `probeSourceKey` already fetched — a REFERENCE the landing may
      // cross-check, never the value written to the row (§1.4). Both a new
      // song and a redownload resolve a full NormalizedSource, so both have a
      // page to quote; the field is no longer always null.
      const expectedDurationSeconds =
        resolved.source.pages[resolved.source.page - 1]?.duration ?? null;
      const result = await this.#options.audio.land({
        taskId: task.id,
        songId,
        mode: existing === null ? 'new' : 'replace',
        openStream: (signal: AbortSignal) => this.#bilibili.openAudio(stream.url, { signal }),
        request: audioRequest,
        expect: {
          codecs: stream.codecs,
          isAac: stream.isAac,
          expectedDurationSeconds,
        },
        reportStage: (stage: DownloadStage) => this.#setStage(task, stage),
        onProgress: (received: number, totalBytes: number | null) =>
          ctx.reportProgress?.(received, totalBytes),
        signal: ctx.signal,
        commit: ({ duration }: LandedAudio) => {
          // Read here rather than before `land`: entering `saving` is what
          // freezes the target list (second review ⑫), and that now happens
          // INSIDE the landing, immediately before this runs.
          const targets = [...task.playlistIds];
          if (existing === null) {
            createFileBackedSongInTx(this.#options.store, {
              id: songId,
              name: resolved.name,
              artist: resolved.artist,
              duration,
              file_origin: 'downloaded',
              source_url: resolved.source.source_url,
              source_provider: resolved.source.source_provider,
              source_key: resolved.source.source_key,
            });
          } else {
            updateSongInTx(this.#options.store, songId, {
              duration,
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
    // An ensure-file that did nothing fetches nothing — including lyrics. Its
    // whole contract is "zero network when the file is there" (M5-8).
    if (resolved !== null) this.#deriveLyrics(task, songId);
  }

  #addMemberships(playlistIds: readonly string[], songId: string, failed: string[]): void {
    for (const playlistId of playlistIds) {
      try {
        addSongsToPlaylistInTx(this.#options.store, playlistId, [songId]);
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
      this.#options.store.sqlite
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
      this.enqueueLyrics(songId, { exemptFromCapacity: true, runNext: true });
    } catch (err) {
      this.#logger.warn({ task: task.id, err }, 'could not queue the lyrics continuation');
    }
  }

  async #runLyrics(task: TaskRecord): Promise<void> {
    const song = getSong(
      this.#options.store.drizzle,
      this.#options.store.sqlite,
      task.songId as string,
    );
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
    // A terminal task has no stage, so it has no transfer either: leaving the
    // last byte count on it would make a finished row render as 63% forever.
    this.#resetProgress(task);
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
