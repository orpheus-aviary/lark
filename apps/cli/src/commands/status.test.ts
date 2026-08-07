import { LOCAL_API_VERSION, type StatusData } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/errors.js';
import { exitCodeFor } from '../lib/exit-codes.js';
import type { DaemonIdentity } from '../lib/identity.js';
import { captureStreams } from '../lib/output.js';
import { type StatusReport, runStatus } from './status.js';

const STATUS: StatusData = {
  status: 'ok',
  pid: 4242,
  uptime: 12.7,
  version: '0.1.0',
  nest_fingerprint: 'a'.repeat(64),
  local_api_version: LOCAL_API_VERSION,
};

const CURRENT: DaemonIdentity = { state: 'current', status: STATUS, pid: STATUS.pid };

async function runWith(identity: DaemonIdentity, json: boolean) {
  const streams = captureStreams();
  let error: CliError | null = null;
  try {
    await runStatus({ identity: async () => identity, streams }, { json });
  } catch (err) {
    error = err as CliError;
  }
  return { streams, error };
}

describe('lark status — current', () => {
  it('prints a human summary', async () => {
    const { streams, error } = await runWith(CURRENT, false);

    expect(error).toBeNull();
    expect(streams.stdout.join('\n')).toContain('online');
    expect(streams.stdout.join('\n')).toContain('4242');
    expect(streams.stdout.join('\n')).toContain('13s'); // uptime rounded
    expect(streams.stderr).toEqual([]);
  });

  it('--json prints exactly one success envelope on stdout', async () => {
    const { streams, error } = await runWith(CURRENT, true);

    expect(error).toBeNull();
    expect(streams.stdout).toHaveLength(1);
    expect(streams.stderr).toEqual([]);
    const envelope = JSON.parse(streams.stdout[0] as string) as {
      success: boolean;
      data: StatusReport;
    };
    expect(envelope.success).toBe(true);
    // The daemon's own payload, plus how we read it — a consumer should not
    // have to re-derive "is this MY daemon" from the fields.
    expect(envelope.data).toEqual({ ...STATUS, identity: 'current' });
  });
});

describe('lark status — everything else is an error', () => {
  // The frozen contract (M6-22): only `current` is a success, so a script's
  // rule stays "exit 0 ⇔ stdout has an envelope" rather than "parse the
  // status field to find out whether status succeeded".
  it.each([
    [{ state: 'absent' } as DaemonIdentity, 'DAEMON_UNAVAILABLE', 4],
    [
      { state: 'other-nest', pid: 9, fingerprint: 'b'.repeat(64) } as DaemonIdentity,
      'DAEMON_OTHER_NEST',
      5,
    ],
    [
      { state: 'same-nest-incompatible', pid: 9, remoteApiVersion: 2 } as DaemonIdentity,
      'DAEMON_INCOMPATIBLE',
      5,
    ],
    [
      { state: 'occupied-unverifiable', reason: 'pid-file-live', pid: 9 } as DaemonIdentity,
      'DAEMON_UNVERIFIED',
      5,
    ],
  ])('%o → %s (exit %i), with nothing on stdout', async (identity, code, exit) => {
    const { streams, error } = await runWith(identity, true);

    expect(streams.stdout).toEqual([]);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(code);
    expect(exitCodeFor((error as CliError).code)).toBe(exit);
  });

  it('carries the diagnosis in details.identity', async () => {
    const { error } = await runWith(
      { state: 'same-nest-incompatible', pid: 77, remoteApiVersion: 2 },
      true,
    );

    expect((error as CliError).details?.identity).toMatchObject({
      state: 'same-nest-incompatible',
      pid: 77,
      fingerprint_match: true,
      remote_api_version: 2,
      local_api_version: LOCAL_API_VERSION,
    });
  });
});
