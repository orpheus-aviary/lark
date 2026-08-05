// The engine end to end: a real fake-upstream server, a real database, real
// ffmpeg. The only thing stubbed is the internet.
//
// The acceptance criterion this file exists to protect is the R16 one — a
// pasted single-part URL downloads with NO LLM configured — so that case runs
// first and with `llm: null` everywhere it can reach.

import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { LlmConfig } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/index.js';
import type { LarkDatabase } from '../db/index.js';
import { songLyricsPath } from '../library/lyrics.js';
import { createPlaylist, deletePlaylist, getPlaylistSongs } from '../library/playlists.js';
import { getSong, listSongs } from '../library/songs.js';
import { songsDir } from '../paths.js';
import type { FakeUpstream } from '../testing/fake-upstream.js';
import { startFakeUpstream } from '../testing/fake-upstream.js';
import { createBilibiliClient } from './bilibili.js';
import { DownloadEngine, describeTaskError, downloadDedupeKey } from './engine.js';
import { resolveFfmpegBinaries } from './ffmpeg.js';
import { DEFAULT_TIMEOUTS } from './timeouts.js';

const BVID = 'BV1Ki4y1y7HC';
const NO_LLM: LlmConfig = { url: '', model: '', api_key: '', api_format: '' };

let audioFixture: Buffer;
let nest: string;
let db: LarkDatabase;
let sqlite: BetterSqlite3.Database;
let upstream: FakeUpstream;
let engine: DownloadEngine | null = null;

beforeAll(async () => {
  // A real m4a, so ffmpeg has something it can genuinely transcode.
  const dir = mkdtempSync(join(tmpdir(), 'lark-engine-fixture-'));
  const path = join(dir, 'fixture.m4a');
  const { ffmpeg } = resolveFfmpegBinaries();
  await promisify(execFile)(ffmpeg.path, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'aac',
    '-y',
    path,
  ]);
  audioFixture = readFileSync(path);
  rmSync(dir, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-engine-'));
  // `vi.stubEnv`, not an assignment: Biome blocks `delete process.env.X`, and
  // `= undefined` writes the STRING "undefined" into the environment.
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ db, sqlite } = createDatabase({ dbPath: ':memory:' }));
  upstream = await startFakeUpstream({ audio: audioFixture });
});

