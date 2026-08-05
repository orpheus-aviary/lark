import { describe, expect, it } from 'vitest';
import { DAEMON_TOKEN_PATH_FLAG, DAEMON_URL_FLAG, argvValue } from './argv.js';

describe('argvValue', () => {
  const argv = [
    '/apps/Electron',
    '--daemon-url=http://127.0.0.1:47100',
    '--daemon-token-path=/nest/lark/daemon-token',
  ];

  it('extracts each flag value', () => {
    expect(argvValue(argv, DAEMON_URL_FLAG)).toBe('http://127.0.0.1:47100');
    expect(argvValue(argv, DAEMON_TOKEN_PATH_FLAG)).toBe('/nest/lark/daemon-token');
  });

  it('returns null when the flag is absent', () => {
    expect(argvValue(['/apps/Electron'], DAEMON_URL_FLAG)).toBeNull();
  });

  it('returns the empty string for a bare flag, not null', () => {
    expect(argvValue(['--daemon-url='], DAEMON_URL_FLAG)).toBe('');
  });
});
