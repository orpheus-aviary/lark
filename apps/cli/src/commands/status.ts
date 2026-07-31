import type { Backend } from '../backend/types.js';

export interface StatusOptions {
  /** Print the raw response envelope instead of a human-readable summary. */
  json?: boolean;
}

/** `lark status` — report whether the daemon answers and what it reports. */
export async function runStatus(backend: Backend, opts: StatusOptions): Promise<void> {
  const envelope = await backend.status();
  if (opts.json) {
    console.log(JSON.stringify(envelope, null, 2));
    return;
  }
  const data = envelope.data;
  if (!data) {
    console.log('daemon responded without status data');
    return;
  }
  console.log(`daemon: online (pid ${data.pid}, v${data.version})`);
  console.log(`uptime: ${Math.round(data.uptime)}s`);
}