afterEach(async () => {
  await engine?.close();
  engine = null;
  await upstream.close();
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

interface BuildOptions {
  llm?: LlmConfig;
  capacity?: number;
  callbacks?: ConstructorParameters<typeof DownloadEngine>[0]['callbacks'];
}

function build(options: BuildOptions = {}): DownloadEngine {
  const llmConfig: LlmConfig = options.llm ?? NO_LLM;
  engine = new DownloadEngine({
    db,
    sqlite,
    getLlmConfig: () => llmConfig,
    bilibili: createBilibiliClient({ apiBase: upstream.baseUrl, timeouts: DEFAULT_TIMEOUTS }),
    lyricsOrigins: upstream.lyricsOrigins(),
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.callbacks === undefined ? {} : { callbacks: options.callbacks }),
  });
  return engine;
}

/** An LLM config pointed at the fake upstream. */
function llmConfig(): LlmConfig {
  return { url: upstream.llmUrl(), model: 'fake', api_key: 'k', api_format: 'openai' };
}

/** Wait until a task reaches a terminal state. */
async function settle(e: DownloadEngine, taskId: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = e.snapshot().tasks.find((t) => t.id === taskId);
    if (task !== undefined && ['succeeded', 'failed', 'cancelled'].includes(task.state)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`task ${taskId} did not settle in ${timeoutMs}ms`);
}

/** Wait until every task is terminal — download plus its lyrics continuation. */
async function settleAll(e: DownloadEngine, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pending = e.snapshot().tasks.filter((t) => t.state === 'queued' || t.state === 'running');
    if (pending.length === 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('tasks did not settle');
}

const taskOf = (e: DownloadEngine, id: string) =>
  e.snapshot().tasks.find((t) => t.id === id) ?? expect.fail(`no task ${id}`);

const videoTarget = (page: number | null = null, title: string | null = null) =>
  ({ kind: 'video', bvid: BVID, page, title }) as const;

// ─── The R16 criterion ─────────────────────────────────

describe('single-part URL with no LLM', () => {
  it('downloads, transcodes, stores and writes back the source key', async () => {
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);

    const task = taskOf(e, id);
    expect(task.state).toBe('succeeded');
    expect(task.error_code).toBeNull();

    const songId = task.result?.song_id as string;
    const song = getSong(db, sqlite, songId);
    expect(song.name).toBe('【私藏馆】周杰伦《稻香》');
    expect(song.artist).toBe('音乐私藏馆');
    expect(song.source_key).toBe(`${BVID}:550103819`);
    expect(song.source_url).toBe(`https://www.bilibili.com/video/${BVID}`);
    expect(song.file_origin).toBe('downloaded');
    expect(song.duration).toBeGreaterThan(0.9);

    // song.mp3 is there and nothing staged is left beside it. (The lyrics
    // continuation may or may not have landed lyrics.lrc by now — that is a
    // separate task with its own test.)
    const files = readdirSync(join(songsDir(), songId));
    expect(files).toContain('song.mp3');
    expect(files.filter((f) => f.startsWith('.'))).toEqual([]);
    // The fake LLM endpoint was never called.
    expect(upstream.requests.filter((p) => p.includes('completions'))).toEqual([]);
  }, 60_000);

  it('adds the song to the requested playlists', async () => {
    const playlist = createPlaylist(db, sqlite, '新歌单');
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget(), playlistIds: [playlist.id] });
    await settle(e, id);

    const members = getPlaylistSongs(db, sqlite, playlist.id);
    expect(members).toHaveLength(1);
    expect(taskOf(e, id).failed_playlist_ids).toEqual([]);
  }, 60_000);

  it('honours an explicit ?p= against a multi-part video, still with no LLM', async () => {
    upstream.state.videos.set(BVID, {
      title: '多P合辑',
      owner: 'UP',
      ownerMid: 1,
      duration: 100,
      pages: [
        { page: 1, part: '一', duration: 50, cid: 111 },
        { page: 2, part: '二', duration: 50, cid: 222 },
      ],
    });
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget(2) });
    await settle(e, id);

    const song = getSong(db, sqlite, taskOf(e, id).result?.song_id as string);
    expect(song.source_key).toBe(`${BVID}:222`);
    expect(song.source_url).toBe(`https://www.bilibili.com/video/${BVID}?p=2`);
  }, 60_000);
});

describe('multi-part with no ?p= and no LLM', () => {
  // The batch trade-off (fourth review ②): batch items skip the synchronous
  // preflight, so this surfaces as an async task failure rather than a 400.
  it('fails the task with LLM_NOT_CONFIGURED rather than guessing a part', async () => {
    upstream.state.videos.set(BVID, {
      title: '多P合辑',
      owner: 'UP',
      ownerMid: 1,
      duration: 100,
      pages: [
        { page: 1, part: '一', duration: 50, cid: 111 },
        { page: 2, part: '二', duration: 50, cid: 222 },
      ],
    });
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);

    const task = taskOf(e, id);
    expect(task.state).toBe('failed');
    expect(task.error_code).toBe('LLM_NOT_CONFIGURED');
    expect(task.error_message).toContain('?p=');
    expect(listSongs(db, sqlite).total).toBe(0);
  }, 60_000);
});

// ─── Keyword path ──────────────────────────────────────

