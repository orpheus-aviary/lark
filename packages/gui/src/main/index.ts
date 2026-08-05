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
import { type BrowserWindow, app, dialog } from 'electron';
import { DaemonManager, DaemonStartError } from './daemon-manager.js';
import { registerDialogIpc } from './dialog-ipc.js';
import { installMediaProtocol, registerMediaScheme } from './media-protocol.js';
import { ensureNestIdentity, nestDirFromAdditionalData } from './nest.js';
import { createMainWindow } from './window.js';

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
  env: process.env, // inherits LARK_NEST_DIR; the manager never adds a token
  spawnImpl: (command, args, options) => spawn(command, args, options),
  readFileImpl: (path) => readFileSync(path, 'utf8'),
  realpathImpl: (path) => realpathSync(path),
  log: (msg) => console.log(msg),
});

let mainWindow: BrowserWindow | null = null;

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
  if (mainWindow !== null) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
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

  const { width, height } = windowSize();
  mainWindow = createMainWindow({ width, height, daemonUrl, tokenPath });
  registerDialogIpc(() => mainWindow);

  app.on('activate', () => {
    // macOS dock click: the window exists but is hidden (red X hides, M4-4).
    if (mainWindow !== null) mainWindow.show();
    else mainWindow = createMainWindow({ width, height, daemonUrl, tokenPath });
  });
}

void bootstrap();

// Stop the owned daemon (never a reused one — DaemonManager.stop() is a no-op
// then) before actually quitting. preventDefault once, resume after stop.
let daemonStopped = false;
app.on('before-quit', (event) => {
  if (manager.ownedPid !== null && !daemonStopped) {
    event.preventDefault();
    void manager.stop().finally(() => {
      daemonStopped = true;
      app.quit();
    });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
