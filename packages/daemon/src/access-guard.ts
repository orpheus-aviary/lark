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

/**
 * Hostname out of a `Host` header, port stripped. IPv6 literals keep their
 * brackets (`[::1]:47100` → `[::1]`), which is the form the allowlist holds.
 */
function hostnameFromHostHeader(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

/**
 * Host header check — anti DNS-rebinding (M2, owl parity).
 *
 * CORS cannot stop this attack: a page on `evil.test` whose DNS resolves to
 * 127.0.0.1 sends SAME-ORIGIN requests as far as the browser is concerned, so
 * no Origin header is checked and no preflight happens. What distinguishes it
 * from a real local client is the `Host` header, which still says `evil.test`.
 * lark is loopback-only, so the allowlist is exactly the loopback names.
 * A missing Host is rejected: HTTP/1.1 requires it.
 */
export function isHostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  return LOOPBACK_HOSTNAMES.has(hostnameFromHostHeader(hostHeader));
}

/** `@fastify/cors` `origin` delegate. */
export function corsOriginDelegate(): (
  origin: string | undefined,
  cb: (err: Error | null, allow: boolean) => void,
) => void {
  return (origin, cb) => cb(null, isOriginAllowed(origin));
}
