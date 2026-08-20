// The engine end to end: a real fake-upstream server, a real database, real
// ffmpeg. The only thing stubbed is the internet.
//
// The acceptance criterion this file exists to protect is the R16 one — a
// pasted single-part URL downloads with NO LLM configured — so that case runs
// first and with `llm: null` everywhere it can reach.

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DownloadNamingMode, DownloadTaskData, LlmConfig } from '@lark/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../db/index.js';
import type { LarkDatabase } from '../../db/index.js';
import { nodeAudioLanding } from '../../download/audio-landing.js';
import { type MediaToolsProvider, MediaToolsRegistry } from '../../media-tools/registry.js';
import { resolveMediaTools } from '../../media-tools/resolve.js';
import { nodeFileContext } from '../../node-fs.js';
import { songLyricsPath } from '../../paths.js';
import { songsDir } from '../../paths.js';
import { fakeMediaTools } from '../../testing/fake-media-tools.js';
import type { FakeUpstream } from '../../testing/fake-upstream.js';
import { startFakeUpstream } from '../../testing/fake-upstream.js';
import { toneWav } from '../../testing/tone-wav.js';
import type { PortableDb } from '../db.js';
import { MediaToolsUnavailableError } from '../errors.js';
import {
  createPlaylist,
  deletePlaylist,
  getPlaylistSongs,
  listPlaylists,
} from '../library/playlists.js';
import { getSong, listSongs } from '../library/songs.js';
import type { AudioLandingPort, AudioStreamExpectation } from '../ports/audio-landing.js';
import { songs } from '../schema.js';
import { createBilibiliClient } from './bilibili.js';
import { DownloadEngine, describeTaskError, downloadDedupeKey } from './engine.js';
import { DEFAULT_TIMEOUTS } from './timeouts.js';

const BVID = 'BV1Ki4y1y7HC';
const NO_LLM: LlmConfig = { url: '', model: '', api_key: '', api_format: '' };

let audioFixture: Buffer;
let nest: string;
let db: LarkDatabase;
let store!: PortableDb;
let sqlite: BetterSqlite3.Database;
let upstream: FakeUpstream;
let engine: DownloadEngine | null = null;
/** The real registry: these tests transcode for real, so the tools must be real. */
let mediaTools: MediaToolsRegistry;

beforeAll(async () => {
  // Real audio, so ffmpeg has something it can genuinely transcode. Written
  // by hand rather than synthesised by ffmpeg: the vendored build has neither
  // the lavfi demuxer nor an AAC encoder (M7 T0).
  audioFixture = toneWav(1);

  const outcome = resolveMediaTools();
  if (!outcome.ok) throw new Error(`no usable ffmpeg for the test run: ${outcome.detail}`);
  mediaTools = new MediaToolsRegistry();
  const probe = await mediaTools.refresh();
  if (probe.state !== 'ready') {
    throw new Error(
      `no usable ffmpeg for the test run (${probe.state}): ${probe.detail} — run \`just fetch-ffmpeg\` or \`brew install ffmpeg\``,
    );
  }
}, 60_000);

beforeEach(async () => {
  nest = mkdtempSync(join(tmpdir(), 'lark-engine-'));
  // `vi.stubEnv`, not an assignment: Biome blocks `delete process.env.X`, and
  // `= undefined` writes the STRING "undefined" into the environment.
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ db, sqlite, portable: store } = createDatabase({ dbPath: ':memory:' }));
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
  mediaTools?: MediaToolsProvider;
  llm?: LlmConfig;
  capacity?: number;
  callbacks?: ConstructorParameters<typeof DownloadEngine>[0]['callbacks'];
  /** Replace the landing port — e.g. a spy that captures the `expect` it is handed. */
  audio?: AudioLandingPort;
}

