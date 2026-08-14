import { configureTransport } from '@lark/shared';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { getPlatform } from './platform/index.js';
import { BootGate } from './session/BootGate.js';
import { applyThemeMode } from './theme/theme.js';
import './style.css';

// Wire the shared transport to this host before anything renders. The bearer
// header is read fresh per call through the preload bridge (R29) — a daemon
// restart's rotated token needs no reload. The token itself never reaches a
// URL, the DOM or a log line (R21).
const platform = getPlatform();
configureTransport({
  baseUrl: () => platform.daemonBaseUrl(),
  getAuthHeaders: () => {
    const token = platform.getDaemonToken();
    const headers: Record<string, string> = {};
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return headers;
  },
});

// Pre-paint guess so a dark-mode desktop never flashes a light first frame;
// App's effect takes over (and starts listening) once the config has loaded.
applyThemeMode('system');

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('lark: #root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {/* Nothing of the library mounts until the daemon says it is serving one
        (0.3.0 §3.2-2): during the audio migration every business route
        refuses, and App's stores fetch the moment they exist. */}
    <BootGate>
      <App />
    </BootGate>
  </React.StrictMode>,
);
