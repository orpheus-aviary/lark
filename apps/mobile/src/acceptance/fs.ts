// `FileSystemPort` on the device (criteria 9 and 10②③④).
//
// Criterion 10① — "a reader never sees the target missing" — is NOT here, and
// cannot be. Everything below runs on the JS thread, so a poll loop beside a
// synchronous native call only ever runs after it returns, and a deliberately
// non-atomic implementation would pass every assertion in this file. That is
// the trap the subplan spells out (§1.5, and `node-fs.test.ts:60` only works
// because the desktop's write is genuinely async). The window is observed by
// the instrumentation test in `modules/lark-fs/android/src/androidTest/`,
// which has two real threads and a barrier.
//
// What IS here is everything else the port promises, on the real filesystem:
// absence as a return value, the temp file's shape, parent creation, and what
// a failed write leaves behind.

import { resetRandomForTesting, uuid } from '@lark/core/portable';
import { Directory, File } from 'expo-file-system';
import { installPortableRuntime } from '../boot/runtime';
import { createFileSystem, sweepWriteResidue } from '../ports/fs';
import { nestDirectory } from '../ports/paths';
import type { ScenarioRow } from './d16';

const SCRATCH = 'fs-check';

const scratchDirectory = (): Directory => new Directory(nestDirectory(), SCRATCH);

function resetScratch(): Directory {
  const directory = scratchDirectory();
  if (directory.exists) directory.delete();
  directory.create({ intermediates: true });
  return directory;
}

const uriIn = (directory: Directory, name: string): string => new File(directory, name).uri;

/** Every entry, so a stray temp file is visible rather than inferred. */
const namesIn = (directory: Directory): string[] =>
  directory.exists
    ? directory
        .list()
        .map((entry) => entry.name)
        .sort()
    : [];

type Scenario = () => Promise<string>;

const fs = createFileSystem();

/** Criterion 9, absence half: three calls, three return values, no throws. */
const absenceIsAValue: Scenario = async () => {
  const directory = resetScratch();
  const missing = uriIn(directory, 'not-there.txt');

  if (fs.statSync(missing) !== null) throw new Error('statSync did not answer null');
  if (fs.unlinkSync(missing) !== false) throw new Error('unlinkSync did not answer false');
  if ((await fs.readText(missing)) !== null) throw new Error('readText did not answer null');
  if ((await fs.unlink(missing)) !== false) throw new Error('unlink did not answer false');

  return 'statSync null · unlinkSync false · readText null · unlink false';
};

/** Criterion 9, presence half. */
const presenceRoundTrips: Scenario = async () => {
  const directory = resetScratch();
  const path = uriIn(directory, 'present.txt');
  const text = 'lyrics line one\nline two\n';

  await fs.writeTextAtomic(path, text);

  const stat = fs.statSync(path);
  if (stat === null) throw new Error('statSync answered null for a file that exists');
  if ((await fs.readText(path)) !== text) throw new Error('readText did not round-trip');
  if (stat.size !== new TextEncoder().encode(text).length) {
    throw new Error(`size was ${stat.size}, expected the byte length`);
  }
  if (!fs.unlinkSync(path)) throw new Error('unlinkSync answered false for a file that exists');
  if (fs.statSync(path) !== null) throw new Error('it is still there after unlink');

  return `size ${stat.size} · round-tripped · deleted`;
};

/** Criterion 10②③: the temp file's shape, and nothing left behind. */
const atomicWriteLeavesNoResidue: Scenario = async () => {
  const directory = resetScratch();
  // Criterion 10③, parent creation: two levels that do not exist yet.
  const nested = new Directory(directory, 'songs', 'a-song');
  const path = uriIn(nested, 'lyrics.lrc');

  await fs.writeTextAtomic(path, 'first');
  if ((await fs.readText(path)) !== 'first') throw new Error('the first write did not land');

  await fs.writeTextAtomic(path, 'second');
  if ((await fs.readText(path)) !== 'second') throw new Error('the replacement did not land');

  const left = namesIn(nested);
  if (left.length !== 1 || left[0] !== 'lyrics.lrc') {
    throw new Error(`the directory holds ${JSON.stringify(left)}`);
  }
  return `parents created · replaced · directory holds only ${left[0]}`;
};

