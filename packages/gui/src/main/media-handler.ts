// lark-media:// request handling, ported from the M0 spike verbatim where the
// contract allows (M4-6; spike §6.3 is the porting record). Electron-free on
// purpose: the protocol wiring (`media-protocol.ts`) injects `net.fetch` and
// the token reader, so the whole status-code matrix is unit-testable under
// plain Node.

import { isUuidV4 } from '@lark/shared';

/** Registered before app ready by `media-protocol.ts`. */
export const MEDIA_SCHEME = 'lark-media';

/**
 * The ONLY response headers forwarded from the daemon (M4-6④). Everything
 * else — including any future cookie or diagnostic header — stops here.
 */
export const MEDIA_PASSTHROUGH_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
] as const;

/**
 * Strict URL validation (M4-6②): `lark-media://song/<uuid-v4>` and nothing
 * else — no credentials, no port, no query, no fragment, no extra path
 * segments, lowercase v4 only. Returns the song id, or null when anything is
 * off.
 */
export function songIdFromMediaUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${MEDIA_SCHEME}:`) return null;
  if (url.hostname !== 'song') return null;
  if (url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  const id = url.pathname.slice(1);
  if (url.pathname !== `/${id}`) return null;
  return isUuidV4(id) ? id : null;
}

export interface MediaHandlerDeps {
  /** `http://127.0.0.1:<port>` — the daemon the audio comes from. */
  daemonOrigin: string;
  /**
   * Fresh token per request (R29) — a daemon restart rotates the token and the
   * next range request must pick it up without an app restart. Throwing means
   * "token file unreadable" and maps to 503.
   */
  readToken: () => string;
  /** `net.fetch` with `bypassCustomProtocolHandlers` baked in (or a test fake). */
  fetchUpstream: (url: string, init: { headers: Record<string, string> }) => Promise<Response>;
}

/**
 * The protocol.handle() callback (M4-6③–⑤): validate → attach fresh token +
 * inbound Range verbatim → passthrough upstream status and the five headers.
 * 400 invalid URL / 503 token unreadable / 502 upstream unreachable; the
 * upstream's own 200/206/404/416 pass through untouched.
 */
export function createMediaRequestHandler(
  deps: MediaHandlerDeps,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const id = songIdFromMediaUrl(request.url);
    if (id === null) return new Response('invalid lark-media url', { status: 400 });

    let token: string;
    try {
      token = deps.readToken();
    } catch {
      return new Response('daemon token unavailable', { status: 503 });
    }

    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const range = request.headers.get('range');
    if (range !== null) headers.Range = range;

    let upstream: Response;
    try {
      upstream = await deps.fetchUpstream(`${deps.daemonOrigin}/audio/${id}`, { headers });
    } catch {
      return new Response('daemon unreachable', { status: 502 });
    }

    const out = new Headers();
    for (const name of MEDIA_PASSTHROUGH_HEADERS) {
      const value = upstream.headers.get(name);
      if (value !== null) out.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers: out });
  };
}
