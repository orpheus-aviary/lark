# Phase B · N3 播放（`apps/mobile`）

- **日期**：2026-08-20（**v4，可开工定稿**）。v1 → v2/v3（用户第一轮评审）→ **v4（一轮反例评审收敛，修订对照见 §8）**。**决策 a–p 全部关闭。**
- **前置**：N2 全部完成（七批 N2a–N2g，head `0d57532`，判据 1–21 全过）。曲库、四 tab、D16 身份门、file-op 执行器、`nowPlayingTitle` 与 `now_playing_mode` 都已在位。
- **主计划**：`docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4.3 的 N3 行 + §4.5 的蓝牙歌词修订段；框架 `docs/plans/2026-08-17-phase-b-mobile-n0.md` §5。
- **冻结设备**：vivo V2408A（release 构建）。行为判据一律在它上面取。

---

## §0 范围

**做**：PlayerDriver（expo-audio 封装 + 串行/generation 竞态模型）· 队列与四种播放模式（**快照口径**，§2.6）· minibar + 队列面板 + 全屏播放/歌词页 · 后台/锁屏/音频焦点 · 蓝牙歌词接线与开关 · **进度记忆**（§2.7）。

**不做（本批）**：下载（N4）· 同步（N5）· 多选批量（N6）· 逐词歌词与 Android Auto / widget（主计划 §4.5）· 桌面的任何蓝牙歌词（同上）· **整晚 soak**（决策 k）· 打开就续播（决策 i）· **锁屏/车机上的切歌**（§1.9，钉版做不到，v1 收窄）。

**一句话的边界**：N3 之前，手机上的 lark 是一个能读能写的曲库；N3 之后，它是一个播放器。曲库里有 7 首已下载的歌，够跑完每一条判据——**N3 不引入任何新的取文件路径**。

---

## §1 开工前必须知道的

### 1.1 桌面播放器里能共享的比 v1 以为的多一块

`packages/gui/src/renderer/src/stores/player.ts`（563 行）加上 `player/` 目录，分成三堆：

| | 内容 | 能不能共享 |
|---|---|---|
| **宿主/daemon 缠绕** | `element`（`<audio>`）· 单飞上报器（`reporter.ts`）· 远程命令（`remote.ts`）· daemon 重启后的 recovery（`recovery.ts`）· pending play（`pending.ts`） | **不能** |
| **队列语义（纯）** | 「这一首放完了该放谁」——`next`（`:284`）· `prev`（`:298`）· `playAt`（`:314`）· `randomOther`（`:324`）· `advanceAfterEnded`（`:347`） | **能**，决策 a |
| **竞态模型（纯）** | `player/queue.ts` 的 `createOperationQueue`——**零 import、只注入 `now`**，串行 + generation + 「最后意图胜出」。deadline 那个可选参数才是远程专用的 | **能**，决策 p（v1 把它整条归成「不能共享」，看错了） |

队列语义合起来是 **Go parity 的四条**，每条都是有人踩过才写下的：

1. **`sequential` 到列表末尾就停，不回头**（`:357-363`）；`repeat-all` 才 wrap。
2. **`shuffle` 是「随机另一首」不是「随机一首」**（`randomOther` 排除当前 index），且**只从有文件的里挑**。
3. **邻居没有文件就停下，不是跳过**（`playAt` 的 `has_file === false`）。
4. **当前歌不在当前列表里时拒绝**（D11，`index < 0`），不跳到一个随机位置。

写两遍必漂，而漂移表现成「同一首歌在两端放完之后去了不同的地方」——没人会往「两个 next 函数」上想。形状与 **N2 决策 n**（`song-sort` 进 shared）相同。

**但「抽出来」必须先有 API**（评审 P0-6，属实）：现有五个函数体里调 `get()`、`ctx`、`ops.play`，**不是纯函数**。可共享的形状是一个**决定**，不是一个动作：

```ts
export type QueueDecision =
  | { kind: 'play'; songId: string }
  | { kind: 'restart' }                                  // repeat-one 自然放完
  | { kind: 'stop'; reason: 'end-of-list' | 'no-playable' }
  | { kind: 'reject'; reason: 'not-in-queue' | 'no-file' | 'no-other-playable' };

