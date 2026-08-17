// What N0b-1 actually proves (criterion 12).
//
// Not "the app started" — that only needs React. Each probe below USES
// something from one of the three workspace packages the spike is allowed to
// import, so Metro has to have resolved it through the workspace link to
// `packages/*/dist` for the screen to render at all. A missing resolution is a
// bundling failure, which is louder than a wrong number.
//
// The boundary is the point (subplan §0): core's business modules reach for
// `node:crypto` and `node:fs/promises`, so they cannot be imported here until
// N1 ports them. Anything a probe needs core to COMPUTE comes from a
// desktop-produced fixture instead — never from a copy of core's logic living
// in this directory.

import { LATEST_KNOWN_VERSION, MIGRATIONS, REQUIRED_COLUMNS } from '@lark/core/portable';
import { LOCAL_API_VERSION, isUuidV4 } from '@lark/shared';
import { CLIENT_VERSION } from '@orpheus-aviary/skybridge-client';

export interface Probe {
  readonly source: string;
  readonly detail: string;
}

export function bootProbes(): Probe[] {
  return [
    {
      source: '@lark/core/portable',
      detail: [
        `schema v${LATEST_KNOWN_VERSION}`,
        `migrations ${MIGRATIONS.map((m) => m.version).join('→')}`,
        `${Object.keys(REQUIRED_COLUMNS).length} tables in the signature`,
      ].join(' · '),
    },
    {
      source: '@lark/shared',
      detail: [
        `local api v${LOCAL_API_VERSION}`,
        `isUuidV4 ${isUuidV4('9f1b1e2c-3d4a-4b5c-8d6e-7f8091a2b3c4')}`,
      ].join(' · '),
    },
    {
      source: '@orpheus-aviary/skybridge-client',
      detail: `client ${CLIENT_VERSION}`,
    },
  ];
}
