# Phase B · N4 下载（`apps/mobile`）

- **日期**：2026-08-20（**v2，可开工定稿**）。v1 → **v2（一轮反例评审收敛，修订对照见 §8）**。决策 a–p **待用户关闭**。
- **前置**：N3 全部完成（六批 N3a–N3f，head `98aa64d`，判据 1–19 + 21–25 过）。手机上已经是一个完整播放器；曲库、四 tab、D16 身份门、file-op 执行器、`FileEffectRuntime`、播放器与队列都在位。
- **基线**：2026-08-20 实测 `just check` **exit 0**（含 `spike-media-test` 全段）、`just test` **exit 0 / 2729 passed**（shared 129 · core 1221 · mobile 59 · cli 428+9 skipped · daemon 465 · gui 427）。开工前的红灯不是本批带进来的。
- **主计划**：`docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4.3 的 N4 行（含 **Stage-3 修订**：TLS 移出）+ §4.5 的两处修订段；框架 `docs/plans/2026-08-17-phase-b-mobile-n0.md` §5「N4 下载」。
- **冻结设备**：vivo V2408A（Android 15 / API 35），数值与行为判据一律 **release 构建**。
- **本批四条范围由用户 2026-08-20 拍板**：① **TLS（D15）不做**（§0）；② **LLM 设置页进 N4**；③ **收藏夹/合集批量进 N4**；④ **加 dataSync 前台服务**。

---

## §0 范围

**做**：移动端 `AudioLandingPort` 实现与落盘协议 · 引擎在手机上的装配（含进程级 download hub 与 claims 重接）· 启动清扫 · **添加页**（粘贴 / 分享 intent → 解析 → 命名 → 目标 → 提交，任务列表与取消）· **收藏夹 / 合集展开 + 多选提交** · **LLM 设置页与四条能力** · **dataSync 前台服务** · ensure-file · 缓存管理 · **歌单导出 → 系统分享面板** · 桌面侧三处提取（preflight、EvictionScheduler + SongLeaseRegistry + canRedownload、AudioLanding 契约）。

**不做（本批）**：同步（N5） · **TLS / 明文 server 的任何工作**（用户 2026-08-20 决定） · 本地**音频**文件导入（D12） · 歌单**导入**（N6） · 歌曲行的多选批量操作（N6；本批的「多选」只在收藏夹/合集的条目勾选里） · 逐词歌词 / Android Auto / widget · 桌面的任何**行为**变化（三处提取一律零行为变化，判据 1 与 4 守着）。

**范围修订：TLS（D15）移出 N4**（用户 2026-08-20 决定）。主计划原文把「TLS 完成死线」写在 N4 行，本批**一个字不提 TLS**，主计划 §4.3 同步加 Stage-3 修订段。准确的口径是：

> **不阻塞 N4 的任何子批**（下载链路完全不碰 skybridge）；**硬阻塞 N5**——server 今天仍是 `http://<公网IP>:8443`，而移动端 v1 是 https-only（D15），所以 N5 开工前必须二选一：补完 TLS（域名 + 证书 + 自动续期 + 反代 + 两端 `server_url` 迁移 + 真机连通），或者单独决定「移动端要不要一个明文开关」。这条进 `PROCESS.md` 的待办，**不算被本批消掉**。

**一句话的边界**：N3 之后，手机上的 lark 是一个能播完桌面搬过来的歌的播放器；N4 之后，它自己能往曲库里加歌——**而且这是移动端第一次真的发出网络请求**（§1.3 是这句话的第一个代价）。

---

## §1 开工前必须知道的

### 1.1 引擎已经是可移植的，N4 缺的是三块宿主件

`DownloadEngine`（`portable/download/engine.ts`，1049 行）在 N1h 之后**完全可移植**：队列、状态机、claims、去重、批次、进度节流（`:99-101`）、`#discardUncommittedSongDir` 的「无行才可删」判定（`:755-768`）全在 portable，唯一的宿主缝是 `options.audio: AudioLandingPort`（`:146`）。`fetchImpl` 也不必注入——`globalThis.fetch` 就是 `expo/fetch`（N0b-3 冻结，N1i 复验）。

移动端要补的只有三块：**音频怎么落到这台机器上**（`ports/audio-landing.ts` 的移动实现）· **入队前的网络预检**（今天只在 daemon 路由里，§1.2）· **事件到 UI**（引擎只给 `callbacks`，谁听是宿主的事）。

**第三块有一个实现约束**：`EngineCallbacks` 只能在**构造引擎时**给（`engine.ts:122-128`），没有 add/remove 订阅面。所以「谁听」不能一批一批往上加——**进程级 download hub 必须和引擎同批出生**（N4b），前台服务（N4c）与 UI（N4d）都只是它的订阅者。

### 1.2 预检今天只活在 daemon 路由里，而它和 portable 的等价物**行为不同**

`routes/download.ts` 的头注释把分工写得很清楚——「网络工作在这里，调度在那里」——但那些**判断**今天只有 daemon 有：

| 判断 | file:line |
|---|---|
| `resolveOne`：解析 + 至多一次短链展开 | `routes/download.ts:88-97` |
| `preflightSingle`：keyword 要 LLM · video 必须带 naming · 多 P 且无 `?p=` 且无 LLM → 当场拒 | `routes/download.ts:103-160` |
| 批量的 LLM 门 | `routes/download.ts:198-222` |
| `fetch-list` 的分页、上限、**部分成功语义**（`truncated` 要变成 `error` 文案） | `routes/download.ts:236-300` |

移动端把这四条再写一遍就是 §7 F13 那种漂移，而这次没有第二个实现能对照。**所以 N4a 提取进 `portable/download/preflight.ts`**。

🔴 **但提取不是搬运——两边今天对同一件事的回答不一样**（v2 新增，评审 P1-4 属实）：

| 情形 | daemon 今天 | portable 的 `resolveInput` 今天 |
|---|---|---|
| 短链展开后**仍是短链** | `InvalidRequestError('INVALID_SOURCE')` → **400** | `NormalizeFailedError` → **502 NORMALIZE_FAILED** |

而 `routes/download.test.ts` 里**短链用例一条都没有**（实测 grep 零命中），所以「路由测试原样绿」这个 gate 在这一条上是空的。两个连带事实让修法变便宜：**`resolveInput` 在生产代码里零调用方**（只有 `link.test.ts` 引用它），且 daemon 的 400 是已发布协议的一部分。

**因此 N4a 的顺序是固定的**：先补 characterization test 钉住现在的 400 → 再让 portable 的函数迁就它（改抛 `InvalidSourceError`，同步改它自己的单测）→ 提取 → 判据 1 用一张**逐条错误码对照表**验收，而不是只看测试绿。

CLI 不在这条线上（`apps/cli/src/backend/direct.ts:317-332` 全部 `daemonOnly`），**所以这次是两方共享（daemon + mobile）**。

### 1.3 🔴 明文流：R1 的成功可能是构建配置给的

N0b-4a 与 N1i 的 R1 都在移动网络上成功拉到了音频流，节点是 `xy…xy.mcdn.bilivideo.cn:8082`（bilibili 的 P2P CDN）。**但那两轮都跑在 spike 的构建上，而 spike 显式开了明文**：

```
spikes/mobile-foundation/app.config.ts:87   usesCleartextTraffic: true   // SPIKE-ONLY（决策 f）
```

`apps/mobile/app.config.ts` 没有这一行，Android 9+ 默认禁止明文。如果 playurl 在移动网络上派的是 `http://`，产品 release 会在 4G 下每首歌都失败而 **Wi-Fi 全绿**——最难查的一类症状。

**开工第一件事**（判据 5，排在写任何 UI 之前）：在产品构建上打一次 playurl，把选中流的 scheme 与 host 原样记下来。三条出路：

