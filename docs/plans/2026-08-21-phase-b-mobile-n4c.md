# Phase B · N4c 前台服务（`apps/mobile`）

- **日期**：2026-08-21（**v1，待用户评审**）。决策 a–j 待关闭，**其中 g 已于 2026-08-21 关闭（照倾向复用）**。
- **这是 N4 子计划里 N4c 那一行的展开**，不替代它：`docs/plans/2026-08-20-phase-b-mobile-n4.md` 的 §1.9（五条生命周期事实）· §2.6（**冻结的状态机**）· §5 决策 e（自建 `modules/lark-transfer`）· 判据 15–19 全部原样继承。这份只写「怎么落地、分几批、怎么验」。
- **前置**：**N4b 已完成**（head `fd38d09`，判据 5–14 全关）。手机上已经有：引擎 + 进程级 hub（`downloads/hub.ts`）· 落盘协议（含 ③b 完整性检查与 ⑤⑥ 之间的崩溃点）· 启动清扫 ⑪b · 共享 claim registry。
- **基线**：2026-08-21 实测 `just check` exit 0、`just test` exit 0 / **2736 passed**（shared 129 · core 1226 · mobile 59 · cli 428+9 skipped · daemon 468 · gui 427）。
- **冻结设备**：vivo V2408A（Android 15 / API 35），数值与行为判据一律 **release 构建**。

---

## §0 范围

**做**：`modules/lark-transfer` 自建原生模块（dataSync 前台服务 + 通知渠道 + `onTimeout`）· `downloads/foreground.ts` 状态机（§2.6 冻结的那个）· 第一次下载时申请通知权限 · 降级态 · acceptance 触发长曲下载的入口 · 判据 15–19。

**不做（本批）**：添加页与任务列表 UI（N4d——本批的降级态与「正在下载 N 首」**只保证可读**，不保证有屏幕看）· 通知上的取消按钮（N4d 有了任务列表再说）· 每首一条通知（§2.6 定死一条）· `expo-notifications` 依赖（§1.9：**没有它，所以「被系统暂停」只在应用内可见**）· 电量/耐久的长跑（判据 15 只证明一条长曲一次下完）。

**一句话的边界**：N4b 之后手机能下完一首歌，**前提是你一直看着它**；N4c 之后，熄屏、切后台、去泡杯茶，那 50MB 还在走。

---

## §1 开工前必须知道的

### 1.1 判据 15 是本批唯一的理由，别让它被别的东西挡住

排在 N4d 之前的原因写在 N4 §3：「之后每次手测都涉及分钟级下载，**熄屏就死的下载会污染后面每一批的结论**」。所以本批的第一个可跑判据就应该是 15，而不是最后一个——**如果长曲在熄屏下下不完，状态机写得再漂亮也没用**，决策 j（wake lock）就得当场重开。

### 1.2 五条生命周期事实（N4 §1.9 原样继承，逐条给落点）

| 事实 | 落点 |
|---|---|
| 权限与类型：`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC` + `foregroundServiceType="dataSync"` | §2.3；判据 16 断言 **merged manifest**，不是断言 config |
| 🔴 **起服务的时机是用户手势，不是任务入队** | §2.4 的 `arming`；判据 17① |
| 🔴 **`onTimeout` 要停的是全部，不是 running** | §2.4；判据 18（单测） |
| 🔴 停了 FGS 就没法用它的通知说话，而**我们没有 `expo-notifications`** | 「被系统暂停」只进 hub，不承诺通知；判据 18 只记录 |
| 🔴 通知权限今天只在第一次播放时申请 | §2.5；判据 19 |
| 起不来怎么办：catch `ForegroundServiceStartNotAllowedException` → 照常下载 + 降级态可见 | §2.4 的 `degraded`；判据 17③ |

### 1.3 已经量过的三件，本批直接用

