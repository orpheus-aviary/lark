// The engine on the phone, with the real network in front of it (criteria 5, 6
// and 14).
//
// Everything else in this directory can run with no signal. These three cannot,
// and that is the point: `audio-landing.ts` proves the landing protocol behind
// a transfer seam, and what is left over — whether the bytes bilibili serves
// this device can be reached at all, and whether a whole download lands as a
// playable song — is exactly what a seam cannot answer.
//
// CRITERION 5 CAME FIRST, AND ITS PREMISE IS NOW GONE (N5b). It was written
// because N0b-4a and N1i both pulled audio over mobile data from an mcdn node
// on `:8082` while running the SPIKE's build, which sets
// `usesCleartextTraffic: true` — and the product did not. The failure it
// guarded against was the nastiest shape available: every download works on
// Wi-Fi and every download fails on 4G.
//
// The product now sets it too (master plan §4.3, Stage-4, 2026-08-25 — mobile
// sync accepts a plaintext server, and Android has no way to permit that for
// one host chosen at run time). So be honest about what these two rows are
// still worth:
//
//   ① streamSchemeIsHttps STILL MEANS SOMETHING. It is no longer a gate — a
//      cleartext stream would now be fetched rather than blocked — but it is
//      the only place that reports WHICH scheme this device was handed, and
//      the user accepted plaintext audio knowingly (N5 subplan §0.1), not
//      unknowingly.
//   ② streamIsReachable NO LONGER PROVES THE CLEARTEXT HALF. It used to
//      answer "and can the product's own configuration actually reach it";
//      the configuration it asks that of now permits everything, so what
//      survives is only "the bytes are there".
//
// Neither row is deleted. A criterion that stopped proving one of its two
// halves is worth keeping as a measurement — quietly dropping it is how the
// next person concludes the guarantee is still in place.
//
// RUN IT ON BOTH NETWORKS. playurl picks a CDN node by the CALLER's IP, so a
// Wi-Fi answer says nothing about mobile data — that is not a guess, it is
// N0b-4a's measurement (a stream signed on home broadband was unreachable from
// 5G on the same phone).

import {
  type ClaimToken,
  FileEffectRuntime,
  type PortableDb,
  createBilibiliClient,
  createFileBackedSongInTx,
  preflightSingle,
  resolveOne,
  uuid,
} from '@lark/core/portable';
import type { DownloadTaskData } from '@lark/shared';
import { File } from 'expo-file-system';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { createDownloadRuntime } from '../downloads/engine';
import { downloads } from '../downloads/hub';
import { recoveredSongsRoot, songDirectory, songsRoot } from '../ports/paths';
import { createSongFiles } from '../ports/song-files';
import { createLibrary } from '../services/library';
import { audioFixtures } from './audio-landing';
import { type ScenarioRow, resetInstall } from './d16';

const client = createBilibiliClient();

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * The video criterion 6 downloads, and the ffprobe reading it is measured
 * against. Criterion 29 borrows it too — one known-good bvid rather than two.
 */
export function subjectVideo(): { bvid: string; durationSec: number } {
  const short = audioFixtures().find((entry) => entry.key === 'short');
  if (short === undefined) throw new Error('no `short` entry in the audio fixture manifest');
  if (short.bvid === undefined) {
    throw new Error(
      'the manifest predates the bvid field — re-run `just mobile-push-audio-fixtures`',
    );
  }
  return { bvid: short.bvid, durationSec: short.durationSec };
}

async function freshBoot(): Promise<BootResult> {
  await resetInstall();
  for (const stale of [songsRoot(), recoveredSongsRoot()]) {
    if (stale.exists) stale.delete();
  }
  return runBootSequence();
}

/**
 * Wait for one task to reach a terminal state, THROUGH THE HUB.
 *
 * Polling the engine would be shorter and would prove less: the hub is what
 * every screen from N4c on reads, and it only ever learns anything through the
 * callbacks the engine was constructed with. If a callback is not wired, this
 * hangs — which is the correct answer to "does the hub see downloads".
 */
