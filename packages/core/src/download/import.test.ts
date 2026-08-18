// The import matrix (0.3.0 T4, §3.4 — criterion 31).
//
// One case per row of the decision table, run against the REAL vendored
// ffmpeg: the table's whole content is what a specific build does with a
// specific container, and a fake tool chain would only prove that this file
// agrees with itself. The inputs are the tracked fixtures — the profile
// decodes ALAC, ADTS, FLAC, Vorbis and Opus while encoding none of them, so
// nothing here could produce its own input either (see
// `scripts/fixtures/README.md`).

import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LarkDatabase, createDatabase } from '../db/index.js';
import { probeCapabilities } from '../media-tools/capabilities.js';
import { type ResolvedMediaTools, resolveMediaTools } from '../media-tools/resolve.js';
import { songsDir } from '../paths.js';
import type { PortableDb } from '../portable/db.js';
import { getSong } from '../portable/library/songs.js';
import { type AudioFixture, fixturePath, vendoredToolsDir } from '../testing/audio-fixtures.js';
import { type FakeMediaTools, fakeMediaTools } from '../testing/fake-media-tools.js';
import { type WavSampleFormat, toneWav } from '../testing/tone-wav.js';
import { probeAudio } from './ffmpeg.js';
import { importSongs } from './import.js';

let nest: string;
let inputs: string;
let db: LarkDatabase;
let store!: PortableDb;
let sqlite: BetterSqlite3.Database;
let tools: ResolvedMediaTools;
let mediaTools: FakeMediaTools;

beforeAll(async () => {
  // The vendored build when there is one: this suite's whole claim is that the
  // profile lark SHIPS reads these containers, and the resolver would
  // otherwise prefer a developer's Homebrew ffmpeg — which decodes everything,
  // and would let a missing decoder ship.
  const vendored = vendoredToolsDir();
  const outcome = resolveMediaTools(
    vendored === null ? {} : { env: { ...process.env, LARK_MEDIA_TOOLS_DIR: vendored } },
  );
  if (!outcome.ok) throw new Error(`no usable ffmpeg for the test run: ${outcome.detail}`);
  const probe = await probeCapabilities(outcome.tools);
  if (probe.state !== 'ready') {
    throw new Error(`no usable ffmpeg for the test run (${probe.state}): ${probe.detail}`);
  }
  tools = outcome.tools;
  // The user's files live outside the nest, and are never modified — a
  // separate directory so a stray write into one would be visible.
  inputs = mkdtempSync(join(tmpdir(), 'lark-import-inputs-'));
}, 120_000);

afterAll(() => {
  rmSync(inputs, { recursive: true, force: true });
});

beforeEach(() => {
  nest = mkdtempSync(join(tmpdir(), 'lark-import-nest-'));
  vi.stubEnv('LARK_NEST_DIR', nest);
  const handles = createDatabase({ dbPath: ':memory:' });
  db = handles.db;
  store = handles.portable;
  sqlite = handles.sqlite;
  // The real binaries behind a provider that records what it was told, so the
  // suite can also assert the tool chain is not blamed for a bad file.
  mediaTools = fakeMediaTools({ ffmpeg: tools.ffmpeg.path, ffprobe: tools.ffprobe.path });
});

afterEach(() => {
  sqlite.close();
  vi.unstubAllEnvs();
  rmSync(nest, { recursive: true, force: true });
});

/** Copy a tracked fixture under a name that says which case it is. */
function input(fixture: AudioFixture, as: string): string {
  const path = join(inputs, as);
  copyFileSync(fixturePath(fixture), path);
  return path;
}

function wavInput(as: string, format: WavSampleFormat): string {
  const path = join(inputs, as);
  writeFileSync(path, toneWav(1, 22_050, format));
  return path;
}

const importOne = async (path: string) => importSongs(store, mediaTools, [path]);

/** What is under `songs/`, with "the directory is not there yet" as empty. */
function songDirs(): string[] {
  return existsSync(songsDir()) ? readdirSync(songsDir()) : [];
}