function build(options: BuildOptions = {}): DownloadEngine {
  const llmConfig: LlmConfig = options.llm ?? NO_LLM;
  const tools = options.mediaTools ?? mediaTools;
  engine = new DownloadEngine({
    store,
    files: nodeFileContext(),
    getLlmConfig: () => llmConfig,
    // The real desktop landing, exactly as boot builds it: these tests are
    // about the engine's decisions AROUND the bytes, and a fake here would
    // stop asserting that the six-step protocol still runs under them.
    audio:
      options.audio ?? nodeAudioLanding({ store, mediaTools: tools, timeouts: DEFAULT_TIMEOUTS }),
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

const videoTarget = (
  page: number | null = null,
  title: string | null = null,
  naming: DownloadNamingMode = 'original',
) => ({ kind: 'video', bvid: BVID, page, title, naming }) as const;

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

    // song.m4a is there and nothing the LANDING staged is left beside it. The
    // lyrics continuation is a different task on its own clock: it may still
    // be writing `.lyrics.<uuid>.tmp` right now, so the filter names the
    // download's own prefixes instead of "anything hidden".
    const files = readdirSync(join(songsDir(), songId));
    expect(files).toContain('song.m4a');
    const staged = files.filter((f) =>
      ['.download.', '.song.', '.pending.', '.replace.'].some((p) => f.startsWith(p)),
    );
    expect(staged).toEqual([]);
    // The fake LLM endpoint was never called.
    expect(upstream.requests.filter((p) => p.includes('completions'))).toEqual([]);
  }, 60_000);

  // M7-18. Two things are asserted, and the second is the point: the task
  // fails with a code that names the machine's problem, and it fails BEFORE
  // the transfer — pulling down a whole track only to discover there is
  // nothing to transcode it with is a minutes-long way to say "install
  // ffmpeg".
  it('fails with MEDIA_TOOLS_UNAVAILABLE before downloading a byte', async () => {
    const e = build({
      mediaTools: fakeMediaTools({
        unavailable: new MediaToolsUnavailableError('missing', '没有找到：ffmpeg'),
      }),
    });
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);

    const task = taskOf(e, id);
    expect(task.state).toBe('failed');
    expect(task.error_code).toBe('MEDIA_TOOLS_UNAVAILABLE');
    // `/media/` is where the fake upstream serves the bytes.
    expect(upstream.requests.filter((p) => p.startsWith('/media/'))).toEqual([]);
  }, 60_000);

  it('adds the song to the requested playlists', async () => {
    const playlist = createPlaylist(store, '新歌单');
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

// ─── Naming (0.3.0 §3.6-1) ─────────────────────────────

describe('naming mode', () => {
  /** Answer the infer prompt; everything else is not this suite's business. */
  function inferAs(answer: { song_name?: string; artist?: string } | 'fail'): void {
    upstream.state.llm = (system) => {
      if (!system.includes('推断内容名称')) return '1';
      if (answer === 'fail') throw new Error('the model is having a day');
      return JSON.stringify(answer);
    };
  }

  it('keeps the title verbatim, and asks nothing, on original', async () => {
    inferAs({ song_name: '不该被用到', artist: '也不该' });
    const e = build({ llm: llmConfig() });
    const { id } = e.enqueueDownload({ target: videoTarget(null, null, 'original') });
    await settle(e, id);

    const song = getSong(db, sqlite, taskOf(e, id).result?.song_id as string);
    // The fixture's own title and uploader, untouched by a configured model.
    expect(song.name).toBe('【私藏馆】周杰伦《稻香》');
    expect(song.artist).toBe('音乐私藏馆');
    expect(upstream.requests.some((r) => r.includes('chat/completions'))).toBe(false);
  }, 60_000);

  it('stores what the model read out of the title on clean', async () => {
    inferAs({ song_name: '稻香', artist: '周杰伦' });
    const e = build({ llm: llmConfig() });
    const { id } = e.enqueueDownload({ target: videoTarget(null, null, 'clean') });
    await settle(e, id);

    const song = getSong(db, sqlite, taskOf(e, id).result?.song_id as string);
    expect(song.name).toBe('稻香');
    expect(song.artist).toBe('周杰伦');
  }, 60_000);

  // Criterion 25.
  it('falls back to the uploader when the model gives no artist', async () => {
    inferAs({ song_name: '晴天', artist: '' });
    const e = build({ llm: llmConfig() });
    const { id } = e.enqueueDownload({ target: videoTarget(null, null, 'clean') });
    await settle(e, id);

    const song = getSong(db, sqlite, taskOf(e, id).result?.song_id as string);
    expect(song.name).toBe('晴天');
    expect(song.artist).toBe('音乐私藏馆');
  }, 60_000);

  // Per SONG, not per kind. A queue of ten links should hand back finished
  // songs one at a time; the alternative is ten silent files followed by ten
  // lyrics fetches, and the first song is only done when the last one is.
  it("fetches one song's lyrics before starting the next song", async () => {
    // Two parts of one video = two songs from two links, which is the smallest
    // "queue of several" this upstream can produce.
    await upstream.close();
    upstream = await startFakeUpstream({
      audio: audioFixture,
      videos: new Map([
        [
          BVID,
          {
            title: '【私藏馆】周杰伦《稻香》',
            owner: '音乐私藏馆',
            ownerMid: 229733301,
            duration: 223,
            pages: [
              { page: 1, part: 'P1', duration: 111, cid: 550103819 },
              { page: 2, part: 'P2', duration: 112, cid: 550103820 },
            ],
          },
        ],
      ]),
    });

    const started: string[] = [];
    const seen = new Set<string>();
    const e = build({
      callbacks: {
        onStatus: (task) => {
          if (task.state !== 'running' || seen.has(task.id)) return;
          seen.add(task.id);
          started.push(task.kind);
        },
      },
    });
    e.enqueueDownload({ target: videoTarget(1) });
    e.enqueueDownload({ target: videoTarget(2) });
    await settleAll(e);

    expect(started).toEqual(['download', 'lyrics', 'download', 'lyrics']);
  }, 90_000);

  // What a task list can call this task (§3.6-3). The link is all a queued
  // task has; the naming mode's answer is the first thing anyone can show.
  it('names the task after the song the naming mode produced', async () => {
    inferAs({ song_name: '稻香', artist: '周杰伦' });
    const e = build({ llm: llmConfig() });
    const { id, title } = e.enqueueDownload({ target: videoTarget(null, null, 'clean') });
    expect(title).toBeNull();
    await settle(e, id);

    expect(taskOf(e, id).title).toBe('稻香');
    expect(taskOf(e, id).artist).toBe('周杰伦');
  }, 60_000);

  it('names a task that starts from a song before it has run at all', async () => {
    const e = build({ llm: NO_LLM });
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);
    const songId = taskOf(e, id).result?.song_id as string;

    // Enqueue only — no `settle`: the label has to be there while it waits,
    // which is the whole complaint about a queue full of "已有歌曲".
    const again = e.enqueueRedownload(songId);
    expect(again.title).toBe(getSong(db, sqlite, songId).name);
    expect(again.artist).toBe(getSong(db, sqlite, songId).artist);
    await settle(e, again.id);
  }, 60_000);

  it('falls back to the title the submission carried when the model fails', async () => {
    inferAs('fail');
    const e = build({ llm: llmConfig() });
    // A list item: its own title is the one to fall back to, not the video's.
    const { id } = e.enqueueDownload({ target: videoTarget(null, '列表里的标题', 'clean') });
    await settle(e, id);

    const task = taskOf(e, id);
    // Degraded, never failed: the audio is what the user asked for.
    expect(task.state).toBe('succeeded');
    const song = getSong(db, sqlite, task.result?.song_id as string);
    expect(song.name).toBe('列表里的标题');
    expect(song.artist).toBe('音乐私藏馆');
  }, 60_000);

  // Criterion 27. The one failure the fallback must NOT swallow: an aborted
  // model call and a provider error arrive as the same error, and only the
  // task's own signal can tell them apart.
  //
  // Set up so that naming is the LAST thing that touches the network: the song
  // is already in the library with its file, so this download transfers
  // nothing and every later step is local. Swallow the abort here and the task
  // walks straight past the commit point and reports SUCCESS — joining a
  // playlist the user cancelled out of.
  it('a cancel during naming cancels the task instead of committing it', async () => {
    inferAs({ song_name: '稻香', artist: '周杰伦' });
    const e = build({ llm: llmConfig() });
    const first = e.enqueueDownload({ target: videoTarget(1, null, 'original') });
    await settle(e, first.id);
    const playlist = createPlaylist(store, '不该收到这首');

    let cancel: (() => void) | null = null;
    upstream.state.llm = (system) => {
      if (!system.includes('推断内容名称')) return '1';
      cancel?.();
      throw new Error('the request was aborted');
    };
    const second = e.enqueueDownload({
      target: videoTarget(1, null, 'clean'),
      playlistIds: [playlist.id],
    });
    cancel = () => e.cancel(second.id);
    await settle(e, second.id);

    expect(taskOf(e, second.id).state).toBe('cancelled');
    expect(getPlaylistSongs(db, sqlite, playlist.id)).toHaveLength(0);
  }, 60_000);

  it('reports the naming stage only on the clean path', async () => {
    inferAs({ song_name: '稻香', artist: '周杰伦' });
    const stages: (string | null)[] = [];
    const e = build({
      llm: llmConfig(),
      callbacks: { onStatus: (task) => stages.push(task.stage) },
    });
    const { id } = e.enqueueDownload({ target: videoTarget(null, null, 'clean') });
    await settle(e, id);
    expect(stages).toContain('naming');

    const plain = e.enqueueDownload({ target: videoTarget(1, null, 'original') });
    await settle(e, plain.id);
    expect(stages.slice(stages.lastIndexOf('naming') + 1)).not.toContain('naming');
  }, 60_000);
});

// ─── Byte progress (0.3.0 §3.5) ────────────────────────

describe('transfer progress', () => {
  /** Every status snapshot the engine emitted for this task, in order. */
  function watch(): { events: DownloadTaskData[]; engine: DownloadEngine } {
    const events: DownloadTaskData[] = [];
    return { events, engine: build({ callbacks: { onStatus: (t) => events.push(t) } }) };
  }

  it('reports what arrived and what was promised, then zeroes it', async () => {
    const { events, engine } = watch();
    const { id } = engine.enqueueDownload({ target: videoTarget() });
    await settle(engine, id);

    const mine = events.filter((event) => event.id === id);
    const transferring = mine.filter(
      (event) => event.stage === 'downloading' && event.received_bytes > 0,
    );
    expect(transferring.length).toBeGreaterThan(0);
    for (const event of transferring) {
      expect(event.total_bytes).toBe(audioFixture.length);
      expect(event.received_bytes).toBeLessThanOrEqual(audioFixture.length);
    }
    // The last thing said about the transfer is its full size — the throttle
    // must not be allowed to hold the tail (§3.5).
    expect(transferring.at(-1)?.received_bytes).toBe(audioFixture.length);

    // Progress belongs to one stage, and a terminal task has none.
    for (const event of mine.filter((e) => e.stage !== 'downloading')) {
      expect(event.received_bytes).toBe(0);
      expect(event.total_bytes).toBeNull();
    }
  }, 60_000);

  // The other half of the contract: a source that declares no size.
  it('reports bytes with no total when the source does not declare one', async () => {
    upstream.state.audioChunkBytes = 4096;
    const { events, engine } = watch();
    const { id } = engine.enqueueDownload({ target: videoTarget() });
    await settle(engine, id);

    const transferring = events.filter(
      (event) => event.id === id && event.stage === 'downloading' && event.received_bytes > 0,
    );
    expect(transferring.length).toBeGreaterThan(0);
    for (const event of transferring) expect(event.total_bytes).toBeNull();
    expect(transferring.at(-1)?.received_bytes).toBe(audioFixture.length);
  }, 60_000);

  it('throttles: many chunks, few events', async () => {
    upstream.state.audioChunkBytes = 1024;
    const chunks = Math.ceil(audioFixture.length / 1024);
    expect(chunks).toBeGreaterThan(20);

    const { events, engine } = watch();
    const { id } = engine.enqueueDownload({ target: videoTarget() });
    await settle(engine, id);

    // §4-d: one every 500ms at most, so a transfer this fast produces the
    // opening one and the forced final value — never one per chunk.
    const transferring = events.filter(
      (event) => event.id === id && event.stage === 'downloading' && event.received_bytes > 0,
    );
    expect(transferring.length).toBeLessThanOrEqual(2);
    expect(transferring.at(-1)?.received_bytes).toBe(audioFixture.length);
  }, 60_000);

  it('never goes backwards within one transfer', async () => {
    upstream.state.audioChunkBytes = 2048;
    const { events, engine } = watch();
    const { id } = engine.enqueueDownload({ target: videoTarget() });
    await settle(engine, id);

    const received = events
      .filter((event) => event.id === id && event.stage === 'downloading')
      .map((event) => event.received_bytes);
    expect(received).toEqual([...received].sort((a, b) => a - b));
  }, 60_000);
});

// ─── Naming conflicts ──────────────────────────────────

describe('two submissions, two naming modes', () => {
  // Criterion 26: the refusal lands before anything is written.
  it('refuses the second one, and creates no playlist on the way out', async () => {
    const e = build();
    e.enqueueDownload({ target: videoTarget(1, null, 'original') });

    let caught: unknown;
    try {
      e.enqueueBatches([
        {
          target: { kind: 'new', name: '不该被建出来的歌单' },
          items: [{ kind: 'video', bvid: BVID, page: 1, title: null, naming: 'clean' }],
        },
      ]);
    } catch (err) {
      caught = err;
    }

    expect((caught as { code?: string })?.code).toBe('NAMING_MODE_CONFLICT');
    expect(listPlaylists(db, sqlite).some((p) => p.name === '不该被建出来的歌单')).toBe(false);
  });

  it('refuses a request that disagrees with itself', () => {
    const e = build();
    expect(() =>
      e.enqueueBatches([
        {
          target: { kind: 'all' },
          items: [
            { kind: 'video', bvid: BVID, page: 1, title: null, naming: 'original' },
            { kind: 'video', bvid: BVID, page: 1, title: null, naming: 'clean' },
          ],
        },
      ]),
    ).toThrow(/NAMING|命名/);
  });

  it('merges the two that agree', () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget(1, null, 'clean') });
    const second = e.enqueueDownload({ target: videoTarget(1, null, 'clean') });
    expect(second.id).toBe(first.id);
  });
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
    const p1 = createPlaylist(store, 'A');
    const p2 = createPlaylist(store, 'B');
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

  it('aborts a running download and leaves nothing behind', async () => {
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
    // Found in acceptance: staging happens inside the song's own directory, so
    // the directory exists before the transfer does. Nothing else claims it —
    // recovery ignores a directory with no audio — so one empty directory per
    // cancelled download would accumulate forever.
    expect(readdirSync(songsDir())).toEqual([]);
  }, 60_000);

  it("leaves an existing song's directory alone when a redownload is cancelled", async () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id as string;
    await settleAll(e);

    upstream.state.hangAudio = true;
    const again = e.enqueueRedownload(songId);
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && taskOf(e, again.id).stage !== 'downloading') {
      await new Promise((r) => setTimeout(r, 10));
    }
    e.cancel(again.id);
    await settle(e, again.id);

    // The song has a row, so its directory is not the cleanup's business.
    expect(existsSync(join(songsDir(), songId, 'song.m4a'))).toBe(true);
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
        items: [{ kind: 'video', bvid: BVID, page: null, title: '稻香', naming: 'original' }],
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
          items: [{ kind: 'video', bvid: BVID, page: 1, title: null, naming: 'original' }],
        },
        {
          target: { kind: 'new', name: '第二个' },
          items: [
            { kind: 'video', bvid: BVID, page: 2, title: null, naming: 'original' },
            { kind: 'video', bvid: BVID, page: 3, title: null, naming: 'original' },
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
          items: [{ kind: 'video', bvid: BVID, page: 1, title: null, naming: 'original' }],
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
        items: [{ kind: 'video', bvid: BVID, page: 1, title: '批量标题', naming: 'original' }],
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
        items: [{ kind: 'video', bvid: BVID, page: 1, title: '列表里的标题', naming: 'original' }],
      },
    ]);
    await settleAll(e);
    expect(listSongs(db, sqlite).songs[0]?.name).toBe('列表里的标题');
  }, 60_000);
});