export function awaitTask(taskId: string, timeoutMs = 180_000): Promise<DownloadTaskData> {
  return new Promise((resolve, reject) => {
    const find = (): DownloadTaskData | undefined =>
      downloads.getState().tasks.find((task) => task.id === taskId);
    const settled = (task: DownloadTaskData | undefined): boolean =>
      task !== undefined && ['succeeded', 'failed', 'cancelled'].includes(task.state);

    const timer = setTimeout(() => {
      unsubscribe();
      const task = find();
      reject(
        new Error(`task ${taskId} was still ${task?.state ?? 'unknown'} after ${timeoutMs}ms`),
      );
    }, timeoutMs);
    const done = (task: DownloadTaskData): void => {
      clearTimeout(timer);
      unsubscribe();
      resolve(task);
    };
    const unsubscribe = downloads.subscribe(() => {
      const task = find();
      if (settled(task)) done(task as DownloadTaskData);
    });
    const now = find();
    if (settled(now)) done(now as DownloadTaskData);
  });
}

// ─── criterion 5: what scheme does this device get? ─────

interface StreamProbe {
  scheme: string;
  host: string;
  codecs: string;
  isAac: boolean;
  url: string;
  headers: Record<string, string>;
}

let probed: StreamProbe | null = null;

async function probeStream(): Promise<StreamProbe> {
  const { bvid } = subjectVideo();
  const pages = await client.pagelist(bvid);
  const first = pages[0];
  if (first === undefined) throw new Error(`${bvid} has no parts`);
  // The client's own selection rule — AAC first, then bandwidth — because what
  // matters is the stream this app would REALLY download, not any stream.
  const stream = await client.audioStream(bvid, first.cid);
  const request = await client.describeAudioRequest(stream.url);
  const url = new URL(stream.url);
  probed = {
    scheme: url.protocol,
    host: url.host,
    codecs: stream.codecs,
    isAac: stream.isAac,
    url: stream.url,
    headers: request.headers,
  };
  return probed;
}

/** ①: the fact itself. Red here is a decision to make (§1.3's three ways out). */
async function streamSchemeIsHttps(): Promise<string> {
  const probe = probed ?? (await probeStream());
  const summary = `${probe.scheme}//${probe.host} · ${probe.codecs} · isAac=${probe.isAac}`;
  // Red here is a REPORT, not a blocker, since N5b: the blanket
  // `usesCleartextTraffic` decision h refused is the one the product now
  // ships (master plan §4.3, Stage-4), so a cleartext stream downloads fine.
  // What is left to decide if this goes red is whether to prefer an https
  // candidate inside the same codec (`backupUrl`, which the client still does
  // not read) — a quality choice about somebody's mobile data, no longer a
  // question of whether the feature works at all.
  expect(probe.scheme === 'https:', `${summary} — cleartext`);
  return summary;
}

/** ②: and whether the bytes are actually there (the cleartext half died in N5b). */
async function streamIsReachable(): Promise<string> {
  const probe = probed ?? (await probeStream());
  const response = await fetch(probe.url, {
    headers: { ...probe.headers, Range: 'bytes=0-1023' },
  });
  const body = await response.arrayBuffer();
  expect(
    response.status === 206 || response.status === 200,
    `${probe.host} answered ${response.status}`,
  );
  expect(body.byteLength > 0, `${probe.host} answered ${response.status} with no bytes`);
  // `content-range` on a 206 carries the WHOLE size (`bytes 0-1023/3690190`),
  // which is the question behind ③b and behind any progress bar: does this node
  // tell a client how big the file is, or does it not?
  return (
    `${probe.scheme}//${probe.host} → ${response.status} · ` +
    `${response.headers.get('content-type') ?? 'no content-type'} · ${body.byteLength} bytes · ` +
    `content-range ${response.headers.get('content-range') ?? 'absent'} · ` +
    `content-length ${response.headers.get('content-length') ?? 'absent'}`
  );
}

// ─── criterion 6: a real download, end to end ───────────

