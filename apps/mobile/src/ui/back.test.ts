import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BACK, handleBack, registerBack, resetBackHandlers } from './back';

beforeEach(resetBackHandlers);

describe('handleBack', () => {
  it('is false when nobody is listening — the system gets the press', () => {
    expect(handleBack()).toBe(false);
  });

  it('asks the innermost layer first, whatever order they registered in', () => {
    const seen: string[] = [];
    // The order React actually produces: effects run child-first, so the
    // INNER layer registers BEFORE the outer one. A plain stack would ask the
    // tab first and close the wrong thing.
    registerBack(() => {
      seen.push('selection');
      return true;
    }, BACK.selection);
    registerBack(() => {
      seen.push('tab');
      return true;
    }, BACK.tab);

    expect(handleBack()).toBe(true);
    expect(seen).toEqual(['selection']);
  });

  it('falls through to the next layer when one declines', () => {
    const seen: string[] = [];
    registerBack(() => {
      seen.push('tab');
      return true;
    }, BACK.tab);
    registerBack(() => {
      seen.push('screen');
      return false;
    }, BACK.screen);

    expect(handleBack()).toBe(true);
    expect(seen).toEqual(['screen', 'tab']);
  });

  it('gives an equal claim to the newest registration', () => {
    const seen: string[] = [];
    registerBack(() => {
      seen.push('older');
      return true;
    }, BACK.screen);
    registerBack(() => {
      seen.push('newer');
      return true;
    }, BACK.screen);

    handleBack();
    expect(seen).toEqual(['newer']);
  });

  it('stops asking a handler that unregistered', () => {
    const gone = vi.fn(() => true);
    const remove = registerBack(gone, BACK.screen);
    remove();

    expect(handleBack()).toBe(false);
    expect(gone).not.toHaveBeenCalled();
  });

  it('survives a handler that unregisters itself while consuming the press', () => {
    // What closing a screen IS: the handler sets state, the screen unmounts,
    // its cleanup runs. Iterating the live array would skip the next entry.
    const after = vi.fn(() => true);
    let remove = (): void => undefined;
    remove = registerBack(() => {
      remove();
      return false;
    }, BACK.selection);
    registerBack(after, BACK.tab);

    expect(handleBack()).toBe(true);
    expect(after).toHaveBeenCalledOnce();
  });
});
