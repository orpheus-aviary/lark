// Electron wiring for lark-media:// (M4-6). All logic lives in
// media-handler.ts; this file only touches the Electron APIs.

import { readFileSync } from 'node:fs';
import { protocol, session } from 'electron';
import { MEDIA_SCHEME, createMediaRequestHandler } from './media-handler.js';

/**
 * Media streams get their OWN session, and therefore their own socket pool.
 *
 * Chromium allows six sockets per origin, and everything lark does speaks to
 * one origin: the SSE channel, every API call, and every ranged audio request
 * (the upstream hop of this handler runs on the app's session too). A media
 * element buffering a long file keeps several ranged responses open at once —
 * with canonical m4a it reliably holds all six — and the renderer then cannot
 * reach the daemon at all. accept-gui caught it as "the GUI never re-registers
 * after a daemon restart": the command channel could not get a socket, so the
 * GUI stayed offline for as long as the song kept playing. Audio was fine
 * throughout, which is what makes it nasty — nothing looks broken.
 *
 * In-memory partition (no `persist:` prefix): there is no state worth keeping,
 * the request carries a fresh Bearer token per call, and no cookies exist.
 */
const MEDIA_PARTITION = 'lark-media-upstream';

/**
 * Must run before app ready (M4-6①). `standard` gives the scheme a real
 * origin (host/path parsing the URL validation relies on); `stream` +
 * `supportFetchAPI` are what make <audio> issue ranged requests through the
 * handler.
 */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: MEDIA_SCHEME, privileges: { standard: true, stream: true, supportFetchAPI: true } },
  ]);
}

/** Install the handler (after ready). Token re-read per request (R29). */
export function installMediaProtocol(opts: { daemonOrigin: string; tokenPath: string }): void {
  // After `app.whenReady()`, which is where this is called from — a session
  // cannot be created earlier.
  const upstream = session.fromPartition(MEDIA_PARTITION);
  protocol.handle(
    MEDIA_SCHEME,
    createMediaRequestHandler({
      daemonOrigin: opts.daemonOrigin,
      readToken: () => readFileSync(opts.tokenPath, 'utf8').trim(),
      // `upstream.fetch`, not `net.fetch`: the session is what selects the
      // socket pool, and `net.fetch` is hard-wired to the default one — it
      // takes no session option, so passing one is silently ignored (verified
      // against electron.d.ts after exactly that mistake).
      //
      // bypassCustomProtocolHandlers: the upstream hop must never re-enter
      // this handler (spike-verified).
      fetchUpstream: (url, init) =>
        upstream.fetch(url, { headers: init.headers, bypassCustomProtocolHandlers: true }),
    }),
  );
}
