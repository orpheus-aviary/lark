// The boot sweep on the device (criteria 11–13).
//
// What is being asked here is not "does the code branch correctly" — that is
// six lines and a desktop test would say so. It is whether THIS filesystem does
// what the sweep assumes: that a directory move into a freshly created parent
// works, that deleting a directory out from under a listing is safe, and that
// what boot hands back has already been reconciled.
//
// Criterion 11's other half — a crash between the commit and the atomic
// replace — needs a real download to reach, and lives with the landing
// scenarios. What this file covers of it is the state that crash leaves behind:
// a committed row, no canonical file, one `.tmp`.

import {
  CANONICAL_AUDIO_FILE,
  LYRICS_FILE,
  countFileOps,
  createSong,
  enqueueRemoteDelete,
  pendingFileOpSongIds,
  uuid,
} from '@lark/core/portable';
import { Directory, File } from 'expo-file-system';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { sweepSongsStore } from '../boot/sweep';
import {
  recoveredSongsRoot,
  songDirectory,
  songsRoot,
  trashRecoveryDirectory,
  trashRoot,
} from '../ports/paths';
import { type ScenarioRow, resetInstall } from './d16';

// ─── fixture plumbing ───────────────────────────────────

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const names = (directory: Directory): string[] =>
  directory.exists
    ? directory
        .list()
        .map((entry) => entry.name)
        .sort()
    : [];

function writeFile(directory: Directory, name: string, contents: string): void {
  const file = new File(directory, name);
  file.create({ overwrite: true });
  file.write(contents);
}

/** A song directory in whichever of the four shapes the sweep has to judge. */
function seedDirectory(
  id: string,
  what: { audio?: boolean; lyrics?: boolean; tmp?: boolean } = {},
): void {
  const directory = songDirectory(id);
  if (!directory.exists) directory.create({ intermediates: true });
  if (what.audio === true) writeFile(directory, CANONICAL_AUDIO_FILE, 'audio');
  if (what.lyrics === true) writeFile(directory, LYRICS_FILE, '[00:00.00]hi');
  // The name the landing protocol writes (`ports/audio-landing.ts`), not an
  // invented one: the sweep is being asked to recognise the real thing.
  if (what.tmp === true) writeFile(directory, `.download.${uuid()}.tmp`, 'half a song');
}

/** Where a sweep parked things, whatever stamp it chose. */
function parkedIn(): Directory[] {
  return trashRoot().exists
    ? trashRoot()
        .list()
        .filter((entry): entry is Directory => entry instanceof Directory)
    : [];
}

/** A booted library with nothing in it, and none of the three roots either. */
async function freshLibrary(): Promise<BootResult> {
  await resetInstall();
  for (const stale of [songsRoot(), recoveredSongsRoot(), trashRoot()]) {
    if (stale.exists) stale.delete();
  }
  return runBootSequence();
}

async function withLibrary(body: (boot: BootResult) => Promise<string>): Promise<string> {
  const boot = await freshLibrary();
  try {
    return await body(boot);
  } finally {
    boot.handle.closeSync();
  }
}

// ─── scenarios ──────────────────────────────────────────

type Scenario = () => Promise<string>;

/**
 * Criterion 11, the part a crash leaves on disk: the row committed, the atomic
 * replace never ran. Nothing here is recovery — the row is the truth, `has_file`
 * is computed off the disk, and the song reads as "needs download". All the
 * sweep owes it is taking the dead tmp away without taking the directory.
 */
const committedRowKeepsItsDirectory: Scenario = () =>
  withLibrary(async ({ db }) => {
    const song = createSong(db, { name: 'a song whose file never landed' });
    seedDirectory(song.id, { tmp: true, lyrics: true });

    const report = await sweepSongsStore(db);

    expect(report.tempFilesRemoved === 1, `swept ${report.tempFilesRemoved} tmp files, wanted 1`);
    expect(report.emptyDirsRemoved === 0, 'the sweep removed a directory that has a row');
    expect(songDirectory(song.id).exists, 'the directory went with the tmp file');
    expect(
      JSON.stringify(names(songDirectory(song.id))) === JSON.stringify([LYRICS_FILE]),
      `left ${JSON.stringify(names(songDirectory(song.id)))} behind`,
    );
    return 'row kept · tmp gone · lyrics untouched · reads as "needs download"';
  });

/** The ordinary crash: a download that died before it committed anything. */
const unreferencedAndEmpty: Scenario = () =>
  withLibrary(async ({ db }) => {
    const id = uuid();
    seedDirectory(id, { tmp: true });

    const report = await sweepSongsStore(db);

    expect(report.tempFilesRemoved === 1, `swept ${report.tempFilesRemoved} tmp files, wanted 1`);
    expect(
      report.emptyDirsRemoved === 1,
      `removed ${report.emptyDirsRemoved} directories, wanted 1`,
    );
    expect(!songDirectory(id).exists, 'a directory standing for nothing survived');
    expect(parkedIn().length === 0, 'nothing was worth parking, yet something was parked');
    return 'tmp swept · empty directory removed · trash/ untouched';
  });

/**
 * Criterion 12. The destination is the whole point: `recovered-songs/` is
 * sync's, and `/sync/status` counts what is in it — an orphan filed there would
 * read as a sync problem the day N5 ships.
 */
