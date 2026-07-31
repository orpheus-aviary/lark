import { fileURLToPath } from 'node:url';
import { defaultDaemonBaseUrl } from '@lark/shared';
import { BrowserWindow, app, shell } from 'electron';

const preloadPath = fileURLToPath(new URL('../preload/index.mjs', import.meta.url));
const rendererHtml = fileURLToPath(new URL('../renderer/index.html', import.meta.url));

/** R10 — only http(s) links may leave the app. */
function openExternalIfSafe(url: string): void {
  const scheme = URL.parse(url)?.protocol;
  if (scheme === 'http:' || scheme === 'https:') void shell.openExternal(url);
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 600,
    minHeight: 400,
    show: false,
    webPreferences: {
      preload: preloadPath,
      sandbox: false,
      // M0 does not spawn the daemon (M4 does) — it only tells the renderer
      // where to find one.
      additionalArguments: [`--daemon-url=${defaultDaemonBaseUrl()}`],
    },
  });

  win.on('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) win.loadURL(devServerUrl);
  else win.loadFile(rendererHtml);

  return win;
}

await app.whenReady();
createWindow();

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