describe('keyword download', () => {
  it('analyses, searches, picks and stores the cleaned name', async () => {
    upstream.state.llm = (system) => {
      if (system.includes('分析用户输入')) {
        return JSON.stringify({
          type: 'keyword',
          song_name: '稻香',
          artist: '周杰伦',
          query: '稻香',
        });
      }
      if (system.includes('从bilibili搜索结果中选择')) return BVID;
      if (system.includes('推断内容名称'))
        return JSON.stringify({ song_name: '稻香', artist: '周杰伦' });
      return '1';
    };

    const e = build({ llm: llmConfig() });
    const { id } = e.enqueueDownload({ target: { kind: 'keyword', query: '稻香 周杰伦' } });
    await settle(e, id);

    const task = taskOf(e, id);
    expect(task.state).toBe('succeeded');
    const song = getSong(db, sqlite, task.result?.song_id as string);
    expect(song.name).toBe('稻香');
    expect(song.artist).toBe('周杰伦');
  }, 60_000);

  it('fails clearly when the model finds nothing suitable', async () => {
    upstream.state.llm = (system) =>
      system.includes('从bilibili搜索结果中选择')
        ? 'NONE'
        : JSON.stringify({ song_name: 'x', artist: '', query: 'x' });

    const e = build({ llm: llmConfig() });
    const { id } = e.enqueueDownload({ target: { kind: 'keyword', query: '不存在的歌' } });
    await settle(e, id);
    expect(taskOf(e, id).error_code).toBe('BILIBILI_FAILED');
  }, 60_000);

  it('reports risk control distinctly from an ordinary failure', async () => {
    upstream.state.riskControlSearch = true;
    upstream.state.llm = () => JSON.stringify({ song_name: 'x', artist: '', query: 'x' });

    const e = build({ llm: llmConfig() });
    const { id } = e.enqueueDownload({ target: { kind: 'keyword', query: 'x' } });
    await settle(e, id);
    expect(taskOf(e, id).error_code).toBe('BILIBILI_RISK_CONTROL');
  }, 60_000);

  it('refuses a keyword outright when no LLM is configured', async () => {
    const e = build();
    const { id } = e.enqueueDownload({ target: { kind: 'keyword', query: '稻香' } });
    await settle(e, id);
    expect(taskOf(e, id).error_code).toBe('LLM_NOT_CONFIGURED');
  }, 60_000);
});

// ─── Dedupe ────────────────────────────────────────────

describe('dedupe keys', () => {
  // auto only merges with auto (fifth review ①): "no page given" may resolve
  // to part 2, so folding it into an explicit ?p=1 could hand that request the
  // wrong part.
  it('separates bvid:auto from an explicit page', () => {
    expect(downloadDedupeKey(videoTarget())).toBe(`download:${BVID}:auto`);
    expect(downloadDedupeKey(videoTarget(1))).toBe(`download:${BVID}:1`);
    expect(downloadDedupeKey(videoTarget())).toBe(downloadDedupeKey(videoTarget(null, 'other')));
  });

  it('normalises keyword whitespace and case', () => {
    const a = downloadDedupeKey({ kind: 'keyword', query: '  Dao   Xiang ' });
    const b = downloadDedupeKey({ kind: 'keyword', query: 'dao xiang' });
    expect(a).toBe(b);
  });

  it('merges a second request for the same video and unions the targets', () => {
    const p1 = createPlaylist(db, sqlite, 'A');
    const p2 = createPlaylist(db, sqlite, 'B');
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget(), playlistIds: [p1.id] });
    const second = e.enqueueDownload({ target: videoTarget(), playlistIds: [p2.id] });

    expect(second.id).toBe(first.id);
    expect(second.playlist_ids).toEqual([p1.id, p2.id]);
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(e.snapshot().tasks).toHaveLength(1);
  });

  it('does NOT merge an explicit page into an auto request', () => {
    const e = build();
    const auto = e.enqueueDownload({ target: videoTarget() });
    const explicit = e.enqueueDownload({ target: videoTarget(1) });
    expect(explicit.id).not.toBe(auto.id);
  });

  // A terminal task releases its key, and the repeat then reuses the song
  // through the source-key lookup instead of downloading again.
  it('reuses the song rather than downloading twice once the first is done', async () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id;

    const mediaRequests = upstream.requests.filter((p) => p.startsWith('/media/')).length;
    const second = e.enqueueDownload({ target: videoTarget() });
    expect(second.id).not.toBe(first.id);
    await settle(e, second.id);

    expect(taskOf(e, second.id).result?.song_id).toBe(songId);
    expect(listSongs(db, sqlite).total).toBe(1);
    expect(upstream.requests.filter((p) => p.startsWith('/media/')).length).toBe(mediaRequests);
  }, 60_000);
});

// ─── Cancellation ──────────────────────────────────────

