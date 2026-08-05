// Electron wiring for lark-media:// (M4-6). All logic lives in
// media-handler.ts; this file only touches the Electron APIs.

import { readFileSync } from 'node:fs';
import { net, protocol } from 'electron';
import { MEDIA_SCHEME, createMediaRequestHandler } from './media-handler.js';

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
  protocol.handle(
    MEDIA_SCHEME,
    createMediaRequestHandler({
      daemonOrigin: opts.daemonOrigin,
      readToken: () => readFileSync(opts.tokenPath, 'utf8').trim(),
      // bypassCustomProtocolHandlers: the upstream hop must never re-enter
      // this handler (spike-verified).
      fetchUpstream: (url, init) =>
        net.fetch(url, { headers: init.headers, bypassCustomProtocolHandlers: true }),
    }),
  );
}
