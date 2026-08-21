// The AudioLandingContract's second hook, plus the duration measurement the
// phone owes (N4b; criteria 7, 8, 10).
//
// `audio-landing.test.ts` said this was coming: the eight cases live in
// `portable/services/contract/audio-landing` so that the phone's native landing
// is held to the same promises as the desktop's ffmpeg one, through its own
// hook, without a case changing. Nothing in `cases.ts` changed.
//
// WHAT THE TRANSFER SEAM PROVES, AND WHAT IT DOES NOT. The four scenarios are
// driven through `MobileAudioLandingDeps.transfer` rather than over a real
// socket, because a phone has no local HTTP server to point at and Android
// forbids cleartext besides. So these cases exercise the landing PROTOCOL and
// its error normalisation — the six steps, the transaction, the atomic replace,
// and §2.2's mapping table — over a REAL library, REAL files and a REAL
// MediaMetadataRetriever. What they do not answer is how
// `File.downloadFileAsync` itself behaves against bilibili: criteria 5 and 6
// ask that, with the real network, and no seam in the way.
//
// The `valid` scenario copies real bilibili bytes rather than inventing some:
// case one asserts a duration greater than zero, and the only thing that can
// produce one is a file MMR can actually decode. Those bytes arrive through
// `just mobile-push-audio-fixtures`, together with the ffprobe reading criterion
// 8 compares against — a number the device is never asked to compute for
// itself.

import {
  type AudioLandingAttempt,
  type AudioLandingContractHooks,
  type AudioLandingOutcome,
  type AudioLandingPort,
  type AudioLandingSubject,
  AudioNotAacError,
  BilibiliApiError,
  CANONICAL_AUDIO_FILE,
  type ContractReport,
  type PortableDb,
  createFileBackedSongInTx,
  runAudioLandingContract,
  uuid,
  withTimeout,
} from '@lark/core/portable';
import { Directory, File } from 'expo-file-system';
import LarkMedia from '../../modules/lark-media';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { type AudioTransfer, createMobileAudioLanding } from '../ports/audio-landing';
import { recoveredSongsRoot, songDirectory, songsRoot } from '../ports/paths';
import { type ScenarioRow, resetInstall } from './d16';
import { fixtureDirectory } from './fixture-import';

// ─── the pushed audio fixtures ──────────────────────────

export interface AudioFixture {
  name: string;
  key: string;
  /** The video these bytes came from — criterion 6 downloads it again. */
  bvid?: string;
  bytes: number;
  /** ffprobe's reading, from the host. The number criterion 8 measures against. */
  durationSec: number;
  codec: string;
  container: string;
}

/** `<external files>/lark-fixture/audio/` — see `just mobile-push-audio-fixtures`. */
function audioFixtureDirectory(): Directory {
  return new Directory(fixtureDirectory(), 'audio');
}

export function audioFixtures(): AudioFixture[] {
  const manifest = new File(audioFixtureDirectory(), 'manifest.json');
  if (!manifest.exists) {
    throw new Error('no audio fixtures pushed — run `just mobile-push-audio-fixtures`');
  }
  const parsed = JSON.parse(manifest.textSync()) as { entries: AudioFixture[] };
  const missing = parsed.entries.filter(
    (entry) => !new File(audioFixtureDirectory(), entry.name).exists,
  );
  if (missing.length > 0) {
    throw new Error(`the manifest names files that are not here: ${missing.map((m) => m.name)}`);
  }
  return parsed.entries;
}

/** The short track (2:17) — big enough to be real audio, small enough to copy per case. */
function shortFixture(): File {
  const fixtures = audioFixtures();
  const short = fixtures.find((entry) => entry.key === 'short') ?? fixtures[0];
  if (short === undefined) throw new Error('the audio fixture manifest is empty');
  return new File(audioFixtureDirectory(), short.name);
}

// ─── the hook ───────────────────────────────────────────

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/**
 * The last error `classify` could not place, verbatim.
 *
 * `other` is a case failure by design, and the case can only say "expected
 * timed-out, got other" — which names the symptom and hides the cause. This
 * carries the cause out to the row, because the first time that case failed
 * here the obvious explanation (this platform's abort is not named
 * `AbortError`) turned out to be wrong, and passing the case by trusting the
 * scenario instead of the error would have bought the green without looking.
 */
let lastUnclassified: string | null = null;

