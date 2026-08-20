// The AudioLandingContract, driven against the desktop's ffmpeg landing (N4a).
//
// Its five commit / lifecycle cases were this file's own hand-written tests
// before N4; they now live in `portable/services/contract/audio-landing`, so
// the phone's native landing (N4b) is held to the SAME eight, through its own
// hook. What is desktop here is only the hook: a real `nodeAudioLanding`, a
// real bilibili client, and a tiny HTTP server the client actually fetches — so
// the three transfer cases exercise `openAudio`'s real error normalisation
// rather than a hand-thrown stand-in (§2.2).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabase } from '../db/index.js';
import { MediaToolsRegistry } from '../media-tools/registry.js';
import { resolveMediaTools } from '../media-tools/resolve.js';
import { songAudioPath, songDirPath } from '../paths.js';
import type { ContractReport } from '../portable/contract/types.js';
import { createBilibiliClient } from '../portable/download/bilibili.js';
import { DEFAULT_TIMEOUTS } from '../portable/download/timeouts.js';
import { BilibiliApiError } from '../portable/errors.js';
import { createFileBackedSongInTx } from '../portable/library/songs.js';
import { uuid } from '../portable/runtime/random.js';
import {
  type AudioLandingAttempt,
  type AudioLandingContractHooks,
  type AudioLandingOutcome,
  type AudioLandingSubject,
  runAudioLandingContract,
} from '../portable/services/contract/audio-landing/index.js';
import { toneWav } from '../testing/tone-wav.js';
import { nodeAudioLanding } from './audio-landing.js';

const nests: string[] = [];
const dbs: BetterSqlite3.Database[] = [];

// ─── Setup (top-level await, like the LibraryContract hook) ──

// Real audio, so ffmpeg has something it can genuinely transcode (M7 T0).
const audioFixture = toneWav(1);

const mediaOutcome = resolveMediaTools();
if (!mediaOutcome.ok) throw new Error(`no usable ffmpeg for the test run: ${mediaOutcome.detail}`);
const mediaTools = new MediaToolsRegistry();
const probe = await mediaTools.refresh();
if (probe.state !== 'ready') {
  throw new Error(`no usable ffmpeg for the test run (${probe.state}): ${probe.detail}`);
}

