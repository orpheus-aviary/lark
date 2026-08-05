// Main window management (M4-4/M4-5): config-sized frame, hide-on-close on
// macOS (playback keeps running; remote commands keep executing), navigation
// containment, and the argv bridge that hands preload the daemon URL + token
// file path (never the token itself — R21).

import { fileURLToPath } from 'node:url';
import { BrowserWindow, app, shell } from 'electron';
import { DAEMON_TOKEN_PATH_FLAG, DAEMON_URL_FLAG } from '../shared/argv.js';

const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url));
const rendererHtml = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

/** R10 — only http(s) links may leave the app. */
export function openExternalIfSafe(url: string): void {
  const scheme = URL.parse(url)?.protocol;
  if (scheme === 'http:' || scheme === 'https:') void shell.openExternal(url);
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
