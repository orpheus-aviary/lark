// The file-effect journal on the device (criterion 12, all six).
//
// The DECISIONS are portable and already have 27 cases on the desktop runner
// (`portable/sync/file-ops.test.ts`). What only a phone can answer is whether
// this host's five verbs mean what the port says they mean — expo's
// `Directory.delete()` is recursive but throws on absence, its `move` branches
// on whether the destination exists, and a `File → Directory` move needs that
// directory to be there first. So these scenarios drive real ops over the real
// filesystem rather than re-testing the branch matrix in a second place.
//
// CRITERION 12③ USES A REAL KILL, and `d16.ts` is where that debt was
// recorded: "a death in the middle of the file-op drain leaves half a file
// operation, which is not a database state at all". D16's own crash points are
// throws, which is sound for state that is committed before the point is
// reached — but the journal's half-state lives on the filesystem, and a throw
// unwinds where SIGKILL does not. So the fixture PARKS the drain at a point
// this file chooses (decision o⑤: chosen, not guessed), the driver force-stops
// the process there, and the second half asserts what the next boot made of it.

import {
  CANONICAL_AUDIO_FILE,
  FileEffectRuntime,
  type FileOpRow,
  LYRICS_FILE,
  type PortableDb,
  type SongFilesPort,
  countFileOps,
  emitSyncChange,
  enqueueDeleteLyrics,
  enqueueLocalDelete,
  enqueueQuarantine,
  enqueueRemoteDelete,
  enqueueWriteLyrics,
  uuid,
} from '@lark/core/portable';
import { Directory, File } from 'expo-file-system';
import { type BootResult, runBootSequence } from '../boot/sequence';
import { createFileSystem } from '../ports/fs';
import {
  createPaths,
  nestDirectory,
  recoveredSongsDirectory,
  recoveredSongsRoot,
  songDirectory,
} from '../ports/paths';
import { createSongFiles } from '../ports/song-files';
import { type ScenarioRow, resetInstall } from './d16';

// ─── fixture plumbing ───────────────────────────────────

/** A song id that fails the uuid gate inside the executor, deterministically. */
const BROKEN = 'not-a-uuid';

/** Where the kill fixture leaves the two facts that have to survive SIGKILL. */
const KILL_FIXTURE_KEY = 'acceptance_file_op_kill';

const files = { fs: createFileSystem(), paths: createPaths() };
const songFiles = createSongFiles();

function runtimeFor(
  db: PortableDb,
  options: { now?: () => number; songFiles?: SongFilesPort } = {},
): FileEffectRuntime {
  return new FileEffectRuntime({
    sqlite: db.sqlite,
    files,
    songFiles: options.songFiles ?? songFiles,
    nowMs: options.now,
  });
}

function writeFile(directory: Directory, name: string, contents: string): void {
  const file = new File(directory, name);
  file.create({ overwrite: true });
  file.write(contents);
}

function seedSong(id: string, options: { audio?: boolean; lyrics?: boolean } = {}): void {
  const directory = songDirectory(id);
  if (!directory.exists) directory.create({ intermediates: true });
  if (options.audio !== false) writeFile(directory, CANONICAL_AUDIO_FILE, 'audio');
  if (options.lyrics) writeFile(directory, LYRICS_FILE, '[00:00.00]hi');
}

/** Lyrics this device has not pushed — what makes a remote delete rescue them. */
function seedUnpushedLyrics(db: PortableDb, id: string): void {
  emitSyncChange(db.sqlite, {
    entityType: 'song',
    entityId: id,
    op: 'set_lyrics',
    payload: { lrc: '[00:01.00]unpublished' },
  });
}

const names = (directory: Directory): string[] =>
  directory.exists
    ? directory
        .list()
        .map((entry) => entry.name)
        .sort()
    : [];

/**
 * The `quarantine_target` the enqueue transaction snapshotted for this song.
 *
 * Read BEFORE the drain, always: an executed op's row is deleted, so asking
 * afterwards is asking a table that no longer knows.
 */
