// The token seam (M6-15 / R29).
//
// The daemon mints a fresh token every boot and publishes it atomically at
// 0600. So the CLI READS THE FILE ON EVERY REQUEST rather than caching it at
// startup: a daemon restarted between two commands — or mid-`--wait` — rotates
// the token, and a cached copy would turn into a 401 storm the user cannot
// explain.
//
// One place reads it, so there is one place that could ever leak it. It never
// goes into a URL, a log line, an env var of a child process, or an error
// message.

import { readFileSync } from 'node:fs';
import { localTokenPath } from '@lark/core/paths';

/** The current local token, or null when there is no readable one. */
function readDaemonToken(tokenPath: string = localTokenPath()): string | null {
  try {
    const token = readFileSync(tokenPath, 'utf-8').trim();
    return token === '' ? null : token;
  } catch {
    // Missing (no daemon has ever run here) or unreadable (another user's
    // nest). Both mean "no token", and neither is worth a stack trace.
    return null;
  }
}

/** Authorization header for an authenticated call, or `{}` when there is none. */
export function daemonAuthHeaders(tokenPath?: string): Record<string, string> {
  const token = readDaemonToken(tokenPath);
  return token === null ? {} : { Authorization: `Bearer ${token}` };
}