export function decideNext(input: {
  songs: readonly SongData[];       // 队列当前内容
  currentId: string | null;
  mode: PlayMode;
  trigger: 'ended' | 'next' | 'prev';
  random?: () => number;            // 注入，shuffle 的单测才可判定
}): QueueDecision;
```

**播放与提示都归宿主**。这顺带把 §2.4 与决策 n 的口径冲突解掉了：纯函数只产出 `reject + reason`，**出不出声是宿主的事**（决策 n），不再有「矩阵说静默、决策说出声」这种两头话。

另外两个口径照抄不重发明：**UI 循环序 ≠ wire 序**（`shared/types.ts:552` 是 `sequential · repeat-one · repeat-all · shuffle`，UI 循环是 `player.ts:55` 的 `sequential · repeat-all · repeat-one · shuffle`——按 wire 序转圈会把按钮顺序悄悄改掉）；**`lyrics_offset` 是库里那一个真值**，`parseLrc` 故意忽略文件里的 `[offset:]`（M4-13④）。

### 1.2 expo-audio 57.0.3 的两个缺口，都有真机证据

N0b-4b 实测（N0 子计划 §9），两条都归 N3：

1. 🔴 **`release()` 不先 `pause()` 会留下一条谁也停不掉的音轨**。#47569 的修复 #47828 **不在任何已发布的 SDK 57 版本里**（N0b-1 查 CHANGELOG，N0b-4b 真机确证：release 之后 7 秒 `state:started` 的 AudioTrack 还在，JS 侧已无句柄，只有 `am force-stop` 收得掉）。「纪律」这个词本身就是问题——见 §2.3，它必须做成**结构上绕不过去**的东西。
2. 🔴 **蓝牙断连不暂停，音乐从外放继续**（实测：旧 AudioTrack 转 `paused`，同时新起 `deviceId:3`=speaker 的 `started`）。media3 的 `setHandleAudioBecomingNoisy(true)` 默认关闭，expo-audio 的 JS 面没有暴露，RN 侧也没有 becoming-noisy 事件。**用户摘下耳机就会撞上**。决策 e。

第三条（焦点请求是 `GAIN_TRANSIENT` + `usage=USAGE_UNKNOWN`，而 AudioTrack 自己是 `USAGE_MEDIA`）不是缺口而是**待复核的事实**：它决定别人是躲我们还是压我们。决策 f = 先按冻结的行为表测，达标就不动。

### 1.3 后台与锁屏是四个条件，不是一个开关

- `setAudioModeAsync({ playsInSilentMode: true, interruptionMode: 'doNotMix', shouldPlayInBackground: true })`（spike `playback.ts:72-78`）——`doNotMix` 是**要求不是偏好**，expo-audio 自己的说明：锁屏控件需要它。
- **`requestNotificationPermissionsAsync()` 必须在运行时问**（`:439`）。第一次 soak 就是 `granted=false` 跑的——**播放一切正常、锁屏空空如也**，因为 Android 13+ 的媒体通知**就是**锁屏控件。
- **`player.setActiveForLockScreen(true, {...})`**（`:450`）——不调它，Android 约 3 分钟后停掉后台播放。
- **原生配置也要一起进**（§1.8）。
- **vivo OriginOS 会杀后台进程**（N0 §9）。5 分钟到不了它动手的尺度；决策 k 之后本批也只到这一步，耐久推给打包后的真实使用。

### 1.4 错误不是靠超时猜的：`AudioStatus.error` 是存在的

> **v3 的 §1.4 是错的**，本节是它的更正。当时读 `Audio.types.d.ts` 只读到 `:215` 就断言「没有错误面」——**从一个截断的阅读里得出了一个否定**。

- **`AudioStatus.error: string | null`**（`Audio.types.d.ts:243`），注释写明「播放错误信息，加载新源或恢复播放时清空」。
- Android 侧 `AudioPlayer.kt:158` 的 `onPlayerError(error: PlaybackException)` 就是把它 `sendStatusUpdate` 上来的，走的正是 `playbackStatusUpdate`。
- `AudioEvents` 只有两个成员（`AudioModule.types.d.ts:220-225`）这件事**仍然成立**，但结论反了：错误不是没有通道，而是**和状态走同一条通道**。

所以错误面的形状是：

1. **`status.error !== null` → 立即终止**（停死并说明，M4-6：不重试；spike 时代的重试循环制造过一个杀不掉的请求风暴）。
2. **加载超时只是 watchdog**——只负责「既没 `isLoaded` 也没 `error`」这种收不到终态的情况。
3. **两条走同一条销毁路径**（§2.3）。

否则一个立刻就知道坏了的文件要白等 15 秒。

### 1.5 歌词读取在 `LibraryService` 上还缺一个方法

`readLyrics(files, id)` 在 `portable/library/lyrics.ts:27`，`LibraryService`（`services/library.ts:123-157`）只有 `deleteLyrics`，没有读。桌面走的是 daemon 的 `/lyrics` 文本端点，所以它从来不需要。决策 h。

**跨前端契约不扩**（评审属实）：`ContractSongSeed`（`contract/types.ts:31-38`）只有 `fileBytes`，**造不出歌词文件**，加一条契约用例要同时动三个 hook + 扩 seed。而「读一个文件」不是三个前端会各执一词的库语义。所以只加 service 方法 + core 单测，**不扩 LibraryContract、不动 daemon 的 `/lyrics`**。

### 1.6 移动端没有状态容器、没有 router、没有手势栈

- **状态**：今天只有 `ui/library-context.tsx`（72 行）。播放状态要被 minibar / 全屏页 / 队列面板 / 列表行四处读，且 `playbackStatusUpdate` 每 500ms 一跳——context 里塞 `currentTime` 会让整棵树跟着跳。决策 b。
- **导航**：`ui/shell.tsx` 是一个 switch。决策 c。
- **手势**：主计划 §4.2 画的「minibar 上拉 → 队列」，v1 把「上拉」读成了手势并据此讨论要不要引 `react-native-gesture-handler`。**读错了**——用户澄清那是**一个专门的按钮 + 一个不占满屏的面板**（决策 d）。本批**仍然零手势依赖**，队列面板复用 N2f 的 `ui/sheet.tsx`。

### 1.7 熄屏之后 JS 定时器被冻结，所以后台的证据不能只问 JS

N0b-4b 实测：**熄屏后 JS 定时器最大 85 秒才跳一次**，而播放时钟没有被冻结；`performance.now()` 是 `SystemClock.uptimeMillis()`，**深睡期间不走**。

两个后果，都写进了判据：① 判据 5（后台 ≥5 分钟）必须是**两侧证据的合取**——设备侧记 `currentTime` 与自己的采样间隔（间隔本身就是「我被冻结了多久」的证据），主机侧 `dumpsys audio` 看活跃播放器还在不在。② **进度记忆在熄屏后不能承诺任何数字**（§2.7）。

### 1.8 `apps/mobile` 的原生配置还没有音频那一段

产品的 `app.config.ts` 里**没有 `expo-audio` plugin、没有 `POST_NOTIFICATIONS`**；而 spike 的 config 已经是正确模板（`:28` 权限、`:45` plugin 选项）。钉版 plugin 的三件事都要显式写出来：

```ts
android: { permissions: ['android.permission.POST_NOTIFICATIONS'], … }
plugins: [ … ['expo-audio', { recordAudioAndroid: false, enableBackgroundPlayback: true }] ]
```

- `enableBackgroundPlayback` 才会加 `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PLAYBACK` 并注册 media3 的 MediaSessionService；
- **后台播放不会自动带来 `POST_NOTIFICATIONS`**，而那条权限正是锁屏控件可见与否；
- **默认会申请录音权限**——一个不录音的音乐播放器要麦克风，是用户看不懂的权限弹窗。

配置这种东西会在升级时安静地漂，所以判据 3b 是**对构建出来的 merged manifest** 断言（照 N2 判据 10⑤ 的先例）。

### 1.9 锁屏/车机的「上一首 / 下一首」在钉版上不存在（v1 收窄）

`AudioMediaSessionCallback.kt:27-31` 在 `onConnect` 里**显式 remove 掉四个曲目导航命令**（`SEEK_TO_PREVIOUS_MEDIA_ITEM` / `SEEK_TO_NEXT_MEDIA_ITEM` / `SEEK_TO_PREVIOUS` / `SEEK_TO_NEXT`），只留播放、暂停与 seek；JS 面也没有媒体键回调。

**换 `AudioPlaylist` 救不了**：`AudioControlsService.kt:374` 与 `:455` 两个 MediaSession 注册点用的是**同一个 callback**，命令集与用的是哪种 player 无关。

**v1 收窄（2026-08-20 用户决定）**：锁屏与车机只承诺**播放 / 暂停 / seek**，**切歌只能回到 app 里**。

**实施时又长出两条，都记在这里**（N3a 实测）：

- **通知上的控件不是白来的**。expo-audio 只在 `SDK <= S_V2`（API 32）时给通知 `addAction`，API 33+ 交给 AOSP System UI 从 MediaSession 渲染；而冻结设备（vivo OriginOS，API 35）**把媒体通知当普通通知画**，于是一个 action 都没有的通知就只剩歌名和歌手。修法是 `patches/expo-audio@57.0.3.patch` 去掉那个 API 门限 + `expo.autolinking.buildFromSource`（否则补丁对预编译 AAR 无效，见 `docs/LESSONS.md`），并在 `setActiveForLockScreen` 打开 `showSeekBackward` / `showSeekForward`。**结果是三个按钮：后退 10s ｜ 播放/暂停 ｜ 前进 10s。**
- **没有进度条，展开态的按钮行居左** —— **已知，v1 不做**（2026-08-20 用户决定）。进度条属于 System UI 的媒体组件，这台机器不画；而「居左」是系统 MediaStyle 模板的排法，**不是我们的 bug**：同一张下拉截图里 bilibili 的五个按钮起点与间距和我们完全相同（x = 147 / 257 / …），它只是按钮多、把整行填满了才像居中。要居中只能给通知换自建 `RemoteViews`（`setCustomBigContentView`），那等于接管一块本该由系统画的 UI、和 OEM 主题打架，还要塞进一个已经证明很脆的补丁里。**代价大于收益，先记着。**

- **如实记的代价**：蓝牙歌词是 v1 功能，所以会出现「车机上看得见歌词、方向盘上却切不了歌」。
- **逃生口已定价，留给后续**：要加回来不是一句 `pnpm patch`——既要改 Kotlin 让命令不被 remove，还要拦下命令再桥接到 JS（单曲目 timeline 上 `seekToNext` 本身是空操作），JS 面也要加一个事件，然后维护一份跨 SDK 升级会静默失效的补丁。**真在车上用着难受时再单独修这个小功能。**

---

## §2 目标结构

### 2.1 文件布局（`apps/mobile/src/`）

```
player/
├── driver.ts        # PlayerDriver：expo-audio 的唯一入口（§2.2）
├── session.ts       # setAudioModeAsync + 通知权限 + setActiveForLockScreen
├── store.ts         # 播放状态 + 串行/generation（决策 b、p）
├── queue.ts         # 队列快照的持有者（§2.6；decideNext 在 shared）
├── memory.ts        # 进度记忆的宿主侧（读写在 portable，§2.7）
└── now-playing.ts   # 蓝牙歌词接线：订阅 → 去重节流 → updateLockScreenMetadata
ui/
├── minibar.tsx      # 歌名 + 当前歌词行 + ⏯ ⏭ + 队列按钮
├── queue-sheet.tsx  # 队列面板（复用 ui/sheet.tsx 的 Modal，决策 d）
└── player-screen.tsx # 全屏：大歌词 + 进度 + 四控制 + 模式 + offset ±
modules/
└── lark-audio/      # ACTION_AUDIO_BECOMING_NOISY（决策 e）
```

新增到 `@lark/shared`：`decideNext` + `QueueDecision`（决策 a）· `createOperationQueue`（决策 p，从 `gui/src/renderer/src/player/queue.ts` 原样搬）。
新增到 `@lark/core/portable`：`last-playback.ts`（§2.7 的读写与校验，照 `now-playing-mode.ts` 的形状）。

### 2.2 `PlayerDriver` 的面（冻结）

```ts
interface PlayerDriver {
  load(uri: string, meta: AudioMetadata): Promise<void>; // status.error 或 watchdog 超时 → 抛
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  updateNowPlaying(meta: AudioMetadata): void;           // 同步，蓝牙歌词走这里
  subscribe(listener: (s: PlaybackSnapshot) => void): () => void;
  destroy(): Promise<void>;                              // pause → remove，见 §2.3
}
```

**只暴露 `destroy()`，不暴露 `remove()`**——§1.2① 的结构化答案：一条「记得先 pause」的纪律迟早会被某条错误分支绕开，一个**没有 `remove()` 可调**的面绕不开。

**两个必须存在的状态**：① **有当前歌、但没有 player 实例**（进度记忆启动后是它，加载失败之后也是它）；② 正在加载。

### 2.3 三条冻结序列

**换歌**：`pause 当前` → `destroy 当前 player` → `createAudioPlayer(新 uri)` → 等终态（`isLoaded` / `status.error` / watchdog 超时，**先到先算**）→ `setActiveForLockScreen(true, meta)` → `play`。

**销毁**（切歌、退出、组件卸载、**错误分支**、每一条）：`pause()` → 等一跳状态或固定短延时 → `remove()`。

**出错**（`status.error !== null`，或 watchdog 到点）：停死 + 说明 + **走同一条销毁序列**，**不重试**（M4-6）。

### 2.4 队列决定矩阵（`decideNext` 的返回值，Go parity 四条一条不改）

| `trigger` | `sequential` | `repeat-all` | `repeat-one` | `shuffle` |
|---|---|---|---|---|
| `ended` | 末尾 → `stop(end-of-list)`；否则 `play(下一首)` | `play(wrap 下一首)` | `restart` | `play(随机另一首)`；没有 → `stop(no-playable)` |
| `next` | `play(wrap 下一首)` | 同 | 同 | `play(随机另一首)`；没有 → `reject(no-other-playable)` |
| `prev` | `play(wrap 上一首)` | 同 | 同 | 同 |

横向两条（四种模式相同）：**当前歌不在队列里** → `reject(not-in-queue)`；**目标那首没有文件** → `ended` 时 `stop(no-playable)`、手动时 `reject(no-file)`。

- 「手动 next 在 `sequential` 下 wrap 而自然放完不 wrap」不是笔误，是桌面既有行为（`ops.next` 用 `%`，`advanceAfterEnded` 显式判末尾）：**手动和自动是两种意图**。
- **`reject` 出不出声是宿主的事**（决策 n），这张表不管 UI。

### 2.5 蓝牙歌词的接线口径

```
playbackStatusUpdate(每 ~500ms)
  → nowPlayingTitle({ songName, lyrics, timeSeconds, offsetSeconds, mode })
  → 与上次发出的字符串比：相同则什么也不做
  → 距上次发出 < 500ms：什么也不做
  → updateLockScreenMetadata({ title, artist, albumTitle })
