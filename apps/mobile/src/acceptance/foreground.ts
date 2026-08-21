// Criterion 15 and its counter-test: a long download with the screen off.
//
// This is the one question that had to be answered before the state machine was
// written (subplan §1.6). `File.downloadFileAsync` transfers on a native thread,
// so in theory a frozen JS thread cannot stop it — but if Expo's implementation
// hands each chunk to JS and waits, then JS freezing IS the transfer stopping,
// and the whole shape of N4c changes (decision j's wake lock flips).
//
// THREE BUTTONS, because it is three processes' worth of state and one of them
// might not survive:
//
//   Arm (service)    starts the FGS, enqueues the 37-minute track, PARKS
//   Arm (no service) the same download with nothing holding the process up —
//                    the counter-test, because if THIS one also finishes then
//                    criterion 15 proved nothing about the service
//   Check            what became of it, answered from disk as well as from
//                    memory, so "the process died" is a reportable outcome
//                    rather than a crash
//
// EVERY NUMBER THAT MATTERS IS THE HOST'S (subplan §1.5). Screen-off freezes JS
// timers and `performance.now()` does not advance through deep sleep, so what
// this reports about progress is not evidence. The file's final size, the row,
// and `dumpsys activity services` are.

import {
  type DownloadEngine,
  type PortableDb,
  createBilibiliClient,
  preflightSingle,
  resolveOne,
} from '@lark/core/portable';
import { File } from 'expo-file-system';
import { AppState } from 'react-native';
import LarkTransfer from '../../modules/lark-transfer';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { createDownloadRuntime } from '../downloads/engine';
import type {
  ForegroundController,
  ForegroundPhase,
  ForegroundService,
} from '../downloads/foreground';
import { downloads } from '../downloads/hub';
import { type PlayerDriver, createPlayerDriver } from '../player/driver';
import { recoveredSongsRoot, songDirectory, songsRoot } from '../ports/paths';
import { audioFixtures, shortFixture } from './audio-landing';
import { type ScenarioRow, resetInstall } from './d16';
import { awaitTask } from './downloads';

const client = createBilibiliClient();

/** The run in flight, if this process is still the one that started it. */
let run: { boot: BootResult; taskId: string; withService: boolean; expected: number } | null = null;

/** The 37-minute track and the size it has to reach. */
function longFixture(): { bvid: string; bytes: number } {
  const long = audioFixtures().find((entry) => entry.key === 'long');
  if (long?.bvid === undefined) {
    throw new Error('no `long` entry with a bvid — run `just mobile-push-audio-fixtures`');
  }
  return { bvid: long.bvid, bytes: long.bytes };
}

const landedBytes = (songId: string): number => new File(songDirectory(songId), 'song.m4a').size;

async function arm(withService: boolean): Promise<ScenarioRow[]> {
  const { bvid, bytes } = longFixture();
  const boot = await runBootSequence();
  const { engine } = createDownloadRuntime(boot);

  if (withService) {
    // Started HERE, from the foreground, before any network work — which is
    // the whole point of the `arming` state (§2.4). The real UI will do the
    // same thing from the download button.
    await LarkTransfer.start('lark', '正在下载 1 首');
  }

  // `?p=1` is not decoration: BV1LtgV6ZE2U has two parts, and a multi-part link
  // with no page and no LLM is refused by the preflight — `LlmNotConfiguredError`,
  // "这个视频有 2 个分P". That refusal is the extracted gate working (N4a), and
  // N0b's fixture is p1, so the page belongs in the link.
  const item = await resolveOne(client, `https://www.bilibili.com/video/${bvid}?p=1`);
  const target = await preflightSingle({ client, hasLlm: false }, item, 'original');
  const task = engine.enqueueDownload({ target, playlistIds: [] });
  run = { boot, taskId: task.id, withService, expected: bytes };

  return [
    {
      name: `15 · armed ${withService ? 'WITH' : 'WITHOUT'} the service`,
      ok: true,
      detail: `${bvid} · ${(bytes / 1e6).toFixed(1)}MB · task ${task.id.slice(0, 8)} · screen off now, wait, then wake and tap "Check long download"`,
    },
  ];
}

export const armLongDownloadWithService = (): Promise<ScenarioRow[]> => arm(true);
export const armLongDownloadWithoutService = (): Promise<ScenarioRow[]> => arm(false);