// ─── Soft failures and continuations ───────────────────

describe('playlist targets that disappear', () => {
  it('still succeeds and records the lost target', async () => {
    const playlist = createPlaylist(store, '会被删掉');
    const e = build();
    const { id } = e.enqueueDownload({ target: videoTarget(), playlistIds: [playlist.id] });
    deletePlaylist(store, playlist.id);
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

    const before = readFileSync(join(songsDir(), songId, 'song.m4a'));
    const again = e.enqueueRedownload(songId);
    await settle(e, again.id);
    // The redownload spawns its own lyrics continuation, which is still
    // writing `.lyrics.<uuid>.tmp` when the task itself goes terminal — the
    // "no residue" assertion below is about a settled directory.
    await settleAll(e);

    expect(taskOf(e, again.id).state).toBe('succeeded');
    expect(readdirSync(join(songsDir(), songId)).sort()).toEqual(['lyrics.lrc', 'song.m4a']);
    expect(readFileSync(join(songsDir(), songId, 'song.m4a')).length).toBe(before.length);
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
    expect(existsSync(join(songsDir(), songId, 'song.m4a'))).toBe(true);
  }, 60_000);
});

// ─── expectedDurationSeconds (N4a, §1.4) ───────────────
//
// A REFERENCE the landing may cross-check, filled from the page list both
// paths already fetched — the desktop still ignores it, so this asserts the
// engine QUOTES it, not that anything trusts it. The fake video's one part is
// 223s (`defaultState`), so both a new song and a redownload must see 223.

