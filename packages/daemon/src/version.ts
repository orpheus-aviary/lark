// Side-effect-free version constants (M4-2). The GUI main process imports this
// through the `@lark/daemon/version` subpath — the root barrel would drag in
// boot/server/core (and better-sqlite3) — so nothing else may live here.

/** Daemon package version — reported by `GET /status` and `--version`. Display only. */
export const DAEMON_VERSION = '0.3.0';

// The protocol gate moved into the wire contract in M6 (the CLI compares it
// too, and must not depend on this package). Re-exported here so the GUI's
// `@lark/daemon/version` import keeps working unchanged.
export { LOCAL_API_VERSION } from '@lark/shared';
