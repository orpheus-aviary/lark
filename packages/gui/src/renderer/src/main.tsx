import { configureTransport, defaultDaemonBaseUrl } from '@lark/shared';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './style.css';

// Wire the shared transport to this host before anything renders. M2 adds the
// bearer header here, read fresh per call through the preload bridge.
configureTransport({
  baseUrl: () => window.larkAPI?.daemonUrl ?? defaultDaemonBaseUrl(),
});

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('lark: #root element not found');

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