1. **是 https** → 什么都不做，记进 LESSONS 关掉。
2. **是 http 且 DASH 条目带 `backupUrl`** → 选流规则加一条「同 codec 内优先可用的 https 候选」。client 今天只读 `baseUrl` / `base_url`（`bilibili.ts:252`），`backupUrl` 一个字没看。**这比放开明文安全得多，且是 core 的一行规则，两端都受益。**
3. **是 http 且没有 https 候选** → `networkSecurityConfig` 按**域名白名单**放行，写成 CNG plugin 并进 merged manifest 判据（照 D16 先例）。**绝不整体 `usesCleartextTraffic: true`。**

两条 N0b-4a 的实测在 N4 仍成立且**不许写死**：**流 URL 只在签发它的那张网上有效**；**最低 header 要求按节点而非按平台**（cc 节点缺 `Referer` 就 403，mcdn 节点零 header 也给 206，content-type 是 `application/octet-stream`）。任何「按 content-type 判断是不是音频」的新代码都会在移动网络上错。

### 1.4 手机上没有 ffprobe，而 `duration` 必须是**落地的**那个值

端口把这件事说死了：`LandedAudio.duration` 是落地文件的实测长度，`commit` 写行用的就是它，**不许从接口上消失**（`ports/audio-landing.ts:44-52`）。桌面用 ffprobe **探输出文件**，理由是「一个悄悄没带上音频的拷贝，否则会被当成一首歌提交」。手机上四条路：

| 路 | 怎么拿 | 状态 |
|---|---|---|
| **A. `MediaMetadataRetriever` 原生探测** | 平台自带，只吃文件路径，**不碰音频焦点、不建会话**，坏文件抛/返回 null | **主选**。但它与 ExoPlayer 是**两套 extractor**，「ExoPlayer 与 ffprobe 逐毫秒相同」不能顺推——N4b 用 N0b 那两条有 ffprobe 真值的夹具先验它（判据 8） |
| **B. 瞬时 `createAudioPlayer` 读 `duration`** | N0b-4b 实测与 ffprobe 逐毫秒相同（136.835 / 2226.645） | **A 不达标才用**，且要带「不打断正在播的那首」的判据（判据 9）；释放先 `pause()`（#47569） |
| **C. `expect.expectedDurationSeconds`（上游 `page.duration`）** | 零成本：`NormalizedSource` 已带 `pages`（`link.ts:128-137`），新歌与重下**两条路都有** | **只做诊断交叉校验，永远不写进行里**（v2 修正，评审 P1-3 属实：C 证明不了文件可解码，用它兜底正好破坏端口的落地事实不变量） |
| D. 自己解 fMP4 box | 纯 JS | **不做**：分片 MP4 的 `mvhd.duration` 常常是 0，真值在 `mehd`/`sidx`/逐 fragment，押在一个我们没量过的格式假设上 |

**A/C 的容差与不一致时的处置**（本批冻结）：`|A − C| > 3s` → **warning，记日志与任务 warning，不失败**（上游整数秒 + 分 P 时长本来就可能略有出入）；**A 失败 = landing 失败**，不提交、不留文件（判据 7）。A 与 B 都不可用不是「退回 C」，是**本批 blocker**，要回来重新做决策 b。

顺带修一条注释里的事实错误：`engine.ts:904` 写着「重下没有 page 可引用，所以 `expectedDurationSeconds` 永远是 null」——**不成立**，`probeSourceKey` 回来的就是完整 `NormalizedSource`。N4a 两条路径都接上，注释一并改。

### 1.5 桌面的六步落盘协议，每一步都在防一个具体的崩溃——而手机的前提变了

`download/resolve.ts:149-207` / `:295-420` 的六步 + `.pending` manifest + `had_old` 要在「随时被 kill -9」的前提下区分**「song.m4a 是完好的旧文件」**与**「song.m4a 是没提交的新文件」**——外观相同、处理相反。

手机上两个前提变了：

1. **原子替换现在有了**：`LarkFs.moveAtomic` = `Files.move(REPLACE_EXISTING, ATOMIC_MOVE)`，同目录内没有中间态。
2. **这台机器上的音频文件全部可重下**：不做本地音频导入（D12），文件只可能来自一次下载，也就一定有一个当时解析成功的 `source_key`。桌面不能这么想，是因为它有 `imported`（Go 迁移来的 20 首）——那是只此一份的用户资产，R1/R26 就是为它写的。

于是手机换成一个**自愈**的形状（§2.3，决策 c）：暂存 → 读时长 → **数据库事务提交** → 原子替换。**代价如实记**：`replace` 崩在提交与替换之间会留下「新 duration + 旧文件」，要等下一次重下才纠正——写进 §2.3 的崩溃状态表，不藏。

### 1.6 🔴 启动清扫：两处都不能照直觉写

**① 要插进冻结的启动序列**。桌面顺序是 `boot.ts:391-406`：drain → 清空 quarantine → `recoverSongsStore` → **之后**才建引擎（「引擎还不存在，所以没有任务能和它赛跑」）。移动端启动序列在 N2 §2.2 冻结，今天是 ⑪ boot drain → ⑫ 交还库。清扫插在 **⑪ 与 ⑫ 之间（新 ⑪b）**，与已冻结的三条排序约束都不冲突。**这是对冻结段落的显式修订**，要写回 N2 子计划 §2.2 并在 `PROCESS.md` 记一笔。

**② 清扫必须跳过 journal 还认领着的目录**（v2 新增，评审 P1-2 属实）。桌面传的是 `skipSongIds: pendingFileOpSongIds(sqlite)`（`boot.ts:399-401`），理由写在 `RecoveryOptions` 上：drain 之后剩下的是**失败或退避中**的 op，它的行是数据库已经提交的决定，而它的目录正好长得像「有音频没有行」。漏掉它的后果是一次待重试的远端删除被清扫先搬走，随后 journal 重试失败甚至进 dead letter。`pendingFileOpSongIds` 就在 portable（`portable/sync/file-ops.ts:360`），移动端 import 得到。

**③ 孤儿去哪：不是 `recovered-songs/`**（v2 修正，v1 写错了）。两个目录是两回事：

| 目录 | 谁往里放 | 谁在读 |
|---|---|---|
| `trash/recovery-<ts>-<rand>/<id>/` | **崩溃孤儿**（有音频没有行），桌面 `resolve.ts:456` | 没人；等人工看 |
| `recovered-songs/<target>/` | **远端删除时抢救的不可重建资产**（`paths.ts:106-115`） | **`/sync/status` 的 `quarantined_count` 会数它** |

把孤儿丢进 `recovered-songs/` 会在 N5 上线那天把同步隔离统计污染成一堆跟同步无关的东西。移动端因此要新增一个 trash 命名空间（`ports/paths.ts` 今天只有 `recoveredSongsRoot()`）。

### 1.7 D17 的移动端一半从来没实现过

D17 原文：「无 AAC：桌面转码、**移动端拒绝并报错**」。桌面那一半在 `audio-landing.ts`；移动端这一半今天不存在。材料端口已备好（`expect.isAac` / `expect.codecs`，`codecs` 缺失按非 AAC 算，`bilibili.ts:70-77`）——N4b 要写的是那句拒绝、和它对用户说的话，**且必须在下载任何字节之前**（判据 7）。选流规则本身（AAC 优先、同 codec 内取带宽最高，`bilibili.ts:270-277`）两端共用，不改。

### 1.8 分享 intent 的四条已知事实

前三条是 N0b-4c 的 release 实测：

