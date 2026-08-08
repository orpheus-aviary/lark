// Where a `-o / --output` actually writes (M6-13 / M6-14).
//
// Two commands take an output path — `playlist export` and `skill export` —
// and they must read it the same way, because the rule has a subtlety worth
// exactly one implementation:
//
//   a relative path resolves against the CURRENT DIRECTORY, not the nest
//     (`-o ./x.md` means what it says in a shell);
//   a path that IS a directory gets the default name appended;
//   a path that ENDS IN A SEPARATOR is a directory even when it does not exist
//     yet — the caller creates it. Judging by `existsSync` alone turns
//     `-o ~/backup/` into a FILE named `backup` the first time it is used
//     (T6 实测: skill export got ENOENT on the rename; playlist export would
//     have silently written the file under the directory's own name).

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export function resolveTargetPath(output: string, defaultName: string): string {
  const absolute = isAbsolute(output) ? output : resolve(process.cwd(), output);
  const asksForDirectory =
    output.endsWith('/') ||
    output.endsWith(sep) ||
    (existsSync(absolute) && statSync(absolute).isDirectory());

  return asksForDirectory ? join(absolute, defaultName) : absolute;
}