```

- **`mode` 每次从哪来**：进入一首歌时读一次 `readNowPlayingMode(sqlite)`，开关改变时重读。**不在每一跳里查库。**
- **关掉开关的那一刻要把 title 改回歌名**（否则车机上会停在最后一句歌词）。
- **只有 title 是歌词位**，`artist` 不参与（§1.9 的 AVRCP 机制）。
- **期望调用次数不是「歌词行数」**（评审属实）：间奏回歌名、相邻相同输出被去重，所以真值是**相邻不同输出的段数**。判据 17 因此照 N2f 的跨设备对照做——**主机用同一份 `nowPlayingTitle` 从同一份歌词算出期望值**，设备只需对上。

### 2.6 队列是一份快照，不是「当前看着的那一屏」（决策 o）

桌面的队列就是当前视图（`orderedSongs()`），切歌单会把队列换掉——D11 正是为这件事存在的。移动端不照抄，三条理由：

1. **手机上切 tab 是常态**：去一趟设置再回来，照桌面口径 next 就可能被拒。
2. **队列面板要显示「第 3 / 7 首」**（决策 d 的原话是「当前**播放的**歌单」）——队列跟着视图漂，这个数字就不再是位置。
3. **「当前播放的歌单」这个说法本身就预设了播放有自己的列表。**

```ts
interface PlayQueue {
  source: { kind: 'all' } | { kind: 'playlist'; id: string };
  songIds: readonly string[];   // 冻结时的顺序（含当时的排序）
}
```

- **存 id 不存 `SongData` 副本**：改名跟着现读的库走，**歌被删了就从队列里消失**。
- **只有「开始播放」换队列**：切 tab、改排序、搜索都不动正在播的队列。
- **决策 a 不受影响**：`decideNext` 只吃 `songs`，「songs 从哪来」是各端的持有策略。
- **代价**：两端队列口径从此不同（桌面跟视图、手机是快照）。判据 13 守着移动端这一侧，桌面一个字不改。

### 2.7 进度记忆：记住听到哪，但不自己响（决策 i）

**要的**：杀掉应用再打开，minibar 上是上次那首歌、进度条在上次那个位置、**暂停**。按下播放才从那里继续。
**不要的**：启动时创建 player、加载文件、抢音频焦点、弹媒体通知。**启动路径的音频开销必须是零**——D16 身份门与迁移已经排在那条线上。

```
local_metadata.last_playback = {"song_id": "...", "position_seconds": 123.4,
                                "queue": {"kind": "playlist", "id": "..."}}
