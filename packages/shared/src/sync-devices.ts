// Which devices belong on lark's screen (N6c follow-up, moved here in N7c).
//
// 🔴 DEVICES ARE PER ACCOUNT, NOT PER WORKSPACE. The same skybridge account
// carries owl's registrations too — the real list on the measurement phone was
// two owl entries, two lark ones and that phone. `app_version` is the only
// thing that tells them apart: lark writes `lark <version>` at registration
// (`coordinator/login.ts`), owl writes its own.
//
// This lives in `@lark/shared` because BOTH front ends show that list and the
// two must not drift: a device the phone hides and the desktop shows (or the
// reverse) is a device somebody cannot reason about. It moved here from
// `apps/mobile/src/sync/devices.ts` when the desktop grew the same filter
// (criterion 111).
//
// The wire field is `app_version` on the desktop and `appVersion` in the
// skybridge SDK the phone talks to, which is why the accessor is handed in
// rather than the field being named here.

/**
 * TWO RULES, and the second one is the careful half:
 *
 *   1. `lark …` is ours. Shown.
 *   2. An UNKNOWN app (`null`) is shown too. It cannot be proven not to be
 *      ours — an older client, a build predating this convention — and this
 *      list is where somebody goes to revoke a device they no longer trust.
 *      Guessing wrong in that direction hides the thing they came for.
 */
export function isLarkDevice(appVersion: string | null): boolean {
  return appVersion === null || /^lark(\s|$)/i.test(appVersion);
}

export interface LarkDeviceSplit<T> {
  shown: T[];
  /**
   * How many belonged to another tool.
   *
   * COUNTED AND SAID OUT LOUD, for the same reason the unknown ones are shown:
   * a device holding this account's credentials is worth knowing about even
   * when its data belongs elsewhere. Revoking it there is that tool's job.
   */
  hidden: number;
}

export function splitLarkDevices<T>(
  rows: readonly T[],
  appVersionOf: (row: T) => string | null,
): LarkDeviceSplit<T> {
  const shown = rows.filter((row) => isLarkDevice(appVersionOf(row)));
  return { shown, hidden: rows.length - shown.length };
}

/**
 * What the list says about what it is NOT showing. `null` when it hides none.
 *
 * The wording is the phone's, kept verbatim when the desktop grew the same
 * list: it has to say both halves — that those devices hold this account's
 * credentials, and that revoking them is the other tool's job — or the count
 * reads as a defect rather than a fact.
 */
export function hiddenDevicesNote(hidden: number): string | null {
  if (hidden <= 0) return null;
  return `另有 ${hidden} 台设备属于同一账号的其它工具（owl 等），这里不显示——它们也持有这个账号的凭证，要停用请到那个工具里撤销。`;
}
