// Flags main injects via `webPreferences.additionalArguments`, parsed back out
// of `process.argv` by preload. One definition for both sides so the flag
// names can never drift apart.

export const DAEMON_URL_FLAG = '--daemon-url=';
export const DAEMON_TOKEN_PATH_FLAG = '--daemon-token-path=';

/** Value of `<flag><value>` in argv, or null when the flag is absent. */
export function argvValue(argv: readonly string[], flag: string): string | null {
  const hit = argv.find((arg) => arg.startsWith(flag));
  return hit ? hit.slice(flag.length) : null;
}