```

- **落 `local_metadata`**，与 `play_mode` / `now_playing_mode` 同表同域（per-install，不进 `sync_changes`）。**读路径不写库、非法值当作「没有」**——N2g 的 `now_playing_mode` 是同一口径，读写与校验因此也落 portable（桌面单测跑得起来）。
- **连队列来源一起存，不存 id 列表**：只存 `source`，启动时按它重建。存下来的 id 列表会和一个已经变了的歌单打架。
- **承诺是「恢复到 JS 最后观测到的位置」**（v3 的措辞不成立，评审属实）。写入时机：**暂停时 · 切歌时 · `AppState` 进 `background` 时**，外加一道**搭车的 60 秒粗节拍**——不新增定时器，只在本来就有的 `playbackStatusUpdate` 里判「跨过 60 秒边界了吗」。**为记进度而把 CPU 叫醒的闹钟，这个功能不配拥有。**
  - **前台**：JS 不被冻结，节拍是确定的 → 判据 22 只在前台给数字。
  - **熄屏后台**：节拍跟着系统节流变稀（最大 85 秒一跳），**不承诺任何数字**。「进 background 写一次」只保存进入那一刻的位置，它救不了之后的三分钟——**这句话 v3 写反了**。
  - **精度不是目标**（用户原话「记录个大概就好」）。
- **失效一律当作「没有」，且不写回**：
  - 那首歌不在库里 / 没有文件；
  - `position_seconds` 不是有限数、为负、或 > `duration`；**`duration === 0`（库里没记时长）时不拿它做上界**，只查有限且非负；**恰好 `=== duration` 视为放完 → 当作没有**；
  - `queue.kind === 'playlist'` 而那个歌单**已删**或**已空** → 队列退回 `{kind:'all'}`，**歌本身仍然恢复**（用户要的是「上次听到哪」，不是「上次那个歌单」）；
  - JSON 坏掉 / 空串 / 未知 `kind`。
- **不为 D16 收敛特设清理**（用户定）：只在本地存，上面那条失效面已经兜住绝大多数。**代价**：收敛过来的库里如果恰好还有那首歌，minibar 会显示上一个安装听到哪。用户判断「边缘功能，问题不大」。

### 2.8 库变更要有一条 React 之外的信号（评审 P0-7）

今天 `ui/library-context.tsx:62` 的 `changed()` 只做 `setView(reader())`——**一个 React 局部状态更新，外面没人收得到**。而判据 14 要求删歌之后队列跟着收敛（删的是当前这首就停下来）。

**最小做法**：`LibraryProvider` 里加一个 listener set，`changed()` 在 `setView` 之外**再打一个信号**；player 订阅它，收到就用现读的库把队列快照收敛一遍（不在库里的 id 移除；当前这首没了就停）。约 15 行。

**不做通用 reconcile 协议**：N5 的同步删除到时候接同一个信号即可。现在定协议是给一个还没有的问题做设计。

---

## §3 批次划分

每批：`just check` + `just test` 全绿是底线；桌面零回归；**Metro bundle smoke 每批都跑**；提交前给用户看 commit message。真机按常驻规矩——**我装包并讲清楚看什么，用户手测**；要抓内容（logcat / dumpsys / 截屏）或判据要求精确流程时我自己驱动，且**开跑前说一声、跑完说一声**。

| 批 | 内容 | 需要手机 | 本批 gate |
|---|---|---|---|
| **N3a** | expo-audio 进 `apps/mobile`（**与 spike 逐字节同版 57.0.3**）· **原生配置**（§1.8）· `session.ts` · `PlayerDriver`（§2.2 面 + §2.3 三条序列 + `status.error`）· **串行/generation**（决策 p，含 `createOperationQueue` 搬进 shared）· 播放状态容器（决策 b） | 是 | 判据 1（播放/暂停那半）· 2 · **3①④**· **3b** · 5（**3 与 3b 是 gate**）；判据 3②③ 与 4 的设备那半随 N3c 的 acceptance 一起 |
| **N3b** | `decideNext` + `QueueDecision` 进 `@lark/shared`（决策 a）· 四模式 + 持久化（决策 g）· 单测矩阵 · 桌面改吃 | **否（纯桌面批）** | 判据 6–7（**6 是 gate**）；桌面 `player.test.ts` / `queue.test.ts` / `Controls.test.tsx` 原样绿 |
| **N3c** | **移动端 store 接上队列快照与模式**（见下）+ minibar + 全屏页（决策 c）+ **队列面板**（决策 d/o）+ 库变更信号（§2.8）+ 琥珀播放态 + 歌词读取（决策 h）+ **真机四模式**（判据 8 从 N3b 移来） | 是 | 判据 8–15 |
| **N3d** | 蓝牙歌词接线（§2.5）+ 设置页开关 + `dumpsys media_session` 观测 | 是 | 判据 16–18 |
| **N3e** | 中断与外设：**冻结的焦点行为表** · **蓝牙断连不转外放**（决策 e）· 焦点属性复核（决策 f） | 是（**要蓝牙音频设备 + 一通来电**） | 判据 19–21（**19 是 gate**） |
| **N3f** | **进度记忆**（§2.7）+ 后台/锁屏复跑 + 句柄短测 + 文档跟进 | 是 | 判据 22–25（**22 是 gate**） |

**移动端 store 的队列与模式为什么在 N3c 而不在 N3b**（v4 实施时修订）：它要三样只有 boot 之后才存在的东西——按 id 现读库（§2.6 的快照口径）、`readPlayMode` / `writePlayMode` 的 `sqlite`、以及库变更信号（§2.8）。而 `player/index.ts` 是**进程级单例、在 import 时就建好**（N3a 的理由：Activity 重建不能长出第二个播放器）。在没有任何消费者的批次里先发明一套「boot 之后把这些绑上去」的接口，就是给一个还看不见形状的问题做设计。**N3b 因此只出宿主无关的那两块**——`decideNext` 与 `local_metadata.play_mode`——两块都在桌面 test runner 上被完整验过。

**顺序理由**：N3a 的 driver 必须在任何 UI 之前就位，否则 minibar 会长出自己的一份 expo-audio 调用；N3b 排在 UI 之前，是因为队列语义一旦被 UI 就地实现，两端就再也对不齐——**而它整批不需要手机**（真机四模式因此移到 N3c，那里才有可驱动的生产 UI；v3 把它留在 N3b 是错的，那时没有 UI 也没规划 harness）；N3e 虽靠后但**不是打磨**，它是本批唯一「用户会立刻撞上」的 bug；N3f 的进度记忆排最后，因为它要一个已经存在的 minibar 才有地方显示。

---

## §4 判据（1–25，gate 项加粗）

**播放内核**

1. 冻结设备上播 `songs/<id>/song.m4a`：**播放 / 暂停各一次**（N3a）。**seek、进度显示与「`song.duration` 与播放器读出的时长一致（±1s）」随 N3c 验**——N3a 没有进度条，没有可以拖的东西，也没有地方显示秒数；在没有 UI 的批次里声称验过这三件，等于把断言挂在一个不存在的观测量上。store 的 seek 语义由 N3a 的单测覆盖。
2. 锁屏控件出现且可用：**播放 / 暂停 / seek 三件**各一次（**不含上一首/下一首**——§1.9，钉版做不到）。**通知权限是运行时问出来的**（断言 `granted`，不是断言 manifest）。
3. **【gate】销毁不留音轨**。v4 初稿把这条写成「每条路径之后都看不到活跃播放器」——**那和后台播放的定义直接矛盾**（按 home、按 BACK 本来就该继续响），实施时一跑就撞上了。正确的不变量是「**我们名下的活跃播放器数**」：
    - ① **切歌 3 次**：任一时刻 `dumpsys audio` 里属于我们的 `state:started` 播放器**恰好一个**；
    - ② **显式停止 / 退出应用**：**零个**；
    - ③ **加载失败之后**：**零个**；
    - ④ **按 BACK 让 Activity 销毁而进程还在**：播放**继续**（这正是后台播放），回到前台后**仍然只有一个**，且 UI 与它一致——播放器是进程级单例，跟 `bootOnce` 同一个理由（N2f 的教训在一个新地方）。
    - **反测**：把 `destroy()` 里的 `pause()` 去掉 → ① 必须报出多于一个（N0b-4b 量到过这个形态，所以它一定会红）。
3b. **【gate】merged manifest**（照 N2 判据 10⑤）：构建出来的 APK 里 **`POST_NOTIFICATIONS` 在**、**`RECORD_AUDIO` 不在**、`FOREGROUND_SERVICE_MEDIA_PLAYBACK` 与 media3 的 service 已声明。**反测**：把 `recordAudioAndroid: false` 去掉 → 必须红。
4. **错误面走两条不同的路**：① 一个**内容坏掉的音频文件**（0 字节 / 截断）必须由 `status.error` **在 watchdog 超时之前**终止——断言「用了多久」，不是只断言「最后停了」；② 一个**不存在的 uri** 走到终点（无论哪条先到）。两条都是停死 + 说明 + 走同一销毁序列，**不重试**。**反测**：把 `status.error` 分支删掉 → 第 ① 条必须变成「等满了 watchdog」而不是安静通过。
    - **这条跑在 acceptance artifact 上，随 N3c 落地**：生产构建没有任何合法途径造出一个坏掉的音频文件（`Paths.document` 推不进去，UI 里点不出来），而为了测它在生产 UI 上开一个后门，比换一次装贵得多。N3a 交付的是它的宿主无关那一半——store 对「加载失败」的处理由单测覆盖，`PlaybackFailure` 的两种 `reported` 值分别对应这里的 ① 和 ②。
5. 后台 + 锁屏 ≥5 分钟不断（N0b 判据 19 的形态，两侧证据，本批复跑一次作回归线）。

**队列与模式（纯桌面）**

6. **【gate】§2.4 的矩阵逐格一条单测**（三 trigger × 四模式 + 两条横向规则），跑在 `decideNext` 上，**`random` 注入**使 shuffle 可判定。**每一格都要有一个只属于它的变异**（改掉它 → 该格必红）。**不要求「不连带红」**——prev/wrap 共享 helper 时，改坏它本来就该多条一起红（v3 那条规则自相矛盾，评审属实）。
7. 决策 a / p 的代价验收：桌面 `stores/player.test.ts`、`player/queue.test.ts`、`Controls.test.tsx` **原样绿**（零行为变化），且桌面那五个函数体**只剩「调用 + 执行决定」**。

**UI 与队列面板**

8. 真机四种模式各走一次自然放完（`repeat-one` 验重播、`sequential` 验末尾停、`repeat-all` 验 wrap、`shuffle` 验换了一首**不同的**歌）。**判定负担在判据 6**，这里只验接线通了、且 shuffle 只挑有文件的。
9. minibar：有歌即在 · 显示歌名与**当前歌词行** · ⏯ 与 ⏭ 各一次 · 点击进全屏页。
10. 全屏页：大歌词随播放滚动、当前行高亮 · 进度条可拖 · 四个控制 · 模式键循环序 **= `player.ts:55` 的 UI 序**（不是 wire 序）· offset ± 写库并立即生效。
11. 列表里正在播放的行是**琥珀 `#efb146`**（`ui/theme.ts:35` 那一个）。
12. **队列面板**（决策 d）：minibar 上一个**独立按钮**打开它；显示队列全部歌曲、**当前这首高亮并标出「第 N / M 首」**；点面板里任意一首**直接跳过去播**；关闭回到原来那一屏。
13. **【队列是快照】**（决策 o）：从歌单详情起播 → 切到「歌曲」tab → 改一次排序 → 打开面板，**内容与「第 N / M 首」逐项不变**；此时「下一首」走的仍是那个歌单的下一首。**反测**：把队列改成现读当前视图 → 必须红。
14. **删歌之后队列收敛**（§2.8）：删队列里的一首 → 面板里它消失、`M` 减一、当前这首的 `N` 跟着对；**删的是当前这首** → 播放停下并说明。**反测**：不订阅库变更信号 → 两条都必须红。
15. **没有文件的歌被点**：明说「下载在 N4 开放」（决策 j）。歌词缺失 / 纯文本无时间戳 / 有时间戳三种歌各放一次，UI 都不炸。