export async function checkLongDownload(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  const service = await LarkTransfer.isRunning();

  if (run === null) {
    // The process did not survive. That is an ANSWER, not an error — and for
    // the no-service arm it is the expected one.
    const boot = await runBootSequence();
    try {
      rows.push({
        name: '15 · the process did not survive',
        ok: true,
        detail: `${describeLibrary(boot.db)} · service running: ${service}`,
      });
    } finally {
      boot.handle.closeSync();
    }
    return rows;
  }

  const { boot, taskId, withService, expected } = run;
  const task = downloads.getState().tasks.find((entry) => entry.id === taskId);
  const songId = task?.song_id ?? task?.result?.song_id ?? null;
  const landed = songId === null ? 0 : landedBytes(songId);

  const failure =
    task?.error_code === null || task?.error_code === undefined ? '' : ` (${task.error_code})`;
  rows.push({
    name: `15 · ${withService ? 'with' : 'without'} the service, after the screen was off`,
    ok: task?.state === 'succeeded' && landed === expected,
    detail: `task ${task?.state ?? 'gone from the hub'}${failure} · landed ${landed} of ${expected} bytes · service running: ${service} · ${describeLibrary(boot.db)}`,
  });
  return rows;
}

/** What the library says, which survives the process and the hub both. */
function describeLibrary(db: PortableDb): string {
  const row = db.sqlite
    .prepare('SELECT name, duration FROM songs ORDER BY created_at DESC LIMIT 1')
    .get() as { name: string; duration: number } | undefined;
  return row === undefined ? 'no rows' : `row: ${row.name} ${row.duration}s`;
}

/** Let go of the run and the service, whatever state they are in. */
export async function releaseLongDownload(): Promise<ScenarioRow[]> {
  await LarkTransfer.stop();
  if (run !== null) {
    run.boot.handle.closeSync();
    run = null;
  }
  return [
    {
      name: '15 · released',
      ok: !(await LarkTransfer.isRunning()),
      detail: 'service stopped, library closed',
    },
  ];
}

// ─── N4c-3: the state machine, on the device ────────────
//
// The unit tests own everything about `downloads/foreground.ts` that is
// arithmetic and ordering (`foreground.test.ts`). What is left is the half only
// Android answers, and every one of these scenarios exists because of a
// sentence in the criteria that starts with the system rather than with us:
//
//   17①  is a service started at the GESTURE actually accepted — and is it
//        still up seconds later, while a preflight would be running?
//   17②  does it survive its last task by the grace and then really go?
//   17③  when a start is refused, does the download still finish?
//   21   is a stopped service stopped as far as the SYSTEM is concerned?
//   22   can two foreground services of two different types coexist?
//
// EVERY ROW HERE IS THE APP'S OWN ACCOUNT and the host checks the same facts
// independently — `dumpsys activity services com.orpheusaviary.lark` for the
// services, the notification shade for the notifications. Where the two
// disagree the host wins; `isRunning()` is a flag this process sets, and a
// flag can be wrong in exactly the way a criterion is trying to catch.

/** Long enough for a person holding a phone to run two adb commands. */
const PARK_MS = 25_000;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const activeTasks = (): number =>
  downloads.getState().tasks.filter((task) => task.state === 'queued' || task.state === 'running')
    .length;

const phase = (): ForegroundPhase => downloads.getState().foreground.phase;

/**
 * Poll until the service is up, or give up.
 *
 * `start()` resolving means the system ACCEPTED the request;
 * `startForegroundService` returns before the service has run a line, and the
 * flag is set inside `onStartCommand` (`modules/lark-transfer/index.ts`). A
 * single read straight afterwards would be a coin toss.
 */
async function serviceUp(withinMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (await LarkTransfer.isRunning()) return true;
    await wait(100);
  }
  return false;
}

/** Wait until nothing is queued or running — the lyrics task included. */
async function quiet(timeoutMs = 300_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (activeTasks() > 0) {
    if (Date.now() > deadline) throw new Error(`${activeTasks()} tasks still active`);
    await wait(100);
  }
}

function fixtureLink(key: 'short' | 'long'): string {
  const entry = audioFixtures().find((candidate) => candidate.key === key);
  if (entry?.bvid === undefined) {
    throw new Error(`no \`${key}\` entry with a bvid — run \`just mobile-push-audio-fixtures\``);
  }
  // `?p=1` on the long one is not decoration — it has two parts, and a
  // multi-part link with no model is refused up front (N4b).
  return `https://www.bilibili.com/video/${entry.bvid}${key === 'long' ? '?p=1' : ''}`;
}