async function downloadsARealSong(): Promise<string> {
  const { bvid, durationSec } = subjectVideo();
  const boot = await freshBoot();
  // The library is NOT reset afterwards, unlike everywhere else here: this is
  // the one scenario whose product is a song, and "does it play" is answered by
  // installing the release build over this and pressing play. The handle still
  // closes — the rows and the file are on disk either way, and expo-sqlite
  // caches open databases by name (N2f).
  // What the NATIVE downloader reports while it works. `total_bytes` on the
  // task turning out to be null is either "the node declares no size" or "this
  // API never calls back at all", and ③b plus every progress bar N4d draws
  // depend on which.
  let progressCalls = 0;
  let lastProgress = 'never called';
  const { engine, fileOps } = createDownloadRuntime(boot, {
    transfer: async (args) => {
      const { nativeAudioTransfer } = await import('../ports/audio-landing');
      return nativeAudioTransfer({
        ...args,
        onProgress: (received, total) => {
          progressCalls += 1;
          lastProgress = `${received}/${total ?? 'null'}`;
          args.onProgress(received, total);
        },
      });
    },
  });
  const library = createLibrary(boot, fileOps);

  const item = await resolveOne(client, `https://www.bilibili.com/video/${bvid}`);
  const target = await preflightSingle({ client, hasLlm: false }, item, 'original');
  const queued = engine.enqueueDownload({ target, playlistIds: [] });
  const task = await awaitTask(queued.id);

  expect(
    task.state === 'succeeded',
    `the task ${task.state}: ${task.error_code ?? ''} ${task.error_message ?? ''}`,
  );
  const songId = task.result?.song_id;
  expect(songId !== undefined, 'a succeeded download named no song');
  const song = library.getSong(songId as string);

  expect(song.has_file === true, 'the library says the song has no file');
  expect(new File(songDirectory(song.id), 'song.m4a').exists, 'song.m4a is not on disk');
  expect(song.file_origin === 'downloaded', `file_origin is ${song.file_origin}`);
  expect(song.source_provider === 'bilibili', `source_provider is ${song.source_provider}`);
  expect(
    (song.source_key ?? '').startsWith(`${bvid}:`),
    `source_key is ${song.source_key}, expected ${bvid}:<cid>`,
  );
  // The desktop's ffprobe reading of the same part (`just
  // mobile-push-audio-fixtures`), not a number this device produced.
  const delta = Math.abs(song.duration - durationSec);
  expect(
    delta <= 1,
    `duration ${song.duration}s vs ffprobe ${durationSec}s — off by ${delta.toFixed(3)}s`,
  );

  // The lyrics leg runs as its own task after the commit point. It is judged on
  // having RUN, not on having found something: not every video has lyrics
  // anywhere, and failing the download for that would be wrong.
  const lyricsTask = downloads
    .getState()
    .tasks.find((entry) => entry.kind === 'lyrics' && entry.song_id === song.id);
  const lyrics = lyricsTask === undefined ? null : (await awaitTask(lyricsTask.id, 60_000)).state;
  const lrc = await library.readLyrics(song.id);

  boot.handle.closeSync();
  return (
    `${song.name} · ${song.duration}s (Δ${delta.toFixed(3)}s) · ${song.source_key} · ` +
    // Whether the completeness gate (③b) is ARMED on a real transfer: it can
    // only compare against a total the source declared, and `null` here would
    // mean the guard that criterion 7② bought is inert in production.
    // The task's own `total_bytes` is deliberately NOT quoted here: the engine
    // zeroes progress on every stage change (`engine.ts` `#resetProgress`), and
    // the landing enters `saving` after the transfer — so a terminal task
    // always reports null and says nothing about whether ③b had a total to
    // compare against. What the native downloader reported does say.
    `native progress ×${progressCalls}, last ${lastProgress} · ` +
    `lyrics task ${lyrics ?? 'never queued'} · ${lrc === null ? 'no lrc' : `${lrc.length} chars of lrc`}`
  );
}

// ─── criterion 14: one claim registry, or two ───────────

/**
 * A song whose files exist and whose row is about to be deleted while something
 * else holds its `file` claim.
 *
 * The claim is taken on `engine.claims` directly rather than by starting a real
 * download, and the reason is what the criterion is actually about: whether the
 * journal runtime the LIBRARY was given arbitrates against the ENGINE's
 * registry. A real in-flight download would take the same claim from the same
 * registry — and would also need the network, a stream and a stopwatch to hold
 * the window open.
 */