/** Criterion 10②: the name a prefix sweep has to recognise. */
const tempIsASweepableSibling: Scenario = async () => {
  const directory = resetScratch();
  const path = uriIn(directory, 'lyrics.lrc');
  await fs.writeTextAtomic(path, 'old');

  let seen: string[] = [];
  const watching = createFileSystem({
    moveAtomic: async (from, to) => {
      // Caught mid-write: this is the only moment the temp file exists.
      seen = namesIn(directory);
      const source = new File(from);
      const target = new File(to);
      if (source.parentDirectory.uri !== target.parentDirectory.uri) {
        throw new Error('the temp file is not a sibling of the target');
      }
      throw new Error('stop here');
    },
  });

  await watching.writeTextAtomic(path, 'new').catch(() => undefined);

  const temps = seen.filter((name) => name !== 'lyrics.lrc');
  if (temps.length !== 1) throw new Error(`saw ${JSON.stringify(seen)} mid-write`);
  const temp = temps[0] as string;
  if (!temp.startsWith('.') || !temp.endsWith('.tmp')) {
    throw new Error(`the temp file is named ${temp}, which no prefix sweep would find`);
  }
  if (!temp.includes('lyrics.lrc')) {
    throw new Error(`${temp} does not name its target — a sweep could not attribute it`);
  }
  return temp;
};

/** Criterion 10③: a failed write keeps the old file and leaves no residue. */
const failedWriteKeepsTheOldFile: Scenario = async () => {
  const directory = resetScratch();
  const path = uriIn(directory, 'lyrics.lrc');
  await fs.writeTextAtomic(path, 'the old lyrics');

  const failing = createFileSystem({
    moveAtomic: async () => {
      throw new Error('ERR_LARK_FS_MOVE (simulated)');
    },
  });

  let threw = false;
  try {
    await failing.writeTextAtomic(path, 'the new lyrics');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('a failed move did not propagate');

  // The two things that matter, in the order they matter: the document that
  // cannot be re-downloaded is intact, and nothing is left to confuse a sweep.
  if ((await fs.readText(path)) !== 'the old lyrics') throw new Error('the old file changed');
  const left = namesIn(directory);
  if (left.length !== 1) throw new Error(`residue: ${JSON.stringify(left)}`);

  return 'old file intact · no residue · error propagated';
};

/** Criterion 10④'s companion: the sweep finds residue that a hard kill left. */
const sweepFindsOrphanedTemps: Scenario = async () => {
  const directory = resetScratch();
  // What a process death between `create` and the move leaves.
  const orphan = new File(directory, '.lyrics.lrc.abc123.tmp');
  orphan.create();
  orphan.write('half a write');

  const swept = sweepWriteResidue(directory);
  if (swept !== 1) throw new Error(`swept ${swept}, expected 1`);
  if (namesIn(directory).length !== 0) throw new Error('the orphan is still there');
  return 'one orphan swept';
};

/**
 * Criterion 11, and it arrived by accident before it arrived on purpose.
 *
 * MEASURED: the first run of this suite was 2/6 with four rows reading `no
 * RandomSource: this host has no crypto.randomUUID`. The acceptance root does
 * not boot on mount, so nothing had installed the port, and the temp file's
 * name needs a uuid. That is the port behaving exactly as designed — React
 * Native has neither `randomUUID` nor `getRandomValues` (N0b-3), and a
 * `Math.random()` fallback would mint ids that collide across devices with
 * sync there to give every collision a second library to corrupt.
 *
 * So it becomes a case: take the source away, watch it refuse, put it back.
 */
const randomIsFailLoud: Scenario = async () => {
  resetRandomForTesting();
  let refusal = '';
  try {
    uuid();
  } catch (err) {
    refusal = err instanceof Error ? err.message : String(err);
  } finally {
    // Whatever happens above, the rest of this process needs its ids back.
    installPortableRuntime();
  }
  if (!refusal.includes('no RandomSource')) {
    throw new Error(`minted an id with no source installed: ${refusal || '(no throw)'}`);
  }
  if (uuid().length !== 36) throw new Error('reinstalling the source did not restore it');
  return refusal.split('.')[0] as string;
};

const SCENARIOS: { name: string; run: Scenario }[] = [
  { name: '9 · absence is a return value', run: absenceIsAValue },
  { name: '9 · a real file round-trips', run: presenceRoundTrips },
  { name: '10②③ · parents created, no residue', run: atomicWriteLeavesNoResidue },
  { name: '10② · the temp file is a sweepable sibling', run: tempIsASweepableSibling },
  { name: '10③ · a failed write keeps the old file', run: failedWriteKeepsTheOldFile },
  { name: '10③ · the sweep finds an orphaned temp', run: sweepFindsOrphanedTemps },
  { name: '11 · no RandomSource is a refusal, not a bad uuid', run: randomIsFailLoud },
];

export async function runFileSystemScenarios(): Promise<ScenarioRow[]> {
  // §2.2 step ①. The acceptance root does not boot on mount, so this suite has
  // to install the runtime itself — `writeTextAtomic` names its temp file with
  // a uuid, and without a source that is a refusal (criterion 11, below).
  installPortableRuntime();

  const rows: ScenarioRow[] = [];
  for (const { name, run } of SCENARIOS) {
    try {
      rows.push({ name, ok: true, detail: await run() });
    } catch (err) {
      rows.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  const directory = scratchDirectory();
  if (directory.exists) directory.delete();
  return rows;
}