async function enqueueOne(engine: DownloadEngine, link: string): Promise<string> {
  const item = await resolveOne(client, link);
  const target = await preflightSingle({ client, hasLlm: false }, item, 'original');
  return engine.enqueueDownload({ target, playlistIds: [] }).id;
}

/**
 * Criterion 17① and ②, in one run, because they are one timeline.
 *
 * The park in the middle is where the preflight would be: nothing is enqueued,
 * the app is doing nothing at all, and the service has to be up anyway. That is
 * the whole claim of `arming` — and the counter-test for it is not a code edit
 * but the scenario below, which arms from the background and is refused.
 */
export async function armForegroundParked(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  const boot = await runBootSequence();
  const { engine, foreground } = createDownloadRuntime(boot);
  try {
    // The permission dialog appears HERE on a fresh install, and this await
    // does not return until it is answered (criterion 19).
    await foreground.arm();
    const upAtGesture = await serviceUp();
    const armed = phase();
    const enqueued = activeTasks();
    rows.push({
      name: '17① · up at the gesture, with nothing enqueued',
      ok: upAtGesture && armed === 'arming' && enqueued === 0,
      detail: `phase ${armed} · service running ${upAtGesture} · ${enqueued} active tasks · parking ${PARK_MS / 1000}s — dumpsys now`,
    });

    await wait(PARK_MS);
    const upThroughPreflight = await LarkTransfer.isRunning();
    rows.push({
      name: '17① · still up through what would be the preflight',
      ok: upThroughPreflight && phase() === 'arming',
      detail: `phase ${phase()} · service running ${upThroughPreflight} after ${PARK_MS / 1000}s of nothing`,
    });

    const taskId = await enqueueOne(engine, fixtureLink('short'));
    foreground.settle();
    const working = phase();
    rows.push({
      name: '17 · running once something is enqueued',
      ok: working === 'running',
      detail: `phase ${working} · ${activeTasks()} active`,
    });

    const task = await awaitTask(taskId);
    await quiet();
    // From here the grace is counting. Both samples matter: the first says it
    // did not stop the instant the queue emptied, the second says it did stop.
    await wait(1_000);
    const heldThroughGrace = await LarkTransfer.isRunning();
    await wait(2_500);
    const stopped = !(await LarkTransfer.isRunning());
    rows.push({
      name: '17② · outlives its last task by the grace, then goes',
      ok: heldThroughGrace && stopped && phase() === 'idle',
      detail: `+1.0s running ${heldThroughGrace} · +3.5s running ${!stopped} · phase ${phase()} — dumpsys should show nothing`,
    });
    rows.push({
      name: '17 · and the song landed',
      ok: task.state === 'succeeded',
      detail: `task ${task.state}${task.error_code === null ? '' : ` (${task.error_code})`} · ${task.title ?? 'unnamed'}`,
    });
  } finally {
    foreground.dispose();
    boot.handle.closeSync();
  }
  return rows;
}

/**
 * Criterion 17③ with the refusal injected — the deterministic half.
 *
 * Android refuses on its own schedule; this refuses every time, which is what
 * makes "the download finishes anyway" a repeatable claim rather than a lucky
 * one.
 */
export async function armDegradedInjected(): Promise<ScenarioRow[]> {
  const said: string[] = [];
  const refusing: ForegroundService = {
    start: () => {
      const err: Error & { code?: string } = new Error('injected refusal');
      err.code = 'ERR_LARK_FGS_NOT_ALLOWED';
      said.push('start (refused)');
      return Promise.reject(err);
    },
    update: (title, body) => {
      said.push(`update:${title}|${body}`);
      return Promise.resolve();
    },
    stop: () => {
      said.push('stop');
      return Promise.resolve();
    },
    // Nothing came up, so nothing is running. A start that threw arms no
    // confirmation (`foreground.ts`), so this is only ever the honest answer to
    // a question the state machine does not ask on this path.
    isRunning: () => Promise.resolve(false),
  };

  const rows: ScenarioRow[] = [];
  const boot = await runBootSequence();
  const { engine, foreground } = createDownloadRuntime(boot, { service: refusing });
  try {
    await foreground.arm();
    const status = downloads.getState().foreground;
    const realService = await LarkTransfer.isRunning();
    rows.push({
      name: '17③ · a refused start is a degraded download, not a failed one',
      ok:
        status.phase === 'degraded' && status.reason === 'ERR_LARK_FGS_NOT_ALLOWED' && !realService,
      detail: `phase ${status.phase} · reason ${status.reason} · real service running ${realService}`,
    });

    const taskId = await enqueueOne(engine, fixtureLink('short'));
    foreground.settle();
    const duringPhase = phase();
    const task = await awaitTask(taskId);
    await quiet();
    await wait(3_500);
    rows.push({
      name: '17③ · it downloads anyway, and says so the whole way through',
      ok: task.state === 'succeeded' && duringPhase === 'degraded' && phase() === 'idle',
      detail: `task ${task.state} · phase during ${duringPhase} → after ${phase()} · service was told: ${said.join(', ')}`,
    });
  } finally {
    foreground.dispose();
    boot.handle.closeSync();
  }
  return rows;
}