function targetOf(db: PortableDb, songId: string): string {
  const row = db.sqlite
    .prepare('SELECT arg FROM sync_file_ops WHERE song_id = ? ORDER BY id DESC LIMIT 1')
    .get(songId) as { arg: string } | undefined;
  if (row === undefined) throw new Error(`no journal row for ${songId}`);
  return (JSON.parse(row.arg) as { quarantine_target: string }).quarantine_target;
}

/** Both of a song's files, in the order `names` sorts them. */
const BOTH_FILES = [LYRICS_FILE, CANONICAL_AUDIO_FILE].sort();

function readMeta(db: PortableDb, key: string): string | null {
  return (
    (
      db.sqlite.prepare('SELECT value FROM local_metadata WHERE key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value ?? null
  );
}

function expect(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A booted library with nothing in it, and no `recovered-songs/` either. */
async function freshLibrary(): Promise<BootResult> {
  await resetInstall();
  for (const stale of [new Directory(nestDirectory(), 'songs'), recoveredSongsRoot()]) {
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

/** Criterion 12①, the three kinds that are not a remote delete, plus the local one. */
const everyKind: Scenario = () =>
  withLibrary(async ({ db }) => {
    const local = uuid();
    const aside = uuid();
    const written = uuid();
    const cleared = uuid();
    // A local delete whose directory is ALREADY gone — the shape a rerun after
    // a crash takes, and the only caller that hands `removeSongDir` a song it
    // has not asked `songDirExists` about first.
    const vanished = uuid();
    seedSong(local, { lyrics: true });
    seedSong(aside, { lyrics: true });
    seedSong(written);
    seedSong(cleared, { lyrics: true });

    enqueueLocalDelete(db.sqlite, local);
    enqueueQuarantine(db.sqlite, aside);
    enqueueWriteLyrics(db.sqlite, written, '[00:03.00]from a peer');
    enqueueDeleteLyrics(db.sqlite, cleared);
    enqueueLocalDelete(db.sqlite, vanished);
    const asideTarget = targetOf(db, aside);

    const result = await runtimeFor(db).drain();
    expect(result.executed === 5, `executed ${result.executed} of 5: ${JSON.stringify(result)}`);

    expect(!songDirectory(local).exists, 'the local delete left the directory');
    expect(!songDirectory(aside).exists, 'the quarantine left the directory');
    // The whole directory moved, so the target IS the song directory now.
    expect(
      JSON.stringify(names(recoveredSongsDirectory(asideTarget))) === JSON.stringify(BOTH_FILES),
      `the quarantine target holds ${JSON.stringify(names(recoveredSongsDirectory(asideTarget)))}`,
    );
    expect(
      (await files.fs.readText(files.paths.songLyrics(written))) === '[00:03.00]from a peer',
      'the peer lyrics did not land',
    );
    expect(files.fs.statSync(files.paths.songLyrics(cleared)) === null, 'the lyrics survived');
    expect(files.fs.statSync(files.paths.songAudio(cleared)) !== null, 'it took the audio too');
    return 'delete_song_files (present + already gone) · quarantine · write_lyrics · delete_lyrics';
  });

/**
 * Criterion 12①, the `quarantineExists` branch: the move happened and the
 * crash came after it.
 *
 * The target is stable per op, so on a rerun its existence is the evidence.
 * Reaching it needs the op to be replayed against ITS OWN target, which is
 * what a crash between the move and the row's deletion leaves — so the fixture
 * writes that state rather than enqueuing a second, differently-targeted op
 * (which would take the "nothing to move" path instead and prove nothing).
 */
const quarantineRerun: Scenario = () =>
  withLibrary(async ({ db }) => {
    const id = uuid();
    seedSong(id, { lyrics: true });
    enqueueQuarantine(db.sqlite, id);
    const target = targetOf(db, id);

    await runtimeFor(db).drain();
    expect(!songDirectory(id).exists, 'the first pass did not move it');

    // What the crash left: the target is populated, and the song directory is
    // back because whatever wrote it never learned the op had run.
    seedSong(id, { lyrics: true });
    enqueueQuarantine(db.sqlite, id);
    db.sqlite
      .prepare("UPDATE sync_file_ops SET arg = json_set(arg, '$.quarantine_target', ?)")
      .run(target);

    const result = await runtimeFor(db).drain();
    expect(result.executed === 1, `the replay ${JSON.stringify(result)}`);
    expect(!songDirectory(id).exists, 'the replay left the directory behind');
    expect(
      JSON.stringify(names(recoveredSongsDirectory(target))) === JSON.stringify(BOTH_FILES),
      `the target holds ${JSON.stringify(names(recoveredSongsDirectory(target)))} — it merged two directories`,
    );
    expect(names(recoveredSongsRoot()).length === 1, 'the replay made a second target');
    return 'target already there · leftovers dropped, not merged';
  });

/**
 * Criterion 12①'s matrix: `audio_origin` × `lyrics_disposition`.
 *
 * The disposition is not an argument — it is DECIDED by the enqueue
 * transaction from whether a lyrics change is still unpushed (R4-3), so the
 * fixture sets up the cause rather than the value.
 */
const remoteDeleteMatrix: Scenario = () =>
  withLibrary(async ({ db }) => {
    const cases = [
      { origin: 'downloaded' as const, unpushed: false, expected: [] },
      { origin: 'downloaded' as const, unpushed: true, expected: [LYRICS_FILE] },
      { origin: 'imported' as const, unpushed: false, expected: [CANONICAL_AUDIO_FILE] },
      {
        origin: 'imported' as const,
        unpushed: true,
        expected: [LYRICS_FILE, CANONICAL_AUDIO_FILE],
      },
      { origin: null, unpushed: false, expected: [CANONICAL_AUDIO_FILE] },
      { origin: null, unpushed: true, expected: [LYRICS_FILE, CANONICAL_AUDIO_FILE] },
    ];

    // Targets are read here, while the rows still exist: a drained op's row is
    // deleted, and the snapshot goes with it.
    const planted = cases.map(({ origin, unpushed }) => {
      const id = uuid();
      seedSong(id, { lyrics: true });
      if (unpushed) seedUnpushedLyrics(db, id);
      enqueueRemoteDelete(db.sqlite, id, origin);
      return { id, target: targetOf(db, id) };
    });

    const result = await runtimeFor(db).drain();
    expect(result.executed === 6, `executed ${result.executed} of 6`);

    cases.forEach((expectation, index) => {
      const { id, target } = planted[index] as { id: string; target: string };
      const kept = names(recoveredSongsDirectory(target));
      const wanted = [...expectation.expected].sort();
      expect(
        JSON.stringify(kept) === JSON.stringify(wanted),
        `${expectation.origin ?? 'null'}/${expectation.unpushed ? 'quarantine' : 'delete'} rescued ${JSON.stringify(kept)}, expected ${JSON.stringify(wanted)}`,
      );
      expect(!songDirectory(id).exists, `${id} still has a directory`);
    });
    return '6 combinations · replaceable audio deleted, irreplaceable kept';
  });

/** Criterion 12②: one song's queue is ordered, other songs are not behind it. */
const orderAndOvertaking: Scenario = () =>
  withLibrary(async ({ db }) => {
    const healthy = uuid();
    seedSong(healthy);
    enqueueDeleteLyrics(db.sqlite, BROKEN);
    enqueueDeleteLyrics(db.sqlite, BROKEN);
    enqueueLocalDelete(db.sqlite, healthy);

    const result = await runtimeFor(db).drain();
    expect(result.executed === 1, `executed ${result.executed}, expected the healthy song`);
    expect(result.failed === 1, `failed ${result.failed}`);
    // The second broken op was not attempted: ops for one song depend on each
    // other, so one that fails holds the rest of ITS queue and nothing else.
    expect(result.skipped === 1, `skipped ${result.skipped}`);
    expect(!songDirectory(healthy).exists, 'the healthy song was held up');

    const attempts = (
      db.sqlite.prepare('SELECT attempts FROM sync_file_ops ORDER BY id').all() as FileOpRow[]
    ).map((row) => row.attempts);
    expect(
      JSON.stringify(attempts) === '[1,0]',
      `attempts ${JSON.stringify(attempts)}, expected [1,0]`,
    );
    return 'one attempt on the head, none on what is behind it, the other song through';
  });

/** Criterion 12④: it backs off, gives up, and does not become the boot's problem. */
const backoffThenPermanent: Scenario = () =>
  withLibrary(async ({ db }) => {
    let now = 1_000_000;
    const rt = runtimeFor(db, { now: () => now });
    enqueueDeleteLyrics(db.sqlite, BROKEN);

    await rt.drain();
    // Same millisecond: the backoff is in the future, so the row is skipped
    // rather than burned through.
    const immediate = await rt.drain();
    expect(immediate.skipped === 1 && immediate.failed === 0, 'it retried inside its own backoff');

    for (let i = 0; i < 4; i++) {
      now += 3_600_000;
      await rt.drain();
    }
    const counts = countFileOps(db.sqlite);
    expect(counts.failed === 1 && counts.pending === 0, `counts ${JSON.stringify(counts)}`);
    expect((counts.lastError ?? '').includes('Invalid id'), `last error: ${counts.lastError}`);

    // What boot needs from a permanently failed row: that it is reported and
    // stays out of the way.
    const healthy = uuid();
    seedSong(healthy);
    enqueueLocalDelete(db.sqlite, healthy);
    now += 3_600_000;
    const after = await rt.drain();
    expect(after.executed === 1, 'a dead row blocked an unrelated song');
    expect(after.failed === 0, 'it kept retrying a row that had given up');
    return `5 attempts · gave up · ${after.skipped} skipped, 1 executed after`;
  });

/** Criterion 12⑤: a row nobody can read goes to the archive, not into the way. */
const unreadableArg: Scenario = () =>
  withLibrary(async ({ db }) => {
    const healthy = uuid();
    seedSong(healthy);
    enqueueLocalDelete(db.sqlite, uuid());
    const broken = (db.sqlite.prepare('SELECT id FROM sync_file_ops').get() as { id: number }).id;
    db.sqlite.prepare('UPDATE sync_file_ops SET arg = ? WHERE id = ?').run('{not json', broken);
    enqueueLocalDelete(db.sqlite, healthy);

    let now = 1_000_000;
    const rt = runtimeFor(db, { now: () => now });
    const first = await rt.drain();
    expect(first.executed === 1 && first.failed === 1, `drain said ${JSON.stringify(first)}`);
    expect(!songDirectory(healthy).exists, 'an unreadable row blocked another song');

    for (let i = 0; i < 4; i++) {
      now += 3_600_000;
      await rt.drain();
    }
    expect(
      (countFileOps(db.sqlite).lastError ?? '').includes('unreadable arg'),
      'it failed for some other reason',
    );

    rt.discard(broken);
    const letter = db.sqlite
      .prepare("SELECT reason, op FROM sync_dead_letters WHERE direction='out'")
      .get() as { reason: string; op: string } | undefined;
    expect(letter?.reason === 'file_op_discarded', 'nothing was archived');
    expect(countFileOps(db.sqlite).failed === 0, 'the row outlived its discard');
    return `archived as ${letter?.op}`;
  });

/**
 * Criterion 12⑥: the drain is inside the boot sequence, before it hands back.
 *
 * The assertion is about ORDER, so it is taken at the only moment order is
 * observable — the instant `runBootSequence` resolves. If step ⑪ were removed,
 * the files would still be there at that instant and this reds.
 */
const bootDrainsFirst: Scenario = async () => {
  const id = uuid();
  const setup = await freshLibrary();
  try {
    seedSong(id, { lyrics: true });
    enqueueLocalDelete(setup.db.sqlite, id);
  } finally {
    setup.handle.closeSync();
  }
  expect(songDirectory(id).exists, 'the fixture did not survive being closed');

  const boot = await runBootSequence();
  try {
    expect(boot.decision.action === 'normal', `the relaunch decided '${boot.decision.action}'`);
    expect(
      boot.drained.executed === 1,
      `the boot drain executed ${boot.drained.executed} of the 1 waiting`,
    );
    expect(!songDirectory(id).exists, 'boot handed back a library whose journal had not run');
    return 'one op waiting · drained inside the sequence · gone before ⑫';
  } finally {
    boot.handle.closeSync();
  }
};

const SCENARIOS: { name: string; run: Scenario }[] = [
  { name: '12① · all four kinds', run: everyKind },
  { name: '12① · a quarantine that already happened', run: quarantineRerun },
  { name: '12① · remote delete, origin × disposition', run: remoteDeleteMatrix },
  { name: '12② · same song ordered, other songs overtake', run: orderAndOvertaking },
  { name: '12④ · backoff, then it waits for a human', run: backoffThenPermanent },
  { name: '12⑤ · an unreadable row is archived', run: unreadableArg },
  { name: '12⑥ · boot drains before it hands back the library', run: bootDrainsFirst },
];

export async function runFileOpScenarios(): Promise<ScenarioRow[]> {
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

// ─── criterion 12③: the two halves of a real kill ───────

/**
 * Half one: build the half-state and stop inside it.
 *
 * The point is chosen, not guessed: `removeSongDir` is called AFTER both
 * rescues and BEFORE anything deletes the journal row, so what SIGKILL freezes
 * is exactly "the files are out, the directory and the row are not".
 */
export async function armMidDrainKill(): Promise<ScenarioRow[]> {
  const boot = await freshLibrary();
  const { db } = boot;
  const id = uuid();
  seedSong(id, { lyrics: true });
  seedUnpushedLyrics(db, id);
  enqueueRemoteDelete(db.sqlite, id, 'imported');
  const target = targetOf(db, id);

  // Committed BEFORE the park, because after it there is no chance to write
  // anything: the process is about to stop existing.
  db.sqlite
    .prepare('INSERT OR REPLACE INTO local_metadata (key, value) VALUES (?, ?)')
    .run(KILL_FIXTURE_KEY, JSON.stringify({ id, target }));

  let reached: () => void = () => undefined;
  const atThePoint = new Promise<void>((resolve) => {
    reached = resolve;
  });

  // Deliberately not awaited: it parks and the process ends there.
  void runtimeFor(db, {
    songFiles: {
      ...songFiles,
      removeSongDir: async () => {
        reached();
        // Forever. The next thing that happens to this process is `am
        // force-stop`, which is the point.
        return new Promise<void>(() => undefined);
      },
    },
  })
    .drain()
    .catch(() => undefined);
  await atThePoint;

  const kept = names(recoveredSongsDirectory(target));
  return [
    {
      name: '12③ · parked mid-drain',
      ok: kept.length === 2 && songDirectory(id).exists,
      detail: `rescued ${kept.join(' + ')} · directory still there · PARKED, force-stop now`,
    },
  ];
}

/** Half two: what the next boot made of it. */
export async function resumeAfterKill(): Promise<ScenarioRow[]> {
  const boot = await runBootSequence();
  try {
    const raw = readMeta(boot.db, KILL_FIXTURE_KEY);
    if (raw === null) {
      throw new Error('no fixture — arm the kill, force-stop, relaunch, then run this');
    }
    const { id, target } = JSON.parse(raw) as { id: string; target: string };

    expect(
      boot.drained.executed === 1,
      `the boot drain executed ${boot.drained.executed}: ${JSON.stringify(boot.drained)}`,
    );
    expect(!songDirectory(id).exists, 'the song directory survived the resumed op');
    const kept = names(recoveredSongsDirectory(target));
    expect(
      JSON.stringify(kept) === JSON.stringify(BOTH_FILES),
      `the quarantine holds ${JSON.stringify(kept)} — a rerun rescued something twice`,
    );
    expect(names(recoveredSongsRoot()).length === 1, 'the rerun made a second target');
    const counts = countFileOps(boot.db.sqlite);
    expect(counts.pending === 0 && counts.failed === 0, `journal left ${JSON.stringify(counts)}`);

    return [
      {
        name: '12③ · resumed from the same row after SIGKILL',
        ok: true,
        detail: `boot drain executed 1 · ${kept.join(' + ')} rescued once · journal empty`,
      },
    ];
  } catch (err) {
    return [
      {
        name: '12③ · resumed from the same row after SIGKILL',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      },
    ];
  } finally {
    boot.handle.closeSync();
  }
}
