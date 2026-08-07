import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DOWNLOAD_BATCH_ITEMS_MAX,
  DOWNLOAD_INPUT_MAX,
  DOWNLOAD_PARSE_LINES_MAX,
} from '@lark/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BATCH_BYTES_MAX,
  BATCH_PHYSICAL_LINES_MAX,
  type InputLine,
  chunkForParse,
  collectLines,
  describeLines,
  precheckLines,
  readBatchLines,
  readLineSource,
} from './download-input.js';
import type { CliError } from './errors.js';

async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

function codeOfSync(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

const lines = (...texts: string[]): InputLine[] =>
  texts.map((text, index) => ({ text, line: index + 1 }));

describe('collectLines', () => {
  it('drops blanks and comments, and keeps PHYSICAL line numbers', async () => {
    // The numbers are what an error message points at, so they have to survive
    // the lines that got dropped.
    const collected = collectLines('\n# a note\n  BV1  \n\n关键词\n');
    expect(collected).toEqual([
      { text: 'BV1', line: 3 },
      { text: '关键词', line: 5 },
    ]);
  });

  it('treats a single input as one line', () => {
    expect(collectLines('周杰伦 晴天')).toEqual([{ text: '周杰伦 晴天', line: 1 }]);
  });
});

describe('readLineSource', () => {
  it('joins lines split across chunk boundaries', async () => {
    const collected = await readLineSource(
      Readable.from([Buffer.from('BV1\nBV'), Buffer.from('2\nBV3')]),
    );
    expect(collected.map((line) => line.text)).toEqual(['BV1', 'BV2', 'BV3']);
  });

  it('decodes a multi-byte character split across chunks', async () => {
    // 晴 is three UTF-8 bytes; cutting it in half must not produce U+FFFD.
    const bytes = Buffer.from('晴天\n');
    const collected = await readLineSource(
      Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]),
    );
    expect(collected[0]?.text).toBe('晴天');
  });

  it('keeps a last line with no trailing newline, and strips CR', async () => {
    const collected = await readLineSource(Readable.from(['BV1\r\nBV2']));
    expect(collected.map((line) => line.text)).toEqual(['BV1', 'BV2']);
  });

  it('refuses a source over the byte cap', async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x61);
    const chunks = Array.from({ length: BATCH_BYTES_MAX / chunk.byteLength + 1 }, () => chunk);
    expect(await codeOf(() => readLineSource(Readable.from(chunks)))).toBe('USAGE_ERROR');
  });

  it('refuses a source over the physical-line cap', async () => {
    const text = `${'\n'.repeat(BATCH_PHYSICAL_LINES_MAX)}x\n`;
    expect(await codeOf(() => readLineSource(Readable.from([text])))).toBe('USAGE_ERROR');
  });
});

describe('readBatchLines', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lark-cli-batch-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a file', async () => {
    const path = join(dir, 'inputs.txt');
    writeFileSync(path, '# 收藏\nBV1\nBV2\n');
    expect((await readBatchLines(path)).map((line) => line.text)).toEqual(['BV1', 'BV2']);
  });

  it('reports a missing file as NOT_FOUND, with the path', async () => {
    expect(await codeOf(() => readBatchLines(join(dir, 'nope.txt')))).toBe('NOT_FOUND');
  });

  it('reads stdin for `-`', async () => {
    const collected = await readBatchLines('-', { stdin: Readable.from(['BV1\nBV2\n']) });
    expect(collected).toHaveLength(2);
  });
});

describe('precheckLines', () => {
  it('accepts a normal paste', () => {
    expect(codeOfSync(() => precheckLines(lines('BV1', '晴天')))).toBeNull();
  });

  it('rejects an over-long line and names every offender', () => {
    const long = 'x'.repeat(DOWNLOAD_INPUT_MAX + 1);
    let caught: CliError | undefined;
    try {
      precheckLines(lines('ok', long, 'ok', long));
    } catch (err) {
      caught = err as CliError;
    }
    expect(caught?.code).toBe('USAGE_ERROR');
    expect(caught?.details).toEqual({ lines: [2, 4] });
  });

  it('rejects an empty selection — blanks and comments only', () => {
    expect(codeOfSync(() => precheckLines([]))).toBe('USAGE_ERROR');
  });

  it('rejects more inputs than one batch may carry', () => {
    const many = lines(...Array.from({ length: DOWNLOAD_BATCH_ITEMS_MAX + 1 }, () => 'BV1'));
    expect(codeOfSync(() => precheckLines(many))).toBe('USAGE_ERROR');
  });
});

describe('chunkForParse', () => {
  it('keeps one request when everything fits', () => {
    expect(chunkForParse(lines('BV1', 'BV2'))).toHaveLength(1);
  });

  it('splits on the line ceiling', () => {
    const many = lines(...Array.from({ length: DOWNLOAD_PARSE_LINES_MAX + 1 }, () => 'BV1'));
    const chunks = chunkForParse(many);
    expect(chunks.map((chunk) => chunk.length)).toEqual([DOWNLOAD_PARSE_LINES_MAX, 1]);
  });

  it('splits on the byte ceiling, counting the joining newlines', () => {
    const half = 'x'.repeat(DOWNLOAD_INPUT_MAX / 2);
    const chunks = chunkForParse(lines(half, half, half));
    // Two halves plus a newline already exceed the ceiling.
    expect(chunks.map((chunk) => chunk.length)).toEqual([1, 1, 1]);
    for (const chunk of chunks) {
      expect(chunk.map((line) => line.text).join('\n').length).toBeLessThanOrEqual(
        DOWNLOAD_INPUT_MAX,
      );
    }
  });

  it('never emits an empty chunk', () => {
    // Every chunk turns into one request body; an empty one would be a 400.
    const maximal = 'x'.repeat(DOWNLOAD_INPUT_MAX);
    expect(chunkForParse(lines(maximal, maximal))).toEqual([
      [{ text: maximal, line: 1 }],
      [{ text: maximal, line: 2 }],
    ]);
  });
});

describe('describeLines', () => {
  it('lists the numbers', () => {
    expect(describeLines(lines('a', 'b'))).toBe('第 1、2 行');
  });

  it('truncates a long list rather than printing 400 numbers', () => {
    const many = lines(...Array.from({ length: 30 }, () => 'x'));
    expect(describeLines(many)).toBe('第 1、2、3、4、5、6、7、8、9、10 等 30 行');
  });
});
