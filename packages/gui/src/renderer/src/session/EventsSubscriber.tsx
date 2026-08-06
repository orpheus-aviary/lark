// The one component that owns the daemon session (M4-7: EventsSubscriber is
// the central SSE consumer). Renders nothing; wires GuiSession to the stores.
//
// Business-event dispatch lives here and grows with T3–T5 (download events,
// player commands). Payloads are refresh signals — details are refetched.

import type { GuiRegisterData, LarkEvent, StatusData } from '@lark/shared';
import { API_PATHS, request, subscribeSse } from '@lark/shared';
import { useEffect } from 'react';
import { getPlatform } from '../platform/index.js';
import { handlePlayerCommand } from '../player/remote.js';
import { useCache } from '../stores/cache.js';
import { useConfig } from '../stores/config.js';
import { useDataBus } from '../stores/data-bus.js';
import { useDownloads } from '../stores/download.js';
import { usePlayer } from '../stores/player.js';
import { useSession } from '../stores/session.js';
import { GuiSession } from './gui-session.js';

function dispatchEvent(event: LarkEvent): void {
  const bus = useDataBus.getState();
  switch (event.type) {
    case 'songs:changed':
      bus.bumpSongs();
      return;
    case 'playlists:changed':
      bus.bumpPlaylists();
      return;
    case 'lyrics:changed':
      bus.bumpLyrics(event.song_id);
      return;
    case 'cache:evicted': {
      // The row survives; only `has_file` flipped, which is a per-request disk
      // probe — so the list has to be refetched to grey the song out (M5-19).
      bus.bumpSongs();
      const cache = useCache.getState();
      if (cache.watching) cache.refresh();
      return;
    }
    case 'player:command':
      // Arrival time is taken HERE: the deadline that decides whether the
      // command is still worth running starts when the frame lands, not when
      // the queue gets round to it (M4-10).
      handlePlayerCommand(event, Date.now());
      return;
    case 'download:status':
    case 'download:complete':
    case 'download:error':
    case 'download:cancelled':
    case 'download:batches-changed':
      useDownloads.getState().applyEvent(event);
      return;
    default:
      return;
  }
}

export function EventsSubscriber(): null {
  useEffect(() => {
    const platform = getPlatform();
    const session = new GuiSession({
      registerGui: async () => {
        const envelope = await request<GuiRegisterData>('POST', API_PATHS.guiRegister, {
          pid: platform.rendererPid,
          version: platform.guiVersion,
        });
        const id = envelope.data?.gui_instance_id;
        if (!id) throw new Error('register returned no gui_instance_id');
        return id;
      },
      subscribe: subscribeSse,
      probeStatusPid: async () => {
        try {
          const envelope = await request<StatusData>('GET', API_PATHS.status);
          return envelope.data?.pid ?? null;
        } catch {
          return null;
        }
      },
      readToken: () => platform.getDaemonToken(),
      onHello: () => {
        useSession.getState().bumpEpoch();
        useDataBus.getState().bumpAll();
        useConfig.getState().refresh();
        // A restarted daemon's mirror is empty and a reconnected one may have
        // missed reports while the channel was down (M4-8).
        usePlayer.getState().reportNow();
        useDownloads.getState().resetEventStream();
        useDownloads.getState().refresh();
      },
      onGenerationChange: () => useSession.getState().bumpGeneration(),
      onEvent: dispatchEvent,
      onOnline: () => useSession.getState().setSseStatus('online'),
      onOffline: () => useSession.getState().setSseStatus('offline'),
      warn: (msg) => console.warn('[session]', msg),
    });
    session.start();
    // StrictMode mount→cleanup→remount is the NORMAL path: dispose makes all
    // of the first instance's continuations no-ops, so exactly one SSE stream
    // and one effective registration survive (tested in gui-session.test.ts).
    return () => session.dispose();
  }, []);

  return null;
}