1. **分享文本里没有 bvid，只有 b23.tv 短链**（`EXTRA_TITLE` 为空）→ 添加页**在展开短链之前识别不出任何东西**，UI 必须有「正在解析」这一态。
2. **收藏夹分享不到系统面板**（直接进 bilibili 自己的发动态发布器）→ **收藏夹/合集只能靠粘贴框进入**。
3. **payload 是易失的**（`resetOnBackground` 默认开，切后台即清）→ **必须在挂载时消费掉**。

第四条是 v2 新增（评审属实）：**「挂载时消费」不能挂在添加页上**。`ui/shell.tsx:52` 是 `{tab === '添加' && <AddTab />}`，而默认 tab 是「歌曲」——一次冷启动分享会因为添加页根本没挂载而**永远收不到**。消费点必须在 **App / Shell 根层**：收到 → 存成草稿 → 把 tab 切到「添加」（决策 p）。

### 1.9 dataSync 前台服务：生命周期比「有任务就起」复杂

用户已决定加它。五条写进设计而不是撞上（其中四条 v2 新增）：

- **权限与类型**：`FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_DATA_SYNC`，service 声明 `android:foregroundServiceType="dataSync"`。判据照 N2 判据 10⑤ / N3 判据 3b，**断言 merged manifest**。顺带断言 **`INTERNET` 在**——这是产品构建第一次真的联网。
- 🔴 **起服务的时机是用户手势，不是任务入队**：入队之前还有一段网络预检（短链展开 + pagelist，秒级）。用户在这段时间切后台，入队时再起 FGS 就撞上 Android 12+ 的后台启动限制。所以**在用户点「下载」的那一刻起**（此刻必定前台，合法），预检后什么也没入队就撤。
- 🔴 **`onTimeout` 要停的是全部，不是 running**：只取消 running，queued 会立刻顶上，等于没停。Android 15 的 dataSync 有 24 小时累计 6 小时上限，到点系统调 `Service.onTimeout(...)`，应用必须当场停。**这条实测不了**（要攒够 6 小时），如实记「有代码路径、有单测、没有真机证据」。
- 🔴 **停了 FGS 就没法用它的通知说话**，而我们**没有 `expo-notifications` 依赖**。所以「被系统暂停」这个状态**只在应用内可见**（添加页 + 任务列表），不承诺通知。
- 🔴 **通知权限今天只在第一次播放时申请**（`player/session.ts:14-19`，而且那是有意的设计：冷启动弹框没有上下文）。先下载后播放的用户，下载通知**不可见**（服务照跑，只是看不见）。所以**第一次下载也申请一次**，理由与首播同构（用户刚点了下载，此刻有上下文）。
- **起不来怎么办**：catch `ForegroundServiceStartNotAllowedException` → **照常下载，但记成一个降级态并在任务列表上可见**。让一次下载因为通知服务起不来而失败更糟；静默当成功也不行。

### 1.10 手机上没有配置文件，也没有 aviary 回退

桌面 LLM 配置来自 `lark_config.toml`，空字段回退 `aviary_config.toml`（`config/index.ts:166-183`）。手机上两者都不存在，而引擎要的只是 `getLlmConfig: () => LlmConfig`（`url` / `model` / `api_key` / `api_format`）。落点见 §2.8。两个连带语义定死：**没有 aviary 回退**；**D16 的 converge 不碰 LLM 配置**（converge 清的是 sync binding 与 skybridge 凭证；LLM key 是设备本地的东西，且 SecureStore 本来就不进备份，卸载重装即失）。

### 1.11 缓存：纯逻辑在 portable，三个供给者与两条调度语义都在 daemon

`portable/library/cache.ts` 已是注入式纯逻辑（`CacheOptions:42` / `EvictionOptions:58`），两条不变量原样成立：**fail-closed** 与**删除临界区里没有 await**。手机上缺的是它的供给者，今天全在 daemon：

- `isExcluded`（`daemon/src/cache.ts:80`）= 正在播的歌 + ensure 租约 + `downloads.pendingFileSongIds()`；
- **`SongLeaseRegistry`（`daemon/src/cache.ts:31-68`）**——v1 漏了：计划直接说「照它，60s」，但它在 daemon 里，移动端守卫**禁止 import**。要跟 scheduler 一起提进 portable。
- `canRedownload`（`:114`）= 拿 `probeSourceKey` 问 bilibili，六行；
- `EvictionScheduler`（`:169-298`）= **延后一个宏任务**（否则刚下完的歌还握着 file claim，会被跳过且永不回头）+ **脏标重跑**。

那两条调度语义写两遍必漂，漂移形态是「同一次下载之后，一边清了一边没清」——**提取进 portable，注入 `defer`**（桌面继续传 `setImmediate`，时序逐字不变；手机传 `setTimeout(…, 0)`）（决策 g）。

### 1.12 UI 侧手上已经有什么

- **没有 zustand、没有 router、没有手势栈**（N2 决策）。添加页是 `shell.tsx` 里的第三个 tab，今天是一块占位文案（`shell.tsx:99`）。
- 播放状态用**自建 external store**（`useSyncExternalStore` + 选择器，N3 决策 b）。下载状态照抄这个形状（决策 n），且**它就是 §1.1 说的那个进程级 hub**。
- **库变更信号**已经有了（`library-signal.ts`）：下载成功后调 `libraryChanged()`，歌曲列表、队列、播放器跟着收敛。
- **播放器已经有「最新意图胜出」的代际**（`player/store.ts:154-163` 的 `intent` / `claim()`）。**ensure-file 必须复用同一形状**（§2.9）：点了缺文件的 A、又点 B，A 下完不许抢走 B。
- 「这首还没有文件」今天写死「下载在 N4 开放」（`songs-tab.tsx:199`）——N4g 换成真的 ensure-file，**并把 N3 判据 15 里那条「夹具库里没有 `has_file === false` 的歌，如实记着没验」补上**。

---

## §2 目标结构

### 2.1 文件布局

```
packages/core/src/portable/download/
├── preflight.ts          ← 新（N4a）：resolveOne / preflightSingle / preflightBatch / fetchList
└── engine.ts             ← 改：expectedDurationSeconds 接上（§1.4）
packages/core/src/portable/library/
└── eviction-runtime.ts   ← 新（N4a，决策 g）：EvictionScheduler + SongLeaseRegistry + canRedownload
packages/core/src/portable/ports/
└── audio-landing.ts      ← 加法扩展 + 冻结（§2.2）
packages/core/src/portable/services/contract/audio-landing/
                          ← 新（N4a）：八条契约用例 + 两个 hook（桌面 vitest / 手机 acceptance）

apps/mobile/src/
├── ports/audio-landing.ts   ← 新（N4b）：落盘协议 §2.3 + transfer 缝
├── downloads/
│   ├── engine.ts            ← 新（N4b）：装配引擎；长命 FileEffectRuntime 换 claims
│   ├── hub.ts               ← 新（N4b，v2 提前）：进程级 external store，引擎构造时接上
│   ├── preflight.ts         ← 新（N4d）：portable preflight 的移动薄壳（LLM 快照 + 错误文案）
│   └── foreground.ts        ← 新（N4c）：前台服务状态机
├── settings/llm.ts          ← 新（N4e）
├── boot/sequence.ts         ← 改（N4b）：新增 ⑪b 启动清扫（skip set + trash）
├── ports/paths.ts           ← 改（N4b）：新增 trash 命名空间
├── ui/add-tab.tsx           ← 新（N4d）
├── ui/list-picker.tsx       ← 新（N4f）
└── modules/lark-media/      ← 新（N4b）：MediaMetadataRetriever 时长探测
    modules/lark-transfer/   ← 新（N4c）：dataSync 前台服务
```

### 2.2 `AudioLandingPort` 的最终签名（**本批冻结**，N1 §8 留的那个口子）

N1h 冻结了切面位置与桌面不变量，跨宿主字段签名留到 N4 **加法扩展**。本批加两处、冻结全部：

