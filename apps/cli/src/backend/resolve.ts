// Which backend serves this command (M6-2), as a pure function.
//
// The matrix is five identity states × four needs × `--direct`, and it is
// written out rather than derived because every cell is a policy decision
// somebody has to be able to read:
//
//   READ   never needs a daemon. If ours is running we go through it (it has
//          the fresher view of `has_file` and friends); otherwise — or on
//          `--direct` — we open the library read-only, which is safe against
//          ANY of the other states because it writes nothing.
//   WRITE  goes through our daemon when there is one, and NEVER around it
//          (R31: a direct write next to a running daemon has no cross-process
//          mutual exclusion for playback / downloads / eviction). Without a
//          daemon a write needs `--direct` SPELLED OUT — no silent downgrade,
//          because "it worked, just not where you thought" is the failure this
//          command family cannot afford.
//   DAEMON some commands are meaningless without one (playback, the download
//          queue). Only `absent` may launch, and only for the commands that
//          are allowed to.
//   NONE   local work; this function is not consulted.
//
// The `other-nest` write case is the interesting one: another nest's daemon
// says nothing about OUR library, so a direct write is legitimate — provided
// our own pid file is clean, because a live local pid means somebody may be
// booting a daemon for THIS nest right now.

import type { PidInspection } from '@lark/core/daemon-control';
import type { CliErrorCode } from '../lib/exit-codes.js';
import type { DaemonIdentity } from '../lib/identity.js';

export type BackendNeed = 'read' | 'write' | 'daemon' | 'none';

export type ModeDecision =
  /** Talk to our running daemon over HTTP. */
  | { kind: 'http' }
  /** Open the library read-only, in this process. */
  | { kind: 'direct-read'; note?: string }
  /** Take the writer lock and write, in this process. */
  | { kind: 'direct-write' }
  /** Nothing is there and this command may start one. */
  | { kind: 'launch' }
  | { kind: 'error'; code: CliErrorCode; message: string };

export interface ModeInput {
  need: BackendNeed;
  /** `--direct` was passed. */
  direct: boolean;
  identity: DaemonIdentity;
  /**
   * This nest's pid file, for the `other-nest` write gate. Read-only, and only
   * consulted in that one cell.
   */
  localPid: PidInspection;
  /** Whether this command is allowed to start a daemon (play / gui). */
  canLaunch?: boolean;
}

const DIRECT_REJECTED = (what: string): { kind: 'error'; code: CliErrorCode; message: string } => ({
  kind: 'error',
  code: 'USAGE_ERROR',
  message: `${what}不支持 --direct：它需要一个运行中的 daemon（播放、下载队列、联网识别都在 daemon 里）。`,
});

export function decideMode(input: ModeInput): ModeDecision {
  const { need, direct, identity, localPid } = input;

  if (need === 'none') {
    return direct
      ? { kind: 'error', code: 'USAGE_ERROR', message: '这个命令是纯本地操作，不接受 --direct。' }
      : { kind: 'http' }; // never used; commands with need 'none' do not ask
  }

  if (need === 'daemon') {
    if (direct) return DIRECT_REJECTED('该命令');
    switch (identity.state) {
      case 'current':
        return { kind: 'http' };
      case 'absent':
        return input.canLaunch === true
          ? { kind: 'launch' }
          : {
              kind: 'error',
              code: 'DAEMON_UNAVAILABLE',
              message: 'daemon 未在运行——先跑 `lark daemon`，或用 `lark play` / `lark gui` 拉起。',
            };
      case 'other-nest':
        return {
          kind: 'error',
          code: 'DAEMON_OTHER_NEST',
          message: '端口 47100 被另一个数据目录的 lark daemon 占用——先停掉那个实例。',
        };
      case 'same-nest-incompatible':
        return {
          kind: 'error',
          code: 'DAEMON_INCOMPATIBLE',
          message: '运行中的 daemon 协议版本不兼容——先 `lark stop-daemon` 停掉旧实例。',
        };
      case 'occupied-unverifiable':
        return {
          kind: 'error',
          code: 'DAEMON_UNVERIFIED',
          message: '端口 47100 被占用且无法确认对方是本数据目录的 lark daemon——拒绝继续。',
        };
    }
  }

  if (need === 'read') {
    if (identity.state === 'current' && !direct) return { kind: 'http' };
    if (identity.state === 'current') return { kind: 'direct-read' };
    // Any other state: a read writes nothing, so it is safe everywhere. Say so
    // on stderr when it is not the obvious case, since the answer may be
    // staler than the running daemon's.
    return identity.state === 'absent'
      ? { kind: 'direct-read' }
      : { kind: 'direct-read', note: `直接读取本地库（${identity.state}）` };
  }

  // need === 'write'
  switch (identity.state) {
    case 'current':
      return direct
        ? {
            kind: 'error',
            code: 'DAEMON_RUNNING_BLOCKED',
            message:
              'daemon 正在运行，禁止 --direct 写：跨进程的播放 / 下载 / 缓存清理互斥只有 daemon 里有（R31）。去掉 --direct 走 HTTP，或先 `lark stop-daemon`。',
          }
        : { kind: 'http' };
    case 'absent':
      return direct
        ? { kind: 'direct-write' }
        : {
            kind: 'error',
            code: 'DAEMON_UNAVAILABLE',
            message: 'daemon 未在运行。加 --direct 直接写本地库，或先跑 `lark daemon`。',
          };
    case 'other-nest':
      if (!direct) {
        return {
          kind: 'error',
          code: 'DAEMON_UNAVAILABLE',
          message:
            '端口 47100 上的 daemon 属于另一个数据目录，本数据目录没有 daemon。加 --direct 直接写本地库，或先为本目录启动 daemon。',
        };
      }
      // Proven to be somebody else's daemon — but only our own pid file can
      // say whether a daemon for THIS nest is coming up right now.
      if (localPid.state === 'absent' || localPid.state === 'stale')
        return { kind: 'direct-write' };
      return {
        kind: 'error',
        code: 'DAEMON_UNVERIFIED',
        message: `本数据目录的 pid 文件仍然存在（${localPid.state}）——无法确认没有第二个写者，拒绝 --direct 写。`,
      };
    case 'same-nest-incompatible':
      return {
        kind: 'error',
        code: 'DAEMON_INCOMPATIBLE',
        message: '本数据目录的 daemon 正在运行但版本不兼容——先 `lark stop-daemon` 再重试。',
      };
    case 'occupied-unverifiable':
      return {
        kind: 'error',
        code: 'DAEMON_UNVERIFIED',
        message: '端口 47100 或 pid 文件被占用且无法确认身份——拒绝写入（fail-closed）。',
      };
  }
}
