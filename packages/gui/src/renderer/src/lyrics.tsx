// The floating lyric window's entry (0.5.0 ⑤).
//
// A SECOND RENDERER WITH ONE JOB, and almost nothing of the first one: no
// transport, no stores, no theme — it is told what to draw over IPC and draws
// it. `configureTransport` is deliberately absent: this window has no daemon
// URL and no token (see `main/window.ts`), and a transport configured against
// nothing would turn a missing feature into a failing request.

import React from 'react';
import ReactDOM from 'react-dom/client';
import { DesktopLyrics } from './desktop-lyrics/DesktopLyrics.js';
import './desktop-lyrics/lyrics.css';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('lark: #root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <DesktopLyrics />
  </React.StrictMode>,
);