/** A landing spy that records the `expect` it is handed and commits at once. */
function capturingAudio(seen: AudioStreamExpectation[]): AudioLandingPort {
  return {
    hasAudio: () => false,
    discardUncommitted: () => {},
    async land(input) {
      seen.push(input.expect);
      input.commit({ duration: 1 });
      return { warnings: [] };
    },
  };
}

describe('expectedDurationSeconds', () => {
  it('quotes the selected part duration for a new song and a redownload', async () => {
    const seen: AudioStreamExpectation[] = [];
    const e = build({ audio: capturingAudio(seen) });

    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id as string;
    // New song: resolveTarget → normalizeSourceOnline → the page's duration.
    expect(seen[0]?.expectedDurationSeconds).toBe(223);

    const again = e.enqueueRedownload(songId);
    await settle(e, again.id);
    // Redownload: probeSourceKey resolves the SAME NormalizedSource, so the
    // page is there to quote — the field is not forced to null (§1.4 fix).
    expect(seen[1]?.expectedDurationSeconds).toBe(223);
  }, 30_000);
});

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

// ─── ensure-file (M5-8) ────────────────────────────────

describe('ensure-file', () => {
  it('succeeds without a single network call when the file is already there', async () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id as string;
    await settleAll(e);

    // The hardest case, and the common one for a Go-era import: a file on
    // disk and no source key at all, so nothing COULD be resolved.
    db.update(songs).set({ source_key: null, source_provider: null }).run();
    const before = readFileSync(join(songsDir(), songId, 'song.m4a'));
    upstream.requests.length = 0;

    const ensure = e.enqueueEnsureFile(songId);
    await settle(e, ensure.id);
    await settleAll(e);

    expect(taskOf(e, ensure.id).state).toBe('succeeded');
    expect(taskOf(e, ensure.id).result).toEqual({ song_id: songId });
    expect(upstream.requests).toEqual([]); // no probe, no lyrics, nothing
    expect(readFileSync(join(songsDir(), songId, 'song.m4a')).equals(before)).toBe(true);
  }, 60_000);

  it('downloads the file when it is missing', async () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id as string;
    await settleAll(e);
    rmSync(join(songsDir(), songId, 'song.m4a'));

    const ensure = e.enqueueEnsureFile(songId);
    await settle(e, ensure.id);

    expect(taskOf(e, ensure.id).state).toBe('succeeded');
    expect(existsSync(join(songsDir(), songId, 'song.m4a'))).toBe(true);
  }, 60_000);

  it('keeps its own dedupe key — it must never absorb a forced redownload', async () => {
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });
    await settle(e, first.id);
    const songId = taskOf(e, first.id).result?.song_id as string;
    await settleAll(e);

    const ensure = e.enqueueEnsureFile(songId);
    const redownload = e.enqueueRedownload(songId);
    expect(redownload.id).not.toBe(ensure.id);
    // …and each merges only with its own kind.
    expect(e.enqueueEnsureFile(songId).id).toBe(ensure.id);
    expect(e.enqueueRedownload(songId).id).toBe(redownload.id);

    e.cancel(ensure.id);
    e.cancel(redownload.id);
  }, 60_000);
});