describe('cancel', () => {
  it('cancels a queued task without ever starting it', async () => {
    upstream.state.hangAudio = true;
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    const second = e.enqueueDownload({ target: videoTarget(2) });

    const cancelled = e.cancel(second.id);
    expect(cancelled.state).toBe('cancelled');
    expect(taskOf(e, first.id).state).not.toBe('cancelled');
    e.cancel(first.id);
  }, 60_000);

  it('aborts a running download and leaves no partial file', async () => {
    upstream.state.hangAudio = true;
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });

    // Wait for it to actually reach the download stage.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && taskOf(e, id).stage !== 'downloading') {
      await new Promise((r) => setTimeout(r, 10));
    }
    e.cancel(id);
    await settle(e, id);

    expect(taskOf(e, id).state).toBe('cancelled');
    expect(listSongs(db, sqlite).total).toBe(0);
  }, 60_000);

  it('is idempotent once terminal', async () => {
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);
    expect(e.cancel(id).state).toBe('succeeded');
    expect(e.cancel(id).state).toBe('succeeded');
  }, 60_000);

  it('404s an unknown task id', () => {
    const e = build();
    expect(() => e.cancel('11111111-2222-4333-8444-555555555555')).toThrow(/task not found/);
  });
});

// ─── Capacity and batches ──────────────────────────────

describe('capacity', () => {
  it('refuses a task beyond the pending limit', () => {
    upstream.state.hangAudio = true;
    const e = build({ capacity: 1 });
    e.enqueueDownload({ target: videoTarget() });
    expect(() => e.enqueueDownload({ target: videoTarget(2) })).toThrow(/queue is full/);
  });

  it('lets a merge through even at capacity — it creates no task', () => {
    upstream.state.hangAudio = true;
    const e = build({ capacity: 1 });
    const first = e.enqueueDownload({ target: videoTarget() });
    expect(e.enqueueDownload({ target: videoTarget() }).id).toBe(first.id);
  });
});

describe('enqueueBatches', () => {
  it('creates the new playlist and reports its real id', () => {
    const e = build();
    const [batch] = e.enqueueBatches([
      {
        target: { kind: 'new', name: '收藏夹导入' },
        items: [{ kind: 'video', bvid: BVID, page: null, title: '稻香' }],
      },
    ]);

    expect(batch?.target).toMatchObject({ kind: 'playlist', name: '收藏夹导入' });
    const playlistId = (batch?.target as { playlist_id: string }).playlist_id;
    expect(playlistId).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch?.total).toBe(1);
    expect(batch?.items[0]?.final).toBeNull();
  });

  // All or nothing (third review ③): a half-applied batch leaves the user with
  // some new playlists, some tasks, and no way to tell what is missing.
  it('rejects the whole request when one group overflows the capacity', () => {
    upstream.state.hangAudio = true;
    const e = build({ capacity: 2 });
    expect(() =>
      e.enqueueBatches([
        {
          target: { kind: 'new', name: '第一个' },
          items: [{ kind: 'video', bvid: BVID, page: 1, title: null }],
        },
        {
          target: { kind: 'new', name: '第二个' },
          items: [
            { kind: 'video', bvid: BVID, page: 2, title: null },
            { kind: 'video', bvid: BVID, page: 3, title: null },
          ],
        },
      ]),
    ).toThrow(/queue is full/);

    expect(e.snapshot().tasks).toEqual([]);
    expect(readdirSync(nest)).not.toContain('第一个');
  });

  it('rejects an unknown playlist target without registering anything', () => {
    const e = build();
    expect(() =>
      e.enqueueBatches([
        {
          target: { kind: 'playlist', playlist_id: '11111111-2222-4333-8444-555555555555' },
          items: [{ kind: 'video', bvid: BVID, page: 1, title: null }],
        },
      ]),
    ).toThrow(/playlist not found/);
    expect(e.snapshot().tasks).toEqual([]);
  });

  // A terminal task ages out of the ring; without the snapshot the batch would
  // silently lose its own item's outcome (M3-5).
  it('writes the terminal outcome back onto the batch item', async () => {
    const e = build();
    const [batch] = e.enqueueBatches([
      {
        target: { kind: 'all' },
        items: [{ kind: 'video', bvid: BVID, page: 1, title: '批量标题' }],
      },
    ]);
    await settleAll(e);

    const stored = e.snapshot().batches.find((b) => b.id === batch?.id);
    expect(stored?.items[0]?.final).toMatchObject({ state: 'succeeded' });
    expect(stored?.items[0]?.final?.song_id).not.toBeNull();
  }, 60_000);

  it('uses the batch item title over the video title', async () => {
    const e = build();
    e.enqueueBatches([
      {
        target: { kind: 'all' },
        items: [{ kind: 'video', bvid: BVID, page: 1, title: '列表里的标题' }],
      },
    ]);
    await settleAll(e);
    expect(listSongs(db, sqlite).songs[0]?.name).toBe('列表里的标题');
  }, 60_000);
});

