// Which window this is: the library, or the migration (0.3.0 T3c, §3.2-2).
//
// It sits OUTSIDE `App` on purpose. `App` mounts a player, an SSE session and
// five stores that immediately fetch; during the migration every one of those
// reads answers 503, so the question "is the library being served" has to be
// settled before any of it exists — not handled afterwards by each store.
//
// The probe is `GET /status`, the one route that answers without a token and
// without a served library. Three outcomes:
//
//   normal            → the app, exactly as before.
//   pending/activating/fatal → the migration screen, polled once a second so
//                       the moment the daemon activates the app takes over.
//   unreachable       → the app. A daemon that cannot be reached is not a
//                       migrating daemon, and the app has had its own offline
//                       handling since M4; blocking on an unanswered probe
//                       would turn "the daemon is starting" into a blank
//                       window.

import { useEffect } from 'react';
import { MigrationScreen } from '../components/MigrationScreen.js';
import { useMigration } from '../stores/migration.js';

/** How often the phase is re-checked while the library is not being served. */
const POLL_MS = 1000;

export function BootGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const phase = useMigration((s) => s.phase);
  const probed = useMigration((s) => s.probed);
  const probe = useMigration((s) => s.probe);

  useEffect(() => {
    void probe();
  }, [probe]);

  // Only while there is something to wait for. Once the daemon is serving, the
  // app's own SSE session is the live channel and a second-by-second poll of
  // `/status` would be a background request nobody reads.
  useEffect(() => {
    if (phase === 'normal') return;
    const timer = setInterval(() => void probe(), POLL_MS);
    return () => clearInterval(timer);
  }, [phase, probe]);

  // The first probe has not landed. Deliberately blank rather than a spinner:
  // on loopback this is a millisecond, and a flash of "connecting…" every
  // launch would be worse than nothing.
  if (!probed) return <div className="h-full" />;
  if (phase === 'pending' || phase === 'activating' || phase === 'fatal') {
    return <MigrationScreen />;
  }
  return <>{children}</>;
}
