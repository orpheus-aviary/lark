import { describe, expect, it, vi } from 'vitest';
import { confirm } from './confirm.js';
import type { CliError } from './errors.js';

const PROMPT = '删除 3 首歌？';

async function codeOf(fn: () => Promise<void>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

describe('confirm', () => {
  it('proceeds on --yes without asking anything', async () => {
    const ask = vi.fn();
    await confirm(PROMPT, { yes: true, json: false, isTty: true, ask });
    expect(ask).not.toHaveBeenCalled();
  });

  it('never prompts in --json mode, even on a TTY', async () => {
    // A prompt would either pollute the stream the caller is parsing or block
    // an agent on a question nobody will answer (M6-6).
    const ask = vi.fn();
    expect(await codeOf(() => confirm(PROMPT, { yes: false, json: true, isTty: true, ask }))).toBe(
      'USAGE_ERROR',
    );
    expect(ask).not.toHaveBeenCalled();
  });

  it('never prompts without a TTY', async () => {
    const ask = vi.fn();
    expect(
      await codeOf(() => confirm(PROMPT, { yes: false, json: false, isTty: false, ask })),
    ).toBe('USAGE_ERROR');
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([['y'], ['Y'], ['yes'], ['  yes  ']])('accepts %s', async (answer) => {
    await confirm(PROMPT, { yes: false, json: false, isTty: true, ask: async () => answer });
  });

  it.each([['n'], [''], ['no'], ['anything else']])(
    'treats %s as a decision, not an error to debug',
    async (answer) => {
      // owl's precedent: a user who said no gets 130, the interrupted code.
      expect(
        await codeOf(() =>
          confirm(PROMPT, { yes: false, json: false, isTty: true, ask: async () => answer }),
        ),
      ).toBe('INTERRUPTED');
    },
  );

  it('shows the prompt it was given', async () => {
    const ask = vi.fn(async (_question: string) => 'y');
    await confirm(PROMPT, { yes: false, json: false, isTty: true, ask });
    expect(ask.mock.calls[0]?.[0]).toContain(PROMPT);
  });
});
