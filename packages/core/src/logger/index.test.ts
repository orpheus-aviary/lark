// Verify the default pino redact paths actually mask the fields we care
// about. We don't construct `createLogger` directly (it spawns a pino-roll
// worker thread, awkward to capture synchronously) — a sibling pino instance
// with the same redact config and a Writable sink exercises the exact config
// both factories install (owl test pattern).

import { Writable } from 'node:stream';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LOG_REDACT_PATHS } from './index.js';

function makeCapture(): { logger: pino.Logger; output: () => string } {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString('utf-8'));
      cb();
    },
  });
  const logger = pino(
    {
      level: 'info',
      timestamp: false,
      redact: { paths: [...DEFAULT_LOG_REDACT_PATHS], censor: '[REDACTED]' },
    },
    sink,
  );
  return { logger, output: () => chunks.join('') };
}

describe('logger default redact paths (M1-15)', () => {
  it('exports the expected paths (regression — keep in sync with the plan list)', () => {
    expect([...DEFAULT_LOG_REDACT_PATHS]).toEqual([
      'token',
      '*.token',
      '*.auth.token',
      'authorization',
      'headers.authorization',
      'req.headers.authorization',
      'api_key',
      '*.api_key',
      'llm.api_key',
      '*.llm.api_key',
    ]);
  });

  it("masks the top-level `{ api_key }` shape (`*.api_key` alone can't)", () => {
    const { logger, output } = makeCapture();
    logger.info({ api_key: 'sk-top-secret' }, 'top-level');
    expect(output()).not.toContain('sk-top-secret');
    expect(output()).toContain('[REDACTED]');
  });

  it('masks `{ llm: { api_key } }` and one-owner `{ cfg: { api_key } }`', () => {
    const { logger, output } = makeCapture();
    logger.info({ llm: { api_key: 'sk-llm-secret', model: 'm1' } }, 'llm');
    logger.info({ cfg: { api_key: 'sk-cfg-secret' } }, 'cfg');
    expect(output()).not.toContain('sk-llm-secret');
    expect(output()).not.toContain('sk-cfg-secret');
    expect(output()).toContain('"model":"m1"'); // siblings stay visible
  });

  it('masks the deep `{ config: { llm: { api_key } } }` shape via `*.llm.api_key`', () => {
    const { logger, output } = makeCapture();
    logger.info({ config: { llm: { api_key: 'sk-deep-secret', url: 'https://x' } } }, 'deep');
    expect(output()).not.toContain('sk-deep-secret');
    expect(output()).toContain('https://x');
  });

  it('masks token shapes: top-level, one-owner, and `*.auth.token`', () => {
    const { logger, output } = makeCapture();
    logger.info({ token: 'tok-top' }, 'A');
    logger.info({ session: { token: 'tok-owned' } }, 'B');
    logger.info({ cfg: { auth: { token: 'tok-auth', user: 'u1' } } }, 'C');
    expect(output()).not.toContain('tok-top');
    expect(output()).not.toContain('tok-owned');
    expect(output()).not.toContain('tok-auth');
    expect(output()).toContain('"user":"u1"');
  });

  it('masks authorization header shapes', () => {
    const { logger, output } = makeCapture();
    logger.info({ authorization: 'Bearer A1' }, 'A');
    logger.info({ headers: { authorization: 'Bearer B2' } }, 'B');
    logger.info({ req: { headers: { authorization: 'Bearer C3' } } }, 'C');
    expect(output()).not.toContain('A1');
    expect(output()).not.toContain('B2');
    expect(output()).not.toContain('C3');
  });

  it('does NOT mask unrelated fields (no over-redaction)', () => {
    const { logger, output } = makeCapture();
    logger.info({ user_id: 'u_42', api_format: 'openai', url: 'https://x', kind: 'sync' }, 'noise');
    expect(output()).toContain('u_42');
    expect(output()).toContain('"api_format":"openai"');
    expect(output()).toContain('https://x');
    expect(output()).toContain('"kind":"sync"');
    expect(output()).not.toContain('[REDACTED]');
  });
});
