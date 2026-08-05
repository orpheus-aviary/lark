// The renderer's half of the `lark-media://` contract (M4-6): a URL shape and
// nothing else. The token never appears here — main attaches Authorization
// when it proxies the request, which is exactly why the media src is safe to
// put in the DOM (R21/R29).

export function mediaUrl(songId: string): string {
  return `lark-media://song/${songId}`;
}

/**
 * The slice of HTMLMediaElement the player drives. Narrow on purpose: the
 * store and the recovery machine are then testable against a fake instead of
 * jsdom's half-implemented media element.
 */
export interface MediaElement {
  src: string;
  currentTime: number;
  readonly duration: number;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