**蓝牙歌词**

16. 开关默认**关**（`now_playing_mode` 缺行 → `'title'`）；打开后 `dumpsys media_session` 的 metadata TITLE **随歌词行改变**；关掉后**当场变回歌名**。
17. 去重与节流：一次播放里 `updateLockScreenMetadata` 的调用次数 **等于主机用同一份 `nowPlayingTitle` 从同一份歌词算出的「相邻不同输出段数」**（§2.5；不是行数、不是 tick 数），且相邻两次间隔 ≥500ms。**反测**：去掉「返回值没变就不发」 → 次数必须跳到 tick 量级。
18. **如实记录 queue 陷阱的观测**：我们这个 session 的 queue 与 `activeQueueID` 是什么形态。**不设通过/失败**——没有带屏接收端，「车机上延迟 2 秒」本批测不了。

**中断与外设**

19. **【gate】蓝牙/耳机断连不转外放**：断连后音乐**暂停**，不从扬声器继续。**反测**：拿掉决策 e 的产物 → 必须复现 N0b-4b 量到的形态（新起 speaker 的 AudioTrack）。
20. **音频焦点按开工前冻结的行为表验**（评审属实：v3 的「测的时候再写成判据」等于没有通过条件）。冻结如下，三条各一次：<br>· **来电** → 暂停；通话结束后**不自动恢复**（用户没按播放，我们不替他决定）；<br>· **另一个应用开始播放** → 暂停，不恢复；<br>· **导航语音（短暂焦点）** → **压低音量，语音结束后恢复原音量**，不暂停。<br>「不锁 API」指的是不锁接口，不是不锁行为。
21. 焦点属性复核：`dumpsys audio` 记录我们请求的是 `GAIN` 还是 `GAIN_TRANSIENT`、`usage` 是什么。判据 20 全过则**照原样留着并记下来**；不过才动（决策 f）。