```ts
interface AudioStreamExpectation {
  codecs: string;
  isAac: boolean;
  /** 现在真的会被填上（§1.4）：选中分 P 的 duration，新歌与重下两条路都有。诊断用，永不写行。 */
  expectedDurationSeconds: number | null;
}
interface AudioLandingInput {
  …既有字段…
  /**
   * 加法①：已鉴权请求的**材料**，给能原生下载的宿主用（决策 a）。
   * `timeoutMs` 是**整条传输的 deadline**，由 client 给（`timeouts.audioStream`），
   * 不是宿主自己发明的数——宿主只负责把它和 `input.signal` 组合起来。
   */
  request: { url: string; headers: Readonly<Record<string, string>>; timeoutMs: number };
  /** 既有：在 JS 里读流的宿主用这条（桌面）。两条描述同一个请求，宿主二选一。 */
  openStream(signal: AbortSignal): Promise<Response>;
}
```

**错误归一是契约的一部分**（v2 新增，评审 P1-1 属实）。`openAudio` 今天同时做三件事：组合任务取消与 5 分钟整流超时、统一 `!response.ok → BilibiliApiError`、把网络异常原样抛（`bilibili.ts:335-341`）。只给 `{url, headers}` 会把后两件悄悄换成 Expo 自己的异常类型。所以端口明写：

| 情形 | 每个宿主都必须产生 |
|---|---|
| HTTP 非 2xx | `BilibiliApiError`（文案含 status） |
| 整条传输超时 | 与桌面同一类的中止（`AbortError` 语义），任务落 `failed` |
| 用户取消 / 关闭 | 中止原样传播，任务落 `cancelled`（不是 failed） |

契约用例（§2.4 的第 6–8 条）对两个宿主各跑一遍。**`BilibiliClient` 加 `describeAudioRequest(url, opts): Promise<{url, headers, timeoutMs}>`，与 `openAudio` 共用同一份 `headers()`（`bilibili.ts:151`）**——不是第二份 header 逻辑。

**移动端的 `audioStream` 取 15 分钟**（桌面 5 分钟不动）：桌面没人在 200KB/s 上下 50MB，而手机会。写明**这是「整条传输」而不是「停滞」计时，按停滞计时才是对的形状，但那要动桌面语义，不在 N4**。

### 2.3 移动端落盘协议与启动清扫（**冻结**，决策 c）

```
① songs/<id>/ 建目录（新歌）
② 判 isAac —— 非 AAC 在下载任何字节之前拒绝（§1.7）
③ 下载 → songs/<id>/.download.<taskId>.tmp   （原生，进度 / 取消 / timeoutMs）
④ 读时长：MediaMetadataRetriever（§1.4）——读不出 = landing 失败，不提交
⑤ sqlite.transaction(() => { commit({duration}); touchLastAccessed(...) }).immediate()
   —— 点无回头。touchLastAccessed 不能漏：漏了 LRU 会把刚下完的歌排到清理队首
⑥ LarkFs.moveAtomic(tmp → song.m4a)
   —— 失败：删 tmp，返回 warning（land 的返回值就是给这种事用的）
```

崩溃状态表（进程在任意点被 kill）：

| 崩在哪 | 磁盘上是什么 | 下次启动怎么收 | 用户看到 |
|---|---|---|---|
| ③④ 中 | tmp 残留，新歌无行 | 清扫删 tmp；**无行且无音频的目录**一并删 | 什么也没发生 |
| ⑤ 之后 ⑥ 之前（new） | 行在、无 canonical | 不用收——`has_file` 是探盘算的 | 「需要下载」，点一下就回来（**自愈**） |
| ⑤ 之后 ⑥ 之前（replace） | 行是新的、文件是旧的 | 不用收 | 旧文件照常播；duration 可能差几秒，**下次重下才纠正**（本协议的代价） |
| ⑥ 之后 | 完成态 | — | 完成 |

**启动清扫（⑪b）** 三条规则，一条都不能少：

1. **先取 skip set**：`pendingFileOpSongIds(sqlite)`（§1.6②）。集合里的 song id **一律不碰**。
2. 删 `songs/*/.download.*.tmp` 与 N2 已有的 `.<name>.<uuid>.tmp` 写残留（`ports/fs.ts` 的 `sweepWriteResidue`）。
3. **有音频但没有行**的目录 → 移进 **`<nest>/trash/recovery-<ts>-<rand>/<id>/`**（§1.6③；**不是 `recovered-songs/`**）。不删——「删掉一个我们解释不了的东西」是这个项目一贯不做的。

### 2.4 preflight 提取面（**冻结**，决策 d）

```ts
// portable/download/preflight.ts —— 纯业务判断，零 wire 概念
resolveOne(client, input, opts): Promise<ParsedItem>            // 展开后仍是短链 → InvalidSourceError（400 口径）
preflightSingle(deps, item, naming): Promise<DownloadTarget>    // 三条 LLM 门 + 列表拒绝
preflightBatch(deps, groups): void                              // 组里有 keyword / clean 就要 LLM
fetchList(client, request, opts): Promise<FetchListData>        // 分页 + 上限 + 部分成功 + truncated 文案
```

**顺序固定**（§1.2）：① 先补 characterization test（短链展开后仍是短链 → **400 INVALID_SOURCE**，这是今天的行为，也是提取后要保住的行为）；② 改 `resolveInput` 迁就它（零生产调用方，改它是免费的）；③ 提取；④ 判据 1 拿**错误码对照表**逐条验收：

| 情形 | 提取前后都必须是 |
|---|---|
| 展开后仍是短链 | 400 `INVALID_SOURCE` |
| 非 B 站链接 / 不认识的 B 站路径 | 400 `INVALID_SOURCE` |
| keyword 且无 LLM | 400 `LLM_NOT_CONFIGURED` |
| clean 且无 LLM | 400 `LLM_NOT_CONFIGURED` |
| 多 P 且无 `?p=` 且无 LLM | 400 `LLM_NOT_CONFIGURED` |
| 收藏夹 / 合集直接提交 | 400 `INVALID_SOURCE` |
| 预检超时 | 504 `PREFLIGHT_TIMEOUT` |
| `naming_mode` 缺失 / keyword 带 naming | 400 `INVALID_BODY`（**留在路由**，它说的是请求体形状） |

### 2.5 添加页的状态机（N4d + N4f）

```
        ┌─ 粘贴框 ─┐        ┌─ 分享 intent（**根层**消费，§1.8-4）
        └────┬─────┘        └────┬────
             ↓                    ↓
        [正在解析]  ← 短链一定要走这一步
             ↓
   ┌─────────┼──────────────┬─────────────┐
   ↓         ↓              ↓             ↓
 video    keyword       favorites/collection    无法识别
   ↓         ↓              ↓             ↓
命名模式   需要 LLM      [正在取列表]      说清楚为什么
（记忆）      ↓         勾选 + 目标
   ↓         ↓              ↓
      目标歌单（默认「仅曲库」）
             ↓
        提交 → 任务列表（进度 / 取消 / 全部取消 / 降级态）
```

两条提交语义照桌面，不合并（`BatchSelectModal.tsx` 头注释）：**一个列表组 = 一次 `enqueueBatches`**；**零散单条 = 一条一条提交、best-effort、遇到第一个拒绝就停**。注意 `enqueueBatches` 的原子性说的是**准入**（validate → capacity → 建歌单 → 注册，`engine.ts:304-312`），**不是**「所有下载都会成功」。

### 2.6 前台服务状态机（**冻结**，决策 e）

