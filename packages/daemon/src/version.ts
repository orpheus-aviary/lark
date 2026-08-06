// Side-effect-free version constants (M4-2). The GUI main process imports this
// through the `@lark/daemon/version` subpath — the root barrel would drag in
// boot/server/core (and better-sqlite3) — so nothing else may live here.

/** Daemon package version — reported by `GET /status` and `--version`. Display only. */
export const DAEMON_VERSION = '0.1.0';

/**
 * Compatibility gate for the local HTTP protocol (M4-2). The GUI refuses to
 * reuse a running daemon whose `local_api_version` differs — the package
 * version can't carry that signal (it sits at 0.1.0 across protocol changes).
 * Bump on any breaking change to the daemon's local API.
 *
 * 2 (M5): the GUI now depends on `[theme]` in the config plus the M5 routes
 * (/cache, playlist import/export, ensure-file) — an M4 daemon has none of
 * them, so reuse must take the "stop the old instance" branch (M5-17).
 */
export const LOCAL_API_VERSION = 2;