/** Map this host's own exception onto the contract's vocabulary (§2.2). */
function classify(err: unknown, attempt: AudioLandingAttempt): AudioLandingOutcome {
  if (attempt.commitThrows === true) return 'commit-threw';
  if (err instanceof BilibiliApiError) return 'api-error';
  // The subject KNOWS whether it aborted the caller's signal, which is the only
  // thing that tells a cancel from a deadline: both arrive here as an abort.
  if (attempt.scenario === 'cancel') return 'cancelled';
  if (isAbortError(err)) return 'timed-out';
  lastUnclassified = describe(err);
  return 'other';
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function abortError(): Error {
  const err = new Error('The operation was aborted.');
  err.name = 'AbortError';
  return err;
}

/** What the seam does under each scenario. */
function transferFor(scenario: () => AudioLandingAttempt['scenario']): AudioTransfer {
  return async ({ destinationUri, onProgress, signal }) => {
    switch (scenario()) {
      case 'valid': {
        const source = shortFixture();
        onProgress(0, source.size);
        source.copySync(new File(destinationUri));
        onProgress(source.size, source.size);
        return;
      }
      case 'http-error':
        // What the native downloader does with a non-2xx: it rejects, with an
        // error of its own that is NOT an abort. The landing is what turns that
        // into a BilibiliApiError.
        throw new Error('HTTP 500');
      default:
        // 'timeout' and 'cancel' are the same transfer — one that never
        // finishes. Which signal ended it is the difference, and the landing
        // composes both into the one it hands here.
        //
        // It rejects with an AbortError OF ITS OWN rather than with
        // `signal.reason`, and that is not a shortcut: read synchronously
        // inside the abort listener, a composed signal's `reason` is
        // `undefined` on this runtime (the `abort shape` row measures it) — so
        // rejecting with it would hand the landing a bare `undefined` that no
        // real transfer produces. `File.downloadFileAsync` rejects with an
        // AbortError; so does this.
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
    }
  };
}

/** Which boot each live subject came from, so `close` can end it. */
const openBoots = new Map<AudioLandingSubject, BootResult>();

async function freshBoot(): Promise<BootResult> {
  await resetInstall();
  for (const stale of [songsRoot(), recoveredSongsRoot()]) {
    if (stale.exists) stale.delete();
  }
  return runBootSequence();
}

function subjectFor(boot: BootResult): AudioLandingSubject {
  let scenario: AudioLandingAttempt['scenario'] = 'valid';
  const landing = createMobileAudioLanding({
    store: boot.db,
    transfer: transferFor(() => scenario),
  });
  const audioFile = (id: string): File => new File(songDirectory(id), CANONICAL_AUDIO_FILE);

  return {
    newSongId: () => uuid(),
    hasAudio: (id) => landing.hasAudio(id),
    discardUncommitted: (id) => landing.discardUncommitted(id),

    placeExistingAudio: (id, marker) => {
      const directory = songDirectory(id);
      if (!directory.exists) directory.create({ intermediates: true });
      const file = audioFile(id);
      file.create({ overwrite: true });
      file.write(marker);
    },
    makeEmptyDir: (id) => {
      const directory = songDirectory(id);
      if (!directory.exists) directory.create({ intermediates: true });
    },
    readAudio: (id) => (audioFile(id).exists ? audioFile(id).textSync() : null),
    dirExists: (id) => songDirectory(id).exists,
    residue: (id) =>
      songDirectory(id).exists
        ? songDirectory(id)
            .list()
            .map((entry) => entry.name)
            .filter((name) => name.startsWith('.'))
        : [],

    land: (attempt) => {
      scenario = attempt.scenario;
      return driveLanding(boot.db, landing, attempt, {
        // Short, so the deadline case ends in well under a second rather than
        // in the fifteen minutes production allows a real transfer.
        timeoutMs: attempt.scenario === 'timeout' ? 300 : 60_000,
        isAac: true,
      });
    },
  };
}

interface DriveOptions {
  timeoutMs: number;
  isAac: boolean;
  /** Bytes the transfer should write instead of the whole fixture. */
  truncateTo?: number;
}

async function driveLanding(
  store: PortableDb,
  landing: AudioLandingPort,
  attempt: AudioLandingAttempt,
  options: DriveOptions,
): Promise<{
  outcome: AudioLandingOutcome;
  commitCalls: number;
  committedDuration: number | null;
}> {
  let commitCalls = 0;
  let committedDuration: number | null = null;
  const controller = new AbortController();
  if (attempt.scenario === 'cancel') {
    setTimeout(() => controller.abort(new Error('user cancelled')), 60);
  }

  try {
    await landing.land({
      taskId: uuid(),
      songId: attempt.songId,
      mode: attempt.mode,
      // The JS-stream description, which this host does not use — it takes the
      // `request` branch (decision a). Reaching it would be a bug, so it says so.
      openStream: () => Promise.reject(new Error('the phone lands through `request`')),
      request: {
        url: 'https://fixture.invalid/audio.m4a',
        headers: {},
        timeoutMs: options.timeoutMs,
      },
      expect: { codecs: 'mp4a.40.2', isAac: options.isAac, expectedDurationSeconds: null },
      reportStage: () => {},
      onProgress: () => {},
      signal: controller.signal,
      commit: ({ duration }) => {
        commitCalls += 1;
        committedDuration = duration;
        if (attempt.commitThrows === true) throw new Error('commit refused');
        // A real row, so the transaction the landing wraps is a real one and
        // `touchLastAccessed` has something to touch.
        createFileBackedSongInTx(store, {
          id: attempt.songId,
          name: 'contract',
          artist: '',
          duration,
          file_origin: 'downloaded',
          source_url: null,
          source_provider: null,
          source_key: null,
        });
      },
    });
    return { outcome: 'landed', commitCalls, committedDuration };
  } catch (err) {
    return { outcome: classify(err, attempt), commitCalls, committedDuration };
  }
}

const HOOKS: AudioLandingContractHooks = {
  async open(): Promise<AudioLandingSubject> {
    const boot = await freshBoot();
    const subject = subjectFor(boot);
    openBoots.set(subject, boot);
    return subject;
  },
  async close(subject: AudioLandingSubject): Promise<void> {
    openBoots.get(subject)?.handle.closeSync();
    openBoots.delete(subject);
  },
};

// ─── criterion 7: the two refusals ──────────────────────

/** ①: no encoder here, so a non-AAC stream is refused before a byte moves. */
async function refusesNonAac(): Promise<string> {
  const boot = await freshBoot();
  try {
    const id = uuid();
    let transfers = 0;
    const landing = createMobileAudioLanding({
      store: boot.db,
      transfer: async () => {
        transfers += 1;
      },
    });

    let thrown: unknown = null;
    try {
      await landing.land({
        taskId: uuid(),
        songId: id,
        mode: 'new',
        openStream: () => Promise.reject(new Error('unused')),
        request: { url: 'https://fixture.invalid/audio.m4a', headers: {}, timeoutMs: 60_000 },
        // The other half of D17: the desktop transcodes what is not AAC, and
        // this device says no. `codecs` is what bilibili called the stream.
        expect: { codecs: 'opus', isAac: false, expectedDurationSeconds: null },
        reportStage: () => {},
        onProgress: () => {},
        signal: new AbortController().signal,
        commit: () => {
          throw new Error('commit ran for a stream this device refuses');
        },
      });
    } catch (err) {
      thrown = err;
    }

    expect(
      thrown instanceof AudioNotAacError,
      `it threw ${describe(thrown)}, not AudioNotAacError`,
    );
    expect(transfers === 0, `the transfer ran ${transfers} times before the codec was judged`);
    expect(!songDirectory(id).exists, 'a directory was created for a stream we refuse');
    return `${describe(thrown)} · transfer never ran · no directory created`;
  } finally {
    boot.handle.closeSync();
  }
}

const describe = (err: unknown): string =>
  err instanceof Error ? `${err.name}: ${err.message}` : String(err);

/** ②: a transfer that arrives incomplete has no readable duration, so nothing commits. */
async function refusesUnreadable(bytes: number | 'empty'): Promise<string> {
  const boot = await freshBoot();
  try {
    const id = uuid();
    const source = shortFixture();
    const landing = createMobileAudioLanding({
      store: boot.db,
      transfer: async ({ destinationUri, onProgress }) => {
        const file = new File(destinationUri);
        file.create({ overwrite: true });
        if (bytes === 'empty') return;
        // A real truncated transfer announced a content-length and then stopped
        // short, which is exactly what ③b compares against. Reporting nothing
        // here would test a transfer no server performs.
        onProgress(bytes, source.size);
        file.write(source.bytesSync().slice(0, bytes));
      },
    });
    const report = await driveLanding(
      boot.db,
      landing,
      { scenario: 'valid', songId: id, mode: 'new' },
      { timeoutMs: 60_000, isAac: true },
    );

    // The one that matters: an incomplete download must not become a song.
    expect(report.commitCalls === 0, `commit ran ${report.commitCalls} times on a partial file`);
    expect(!new File(songDirectory(id), CANONICAL_AUDIO_FILE).exists, 'a canonical file was left');
    const residue = songDirectory(id).exists
      ? songDirectory(id)
          .list()
          .map((entry) => entry.name)
      : [];
    expect(residue.length === 0, `the directory still holds ${JSON.stringify(residue)}`);
    return `${bytes === 'empty' ? '0 bytes' : `${bytes} bytes`} · no commit · nothing left behind`;
  } finally {
    boot.handle.closeSync();
  }
}

/**
 * When a composed signal's `reason` becomes readable on THIS runtime.
 *
 * Not a judgement, a measurement, and it exists because the contract's timeout
 * case failed here for a reason nobody would have guessed: read SYNCHRONOUSLY
 * inside the `abort` listener, `AbortSignal.any([caller, timeout])` has a
 * `reason` of `undefined`; read one microtask later it is a proper AbortError.
 * Node makes both readings the same, so the desktop hook never had to know.
 *
 * Any code on this platform that classifies an abort by reading `reason` from
 * inside the listener gets `undefined`. Production does not — the native
 * transfer rejects with an error of its own — but that is a fact worth keeping
 * where the next person will find it.
 */
async function abortShape(): Promise<string> {
  const signal = withTimeout(50, new AbortController().signal);
  const inListener = await new Promise<unknown>((resolve) => {
    signal.addEventListener('abort', () => resolve(signal.reason), { once: true });
  });
  const afterAwait: unknown = signal.reason;
  const show = (value: unknown): string =>
    value instanceof Error ? `${value.name}` : `${typeof value} (${String(value)})`;
  return `inside the listener: ${show(inListener)} · a microtask later: ${show(afterAwait)}`;
}

// ─── criterion 8: MMR against ffprobe ───────────────────

async function durationsMatchFfprobe(): Promise<string> {
  const parts: string[] = [];
  for (const fixture of audioFixtures()) {
    const uri = new File(audioFixtureDirectory(), fixture.name).uri;
    const read = await LarkMedia.readDurationSeconds(uri);
    const delta = Math.abs(read - fixture.durationSec);
    expect(
      delta <= 1,
      `${fixture.key}: MMR ${read.toFixed(3)}s vs ffprobe ${fixture.durationSec.toFixed(3)}s ` +
        `— off by ${delta.toFixed(3)}s (decision b's fallback is B, the transient player, never C)`,
    );
    parts.push(`${fixture.key} ${read.toFixed(3)}s (Δ${delta.toFixed(3)}s)`);
  }
  return parts.join(' · ');
}

// ─── the suite ──────────────────────────────────────────

const SCENARIOS: { name: string; run: () => Promise<string> }[] = [
  { name: 'abort shape on this runtime', run: abortShape },
  { name: '8 · MMR reads what ffprobe read', run: durationsMatchFfprobe },
  { name: '7① · a non-AAC stream is refused before a byte', run: refusesNonAac },
  { name: '7② · an empty transfer never commits', run: () => refusesUnreadable('empty') },
  { name: '7② · a truncated transfer never commits', run: () => refusesUnreadable(64 * 1024) },
];

export async function runAudioLandingScenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  for (const { name, run } of SCENARIOS) {
    try {
      rows.push({ name, ok: true, detail: await run() });
    } catch (err) {
      rows.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }

  lastUnclassified = null;
  const report: ContractReport = {
    pass: (group, name) => rows.push({ name: `${group} · ${name}`, ok: true, detail: 'pass' }),
    fail: (group, name, error) =>
      rows.push({
        name: `${group} · ${name}`,
        ok: false,
        detail:
          describe(error) +
          (lastUnclassified === null ? '' : ` · unclassified was: ${lastUnclassified}`),
      }),
    // A skip reads as a failure: this host has no exemptions either, so a case
    // that did not run is a case nobody is watching.
    skip: (group, name, reason) =>
      rows.push({ name: `${group} · ${name}`, ok: false, detail: `skipped: ${reason}` }),
  };
  await runAudioLandingContract(HOOKS, report);

  await resetInstall();
  return rows;
}
