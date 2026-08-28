import { describe, expect, it } from 'vitest';
import { EMPTY_ADD_DRAFT, shareArrived, submitted } from './add-draft';

const typed = { text: 'BV1 半句话', playlistId: 'p-1' } as const;

describe('the add page draft', () => {
  it('starts with nothing typed and no playlist chosen', () => {
    expect(EMPTY_ADD_DRAFT).toEqual({ text: '', playlistId: null });
  });

  it('lets a share replace what was typed', () => {
    expect(shareArrived(typed, 'https://b23.tv/x').text).toBe('https://b23.tv/x');
  });

  // The share carries a link, not an opinion about where it should go.
  it('keeps the chosen playlist when a share arrives', () => {
    expect(shareArrived(typed, 'https://b23.tv/x').playlistId).toBe('p-1');
  });

  it('empties the box once something is queued, and keeps the playlist', () => {
    expect(submitted(typed)).toEqual({ text: '', playlistId: 'p-1' });
  });
});
