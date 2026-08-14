// Test fixtures shared with sibling packages, behind the `@lark/core/testing`
// subpath so they never reach the production barrel: the Go-era songs.db
// seeder (the daemon's boot tests prove a legacy library is refused with
// guidance instead of migrated behind the user's back), a fake bilibili, and a
// media toolchain that never spawns a child.

export * from '../db/fixture-go-db.js';
export * from './audio-fixtures.js';
export * from './fake-media-tools.js';
export * from './fake-upstream.js';
export * from './mp3-fixture.js';
export * from './tone-wav.js';