/**
 * Criterion 17's counter-test, and the only one Android can give: arm from the
 * BACKGROUND.
 *
 * If a background start is allowed, then starting the service at the enqueue
 * rather than at the gesture would have been fine all along and `arming` is
 * ceremony.
 *
 * 🔴 IT ARMS FROM AN `AppState` CALLBACK, NOT FROM A TIMER, and the first
 * version of this scenario got that wrong: it waited ten seconds and armed,
 * which measured nothing at all because JS timers are frozen in the background
 * (N3f, N0b-4a). The wait simply did not elapse until the app was back in the
 * foreground, and what looked like "Android allowed it" was an arm that had
 * happened in the foreground like any other. `AppState` fires AT the
 * transition, which is the one moment JS still gets a word in.
 *
 * Two buttons, because the answer has to be read after coming back — and
 * because the host's `dumpsys` during the window is the part that counts.
 */
let backgroundArm: {
  at: string;
  phase: ForegroundPhase;
  reason: string | null;
  startThrew: string | null;
  boot: BootResult;
  foreground: ForegroundController;
} | null = null;

export async function armFromBackground(): Promise<ScenarioRow[]> {
  const boot = await runBootSequence();
  const { foreground } = createDownloadRuntime(boot);
  backgroundArm = null;

  const subscription = AppState.addEventListener('change', (next) => {
    if (next !== 'background' || backgroundArm !== null) return;
    subscription.remove();
    void (async () => {
      let startThrew: string | null = null;
      try {
        // It does not reject — a refusal it recognises becomes `degraded`. A
        // throw here would mean something else entirely, which is worth
        // recording rather than swallowing.
        await foreground.arm();
      } catch (err) {
        startThrew = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      }
      const status = downloads.getState().foreground;
      // Read synchronously, not polled: `wait` is a JS timer and there is no
      // guarantee this process gets another tick while it is in the background.
      backgroundArm = {
        at: 'background',
        phase: status.phase,
        reason: status.reason,
        startThrew,
        boot,
        foreground,
      };
    })();
  });

  return [
    {
      name: '17 counter-test · armed on the NEXT background',
      ok: true,
      detail:
        'press HOME now — it arms from the AppState callback; watch dumpsys, then come back and tap Check',
    },
  ];
}

export async function checkBackgroundArm(): Promise<ScenarioRow[]> {
  if (backgroundArm === null) {
    return [
      {
        name: '17 counter-test · nothing armed',
        ok: false,
        detail: 'the background transition never reached JS — arm again and press HOME',
      },
    ];
  }
  const { phase, reason, startThrew, boot, foreground } = backgroundArm;
  backgroundArm = null;
  try {
    const upNow = await serviceUp(3_000);
    const now = downloads.getState().foreground;
    return [
      {
        // A RECORD, NOT A VERDICT, and the reason is the measurement itself
        // (N4c-3): vivo's Android 15 neither throws nor starts the service —
        // it DEFERS the request until the app is next in the foreground. From
        // inside the app there is nothing to see at the transition, and by the
        // time JS runs again the service is genuinely there. So the claim
        // "arming from the background buys you nothing WHILE you are in the
        // background" belongs to the host's `dumpsys` sampling during the
        // window, and this row is what the app can honestly add to it.
        name: '17 counter-test · what a background arm looked like from inside',
        ok: true,
        detail: `at the transition: phase ${phase} · reason ${reason ?? 'none'} · arm threw ${startThrew ?? 'nothing'} — after coming back: phase ${now.phase} · service running ${upNow} · THE WINDOW IS DUMPSYS'S TO JUDGE`,
      },
    ];
  } finally {
    foreground.dispose();
    await LarkTransfer.stop();
    boot.handle.closeSync();
  }
}

