// Turning what the user typed (or piped in) into inputs the daemon accepts
// (M6-11).
//
// Everything here is local and cheap, and that is the point: a 900-line file
// whose 40th line is 20 000 characters long should be rejected in a
// millisecond, naming the line, rather than after a round trip that comes back
// as `INVALID_BODY` about a request the user never composed.
//
// The numbers come from `@lark/shared` — the same constants the daemon rejects
// on — because the chunker's whole job is to build requests that fit, and two
// copies of "200 lines" drift the first time either moves.
//
// Line rules, frozen: one input per line, blank lines skipped, `#` starts a
// comment. Line NUMBERS are physical, so "第 7 行" means the seventh line of
// the file the user is looking at, not the seventh input.

import { createReadStream } from 'node:fs';
import {
  DOWNLOAD_BATCH_ITEMS_MAX,
  DOWNLOAD_INPUT_MAX,
  DOWNLOAD_PARSE_LINES_MAX,
} from '@lark/shared';
import { CliError, usageError } from './errors.js';

/**
 * Hard bounds on ONE `--batch` read. Not product limits: 1000 inputs is the
 * ceiling that matters (`DOWNLOAD_BATCH_ITEMS_MAX`), and these two only exist
 * so that pointing `--batch` at a 4GB file fails immediately instead of
 * filling memory on the way to the same refusal.
 */
export const BATCH_PHYSICAL_LINES_MAX = 50_000;
export const BATCH_BYTES_MAX = 5 * 1024 * 1024;

export interface InputLine {
  /** The trimmed text of the line. */
  text: string;
  /** 1-based PHYSICAL line number — what the user sees in an editor. */
  line: number;
}

/** Split a pasted blob into effective lines. */
export function collectLines(raw: string): InputLine[] {
  const lines: InputLine[] = [];
  raw.split('\n').forEach((text, index) => {
    const line = keep(text, index + 1);
    if (line !== null) lines.push(line);
  });
  return lines;
}

/** One physical line → an effective line, or nothing. */
function keep(text: string, line: number): InputLine | null {
  const trimmed = text.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return null;
  return { text: trimmed, line };
}

export interface BatchIo {
  /** Injected for tests; production reads the real stdin. */
  stdin?: AsyncIterable<Uint8Array | string>;
}

/** Read `--batch <file|->`. `-` is stdin, so a pipeline can feed the queue. */
export async function readBatchLines(source: string, io: BatchIo = {}): Promise<InputLine[]> {
  if (source === '-') {
    return await readLineSource(io.stdin ?? process.stdin);
  }
  try {
    return await readLineSource(createReadStream(source));
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError('NOT_FOUND', `读不了 ${source}：${message(err)}`, { path: source });
  }
}

/**
 * Consume a byte (or text) stream line by line.
 *
 * Streaming rather than "read it all, then split": the byte and line caps have
 * to be able to stop a runaway source, and a cap you only check after loading
 * the file is decoration.
 */
export async function readLineSource(
  source: AsyncIterable<Uint8Array | string>,
): Promise<InputLine[]> {
  const decoder = new TextDecoder();
  const lines: InputLine[] = [];
  let bytes = 0;
  let physical = 0;
  let pending = '';

  const take = (text: string): void => {
    physical += 1;
    if (physical > BATCH_PHYSICAL_LINES_MAX) {
      throw usageError(`批量输入最多 ${BATCH_PHYSICAL_LINES_MAX} 行。`);
    }
    const line = keep(text, physical);
    if (line !== null) lines.push(line);
  };

  for await (const chunk of source) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bytes > BATCH_BYTES_MAX) {
      throw usageError(`批量输入最大 ${BATCH_BYTES_MAX / 1024 / 1024}MB。`);
    }
    pending += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });

    for (let cut = pending.indexOf('\n'); cut !== -1; cut = pending.indexOf('\n')) {
      take(pending.slice(0, cut));
      pending = pending.slice(cut + 1);
    }
  }
  // Flush the decoder (a multi-byte character split across chunks) and the
  // last line, which a file need not terminate with a newline.
  pending += decoder.decode();
  if (pending !== '') take(pending);

  return lines;
}

/**
 * Everything that can be judged without asking the daemon anything.
 *
 * Reported with line numbers and ALL AT ONCE — fixing a 900-line file one
 * error per run is not a workflow.
 */
export function precheckLines(lines: readonly InputLine[]): void {
  const tooLong = lines.filter((line) => line.text.length > DOWNLOAD_INPUT_MAX);
  if (tooLong.length > 0) {
    throw usageError(
      `${describeLines(tooLong)}超过 ${DOWNLOAD_INPUT_MAX} 个字符——一行放一个链接或关键词。`,
      { lines: tooLong.map((line) => line.line) },
    );
  }
  if (lines.length === 0) {
    throw usageError('没有可下载的输入（空行和 # 开头的注释会被跳过）。');
  }
  if (lines.length > DOWNLOAD_BATCH_ITEMS_MAX) {
    throw usageError(
      `一次最多下载 ${DOWNLOAD_BATCH_ITEMS_MAX} 条，收到 ${lines.length} 条——分几次跑。`,
      { count: lines.length },
    );
  }
}

/**
 * Split the lines into `POST /download/parse` requests that fit.
 *
 * Two ceilings at once, because the daemon enforces both: at most
 * `DOWNLOAD_PARSE_LINES_MAX` lines per request, and the joined body no longer
 * than `DOWNLOAD_INPUT_MAX`. `precheckLines` has already guaranteed that every
 * single line fits on its own, so a chunk is never empty.
 */
export function chunkForParse(lines: readonly InputLine[]): InputLine[][] {
  const chunks: InputLine[][] = [];
  let current: InputLine[] = [];
  let length = 0;

  for (const line of lines) {
    // +1 for the newline joining it to what is already there.
    const grown = current.length === 0 ? line.text.length : length + 1 + line.text.length;
    if (
      current.length > 0 &&
      (current.length >= DOWNLOAD_PARSE_LINES_MAX || grown > DOWNLOAD_INPUT_MAX)
    ) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    length = current.length === 0 ? line.text.length : length + 1 + line.text.length;
    current.push(line);
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** `第 3、7、12 行`, truncated — a 400-entry list is not a message. */
export function describeLines(lines: readonly InputLine[]): string {
  const shown = lines.slice(0, 10).map((line) => line.line);
  const suffix = lines.length > shown.length ? ` 等 ${lines.length} 行` : ' 行';
  return `第 ${shown.join('、')}${suffix}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
