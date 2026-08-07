import { ApiError } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { CliError, toCliError, usageError } from './errors.js';
import { exitCodeFor } from './exit-codes.js';

describe('toCliError', () => {
  it('passes a CliError through untouched', () => {
    const original = usageError('bad flag');
    expect(toCliError(original)).toBe(original);
  });

  it('adopts a registered daemon code', () => {
    const err = toCliError(new ApiError(404, 'NOT_FOUND', 'no such song', { id: 'abc' }));
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toEqual({ id: 'abc' });
    expect(exitCodeFor(err.code)).toBe(1);
  });

  it('degrades an unknown daemon code instead of dropping it', () => {
    // A newer daemon talking to an older CLI: the code travels on in details,
    // so the message stays actionable even though the mapping is missing.
    const err = toCliError(new ApiError(418, 'BREWING_COFFEE', 'nope'));
    expect(err.code).toBe('HTTP_ERROR');
    expect(err.details).toMatchObject({ daemon_code: 'BREWING_COFFEE', http_status: 418 });
  });

  it('keeps an unclassified failure verbatim', () => {
    const err = toCliError(new Error('EACCES: permission denied'));
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('EACCES: permission denied');
  });

  it('stringifies a non-Error throw', () => {
    expect(toCliError('boom').message).toBe('boom');
  });
});

describe('CliError', () => {
  it('carries code and details', () => {
    const err = new CliError('SONG_BUSY', 'busy', { song_id: 'x' });
    expect(err.name).toBe('CliError');
    expect(err.code).toBe('SONG_BUSY');
    expect(err.details).toEqual({ song_id: 'x' });
  });
});
