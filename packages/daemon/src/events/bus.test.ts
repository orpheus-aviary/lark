import type { LarkEvent } from '@lark/shared';
import { describe, expect, it } from 'vitest';
import { EventsBus } from './bus.js';

const SONGS_CHANGED: LarkEvent = { type: 'songs:changed' };

describe('EventsBus', () => {
  it('delivers an event to every subscriber and reports the count', () => {
    const bus = new EventsBus();
    const a: LarkEvent[] = [];
    const b: LarkEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    expect(bus.emit(SONGS_CHANGED)).toBe(2);
    expect(a).toEqual([SONGS_CHANGED]);
    expect(b).toEqual([SONGS_CHANGED]);
  });

  it('stops delivering after unsubscribe', () => {
    const bus = new EventsBus();
    const seen: LarkEvent[] = [];
    const off = bus.subscribe((e) => seen.push(e));
    off();

    expect(bus.emit(SONGS_CHANGED)).toBe(0);
    expect(seen).toEqual([]);
  });

  it('isolates a throwing subscriber from the others', () => {
    const bus = new EventsBus();
    const seen: LarkEvent[] = [];
    bus.subscribe(() => {
      throw new Error('bad subscriber');
    });
    bus.subscribe((e) => seen.push(e));

    expect(() => bus.emit(SONGS_CHANGED)).not.toThrow();
    expect(seen).toEqual([SONGS_CHANGED]);
  });

  it('survives a subscriber that unsubscribes mid-dispatch', () => {
    const bus = new EventsBus();
    const seen: LarkEvent[] = [];
    const off = bus.subscribe(() => off());
    bus.subscribe((e) => seen.push(e));

    bus.emit(SONGS_CHANGED);
    expect(seen).toEqual([SONGS_CHANGED]);
    expect(bus.size()).toBe(1);
  });

  it('drops every subscriber on close', () => {
    const bus = new EventsBus();
    bus.subscribe(() => {});
    bus.close();
    expect(bus.size()).toBe(0);
    expect(bus.emit(SONGS_CHANGED)).toBe(0);
  });
});