// ─── Eviction pre-filter (M5-5) ────────────────────────

describe('pendingFileSongIds', () => {
  it('lists songs a queued file task will write, and ignores lyrics tasks', async () => {
    upstream.state.hangAudio = true;
    const e = build();
    const first = e.enqueueDownload({ target: videoTarget() });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && taskOf(e, first.id).song_id === null) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const songId = taskOf(e, first.id).song_id as string;
    expect([...e.pendingFileSongIds()]).toEqual([songId]);

    e.cancel(first.id);
    await settle(e, first.id);
    expect([...e.pendingFileSongIds()]).toEqual([]);

    // A lyrics task writes lyrics.lrc, never the audio — and one is spawned by
    // every finished download, so counting it would make a just-downloaded
    // song permanently unevictable.
    upstream.state.hangAudio = false;
    const done = e.enqueueDownload({ target: videoTarget() });
    await settle(e, done.id);
    await settleAll(e);
    const downloaded = taskOf(e, done.id).result?.song_id as string;

    e.enqueueLyrics(downloaded);
    expect([...e.pendingFileSongIds()]).toEqual([]);
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

  /**
   * Found in acceptance: `resolving` went out three times for one transition,
   * because the worker sets the opening stage and the pipeline reported it
   * again on entry.
   *
   * The rule is not "never repeat a stage" — binding the song id is a real
   * change that happens while the stage stays `resolving`, and the client
   * wants that signal. The rule is that an event must MEAN something: two
   * consecutive events may share a stage only if something else moved.
   */
  it('emits an event only when something actually changed', async () => {
    const seen: DownloadTaskData[] = [];
    const e = build({ callbacks: { onStatus: (t) => seen.push(t) } });
    const { id } = e.enqueueDownload({ target: videoTarget() });
    await settle(e, id);
    await settleAll(e);

    // Byte progress is a fourth axis (§3.5): two events can legitimately agree
    // on state, stage AND song id and still be a real update, which is exactly
    // why the dedupe tuple carries `revision`.
    const inert = seen.filter((event, i) => {
      const previous = seen[i - 1];
      return (
        previous !== undefined &&
        previous.state === event.state &&
        previous.stage === event.stage &&
        previous.song_id === event.song_id &&
        previous.received_bytes === event.received_bytes
      );
    });
    expect(inert).toEqual([]);
    // …and within one task the revision only ever climbs, so a client that
    // dedupes on the tuple never drops one of these. (Per task: the lyrics
    // continuation is a second task, and its revisions start at 1 again.)
    const byTask = new Map<string, number[]>();
    for (const event of seen) {
      byTask.set(event.id, [...(byTask.get(event.id) ?? []), event.revision]);
    }
    for (const revisions of byTask.values()) {
      expect(revisions).toEqual([...revisions].sort((a, b) => a - b));
    }
  }, 60_000);

  it('announces a new batch even when every item merged onto pending tasks', () => {
    upstream.state.hangAudio = true;
    const changed: string[] = [];
    const e = build({ callbacks: { onBatchesChanged: (id) => changed.push(id) } });
    e.enqueueDownload({ target: videoTarget(1) });

    const [batch] = e.enqueueBatches([
      {
        target: { kind: 'all' },
        items: [{ kind: 'video', bvid: BVID, page: 1, title: null, naming: 'original' }],
      },
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
