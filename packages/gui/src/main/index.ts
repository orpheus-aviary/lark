// Electron main entry — orchestration only; every decision lives in the
// sibling modules. Order is contractual (M4-4): nest identity (mkdir →
// realpath) FIRST, then the single-instance lock carrying that identity, then
// scheme registration, all before app ready.

import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { loadConfig } from '@lark/core/config';
import { localTokenPath } from '@lark/core/paths';
import { defaultDaemonBaseUrl } from '@lark/shared';
import { type BrowserWindow, app, dialog, ipcMain, screen } from 'electron';
import type {
  DesktopLyricsChange,
  DesktopLyricsGesture,
  DesktopLyricsMessage,
} from '../shared/desktop-lyrics.js';
import { IPC_CHANNELS } from '../shared/ipc.js';
import { saveWindowSize } from './daemon-config.js';
import { DaemonManager, DaemonStartError } from './daemon-manager.js';
import { DesktopLyricsGestures, type GestureTarget } from './desktop-lyrics-gesture.js';
import { DesktopLyricsController, type DesktopLyricsWindow } from './desktop-lyrics-window.js';
import { registerDialogIpc } from './dialog-ipc.js';
import { installMediaProtocol, registerMediaScheme } from './media-protocol.js';
import { withMediaToolsDir } from './media-tools-dir.js';
import { ensureNestIdentity, nestDirFromAdditionalData } from './nest.js';
import { QuitCoordinator } from './quit.js';
import { WindowMemory } from './window-memory.js';
import { WindowRef } from './window-ref.js';
import { createDesktopLyricsWindow, createMainWindow } from './window.js';

const { realLarkDir } = ensureNestIdentity();

// The lock engages BEFORE the daemon identity check ever runs, so it must
// carry the nest identity itself: a second instance on a DIFFERENT nest must
// not be silently swallowed into focusing this window (M4-4, third review).
const isPrimary = app.requestSingleInstanceLock({ nest_dir: realLarkDir });
if (!isPrimary) {
  // showErrorBox is the one dialog that works before `ready` — an async
  // showMessageBox here would never appear (M4-4, fourth review).
  dialog.showErrorBox(
    'lark 已在运行',
    '另一个 lark 实例已经在运行，本实例将退出。若两者属于同一数据目录，已通知既有窗口聚焦。',
  );
  app.exit(0);
}

registerMediaScheme();

const daemonUrl = defaultDaemonBaseUrl();
const tokenPath = localTokenPath();
const manager = new DaemonManager({
  baseUrl: daemonUrl,
  realLarkDir,
  tokenPath,
  daemonCliPath: createRequire(import.meta.url).resolve('@lark/daemon/cli'),
  execPath: process.execPath,
  // Inherits LARK_NEST_DIR; the manager never adds a token (R29). A `bundled`
  // build additionally points the daemon at its own ffmpeg (M7-16).
  env: withMediaToolsDir(process.env, { resourcesPath: process.resourcesPath }),
  spawnImpl: (command, args, options) => spawn(command, args, options),
  readFileImpl: (path) => readFileSync(path, 'utf8'),
  realpathImpl: (path) => realpathSync(path),
  log: (msg) => console.log(msg),
});

/** Never dereferenced directly — see `window-ref.ts` for why. */
const windowRef = new WindowRef<BrowserWindow>();
let windowMemory: WindowMemory | null = null;

/**
 * The floating lyric window's lifecycle (⑤).
 *
 * Built here rather than inside `bootstrap` because the quit path needs it
 * too: an always-on-top window that outlived the app it belongs to would be a
 * strip of text nobody can close.
 */
const requestLyricsChange = (change: DesktopLyricsChange): void => {
  windowRef.live()?.webContents.send(IPC_CHANNELS.desktopLyricsChange, change);
};

/**
 * Dragging and resizing that window (判据 19's fix).
 *
 * `screen.getCursorScreenPoint()` is the measurement, not the renderer's event
 * coordinates: main already thinks in the same screen-space units the window's
 * own bounds are in, so there is no scale factor to get wrong.
 */
const lyricsGestures = new DesktopLyricsGestures(() => screen.getCursorScreenPoint());

const desktopLyrics = new DesktopLyricsController({
  create: (config) => {
    const win = createDesktopLyricsWindow(config, requestLyricsChange);
    const target: GestureTarget = {
      getBounds: () => win.getBounds(),
      setBounds: (bounds) => win.setBounds(bounds),
    };
    lyricsGestures.attach(target);
    const handle: DesktopLyricsWindow = {
      isDestroyed: () => win.isDestroyed(),
      destroy: () => win.destroy(),
      publish: (message) => {
        if (win.isDestroyed()) return;
        win.webContents.send(IPC_CHANNELS.desktopLyricsState, message);
      },
      setIgnoreMouseEvents: (ignore) => {
        if (win.isDestroyed()) return;
        // `forward: true` so the window still knows where the pointer is —
        // without it a locked window could never notice a hover, which is
        // what the unlocked one uses to show its controls.
        win.setIgnoreMouseEvents(ignore, { forward: true });
      },
    };
    win.on('closed', () => {
      lyricsGestures.detach(target);
      desktopLyrics.noteClosed(handle);
    });
    return handle;
  },
  // Closing it IS turning the feature off (see `desktop-lyrics-window.ts`),
  // so the answer outlives the launch. The main window owns the config, so it
  // is the one told; it writes the PATCH.
  onClosedByUser: () => requestLyricsChange({ enabled: false }),
});