```
idle ──用户点下载（此刻必定前台，合法）──▶ arming ──入队成功──▶ running
  ▲                                          │                    │
  │                                   预检后零入队                 │ 活动任务归零
  └──────────────────────────────────────────┴────2 秒后停─────────┘
                                     running ──onTimeout──▶ paused-by-system
```

- **arming**：起服务发生在**手势**那一刻，不是入队那一刻（§1.9）。起不来 → 记降级态、照常下载、任务列表上可见。
- **停**：活动任务归零后**延后 2 秒**再停（两条任务之间的空隙不该让通知闪一下），期间又有任务就取消停。
- **通知**：一行，「正在下载 N 首」+ 当前这首的名字；点击回到应用。不做每首一条。**第一次下载时申请通知权限**（§1.9）。
- **`onTimeout`**：**原子停全部**——先把 queued 与 running 一起取消（照 `cancelAll` 的逐条口径），再停服务，状态置 `paused-by-system`。**这个状态只在应用内可见**（没有 expo-notifications）。
- 与播放的媒体服务互不干涉：两个服务、两条通知、两个 type。

### 2.7 缓存的移动口径（N4g）

| 供给者 | 移动端答什么 |
|---|---|
| `limitBytes` | `local_metadata.cache_limit_mb`，**默认 0 = 不限**，设置页可改 |
| `isExcluded` | 正在播的歌 + **ensure 租约**（提取来的 `SongLeaseRegistry`，60s） + `engine.pendingFileSongIds()` |
| `streamCount` | **恒 0**，而且这次是真的：手机上播放器直接读文件，没有 `/audio` 那种流 |
| `probe` | `canRedownload` 的移动实例（提取物） |
| `acquireFileClaim` | 引擎的 `claims` |
| 触发 | 启动一次 · 每次下载成功 · 改限额 · 设置页手动清理（唯一 await 结果的入口，照桌面） |

### 2.8 LLM 配置（**冻结**，决策 f）

| 字段 | 存哪 | 缺省 |
|---|---|---|
| `url` / `model` / `api_format` | `local_metadata`（`llm_url` / `llm_model` / `llm_api_format`），形状照 `now-playing-mode.ts`：缺行即默认、读路径不写库、看不懂的值不覆盖 | 空 / 空 / `openai` |
| `api_key` | SecureStore 键 `lark.llm.api_key`（`requireAuthentication: false`）——**不进 `CredentialStore` 端口**，那个端口是 skybridge 凭证的形状 | 空 |

`getLlmConfig()` 每次现读（引擎按任务快照一次，`engine.ts:#llmSnapshot`），`isLlmConfigured` 沿用 core（`url` + `model` 非空即可）。设置页只显示「已配置」，**不回显 key**（照 `redactConfig`）。

### 2.9 ensure-file 的所有权与队列快照（**冻结**，决策 o）

点一首没有文件的歌 = 一次**播放意图**，不只是一次下载：

- **最新意图胜出**：复用播放器已有的代际（`player/store.ts:154-163` 的 `intent`/`claim()`）。点 A（缺文件）→ 再点 B：A 下完之后**不许**抢走 B。判定发生在下载完成回来那一刻：`mine !== intent` 就只入库、不起播。
- **队列快照取在真正起播那一刻**，不是点击那一刻——与 N3 决策 o（队列 = 起播那一刻的快照）同一口径。一次要等 30 秒的下载期间，用户很可能已经换了一屏。
- 期间 minibar 显示「正在获取」，可取消（取消 = 放弃这次播放意图，下载任务照 `cancel` 走）。

---

## §3 批次划分

每批：`just check` + `just test` 全绿是底线；桌面零回归；**Metro bundle smoke 每批都跑**；`pnpm install` 变动后复跑桌面 `just check` + `just test`；提交前给用户看 commit message。真机按常驻规矩——**我装包 + 讲清楚看什么，用户手测**；要抓内容（logcat / dumpsys / 截屏）或判据要求精确流程时我自己驱动，且开跑前说一声、跑完说一声。

| 批 | 内容 | 需要手机 | 本批 gate |
|---|---|---|---|
| **N4a** | **纯桌面批**：短链 characterization + preflight 提取（§2.4）· AudioLanding 签名冻结（含 `timeoutMs` 与错误归一，§2.2）+ `expectedDurationSeconds` 接线 · **AudioLandingContract 八条** + 桌面 hook · EvictionScheduler + SongLeaseRegistry + canRedownload 提取（决策 g） | **否** | 判据 1–4（**1 · 3 是 gate**） |
| **N4b** | `modules/lark-media`（MMR 时长）· 移动 AudioLanding + 落盘协议（§2.3）· 启动清扫 ⑪b（skip set + trash）· 引擎装配 + **进程级 hub** + claims 重接 · **明文 scheme 判定** · 契约真机跑 | 是 | 判据 5–14（**5 · 6 · 10 · 11 是 gate**） |
| **N4c** | `modules/lark-transfer`（dataSync）+ 状态机（§2.6）+ 通知权限 + manifest 审计 | 是 | 判据 15–19（**15 · 16 是 gate**） |
| **N4d** | 添加页 v1（粘贴 → 解析 → 命名 → 目标 → 提交）+ 任务列表与取消 + **根层分享 intent** | 是 | 判据 20–25（**22 是 gate**） |
| **N4e** | LLM 设置页 + 四条能力（关键词 / clean / 多 P 选集 / **重新识别**） | 是 | 判据 26–30 |
| **N4f** | 收藏夹 / 合集展开 + 勾选 + 批次提交与进度 | 是 | 判据 31–33 |
| **N4g** | ensure-file（§2.9）+ 缓存管理 + 歌单导出 + 文档收尾 | 是 | 判据 34–40（**34 是 gate**） |

**顺序理由**：N4a 最前——移动实现要照着冻结的端口写，而契约要在有第二个实现之前先被桌面证明「它测得出东西」；N4b 里 §1.3 那条**一次 playurl 就能答**的问题必须在写任何 UI 之前答掉（答错了整条链在 4G 上是死的），而 hub 与引擎同批出生是引擎 API 的硬约束（§1.1）；N4c 排在 UI 之前，因为之后每次手测都涉及分钟级下载，**熄屏就死的下载会污染后面每一批的结论**；N4d 之后才有生产 UI 可驱动；N4e 在 N4f 之前，因为批量的 LLM 门要有一个真 LLM 才验得了「配了就能过」；N4g 收尾，ensure-file 要等下载链路本身被证明是通的。

---

## §4 判据（1–40，gate 项加粗）

**提取与契约（纯桌面）**

1. **【gate】提取零行为变化**：`routes/download.test.ts` 与 `routes/cache.test.ts` **原样绿**，**且 §2.4 的错误码对照表逐条**（含**本批新补的短链 characterization**——今天它一条用例都没有，所以「原样绿」在这一条上本来是空的）。路由文件只剩 wire 校验与调用。**反测**：把 `preflightSingle` 的多 P LLM 门去掉 → 对照表必须红。
2. `expectedDurationSeconds` 两条路径都真有值：新歌（`resolveTarget`）与重下（`probeSourceKey`）各一条 core 单测。**反测**：把重下那条改回 `null` → 必须红。
3. **【gate】AudioLandingContract 八条在桌面 hook 全绿**：① `commit` 恰好一次且拿到落地时长 · ② `commit` 抛出则整个 landing 回滚且**旧文件原样还在** · ③ 新歌提交失败则目录里什么都不留 · ④ `hasAudio` 认 canonical 文件不认目录 · ⑤ `discardUncommitted` 删目录且对不存在的目录安静 · ⑥ **HTTP 非 2xx → `BilibiliApiError`** · ⑦ **整条传输超时 → 中止且任务 failed** · ⑧ **用户取消 → 任务 cancelled（不是 failed）**。**反测**：拿掉桌面 `landSongFile` 的 `rollback` → ② 必须红。
4. 缓存三件提取后桌面零变化：`daemon/src/cache.test.ts` 原样绿，且桌面注入的 defer 仍是 `setImmediate`。**反测**：把 defer 换成微任务 → 「刚下完的歌被跳过且永不回头」那条必须红。