/** The landed file, probed — what the library actually got. */
async function landed(songId: string) {
  const files = readdirSync(join(songsDir(), songId));
  expect(files).toEqual(['song.m4a']);
  return probeAudio(tools.ffprobe.path, join(songsDir(), songId, 'song.m4a'));
}

// ─── Accepted ──────────────────────────────────────────

describe('the formats import takes', () => {
  interface Accepted {
    name: string;
    path: () => string;
    /** The one warning this import owes the user, or none at all. */
    warning: RegExp | null;
    channels?: number;
    sampleRate?: number;
  }

  const CASES: Accepted[] = [
    {
      // AAC already in an MP4: rewrapped, not re-encoded, so nothing is lost
      // and there is nothing to say.
      name: 'AAC in MP4 (copy)',
      path: () => input('tone-1s.m4a', 'aac-in-mp4.m4a'),
      warning: null,
    },
    {
      name: 'AAC in a raw ADTS stream (copy + bitstream filter)',
      path: () => input('tone-1s.aac', 'adts.aac'),
      warning: null,
    },
    {
      name: 'cover art is not a video',
      path: () => input('tone-1s-cover.m4a', 'with-cover.m4a'),
      warning: null,
    },
    {
      name: 'ALAC in MP4 (MP4 family, but lossless — re-encoded)',
      path: () => input('tone-1s-alac.m4a', 'alac.m4a'),
      warning: /^alac 是无损格式/,
    },
    {
      name: 'MP3',
      path: () => input('tone-1s.mp3', 'plain.mp3'),
      warning: /^mp3 已重新编码/,
    },
    {
      name: 'FLAC',
      path: () => input('tone-1s.flac', 'lossless.flac'),
      warning: /^flac 是无损格式/,
    },
    {
      name: 'Vorbis in Ogg (stereo stays stereo)',
      path: () => input('tone-1s.ogg', 'vorbis.ogg'),
      warning: /^vorbis 已重新编码/,
      channels: 2,
    },
    {
      name: 'Opus in Ogg (48kHz stays 48kHz)',
      path: () => input('tone-1s.opus', 'opus.opus'),
      warning: /^opus 已重新编码/,
      sampleRate: 48_000,
    },
  ];

  it.each(CASES)(
    'imports $name',
    async ({ path, warning, channels, sampleRate }) => {
      const result = await importOne(path());

      expect(result.failed).toEqual([]);
      expect(result.imported).toHaveLength(1);
      const [entry] = result.imported;
      expect(entry.warnings).toEqual(warning === null ? [] : [expect.stringMatching(warning)]);

      // Whatever came in, one AAC-in-MP4 audio stream comes out.
      const probe = await landed(entry.song_id);
      expect(probe.codec).toBe('aac');
      expect(probe.container).toContain('mp4');
      expect(probe.audio_stream_count).toBe(1);
      expect(probe.has_attached_pic).toBe(false);
      expect(probe.duration).toBeGreaterThan(0.9);
      if (channels !== undefined) expect(probe.channels).toBe(channels);
      if (sampleRate !== undefined) expect(probe.sample_rate).toBe(sampleRate);

      // A user asset: cache eviction may never reclaim it (R1/R26).
      const song = getSong(db, sqlite, entry.song_id);
      expect(song).toMatchObject({ file_origin: 'imported', artist: '' });
      expect(song?.duration).toBeGreaterThan(0.9);
    },
    60_000,
  );

  // §4-a: the profile decodes a deliberate subset of PCM, and every member of
  // it has a real sample here rather than a promise in a comment.
  const PCM: WavSampleFormat[] = ['pcm_u8', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le'];

  it.each(PCM)(
    'imports WAV %s',
    async (format) => {
      const result = await importOne(wavInput(`${format}.wav`, format));

      expect(result.failed).toEqual([]);
      const [entry] = result.imported;
      expect(entry.warnings).toEqual([expect.stringMatching(/无损/)]);
      expect((await landed(entry.song_id)).codec).toBe('aac');
    },
    60_000,
  );

  it('takes the first audio track, and says it dropped the rest', async () => {
    const result = await importOne(input('tone-two-tracks.m4a', 'two-tracks.m4a'));

    const [entry] = result.imported;
    expect(entry.warnings).toEqual(['文件有 2 条音轨，只导入了第 1 条']);

    // The container declares 2s — the LONGER track. The row has to describe
    // the track that was kept, or the library claims a length its file
    // does not have.
    const probe = await landed(entry.song_id);
    expect(probe.duration).toBeLessThan(1.5);
    expect(getSong(db, sqlite, entry.song_id)?.duration).toBeLessThan(1.5);
  }, 60_000);

  it('lets the container decide, not the extension', async () => {
    // An AAC-in-MP4 wearing `.mp3`. Before 0.3.0 this was refused for lying
    // about itself; now it is simply an import that needs no re-encoding —
    // the probe knows what it is, and the extension never did.
    const result = await importOne(input('tone-1s.m4a', 'liar.mp3'));

    expect(result.failed).toEqual([]);
    expect(result.imported[0].warnings).toEqual([]);
    expect((await landed(result.imported[0].song_id)).codec).toBe('aac');
  }, 60_000);
});

// ─── Refused ───────────────────────────────────────────

describe('the files import refuses', () => {
  it('refuses a real video track, but not cover art', async () => {
    const result = await importOne(input('tone-1s-video.mp4', 'music-video.mp4'));

    expect(result.imported).toEqual([]);
    expect(result.failed[0].error_code).toBe('IMPORT_HAS_VIDEO');
    expect(result.failed[0].reason).toContain('视频');
    // Nothing half-created: the song directory is made before the conversion.
    expect(songDirs()).toEqual([]);
  }, 60_000);

  it('refuses a file with no audio stream at all', async () => {
    const result = await importOne(input('cover-only.m4a', 'just-a-picture.m4a'));

    expect(result.failed[0].error_code).toBe('IMPORT_NO_AUDIO');
    expect(songDirs()).toEqual([]);
  }, 60_000);

  it('refuses a codec the shipped ffmpeg cannot decode', async () => {
    // 64-bit float PCM: a real WAV, named by ffprobe, decodable by nothing in
    // the profile. Caught here so the user reads a sentence about the format
    // instead of ffmpeg's "no decoder found" two steps later.
    const result = await importOne(wavInput('f64.wav', 'pcm_f64le'));

    expect(result.failed[0].error_code).toBe('IMPORT_UNSUPPORTED_FORMAT');
    expect(result.failed[0].reason).toContain('pcm_f64le');
  }, 60_000);

  it('refuses an unsupported extension without probing it', async () => {
    const path = join(inputs, 'song.wma');
    writeFileSync(path, 'not audio at all');
    const result = await importOne(path);

    expect(result.failed[0].error_code).toBe('IMPORT_UNSUPPORTED_FORMAT');
    expect(result.failed[0].reason).toContain('.wma');
    // The cheap filter is the point: no directory, no child process.
    expect(songDirs()).toEqual([]);
    expect(mediaTools.noted).toHaveLength(1);
    expect(mediaTools.noted[0]).toBeInstanceOf(Error);
  });

  it('reports a file the tools cannot read as a tool failure', async () => {
    const path = join(inputs, 'junk.mp3');
    writeFileSync(path, '<html><body>404 Not Found</body></html>');
    const result = await importOne(path);

    expect(result.failed[0].error_code).toBe('FFMPEG_FAILED');
    // Found in acceptance: ffprobe names the file it was handed. That used to
    // be the staged copy inside the library — a path the user never saw.
    expect(result.failed[0].path).toBe(path);
    expect(result.failed[0].reason).not.toContain(songsDir());
  }, 60_000);

  it('reports a missing file per path instead of failing the batch', async () => {
    const good = input('tone-1s.m4a', 'survivor.m4a');
    const missing = join(inputs, `${randomUUID()}.mp3`);

    const result = await importSongs(store, mediaTools, [missing, good]);

    expect(result.failed).toEqual([
      { path: missing, reason: expect.any(String), error_code: 'FFMPEG_FAILED' },
    ]);
    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].name).toBe('survivor');
  }, 60_000);
});