async function claimsAreShared(): Promise<string> {
  const boot = await freshBoot();
  try {
    const { engine, fileOps } = createDownloadRuntime(boot);
    const library = createLibrary(boot, fileOps);
    const busy = seedSongWithFile(boot.db, 'being downloaded');
    const free = seedSongWithFile(boot.db, 'not being downloaded');

    const held: ClaimToken = engine.claims.acquire(busy, 'file', 'acceptance-download');
    try {
      // The row goes — the user asked for that and it is a database decision.
      // What must NOT happen is the directory going while a download writes it.
      await library.deleteSong(busy);
      expect(songDirectory(busy).exists, 'the files went while the download still held them');
      expect(pendingOps(boot.db, busy) === 1, 'the delete did not stay in the journal');

      await library.deleteSong(free);
      expect(!songDirectory(free).exists, 'an unclaimed song was not deleted');
    } finally {
      engine.claims.release(held);
    }

    // And once the download lets go, the deferred delete completes.
    await fileOps.drain();
    expect(!songDirectory(busy).exists, 'the delete never resumed after the claim was released');
    expect(pendingOps(boot.db, busy) === 0, 'the journal still holds the resumed op');
    return 'row deleted · files kept while claimed · resumed on release · other songs unaffected';
  } finally {
    boot.handle.closeSync();
  }
}

/** The counter-test, run rather than argued: a runtime with a registry of its own. */
async function withoutSharingTheFilesGo(): Promise<string> {
  const boot = await freshBoot();
  try {
    const { engine } = createDownloadRuntime(boot);
    // A FRESH registry — what the boot runtime has, and what the library would
    // have kept if `downloads/engine.ts` had not rebuilt it (N4b-4).
    const library = createLibrary(
      boot,
      new FileEffectRuntime({
        sqlite: boot.db.sqlite,
        files: boot.files,
        songFiles: createSongFiles(),
      }),
    );
    const busy = seedSongWithFile(boot.db, 'being downloaded');

    const held = engine.claims.acquire(busy, 'file', 'acceptance-download');
    try {
      await library.deleteSong(busy);
      expect(
        !songDirectory(busy).exists,
        'the unshared runtime ALSO deferred — then the scenario above proves nothing',
      );
    } finally {
      engine.claims.release(held);
    }
    return 'two registries · the files went out from under the download · the guard is real';
  } finally {
    boot.handle.closeSync();
  }
}

function seedSongWithFile(store: PortableDb, name: string): string {
  const id = uuid();
  store.sqlite
    .transaction(() => {
      createFileBackedSongInTx(store, {
        id,
        name,
        artist: '',
        duration: 1,
        file_origin: 'downloaded',
        source_url: null,
        source_provider: null,
        source_key: null,
      });
    })
    .immediate();
  const directory = songDirectory(id);
  if (!directory.exists) directory.create({ intermediates: true });
  const audio = new File(directory, 'song.m4a');
  audio.create({ overwrite: true });
  audio.write('audio');
  return id;
}

const pendingOps = (store: PortableDb, songId: string): number =>
  (
    store.sqlite
      .prepare('SELECT count(*) AS n FROM sync_file_ops WHERE song_id = ?')
      .get(songId) as {
      n: number;
    }
  ).n;

// ─── the suite ──────────────────────────────────────────

const SCENARIOS: { name: string; run: () => Promise<string> }[] = [
  { name: '5 · the stream this device is given is https', run: streamSchemeIsHttps },
  { name: '5 · and the product build can read bytes from it', run: streamIsReachable },
  { name: '14 · one registry: the files wait for the download', run: claimsAreShared },
  { name: '14 · counter-test: two registries, the files go', run: withoutSharingTheFilesGo },
  // Last, and the library it leaves behind is the point (see the scenario).
  { name: '6 · a real bilibili video becomes a song', run: downloadsARealSong },
];

export async function runDownloadScenarios(): Promise<ScenarioRow[]> {
  // Forget the last run's probe. The whole point of criterion 5 is running this
  // once per network, and a cached answer from the other one would be the exact
  // wrong thing to show.
  probed = null;
  const rows: ScenarioRow[] = [];
  for (const { name, run } of SCENARIOS) {
    try {
      rows.push({ name, ok: true, detail: await run() });
    } catch (err) {
      rows.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  // NO `resetInstall()` here, unlike every other suite: criterion 6's song is
  // meant to survive, so the release build can be installed over this and asked
  // to play it.
  return rows;
}