// ─── Soft failures and continuations ───────────────────

describe('playlist targets that disappear', () => {
  it('still succeeds and records the lost target', async () => {
    const playlist = createPlaylist(db, sqlite, '会被删掉');
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget(), playlistIds: [playlist.id] });
    deletePlaylist(db, sqlite, playlist.id);
    await settle(e, id);

    const task = taskOf(e, id);
    expect(task.state).toBe('succeeded');
    expect(task.failed_playlist_ids).toEqual([playlist.id]);
  }, 60_000);
});

describe('lyrics continuation', () => {
  it('is spawned by a successful download and writes the lrc', async () => {
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);
    const songId = taskOf(e, id).result?.song_id as string;
    await settleAll(e);

    const lyricsTask = e.snapshot().tasks.find((t) => t.kind === 'lyrics');
    expect(lyricsTask?.state).toBe('succeeded');
    expect(existsSync(songLyricsPath(songId))).toBe(true);
    expect(readFileSync(songLyricsPath(songId), 'utf-8')).toContain('[00:12.34]');
  }, 60_000);

  it('fails only the lyrics task when no platform has anything', async () => {
    upstream.state.lyrics = { netease: [], qq: [], kugou: [] };
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);
    await settleAll(e);

    expect(taskOf(e, id).state).toBe('succeeded');
    const lyricsTask = e.snapshot().tasks.find((t) => t.kind === 'lyrics');
    expect(lyricsTask?.state).toBe('failed');
    expect(lyricsTask?.error_code).toBe('NOT_FOUND');
    expect(listSongs(db, sqlite).total).toBe(1);
  }, 60_000);
});

// ─── Redownload ────────────────────────────────────────

describe('redownload', () => {
  it('replaces the file of an existing song and flips it to downloaded', async () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id as string;
    await settleAll(e);

    const before = readFileSync(join(songsDir(), songId, 'song.mp3'));
    const again = e.enqueueRedownload(songId);
    await settle(e, again.id);

    expect(taskOf(e, again.id).state).toBe('succeeded');
    expect(readdirSync(join(songsDir(), songId)).sort()).toEqual(['lyrics.lrc', 'song.mp3']);
    expect(readFileSync(join(songsDir(), songId, 'song.mp3')).length).toBe(before.length);
  }, 60_000);

  it('404s an unknown song before queuing anything', () => {
    const e = build();
    expect(() => e.enqueueRedownload('11111111-2222-4333-8444-555555555555')).toThrow(
      /song not found/,
    );
    expect(e.snapshot().tasks).toEqual([]);
  });

  it('reports SOURCE_GONE when the key died and there is no LLM', async () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id as string;
    await settleAll(e);

    upstream.state.videos.clear(); // the source is gone
    const again = e.enqueueRedownload(songId);
    await settle(e, again.id);

    const task = taskOf(e, again.id);
    expect(task.error_code).toBe('SOURCE_GONE');
    expect(task.error_message).toContain('LLM');
    // The existing file is untouched.
    expect(existsSync(join(songsDir(), songId, 'song.mp3'))).toBe(true);
  }, 60_000);
});

// ─── Claims ────────────────────────────────────────────