**落盘与第一次真下载**

5. **【gate】明文 scheme 判定**（§1.3）：在**产品配置的 release 构建**上、**移动网络**下打一次 playurl，把 scheme 与 host 记进 `PROCESS.md`；若是 http，按 §1.3 的第 2 或第 3 条出路当场落地，**再跑一遍判据 6**。Wi-Fi 与移动网络各一遍。
6. **【gate】真机下完一首真 bilibili 歌**：从一条真实视频链接到 `songs/<id>/song.m4a` 存在、**能播**、`song.duration` 与桌面 ffprobe 对同一文件的读数 **±1s**、`file_origin='downloaded'`、`source_key` 正确、**歌词也到了**（引擎的 lyrics 续跑）。
7. **两条拒绝路径**：① 非 AAC（`isAac: false`）→ **在下载任何字节之前**失败，文案说得出「这台设备只收 AAC」；② 0 字节 / 截断的音频（acceptance 的 transfer 缝喂进去）→ ④ 读不出时长 → **不提交、不留文件、目录被收走**。**反测**：把 ② 改成「用 `expectedDurationSeconds` 兜底」→ 必须红（那正是「悄悄没带音频的拷贝被当成一首歌」）。
8. **MMR 与 ffprobe 对照**：N0b 的两条夹具（2:17 / 37:07，有 ffprobe 真值）各一次，差值 **≤1s**；同时记录 `|A − C|`（上游 `page.duration`）的实际差值。不达标 → 走决策 b 的 B（瞬时 player），**不是退回 C**。
9. **时长探测不打断播放**：一边放歌一边落地一首新歌，`dumpsys audio` 全程**只有一个活跃播放器**、播放不断。（MMR 理论上不碰焦点，这条是证明它。）
10. **【gate】契约八条在真机 hook 全绿**（同判据 3 的用例，acceptance 构建）。
11. **【gate】崩溃自愈**：在 ⑤ 与 ⑥ 之间停住（acceptance 的崩溃点，照 N2d 的 PARKED + force-stop）→ 重启后**行在、列表显示「需要下载」**、`.tmp` 被清扫掉、目录还在。**反测**：不做启动清扫 → `.tmp` 必须还在。
12. **孤儿进 trash 而不是 recovered-songs**：造一个「有音频没有行」的目录 → 启动后它在 `trash/recovery-*/` 里，**`recovered-songs/` 一个新条目都没多**。**反测**：把落点改回 `recovered-songs/` → 必须红（这条守的是 N5 的 `quarantined_count`）。
13. **清扫跳过 journal 认领的目录**：造一条**失败/退避中**的远端删除 file-op（它的目录正好是「有音频没有行」的形状）→ 启动后目录**原封不动**、op 仍在 journal 里。**反测**：不传 `skipSongIds` → 目录必须被搬走。
14. **claims 真的共享了**：一次下载进行中删同一首歌 → 被拒（`SongBusyError` 形态），删别的歌照常。**反测**：长命 runtime 不传 `claims` → 必须变成「删成功了，而下载还在写那个目录」。

**前台服务**

15. **【gate】熄屏下完长曲**：37 分钟那条（≈50MB）在**熄屏 + 应用不可见**下下完，全程不重来。证据取主机侧（`dumpsys` 服务在 + 文件最终大小 + 行落库），不取 JS 自述（熄屏后 JS 定时器被冻结）。
16. **【gate】merged manifest**：`FOREGROUND_SERVICE` · `FOREGROUND_SERVICE_DATA_SYNC` · service 的 `foregroundServiceType="dataSync"` · **`INTERNET`** 全在。**反测**：去掉 dataSync 类型 → 必须红。
17. **状态机三态**：① 手势那一刻服务就起（预检还没回来时 `dumpsys` 里已经有它）；② 活动任务归零 2 秒后停、通知消失；③ 起不来时**照常下完**且任务列表上看得见降级态。**反测**：把起服务挪回入队时刻 → 「预检期间切后台」必须复现起不来。
18. **`onTimeout` 停的是全部**：单测断言 timeout → **queued 与 running 一起取消** + 停服务 + 置 `paused-by-system`。**反测**：只取消 running → 必须红（queued 会顶上）。**6 小时配额没有真机证据，如实记。**
19. **通知权限在第一次下载也申请**：全新安装 → 不播放、直接下载 → 权限对话框出现，授予后通知可见。**反测**：只在首播申请 → 下载通知必须不可见。

**添加页与分享**

20. 粘一条**视频链接** → 预览认出它 → 选命名模式 → 选目标（默认「仅曲库」）→ 提交 → 任务列表出现进度 → 完成后歌曲 tab 里就有它。
21. **短链有「正在解析」这一态**：粘一条 `b23.tv`，展开期间 UI 明确在等，展开后显示真实 bvid。
22. **【gate】分享 intent 三条路径 + 根层消费**：从**真 bilibili app 的视频详情页**分享，冷启动 / 后台存活 / 前台各一次；**冷启动那次的默认 tab 是「歌曲」，仍然必须收到**并自动切到添加页。**反测**：把消费点放回 `AddTab` → 冷启动那次必须收不到（`shell.tsx:52` 条件挂载）。
23. 取消：running 的任务点取消 → 最终 `cancelled`，**目录不留残骸**；「全部取消」按每条任务分别作答（过了提交点的那条如实说不能取消）。
24. **命名模式记忆**：选过一次之后下次默认是它（`local_metadata.naming_mode`）。
25. **说不出的输入不装懂**：非 bilibili 链接 / 一段乱码 → 明确拒绝并说支持什么，不静默当关键词丢给 LLM。

**LLM**

26. 设置页填齐 → **关键词搜索**能提交并下成一首歌。
27. `clean` 命名真的走了模型：同一条链接，`original` 与 `clean` 落库的 `name`/`artist` 不同，且 `clean` 失败时**回落到原标题**而不是失败。
28. **多 P 且不写 `?p=`**：没配 LLM → 明确说「加 ?p= 或配 LLM」；配了 → 自动选集并下成。**反测**：去掉 LLM 门 → 未配置时必须变成异步失败而不是当场说明。
29. **重新识别**（`reidentifySource`）：把一首歌的 `source_key` 改成不存在的 cid（acceptance 造）→ 重新下载 → **无 LLM 时 `SOURCE_GONE` 且文案说得出怎么修**，**有 LLM 时**能重新识别并下成。
30. **key 不外泄**：设置页只显示「已配置」；日志、错误文案、任务快照里 grep 不到 key。

**批量**

31. 粘一条**收藏夹**链接 → 展开成条目列表 → 全选/反选 → 目标选「新建歌单（用列表标题）」→ 提交 → 批次进度 M/N 走到底，歌单里是勾选的那些。合集同走一遍。
32. **部分成功如实说**：让列表拉取中途失败（或触发上限）→ 已拿到的条目仍可用，UI 显示的是 `error` / 截断文案。**反测**：去掉 `truncated → error` 那一步 → 必须红。
33. **准入与执行分开**：一个列表组的**准入**全成全不成（拒绝时歌单没被建、一条任务都没进队）；**执行**逐项成败（其中一条视频失效不影响其它条目完成）。两者在 UI 上区分得出来。

**ensure-file · 缓存 · 导出**

