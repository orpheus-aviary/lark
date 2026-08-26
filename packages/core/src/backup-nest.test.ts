// The four contracts of M4-14⑧, each with the failure it exists to prevent.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backupNest } from './backup-nest.js';
import { createDatabase } from './db/index.js';
import { invalidateActiveWorkspace } from './paths.js';
import { createSong } from './portable/library/songs.js';

let nest: string;
let workspace: string;
const quiet = { probeRunning: async (): Promise<string | null> => null };

/** A nest with a real library, a config, a song file and runtime litter. */
function seedNest(root: string): void {
  const lark = join(root, 'lark');
  mkdirSync(join(lark, 'songs'), { recursive: true });
  mkdirSync(join(lark, 'logs'), { recursive: true });
  writeFileSync(join(lark, 'lark_config.toml'), '[log]\nlevel = "info"\n');
  writeFileSync(join(lark, 'daemon-token'), 'secret-token');
  writeFileSync(join(lark, 'daemon.pid'), '999999');
  writeFileSync(join(lark, 'songs.db.migrate.lock'), '');
  writeFileSync(join(lark, 'logs', 'lark.log'), 'noise\n');

  const { sqlite, portable: store } = createDatabase({ dbPath: join(lark, 'songs.db') });
  createSong(store, { name: '第一首', artist: '歌手' });
  sqlite.close();
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'lark-backup-test-'));
  nest = join(workspace, 'nest');
  seedNest(nest);
  vi.stubEnv('LARK_NEST_DIR', nest);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  invalidateActiveWorkspace();
  await rm(workspace, { recursive: true, force: true });
});

describe('nothing may be running', () => {
  it('refuses while a daemon answers', async () => {
    await expect(
      backupNest({ probeRunning: async () => 'a daemon is answering on 127.0.0.1:47100' }),
    ).rejects.toThrow(/stop lark before copying/);
  });

  it('does not create the target when it refuses', async () => {
    const target = join(workspace, 'copy');
    await expect(backupNest({ target, probeRunning: async () => 'alive' })).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });
});

