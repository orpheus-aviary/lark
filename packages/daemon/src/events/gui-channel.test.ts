import type { LarkEvent } from '@lark/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GuiCapacityError, GuiChannel, type GuiConnection } from './gui-channel.js';

const COMMAND: LarkEvent = { type: 'player:command', request_id: 'r1', command: 'pause' };

/** A connection that records what it received; `fail` makes writes report false. */
function fakeConnection(options: { fail?: boolean; throws?: boolean } = {}): GuiConnection & {
  sent: LarkEvent[];
  closed: number;
} {
  const sent: LarkEvent[] = [];
  return {
    sent,
    closed: 0,
    send(event: LarkEvent) {
      if (options.throws) throw new Error('socket exploded');
      sent.push(event);
      return options.fail !== true;
    },
    close() {
      this.closed++;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('registration', () => {
  it('mints an id that is immediately recognised', () => {
    const channel = new GuiChannel();
    const id = channel.register(4242, '0.1.0');
    expect(channel.isRegistered(id)).toBe(true);
    expect(channel.isRegistered('never-minted')).toBe(false);
  });

  it('evicts the oldest UNATTACHED registration when full', () => {
    const channel = new GuiChannel({ capacity: 2 });
    const first = channel.register(1000, '0.1.0');
    const second = channel.register(1001, '0.1.0');
    const third = channel.register(1002, '0.1.0');

    expect(channel.isRegistered(first)).toBe(false);
    expect(channel.isRegistered(second)).toBe(true);
    expect(channel.isRegistered(third)).toBe(true);
  });

  it('refuses a new registration when every slot is connected (GUI_CAPACITY)', () => {
    const channel = new GuiChannel({ capacity: 2 });
    for (const _ of [0, 1]) {
      const id = channel.register(1, '0.1.0');
      channel.attach(id, fakeConnection());
    }
    expect(() => channel.register(2, '0.1.0')).toThrow(GuiCapacityError);
  });

  it('expires a registration that never attaches', () => {
    vi.useFakeTimers();
    const channel = new GuiChannel({ registrationTtlMs: 1000 });
    const id = channel.register(1, '0.1.0');

    vi.advanceTimersByTime(999);
    expect(channel.isRegistered(id)).toBe(true);
    vi.advanceTimersByTime(2);
    expect(channel.isRegistered(id)).toBe(false);
  });

  it('re-arms expiry after a disconnect, and attaching cancels it', () => {
    vi.useFakeTimers();
    const channel = new GuiChannel({ registrationTtlMs: 1000 });
    const id = channel.register(1, '0.1.0');
    const conn = fakeConnection();

    channel.attach(id, conn);
    vi.advanceTimersByTime(5000); // attached → no expiry
    expect(channel.isRegistered(id)).toBe(true);

    channel.detach(id, conn);
    vi.advanceTimersByTime(1001);
    expect(channel.isRegistered(id)).toBe(false);
  });
});

describe('active connection (single consumer)', () => {
  it('unicasts only to the newest connection', () => {
    const channel = new GuiChannel();
    const oldId = channel.register(1, '0.1.0');
    const newId = channel.register(2, '0.1.0');
    const oldConn = fakeConnection();
    const newConn = fakeConnection();
    channel.attach(oldId, oldConn);
    channel.attach(newId, newConn);

    expect(channel.sendToActive(COMMAND)).toBe(true);
    expect(newConn.sent).toEqual([COMMAND]);
    expect(oldConn.sent).toEqual([]);
    expect(channel.activeId()).toBe(newId);
  });

  it('promotes the previous connection when the active one drops', () => {
    const channel = new GuiChannel();
    const oldId = channel.register(1, '0.1.0');
    const newId = channel.register(2, '0.1.0');
    const oldConn = fakeConnection();
    const newConn = fakeConnection();
    channel.attach(oldId, oldConn);
    channel.attach(newId, newConn);

    expect(channel.detach(newId, newConn)).toBe(true); // was active
    expect(channel.activeId()).toBe(oldId);
    channel.sendToActive(COMMAND);
    expect(oldConn.sent).toEqual([COMMAND]);
  });

  it('notifies onActiveClose with the gui id that dropped', () => {
    const channel = new GuiChannel();
    const id = channel.register(1, '0.1.0');
    const conn = fakeConnection();
    const closed: string[] = [];
    channel.onActiveClose((guiId) => closed.push(guiId));

    channel.attach(id, conn);
    channel.detach(id, conn);
    expect(closed).toEqual([id]);
    expect(channel.guiOnline()).toBe(false);
  });

  it('ignores a detach from a superseded connection', () => {
    const channel = new GuiChannel();
    const id = channel.register(1, '0.1.0');
    const first = fakeConnection();
    const second = fakeConnection();
    channel.attach(id, first);
    channel.attach(id, second); // same GUI reconnects; first is closed out

    expect(first.closed).toBe(1);
    expect(channel.detach(id, first)).toBe(false); // stale close arrives late
    expect(channel.guiOnline()).toBe(true);
    channel.sendToActive(COMMAND);
    expect(second.sent).toEqual([COMMAND]);
  });

  it('reports false when there is no active connection', () => {
    const channel = new GuiChannel();
    expect(channel.sendToActive(COMMAND)).toBe(false);
    expect(channel.guiOnline()).toBe(false);
  });

  it('reports false when the write fails or throws', () => {
    const failing = new GuiChannel();
    const failId = failing.register(1, '0.1.0');
    failing.attach(failId, fakeConnection({ fail: true }));
    expect(failing.sendToActive(COMMAND)).toBe(false);

    const throwing = new GuiChannel();
    const throwId = throwing.register(1, '0.1.0');
    throwing.attach(throwId, fakeConnection({ throws: true }));
    expect(throwing.sendToActive(COMMAND)).toBe(false);
  });

  it('rejects an id it never minted (the 409 source)', () => {
    const channel = new GuiChannel();
    expect(channel.attach('11111111-1111-4111-8111-111111111111', fakeConnection())).toBe(false);
  });
});

describe('close', () => {
  it('clears registrations, connections and pending timers, idempotently', () => {
    vi.useFakeTimers();
    const channel = new GuiChannel({ registrationTtlMs: 1000 });
    const attachedId = channel.register(1, '0.1.0');
    channel.attach(attachedId, fakeConnection());
    channel.register(2, '0.1.0'); // pending expiry timer
    channel.onActiveClose(() => {
      throw new Error('must not run after close');
    });

    channel.close();
    channel.close(); // idempotent

    expect(channel.size()).toBe(0);
    expect(channel.activeId()).toBeNull();
    expect(channel.sendToActive(COMMAND)).toBe(false);
    // No timer may survive: a lingering registration expiry is exactly what
    // keeps a test process (or a shutting-down daemon) alive.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses to attach after close', () => {
    const channel = new GuiChannel();
    const id = channel.register(1, '0.1.0');
    channel.close();
    expect(channel.attach(id, fakeConnection())).toBe(false);
  });
});
