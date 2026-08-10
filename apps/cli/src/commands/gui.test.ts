import type { PlayerStatusResponse } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import type { CliError } from '../lib/errors.js';
import { fakeContext } from '../testing/fake-backend.js';
import { FakeChild, type FakeSpawn, fakeSpawn, virtualClock } from '../testing/fake-child.js';
import { type GuiDeps, runGui } from './gui.js';

const online = (gui_online: boolean): PlayerStatusResponse => ({
  gui_online,
  player: null,
  reported_at: null,
});

const deps = (spawn: FakeSpawn): GuiDeps => ({
  ...virtualClock(),
  spawnImpl: spawn.impl,
  command: () => ({ command: 'electron', args: ['gui'] }),
  waitMs: 100,
  pollMs: 10,
});

async function caught(fn: () => Promise<unknown>): Promise<CliError | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err as CliError;
  }
}

describe('lark gui', () => {
  it('is idempotent: an already-registered GUI is not a second window', async () => {
    const spawn = fakeSpawn();
    const ctx = fakeContext({ playerStatus: online(true) });
    await runGui(ctx, deps(spawn));

    expect(spawn.children).toHaveLength(0);
    expect(ctx.streams.stdout).toEqual(['✓ GUI 已经在运行']);
  });

  it('starts one detached and waits for it to register', async () => {
    const spawn = fakeSpawn();
    const ctx = fakeContext({ playerStatuses: [online(false), online(false), online(true)] });
    await runGui(ctx, deps(spawn));

    expect(spawn.children).toHaveLength(1);
    // Same hygiene as the daemon child: no pipes, or the parent CLI could not
    // exit after handing off (六轮④).
    expect(spawn.options[0]).toMatchObject({ detached: true, stdio: 'ignore' });
    expect(ctx.streams.stdout).toEqual(['✓ GUI 已启动']);
  });

  it('reports {launched, gui_online} under --json', async () => {
    const spawn = fakeSpawn();
    const ctx = fakeContext({ playerStatuses: [online(false), online(true)] }, { json: true });
    await runGui(ctx, deps(spawn));

    expect(JSON.parse(ctx.streams.stdout[0] as string).data).toEqual({
      launched: true,
      gui_online: true,
    });
  });

  it('gives up when the window never connects', async () => {
    const spawn = fakeSpawn();
    const ctx = fakeContext({ playerStatus: online(false) });
    expect((await caught(() => runGui(ctx, deps(spawn))))?.code).toBe('GUI_TIMEOUT');
  });

  it('says the GUI died rather than waiting out the whole budget', async () => {
    const spawn = fakeSpawn(new FakeChild(), true);
    const ctx = fakeContext({ playerStatus: online(false) });
    const err = await caught(() => runGui(ctx, deps(spawn)));

    expect(err?.code).toBe('GUI_ERROR');
    expect(err?.message).toContain('立刻退出');
  });
});

// M7-7: packaged, the child is `/usr/bin/open`, whose job is to hand the app
// to LaunchServices and return. Every packaged `lark gui` would fail on the
// dev rule ("it exited, so it crashed") before the window even appeared.
describe('lark gui, packaged', () => {
  const openCommand = () => ({
    command: '/usr/bin/open',
    args: ['/Applications/Lark.app'],
    expectsImmediateExit: true,
  });

  it('treats `open` returning 0 as handoff, not death', async () => {
    const spawn = fakeSpawn(new FakeChild(), true, 0);
    const ctx = fakeContext({ playerStatuses: [online(false), online(true)] });
    await runGui(ctx, { ...deps(spawn), command: openCommand });

    expect(ctx.streams.stdout).toEqual(['✓ GUI 已启动']);
  });

  // Non-zero still means the app could not be started at all — which is why
  // the exit CODE is kept and not just the fact of exiting (E9).
  it('reports a non-zero `open` as a failure to start the app', async () => {
    const spawn = fakeSpawn(new FakeChild(), true, 1);
    const ctx = fakeContext({ playerStatus: online(false) });
    const err = await caught(() => runGui(ctx, { ...deps(spawn), command: openCommand }));

    expect(err?.code).toBe('GUI_ERROR');
    expect(err?.message).toContain('LARK_APP_PATH');
  });
});