**进度记忆与收尾**

22. **【gate】进度记忆**：① **前台**播满 3 分钟后 `am force-stop` → 重开后 minibar 是那首歌、**位置 ≥ 2 分钟**（60 秒节拍的余量，**不是精度断言**）、**且是暂停态**；② 重开后**没有**创建 player——按下播放之前 `dumpsys audio` 看不到活跃播放器，也没有媒体通知；③ 按下播放从记住的位置继续；④ 队列按 `source` 重建，「下一首」走原来那个歌单。**反测**：去掉 60 秒节拍 → ① 必须红（前台的节拍是确定的）。<br>**熄屏后台那条只断言「位置不是 0 且不超过实际播放量」，不给下界**（§1.7）。
23. **进度记忆的失效面**（**跑在桌面单测上**，portable 模块）：歌不在库 / 没有文件 / position 非有限或为负 / `position === duration` / `duration === 0` / 歌单已删 / 歌单已空 / 坏 JSON / 空串 / 未知 `kind` —— 各一条，结果是「没有」或「退回 `all` 但歌还在」，且**库里那一行没有被改写**。**D16 收敛不清这一行**（决策 i），所以这里没有那条断言，有的是 §2.7 记下的代价。
24. **句柄不漏（短测，不是长跑）**：连续切歌 30 次（几十秒），结束后 `dumpsys audio` 里**只有一个活跃播放器**。（v3 的「内存无单调增长」删掉——几十秒内受 GC 干扰，是会误报的断言。）
25. 跑完上述之后应用仍可交互：切一次歌、开一次全屏页、开一次队列面板。

> **决策 k 的代价，如实记**：**耐久性（数小时不掉）在 N3 没有证据**。判据 5 只证明「不是一开始就断」，判据 24 只证明换歌路径不漏句柄。vivo OriginOS 杀后台这条风险**没有被本批消掉**，推给打包之后的真实使用——与判据 16b「声明了但没验过」同一种记法。

---

## §5 决策（a–p，**2026-08-20 全部关闭**）

