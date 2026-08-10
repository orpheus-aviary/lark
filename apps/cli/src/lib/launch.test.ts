import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeChild, fakeSpawn } from '../testing/fake-child.js';
import type { CliError } from './errors.js';
import {
  daemonLaunchCommand,
  guiLaunchCommand,
  launchDetached,
  resolveAppBundle,
  workspaceRoot,
} from './launch.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'lark-launch-'));
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as CliError).code;
  }
}

function touch(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
}

describe('workspaceRoot', () => {
  it('walks up to the workspace marker', () => {
    const deep = join(root, 'apps/cli/dist/lib');
    mkdirSync(deep, { recursive: true });
    expect(workspaceRoot(join(deep, 'launch.js'))).toBe(root);
  });

  it('says so rather than guessing when there is no workspace', () => {
    // M7 SEAM: a packaged `lark` lands here, and this message is what tells
    // the user (and us) that the locators still assume a checkout.
    expect(codeOf(() => workspaceRoot('/nonexistent/somewhere/lark'))).toBe('USAGE_ERROR');
  });
});

describe('daemonLaunchCommand', () => {
  it('runs the daemon CLI with THIS node', () => {
    touch(join(root, 'packages/daemon/dist/cli.js'));
    expect(daemonLaunchCommand({ root })).toEqual({
      command: process.execPath,
      args: [join(root, 'packages/daemon/dist/cli.js'), 'daemon'],
    });
  });

  it('names the build step when the daemon has not been built', () => {
    let message = '';
    try {
      daemonLaunchCommand({ root });
    } catch (err) {
      message = (err as CliError).message;
    }
    expect(message).toContain('just build-daemon');
  });
});

describe('guiLaunchCommand', () => {
  beforeEach(() => {
    touch(join(root, 'node_modules/electron/path.txt'));
    writeFileSync(
      join(root, 'node_modules/electron/path.txt'),
      'Electron.app/Contents/MacOS/Electron\n',
    );
  });

  it('reads the Electron binary out of the package, and points it at the built app', () => {
    // Read rather than imported: the CLI is not allowed to depend on electron
    // (M6-21), and it only needs the path.
    touch(join(root, 'packages/gui/out/main/index.js'));
    expect(guiLaunchCommand({ root })).toEqual({
      command: join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
      args: [join(root, 'packages/gui')],
    });
  });

  it('names the build step when the GUI has not been built', () => {
    let message = '';
    try {
      guiLaunchCommand({ root });
    } catch (err) {
      message = (err as CliError).message;
    }
    expect(message).toContain('just build-gui');
  });
});

describe('launchDetached', () => {
  it('spawns detached with no pipes, and lets go of the child', () => {
    const spawn = fakeSpawn();
    launchDetached({ command: 'node', args: ['x.js'] }, spawn.impl);

    expect(spawn.options[0]).toMatchObject({ detached: true, stdio: 'ignore' });
    // The environment is inherited whole — `LARK_NEST_DIR` above all, because
    // a child on a different nest than its parent is the worst outcome here.
    expect(spawn.options[0]?.env).toBe(process.env);
  });

  it('records an exit that arrives after the caller walked away', async () => {
    const child = new FakeChild();
    const launched = launchDetached({ command: 'node', args: [] }, fakeSpawn(child).impl);
    expect(launched.state.exited).toBe(false);

    child.emit('exit', 0, null);
    expect(launched.state.exited).toBe(true);
  });

  it('records a spawn error as an exit too', () => {
    const child = new FakeChild();
    const launched = launchDetached({ command: 'node', args: [] }, fakeSpawn(child).impl);

    child.emit('error', new Error('ENOENT'));
    expect(launched.state.error?.message).toBe('ENOENT');
    expect(launched.state.exited).toBe(true);
  });

  it('turns a throwing spawn into a reportable failure', () => {
    const code = codeOf(() =>
      launchDetached({ command: 'node', args: [] }, () => {
        throw new Error('EACCES');
      }),
    );
    expect(code).toBe('DAEMON_UNAVAILABLE');
  });
});

