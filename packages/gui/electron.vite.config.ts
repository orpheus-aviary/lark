import { fileURLToPath } from 'node:url';
import { DEFAULT_DAEMON_PORT } from '@lark/shared';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import type { Plugin } from 'vite';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

/**
 * Renderer CSP — single source of truth (M0-5).
 *
 * `index.html` deliberately carries no CSP meta of its own: multiple policies
 * intersect, so a second source can only ever tighten, never relax, and a
 * `session.webRequest` header can't loosen a meta policy either. Injecting here
 * keeps dev and production strategies in one place.
 *
 * `frame-ancestors` is omitted on purpose: browsers ignore it when delivered
 * via meta, so writing it would only buy false confidence. Nesting protection
 * belongs to the Electron layer (`will-navigate` / `setWindowOpenHandler`, M4).
 */
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  'media-src lark-media:',
  "object-src 'none'",
  "base-uri 'none'",
];

function contentSecurityPolicy(dev: boolean): string {
  // Dev additionally allows the Vite HMR socket, and inline scripts — the React
  // Fast Refresh preamble that @vitejs/plugin-react injects into index.html is
  // an inline module script. Production keeps `script-src 'self'`.
  const scriptSrc = dev ? "script-src 'self' 'unsafe-inline'" : "script-src 'self'";
  const connectSrc = dev
    ? `connect-src http://127.0.0.1:${DEFAULT_DAEMON_PORT} ws://localhost:* ws://127.0.0.1:*`
    : `connect-src http://127.0.0.1:${DEFAULT_DAEMON_PORT}`;
  return [...CSP_DIRECTIVES, scriptSrc, connectSrc].join('; ');
}

/**
 * Inject the CSP meta ahead of every script tag.
 *
 * `order: 'post'` matters: a meta CSP only governs what the parser sees AFTER
 * it, and @vitejs/plugin-react head-prepends its inline Fast Refresh preamble
 * from a `pre` hook. Running last means our `head-prepend` lands above that
 * preamble instead of below it.
 */
function cspPlugin(): Plugin {
  return {
    name: 'lark:csp',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: contentSecurityPolicy(ctx.server !== undefined),
              },
              injectTo: 'head-prepend',
            },
          ],
        };
      },
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: here('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: here('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: here('src/renderer'),
    plugins: [react(), cspPlugin()],
    resolve: {
      alias: { '@': here('src/renderer/src') },
    },
    build: {
      outDir: here('out/renderer'),
      rollupOptions: {
        input: { index: here('src/renderer/index.html') },
      },
    },
  },
});
