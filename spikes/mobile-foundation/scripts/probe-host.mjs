// HOST script (Node, desktop) — the peer the phone needs, plus a place to put
// results.
//
// Two jobs, both because of the release build:
//
//   1. Criterion 21 has three fetch rows that need a server to answer them
//      (a redirect that must NOT be followed, a 204, a body that arrives in
//      pieces). Pointing them at bilibili would make a platform question depend
//      on somebody else's uptime and rate limiting; pointing them here makes
//      the answer about `expo/fetch`. Plaintext HTTP over the loopback that
//      `adb reverse` provides — spike only (decision f).
//
//   2. Numeric criteria must run on a RELEASE build (§3.2a), where there is no
//      Metro and no dev menu. Reading two hundred numbers off a phone screen
//      with `screencap` is how transcription errors get into a plan document,
//      so the panels POST their results here and they land in `.runtime/` as
//      JSON.
//
//   node scripts/probe-host.mjs           # or: just spike-mobile-probe-host
//
// The device reaches it at http://localhost:8099 through `adb reverse`, which
// the just recipe sets up.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createSkybridgeClient, login } from '@orpheus-aviary/skybridge-client';

const PORT = Number(process.env.PROBE_PORT ?? 8099);
const OUT_DIR = fileURLToPath(new URL('../.runtime/', import.meta.url));
mkdirSync(OUT_DIR, { recursive: true });

const NETWORK_FIXTURES = `${OUT_DIR}network-fixtures.json`;
const SKYBRIDGE_HOST = `${OUT_DIR}skybridge-host.json`;

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

const readJson = (path) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    log(`could not read ${path}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
};

/**
 * The desktop's own skybridge client, for the SSE half of criterion 22.
 *
 * The event has to come from SOMEWHERE ELSE: a device that pushes a change and
 * then sees it arrive over SSE has not shown that the stream carries other
 * devices' work, and whether a server echoes a device to itself is the server's
 * business, not the platform's.
 */
let nudgeClient = null;
let nudgeSeq = 0;

async function nudgeChange() {
  const host = readJson(SKYBRIDGE_HOST);
  if (host === null) throw new Error('no .runtime/skybridge-host.json — run sync-host.mjs first');

  if (nudgeClient === null) {
    const auth = await login(host.hostBaseUrl, host.email, host.password);
    const bootstrap = createSkybridgeClient({ authContext: auth });
    const device = await bootstrap.registerDevice({
      name: 'desktop-nudge',
      appVersion: 'lark spike probe-host',
      clientVersion: '0.1.4',
    });
    const client = createSkybridgeClient({ authContext: auth, deviceId: device.id });
    const workspace = await client.ensureWorkspace(host.workspaceTool, host.workspaceName);
    nudgeClient = { client, workspaceId: workspace.id, deviceId: device.id };
    log(
      `nudge client ready: device ${device.id.slice(0, 8)}… workspace ${workspace.id.slice(0, 8)}…`,
    );
  }

  nudgeSeq += 1;
  const change = {
    clientChangeId: `nudge-${Date.now()}-${nudgeSeq}`,
    entityType: 'spike_nudge',
    entityId: `nudge-${nudgeSeq}`,
    op: 'update',
    payload: { from: 'desktop', seq: nudgeSeq, at: Date.now() },
    clientLocalSeq: nudgeSeq,
    clientCreatedAt: Date.now(),
    attachmentRefs: null,
  };
  const result = await nudgeClient.client.pushChanges(nudgeClient.workspaceId, [change]);
  return { pushed: change.clientChangeId, workspaceId: nudgeClient.workspaceId, result };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const path = url.pathname;

  if (req.method === 'POST' && path.startsWith('/results/')) {
    const name = path.slice('/results/'.length).replace(/[^a-zA-Z0-9._-]/g, '_') || 'result';
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `${OUT_DIR}${name}-${stamp}.json`;
      let pretty = body;
      try {
        pretty = JSON.stringify(JSON.parse(body), null, 2);
      } catch {
        // Not JSON; keep whatever arrived rather than losing it.
      }
      writeFileSync(file, pretty, 'utf-8');
      log(`← ${name}: ${body.length} bytes → ${file}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }

  // The N0b-4 fixtures, served rather than bundled: bilibili's stream URLs carry
  // a `deadline` about two hours out, so a fixture compiled into the app would
  // need a rebuild every time it went stale. The device asks for it at the
  // start of every network panel and reports its age.
  if (req.method === 'GET' && path === '/fixtures/network') {
    const network = readJson(NETWORK_FIXTURES);
    const skybridge = readJson(SKYBRIDGE_HOST);
    log(
      `→ /fixtures/network (bilibili ${network === null ? 'MISSING' : 'ok'}, ` +
        `skybridge ${skybridge === null ? 'MISSING' : 'ok'})`,
    );
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ network, skybridge, servedAt: Date.now() }));
    return;
  }

  // Criterion 22's soft half: make something happen in the workspace that the
  // device did not do itself, so its SSE subscription has something to receive.
  if (req.method === 'POST' && path === '/skybridge/nudge') {
    log('→ /skybridge/nudge');
    nudgeChange()
      .then((result) => {
        log(`  pushed ${result.pushed}`);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`  nudge failed: ${message}`);
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: message }));
      });
    return;
  }

  switch (path) {
    case '/health':
      log('→ /health');
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      return;

    // b23.tv's shape: core sends `redirect: 'manual'` and reads Location
    // instead of following (bilibili.ts:318,326).
    case '/redirect':
      log('→ /redirect');
      res.writeHead(302, { location: '/redirected' }).end();
      return;

    case '/redirected':
      res.writeHead(200, { 'content-type': 'text/plain' }).end('followed');
      return;

    // skybridge answers 204 to several calls (http.ts:77).
    case '/empty':
      log('→ /empty');
      res.writeHead(204).end();
      return;

    // SSE's shape without being SSE: a body that only arrives over time, so a
    // buffering implementation cannot fake its way through (sse.ts:43-47).
    case '/stream': {
      log('→ /stream');
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        res.write(`data: chunk ${sent}\n\n`);
        if (sent >= 5) {
          clearInterval(timer);
          res.end();
        }
      }, 120);
      res.on('close', () => clearInterval(timer));
      return;
    }

    default:
      res.writeHead(404, { 'content-type': 'text/plain' }).end('no such probe');
  }
});

server.listen(PORT, () => {
  log(`probe host on :${PORT} — results land in ${OUT_DIR}`);
  log('the device reaches it at http://localhost:8099 via `adb reverse`');
});