| # | 决策 | 结论 |
|---|---|---|
| **a** | 队列纯逻辑落在哪 | **提取进 `@lark/shared`**，桌面改吃。四条 Go parity 语义写两遍必漂，且漂移表现成「同一首歌两端放完去了不同地方」。**可共享的形状是 `QueueDecision` 不是动作**（§1.1）——播放与提示归宿主 |
| **b** | 播放状态容器 | **自建 external store**（`useSyncExternalStore` + 选择器）。context 会让 `currentTime` 每 500ms 重渲染整棵树；zustand 是为「带选择器的订阅」引一个新依赖 |
| **c** | 全屏播放页怎么来 | **RN `Modal`**。`shell.tsx` 已经是一个 switch，一个全屏 Modal 不需要导航栈 |
| **d** | 队列怎么打开 | **minibar 上一个专门的按钮 + 一个不占满屏的面板**（形态 = N2f 歌曲行 ⋮ 那个 bottom sheet，零新依赖）。「上拉」从来不是手势的意思，v1 读错了。**面板里点任意一首直接跳过去播** |
| **e** | 蓝牙断连不暂停 | **自建 Expo 原生模块**监听 `ACTION_AUDIO_BECOMING_NOISY`（`modules/lark-audio`）。与 N2 决策 a 同一理由：打在别人的 Kotlin 上更脆且跨 SDK 升级静默失效 |
| **f** | 音频焦点属性 | **先按判据 20 的冻结行为表测，达标就不动**。自己接管一半焦点管理是更难查的病 |
| **g** | 播放模式存哪 | **`local_metadata.play_mode`**，与 `now_playing_mode` 同域。桌面的 localStorage 不动，两端各留适配器 |
| **h** | 歌词读取 | **加到 `LibraryService` + core 单测**；**不扩 LibraryContract、不动 daemon `/lyrics`**（§1.5：seed 造不出歌词文件，且「读一个文件」不是三端会各执一词的库语义） |
| **i** | 重开应用回到哪 | **记住歌与进度，启动为暂停态**。承诺是「恢复到 **JS 最后观测到的位置**」；节能优先（三个转折点 + 搭车 60 秒节拍，**不新增定时器**）；连队列来源一起恢复；**不为 D16 收敛特设清理** |
| **j** | 点一首没有文件的歌 | **可点，明说「下载在 N4 开放」**。吞掉点击的行会被当成坏了（N2f 手测结论） |
| **k** | 耐久验收 | **不做长跑**。本批只保留 ≥5 分钟后台/锁屏与几十秒的句柄短测；耐久留给打包后的真实使用，代价写在 §4 末尾 |
| **l** | 用不用 `AudioPlaylist` | **不用**。§2.4 的四条语义与 §2.6 的快照口径它一条都不知道；**而且它也换不来锁屏切歌**（§1.9：两个注册点同一个 callback） |
| **m** | 加载 watchdog 与错误文案 | **watchdog 15 秒，只管「收不到终态」**；`status.error` 一到就立即终止。文案照 M4-6：停死并说明，**不重试** |
| **n** | 「拒绝」要不要出声 | **只有用户主动按键（next / prev / 点队列里的一首）的拒绝出 toast**；自然放完导致的停止不出声——弹提示是在为「结束」道歉。minibar 的暂停态就是它的反馈 |
| **o** | 队列跟视图还是跟播放 | **跟播放：起播那一刻冻结成快照**（§2.6）。代价是两端口径不同，判据 13 守着 |
| **p** | 竞态模型（v4 新增） | **把 `player/queue.ts` 的 `createOperationQueue` 一并提进 `@lark/shared`**。它是零 import 的纯 TS，串行 + generation + 「最后意图胜出」正是移动端要的（连点两首、A 没加载完就加载 B、旧超时销毁新 player、seek 与切歌交错）；deadline 那个可选参数留给桌面的远程命令 |

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| **耐久性在本批没有证据**（决策 k 的代价） | 判据 5 只证明「不是一开始就断」，判据 24 只证明换歌不漏句柄。vivo 杀后台这条风险原样留着，进 `PROCESS.md` 的待办，**不是当成过了** |
| **锁屏/车机切不了歌**（§1.9 的代价） | v1 收窄已记；逃生口已定价（改 Kotlin + 拦命令 + 桥接 JS + 维护补丁）。**蓝牙歌词是 v1 功能，所以这条是用户真会感觉到的** |
| **#47569 的泄漏音轨在开发期反复出现** | §2.3 把 pause-before-release 做成结构上绕不过去的；判据 3 的反测是哨兵。开发期随手 `adb shell am force-stop com.orpheusaviary.lark` |
| **蓝牙歌词的 2 秒 queue 陷阱** | 判据 18 只记录不判定；真踩上要打补丁或加 config plugin，**超出「小功能」的预算** |
| **没有带屏蓝牙设备** | 用户已决定：不实测、先开发。判据 16/17 测的是**我们发出去的** |
| 决策 a/p 动桌面 `player.ts` | 判据 7：三个桌面测试原样绿（**diff 只有删除**是切面画对了的信号，N1h 记过） |
| **队列口径两端分叉**（决策 o） | 判据 13 守移动端，桌面一个字不改。分叉写进 §2.6 与 PROCESS，别让后来的人以为哪边是 bug |
| **原生配置升级后安静地漂** | 判据 3b 对 merged manifest 断言，带反测 |
| **判据变成概率题** | shuffle 注入 `random`、蓝牙歌词次数与主机算出的期望值对照、删掉内存断言、焦点行为表开工前冻结 |
| `pnpm install` 扰动桌面 | 常驻判据：每次依赖变动复跑桌面 `just check` + `just test` |
| **真机验收期间人在用手机** | N2f 的教训：开跑前说一声、跑完说一声；`not in front` 之类的失败**默认解释是人为干扰** |

---

## §7 参考

- 主计划 §4.3 的 N3 行、§4.4 风险、§4.5 蓝牙歌词修订段：`docs/plans/2026-08-13-m4a-and-mobile-master-plan.md`
- N0 子计划 §5（N3 框架）· §9（设备档案、判据 19 实测、release/pause 与 becoming-noisy 两条债）：`docs/plans/2026-08-17-phase-b-mobile-n0.md`
- N2 子计划 §1.10 / §2.5（蓝牙歌词输入与节流）· §8.3（手势栈取舍）· §8.4（判据 20 的落地修订）：`docs/plans/2026-08-19-phase-b-mobile-n2.md`
- 桌面播放器：`stores/player.ts:55,284,298,314,324,347`；串行队列 `player/queue.ts`；歌词面板 `components/LyricsPanel.tsx`；控制条 `components/Controls.tsx:80,111`
- 判定函数与开关：`packages/shared/src/now-playing.ts`、`packages/core/src/portable/now-playing-mode.ts`
- 歌词与路径：`packages/shared/src/lrc.ts`、`portable/library/lyrics.ts:27`、`apps/mobile/src/ports/paths.ts`（`songAudio` 直接给 `file://` URI）
- 契约面（为什么不扩）：`portable/services/contract/types.ts:31-38`（seed）、`:69`（`LibrarySubject`）
- 库变更信号的现状：`apps/mobile/src/ui/library-context.tsx:62`
- spike 的播放面板与原生配置模板：`spikes/mobile-foundation/src/panels/playback.ts:72,439,450`、`spikes/mobile-foundation/app.config.ts:28,45`
- expo-audio 源码（本批的事实来源）：`build/AudioModule.types.d.ts:180,220-225`、`build/Audio.types.d.ts:189-215,243`、`android/.../AudioPlayer.kt:158`、`android/.../service/AudioMediaSessionCallback.kt:27-31`、`android/.../service/AudioControlsService.kt:374,455`
- 实施记录：`PROCESS.md` 的 Phase B 段；踩坑：`docs/LESSONS.md`

---

## §8 评审修订对照（v3 → v4）