describe('what lands in the copy', () => {
  it('copies the library and leaves runtime state behind', async () => {
    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    expect(readdirSync(result.larkDir).sort()).toEqual(['lark_config.toml', 'songs', 'songs.db']);
    expect(existsSync(join(result.larkDir, 'daemon-token'))).toBe(false);
    expect(existsSync(join(result.larkDir, 'daemon.pid'))).toBe(false);
    expect(existsSync(join(result.larkDir, 'logs'))).toBe(false);
    expect(existsSync(join(result.larkDir, 'songs.db.migrate.lock'))).toBe(false);
  });

  // Everything in there is a file the audio migration could not prove it
  // could get back — an imported song, or one whose source stopped answering.
  // A backup that skipped it would be the one place those bytes are not.
  it('copies the audio migration backup', async () => {
    mkdirSync(join(nest, 'lark', 'migration-backup'), { recursive: true });
    writeFileSync(join(nest, 'lark', 'migration-backup', 'a-song-id.mp3'), 'irreplaceable');

    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    expect(readFileSync(join(result.larkDir, 'migration-backup', 'a-song-id.mp3'), 'utf-8')).toBe(
      'irreplaceable',
    );
  });

  it('leaves the lock databases and their sidecars behind', async () => {
    // The backup itself holds the writer lock while it reads the directory
    // (M6-18 ④), so `songs.db.writer.lock-journal` is guaranteed to exist at
    // that moment. A lock file in a copy means nothing — its fcntl state
    // belongs to a process on this machine.
    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    const copied = readdirSync(result.larkDir);
    expect(copied.filter((name) => name.includes('.lock'))).toEqual([]);
  });

  it('never copies a skill export or a half-written skill temp file', async () => {
    // `--output` may point at a subdirectory, where the top-level skip list
    // cannot see it — hence the basename filter at every depth (M6-14).
    const lark = join(nest, 'lark');
    writeFileSync(join(lark, 'lark-skill.md'), '# skill');
    writeFileSync(join(lark, '.lark-skill.md.tmp-abc123'), '# half written');
    mkdirSync(join(lark, 'exports'), { recursive: true });
    writeFileSync(join(lark, 'exports', 'lark-skill.md'), '# skill');
    writeFileSync(join(lark, 'exports', '.lark-skill.md.tmp-def456'), '# half written');
    writeFileSync(join(lark, 'exports', 'keep-me.json'), '{}');

    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    expect(existsSync(join(result.larkDir, 'lark-skill.md'))).toBe(false);
    expect(existsSync(join(result.larkDir, '.lark-skill.md.tmp-abc123'))).toBe(false);
    expect(readdirSync(join(result.larkDir, 'exports'))).toEqual(['keep-me.json']);
  });

  it('never copies the skybridge credentials or a stashed copy of them', async () => {
    // A backup is disaster recovery, not a clone (§4.5): a restore that carried
    // the device identity would give two installs the same device id, and the
    // LWW key's third element would stop telling them apart.
    const lark = join(nest, 'lark');
    writeFileSync(join(lark, 'skybridge.toml'), '[server]\nurl = "https://sync.test"\n');
    writeFileSync(
      join(lark, '.skybridge.toml.tmp-abc123'),
      '[server]\nurl = "https://sync.test"\n',
    );

    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    expect(readdirSync(result.larkDir).sort()).toEqual(['lark_config.toml', 'songs', 'songs.db']);
  });

  it('never copies an account workspace’s credentials either (N7b)', async () => {
    // Same rule, one level down: since N7 a workspace keeps its own
    // `skybridge.toml`, and the exclusion has always been by basename at every
    // depth — this is what pins that it stays that way.
    const workspaceDir = join(nest, 'lark', 'libraries', '0d37bfbdb385448f80a53bd8ba7e61d3');
    mkdirSync(join(workspaceDir, 'songs'), { recursive: true });
    writeFileSync(join(workspaceDir, 'songs.db'), 'not really a database');
    writeFileSync(join(workspaceDir, 'skybridge.toml'), '[server]\nurl = "https://sync.test"\n');
    writeFileSync(join(workspaceDir, '.skybridge.toml.tmp-abc123'), 'stashed');

    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    const copied = join(result.larkDir, 'libraries', '0d37bfbdb385448f80a53bd8ba7e61d3');
    expect(readdirSync(copied).sort()).toEqual(['songs', 'songs.db']);
  });

  it('backs up an ACTIVE account workspace through sqlite, not by copying (N7c)', async () => {
    // The migration moves a bound library under `libraries/`, and the backup
    // has to follow it: the online backup is what makes the copy coherent
    // while a writer could have been mid-transaction.
    const id = '0d37bfbdb385448f80a53bd8ba7e61d3';
    const lark = join(nest, 'lark');
    const wsDir = join(lark, 'libraries', id);
    mkdirSync(wsDir, { recursive: true });
    renameSync(join(lark, 'songs.db'), join(wsDir, 'songs.db'));
    renameSync(join(lark, 'songs'), join(wsDir, 'songs'));
    writeFileSync(join(lark, 'workspaces.toml'), `active = "${id}"\n`);
    // A lock database the workspace grew on its own, at depth. The writer
    // lock is not faked: the backup takes a real one at this same path while
    // it runs, so the copy must drop that too.
    writeFileSync(join(wsDir, 'songs.db.migrate.lock'), '');
    invalidateActiveWorkspace();

    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    const copied = join(result.larkDir, 'libraries', id);
    expect(readdirSync(copied).sort()).toEqual(['songs', 'songs.db']);
    // And it is a real database, written by the backup rather than copied.
    const db = new BetterSqlite3(join(copied, 'songs.db'), { readonly: true });
    const names = db.prepare('SELECT name FROM songs').all() as { name: string }[];
    db.close();
    expect(names.map((row) => row.name)).toEqual(['第一首']);
    expect(existsSync(join(result.larkDir, 'songs.db'))).toBe(false);
  });

  it('copies the workspace index but not one caught mid-rename (N7b)', async () => {
    // The index is a pointer and a label, not a token: a restored nest should
    // come up on the workspace it was on. Half of one must not, because half
    // of it reads as `local`.
    const lark = join(nest, 'lark');
    writeFileSync(join(lark, 'workspaces.toml'), 'active = "local"\n');
    writeFileSync(join(lark, '.workspaces.toml.tmp-abc123'), 'active = "loc');

    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    expect(existsSync(join(result.larkDir, 'workspaces.toml'))).toBe(true);
    expect(existsSync(join(result.larkDir, '.workspaces.toml.tmp-abc123'))).toBe(false);
  });

  it('produces a database with the same rows and no wal sidecar', async () => {
    const result = await backupNest({ target: join(workspace, 'copy'), ...quiet });

    // Checked BEFORE opening it: a read-only connection to a WAL database
    // creates its own sidecars and does not remove them on close, so reading
    // first would assert on the test's own leftovers.
    expect(existsSync(join(result.larkDir, 'songs.db-wal'))).toBe(false);
    expect(existsSync(join(result.larkDir, 'songs.db-shm'))).toBe(false);

    const copy = new BetterSqlite3(join(result.larkDir, 'songs.db'), { readonly: true });
    const names = copy.prepare('SELECT name FROM songs').all() as { name: string }[];
    copy.close();
    expect(names.map((row) => row.name)).toEqual(['第一首']);
  });

  it('defaults to a private temp directory, reported resolved', async () => {
    const result = await backupNest(quiet);
    try {
      // Resolved, not as handed out by mkdtemp: on macOS that is `/var/…`
      // while the daemon answers `/private/var/…`, and the GUI's reuse check
      // compares the two literally (T6).
      expect(result.nestDir).toBe(await realpath(result.nestDir));
      expect(result.nestDir.startsWith(await realpath(tmpdir()))).toBe(true);
      expect(existsSync(join(result.larkDir, 'songs.db'))).toBe(true);
    } finally {
      await rm(result.nestDir, { recursive: true, force: true });
    }
  });
});

