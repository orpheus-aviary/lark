// Confirmation for destructive commands (M6-6 / M6-22).
//
// Three rules, and the reasons they are not negotiable:
//
//   `--json` ALWAYS requires `--yes`. A prompt in JSON mode would either
//     pollute the stream a caller is parsing or block an agent forever on a
//     question nobody will answer.
//   Non-TTY ALWAYS requires `--yes`. Same failure, different dress: a pipeline
//     that stops on an invisible question looks like a hang.
//   A TTY prompt answered "no" is `INTERRUPTED` (exit 130), following owl —
//     the user made a decision, and a decision is not an error to debug.

import { createInterface } from 'node:readline/promises';
import { CliError, usageError } from './errors.js';

export interface ConfirmOptions {
  /** `--yes` was passed. */
  yes: boolean;
  /** `--json` was passed: prompting is forbidden. */
  json: boolean;
  /** Whether stdin is a terminal. Injected so tests do not need one. */
  isTty?: boolean;
  /** Asks the question and reads a line. Injected for the same reason. */
  ask?: (question: string) => Promise<string>;
}

async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * Ask, or explain why it cannot. Returns normally when the action may proceed
 * and throws otherwise — so a caller cannot forget to check the answer.
 */
export async function confirm(prompt: string, opts: ConfirmOptions): Promise<void> {
  if (opts.yes) return;

  const isTty = opts.isTty ?? process.stdin.isTTY === true;

  if (opts.json) {
    throw usageError(`${prompt}\n--json 模式下不会询问：确认请显式加 --yes。`);
  }
  if (!isTty) {
    throw usageError(`${prompt}\n非交互环境下不会询问：确认请显式加 --yes。`);
  }

  const ask = opts.ask ?? promptLine;
  // The question goes to stderr (inside `ask`), so stdout stays reserved for
  // the result even in human mode.
  const answer = (await ask(`${prompt} [y/N] `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return;

  throw new CliError('INTERRUPTED', '已取消。');
}
