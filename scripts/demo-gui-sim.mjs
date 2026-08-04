#!/usr/bin/env node
// A minimal stand-in for the GUI's daemon link, for M2 acceptance and as the
// reference the M4 renderer implements against.
//
// It exercises the whole single-consumer protocol end to end:
//   1. POST /gui/register  → a gui_instance_id
//   2. GET  /events?role=gui&gui_id=…  → the SSE stream
//   3. on `player:command` → POST /player/ack
//   4. on 409 GUI_REGISTRATION_REQUIRED (daemon restarted, registry empty) →
//      STOP retrying this id, register again, resubscribe. Retrying the dead
//      id would reconnect "successfully" forever while never receiving another
//      command.
//
// Usage:
//   node scripts/demo-gui-sim.mjs            # ack every command with ok
//   node scripts/demo-gui-sim.mjs --fail     # ack with ok:false (drives 502)
//   node scripts/demo-gui-sim.mjs --silent   # never ack (drives 504)
//   LARK_NEST_DIR=/tmp/nest node scripts/demo-gui-sim.mjs

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const BASE = 'http://127.0.0.1:47100';
const MODE = process.argv.includes('--fail')
  ? 'fail'
  : process.argv.includes('--silent')
    ? 'silent'
    : 'ok';

const larkDir = join(process.env.LARK_NEST_DIR || join(homedir(), 'orpheus-aviary-nest'), 'lark');

function readToken() {
  try {
    return readFileSync(join(larkDir, 'daemon-token'), 'utf-8').trim();
  } catch {
    console.error(`no daemon token at ${join(larkDir, 'daemon-token')} — is the daemon running?`);
    process.exit(1);
  }
}

const api = (path, init = {}) =>
  fetch(`${BASE}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${readToken()}`, ...init.headers },
  });

const postJson = (path, body) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function register() {
  const res = await postJson('/gui/register', { pid: process.pid, version: 'demo-gui-sim' });
  const body = await res.json();
  if (!res.ok) {
    console.error(`register failed: ${res.status} ${body.error_code} ${body.message}`);
    process.exit(1);
  }
  console.log(`registered: gui_instance_id=${body.data.gui_instance_id}`);
  return body.data.gui_instance_id;
}

/** Read one SSE stream to its end. Returns 'restart' when re-registration is due. */
async function subscribe(guiId) {
  const res = await api(`/events?role=gui&gui_id=${guiId}`, {
    headers: { accept: 'text/event-stream' },
  });
  if (res.status === 409) {
    const body = await res.json();
    console.log(`409 ${body.error_code} — registration is gone, registering again`);
    return 'restart';
  }
  if (!res.ok) {
    console.error(`subscribe failed: ${res.status}`);
    return 'retry';
  }
  console.log('subscribed; waiting for commands (Ctrl-C to stop)');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      sep = buffer.indexOf('\n\n');
      const dataLine = block.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      await handleEvent(JSON.parse(dataLine.slice(5).trim()));
    }
  }
  console.log('stream ended');
  return 'retry';
}

async function handleEvent(event) {
  if (event.type !== 'player:command') {
    console.log(`event: ${event.type}`);
    return;
  }
  const { request_id, type, ...command } = event;
  console.log(`command: ${JSON.stringify(command)}`);
  if (MODE === 'silent') {
    console.log('  (not acking — the daemon should answer 504 GUI_TIMEOUT)');
    return;
  }
  await postJson('/player/ack', {
    request_id,
    ok: MODE === 'ok',
    message: MODE === 'fail' ? 'demo-gui-sim was told to fail' : undefined,
  });
  console.log(`  acked ok=${MODE === 'ok'}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let guiId = await register();
while (true) {
  const outcome = await subscribe(guiId).catch((err) => {
    console.error(`stream error: ${err.message}`);
    return 'retry';
  });
  await sleep(1000);
  if (outcome === 'restart') guiId = await register();
}