34. **【gate】点一首没有文件的歌就能拿回来**：ensure-file 入队 → 下完 → 从头播。**顺带把 N3 判据 15 补完**（歌词缺失 / 纯文本无时间戳 / 有时间戳三种各放一次，UI 都不炸）。
35. **latest-wins 与队列快照**（§2.9）：点缺文件的 A → 立刻点 B（有文件）→ A 下完之后**在放的仍是 B**，A 只是入库；且从歌单详情点 A、等待期间切到「歌曲」tab 并改排序 → A 起播后队列是**起播那一刻**的那一屏。**反测**：不判代际 → A 必须抢走 B。
36. **ensure-file 的零网络短路**：对一首已有文件的歌调它 → 不发任何请求、当场成功（`engine.ts:816`）。**反测**：去掉短路 → 必须看到一次 playurl。
37. **缓存 fail-closed**：断网后手动清理 → **一个文件都不删**，UI 说「没能确认可重下，先留着」。**反测**：把 `probe` 恒真 → 必须删。
38. 限额生效：设一个小于当前用量的限额 → 手动清理后用量落到限额下，**正在播的那首和 pin 的那首没被删**。
39. **歌单导出**：导出 → 系统分享面板出现 → 发给自己 → 与桌面同一歌单的导出**解析后结构相等（忽略 `exported_at`）**。（**不是逐字节**：`transfer.ts:104` 用 `Date.now()`，且 GUI 无末尾换行而 CLI 有 `…\n`——这处不一致是既有的，本批只记录不修。）
40. 跑完上述之后应用仍可交互：切一次歌、开一次全屏页、下一首新歌。

> **本批不会证明的事，先写在这里**：TLS（推迟，§0，**硬阻塞 N5**）· dataSync 的 6 小时配额（判据 18）· 下载期间的**长时间**耐久（判据 15 只证明一条长曲一次下完；vivo 杀后台的风险原样留着）· 手机上**没有 imported 文件**这个前提（§1.5 的整个简化压在它上面，N5 要复核一次）· GUI/CLI 导出的末尾换行不一致（判据 39 的括号）。

---

## §5 决策（a–p，**全部待关闭**）

| # | 决策 | 倾向 | 关键理由 |
|---|---|---|---|
| **a** | 音频传输走哪条 | **原生下载**，端口加 `request: {url, headers, timeoutMs}` + **错误归一契约**（§2.2） | 50MB 走 JS 约是 7500 次跨桥写，要和正在播的歌抢同一个 JS 线程。**但只给 url+headers 会丢掉 client 的整流 deadline 与统一状态检查**（`bilibili.ts:335-341`），所以 deadline 由 client 给、错误类型进契约。JS 流保留为退路 |
| **b** | `duration` 从哪来 | **MMR 原生探测（A）为主 → 不达标退瞬时 player（B）→ C 只做诊断** | C 证明不了文件可解码，用它兜底正好破坏端口的落地事实不变量。A/B 都不可用 = 本批 blocker，回来重做本决策。容差 `|A−C|>3s` = warning |
| **c** | 落盘协议 | **五步 + 启动清扫，不做 manifest**（§2.3） | manifest 保护的是「旧文件绝不能丢」，而手机上没有不可重下的音频（D12）。代价写在崩溃状态表里 |
| **d** | preflight 落点 | **提取进 portable，daemon 变薄壳**；**先补 characterization、保 400 口径** | 四条判断今天只有 daemon 有，而 portable 的等价物对短链答的是 502。`resolveInput` 零生产调用方，改它比改协议便宜 |
| **e** | 前台服务 | **自建 `modules/lark-transfer`**，状态机见 §2.6 | 没有现成 Expo 模块；起在手势、停全部、降级可见都是我们自己的策略 |
| **f** | LLM 配置落点 | **local_metadata + SecureStore 独立键**，无 aviary 回退，converge 不碰 | key 是凭证但**不是 skybridge 的凭证**，塞进那个端口会让「整份凭证一起换」变成假话 |
| **g** | 缓存提取范围 | **EvictionScheduler + `SongLeaseRegistry` + `canRedownload` 一起进 portable**，注入 `defer` | v1 漏了 lease——它在 daemon 里，移动端守卫禁止 import。两条调度语义写两遍必漂 |
| **h** | 明文流怎么办 | **先测 scheme**；http 且有 https 备用地址 → **改选流规则**；否则域名白名单 | 放开全局明文是拿一个跨全应用的安全属性换一个 CDN 节点 |
| **i** | 批量提交语义 | **照桌面，不合并**；措辞是「**准入**全成全不成，**执行**逐项成败」 | `enqueueBatches` 的原子性是准入的（`engine.ts:304-312`），说成「都会成功」会验收一个不存在的承诺 |
| **j** | 任务列表放哪 | **添加 tab 内**，不做全局下载条 | 手机四个 tab 已满，minibar 归播放；进行中的下载靠**通知**在别的 tab 也看得见 |
| **k** | 命名模式记忆 | `local_metadata.naming_mode` | 桌面用 localStorage，手机没有 |
| **l** | 歌单导出 | **cache 目录 + `expo-sharing`**，不碰 SAF；比对按**结构**不按字节 | 主计划 §4.5 的 2026-08-17 修订原文；`exported_at` 本来就每次不同 |
| **m** | ensure-file 怎么触发 | **点没有文件的歌直接入队**，不弹确认框；minibar 显示「正在获取」、可取消 | N2f 手测结论：吞掉点击的行会被当成坏了 |
| **n** | 下载状态容器 | **进程级 external store，和引擎同批出生（N4b）** | `EngineCallbacks` 只在构造时给（`engine.ts:122-128`），没有动态订阅面——hub 晚出生就没有地方接 |
| **o** | ensure-file 的所有权 | **复用播放器代际（latest-wins）+ 队列快照取在起播那一刻**（§2.9） | 与 N3 决策 o 同口径；等 30 秒的下载期间用户很可能已经换了一屏 |
| **p** | 分享 intent 消费点 | **App / Shell 根层消费 → 存草稿 → 切 tab** | `shell.tsx:52` 条件挂载 + 默认 tab 是「歌曲」→ 挂在添加页上冷启动永远收不到；payload 又是易失的 |

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| **🔴 移动网络上是明文流** | 判据 5 排在写任何 UI 之前，三条出路已定价。**Wi-Fi 全绿不构成证据**——必须两张网各跑一遍 |
| **MMR 与 ExoPlayer 是两套 extractor** | 判据 8 拿两条有 ffprobe 真值的夹具先验；不达标退 B（带判据 9 的干扰观测）。**不退 C** |
| **replace 崩在提交与替换之间** | §2.3 的表已写明代价；判据 11 只守 new 那条自愈路径，replace 那条**是已知代价不是 bug** |
| **清扫与 journal 抢目录** | 判据 13 带反测；skip set 是桌面已有的做法，不是新发明 |
| **前台服务把电用光 / 被 OEM 特别对待** | 判据 15 只证明「一条长曲一次能下完」；累计配额（判据 18）与长期耐久都推给打包后的真实使用 |
| **批量把 UI 卡住** | 展开 300 条 = 一次网络 + 一个长列表。`FlatList` + 勾选状态不进每行；判据 31 顺带看掉帧 |
| **LLM key 打字体验** | v1 只保证可粘贴；扫码 / 桌面导入是 N6 议题 |
| **提取动了桌面的下载与缓存路径** | 判据 1 与 4：路由测试与缓存测试原样绿 + **错误码对照表**（光靠测试绿不够，短链那条就是证据） |
| **依赖新增（expo-share-intent / expo-sharing）扰动桌面** | 常驻判据：每次 `pnpm install` 变动后复跑桌面 `just check` + `just test`；bundle smoke 每批跑 |
| **`singleTask` 与 Activity 重建** | share-intent 插件会把 MainActivity 改成 `singleTask`；`bootOnce` 已挡住第二次 boot，但判据 22 的三条路径要顺带确认它仍然只 boot 一次 |
| **判据变成概率题** | 时长比对给 ±1s（跨设备）· 导出比结构不比字节 · 进度不断言具体次数（引擎自有节流，那是它单测的事） |
| **基线红了误判成本批引入** | 开工前已实测 `just check` / `just test` 双绿（见文首）。`spike-media-test` 对环境敏感（首次要用 ffmpeg 生成 30 分钟夹具并起 Electron），红了先看夹具与 Electron |
| **真机验收期间人在用手机** | 老规矩：开跑前说一声、跑完说一声；`not in front` 之类的失败默认解释是人为干扰 |

