// The exit table is the CLI's public contract, so it gets checked from both
// directions: the type system proves every registered code HAS an exit, and
// these prove the mapping did not drift into nonsense (M6-6).

import { DAEMON_ENVELOPE_ERROR_CODES, TASK_ERROR_CODES } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import {
  EXIT_FAILED,
  EXIT_INTERRUPTED,
  EXIT_MAP,
  EXIT_NO_DAEMON,
  EXIT_REFUSED,
  LOCAL_CLI_ERROR_CODES,
  exitCodeFor,
  isCliErrorCode,
} from './exit-codes.js';

describe('EXIT_MAP', () => {
  it('covers every daemon envelope code', () => {
    for (const code of DAEMON_ENVELOPE_ERROR_CODES) {
      expect(EXIT_MAP[code], `${code} has no exit code`).toBeTypeOf('number');
    }
  });

  it('covers every local code', () => {
    for (const code of LOCAL_CLI_ERROR_CODES) {
      expect(EXIT_MAP[code], `${code} has no exit code`).toBeTypeOf('number');
    }
  });

  it('has no entries that belong to neither registry', () => {
    // The other direction: a code mapped here but registered nowhere would be
    // one the CLI can never actually receive.
    const registered = new Set<string>([...DAEMON_ENVELOPE_ERROR_CODES, ...LOCAL_CLI_ERROR_CODES]);
    expect(Object.keys(EXIT_MAP).filter((code) => !registered.has(code))).toEqual([]);
  });

  it('uses only the seven documented exit codes', () => {
    const allowed = new Set([0, 1, 2, 3, 4, 5, 130]);
    for (const [code, exit] of Object.entries(EXIT_MAP)) {
      expect(allowed.has(exit), `${code} maps to ${exit}`).toBe(true);
    }
  });

  it('keeps the families that scripts branch on', () => {
    // 4 = "nothing is listening, start one"; 5 = "something IS there and
    // refuses". Confusing the two turns a retryable situation into a loop.
    expect(EXIT_MAP.DAEMON_UNAVAILABLE).toBe(EXIT_NO_DAEMON);
    expect(EXIT_MAP.DAEMON_RUNNING_BLOCKED).toBe(EXIT_REFUSED);
    expect(EXIT_MAP.DAEMON_OTHER_NEST).toBe(EXIT_REFUSED);
    expect(EXIT_MAP.WRITER_BUSY).toBe(EXIT_REFUSED);
    expect(EXIT_MAP.INTERRUPTED).toBe(EXIT_INTERRUPTED);
  });

  it('does not map task-only codes it can never receive on an envelope', () => {
    // Task codes live INSIDE a task object; a failed task is reported through
    // `TASK_FAILED` with the snapshot in details, never by translating the
    // task's own code (M6-6). Only the double-domain codes appear here, and
    // they appear because the ENVELOPE registry lists them.
    const envelope = new Set<string>(DAEMON_ENVELOPE_ERROR_CODES);
    const taskOnly = TASK_ERROR_CODES.filter((code) => !envelope.has(code));
    for (const code of taskOnly) {
      expect(Object.hasOwn(EXIT_MAP, code), `${code} should not be in EXIT_MAP`).toBe(false);
    }
  });
});

describe('exitCodeFor', () => {
  it('maps a registered code', () => {
    expect(exitCodeFor('USAGE_ERROR')).toBe(2);
  });

  it('falls back to a generic failure for a code from a newer daemon', () => {
    // Unreachable in practice — `toCliError` degrades unknown daemon codes to
    // HTTP_ERROR first — but the fallback must never be an exit 0.
    expect(exitCodeFor('SOMETHING_NEW')).toBe(EXIT_FAILED);
    expect(exitCodeFor(undefined)).toBe(EXIT_FAILED);
  });

  it('recognises registered codes and nothing else', () => {
    expect(isCliErrorCode('NOT_FOUND')).toBe(true);
    expect(isCliErrorCode('USAGE_ERROR')).toBe(true);
    expect(isCliErrorCode('FST_ERR_CTP_INVALID_MEDIA_TYPE')).toBe(false);
  });
});
