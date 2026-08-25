// What the device list is allowed to do to a row, and what it says first
// (N6c, criterion 93).
//
// Both answers are here rather than in the screen for the usual reason: a
// device can only ever be shown ONE of the two confirmations — whichever row
// somebody taps — so "the other one is different" is not a thing a phone can
// be asked. It is also the half that matters. Revoking the device you are
// holding is a legitimate thing to do (`daemon/src/routes/sync.ts:152` allows
// it deliberately: refusing would be the wrong protection for somebody whose
// credentials leaked), and it is also the one that surprises, because the
// consequence lands on the screen you are looking at.

/** The parts of a device row these decisions rest on. */
export interface RevokeTarget {
  name: string;
  isCurrent: boolean;
  revokedAt: number | null;
}

/**
 * An already-revoked device has no button.
 *
 * Not a disabled one: the row already says 已撤销, and a second control that
 * exists only to refuse is a control that has to be explained.
 */
export function canRevoke(device: RevokeTarget): boolean {
  return device.revokedAt === null;
}

export interface RevokePrompt {
  title: string;
  message: string;
  /** The destructive button's label. */
  confirm: string;
}

/**
 * What to ask before revoking.
 *
 * The two messages differ in what they promise about THIS phone, and that is
 * the whole reason they are two: revoking another device leaves this one
 * syncing, revoking this one stops it — and it stops it the way an expired
 * token does, at the next round, which reads as "it broke" unless somebody
 * said so first.
 *
 * Neither message promises anything about the songs, because revoking touches
 * none: the library on the revoked device stays exactly as it is, it just
 * stops being told about changes.
 */
export function revokePrompt(device: RevokeTarget): RevokePrompt {
  if (device.isCurrent) {
    return {
      title: '撤销这台手机？',
      message:
        '这台手机会被踢下线：同步停在下一轮，然后要求重新登录。曲库和已经下载的文件都不会动。',
      confirm: '撤销本机',
    };
  }
  return {
    title: `撤销「${device.name}」？`,
    message: '那台设备会停止同步，要用账号重新登录才能继续。这台手机不受影响。',
    confirm: '撤销',
  };
}
