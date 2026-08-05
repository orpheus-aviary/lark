import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Absolute paths to the one-and-only React copy in this workspace (owl's
// workaround, ported preventively per the M4 plan §7 risk table) —
// @testing-library/react@16 + React 19 inside vitest's jsdom hit the
// "Cannot read properties of null (reading 'useState')" hook dispatcher bug
// unless every react / react-dom import resolves to the same module instance.
// dedupe alone isn't enough under pnpm's strict store; explicit aliases close
// the door.
const REACT = resolve(__dirname, '../../node_modules/react');
const REACT_DOM = resolve(__dirname, '../../node_modules/react-dom');

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [react()],
        resolve: {
          alias: {
            '@': resolve(__dirname, 'src/renderer/src'),
            react: REACT,
            'react-dom': REACT_DOM,
          },
          dedupe: ['react', 'react-dom'],
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/src/**/*.test.ts', 'src/renderer/src/**/*.test.tsx'],
          setupFiles: ['src/renderer/src/test-setup.ts'],
          server: {
            deps: {
              inline: [/@testing-library\//],
            },
          },
        },
      },
      {
        test: {
          name: 'main',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/preload/**/*.test.ts', 'src/shared/**/*.test.ts'],
        },
      },
    ],
  },
});
