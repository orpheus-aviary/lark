// The one thing the main process writes to the daemon: the window size
// (M5-3). Kept separate from `window-memory.ts` so the policy (when to save)
// and the transport (how) are testable apart.
//
// The token is read fresh per request, like the media protocol does (R29): a
// daemon restart rotates it, and a cached copy would start answering 401 for
// the rest of the session.

import type { ConfigPatchRequest } from '@lark/shared';
import { API_PATHS } from '@lark/shared';
import type { WindowSize } from './window-memory.js';

export interface DaemonConfigDeps {
  baseUrl: string;
  readToken: () => string;
  fetchImpl?: typeof fetch;
}

/** PATCH the window section. Throws on anything but a 2xx. */
export async function saveWindowSize(
  deps: DaemonConfigDeps,
  size: WindowSize,
  timeoutMs: number,
): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const body: ConfigPatchRequest = { window: { width: size.width, height: size.height } };
  const response = await fetchImpl(`${deps.baseUrl}${API_PATHS.config}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${deps.readToken()}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`PATCH /config answered ${response.status}`);
}
