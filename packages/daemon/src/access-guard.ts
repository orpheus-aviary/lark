/**
 * CORS origin allowlist for the local daemon.
 *
 * The GUI renderer is cross-origin to the daemon (dev → `http://localhost:5173`,
 * production `loadFile` → the literal Origin `null`), so a bare Fastify with no
 * CORS plugin makes the whole GUI link fail. owl solved the same problem with a
 * loopback allowlist; this is the lark equivalent, minus owl's cloud mode.
 *
 * "Reject" here means: the delegate answers false, @fastify/cors omits the
 * `Access-Control-Allow-Origin` header, and the route still runs. The plugin
 * does NOT produce a 403 — enforcement happens in the browser, which refuses to
 * hand the response body to the page. Endpoint authorisation is a separate
 * concern (Bearer token, M2).
 */

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** True when `origin` is an `http:` URL whose host is loopback. */
function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:') return false;
    return LOOPBACK_HOSTNAMES.has(url.hostname);
  } catch {
    return false;
  }
}

/** May a page at `origin` read responses from this daemon? */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true; // no Origin header — CLI / curl / same-origin
  if (origin === 'null') return true; // Electron production renderer (loadFile)
  return isLoopbackHttpOrigin(origin);
}

/** `@fastify/cors` `origin` delegate. */
export function corsOriginDelegate(): (
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean) => void,
) => void {
  return (origin, cb) => cb(null, isOriginAllowed(origin));
}