- **`FOREGROUND_SERVICE` / `INTERNET` / `POST_NOTIFICATIONS` 已经在 merged manifest 里**（N4b 实测，见 `apps/mobile/android/app/src/main/AndroidManifest.xml` 第 2/4/6 行）：前两个来自 Expo 模板与 expo-audio 的插件，第三个来自 `app.config.ts`。**本批要新增的只有 `FOREGROUND_SERVICE_DATA_SYNC` 与我们自己的 `<service>`。**
- **原生模块发事件到 JS 的形态已有模板**：`modules/lark-audio`（`NativeModule<TEventsMap>`，**事件表必须是 `type` 不能 `interface`**，见 `docs/LESSONS.md`）。`onTimeout` 照抄。
- 🔴 **自建 Expo 模块必须有 `android/build.gradle`**，否则 autolink 静默跳过、启动即闪退（N4b 实测，代价一次装机往返）。守卫 `scripts/check-mobile-native-modules.sh` 已在 `just check` 里，**新模块一样受它管**。

### 1.4 manifest 从哪来：模块自带，不写第四个 config 插件

`android/` 是 CNG 产物、不进版本库，所以「能对 manifest 说话的只有 `app.config.ts` 与插件」——这是 D16 那一批的结论，**但它有个更省的出口**：Expo 本地模块是一个标准 AGP library，`modules/<name>/android/src/main/AndroidManifest.xml` 会参与 manifest 合并。于是权限与 `<service>` 声明**和它们描述的那个服务放在同一个目录里**，而不是散在 `plugins/` 里的第四个 JS 文件。

`with-backup-rules.js` 之所以必须是插件，是因为它改的是 **application 节点的属性**（`dataExtractionRules` / `fullBackupContent`）——那是 app 的属性，不是某个 library 的。本批加的是**新元素**（一条权限、一个 service），合并语义清楚，不与任何人抢同一个属性。

> **判据 16 因此有两句话**：merged manifest 里四样都在（含 `INTERNET`）；**且** service 的 `foregroundServiceType` 恰好是 `dataSync`——不是 expo-audio 那条 `mediaPlayback`（它也在同一份 manifest 里，`AudioControlsService`）。**两个服务、两条通知、两个 type，互不干涉**（N4 §2.6 末句）。

### 1.5 熄屏之后 JS 说的话不算数

N0b-4a 已经量过：**`performance.now()` 在 RN Android 上是 `SystemClock.uptimeMillis()`，深睡期间不走**；N3f 又量过熄屏后 JS 定时器被冻结。所以判据 15 的证据**一律取主机侧**：

- 服务在不在：`adb shell dumpsys activity services com.orpheusaviary.lark`
- 文件到没到：落地文件的最终大小（与 `long` 夹具的 54,273,999 字节比）
- 行落没落库：下一次前台启动时读 `songs`

**不取 JS 自述的进度**，因为熄屏期间进度回调本来就可能被压掉——**压掉不等于没下**，这正是判据 15 要分清的两件事。

### 1.6 一条还没量过的、可能推翻状态机的事

**`File.downloadFileAsync` 的传输在熄屏时到底跑在哪。** 它是原生线程，理论上不受 JS 冻结影响；但如果 Expo 的实现把 chunk 回调排到 JS 线程并**等待**它，那 JS 一冻传输就停。判据 15 会一次性答掉；答错的话决策 j 从「不加 wake lock」翻面。

**开工前不猜，开工后第一件事就是量它**（§3 的 N4c-1 排序理由）。

---

## §2 目标结构

### 2.1 文件布局

```
apps/mobile/
├── modules/lark-transfer/            ← 新（N4c-1）
│   ├── index.ts                      ← start / update / stop + onTimeout 事件
│   ├── expo-module.config.json
│   └── android/
│       ├── build.gradle              ← 不能忘（§1.3）
│       └── src/main/
│           ├── AndroidManifest.xml   ← 权限 + <service>（§1.4）
│           └── java/expo/modules/larktransfer/
│               ├── LarkTransferModule.kt
│               └── LarkTransferService.kt
└── src/downloads/
    ├── foreground.ts                 ← 新（N4c-2）：§2.4 的状态机，注入式
    ├── foreground.test.ts            ← 新（N4c-2）：判据 18 与 17 的逻辑半边
    └── engine.ts                     ← 改（N4c-2）：把控制器接到 hub
apps/mobile/src/acceptance/
└── foreground.ts                     ← 新（N4c-3）：长曲下载入口 + 降级态注入
```

### 2.2 原生模块的 API（**本批冻结**）