// ─── Packaged (M7-7) ───────────────────────────────────
//
// Every seam is injected, so none of this touches /Applications or cares
// where the test runner lives on disk.

const APP = '/Applications/Lark.app';
const DAEMON_IN = (app: string) =>
  `${app}/Contents/Resources/app/node_modules/@lark/daemon/dist/cli.js`;
const FFMPEG_IN = (app: string) => `${app}/Contents/Resources/ffmpeg`;

const withPaths =
  (...paths: string[]) =>
  (path: string) =>
    paths.includes(path);

describe('resolveAppBundle', () => {
  it('takes /Applications first', () => {
    expect(resolveAppBundle({ env: {}, home: '/Users/x', exists: withPaths(DAEMON_IN(APP)) })).toBe(
      APP,
    );
  });

  it('falls back to ~/Applications', () => {
    const user = '/Users/x/Applications/Lark.app';
    expect(
      resolveAppBundle({ env: {}, home: '/Users/x', exists: withPaths(DAEMON_IN(user)) }),
    ).toBe(user);
  });

  // An app bundle without the daemon inside looks perfectly normal from the
  // outside, and adopting it would fail much later with something unrelated.
  it('ignores a bundle that does not carry the daemon', () => {
    expect(codeOf(() => resolveAppBundle({ env: {}, home: '/Users/x', exists: () => false }))).toBe(
      'USAGE_ERROR',
    );
  });

  it('lets LARK_APP_PATH win', () => {
    const custom = '/Volumes/build/Lark.app';
    expect(
      resolveAppBundle({
        env: { LARK_APP_PATH: custom },
        home: '/Users/x',
        exists: withPaths(DAEMON_IN(custom), DAEMON_IN(APP)),
      }),
    ).toBe(custom);
  });

  // Fail-fast, never fall through (E16): whoever set the variable wants THAT
  // bundle, and silently using another one is how you debug the wrong copy.
  it('refuses a LARK_APP_PATH that is not usable, instead of looking elsewhere', () => {
    expect(
      codeOf(() =>
        resolveAppBundle({
          env: { LARK_APP_PATH: '/tmp/nope.app' },
          home: '/Users/x',
          exists: withPaths(DAEMON_IN(APP)),
        }),
      ),
    ).toBe('USAGE_ERROR');
  });
});

describe('daemonLaunchCommand (packaged)', () => {
  it("runs the bundle's own Electron as node, on the bundle's own daemon", () => {
    const command = daemonLaunchCommand({
      packaged: true,
      env: {},
      home: '/Users/x',
      exists: withPaths(DAEMON_IN(APP)),
    });
    expect(command).toEqual({
      command: `${APP}/Contents/MacOS/Lark`,
      args: [DAEMON_IN(APP), 'daemon'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('points a bundled build at its own ffmpeg', () => {
    const command = daemonLaunchCommand({
      packaged: true,
      env: {},
      home: '/Users/x',
      exists: withPaths(DAEMON_IN(APP), FFMPEG_IN(APP)),
    });
    expect(command.env).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      LARK_MEDIA_TOOLS_DIR: FFMPEG_IN(APP),
    });
  });

  // A `system` build says nothing, and the daemon falls through to Homebrew.
  it('says nothing about ffmpeg when the build carries none', () => {
    const command = daemonLaunchCommand({
      packaged: true,
      env: {},
      home: '/Users/x',
      exists: withPaths(DAEMON_IN(APP)),
    });
    expect(command.env?.LARK_MEDIA_TOOLS_DIR).toBeUndefined();
  });
});

describe('guiLaunchCommand (packaged)', () => {
  // `open <path>`, never `open -a Lark`: `-a` lets LaunchServices choose, and
  // it can choose a different copy than the daemon just came out of.
  it('opens the same bundle the daemon resolved, by path', () => {
    expect(
      guiLaunchCommand({
        packaged: true,
        env: {},
        home: '/Users/x',
        exists: withPaths(DAEMON_IN(APP)),
      }),
    ).toEqual({
      command: '/usr/bin/open',
      args: [APP],
      expectsImmediateExit: true,
    });
  });
});
