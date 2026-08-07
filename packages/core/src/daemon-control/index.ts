// `@lark/core/daemon-control` — everything needed to find, identify, start and
// stop a daemon, with ZERO native dependencies (M6-21).
//
// The subpath exists for the CLI's module graph: `@lark/core`'s barrel pulls in
// better-sqlite3, so importing it to read a pid file would make `lark status`
// fail on an ABI mismatch that has nothing to do with what it was asked to do.
// Nothing in here may import the database, the download engine, or anything
// else that loads a `.node` file.

export * from './fingerprint.js';
export * from './pid.js';
export * from './stop.js';
