import { type ApiResponse, LOCAL_API_VERSION, type StatusData } from '@lark/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Backend } from '../backend/types.js';
import { runStatus } from './status.js';

const ENVELOPE: ApiResponse<StatusData> = {
  success: true,
  data: {
    status: 'ok',
    pid: 4242,
    uptime: 12.7,
    version: '0.1.0',
    nest_fingerprint: 'a'.repeat(64),
    local_api_version: LOCAL_API_VERSION,
  },
  message: 'daemon is running',
};

function backendReturning(envelope: ApiResponse<StatusData>): Backend {
  return { status: () => Promise.resolve(envelope) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lark status', () => {
  it('prints a human summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStatus(backendReturning(ENVELOPE), {});

    const output = log.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(output).toContain('online');
    expect(output).toContain('4242');
    expect(output).toContain('13s'); // uptime rounded
  });

  it('--json prints the raw envelope verbatim', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStatus(backendReturning(ENVELOPE), { json: true });

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(log.mock.calls[0][0] as string)).toEqual(ENVELOPE);
  });

  it('does not pretend the daemon is online when data is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runStatus(backendReturning({ success: true }), {});

    expect(log.mock.calls.map((args) => args.join(' ')).join('\n')).not.toContain('online');
  });
});
