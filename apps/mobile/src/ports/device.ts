// What this phone calls itself in the workspace's device list (N5c, decision e).
//
// The desktop answers `os.hostname()`. Android's hostname is a loopback name
// nobody would recognise, so this answers with the thing printed on the box:
// `Platform.constants` carries `Brand` and `Model` on Android, which makes
// "vivo V2408A" out of a device whose model alone reads as a part number.
//
// `react-native` and not `expo-device`: the port's own header says no code
// keys off this string — it is a LABEL, and the identity that matters is the
// server-issued device id in the credential store. A whole native module for
// a label would be a dependency bought with a straight face.
//
// Read at login, not at boot, because the port is a function: nothing here
// caches, so a device renamed between the two registers under the new name.

import type { DeviceNameSource } from '@lark/core/portable';
import { Platform } from 'react-native';

/** Last resort. Never empty — the server stores this and a person reads it. */
const FALLBACK = 'Android';

function constant(key: 'Brand' | 'Model'): string {
  const constants: unknown = Platform.constants;
  if (typeof constants !== 'object' || constants === null) return '';
  if (!(key in constants)) return '';
  const value = (constants as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * `Brand Model`, or whichever half exists.
 *
 * The brand is dropped when the model already opens with it — several vendors
 * ship `Model` values that include the brand, and "Google Google Pixel 8" is
 * how a label stops being read.
 */
export const deviceName: DeviceNameSource = () => {
  const brand = constant('Brand');
  const model = constant('Model');
  if (model === '') return brand === '' ? FALLBACK : brand;
  if (brand === '' || model.toLowerCase().startsWith(brand.toLowerCase())) return model;
  return `${brand} ${model}`;
};
