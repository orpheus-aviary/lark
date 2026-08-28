// Main window management (M4-4/M4-5): config-sized frame, hide-on-close on
// macOS (playback keeps running; remote commands keep executing), navigation
// containment, and the argv bridge that hands preload the daemon URL + token
// file path (never the token itself — R21).

import { fileURLToPath } from 'node:url';
import type { DesktopLyricsConfig } from '@lark/shared';
import { BrowserWindow, app, shell } from 'electron';
import { DAEMON_TOKEN_PATH_FLAG, DAEMON_URL_FLAG } from '../shared/argv.js';

const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url));
const rendererHtml = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
const lyricsHtml = fileURLToPath(new URL('../renderer/lyrics.html', import.meta.url));

/** R10 — only http(s) links may leave the app. Returns whether it opened one. */
export function openExternalIfSafe(url: string): boolean {
  const scheme = URL.parse(url)?.protocol;
  if (scheme !== 'http:' && scheme !== 'https:') return false;
  void shell.openExternal(url);
  return true;
}

// Cmd+Q flips this; the close handler consults it to tell "red X" (hide)
// from a real quit.
let quitting = false;
app.on('before-quit', () => {
  quitting = true;
});

export interface MainWindowOptions {
  width: number;
  height: number;
  daemonUrl: string;
  tokenPath: string;
}

export function createMainWindow(opts: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    minWidth: 600,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      additionalArguments: [
        `${DAEMON_URL_FLAG}${opts.daemonUrl}`,
        `${DAEMON_TOKEN_PATH_FLAG}${opts.tokenPath}`,
      ],
    },
  });

  win.on('ready-to-show', () => win.show());

  // macOS red X = hide, not close: the renderer (and with it the audio
  // element and the SSE command channel) stays alive. Cmd+Q really quits.
  win.on('close', (event) => {
    if (process.platform === 'darwin' && !quitting) {
      event.preventDefault();
      win.hide();
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  // M0-5's noted M4 debt: in-page navigation must never leave the app either.
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalIfSafe(url);
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(rendererHtml);

  return win;
}

/**
 * The floating lyric window (0.5.0 ⑤).
 *
 * 🔴 `'screen-saver'` RATHER THAN `alwaysOnTop: true`. The plain flag loses to
 * a full-screen app, which is exactly when somebody is watching something and
 * wants the words — the level is what puts it above one. `setVisibleOnAllWorkspaces`
 * with `visibleOnFullScreen` is the other half on macOS: a Space of its own is
 * where an always-on-top window otherwise ends up.
 *
 * NO DAEMON ARGUMENTS. This window never talks to the daemon (see
 * `shared/desktop-lyrics.ts`), so it is not handed a URL or a token path —
 * the preload's `daemonUrl` reads `null` here and its token getter has no file
 * to read.
 */
export function createDesktopLyricsWindow(config: DesktopLyricsConfig): BrowserWindow {
  const win = new BrowserWindow({
    x: config.x,
    y: config.y,
    width: config.width,
    height: config.height,
    // Frameless AND transparent: the words float, the window does not exist
    // as a rectangle. `hasShadow` off for the same reason — a shadow under
    // nothing is a grey smear over whatever is behind it.
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    resizable: true,
    // It is not a document. It belongs beside the app it came from, not in
    // the dock or the window menu.
    skipTaskbar: true,
    show: false,
    webPreferences: { preload: preloadPath, sandbox: false },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.on('ready-to-show', () => win.showInactive());

  // Same containment as the main window: nothing in here may navigate, and a
  // link — there are none today — leaves through the browser or not at all.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault();
    openExternalIfSafe(url);
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) void win.loadURL(`${devServerUrl}/lyrics.html`);
  else void win.loadFile(lyricsHtml);

  return win;
}
