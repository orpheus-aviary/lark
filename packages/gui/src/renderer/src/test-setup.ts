// Vitest renderer-project setup: a fake `window.larkAPI` for every test file
// (individual tests overwrite fields in their own beforeEach), the transport
// wired to the default port, and the DOM fakes jsdom lacks (M4 T2 seams).

import { configureTransport } from '@lark/shared';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';
import type { LarkApi } from '../../shared/lark-api.js';

configureTransport({ baseUrl: () => 'http://127.0.0.1:47100' });

// @testing-library/react@16 does NOT auto-cleanup under vitest. Without this,
// mounted DOMs from previous tests stack up and getByRole trips on duplicates.
afterEach(() => {
  cleanup();
});

function defaultLarkApi(): LarkApi {
  return {
    daemonUrl: 'http://127.0.0.1:47100',
    getDaemonToken: () => 'test-token',
    rendererPid: 4242,
    guiVersion: '0.0.0-test',
    pickAudio: vi.fn(() => Promise.resolve([])),
    openExternal: vi.fn(() => Promise.resolve(true)),
    pickJsonFile: vi.fn(() => Promise.resolve(null)),
    saveExportFile: vi.fn(() => Promise.resolve(true)),
    readLegal: vi.fn(() => Promise.resolve('MIT License\n\nCopyright (c) test')),
    openMigrationBackup: vi.fn(() => Promise.resolve(true)),
    restartApp: vi.fn(() => Promise.resolve()),
    publishDesktopLyrics: vi.fn(),
    onDesktopLyrics: vi.fn(() => () => {}),
    onDesktopLyricsClosed: vi.fn(() => () => {}),
  };
}

Object.defineProperty(window, 'larkAPI', {
  value: defaultLarkApi(),
  writable: true,
  configurable: true,
});

// jsdom lacks matchMedia / ResizeObserver / PointerEvent capture APIs and has
// a non-functional HTMLMediaElement. Minimal fakes here; tests that care
// about specifics override locally.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

if (!('ResizeObserver' in globalThis)) {
  class FakeResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    value: FakeResizeObserver,
  });
}

// radix-ui components call these on pointer interactions; jsdom has neither.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// HTMLMediaElement: jsdom throws "Not implemented" on play/pause. T4's player
// tests drive these fakes; they live here so EVERY renderer test survives an
// incidental <audio> mount.
Object.defineProperty(HTMLMediaElement.prototype, 'play', {
  writable: true,
  value: vi.fn(() => Promise.resolve()),
});
Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
  writable: true,
  value: vi.fn(),
});
Object.defineProperty(HTMLMediaElement.prototype, 'load', {
  writable: true,
  value: vi.fn(),
});