```ts
export type LarkTransferEvents = {
  /**
   * Android 收回了 dataSync 的配额（API 35 起，24 小时累计 6 小时）。
   * 服务必须当场停，应用必须当场取消全部任务（§2.4）。
   */
  onTimeout(): void;
};

interface LarkTransferNativeModule extends NativeModule<LarkTransferEvents> {
  /**
   * 起服务并立刻 `startForeground`。
   * 抛 `ERR_LARK_FGS_NOT_ALLOWED`（映射 `ForegroundServiceStartNotAllowedException`）
   * —— 调用方据此进降级态，**不失败下载**。
   */
  start(title: string, body: string): Promise<void>;
  /** 只换通知文案，不重新 `startForeground`。服务没起时是 no-op。 */
  update(title: string, body: string): Promise<void>;
  /** 幂等：没起过也安静返回。 */
  stop(): Promise<void>;
  /** `dumpsys` 之外，给 acceptance 的自述。 */
  isRunning(): Promise<boolean>;
}
```

**三条实现约束**：

1. **`startForeground` 必须在服务 `onCreate`/`onStartCommand` 的 10 秒内调用**（Android 8+；14 起更严）。所以 `start()` 是 `startForegroundService` + service 自己在 `onStartCommand` 里第一件事就 `startForeground`，通知内容从 Intent extra 取。
2. **通知渠道自己建**（`NotificationManager.createNotificationChannel`），`IMPORTANCE_LOW`——**不出声、不横幅**。一个正在下载的进度条不该打断任何事。
3. **`onTimeout(startId, fgsType)` 必须 override**（API 35），里面**只做两件事**：发 JS 事件、`stopSelf()`。取消任务是 JS 的决定（§2.4），原生不碰业务。

### 2.3 manifest（模块自带）

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>
  <application>
    <service
      android:name=".LarkTransferService"
      android:exported="false"
      android:foregroundServiceType="dataSync"/>
  </application>
</manifest>
```

`FOREGROUND_SERVICE` 不重复声明——已经在合并结果里（§1.3），重复声明是无害的噪音，**但判据 16 断言的是合并结果，所以少写一行不影响验收**。

### 2.4 状态机（N4 §2.6 冻结，这里补齐边）

```
        idle
         │  arm()  ← 用户点「下载」的那一刻（此刻必定前台，合法）
         ▼
      arming ──── start() 抛 NOT_ALLOWED ──▶ degraded ──活动归零──▶ idle
         │                                    （照常下载，只是没有通知）
         │ 入队成功（hub 出现活动任务）
         ▼
      running ──── 活动任务归零 ──▶ [2 秒宽限] ──▶ idle
         │              ▲                │
         │              └── 又有任务 ────┘（取消停）
         │
         └── onTimeout ──▶ paused-by-system
                            （先原子取消 queued + running，再 stop()）
