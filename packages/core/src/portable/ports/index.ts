// Everything portable core needs from its host, as interfaces (N1a).
//
// Declared here in one batch, ahead of the code that will consume them, so
// that the batches which follow only ever WIRE — a port invented halfway
// through a migration is a port shaped by whatever was convenient that day.
//
// The desktop implementations live next to what they wrap: `node-fs.ts`,
// `paths.ts`, `config/skybridge.ts`. The daemon supplies events and device
// name from its own context; the mobile ones land in N2/N4.

export * from './audio-landing.js';
export * from './credentials.js';
export * from './device-settings.js';
export * from './device.js';
export * from './events.js';
export * from './fs.js';
export * from './paths.js';
export * from './song-files.js';
