// Host adapter — a thin, live pass-through over the preload-injected
// `window.larkAPI` (owl's form). Every field is a live getter rather than a
// captured value: renderer tests mutate `window.larkAPI.*` between cases, and
// live reads keep the cached adapter in step with those mutations.
//
// lark is Electron-only (no web build), so there is exactly one adapter; the
// jsdom test environment provides a fake `window.larkAPI` in test-setup.

import { defaultDaemonBaseUrl } from '@lark/shared';

export interface PlatformAdapter {
  daemonBaseUrl(): string;
  /** Fresh token per call (R29); `null` when unavailable. */
  getDaemonToken(): string | null;
  readonly rendererPid: number;
  readonly guiVersion: string;
  pickMp3(): Promise<string[]>;
  /** Open an http(s) link in the browser; false if it was refused (R10). */
  openExternal(url: string): Promise<boolean>;
}

let cached: PlatformAdapter | undefined;

export function getPlatform(): PlatformAdapter {
  if (cached) return cached;
  cached = {
    daemonBaseUrl: () => window.larkAPI?.daemonUrl ?? defaultDaemonBaseUrl(),
    getDaemonToken: () => window.larkAPI.getDaemonToken(),
    get rendererPid() {
      return window.larkAPI.rendererPid;
    },
    get guiVersion() {
      return window.larkAPI.guiVersion;
    },
    pickMp3: () => window.larkAPI.pickMp3(),
    openExternal: (url) => window.larkAPI.openExternal(url),
  };
  return cached;
}