// The lyric window's own controls, arriving through main because that window
// has no daemon to talk to.
ipcMain.on(IPC_CHANNELS.desktopLyricsChange, (_event, change: DesktopLyricsChange) => {
  requestLyricsChange(change);
});

// Held-button traffic, so it goes straight to the window rather than round
// through the main renderer's config: what is being asked for here is not a
// setting, it is where the window is RIGHT NOW. The resting place is written
// down by `window.ts`'s debounce, off the window's own move/resize events.
ipcMain.on(IPC_CHANNELS.desktopLyricsGesture, (_event, gesture: DesktopLyricsGesture) => {
  lyricsGestures.handle(gesture);
});

/** Take ownership of a window: remember its size, forget it when it is gone. */
function adoptWindow(win: BrowserWindow): void {
  windowMemory = rememberSize(win);
  windowRef.adopt(win, () => {
    windowMemory = null;
  });
}

app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
  const otherNest = nestDirFromAdditionalData(additionalData);
  if (otherNest !== realLarkDir) {
    // Never focus: focusing would tell the user "your other-nest lark is
    // open" when it is not.
    dialog.showErrorBox(
      '另一数据目录的 lark 试图启动',
      `本实例的数据目录：${realLarkDir}\n对方的数据目录：${otherNest ?? '(未知)'}\n每个数据目录同时只能有一个 lark 实例。`,
    );
    return;
  }
  const win = windowRef.live();
  if (win !== null) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});

/** Window size from config; a broken config must not block the window. */
function windowSize(): { width: number; height: number } {
  try {
    return loadConfig().window;
  } catch (err) {
    console.warn(`[config] load failed, using default window size: ${String(err)}`);
    return { width: 1024, height: 768 };
  }
}

/** Debounced size memory, written through the daemon's PATCH /config (M5-3). */
function rememberSize(win: BrowserWindow): WindowMemory {
  return new WindowMemory(win, {
    save: (size, timeoutMs) =>
      saveWindowSize(
        { baseUrl: daemonUrl, readToken: () => readFileSync(tokenPath, 'utf8').trim() },
        size,
        timeoutMs,
      ),
    log: (msg) => console.warn(msg),
  });
}

/**
 * NOT top-level await: Electron emits `ready` only after the ESM entry module
 * finishes evaluating, so awaiting `app.whenReady()` at the top level
 * deadlocks the app (M0 spike, Electron 43.2.0).
 */
async function bootstrap(): Promise<void> {
  await app.whenReady();

  try {
    const attachment = await manager.start();
    console.log(`[daemon] attached: ${attachment.kind} pid=${attachment.pid}`);
  } catch (err) {
    const message =
      err instanceof DaemonStartError ? err.userMessage : `daemon 启动失败：${String(err)}`;
    dialog.showErrorBox('无法连接 daemon', message);
    app.exit(1);
    return;
  }

  installMediaProtocol({ daemonOrigin: daemonUrl, tokenPath });

  // The floating lyric window (0.5.0 ⑤). Driven entirely by the main window:
  // it publishes the config AND what is playing in one message, so there is
  // one opinion about whether that window should exist rather than two
  // processes reading the same file at different times.
  ipcMain.on(IPC_CHANNELS.desktopLyricsPublish, (_event, message: DesktopLyricsMessage) => {
    desktopLyrics.apply(message.config);
    desktopLyrics.publish(message);
  });

  const { width, height } = windowSize();
  adoptWindow(createMainWindow({ width, height, daemonUrl, tokenPath }));
  // The dialogs open MODAL to the window, so they ask for the live one too.
  registerDialogIpc(() => windowRef.live());

  // Opening a different library (N7e). `relaunch` only registers what should
  // happen AFTER this process exits, so the quit below is the ordinary one —
  // `before-quit` still flushes the window size and stops the daemon this app
  // started, and the relaunch happens once that has finished. Doing it any
  // other way would leave a daemon holding the writer lock of a library the
  // new process is about to open.
  ipcMain.handle(IPC_CHANNELS.restartApp, () => {
    app.relaunch();
    app.quit();
  });

  app.on('activate', () => {
    // macOS dock click. Usually the window is merely hidden (red X hides,
    // M4-4) — but if it is gone, this is where it comes back.
    const win = windowRef.live();
    if (win !== null) win.show();
    else adoptWindow(createMainWindow({ width, height, daemonUrl, tokenPath }));
  });
}

void bootstrap();

// One quit sequence for both attachment modes (M5-3). The window size has to
// be written while the daemon is still up, which is why even a REUSED daemon
// now prevents the first quit — M4 let that case exit immediately.
const quitCoordinator = new QuitCoordinator({
  flushWindowSize: async () => {
    await windowMemory?.flush();
  },
  settleDaemonStart: () => manager.settle(),
  stopOwnedDaemon: () => manager.stop(),
  quit: () => app.quit(),
  log: (msg) => console.warn(msg),
});

app.on('before-quit', (event) => {
  // 🔴 BEFORE ANYTHING ELSE, and this is not tidiness. Electron closes every
  // window on the way out; a lyric window torn down by that route would report
  // itself closed, and "closed" means the person turned the feature off — so
  // quitting the app would silently switch the desktop lyrics off for good.
  // Taking it down ourselves is what makes that event ours rather than theirs.
  desktopLyrics.close();
  if (quitCoordinator.handleBeforeQuit()) event.preventDefault();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