---

## §7 参考

- 主计划 §4.3 的 N4 行与 **Stage-3 修订**（TLS 移出）· §4.4 风险 · §4.5 的两处修订：`docs/plans/2026-08-13-m4a-and-mobile-master-plan.md`
- N0 子计划 §5「N4 下载」· §9 的 N0b-4a/4b/4c（流探针、header 矩阵、分享 intent 三条）：`docs/plans/2026-08-17-phase-b-mobile-n0.md`
- N1 子计划 §2.3（AudioLanding 合同原文）· §8（D5 分段冻结，签名留到 N4）：`docs/plans/2026-08-18-phase-b-mobile-n1.md`
- N2 子计划 §2.2（冻结启动序列，本批加 ⑪b）· §1.5（原子替换）：`docs/plans/2026-08-19-phase-b-mobile-n2.md`
- N3 子计划 §2.6（队列快照口径）· §2.8（库变更信号）· 决策 b（external store）· §8.1 第 7 条（判据 15 没验的那半）：`docs/plans/2026-08-20-phase-b-mobile-n3.md`
- 引擎与编排：`portable/download/engine.ts:99,122,146,304,755,816,874,888,904` · `pipeline.ts`（`resolveTarget` / `probeSourceKey` / `reidentifySource` / `runLyrics`）· `link.ts:113,128`
- 端口与桌面实现：`portable/ports/audio-landing.ts:44` · `download/audio-landing.ts` · `download/resolve.ts:149,295,456`
- 预检与路由：`daemon/src/routes/download.ts:88,103,198,236` · `daemon/src/error-mapping.ts:94,101,183`
- 缓存：`portable/library/cache.ts:42,58` · `daemon/src/cache.ts:31,80,114,169`
- 桌面 boot 的顺序与 claims：`daemon/src/boot.ts:391,399,478,555`
- 隔离/垃圾两个命名空间：`core/src/paths.ts:101,106,114` · `portable/sync/file-ops.ts:360`
- 移动端现状：`boot/sequence.ts`（⑪）· `services/library.ts`（`NO_PLAYER_CACHE_OPTIONS`）· `player/store.ts:154`（代际）· `player/session.ts:14`（通知权限）· `ui/shell.tsx:52,99` · `ui/songs-tab.tsx:199` · `modules/lark-fs`
- 导出的两处不一致：`portable/library/transfer.ts:104` · `gui/…/TopBar.tsx:118` · `apps/cli/src/commands/transfer.ts:58`
- 桌面 UI 参照（抄语义不抄实现）：`gui/…/components/{DownloadBar,DownloadPanel,BatchSelectModal,NamingModeDialog}.tsx` · `stores/download.ts`
- 平台事实：`node_modules/expo-file-system/build/{File,NetworkTasks}.d.ts`
- 实施记录：`PROCESS.md` 的 Phase B 段；踩坑：`docs/LESSONS.md`

---

## §8 评审修订对照（v1 → v2）

| # | 评审反例 | 复核结果 | v2 的处理 |
|---|---|---|---|
| P1-1 | 原生下载绕过了 `openAudio` 的整流超时与错误归一 | **属实**（`bilibili.ts:335-341` + `timeouts.ts:18`） | §2.2 加 `timeoutMs` 与**错误归一表**；契约新增第 ⑥⑦⑧ 条；移动端 `audioStream` 单独定 15 分钟并写明「整流而非停滞」 |
| P1-2 | 清扫会和未完成的 file-op 抢目录；且 `recovered-songs` 是错的命名空间 | **两条都属实，第二条是我的硬错**：孤儿在桌面进 `trashDir()/recovery-*`（`resolve.ts:456`），而 `recovered-songs/` 会被 `/sync/status` 的 `quarantined_count` 数（`paths.ts:106-115`） | §1.6 重写成三条规则；§2.3 的清扫加 skip set 与 trash 命名空间；**新增判据 12、13 各带反测** |
| P1-3 | 判据 7 与风险表自相矛盾：C 证明不了可解码 | **属实** | 决策 b 改成 **MMR → 瞬时 player → blocker** 的阶梯，**C 只做诊断**；容差与处置写死（§1.4）；新增判据 8、9 |
| P1-4 | 提取会把短链的 400 静默改成 502，而路由测试没有短链用例 | **属实**，且**`resolveInput` 生产零调用方**（实测），所以改它比改协议便宜 | §1.2 新增该表；§2.4 冻结「characterization 先行 + 错误码对照表」；判据 1 改写 |
| P1-5 | FGS 生命周期不足（起的时机 / onTimeout / 暂停通知 / 通知权限） | **四条属实，一条我改口径**：「起不来就继续下载」保留为行为，但改成**可见的降级态**而不是正常成功路径 | §1.9 重写；§2.6 改成 idle→arming→running→paused-by-system 状态机；判据 17、18、19 新增 |
| P1-6 | N4c 要订阅任务状态，但 hub 在 N4d，而引擎没有动态订阅面 | **属实**（`engine.ts:122-128`） | hub 提到 **N4b**，与引擎同批出生（决策 n）；批次表与 §2.1 同步 |
| P1-7 | 基线 `just check` / `just test` 现在就是红的 | **不复现**：本机实测 `just check` exit 0（含 `spike-media-test` 全段）、`just test` exit 0 / **2729 passed** | 文首记基线数字；§6 加一行「这个 gate 对环境敏感（首次要 ffmpeg 生成 30 分钟夹具 + 起 Electron），红了先看夹具」 |
| 小-1 | 分享 intent 消费层级没写清，冷启动收不到 | **属实**（`shell.tsx:52` 条件挂载 + 默认 tab 是歌曲） | 新增决策 p；判据 22 升为 gate 并带反测 |
| 小-2 | ensure-file 缺 latest-wins，且队列快照时机没定 | **属实**（播放器已有 `intent`/`claim()`，`store.ts:154`） | 新增 §2.9 与决策 o；判据 35 带反测 |
| 小-3 | 缓存提取清单漏了 `SongLeaseRegistry` | **属实**（`daemon/src/cache.ts:31`，移动端守卫禁止 import） | 决策 g 扩到三件；§2.7 注明来源 |
| 小-4 | 导出「逐字节相同」不可满足 | **属实两处**：`exported_at: Date.now()`；GUI 无末尾换行 vs CLI 有 | 判据 39 改成**结构相等（忽略 exported_at）**，并把换行不一致记成**既有不一致，本批不修** |
| 小-5 | 「批量全成全不成」措辞会验收一个不存在的承诺 | **属实**（`engine.ts:304-312` 说的是准入原子性） | 判据 33 改成「准入全成全不成 / 执行逐项成败」；决策 i 同步 |
| 小-6 | LLM 四项能力少一项 gate（重新识别） | **属实** | 新增判据 29（含无 LLM 时的 `SOURCE_GONE` 分支） |
| 小-7 | TLS 文档互相冲突 | **属实**：v1 的「不阻塞任何一批」读起来是全局 | §0 改成「不阻塞 N4 任何子批，**硬阻塞 N5**」；主计划 §4.3 加 **Stage-3 修订**；`PROCESS.md` 记待办 |