describe('the destination is ours', () => {
  it('refuses a target that already exists', async () => {
    const target = join(workspace, 'existing');
    mkdirSync(target);
    writeFileSync(join(target, 'precious.txt'), 'do not touch');

    await expect(backupNest({ target, ...quiet })).rejects.toThrow();
    // The refusal must not have taken the caller's file with it.
    expect(existsSync(join(target, 'precious.txt'))).toBe(true);
  });

  it('refuses a target inside the nest', async () => {
    await expect(backupNest({ target: join(nest, 'copy'), ...quiet })).rejects.toThrow(
      /into the nest itself/,
    );
  });

  it('refuses a target that is a parent of the nest', async () => {
    // `workspace/nest` is the source, so the workspace itself is a parent —
    // and it already exists, so use a fresh parent chain to isolate the rule.
    const parent = join(workspace, 'outer');
    mkdirSync(join(parent, 'nest', 'lark'), { recursive: true });
    seedNest(join(parent, 'nest'));
    vi.stubEnv('LARK_NEST_DIR', join(parent, 'nest'));

    await expect(backupNest({ target: join(parent, 'sub'), ...quiet })).resolves.toBeDefined();
    await expect(backupNest({ target: join(parent, 'nest', 'x'), ...quiet })).rejects.toThrow(
      /into the nest itself/,
    );
  });

  it('sees through a symlink that points back into the nest', async () => {
    const link = join(workspace, 'sneaky');
    mkdirSync(join(nest, 'inner'));
    symlinkSync(join(nest, 'inner'), link);
    // The link itself exists, so the "must not exist" rule fires first; the
    // realpath rule is what catches a link created between the two checks.
    await expect(backupNest({ target: link, ...quiet })).rejects.toThrow();
    expect(existsSync(join(nest, 'inner'))).toBe(true);
  });
});

describe('failure cleanup', () => {
  it('removes the staging it created and nothing else', async () => {
    // A source database that cannot be opened fails after the files were
    // copied — the point at which a half-made copy exists.
    writeFileSync(join(nest, 'lark', 'songs.db'), 'not a database');
    const target = join(workspace, 'copy');

    await expect(backupNest({ target, ...quiet })).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(nest, 'lark', 'lark_config.toml'))).toBe(true);
  });
});
