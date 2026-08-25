// Is this app in front of the person right now? (N5d)
//
// Split from `triggers.ts` for one reason, and it is the same reason
// `share/draft.ts` was split from `share/intent.ts`: everything that imports
// React Native is invisible to `vitest.config.ts`'s allowlist, and the state
// machine next door is exactly the kind of thing that should be settled in a
// second rather than by backgrounding a phone. So the machine takes this as a
// dependency and this file is fifteen lines with nothing to get wrong.
//
// Android reports `active` and `background`. iOS adds `inactive` for the
// moment a call or the app switcher is over the top; this app is
// `platforms: ['android']`, but the mapping treats anything that is not
// `active` as away, because the answer to "should sync be running" is the same
// for both and guessing the other way would leave a socket open under a
// screen the person cannot see.

import { AppState } from 'react-native';

export interface AppStateSource {
  /** True when the app is in the foreground at the moment of asking. */
  active(): boolean;
  /** Called on every transition, with the new answer. Returns an unsubscribe. */
  subscribe(listener: (active: boolean) => void): () => void;
}

export function createAppStateSource(): AppStateSource {
  return {
    active: () => AppState.currentState === 'active',
    subscribe(listener) {
      const subscription = AppState.addEventListener('change', (status) => {
        listener(status === 'active');
      });
      return () => subscription.remove();
    },
  };
}