/**
 * Criterion 21: a stopped service is stopped, and stopping twice is not an
 * error.
 *
 * No library and no download — this is about the module, and the six seconds in
 * the middle are for the host to look at `dumpsys` and at the shade.
 */
export async function serviceStopsForReal(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  await LarkTransfer.start('正在下载 1 首', '判据 21');
  const up = await serviceUp();
  rows.push({
    name: '21 · started',
    ok: up,
    detail: `service running ${up} · six seconds to look at dumpsys and the shade`,
  });
  await wait(6_000);

  await LarkTransfer.stop();
  await wait(1_000);
  const afterFirst = await LarkTransfer.isRunning();

  let threw: string | null = null;
  try {
    await LarkTransfer.stop();
  } catch (err) {
    threw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  await wait(500);
  const afterSecond = await LarkTransfer.isRunning();

  rows.push({
    name: '21 · stopped, and stopping again is a no-op',
    ok: !afterFirst && !afterSecond && threw === null,
    detail: `running after stop ${afterFirst} · after a second stop ${afterSecond} · second stop threw: ${threw ?? 'no'} — dumpsys should show nothing`,
  });
  return rows;
}

/** What criterion 22 leaves running between its two buttons. */
let both: {
  driver: PlayerDriver;
  boot: BootResult;
  engine: DownloadEngine;
  foreground: ForegroundController;
  taskId: string;
} | null = null;

/**
 * Criterion 22: the media service and the dataSync service, at once.
 *
 * Two services, two types, two notifications, and neither one may take the
 * other down. The download is the LONG track, so that it is still going while
 * the host looks.
 */
export async function armPlaybackAndDownload(): Promise<ScenarioRow[]> {
  const driver = createPlayerDriver();
  await driver.load(shortFixture().uri, { title: '判据 22', artist: 'lark' });
  driver.play();

  // AN EMPTY LIBRARY, and not for tidiness. The first run of this scenario
  // enqueued the long track into a library that already had it: the task found
  // the song downloaded and finished in about two seconds, so the window where
  // both services were up — the whole point — was four seconds long and there
  // was nothing to photograph.
  await resetInstall();
  for (const stale of [songsRoot(), recoveredSongsRoot()]) {
    if (stale.exists) stale.delete();
  }

  const boot = await runBootSequence();
  const { engine, foreground } = createDownloadRuntime(boot);
  await foreground.arm();
  const up = await serviceUp();
  const taskId = await enqueueOne(engine, fixtureLink('long'));
  foreground.settle();
  both = { driver, boot, engine, foreground, taskId };

  return [
    {
      name: '22 · both are up — count the services and the notifications now',
      ok: up && phase() === 'running',
      detail: `download service running ${up} · phase ${phase()} · playing, and the long track is downloading · PARKED — tap "Stop 22" when done`,
    },
  ];
}

/** The other half of 22: stopping the download must not touch the music. */
export async function stopPlaybackAndDownload(): Promise<ScenarioRow[]> {
  if (both === null) return [{ name: '22 · stop', ok: false, detail: 'nothing was parked' }];
  const { driver, boot, engine, foreground, taskId } = both;
  both = null;

  let playing = false;
  const unsubscribe = driver.subscribe((snapshot) => {
    playing = snapshot.playing;
  });

  // Through the engine, the way the UI will: cancelling the last task empties
  // the queue, and the grace does the rest. Stopping the SERVICE directly would
  // prove less — the question is whether the state machine's own stop leaves
  // the music alone.
  engine.cancel(taskId);
  await quiet();
  await wait(3_500);
  const serviceGone = !(await LarkTransfer.isRunning());
  await wait(500);

  const rows: ScenarioRow[] = [
    {
      name: '22 · stopping the download left the music alone',
      ok: serviceGone && playing,
      detail: `download service running ${!serviceGone} · still playing ${playing} · phase ${phase()}`,
    },
  ];

  unsubscribe();
  await driver.destroy();
  foreground.dispose();
  boot.handle.closeSync();
  return rows;
}
