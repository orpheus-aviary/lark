// Test fixtures shared with sibling packages, behind the `@lark/core/testing`
// subpath so they never reach the production barrel. Currently: the Go-era
// songs.db seeder, which the daemon's boot tests use to prove a legacy library
// is refused with guidance instead of migrated behind the user's back.

export * from '../db/fixture-go-db.js';
export * from './fake-upstream.js';
