// The row is draggable as a whole, so the only thing standing between "select
// the text in a song name" and "reorder the playlist" is this predicate.

import { describe, expect, it } from 'vitest';
import { canStartDragFrom } from './SongReorder.js';

/** Build `<tr><td><wrapper?><target></…>` and hand back the innermost node. */
function inRow(target: string, wrapper?: string, attributes: Record<string, string> = {}): Element {
  const cell = document.createElement('tr').appendChild(document.createElement('td'));
  const leaf = document.createElement(target);
  if (wrapper === undefined) {
    for (const [name, value] of Object.entries(attributes)) leaf.setAttribute(name, value);
    cell.appendChild(leaf);
    return leaf;
  }
  const parent = document.createElement(wrapper);
  for (const [name, value] of Object.entries(attributes)) parent.setAttribute(name, value);
  parent.appendChild(leaf);
  cell.appendChild(parent);
  return leaf;
}

describe('canStartDragFrom', () => {
  it('lets a press on the row itself start a drag', () => {
    expect(canStartDragFrom(inRow('span'))).toBe(true);
    expect(canStartDragFrom(null)).toBe(true);
  });

  it.each([
    ['the inline edit input', (): Element => inRow('input')],
    ['an action button', (): Element => inRow('button')],
    ['an icon inside a button', (): Element => inRow('svg', 'button')],
    ['a link', (): Element => inRow('a', undefined, { href: 'https://example.test' })],
    ['a contenteditable', (): Element => inRow('span', 'div', { contenteditable: 'true' })],
  ])('refuses to start one from %s', (_label, build) => {
    expect(canStartDragFrom(build())).toBe(false);
  });
});
