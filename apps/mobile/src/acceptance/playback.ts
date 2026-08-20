// Criteria 4 and 3③ — the error paths, on the device (N3f).
//
// THESE CANNOT RUN IN THE PRODUCT, and that is why they are here rather than
// in `mobile-accept-library`'s driven run. A production build has no legal way
// to hold a broken audio file: `Paths.document` is app-private so nothing can
// push one in, and no screen can create one. Opening a back door in the
// product to test the product is a worse trade than a second artifact.
//
// WHAT IS BEING SEPARATED. `AudioStatus` carries `error: string | null`
// (`Audio.types.d.ts:243`), which Android fills from `onPlayerError`
// (`AudioPlayer.kt:158`), and the watchdog exists only for "no terminal state
// ever arrived". A file we KNOW is broken must therefore be refused by the
// player, quickly — so these assert HOW LONG IT TOOK, not merely that it
// stopped. An implementation that let the fifteen-second watchdog answer for
// broken files would pass a "did it stop?" test every time.
//
// The zero-active-players half of criterion 3③ is not asserted here: how many
// AudioTracks the system holds is a `dumpsys audio` fact, and JS cannot see
// it. The host counts after this suite finishes.

import { Directory, File } from 'expo-file-system';
import { LOAD_WATCHDOG_MS, PlaybackFailure, createPlayerDriver } from '../player/driver';
import { nestDirectory } from '../ports/paths';
import type { ScenarioRow } from './d16';

/**
 * Comfortably inside the watchdog and comfortably outside "instant".
 *
 * N0b-4b loaded real bilibili bytes in 119ms, so a refusal that takes seconds
 * would already be suspicious — but the number here only has to separate "the
 * player said no" from "we gave up waiting", and being generous about it keeps
 * the assertion about the mechanism rather than about the device's mood.
 */
const REFUSAL_BUDGET_MS = 5_000;

const META = { title: 'acceptance', artist: 'lark' };

function scratch(): Directory {
  const dir = new Directory(nestDirectory(), 'acceptance-audio');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/** A file that exists and is not audio. Returns its `file://` URI. */
function broken(name: string, bytes: Uint8Array): string {
  const file = new File(scratch(), name);
  file.create({ overwrite: true });
  file.write(bytes);
  return file.uri;
}

interface Outcome {
  /** How long the load took to reach a terminal state. */
  ms: number;
  /** True when the native player reported it; false when the watchdog fired. */
  reported: boolean | null;
  message: string;
}

/**
 * Load and wait for it to end, however it ends.
 *
 * The driver tears ITSELF down on failure (`driver.ts`), so there is nothing
 * to clean up here — which is the same property criterion 3③ then measures
 * from the outside.
 */
async function loadUntilTerminal(uri: string): Promise<Outcome> {
  const driver = createPlayerDriver();
  const started = Date.now();
  try {
    await driver.load(uri, META);
    // A source we expected to be refused and was not. Take it down the
    // supported way before saying so, or the next scenario counts our track.
    await driver.destroy();
    return { ms: Date.now() - started, reported: null, message: 'it loaded' };
  } catch (err) {
    const ms = Date.now() - started;
    if (err instanceof PlaybackFailure) return { ms, reported: err.reported, message: err.message };
    return { ms, reported: null, message: err instanceof Error ? err.message : String(err) };
  }
}

const SCENARIOS: { name: string; run: () => Promise<string> }[] = [
  {
    name: 'an empty file is refused by the player, not by the watchdog',
    run: async () => {
      const outcome = await loadUntilTerminal(broken('empty.m4a', new Uint8Array(0)));
      if (outcome.reported !== true) throw new Error(`no reported error: ${outcome.message}`);
      if (outcome.ms >= REFUSAL_BUDGET_MS) {
        throw new Error(`took ${outcome.ms}ms, which is the watchdog answering`);
      }
      return `${outcome.ms}ms · ${outcome.message}`;
    },
  },
  {
    name: 'so is a file with content that is not audio',
    run: async () => {
      // 4KB of a repeating byte. Not empty, so "it was zero length" is not the
      // only thing the player could be reacting to.
      const outcome = await loadUntilTerminal(broken('garbage.m4a', new Uint8Array(4096).fill(7)));
      if (outcome.reported !== true) throw new Error(`no reported error: ${outcome.message}`);
      if (outcome.ms >= REFUSAL_BUDGET_MS) {
        throw new Error(`took ${outcome.ms}ms, which is the watchdog answering`);
      }
      return `${outcome.ms}ms · ${outcome.message}`;
    },
  },
  {
    name: 'a uri with no file behind it reaches a terminal state',
    run: async () => {
      const outcome = await loadUntilTerminal(new File(scratch(), 'absent.m4a').uri);
      // Either answer is a pass: this one asserts that it ENDS, and which
      // mechanism ends it is the device's business. Both are recorded.
      if (outcome.reported === null) throw new Error(`ended in some other way: ${outcome.message}`);
      const by = outcome.reported ? 'the player' : `the watchdog (${LOAD_WATCHDOG_MS}ms)`;
      return `${outcome.ms}ms · ended by ${by} · ${outcome.message}`;
    },
  },
];

export async function runPlaybackScenarios(): Promise<ScenarioRow[]> {
  const rows: ScenarioRow[] = [];
  for (const { name, run } of SCENARIOS) {
    try {
      rows.push({ name, ok: true, detail: await run() });
    } catch (err) {
      rows.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  }
  // The files are the only thing left behind, and the next run would overwrite
  // them anyway — but a scratch directory that survives into a library the
  // product then opens is exactly the kind of leftover N2 spent a batch on.
  const dir = scratch();
  if (dir.exists) dir.delete();
  return rows;
}
