// The transport gate on a sync server URL (v0.2 T3a, §3.7 / §9).
//
// A login sends a password and receives a bearer token, so plaintext http is
// refused by default. Two exemptions, and only two:
//
//   loopback — the bytes never leave the machine, which is how the e2e suites
//     and a self-hosted server on the same host stay usable;
//   an explicit breaker — `allow_insecure_http`, confirmed twice in the UI
//     before it reaches here and recorded in the credential file so nobody
//     later wonders why a plaintext URL was accepted.
//
// Fails CLOSED on anything it cannot understand: a URL that does not parse, or
// one whose scheme is neither http nor https, is refused rather than passed
// through for the HTTP client to interpret its own way.

import { SyncInsecureUrlError } from '../errors.js';

/** Hosts whose plaintext traffic never reaches a network. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface SyncServerUrlOptions {
  /** The breaker. Only ever true after an explicit, confirmed opt-in. */
  allowInsecureHttp?: boolean;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * Validate and canonicalise a sync server URL.
 *
 * Canonical form is `origin + pathname` with any trailing slash removed:
 * `https://host/` and `https://host` are one server, and a sub-path deployment
 * (`https://host/skybridge`) has to survive because the client appends `/v1`
 * to whatever it is given. Query and fragment are dropped — a base URL has no
 * use for either, and keeping them would make two spellings of the same server
 * look different to a human reading the config file.
 */
export function normalizeSyncServerUrl(raw: string, options: SyncServerUrlOptions = {}): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SyncInsecureUrlError(
      `\`${trimmed}\` is not a URL — the sync server address must start with https://`,
    );
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SyncInsecureUrlError(
      `\`${trimmed}\` uses ${url.protocol.replace(':', '')} — a sync server must be https (or http on localhost)`,
    );
  }

  if (
    url.protocol === 'http:' &&
    !isLoopbackHost(url.hostname) &&
    options.allowInsecureHttp !== true
  ) {
    throw new SyncInsecureUrlError(
      `\`${trimmed}\` is plaintext http — your password and token would cross the network in the clear. Use https, or opt in explicitly with --allow-insecure-http.`,
    );
  }

  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}
