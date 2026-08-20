// The commit protocol, asserted against the desktop landing (N1h, judgement 16).
//
// These are PORT properties, not desktop details: every host that lands audio
// owes the same three answers, and the reason they are written here rather
// than in a hooks-and-runner harness is that there is exactly one
// implementation to run them against today. The cross-host signature is not
// frozen until N4 (§8); when the mobile implementation lands, these become its
// entry exam and the file grows a hook.
//
// What is under test is the CONTRACT the port declares:
//
//   `commit` runs exactly once, inside the implementation's own transaction,
//   at its point of no return. Throwing from it rolls the landing back —
//   including restoring the file that was there — and returning from it means
//   the song is committed and cannot be un-succeeded.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../db/index.js';
import { MediaToolsRegistry } from '../media-tools/registry.js';
import { resolveMediaTools } from '../media-tools/resolve.js';
import { songAudioPath, songDirPath } from '../paths.js';
import type { PortableDb } from '../portable/db.js';
import { DEFAULT_TIMEOUTS } from '../portable/download/timeouts.js';
import { createFileBackedSongInTx } from '../portable/library/songs.js';
import type { AudioLandingPort } from '../portable/ports/audio-landing.js';
import { uuid } from '../portable/runtime/random.js';
import { toneWav } from '../testing/tone-wav.js';
import { nodeAudioLanding } from './audio-landing.js';

let audioFixture: Buffer;
let nest: string;
let sqlite: BetterSqlite3.Database;
let store!: PortableDb;
let mediaTools: MediaToolsRegistry;
let landing: AudioLandingPort;

beforeAll(async () => {
  // Real audio, so ffmpeg has something it can genuinely transcode. Written by
  // hand rather than synthesised: the vendored build has neither the lavfi
  // demuxer nor a way to make its own input (M7 T0).
  audioFixture = toneWav(1);
  const outcome = resolveMediaTools();
  if (!outcome.ok) throw new Error(`no usable ffmpeg for the test run: ${outcome.detail}`);
  mediaTools = new MediaToolsRegistry();
  const probe = await mediaTools.refresh();
  if (probe.state !== 'ready') {
    throw new Error(`no usable ffmpeg for the test run (${probe.state}): ${probe.detail}`);
  }
}, 60_000);

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-landing-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  ({ sqlite, portable: store } = createDatabase({ dbPath: ':memory:' }));
  landing = nodeAudioLanding({ store, mediaTools, timeouts: DEFAULT_TIMEOUTS });
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** A stream of the fixture, as the client would hand one over. */
const openStream = (): Promise<Response> =>
  Promise.resolve(
    new Response(new Uint8Array(audioFixture), {
      headers: { 'content-length': String(audioFixture.byteLength) },
    }),
  );

interface LandOptions {
  songId: string;
  mode: 'new' | 'replace';
  commit: (result: { duration: number }) => void;
}

function land(options: LandOptions): Promise<{ warnings: string[] }> {
  return landing.land({
    taskId: uuid(),
    songId: options.songId,
    mode: options.mode,
    openStream,
    // The desktop lands through `openStream`; `request` is the native-host
    // description of the same call and goes unread here.
    request: { url: 'https://example.test/audio', headers: {}, timeoutMs: 60_000 },
    expect: { codecs: 'mp4a.40.2', isAac: true, expectedDurationSeconds: null },
    reportStage: () => {},
    onProgress: () => {},
    commit: options.commit,
    signal: new AbortController().signal,
  });
}

describe('the landing commit protocol', () => {
  it('calls commit exactly once, and hands it the duration that actually landed', async () => {
    const songId = uuid();
    const durations: number[] = [];
    await land({
      songId,
      mode: 'new',
      commit: ({ duration }) => {
        durations.push(duration);
        // Writing the row is what a commit IS, and the landing's transaction
        // touches `last_accessed_at` on it in the same breath (M5-7) — so a
        // commit that wrote nothing is not a lighter version of this test, it
        // is a different protocol.
        createFileBackedSongInTx(store, {
          id: songId,
          name: '一',
          artist: '',
          duration,
          file_origin: 'downloaded',
          source_url: null,
          source_provider: null,
          source_key: null,
        });
      },
    });

    expect(durations).toHaveLength(1);
    // The fixture is one second, and the row is written from what was probed
    // out of the OUTPUT — never from what any caller promised.
    expect(durations[0]).toBeGreaterThan(0);
    expect(durations[0]).toBeLessThan(3);
    expect(existsSync(songAudioPath(songId))).toBe(true);
  });

  it('rolls the whole landing back when commit throws, restoring the old file', async () => {
    const songId = uuid();
    mkdirSync(songDirPath(songId), { recursive: true });
    writeFileSync(songAudioPath(songId), 'the file that was already there');

    let calls = 0;
    await expect(
      land({
        songId,
        mode: 'replace',
        commit: () => {
          calls += 1;
          throw new Error('the row could not be written');
        },
      }),
    ).rejects.toThrow();

    expect(calls).toBe(1);
    // The point of the manifest: the file that was there is the file that is
    // there. A landing that half-succeeded would be worse than one that failed.
    expect(readFileSync(songAudioPath(songId), 'utf-8')).toBe('the file that was already there');
    // And nothing of the attempt is left to confuse the next recovery pass.
    const residue = readdirSync(songDirPath(songId)).filter((name) => name.startsWith('.'));
    expect(residue).toEqual([]);
  });

  it('leaves nothing behind at all when a NEW song fails to commit', async () => {
    const songId = uuid();
    await expect(
      land({
        songId,
        mode: 'new',
        commit: () => {
          throw new Error('no');
        },
      }),
    ).rejects.toThrow();
    // A brand-new song owns nothing else in that directory, so the whole thing
    // goes — leaving it would look like an orphan to recovery.
    expect(existsSync(songDirPath(songId))).toBe(false);
  });
});

describe('the two lifecycle answers', () => {
  it('hasAudio reports the canonical file, not the directory', () => {
    const songId = uuid();
    expect(landing.hasAudio(songId)).toBe(false);
    mkdirSync(songDirPath(songId), { recursive: true });
    // A directory with no audio in it is not a song with a file — that is the
    // state a cancelled download leaves behind.
    expect(landing.hasAudio(songId)).toBe(false);
    writeFileSync(songAudioPath(songId), 'x');
    expect(landing.hasAudio(songId)).toBe(true);
  });

  it('discardUncommitted removes the directory, and is quiet about one that is gone', () => {
    const songId = uuid();
    mkdirSync(songDirPath(songId), { recursive: true });
    writeFileSync(songAudioPath(songId), 'x');
    landing.discardUncommitted(songId);
    expect(existsSync(songDirPath(songId))).toBe(false);
    // Idempotent: boot recovery and a cancelled task can both reach it.
    expect(() => landing.discardUncommitted(songId)).not.toThrow();
  });
});
