import type { ApiResponse } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { CliError } from './errors.js';
import { captureStreams, emitEnvelope, emitError, successEnvelope } from './output.js';

describe('successEnvelope', () => {
  it('omits absent optional fields rather than emitting nulls', () => {
    // A consumer branching on `"message" in envelope` should see the truth.
    expect(successEnvelope({ ok: true })).toEqual({ success: true, data: { ok: true } });
    expect(successEnvelope([], { total: 0 })).toEqual({ success: true, data: [], total: 0 });
  });
});

describe('emitEnvelope', () => {
  it('writes exactly one line to stdout', () => {
    const streams = captureStreams();
    emitEnvelope(streams, successEnvelope({ pid: 1 }, { message: 'hi' }));

    expect(streams.stdout).toHaveLength(1);
    expect(streams.stderr).toEqual([]);
    expect(JSON.parse(streams.stdout[0] as string)).toEqual({
      success: true,
      data: { pid: 1 },
      message: 'hi',
    });
  });

  it('preserves an HTTP envelope verbatim', () => {
    // `--json` reports what the daemon SAID — including `total` — rather than
    // a re-serialisation of the payload (M6-6).
    const fromDaemon: ApiResponse<number[]> = {
      success: true,
      data: [1, 2],
      message: 'ok',
      total: 2,
    };
    const streams = captureStreams();
    emitEnvelope(streams, fromDaemon);

    expect(JSON.parse(streams.stdout[0] as string)).toEqual(fromDaemon);
  });
});

describe('emitError', () => {
  it('--json writes one error envelope to stderr and nothing to stdout', () => {
    const streams = captureStreams();
    emitError(streams, new CliError('NOT_FOUND', 'no such song', { id: 'abc' }), { json: true });

    expect(streams.stdout).toEqual([]);
    expect(JSON.parse(streams.stderr[0] as string)).toEqual({
      success: false,
      error_code: 'NOT_FOUND',
      message: 'no such song',
      details: { id: 'abc' },
    });
  });

  it('human mode writes one line to stderr', () => {
    const streams = captureStreams();
    emitError(streams, new CliError('NOT_FOUND', 'no such song'), { json: false });

    expect(streams.stdout).toEqual([]);
    expect(streams.stderr).toHaveLength(1);
    expect(streams.stderr[0]).toContain('no such song');
    expect(streams.stderr[0]).toContain('NOT_FOUND');
  });

  it('leaves details out when there are none', () => {
    const streams = captureStreams();
    emitError(streams, new CliError('USAGE_ERROR', 'bad flag'), { json: true });

    expect(Object.hasOwn(JSON.parse(streams.stderr[0] as string), 'details')).toBe(false);
  });
});
