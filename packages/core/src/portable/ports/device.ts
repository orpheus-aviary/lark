// What this device calls itself when it registers with a workspace (N1a).
//
// The desktop answers `os.hostname()`. A phone has no hostname worth showing
// — Android's is a loopback name — so it will answer with the device model
// (N2). Either way the string is only ever a LABEL in the devices list: no
// code keys off it, and the identity that matters is the server-issued device
// id, kept in the credential store.
//
// A function rather than a string because the desktop reads it at login time,
// not at boot: a machine renamed between the two should register under the
// name the user just gave it.

export type DeviceNameSource = () => string;
