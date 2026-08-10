// A spawnable child that never leaves the process (T5).
//
// Both launch paths — the daemon and the GUI — are "spawn detached, watch for
// two things (exit / error), maybe signal it later", so the fake models
// exactly those: which signals arrived, and whether the child chooses to die
// on them.

import { EventEmitter } from 'node:events';
import type { SpawnImpl, SpawnOptions, SpawnedChild } from '../lib/launch.js';

export interface FakeChildOptions {
  pid?: number;
  /** Signals this child actually dies on. Empty = survives everything. */
  diesOn?: NodeJS.Signals[];
  /** `kill` reports "no such process": it was already gone. */
  gone?: boolean;
}

export class FakeChild extends EventEmitter implements SpawnedChild {
  readonly signals: NodeJS.Signals[] = [];
  readonly pid: number;
  #diesOn: NodeJS.Signals[];
  #gone: boolean;

  constructor(options: FakeChildOptions = {}) {
    super();
    this.pid = options.pid ?? 4242;
    this.#diesOn = options.diesOn ?? ['SIGTERM'];
    this.#gone = options.gone ?? false;
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.#gone) return false;
    // Asynchronously, like a real exit.
    if (this.#diesOn.includes(signal)) setTimeout(() => this.emit('exit', 0, signal), 0);
    return true;
  }

  unref(): void {}
}

export interface FakeSpawn {
  impl: SpawnImpl;
  children: FakeChild[];
  options: SpawnOptions[];
}

export function fakeSpawn(
  child: FakeChild = new FakeChild(),
  dieOnSpawn = false,
  exitCode = 1,
): FakeSpawn {
  const children: FakeChild[] = [];
  const options: SpawnOptions[] = [];
  return {
    children,
    options,
    impl: (_command, _args, opts) => {
      options.push(opts);
      children.push(child);
      // `setImmediate` — the same phase {@link virtualClock} yields through,
      // queued FIRST, so a poll loop deterministically sees the exit on its
      // first pass.
      if (dieOnSpawn) setImmediate(() => child.emit('exit', exitCode, null));
      return child;
    },
  };
}

/**
 * A virtual clock: `sleep` is what moves time forward.
 *
 * It still yields a MACROTASK, because a promise that resolves synchronously
 * never lets a timer run — and a child's `exit` arrives on one. A poll loop
 * tested against `Promise.resolve()` runs to its deadline without ever
 * observing the events it is polling for.
 */
export function virtualClock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
  let value = 0;
  return {
    now: () => value,
    sleep: (ms) => {
      value += ms;
      return new Promise((resolve) => setImmediate(resolve));
    },
  };
}