const orphanGoesToTrash: Scenario = () =>
  withLibrary(async ({ db }) => {
    const id = uuid();
    seedDirectory(id, { audio: true, lyrics: true });

    const report = await sweepSongsStore(db, { stamp: 'acceptance' });

    expect(report.orphansQuarantined === 1, `parked ${report.orphansQuarantined}, wanted 1`);
    expect(!songDirectory(id).exists, 'the orphan is still where it was');
    const parked = names(new Directory(trashRecoveryDirectory('acceptance'), id));
    expect(
      JSON.stringify(parked) === JSON.stringify([CANONICAL_AUDIO_FILE, LYRICS_FILE].sort()),
      `trash/recovery-acceptance/${id} holds ${JSON.stringify(parked)}`,
    );
    expect(
      names(recoveredSongsRoot()).length === 0,
      `recovered-songs/ gained ${JSON.stringify(names(recoveredSongsRoot()))}`,
    );
    return `parked in trash/recovery-acceptance · ${parked.join(' + ')} · recovered-songs/ empty`;
  });

/**
 * Criterion 13. The seed is deliberately the orphan shape — files, no row —
 * because that is what makes the skip set load bearing rather than decorative:
 * an op that failed or is backing off owns a directory that looks exactly like
 * residue.
 */
const journalOwnedIsLeftAlone: Scenario = () =>
  withLibrary(async ({ db }) => {
    const id = uuid();
    seedDirectory(id, { audio: true });
    // Not drained: what is waiting here is the state a failed or backing-off op
    // leaves the boot in.
    enqueueRemoteDelete(db.sqlite, id, 'imported');

    const report = await sweepSongsStore(db, { skipSongIds: pendingFileOpSongIds(db.sqlite) });

    expect(report.skippedForFileOps === 1, `skipped ${report.skippedForFileOps}, wanted 1`);
    expect(report.orphansQuarantined === 0, 'the sweep parked a directory the journal owns');
    expect(
      JSON.stringify(names(songDirectory(id))) === JSON.stringify([CANONICAL_AUDIO_FILE]),
      'the directory did not survive untouched',
    );
    expect(countFileOps(db.sqlite).pending === 1, 'the op is no longer waiting in the journal');
    return 'directory untouched · op still waiting · nothing parked';
  });

/**
 * The counter-test for criterion 13, run rather than argued: the same fixture,
 * the same sweep, no skip set. If this one did NOT move the directory, the
 * scenario above would be proving nothing.
 */
const withoutTheSkipSetItIsTaken: Scenario = () =>
  withLibrary(async ({ db }) => {
    const id = uuid();
    seedDirectory(id, { audio: true });
    enqueueRemoteDelete(db.sqlite, id, 'imported');

    const report = await sweepSongsStore(db);

    expect(report.skippedForFileOps === 0, 'something was skipped without a skip set');
    expect(report.orphansQuarantined === 1, `parked ${report.orphansQuarantined}, wanted 1`);
    expect(!songDirectory(id).exists, 'the directory was not taken — criterion 13 proves nothing');
    return 'no skip set · the journal-owned directory is taken · the guard is real';
  });

/** ⑪b is inside the sequence, and after the drain. */
const bootSweepsBeforeHandingBack: Scenario = async () => {
  const orphan = uuid();
  let kept = '';
  const setup = await freshLibrary();
  try {
    kept = createSong(setup.db, { name: 'a song whose file never landed' }).id;
    seedDirectory(kept, { tmp: true });
    seedDirectory(orphan, { audio: true });
  } finally {
    setup.handle.closeSync();
  }

  const boot = await runBootSequence();
  try {
    expect(boot.decision.action === 'normal', `the relaunch decided '${boot.decision.action}'`);
    expect(
      boot.swept.tempFilesRemoved === 1 && boot.swept.orphansQuarantined === 1,
      `⑪b reported ${JSON.stringify({ ...boot.swept, notes: undefined })}`,
    );
    expect(songDirectory(kept).exists, 'boot took the directory of a committed row');
    expect(!songDirectory(orphan).exists, 'boot handed back a library it had not reconciled');
    expect(parkedIn().length === 1, `trash/ holds ${JSON.stringify(names(trashRoot()))}`);
    return 'boot swept inside the sequence · orphan parked · committed row kept';
  } finally {
    boot.handle.closeSync();
  }
};

const SCENARIOS: { name: string; run: Scenario }[] = [
  { name: '11 · a committed row keeps its directory', run: committedRowKeepsItsDirectory },
  { name: '11 · nothing committed, nothing left', run: unreferencedAndEmpty },
  { name: '12 · an orphan goes to trash/, not recovered-songs/', run: orphanGoesToTrash },
  { name: '13 · the journal still owns it', run: journalOwnedIsLeftAlone },
  { name: '13 · counter-test: no skip set, taken', run: withoutTheSkipSetItIsTaken },
  { name: '11 · ⑪b runs inside the boot sequence', run: bootSweepsBeforeHandingBack },
];

export async function runSweepScenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  for (const { name, run } of SCENARIOS) {
    try {
      rows.push({ name, ok: true, detail: await run() });
    } catch (err) {
      rows.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  await resetInstall();
  return rows;
}