| # | 评审反例 | 复核结果 | v4 的处理 |
|---|---|---|---|
| P0-1 | 锁屏 next/prev 在钉版上不可实现，判据 2 要求了一个不存在的能力 | **属实，且比反例更硬**：`AudioMediaSessionCallback.kt:27-31` remove 四个命令，而 `AudioControlsService.kt:374,455` **两个注册点同一个 callback**——**换 `AudioPlaylist` 也救不了**，反例给的第二个选项不成立 | 新增 §1.9；**v1 收窄**（用户 2026-08-20 决定）：锁屏只承诺播放/暂停/seek；判据 2 改写；逃生口定价后记入 §6 |
| P0-2 | `AudioStatus` 有 `error`，「只能靠超时」是错的 | **属实，是我的事实错误**：`Audio.types.d.ts:243` 有 `error: string \| null`，`AudioPlayer.kt:158` 的 `onPlayerError` 经 status 发上来。v3 读到 `:215` 就停了，**从截断的阅读里断言了一个否定** | §1.4 整节重写：`status.error` 立即终止 · watchdog 只管收不到终态 · 两条同一销毁路径；判据 4 改成「坏文件必须**在超时之前**被 error 终止」并带反测 |
| P0-3 | `app.config.ts` 缺 expo-audio plugin 与 `POST_NOTIFICATIONS` | **属实**。spike 的 config（`:28`/`:45`）已是正确模板 | 新增 §1.8；N3a 显式加权限与 plugin 选项；**新增判据 3b（merged manifest gate，带反测）** |
| P0-4 | 异步播放没有竞态模型，而桌面 `queue.ts` 其实是纯 TS | **属实，是我的判断错误**：`createOperationQueue` 零 import、只注入 `now`，deadline 才是远程专用 | §1.1 的表改成三堆；**新增决策 p**：`createOperationQueue` 一并进 shared，N3a 冻结「最后意图胜出」 |
| P0-5 | 后台进度记忆的时间逻辑不成立，判据 22 的反测取决于偶然 | **属实**：「进 background 写一次」只保存那一刻；60 秒节拍在熄屏时不确定 | §2.7 承诺改为「恢复到 **JS 最后观测到的位置**」；判据 22 的数字只对**前台**成立，熄屏只断言「不是 0」；**换掉那个不成立的反测**（改成「去掉 60 秒节拍 → 前台必红」） |
| P0-6 | 「共享五个纯函数」没有定义 API；且 §2.4 说静默、决策 n 说出声 | **属实**，两条 | §1.1 定义 `QueueDecision`；§2.4 改写成**决定矩阵**，UI 呈现归宿主——两头话由此消失 |
| P0-7 | 删除后的队列收敛没有事件通道 | **属实**：`library-context.tsx:62` 的 `changed()` 只更新 React 局部状态 | 新增 §2.8（**最小信号，不做通用 reconcile 协议**）；判据 14 带反测 |
| P1-1 | 判据 8 排在 N3b，但生产 UI 到 N3c 才有，也没规划 harness | **属实** | 判据 8 **移到 N3c**；**N3b 因此是一个零手机的纯桌面批**（§3 的表新增「需要手机」一列） |
| P1-2 | 多条判据不可稳定判定（shuffle 概率 · 次数无容差 · 内存 · 焦点行为没有预冻结） | **全部属实**；且「次数 ≈ 歌词行数」还漏了**去重**——真值是相邻不同输出的段数 | 判据 6 注入 `random`；判据 17 改成**与主机算出的期望值对照**（N2f 的跨设备对照模式）；判据 24 **删掉内存断言**；判据 20 **开工前冻结三条行为** |
| P1-3 | 「每格一个变异且不能连带红」与共享 helper 冲突 | **属实，规则自相矛盾**：共享行为被改坏本来就该多条一起红 | 判据 6 改成「**每一格都要有一个只属于它的变异**」，删掉「不能连带红」 |
| P1-4 | `readLyrics` 的契约成本被低估 | **属实**：`ContractSongSeed`（`types.ts:31-38`）只有 `fileBytes`，造不出歌词文件，且要动三个 hook | 决策 h 收窄：**加 service 方法 + core 单测，不扩 LibraryContract** |
| 小-1 | 「批次表前后倒置」 | **只有判据 8 那一处属实**。判据 2 收窄之后 N3a/N3b 的顺序没有问题 | 见 P1-1；其余不改 |
| 小-2 | 恢复规则缺失（歌单已删/已空 · `duration === 0` · `position === duration`） | 属实 | §2.7 的失效面补齐，判据 23 逐条 |
| 小-3 | 九条决策未关闭 | 属实但那是状态不是缺陷 | **a–p 全部关闭**（用户授权），本文即定稿 |

### §8.1 实施修订（v4 → 落地，N3a–N3c）

计划再细也有实施才看得见的东西。下面每一条都是**跑的时候撞上的**，不是事后觉得应该改的。

| # | 计划怎么写的 | 撞上了什么 | 现在怎么定 |
|---|---|---|---|
| 1 | 判据 3「每条销毁路径之后都看不到活跃播放器」 | **和后台播放的定义直接矛盾**——按 home、按 BACK 本来就该继续响 | 改成对**我们名下的活跃播放器数**断言：切歌恰好一个 · 显式停止零个 · BACK 继续播且仍是一个（判据 3 已改写） |
| 2 | 判据 1 含 seek / 进度显示 / 时长比对 | N3a 没有进度条，**没有可观测量** | 那三件挪到 N3c；N3a 只认播放/暂停 |
| 3 | 判据 4 的设备那半 | 生产构建**造不出坏音频文件**（`Paths.document` 推不进去，UI 里点不出来） | 跑在 acceptance artifact 上，随 N3c 之后的 acceptance 一起；N3a 交宿主无关那半 |
| 4 | 判据 8「真机四模式」在 N3b | N3b 时**没有 UI 可驱动**，也没规划 harness | 挪到 N3c；**N3b 因此是零手机的纯桌面批** |
| 5 | N3b 含「四模式 + 持久化」的移动端接线 | 它要三样 boot 之后才存在的东西，而 `player/index.ts` 是 import 时就建好的**进程级单例** | store 的队列与模式挪到 N3c，N3b 只出 `decideNext` 与 `local_metadata.play_mode` |
| 6 | §1.9 只写了「切歌不可用」 | 通知上**连播放/暂停都没有**——expo-audio 只在 API ≤ 32 给通知加 action，而这台机器把媒体通知当普通通知画 | `patches/expo-audio@57.0.3.patch` + `buildFromSource`；结果是后退 10s ｜ 播放/暂停 ｜ 前进 10s 三个按钮。**进度条与展开态按钮居左：已知不做** |
| 7 | 判据 15「歌词三态各放一次 + 点没有文件的歌」 | 夹具库里**没有** `has_file === false` 的歌，四首也都有歌词 | **如实记着没验**；等 N4 有下载链路、库里自然出现无文件的行时再补 |

**另外三件与判据无关但值得记**（细节在 `docs/LESSONS.md`）：`locationX` 是相对被触摸的**子视图**的（点击跳回开头 + 拖动跟位移，两次咬人）· 走着的秒数让 `uiautomator dump` 直接失败 · 百分比布局挂在没有高度的父节点上会静静地画错（队列面板 6 首只画 2 行）。
