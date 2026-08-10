// Native ABI pre-check (M6-21).
//
// better-sqlite3 ships one compiled `.node` whose NODE_MODULE_VERSION must
// match the runtime loading it — host Node 24.13.0 = modules 137, Electron
// 43.2.0 = modules 148 — so a repo that last ran `just dev` cannot open a
// database from `node` until it is rebuilt.
//
// The CLI needs to know that BEFORE it acts, for two reasons: a `--direct`
// command should say "your native module is built for the other runtime"
// rather than crash with a dlopen stack, and spawning a daemon that is going
// to die on its first database call is worse than not spawning it.
//
// This module must therefore stay importable in a process that cannot load the
// binding at all: the import is DYNAMIC and inside the function. And the probe
// instantiates a real Database, because merely importing the JS wrapper does
// not load the `.node` file — a looser probe would always pass (M1-13).

/**
 * Why the binding could not be loaded.
 *
 * A REASON, not a sentence (M7-14). The fix differs by where the CLI is
 * running from — a repo checkout is repaired with a just recipe that does not
 * exist for someone who installed the published package — and core has no way
 * to tell those apart. So the phrasing belongs to the caller.
 */
export type NativeAbiFailure = 'abi-mismatch' | 'load-failed';

export type NativeAbiProbe =
  | { ok: true }
  | {
      ok: false;
      reason: NativeAbiFailure;
      /** The loader's own words, for the tail of whatever the caller writes. */
      detail: string;
      cause: unknown;
    };

export async function probeNativeAbi(): Promise<NativeAbiProbe> {
  try {
    const { default: BetterSqlite3 } = await import('better-sqlite3');
    new BetterSqlite3(':memory:').close();
    return { ok: true };
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    const mismatch = /NODE_MODULE_VERSION|was compiled against a different/.test(detail);
    return { ok: false, reason: mismatch ? 'abi-mismatch' : 'load-failed', detail, cause };
  }
}
