// Reading a secret from a person or a pipe (v0.2 T5).
//
// A password is the one input this CLI takes that must never be echoed, never
// land in a shell history and never sit in `argv` (where `ps` can read it), so
// there is no `--password` flag: it is either typed at a muted prompt or piped
// in with `--password-stdin`.
//
// The prompt rules match `confirm`, for the same reasons: `--json` forbids it
// (a question in a stream somebody is parsing), and a non-TTY forbids it (a
// pipeline that stops on an invisible question looks like a hang).

import { createInterface } from 'node:readline/promises';
import { usageError } from './errors.js';

export interface SecretOptions {
  /** Read the whole of stdin instead of prompting. */
  fromStdin: boolean;
  /** `--json` was passed: prompting is forbidden. */
  json: boolean;
  /** Whether stdin is a terminal. Injected so tests do not need one. */
  isTty?: boolean;
  /** Test seams. */
  readStdin?: () => Promise<string>;
  promptSecret?: (question: string) => Promise<string>;
}

/** Everything on stdin, with ONE trailing newline removed (`echo` adds it). */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString('utf-8')
    .replace(/\r?\n$/, '');
}

/**
 * Ask at the terminal without echoing.
 *
 * readline writes every keystroke to `output`; replacing that writer for the
 * duration of the question is what hides them. The prompt itself is written
 * synchronously by `question()`, so the mute goes on immediately AFTER the
 * call — mute it earlier and the question disappears too.
 */
async function promptSecretAtTty(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = rl.question(question);
  (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};
  try {
    return await answer;
  } finally {
    rl.close();
    // The muted newline the user typed never reached the terminal.
    process.stderr.write('\n');
  }
}

/** Read a secret, or explain why it cannot be read here. */
export async function readSecret(prompt: string, opts: SecretOptions): Promise<string> {
  if (opts.fromStdin) {
    const value = await (opts.readStdin ?? readAllStdin)();
    if (value === '') throw usageError('--password-stdin 读到的是空输入。');
    return value;
  }

  const isTty = opts.isTty ?? process.stdin.isTTY === true;
  if (opts.json) {
    throw usageError('--json 模式下不会提示输入密码：请用 --password-stdin 从标准输入传入。');
  }
  if (!isTty) {
    throw usageError('非交互环境下不会提示输入密码：请用 --password-stdin 从标准输入传入。');
  }

  const value = await (opts.promptSecret ?? promptSecretAtTty)(prompt);
  if (value === '') throw usageError('密码不能为空。');
  return value;
}
