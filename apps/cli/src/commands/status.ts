// `lark status` — who is on the port, and is it ours (M6-22).
//
// The output contract is deliberately narrow: `current` is the ONLY success.
// Every other identity state is an error envelope on stderr with a non-zero
// exit and the diagnosis in `details.identity`, so the rule a script needs is
// just "exit 0 ⇔ stdout has an envelope" — no parsing a status field to find
// out whether the status command succeeded.

import type { ApiResponse, StatusData } from '@lark/shared';
import { CliError } from '../lib/errors.js';
import type { CliErrorCode } from '../lib/exit-codes.js';
import { type DaemonIdentity, describeIdentity, identityDetails } from '../lib/identity.js';
import { type Streams, emitEnvelope, successEnvelope } from '../lib/output.js';

export interface StatusOptions {
  json?: boolean;
}

export interface StatusDeps {
  identity: () => Promise<DaemonIdentity>;
  streams: Streams;
}

/** Payload of a successful `status`: the daemon's own, plus how we read it. */
export type StatusReport = StatusData & { identity: 'current' };

const CODE_BY_STATE: Record<Exclude<DaemonIdentity['state'], 'current'>, CliErrorCode> = {
  absent: 'DAEMON_UNAVAILABLE',
  'other-nest': 'DAEMON_OTHER_NEST',
  'same-nest-incompatible': 'DAEMON_INCOMPATIBLE',
  'occupied-unverifiable': 'DAEMON_UNVERIFIED',
};

export async function runStatus(deps: StatusDeps, opts: StatusOptions): Promise<void> {
  const identity = await deps.identity();

  if (identity.state !== 'current') {
    throw new CliError(CODE_BY_STATE[identity.state], describeIdentity(identity), {
      identity: identityDetails(identity),
    });
  }

  const report: StatusReport = { ...identity.status, identity: 'current' };
  if (opts.json) {
    const envelope: ApiResponse<StatusReport> = successEnvelope(report, {
      message: 'daemon is running',
    });
    emitEnvelope(deps.streams, envelope);
    return;
  }

  deps.streams.out(`daemon: online (pid ${report.pid}, v${report.version})`);
  deps.streams.out(`uptime: ${Math.round(report.uptime)}s`);
  deps.streams.out(`protocol: local_api_version ${report.local_api_version}`);

  // Only while it is happening (0.3.0 T3d). This is the line that explains why
  // every other command is answering AUDIO_MIGRATION_PENDING — `status` is the
  // one command that keeps working, so it is where the reason belongs.
  const migration = report.audio_migration;
  if (migration !== undefined && migration.phase !== 'normal') {
    const settled =
      migration.done + migration.lost + migration.kept_unconverted + migration.asset_missing;
    const attention = migration.blocked + migration.blocked_file_op;
    const stuck = attention > 0 ? `, ${attention} need attention` : '';
    deps.streams.out(
      `audio migration: ${migration.state} (${settled}/${migration.total}${stuck}) — the library is not served yet`,
    );
  }
}
