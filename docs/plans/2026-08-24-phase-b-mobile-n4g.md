# Phase B · N4g 拿回文件、管住占用、把歌单带走（`apps/mobile`）

- **日期**：2026-08-24（**v2，决策 a–h 全关**，见 §5；§8 是实施修订）。N4 全期子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md` 里 N4g 那一行的展开，判据 **34–40 原样继承**（**34 是 gate**），另加用户 2026-08-24 追加的**「重新下载」**。
- **执行顺序**：N4h ✅ → **N4g（本批）** → N4i（歌曲页多选 + 行菜单补齐）。
- **前置**：N4h 已完成（head `1692d27`，判据 46 真机绿）。下载链路、前台服务、落盘协议、引擎与 hub 都已在手机上跑通——**本批第一次让「已经在库里的一行」重新长出文件**。
- **基线**：`just check` exit 0 · `just test` exit 0 / **2934 passed**（shared 152 · core 1280 · mobile 180 · cli 428+9 skipped · daemon 468 · gui 426）· `mobile-typecheck` exit 0。
- **冻结设备**：vivo V2408A（Android 15 / API 35），行为判据一律 release 构建。
- **测试规模**：照 N4e §8.5——默认落单测，只有设备能回答的才上机，**整批只上机一次**。

---

## §0 范围

**做**：ensure-file（点一首没有文件的歌 → 拿回来 → 从头播，含**最新意图胜出**与**队列快照**，§2.9 已冻结）· **重新下载**（用户 2026-08-24 追加：与 ensure-file 同一行的另一件事）· 缓存管理（真的 `CacheOptions`、用量与限额、手动清理、fail-closed）· 歌单导出到系统分享面板 · **队列规则 3 改写**（N4g-3，用户在真机会话上提出并同意：「下一首」也是一次播放意图；自然播完跳过没有文件的，不再停在原地）· **文档收尾**（N4 全期的账在 §7 结清）。

**不做（本批）**：歌曲页多选与行菜单（N4i）· 歌单**导入**（N6）· 本地音频导入（D12）· 同步（N5，**TLS 仍硬阻塞**）· 自动清理的后台调度（**只在四个时刻触发**，§2.2）。

**一句话的边界**：N4h 之前手机只会「往库里加东西」；N4g 之后它会**修**（缺文件的歌重新长出来）、会**收**（占用超限就清）、会**送出去**（歌单交给别的应用）。

---

## §1 开工前必须知道的

### 1.1 portable 那半又是全的，缺的还是入口

| 要的东西 | 已经在哪 | 形状 |
|---|---|---|
| ensure-file 任务 | `portable/download/engine.ts:258` `enqueueEnsureFile(songId)` | 自带 dedupe key，**已有文件时零网络短路**（判据 36） |
| 60 秒租约 | `portable/library/eviction-runtime.ts:45` `SongLeaseRegistry` | N4a 提取物，桌面在用 |
| 能不能重下 | 同上 `:85` `canRedownload` | 探活，fail-closed 的判定源 |
| 清理调度 | 同上 `:154` `EvictionScheduler` | 注入 `defer`（桌面是 `setImmediate`） |
| 用量与限额 | `services/library.ts:164` `cacheStatus(options)` | 吃 `CacheOptions`（`limitBytes` / `isExcluded` / `streamCount`） |
| 歌单导出 | `services/library.ts` `exportPlaylist(id)` | 回 `PlaylistExportData`（去 id 的 JSON） |

🔴 **手机上这三样今天都只有验收构建碰得到**：`cacheStatus` 被 `acceptance/library-contract.ts` 用 **`NO_PLAYER_CACHE_OPTIONS`** 这个诚实占位调用（`services/library.ts:49`：`limitBytes: 0` · `isExcluded` 恒 false · `streamCount` 恒 0），`exportPlaylist` 同样只在契约里被调过一次。**这正是 N4h 记下的那条教训的第二个实例**（判据验过 ≠ 用户点得到），本批要把三个入口都接上。

### 1.2 「点一首没有文件的歌」今天说什么

`ui/songs-tab.tsx:199`：`ToastAndroid.show('这首还没有文件，下载在 N4 开放')`。**这句话本批要删掉**——和 N4f 删掉 `LIST_NOT_YET` 是同一个形状，而 N4f 的教训是：门开了要有人接，且**开工就要有那条路的单测**。

### 1.3 §2.9 已经冻结了 ensure-file 的两条产品规则，本批照做不再讨论

- **最新意图胜出**：复用播放器的代际（`player/store.ts` 的 `intent`/`claim()`）。点 A（缺文件）→ 立刻点 B → A 下完之后**只入库、不抢播**。
- **队列快照取在真正起播那一刻**，不是点击那一刻（与 N3 决策 o 同口径）。
- 等待期间 minibar 显示「正在获取」，**可取消**（取消 = 放弃这次播放意图，下载任务照 `cancel` 走）。

### 1.4 缓存的移动口径（§2.7 已冻结）

| 供给者 | 手机答什么 |
|---|---|
| `limitBytes` | `local_metadata.cache_limit_mb`，**默认 0 = 不限**，设置页可改 |
| `isExcluded` | 正在播的歌 + **ensure 租约（60s）** + `engine.pendingFileSongIds()` |
| `streamCount` | **恒 0**，而且这次是真的：手机直接读文件，没有 `/audio` 那种流 |
| `probe` | `canRedownload` |
| `acquireFileClaim` | 引擎的 `claims` |
| 触发 | 启动一次 · 每次下载成功 · 改限额 · **设置页手动清理**（唯一 await 结果的入口，照桌面） |

🔴 **手机上没有 imported 文件**（§1.5 的整个简化压在这上面）：清理只会碰 `file_origin='downloaded'`，而手机上暂时只有这一种。**N5 要复核一次**（同步会把桌面导入的歌带过来，那些是用户资产、永不自动清理）。

### 1.5 导出要一个新依赖，而新依赖有一条常驻规矩

`expo-sharing` 不在依赖里（`expo-file-system` 在）。**`pnpm install` 变动后必须复跑桌面 `just check` + `just test`**（N0b 起的常驻义务），且它是原生模块 ⇒ 本批必然要重建一次 APK 才谈得上手测。

### 1.6 判据 39 的既有不一致，本批只记录不修

GUI 导出无末尾换行、CLI 有 `…\n`；`exported_at` 是 `Date.now()`。所以判据 39 比的是**解析后结构相等**，不是逐字节。

---

## §2 目标结构

### 2.1 文件布局

```
apps/mobile/src/
├── services/
│   └── library.ts          ← 改（N4g-1）：NO_PLAYER_CACHE_OPTIONS 换成真的
│                           #   createCacheOptions(deps)；导出面照旧
├── downloads/
│   └── ensure.ts           ← 新（N4g-1）：一次「播放意图」的状态机
│                           #   （代际 + 租约 + 取消），纯逻辑进 vitest
├── cache/
│   └── runtime.ts          ← 新（N4g-1）：EvictionScheduler 的移动装配
│                           #   （defer / probe / claims / limit 读写）
└── ui/
    ├── songs-tab.tsx       ← 改（N4g-2）：删掉占位 toast，接 ensure-file；
    │                       #   行菜单加「重新下载」
    ├── settings-tab.tsx    ← 改（N4g-2）：占用 + 限额 + 手动清理
    └── playlists-tab.tsx   ← 改（N4g-2）：歌单详情加「导出」→ 系统分享面板