describe('claims', () => {
  it('blocks a delete while a download holds the song', async () => {
    upstream.state.hangAudio = true;
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && taskOf(e, first.id).song_id === null) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const songId = taskOf(e, first.id).song_id as string;
    expect(() => e.claims.acquire(songId, 'exclusive', 'route-delete')).toThrow(/is busy/);
    e.cancel(first.id);
  }, 60_000);

  it('releases everything once the task is terminal', async () => {
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);
    await settleAll(e);
    const songId = taskOf(e, id).result?.song_id as string;
    expect(e.claims.describe(songId)).toEqual([]);
  }, 60_000);
});

// ─── Events ────────────────────────────────────────────

describe('callbacks', () => {
  it('reports the queued state immediately, then every stage, then the outcome', async () => {
    const statuses: { id: string; state: string; stage: string | null; revision: number }[] = [];
    let succeeded = 0;
    const e = build({
      callbacks: {
        onStatus: (t) =>
          statuses.push({ id: t.id, state: t.state, stage: t.stage, revision: t.revision }),
        onSucceeded: () => {
          succeeded++;
        },
      },
    });

    const { id } = e.enqueueDownload({ target: videoTarget() });
    expect(statuses[0]).toMatchObject({ state: 'queued', stage: null });
    await settle(e, id);

    // Only this task's events — the lyrics continuation has its own counter.
    const mine = statuses.filter((s) => s.id === id);
    const stages = mine.filter((s) => s.state === 'running').map((s) => s.stage);
    expect(stages).toContain('downloading');
    expect(stages).toContain('converting');
    expect(stages).toContain('saving');
    expect(mine.at(-1)).toMatchObject({ state: 'succeeded', stage: null });
    expect(succeeded).toBeGreaterThanOrEqual(1);

    // Revisions only ever move forward, so a client can dedupe on them.
    const revisions = mine.map((s) => s.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
  }, 60_000);

  it('announces a new batch even when every item merged onto pending tasks', () => {
    upstream.state.hangAudio = true;
    const changed: string[] = [];
    const e = build({ callbacks: { onBatchesChanged: (id) => changed.push(id) } });
    e.enqueueDownload({ target: videoTarget(1) });

    const [batch] = e.enqueueBatches([
      { target: { kind: 'all' }, items: [{ kind: 'video', bvid: BVID, page: 1, title: null }] },
    ]);
    expect(changed).toEqual([batch?.id]);
  });
});

// ─── Error mapping ─────────────────────────────────────

describe('describeTaskError', () => {
  it('maps the predictable classes rather than calling everything internal', async () => {
    const { InvalidSourceError, NotFoundError, SourceKeyConflictError, FfmpegError } = await import(
      '../errors.js'
    );
    expect(describeTaskError(new InvalidSourceError('p out of range')).code).toBe('INVALID_SOURCE');
    expect(describeTaskError(new SourceKeyConflictError('s', 'bilibili', 'k')).code).toBe(
      'SOURCE_KEY_CONFLICT',
    );
    expect(describeTaskError(new NotFoundError('song', 'x')).code).toBe('NOT_FOUND');
    expect(describeTaskError(new FfmpegError('boom')).code).toBe('FFMPEG_FAILED');
  });

  // The message is fixed on purpose: a raw error can carry a SQLite path or an
  // upstream response body, and neither belongs on the wire (fifth review ⑩).
  it('hides an unexpected error behind a fixed message', () => {
    const mapped = describeTaskError(new Error('/Users/someone/nest/lark/songs.db is locked'));
    expect(mapped.code).toBe('INTERNAL_ERROR');
    expect(mapped.message).not.toContain('songs.db');
    expect(mapped.message).toBe('下载任务出现内部错误，详情见日志');
  });
});

// ─── Shutdown ──────────────────────────────────────────

describe('close', () => {
  it('cancels what is in flight and waits for the worker to exit', async () => {
    upstream.state.hangAudio = true;
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget() });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && taskOf(e, id).state !== 'running') {
      await new Promise((r) => setTimeout(r, 10));
    }

    await e.close();
    engine = null;
    expect(['cancelled', 'failed']).toContain(taskOf(e, id).state);
  }, 60_000);

  it('refuses new work once closing', async () => {
    const e = build();
    await e.close();
    engine = null;
    expect(() => e.enqueueDownload({ target: videoTarget() })).toThrow(/queue is full/);
  });
});