```

**每条边的理由，一句一条**：

- **`arm()` 在手势那一刻**：入队之前还有秒级网络预检（短链展开 + pagelist）；用户在这段时间切后台，入队时再起 FGS 就撞 Android 12+ 的后台启动限制。**预检后什么也没入队就撤**（`arming` → `idle`）。
- **2 秒宽限**：两条任务之间的空隙不该让通知闪一下。期间又有任务就取消停。
- **`onTimeout` 取消全部**：只取消 running 的话 queued 会立刻顶上，等于没停。**顺序是「先取消，后停服务」**——反过来会有一个窗口，服务已停而任务还在跑，那正是系统刚刚禁止的事。
- **`degraded` 不是失败**：让一次下载因为通知服务起不来而失败更糟；静默当成功也不行。**它必须在 hub 里可读**，N4d 渲染它。

**状态机是纯逻辑，注入三样**：`service`（上面那个原生 API 的形状）· `downloads`（hub 的 subscribe/getState）· `engine`（`snapshot` / `cancel`）· `setTimeout`。于是判据 18 与 17 的逻辑半边**在笔记本上跑**（`foreground.test.ts`），设备只回答它自己才能回答的部分。

### 2.5 通知权限：第一次下载也申请

`ensureAudioSession()` 已经在首播时申请（`player/session.ts`，`configured` 是 promise 不是 boolean，两次调用共享同一次配置）。**下载侧复用同一个函数**：

- 理由与首播同构：用户刚点了下载，此刻有上下文；
- 复用而不是自己调 `requestNotificationPermissionsAsync`，是因为那个函数还顺带配了音频会话——**分开调会出现「下载申请过、播放又配一次」的两条路径**，而 `ensureAudioSession` 本来就是幂等的一次。

> **决策 g 已关（2026-08-21 用户「照倾向复用」）**，而那句「越界」的代价实测比想象中还小 —— 读 `expo-audio` 的 `AudioModule.kt:211`：`setAudioModeAsync` **只把三个标志存进模块的内存变量**（`shouldPlayInBackground` / `interruptionMode` / `playsInSilentMode`），再遍历已存在的播放器与录音器把标志推下去（下载路径上这两个集合都是空的），最后 `if (!shouldPlayInSilentMode())` 那个分支因为我们设了 `playsInSilentMode: true` 而什么也不暂停。
>
> **它不申请音频焦点**：`requestAudioFocus()` 只在真正播放时调（`:312` / `:477` / `:501` / `:797`）。所以从下载路径调它**不建 AudioTrack、不抢焦点、不弹通知、不影响任何正在播的应用**——可观察后果为零，只是把三个标志提前写好。这段实测要写进 `session.ts` 的注释，因为「它看起来越界但其实是惰性的」正是下一个人会重新怀疑一遍的事。

### 2.6 「活动任务」怎么数

hub 的 `tasks` 里 `state` 为 `queued` 或 `running` 的条数。**lyrics 任务也算**（决策 h）：它也是网络工作，而且紧跟在下载之后——分开数只会让服务在两者之间闪一下，正是 2 秒宽限要避免的事。

通知文案：`正在下载 N 首` + 当前这首的名字（hub 里第一条 `running` 任务的 `title`）。**节流 1 秒**——通知更新是跨进程 IPC，而进度事件本身已经被引擎节流到 500ms。

---

## §3 批次划分

| 批 | 内容 | 需要设备 | 判据 |
|---|---|---|---|
| **N4c-1** | `modules/lark-transfer` 全部（Kotlin + manifest + build.gradle + index.ts）· **acceptance 里一个最小「起服务 → 熄屏下长曲 → 停」的直通入口** | 是 | **15 · 16**（两条都是 gate） |
| **N4c-2** | `downloads/foreground.ts` 状态机 + 单测 · 接到 hub · 权限复用 | 否（单测在笔记本） | 18（单测）· 17 的逻辑半边 |
| **N4c-3** | acceptance 面板：降级态注入 · 三态观测 · 全新安装的权限流程 | 是 | 17 · 19 |

**顺序理由**：N4c-1 最前，因为 §1.6 那条**一次熄屏下载就能答**的问题必须在写状态机之前答掉——答错了（传输随 JS 一起冻）整个 N4c 的形状要改（决策 j 翻面）。判据 16 顺带在同一次构建里验掉。N4c-2 全部离线，是本批唯一能靠单测收敛的部分。N4c-3 收尾。

---

## §4 判据

**继承 N4 子计划的 15–19，逐条给出「怎么跑」**：

15. **【gate】进程可回收时下完长曲**（**2026-08-21 实测后改写，原文见下**）：`long` 夹具那条视频（BV1LtgV6ZE2U **p1**，**54,273,999 字节**，37:07）在**应用切到后台 + `adb shell am kill` + 熄屏**之后仍然下完。`am kill` 只杀「可以安全杀掉的」进程并**明确豁免持有前台服务的进程**，所以它就是 FGS 那条性质本身。**证据全部取主机侧**（§1.5）：kill 之后 `pidof` 还在 · `dumpsys activity services` 里服务在 · 落地文件大小逐字节等于夹具 · `songs` 里有行且 `duration` 与 ffprobe **±1s**。**反测**：同一条**不起服务**跑一遍——`am kill` 之后 `pidof` 必须为空。
    > 🔴 **原文是「熄屏 4 分半下完」，实测两侧都绿，当场按本条自己写的规则改掉。** 4 分半、内存宽裕、应用刚离开前台时，Android 根本不打算回收这个进程——**熄屏时长不是区分变量**。两次实测都 `landed 54273999 of 54273999`，一次带服务一次不带。判据必须挑一个**只有目标机制才产生得出**的差别（N3f 那条「恰好整分的数字」是同一个道理）。**顺带答掉了 §1.6**：熄屏下 `File.downloadFileAsync` 的传输照走，没有把 chunk 押在 JS 线程上，**决策 j（不加 wake lock）成立**。
    > **`am kill` 要先把应用切到后台**：可见的 Activity 不属于「可以安全杀掉」，前台状态下两侧都杀不动。
16. **【gate】merged manifest**：`FOREGROUND_SERVICE` · `FOREGROUND_SERVICE_DATA_SYNC` · **我们那条** service 的 `foregroundServiceType="dataSync"` · `INTERNET` 全在，**且** expo-audio 的 `AudioControlsService` 仍是 `mediaPlayback`（两个服务不许互相污染）。**反测**：去掉模块 manifest 里的 `foregroundServiceType` → 必须红。
17. **状态机三态**：① 手势那一刻服务就起——`arm()` 之后、预检还没回来时 `dumpsys` 里已经有它；② 活动任务归零 **2 秒后**停、通知消失；③ **起不来时照常下完**且降级态在 hub 里读得到。**反测**：把起服务挪回入队时刻 → 「预检期间切后台」必须复现起不来（这条**在设备上跑**，因为它是 Android 的后台启动限制在说话）。
18. **`onTimeout` 停的是全部**：单测断言 `onTimeout` → **queued 与 running 一起取消** + `stop()` 被调用 + 状态置 `paused-by-system` + **取消发生在 stop 之前**。**反测**：只取消 running → 必须红。**6 小时配额没有真机证据，如实记「有代码路径、有单测、没有真机证据」。**
19. **通知权限在第一次下载也申请**：**全新安装**（`pm clear` 或卸载重装）→ 不播放、直接下载 → 权限对话框出现，授予后通知可见。**反测**：只在首播申请 → 下载通知必须不可见。

**本批新增三条**（都因为 N4b 的经验）。**编号从 41 起**：N4 主计划的 §4 把 20–25 给了 N4d（它的 22 还是 gate），子计划另起一套号会让「判据 22」在同一个里程碑里指两件事。

41. **`lark-transfer` 进得了构建**：`just check` 的 `mobile-native-modules` 守卫对新模块绿，且**装机后 `requireNativeModule('LarkTransfer')` 不抛**——N4b 的闪退是在任何画面之前发生的，这条便宜得不该省。
42. **服务停了就是真停了**：`stop()` 之后 `dumpsys activity services` 里没有 `LarkTransferService`，通知栏里没有我们的条目。**幂等**：连停两次不抛。
43. **两个服务互不干涉**：一边放歌（媒体服务在）一边下载（dataSync 服务在）→ `dumpsys` 两条都在、两条通知都在，**停下载不影响播放**。

---

## §5 决策（a–j，**全部待关闭**）

| # | 决策 | 倾向 | 关键理由 |
|---|---|---|---|
| **a** | 服务形态 | **`startForegroundService` + 自己的 `Service`**，不用 bound service | 我们不需要跨进程 API，只需要「进程别死、系统知道我在干活」。bind 会把生命周期和调用方绑在一起，而调用方是 JS |
| **b** | 通知渠道 | **模块自己建**，`IMPORTANCE_LOW` | 没有 `expo-notifications`，也不该为一条通知加一个依赖。LOW = 不出声不横幅 |
| **c** | 通知文案 | `正在下载 N 首` + 当前这首的名字，**1 秒节流**，点击回应用 | 通知更新是 IPC；引擎已把进度节流到 500ms，再叠一层是廉价保险 |
| **d** | `onTimeout` 的分工 | **原生只发事件 + `stopSelf()`；取消任务是 JS 的决定** | 原生模块不碰业务，是这三个自建模块一贯的边界（`lark-fs` / `lark-audio` / `lark-media` 各只做一件事） |
| **e** | 降级态存哪 | **hub**（`downloads/hub.ts` 加一个字段） | N4d 要渲染它，而 hub 已经是「下载这件事的唯一读面」；再开一个 store 就是第二个真相 |
| **f** | `arm()` 谁调 | **N4c 由 acceptance 直调；N4d 换成添加页的提交按钮** | 本批没有 UI，而「手势那一刻」是判据 17① 的全部内容——入口形状必须先定死 |
| **g** | 通知权限 | **复用 `ensureAudioSession()`** | 幂等、一条路径；代价是第一次下载会顺带配置音频会话（§2.5 已写明这句越界） |
| **h** | lyrics 任务算不算活动 | **算** | 分开数会让服务在下载与歌词之间闪一下，正是 2 秒宽限要避免的 |
| **i** | 判据 15 的证据 | **全部主机侧**（服务 + 文件大小 + 行） | 熄屏后 JS 定时器被冻结、`performance.now()` 不走（N0b-4a / N3f 实测） |
| **j** | wake lock | ✅ **不加（2026-08-21 实测关闭）** | 判据 15 两侧都证明：熄屏 4 分半，54.3MB 一次下完、逐字节不差。传输在原生线程上，JS 冻结不影响它。**不需要 `PARTIAL_WAKE_LOCK`，省下的是电量** |

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| ~~🔴 传输随 JS 一起冻（§1.6）~~ | ✅ **2026-08-21 实测排除**：熄屏 4 分半 54.3MB 逐字节下完。决策 j 因此关闭为「不加 wake lock」 |
| 🔴 **vivo 杀后台**（系统在下载进行中杀掉进程，不是驱动脚本点不中） | N3 已记「耐久留给打包后的真实使用」。判据 15 只证明一条长曲一次下完；**杀后台的风险原样留着**，不假装被这批消掉。**真机 session 里若 app 被系统清掉导致驱动失效，明确请用户手动杀后台 + 重启 app**（2026-08-21 用户提供的手段） |
| **6 小时配额测不了** | 判据 18 只到单测。如实记 |
| **`startForeground` 10 秒死线** | 通知内容走 Intent extra，`onStartCommand` 第一件事就 `startForeground`，中间不做任何 IO |
| **两个前台服务打架** | 判据 43 明确验一次。两个 type、两条通知、两个 service 类 |
| **判据 19 要全新安装** | `pm clear` 会连同 SecureStore 一起清 → **D16 会走 fresh 分支**，这是对的（新安装本来就该如此），但要记着它会毁掉当前曲库，**跑在设备 session 的最后** |

---

## §7 本批不会证明的事（先写在这里）

- **dataSync 的 6 小时配额**（判据 18 只有单测）。
- **下载期间的长时间耐久**：判据 15 只证明一条 37 分钟的曲子一次下完；连续几小时、多次熄屏唤醒、vivo 的省电策略，都不在内。
- **通知里的取消按钮**（N4d）。
- **「被系统暂停」的通知提示**——我们没有 `expo-notifications`，停了 FGS 就没法用它的通知说话，所以这个状态**只在应用内可见**（N4 §1.9 原文）。
- **Doze 深度休眠下的表现**：判据 15 的熄屏时长按一次下载算（分钟级），够不到 Doze 的门槛。

---

## §8 实施修订（N4c-2，2026-08-21）

**§2.4 的状态机按 v1 原样落地会有两个洞，都是「没有触发源」类的**，逐条记在这里，图不改：

1. **`arming → idle` 那条边没有触发源 → 加了 `settle()`。** 状态机订阅的是 hub，而 hub 只在引擎有动静时才响；「预检后什么也没入队」这件事**恰恰是没有动静**，于是 `arming` 会一直挂着、服务一直举着这个进程。控制面因此是两个调用而不是一个：`arm()` 在手势那一刻，`settle()` 在调用方的 `finally` 里（预检抛了也得撤）。给 `arming` 设超时是另一条路，被否掉——一次合集预检可以跑二十秒，超时值只能靠猜。
2. **`paused-by-system` 没有出边 → `arm()` 允许从它再来一次。** 图冻结的是**自动**边，而再点一次下载是用户的决定，不是自动边。配额真没了系统会拒，那就落进 `degraded`（照常下载、可读），这正是它存在的意义；不给出边则等于「一次配额到期之后这个进程再也起不了服务」。
3. **`degraded` 归零时照样调 `stop()`。** 按我们自己的记账服务从没起来，但 N4b 实测过反例：`start()` 抛了异常而服务其实已经起来（`ComponentName` 转不了，副作用先发生）。`stop()` 幂等，不调的代价是一个永远举着的服务。
4. **降级态带 `reason`**（决策 e 只说「加一个字段」）：`ERR_LARK_FGS_NOT_ALLOWED`（系统拒绝，正常事）与「模块本身坏了」必须分得开——**自建模块静默不存在正是 N4b 丢掉一个下午的那条**（`docs/LESSONS.md`）。
5. **`onTimeout` 里先置 phase、再取消。** 取消会逐条唤醒 `reconcile`，而 phase 还是 `running` 时的「活动归零」分支会排一个 2 秒后的停——它落地时把 `paused-by-system` 覆盖成 `idle`，应用就忘了自己是被系统停的。单测「does not let the emptied queue call itself idle」守着这条。
6. **取消顺序是 queued → running**（§2.4 的「原子」在实现上的样子）：先取消 running 会放开 worker，被顶上来的 queued 任务就是「系统说停之后才开始的工作」。
7. **通知的标题/正文分工定死**：title = `正在下载 N 首`，body = 当前这首的名字（N4c-1 的 acceptance 直调写的是 `('lark', '正在下载 1 首')`，那是临时的）。没名字时回落到用户输入的链接/关键词，**不编造**（`DownloadTaskData.title` 的合同原文）。
8. **去重与节流是两条独立的守卫，测试必须分开写。** 第一版把它们并成一条断言，**在实现里完全没有去重的情况下照样绿**——节流自己把重复的丢掉了。两条测试各自的反测都点着之后才算数。

**判据**：**18 全绿（单测）· 17 的逻辑半边全绿**（①手势那一刻就 `start`、②归零 2 秒后才停、③起不来照常下完且降级态可读）。判据 17 剩下的一半（`dumpsys` 里服务在不在、后台起不来能不能复现）与判据 19、41–43 留给 N4c-3 的真机 session。

**八条反测逐条跑过**（列在 `foreground.test.ts` 的文件头）：只取消 running / 先停后取消 / phase 置晚 / 吞掉全部取消失败 / 去掉宽限 / 把 `start` 挪到入队时刻 / 去掉去重 / 去掉节流——每条都红在它该红的那个测试上。

**顺带的一条真实变化**：`downloads/engine.ts` 现在 import `modules/lark-transfer`，于是**生产 bundle 启动时就会 `requireNativeModule('LarkTransfer')`**（在此之前只有 acceptance 构建碰它）。这是判据 41 后半句想要的性质，也意味着模块接线出问题会以「启动即闪退」的形式暴露——守卫 `check-mobile-native-modules.sh` 已在 `just check` 里。

---

## §9 N4c-3 实测（2026-08-21，冻结设备 vivo V2408A / release 构建）

**判据 17 · 19 · 41 · 42 · 43 全关。** 每条都是「应用自述 + 主机独立核对」两侧，冲突时以主机为准。

| 判据 | 应用侧 | 主机侧 |
|---|---|---|
| **17①** | `phase arming · service running true · 0 active tasks`，25 秒停泊期后仍 `arming` + 服务在 | `LarkTransferService` t+2s 起来，`isForeground=true` · `types=0x00000001` · 渠道 `lark.downloads` · `importance=2`（LOW），整个停泊期都在 |
| **17②** | 归零 +1.0s 服务仍在、+3.5s 已停、`phase idle` | 服务在 t+30s 消失（每 1.5 秒采样） |
| **17③** | 注入拒绝：`phase degraded · reason ERR_LARK_FGS_NOT_ALLOWED · real service running false`；下载照样 `succeeded`，服务只被告知 `start (refused), stop`（**没有对着不存在的服务说 update**） | 全程没有服务记录 |
| **17 反测** | 见下 | **后台窗口 16 秒、0.4 秒一采，服务一次都没出现；一回前台立刻出现** |
| **19** | —— | `pm clear` 后 `granted=false` → 点「下载」（全程未播放）→ 3 秒内 `granted=true`、服务在、通知在 `lark.downloads` |
| **19 反测** | —— | `pm revoke` 后服务照样起来（t+3s、t+15s 都在），**通知一条都没有** |
| **41** | —— | 守卫 `mobile-native-modules` 绿；**生产包装机后正常启动**（四个 tab + 歌曲列表），启动时的 `requireNativeModule('LarkTransfer')` 没抛 |
| **42** | 2/2：`running after stop false · after a second stop false · second stop threw: no` | 服务 t+0 起、t+7 停；收尾时本包通知数 **0** |
| **43** | `download service running false · still playing true · phase idle` | 两个服务共存 ~45 秒（`AudioControlsService` + `LarkTransferService`）· t+21s 两条通知都在（`expo_audio_channel` + `lark.downloads`）· 期间 `state:started` 的 AudioTrack 恒为 1 |

### 9.1 🔴 反测答出来的是第三种行为，并且改了代码

**后台的 `startForegroundService()` 在这台机器上既不抛异常也不起服务——它被延后到应用回前台。** 于是：

- **对设计**：判据 17 的反测成立，而且比预想的更硬。「在入队时刻起服务」= 整个下载期间毫无保护（服务要等用户下次打开应用才出现），`arm()` 必须在手势那一刻。
- **对代码**：`start()` resolve **只等于「系统收下了请求」**。状态机原本只认「抛异常」这一种拒绝，于是这一整类下应用会以为自己受保护——**判据 17③ 的「降级态可读」在这条路径上是假的**。修法是 start 成功之后 2 秒回头确认一次（`START_CONFIRM_MS`，不 await，只会降级不会升级），确认不了就 `degraded` / `ERR_LARK_FGS_NEVER_STARTED`，并带 generation 与 phase 两道守卫（分别防「已 dispose 的控制器写 hub」与「对着已经结束的下载报警」）。单测 5 条 + 反测 3 条。
- **仍然做不到的**：后台窗口里 JS 是冻的，这个确认跑不了；等它能跑时服务已经真的在了。所以 `checkBackgroundArm` 的那一行是**记录不是判决**，判决属于主机的 `dumpsys` 采样。**产品线上够不到这条路径**——`arm()` 永远由手势触发，那一刻应用必定在前台。

### 9.2 反测的第一版是错的，错法值得记住

第一版用 `await wait(10_000)` 安排「后台 10 秒后 arm」——**后台的 JS 定时器是冻结的**（N3f / N0b-4a），那句 wait 直到应用回前台才到期，arm 于是发生在前台、服务正常起来、反测显示「Android 允许了」。**一个看起来成立的反面结论。** 改用 `AppState` 的 `change` 回调（切换那一瞬间到达，JS 最后能说话的机会）之后才测到真东西。

### 9.3 三条采样陷阱（都进了 `docs/LESSONS.md`）

- **前台服务的通知有约 10 秒延后**：`isForeground=true` 之后前 ~10 秒 `dumpsys notification` 里查不到它。断言「通知在」要等过这段，否则得到「服务在但通知没了」的错误结论。
- **`pm revoke` 会杀掉应用进程**；**`pm clear` 连外部夹具目录一起清**（要重推 `mobile-push-audio-fixtures`，且得先让应用把目录建出来）。
- **已经在库里的曲目会把「长下载」变成 4 秒**：判据 43 第一次跑只共存了 4 秒，因为长曲早被判据 15 下过了。验收要过程就先清库（`resetInstall()` + 删 `songs/`）。

### 9.4 本批仍未证明的

- **6 小时 dataSync 配额**：判据 18 只有单测，如实记「有代码路径、有单测、没有真机证据」。
- **判据 43 的「取消下载」那一刻**：实际跑的时候长曲已经自己下完（~45 秒），所以量到的是「传输服务自己退场、媒体服务与播放不受影响」，不是「取消进行中的下载」。对判据的主张（两个服务互不干涉）等价，但记着差别。
- **判据 19 的对话框本身**：`pm clear` 之后权限从 `granted=false` 变成 `granted=true` 是量到的，**但没有截到对话框**——这台 vivo 在三秒内就变成 granted 且带 `USER_SET`，是它自己代答还是弹了一下没抓到，没有证据。要证的那件事（**申请发生在下载路径上**）成立：全程没有播放，权限只可能是这条路要来的。