```

### 2.2 清理的四个触发时刻（照桌面，§2.7）

```
启动一次 ──┐
下载成功 ──┼─→ EvictionScheduler.schedule()（defer 之后跑，不 await）
改限额  ──┘
设置页「立即清理」─→ 直接 run()，**唯一 await 结果并把数字显示出来的入口**
```

🔴 **下载成功触发的那一次必须延后到 claim 释放之后**（M5 实测：否则永远清不掉刚下载的歌）。桌面的 defer 是 `setImmediate`，手机是 **`setTimeout(fn, 0)`**（决策 c 已关：要的性质只有「宏任务而非微任务」）。

### 2.3 ensure-file 的一次意图

```
点一首 has_file === false 的歌
      ↓ claim() 拿代际（复用 player/store 的 intent）
  enqueueEnsureFile(songId) + 取一张 60s 租约
      ↓ minibar 显示「正在获取」（可取消）
   下载完成回来
      ↓
  mine === intent ？ ──是──→ 起播，队列 = **此刻**这一屏的快照
      └──否──→ 只入库，什么都不动
```

---

## §3 批次划分

| 批 | 内容 | 需要设备 | 判据 |
|---|---|---|---|
| **N4g-1** | 逻辑与装配：真 `CacheOptions` · `cache/runtime.ts` · `downloads/ensure.ts`（代际/租约/取消）· 限额的读写（`local_metadata.cache_limit_mb`，形状照 `now-playing-mode.ts`）· **单测**（含判据 35 的反测、36 的短路、37 的 fail-closed） | 否 | 35 · 36 · 37 的逻辑半边 |
| **N4g-2** | UI 与依赖：歌曲页接 ensure-file + 重新下载 · 设置页缓存区 · 歌单导出（`expo-sharing`，**装依赖后复跑桌面 check+test**）· **一次真机会话** | 是 | **34**（gate）· 38 · 39 · 40，35–37 的设备半边 |
| **N4g-3** | 真机会话之后追加（决策 i）：`decideNext` 规则 3 改写 + 两个宿主的 advance 接上 ensure。**桌面跟着变**（`ops.play` 多传一个 `ensureFile`） | 是（复验一次） | 51 |

---

## §4 判据（34–40 原样继承 + 本批新增两条，编号 49–50）

34. **【gate · 上机】点一首没有文件的歌就能拿回来**：ensure-file 入队 → 下完 → **从头播**。顺带把 **N3 判据 15 补完**（歌词缺失 / 纯文本无时间戳 / 有时间戳三种各放一次，UI 都不炸）。
35. **【单测 + 上机】latest-wins 与队列快照**：点缺文件的 A → 立刻点 B（有文件）→ A 下完后**在放的仍是 B**，A 只入库；从歌单详情点 A、等待期间切到「歌曲」tab 并改排序 → A 起播后队列是**起播那一刻**的那一屏。**反测（单测）**：不判代际 → A 必须抢走 B。
36. **【单测】ensure-file 的零网络短路**：对已有文件的歌调它 → 不发请求、当场成功。**反测**：去掉短路 → 必须看到一次 playurl（用假 client 计数）。
37. **【单测 + 上机一眼】缓存 fail-closed**：断网后手动清理 → **一个文件都不删**，UI 说「没能确认可重下，先留着」。**反测（单测）**：把 `probe` 恒真 → 必须删。
38. **【上机】限额生效**：设一个小于当前用量的限额 → 手动清理后用量落到限额下，**正在播的那首和 pin 的那首没被删**。
39. **【上机】歌单导出**：导出 → 系统分享面板出现 → 发给自己 → 与桌面同一歌单的导出**解析后结构相等**（忽略 `exported_at`；不是逐字节，见 §1.6）。
40. **【上机】跑完上述之后应用仍可交互**：切一次歌、开一次全屏页、下一首新歌。
49. **【上机】重新下载**（本批新增，用户 2026-08-24 追加）：对一首**已经有文件**的歌点「重新下载」→ 文件被替换、`file_origin` 仍是 `downloaded`、时长重新写对；**期间不许把它从缓存里清掉**（`pendingFileSongIds` 的排除生效）。
52. **【单测 + 上机】表过态就作废**（N4g-3，决策 j）：等待期间**主动暂停**（或按下一首、或起播别的歌）→ minibar 那一行**立刻消失**，文件照常下完**只入库不播**；而**队列自己播到头停下来**的那次**不作废**（等待中的那首落地照样播）。**单测**：`store.test.ts` 三条（pause 拿代际 · toggle 拿代际且仍是普通暂停 · `advance` 的 stop 不拿），`ensure.test.ts` 一条（作废后 `getState()` 变 null 且**不取消下载**）。
51. **【单测 + 上机】没有文件的歌不再是墙**（N4g-3，2026-08-24 真机会话后追加）：**有手指**——「下一首」/「上一首」落到一首没有文件的歌 → 和点它那一行一样去拿回来再播，不再弹「还没有文件」；**没手指**——自然播完时**跳过**没有文件的，找下一首有文件的，一首都没有才停（此前是停在刚播完那首的最后一秒）。**单测**：`play-queue.test.ts` 两半各一条 + `sequential` 不为了找文件而绕回列表头 + shuffle 同样按手指分；`store.test.ts` 断言「下一首」走 fetch 而「自然结束」不走。**反测（单测）**：`ended` 也走 fetch → 「downloads nothing」那条必红（那正是原规则要防的下载雪崩）。
50. **【单测】限额的存取形状**：`cache_limit_mb` 缺行读 0（= 不限）· 非法值读 0 且**读路径不写库** · 写入后重读一致。（与 `now_playing_mode` / `naming_mode` 同一条形状。）

---

## §5 决策（a–h，**已关闭**：a–f 2026-08-24 用户拍板「b 直接获取并播放 · d 不做 · 其余按倾向」；g–h 是开工当天从代码里长出来的两条，理由与代价一并记在这里）

| # | 决策 | **定案** | 理由 / 代价 |
|---|---|---|---|
| **a** | 「重新下载」放在哪 | **行菜单里一项**（`⋮` → 重新下载），与「删除」同一张表 | N4i 会给这张表再加三项，形状一致；桌面也在右键菜单里 |
| **b** | 缺文件的行**点一下** | **直接获取并播放**，不弹确认 | 那是一次播放意图（§2.9 的原话），也是 N4 决策 m 的原话。**代价（用户已知）**：在移动网络上会直接开始下载，而决策 d 说了不提示 |
| **c** | 手机上的 `defer` | **`setTimeout(fn, 0)`** | 桌面用 `setImmediate`；`eviction-runtime.ts` 的头注释本来就写着「the phone passes `setTimeout(…, 0)`」。**不做设备确认**：RN 的 `setImmediate` 是自己的 polyfill，而这里唯一要的性质是「宏任务，不是微任务」——`setTimeout(fn, 0)` 在两个运行时上都答得准，去问设备只会得到一个我们本来就不打算依赖的答案 |
| **d** | 移动网络下的流量提示 | **不做** | 下载本来就由用户点出来；做提示要引入网络类型检测（新原生面）。**代价写明**：一次 ensure-file 可能在 5G 上直接跑几十 MB |
| **e** | 设置页缓存区显示什么 | **用量 / 文件数 / 限额 / 「立即清理」四样**常驻；`eligible_bytes` 与 `skipped_unverified` **只在清理结果那一句里说**（照桌面的 toast 与 CLI 的 `cache evict`） | 常驻两个「可回收 / 不可回收」在手机上是两行谁也不会读的字节数；而「这次清了几首、释放多少、还有几首没能确认」是一次操作的回执，本来就该只出现一次 |
| **f** | 导出的文件名 | **`<歌单名>.lark-playlist.json`**（`sanitizeFileName`，非法字符去掉、限 80 字），写 cache 目录 + `expo-sharing` | 与桌面**逐字一致**——GUI 的默认名就是 `${playlist.name}.lark-playlist.json`（`TopBar.tsx:119`），CLI 的默认输出名同样是它（`transfer.ts:71`）。v1 表里写的 `<歌单名>.json` 是简写，按「与桌面一致」这条理由取全名。**不碰 SAF**（主计划 §4.5） |
| **g** | 手机上 `last_accessed_at` 没人写 | **起播那一刻 touch 一次**（`touchLastAccessed`，播放器 `play()` 里 driver 装好之后） | 桌面写它的地方是 `/audio` 路由（`media.ts` 的 `touch(id)`），而手机直接读文件、没有那条路由——**不补的话 LRU 实际退化成「按创建时间」**，于是「按最近最少使用清理」在手机上是句假话，判据 38 也只能验到「限额生效」而验不到「先清最久没听的」。代价：播放路径上多一次 UPDATE（一行，无索引变动），且 `NotFoundError` 要吞（歌在点击与装载之间被删） |
| **h** | 「库变了」在手机上没人重建 React 视图 | **`LibraryProvider` 订阅 `onLibraryChanged`**，`changed()` 退化成只发信号 | `library-signal.ts` 今天只有播放器在听，所以下载完成 / 清理删文件这类**没有手指按在按钮上**的写入不会刷新歌曲页——`engine.ts:207` 的注释说「the song list rebuilds」，而它其实只在切 tab 重挂时才重建（`view` 是 provider 的 state，`changed()` 才换）。N4g 有两条这样的写入（ensure 完成、清理删文件），所以这条必须先修：**一个信号一个家**，写路径喊 `libraryChanged()`，provider 听见了换 `view` |

### §5 追加 · 决策 i（2026-08-24 真机会话上定）

| # | 决策 | **定案** | 理由 / 代价 |
|---|---|---|---|
| **i** | 「下一首」遇到没有文件的歌 | **按有没有手指分**：`next`/`prev` = 一次播放意图 → 拿回来再播（与点行同一条路）· `ended` = 没手指 → **跳过**，找下一首有文件的，都没有才停 | 用户在真机会话上提的两条现象：① 点行会拿、按「下一首」却拒绝，**同一件事两种答复**；② 自然播完停在上一首最后一秒，**读起来像卡住了**。原规则（「stop, never skip」）是从 Go 抄来的，理由是「跳过会把『这首缺文件』悄悄变成『这首不存在』」——**而现在两个宿主都能把文件拿回来，列表里那一行也一直写着「需要下载」**，所以那个理由不再成立，剩下的只是墙。**代价与边界**：`decideNext` 在 `@lark/shared`，**桌面跟着变**（`advance` 多传 `ensureFile: trigger !== 'ended'`，桌面的 `ops.play` 早就有这条路）· 「不许下载雪崩」这条老约束**换了个位置继续存在**：它现在由「`ended` 只跳不拿」保证，判据 51 的反测守着它 · shuffle 的候选池同样按手指分，否则「随机 + 库被清过」会退回同一种不一致 |

### §5 追加 · 决策 j（2026-08-24，同一次会话，用户「可以对齐桌面」）

| # | 决策 | **定案** | 理由 / 代价 |
|---|---|---|---|
| **j** | 等待中的 ensure 什么时候作废 | **凡是「有人对喇叭表过态」的操作都作废它**：起播别的歌（本来就作废）· **主动暂停 / 继续**（`toggle`、`pause`）· 「下一首」。**队列自己走到头而停下不作废**（没人说话）。作废之后 **minibar 那一行立刻消失**，下载**不取消**、照常入库 | 对齐桌面——桌面的 `pause()` 本来就调 `invalidatePending()`，手机的 `toggle`/`pause` 不领代际，于是「点了缺文件的 A → 再点正在播的那一行」这条路上 A 落地时仍会接管。**最锋利的那个例子根本没有手指**：蓝牙音箱断开会 `pause`（N3e），若不作废，半分钟后文件落地就从**外放**开始放音乐。**代价（用户已知）**：点了缺文件的歌之后如果你暂停当前这首等它，它不会自己开始放，要再点一次那一行。**实现上两处**：`claim()` 放在 lane **里面**（放外面会让「加载中按暂停」变成「重新加载并播放」，`store.test.ts` 有那条老用例守着）· 作废的可见性由 `reconcile` 负责，而 `reconcile` 现在也被播放器的每次状态变化驱动 |

**这条没覆盖到的一个缝，如实记**：锁屏/通知栏的暂停键由 expo-audio 原生处理，**不经过 JS**（`driver.ts` 没有 media-session 回调），所以从锁屏暂停不会作废等待中的 ensure。要堵得给 `lark-audio` 加一个回调面，本批不做。

## §6 风险

| 风险 | 缓解 |
|---|---|
| 🔴 **清理删掉了不该删的** | 判据 38 明确验「正在播 + pin 不被删」；`isExcluded` 三源（正在播 / 租约 / `pendingFileSongIds`）在 N4g-1 就有单测；**fail-closed 是默认**（判据 37） |
| 🔴 **ensure-file 抢播**（N3 的代际模型被绕开） | 判据 35 的反测在单测里（不判代际必须红），不靠设备 |
| **`expo-sharing` 装完桌面回归** | 常驻规矩：`pnpm install` 变动后复跑桌面 `just check` + `just test`，本批 §3 已写进 N4g-2 |
| **手机上没有 imported 文件这个前提** | §1.4 已记；**N5 复核**，本批不假装验过 |
| **判据 39 只能证明「结构相等」** | §1.6 已写明既有不一致，本批只记录不修 |

## §7 本批要结清的账（N4 全期的收尾）

- **N3 判据 15 的两条**：「点没有文件的歌」（判据 34 顺带）· `NO_PLAYER_CACHE_OPTIONS` 占位（本批换成真的）。
- **判据 11 的「不做启动清扫」反测没有运行时开关**——本批要么补一个 acceptance 开关，要么如实记成「有代码、无反测」。
- **判据 18（6 小时配额）与判据 24 之外**，N4 全期还欠：**判据 32 的设备半边**（部分成功那一行没在屏幕上见过）· **判据 31 按标题而非 bvid 比对**。本批不额外制造新的欠账。

## §8 本批不会证明的事

- TLS（**硬阻塞 N5**）· dataSync 的 6 小时配额 · 下载期间的长时间耐久 · 手机上出现 imported 文件之后的清理语义（N5）· GUI/CLI 导出的末尾换行不一致（判据 39 的括号）· 移动网络下的流量提示（决策 d）。

---

## §8 实施修订（2026-08-24，电脑那半落地之后回填）

§2.1 的文件布局在实施中长了三个文件、少了一个占位。逐条记下**为什么**，因为每一条都是「按 v1 写会红」或「按 v1 写会留一个假话」。

### 8.1 多出来的三个文件

| 文件 | 为什么不能塞进 §2.1 列的那几个 |
|---|---|
| `downloads/ensure-runtime.ts` | `ensure.ts` 要进 vitest（判据 35 的反测是变异，设备做不了），所以它**不能 import `react-native` 或 `../player`**（后者在 import 时就注册 `LarkAudio` 监听并加载 expo-audio）。于是拆成「状态机 + 装配」，与 `player/store.ts` + `player/index.ts` 同一个形状、同一个理由 |
| `player/visible-queue.ts` | 判据 35② 要的是「**起播那一刻**在屏幕上的那一屏」。此前每次起播都和点击同一个 turn，队列直接就在手边；ensure 是第一个晚一分钟才起播的，而**切走的 tab 会被卸载**（`shell.tsx` 条件挂载），闭包里那份列表已经不存在。所以列表页发布一个 thunk，落地时读一次 |
| `services/playlist-export.ts` | 写 cache 文件 + 调 `expo-sharing` 不属于歌单页的渲染逻辑，且「文件名与桌面逐字一致」这条规则要有一个能被指着看的家（`exportFileName`） |

### 8.2 `NO_PLAYER_CACHE_OPTIONS` 没有「换成真的」，是**搬走 + 新建**

v1 写的是「`services/library.ts`：`NO_PLAYER_CACHE_OPTIONS` 换成真的 `createCacheOptions(deps)`」。实际做的是两件事：生产面新建 `createCacheOptions(deps)`，而那个诚实占位**搬进了唯一还需要它的地方**（`acceptance/library-contract.ts`，改名 `USAGE_ONLY_OPTIONS`）。理由：契约那一例只问 `used_bytes`，而 `used_bytes` 是一次目录遍历，**任何排除与限额都改不了它**——占位在那里是准确的，留在 `services/` 里则会变成「生产代码里有一份永远答 false 的排除表」。

### 8.3 判据 36 与 37 的逻辑半边不新造，指向 core 现有单测

- **36**（零网络短路）：`portable/download/engine.test.ts:1154`，断言 `upstream.requests` 为空 —— 去掉 `engine.ts:830` 的短路，这条当场红，正是判据要的反测形态。
- **37**（fail-closed）：`portable/library/cache.test.ts:196`，同一条用例的两半就是「探不通的留着」与「探得通的删掉」。
- 本批新造的是**手机这一侧**的那半：`services/library.test.ts` 断言三条排除各自生效、且**每次调用都重新问**（`runEviction` 在 unlink 之前会再问一遍，缓存下来的答案就是那次 re-check 的谎言）。

### 8.4 决策 g / h 是实施当天新增的，不是 v1 漏写

两条都属于「v1 的文字成立，但落到这台设备上是假话」：

- **g**：§1.4 说清理按 LRU，而手机上 `last_accessed_at` **一次也没被写过**（桌面在 `/audio` 路由里写，手机没有那条路由）。不补则 LRU = 创建顺序。
- **h**：§2.2 的四个触发里有两个（下载成功、清理删文件）**没有手指按在按钮上**，而 `libraryChanged()` 此前只有播放器在听——列表要等切 tab 才重建。判据 34「下完之后行不再显示需要下载」会以「看起来没生效」的方式红。

### 8.5 `expo-sharing` 不需要写进 `plugins`

`expo install` 提示「Add expo-sharing to plugins」，但那个 config plugin 管的是 **iOS share extension 与「分享进来」的 intent filter**（`withShareExtension`，两侧都默认 `enabled: false`），我们只用「分享出去」。模块本身照常 autolink，`SharingFileProvider` 与它的 `sharing_provider_paths.xml`（覆盖 cache / files / external）在模块自己的 manifest 里，合并即生效。**所以 app.config.ts 一个字没改**——这与 N4d 加 `expo-share-intent` 时必须写 plugin 是两回事，那次改的是 MainActivity 的 launchMode。
