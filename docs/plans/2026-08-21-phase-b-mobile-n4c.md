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

15. **【gate】熄屏下完长曲**：`long` 夹具那条视频（BV1LtgV6ZE2U p1，**54,273,999 字节**，37:07）在**熄屏 + 应用不可见**下下完，全程不重来。**证据全部取主机侧**（§1.5）：`dumpsys activity services` 里服务在 · 落地文件大小逐字节等于夹具 · 重启后 `songs` 里有行且 `duration` 与 ffprobe **±1s**。**反测**：同一条在**不起服务**的情况下再跑一遍——如果它也下完了，这批的 gate 就没有证明任何事，要当场改判据（比如加长熄屏时间或加上 Doze）。
16. **【gate】merged manifest**：`FOREGROUND_SERVICE` · `FOREGROUND_SERVICE_DATA_SYNC` · **我们那条** service 的 `foregroundServiceType="dataSync"` · `INTERNET` 全在，**且** expo-audio 的 `AudioControlsService` 仍是 `mediaPlayback`（两个服务不许互相污染）。**反测**：去掉模块 manifest 里的 `foregroundServiceType` → 必须红。
17. **状态机三态**：① 手势那一刻服务就起——`arm()` 之后、预检还没回来时 `dumpsys` 里已经有它；② 活动任务归零 **2 秒后**停、通知消失；③ **起不来时照常下完**且降级态在 hub 里读得到。**反测**：把起服务挪回入队时刻 → 「预检期间切后台」必须复现起不来（这条**在设备上跑**，因为它是 Android 的后台启动限制在说话）。
18. **`onTimeout` 停的是全部**：单测断言 `onTimeout` → **queued 与 running 一起取消** + `stop()` 被调用 + 状态置 `paused-by-system` + **取消发生在 stop 之前**。**反测**：只取消 running → 必须红。**6 小时配额没有真机证据，如实记「有代码路径、有单测、没有真机证据」。**
19. **通知权限在第一次下载也申请**：**全新安装**（`pm clear` 或卸载重装）→ 不播放、直接下载 → 权限对话框出现，授予后通知可见。**反测**：只在首播申请 → 下载通知必须不可见。

**本批新增三条**（都因为 N4b 的经验）：

20. **`lark-transfer` 进得了构建**：`just check` 的 `mobile-native-modules` 守卫对新模块绿，且**装机后 `requireNativeModule('LarkTransfer')` 不抛**——N4b 的闪退是在任何画面之前发生的，这条便宜得不该省。
21. **服务停了就是真停了**：`stop()` 之后 `dumpsys activity services` 里没有 `LarkTransferService`，通知栏里没有我们的条目。**幂等**：连停两次不抛。
22. **两个服务互不干涉**：一边放歌（媒体服务在）一边下载（dataSync 服务在）→ `dumpsys` 两条都在、两条通知都在，**停下载不影响播放**。

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
| **j** | wake lock | **先不加** | 一个 FGS 不自带 CPU 唤醒，但活跃的网络传输通常够。**这是赌注不是结论**——判据 15 是它的裁判，红了就加 `PARTIAL_WAKE_LOCK` 并把电量代价写进 §7 |

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| 🔴 **传输随 JS 一起冻**（§1.6，未量过） | N4c-1 第一件事就量。红了 → 决策 j 翻面（wake lock），形状要改 |
| 🔴 **vivo 杀后台**（系统在下载进行中杀掉进程，不是驱动脚本点不中） | N3 已记「耐久留给打包后的真实使用」。判据 15 只证明一条长曲一次下完；**杀后台的风险原样留着**，不假装被这批消掉。**真机 session 里若 app 被系统清掉导致驱动失效，明确请用户手动杀后台 + 重启 app**（2026-08-21 用户提供的手段） |
| **6 小时配额测不了** | 判据 18 只到单测。如实记 |
| **`startForeground` 10 秒死线** | 通知内容走 Intent extra，`onStartCommand` 第一件事就 `startForeground`，中间不做任何 IO |
| **两个前台服务打架** | 判据 22 明确验一次。两个 type、两条通知、两个 service 类 |
| **判据 19 要全新安装** | `pm clear` 会连同 SecureStore 一起清 → **D16 会走 fresh 分支**，这是对的（新安装本来就该如此），但要记着它会毁掉当前曲库，**跑在设备 session 的最后** |

---

## §7 本批不会证明的事（先写在这里）

- **dataSync 的 6 小时配额**（判据 18 只有单测）。
- **下载期间的长时间耐久**：判据 15 只证明一条 37 分钟的曲子一次下完；连续几小时、多次熄屏唤醒、vivo 的省电策略，都不在内。
- **通知里的取消按钮**（N4d）。
- **「被系统暂停」的通知提示**——我们没有 `expo-notifications`，停了 FGS 就没法用它的通知说话，所以这个状态**只在应用内可见**（N4 §1.9 原文）。
- **Doze 深度休眠下的表现**：判据 15 的熄屏时长按一次下载算（分钟级），够不到 Doze 的门槛。
