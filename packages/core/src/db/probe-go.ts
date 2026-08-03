// Old Go daemon liveness probe (M1-8). Friendly-hint tier only — the real
// guard is the DB-level EXCLUSIVE lock in migrate-go. Everything derives from
// dbPath (owl probeDaemonPid convention), never from global paths, so fixture
// runs in a temp dir can't point at the real nest.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The Go-era daemon port (TS lark owns 47100; the Go app sat on 47020). */
export const GO_DAEMON_PORT = 47020;

/**
 * Read dirname(dbPath)/daemon.pid and return the pid iff that process is
 * actually alive. Stale pid files are removed on the way (owl behavior).
 */
export function probeGoDaemonPid(dbPath: string): number | null {
  const pidPath = join(dirname(dbPath), 'daemon.pid');
  if (!existsSync(pidPath)) return null;
  const raw = readFileSync(pidPath, 'utf-8').trim();
  const pid = Number(raw);
  if (!Number.isFinite(pid)) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    try {
      unlinkSync(pidPath);
    } catch {
      /* best-effort stale cleanup */
    }
    return null;
  }
}

export interface GoDaemonProbe {
  alive: boolean;
  detail: string;
}

/**
 * pid-file liveness plus a best-effort short-timeout GET on the Go daemon
 * port. The HTTP arm exists for the "daemon runs but pid file is gone" case;
 * connection refused resolves immediately.
 */
export async function probeGoDaemon(dbPath: string): Promise<GoDaemonProbe> {
  const pid = probeGoDaemonPid(dbPath);
  if (pid !== null) {
    return {
      alive: true,
      detail: `the Go lark daemon appears to be running (pid ${pid} from daemon.pid) — quit the Go app first`,
    };
  }
  try {
    const res = await fetch(`http://127.0.0.1:${GO_DAEMON_PORT}/status`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      return {
        alive: true,
        detail: `something is answering on 127.0.0.1:${GO_DAEMON_PORT}/status (the Go daemon port) — quit it first`,
      };
    }
  } catch {
    /* unreachable / timeout → treat as not alive */
  }
  return { alive: false, detail: '' };
}
