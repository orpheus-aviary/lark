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
  type PortableDb,
  createBilibiliClient,
  preflightSingle,
  resolveOne,
} from '@lark/core/portable';
import { File } from 'expo-file-system';
import LarkTransfer from '../../modules/lark-transfer';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { createDownloadRuntime } from '../downloads/engine';
import { downloads } from '../downloads/hub';
import { songDirectory } from '../ports/paths';
import { audioFixtures } from './audio-landing';
import type { ScenarioRow } from './d16';

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