// A server the real client fetches: the buvid endpoint `openAudio` warms, a
// good track, a 5xx, and one that sends headers then hangs.
const server = createServer((req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  if (path === '/x/frontend/finger/spi') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { b_3: 'B3', b_4: 'B4' } }));
    return;
  }
  if (path === '/ok') {
    res.writeHead(200, {
      'content-type': 'audio/mp4',
      'content-length': String(audioFixture.length),
    });
    res.end(audioFixture);
    return;
  }
  if (path === '/500') {
    res.writeHead(500);
    res.end('nope');
    return;
  }
  if (path === '/hang') {
    // Headers, then one chunk, then nothing — a transfer that stalls mid-body,
    // ended only by its deadline or the caller's abort.
    res.writeHead(200, { 'content-type': 'audio/mp4' });
    res.write(audioFixture.subarray(0, 8));
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const client = createBilibiliClient({ apiBase: base, timeouts: DEFAULT_TIMEOUTS });
// A short whole-transfer deadline, so the timeout case ends in well under a
// second rather than the default five minutes.
const fastClient = createBilibiliClient({
  apiBase: base,
  timeouts: { ...DEFAULT_TIMEOUTS, audioStream: 500 },
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
  for (const db of dbs) db.close();
  for (const nest of nests) rmSync(nest, { recursive: true, force: true });
});

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** Map the host's own exception onto the contract's vocabulary (§2.2). */
function classify(err: unknown, attempt: AudioLandingAttempt): AudioLandingOutcome {
  if (attempt.commitThrows === true) return 'commit-threw';
  if (err instanceof BilibiliApiError) return 'api-error';
  // The subject KNOWS whether it aborted the caller signal, which is what tells
  // a cancel apart from a deadline — both arrive here as an abort.
  if (attempt.scenario === 'cancel') return 'cancelled';
  if (isAbort(err)) return 'timed-out';
  return 'other';
}

function makeSubject(): AudioLandingSubject {
  const nest = mkdtempSync(join(tmpdir(), 'lark-landing-contract-'));
  nests.push(nest);
  process.env.LARK_NEST_DIR = nest;
  const { sqlite, portable: store } = createDatabase({ dbPath: ':memory:' });
  dbs.push(sqlite);
  const landing = nodeAudioLanding({ store, mediaTools, timeouts: DEFAULT_TIMEOUTS });

  return {
    newSongId: () => uuid(),
    hasAudio: (id) => landing.hasAudio(id),
    discardUncommitted: (id) => landing.discardUncommitted(id),
    placeExistingAudio: (id, marker) => {
      mkdirSync(songDirPath(id), { recursive: true });
      writeFileSync(songAudioPath(id), marker);
    },
    makeEmptyDir: (id) => {
      mkdirSync(songDirPath(id), { recursive: true });
    },
    readAudio: (id) => {
      try {
        return readFileSync(songAudioPath(id), 'utf-8');
      } catch {
        return null;
      }
    },
    dirExists: (id) => existsSync(songDirPath(id)),
    residue: (id) => {
      try {
        return readdirSync(songDirPath(id)).filter((name) => name.startsWith('.'));
      } catch {
        return [];
      }
    },

    async land(attempt) {
      let commitCalls = 0;
      let committedDuration: number | null = null;
      const controller = new AbortController();
      const c = attempt.scenario === 'timeout' ? fastClient : client;
      const url =
        attempt.scenario === 'http-error'
          ? `${base}/500`
          : attempt.scenario === 'timeout' || attempt.scenario === 'cancel'
            ? `${base}/hang`
            : `${base}/ok`;
      if (attempt.scenario === 'cancel') {
        setTimeout(() => controller.abort(new Error('user cancelled')), 60);
      }
      try {
        await landing.land({
          taskId: uuid(),
          songId: attempt.songId,
          mode: attempt.mode,
          openStream: (signal) => c.openAudio(url, { signal }),
          request: { url, headers: {}, timeoutMs: 60_000 },
          expect: { codecs: 'mp4a.40.2', isAac: true, expectedDurationSeconds: null },
          reportStage: () => {},
          onProgress: () => {},
          commit: ({ duration }) => {
            commitCalls += 1;
            committedDuration = duration;
            if (attempt.commitThrows === true) throw new Error('commit refused');
            // A real commit writes the row, so the transaction the landing
            // wraps is a real one (the row's `last_accessed_at` rides with it).
            createFileBackedSongInTx(store, {
              id: attempt.songId,
              name: 'x',
              artist: '',
              duration,
              file_origin: 'downloaded',
              source_url: null,
              source_provider: null,
              source_key: null,
            });
          },
          signal: controller.signal,
        });
        return { outcome: 'landed', commitCalls, committedDuration };
      } catch (err) {
        return { outcome: classify(err, attempt), commitCalls, committedDuration };
      }
    },
  };
}

const HOOKS: AudioLandingContractHooks = {
  open: () => Promise.resolve(makeSubject()),
  close: () => Promise.resolve(),
};

interface Result {
  group: string;
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

const results: Result[] = [];
const report: ContractReport = {
  pass: (group, name) => results.push({ group, name, status: 'pass' }),
  fail: (group, name, error) =>
    results.push({
      group,
      name,
      status: 'fail',
      detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    }),
  skip: (group, name, reason) => results.push({ group, name, status: 'skip', detail: reason }),
};

await runAudioLandingContract(HOOKS, report);

describe('audio landing contract (desktop hook)', () => {
  it('ran every case', () => {
    expect(results.length).toBe(8);
  });

  // A skip reads as a failure: this host has no exemptions, so a case that did
  // not run is a case nobody is watching.
  it.each(results.map((r) => [`${r.group} · ${r.name}`, r] as const))('%s', (_name, result) => {
    expect(result.status === 'pass' ? 'pass' : (result.detail ?? result.status)).toBe('pass');
  });
});
