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
 */
export const LOCAL_API_VERSION = 1;
