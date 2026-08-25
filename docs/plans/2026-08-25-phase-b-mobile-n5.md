# Phase B · N5 同步（`apps/mobile`）

- **日期**：2026-08-25（v1）→ **同日决策 a–j 全部关闭**（用户「可以」）。**b 的措辞按用户改成「暂时不做」而不是「不做」**——它留在账上，不是被否决。
- **执行顺序**：N4i ✅ →（本批）**N5 同步** → N6 歌单导入 + 收尾发布。
- **前置**：N4 全期完成（head `502a23d`，判据 1–64 全关）。**TLS 不再是前置**——见 §0.1。
- **基线**：以开工当天复跑为准（N4i 收官时 `just check` exit 0 · `just test` **3020 passed**）。
- **冻结设备**：vivo V2408A（Android 15 / API 35），行为判据一律 release 构建。
- **测试规模**（用户 2026-08-25 定，比 N4e §8.5 更收）：**默认落单测且优先在电脑上跑**；设备判据攒成**一次打包、一次会话**，由用户自己跑；我只负责 `just mobile-android-release` + 把「看什么」讲清楚。

**一句话的边界**：N4 之后手机是一台**完整但孤立**的播放器——它写的每一行都进了 `sync_changes`，但没有任何东西把它们送出去。**N5 是把这台设备接进 workspace**。

---

## §0 范围

**做**：① **明文开关**（§2.4，用户 2026-08-25 定）；② **CoordinatorContext 的移动装配**（§2.2，15 个字段逐条落地）；③ **触发器的移动版**（§2.3，桌面 `triggers.ts` 的对应物，这是 N5 里唯一没有 portable 现成件的东西）；④ **设置页同步区**（登录 / 登出 / 状态 / 明文开关）；⑤ **同步徽章**；⑥ **冲突页**；⑦ **文件操作失败的处置入口**；⑧ **一个纯桌面提取批**：`sync-labels` 进 `@lark/shared`（§1.6）。

**不做（本批）**：**TLS**（§0.1，转为后续，负责人仍是用户）· `unbind`（桌面也只有 CLI 有，决策 j）· 歌单导入（N6）· 本地音频导入（D12）· 后台同步（决策 b，**暂时不做，留在账上**）· 歌词管理入口（N4i 留下的，仍不做）· 锁屏暂停键接进 JS（N4g 决策 j 的缺口）。

### 0.1 范围修订：TLS（D15）不再阻塞 N5

**用户 2026-08-25 决定**，推翻主计划 D15 的「移动端 v1 只支持 https」：

> **移动端同时支持 https 与明文 http**，由**设置页的一个开关**决定是否接受明文。TLS 从「N5 开工前置」降为**后续**，不阻塞任何批次。理由是产品形状：其他用户会自建 server，让他们先能用明文 IP 简单跑起来，比先要求每人搞定域名 + 证书更重要。

这条要落进主计划 §4.3 的 **Stage-4 修订**、改写 D15 行、并把 `PROCESS.md:941` 那条待办从「N5 开工前二选一」改成「已选明文开关，TLS 转后续」（判据 65）。

**同一次决定的第二条**：**接受音频走明文**。上一轮讨论里提过的「给下载路径补一道 scheme 底线」，用户明确不做——所以判据 5 那段注释的前提失效，必须如实改写而不是留着（判据 66）。

---

## §1 开工前必须知道的

### 1.1 `CoordinatorContext` 有 15 个字段，手机现成的只有 6 个

`packages/core/src/portable/coordinator/context.ts` 是 N1f 留下的整个接缝——**协议、登录序列、状态机、轮次全在 portable**，宿主只负责填这 15 个字段。桌面的填法在 `packages/daemon/src/sync/coordinator.ts:47-66`，一共 20 行。

所以 N5 的主体工作量不在同步逻辑，**在这 15 行的移动答案**（§2.2 逐条）。这是 N1 端口化真正兑现的一次。

### 1.2 触发器是 N5 里唯一没有 portable 对应物的东西

N1f 把**协调器**搬进了 portable，但**触发器**留在 daemon（`packages/daemon/src/sync/triggers.ts`），文件头自己写明了理由：

> 「What is LEFT in this file after N1f is exactly the part an operating system has opinions about: `setInterval`, `unref`, and the SDK's event stream.」

留下的是四个触发源 + 三个常数：`POLL_MS = 1_000`（outbox 轮询）· `REFRESH_POLL_MS = 60_000`（token 到期检查）· `SSE_COOLDOWN_MS = 30_000`（流断后的冷却）· 加上 `interval_min` 的时钟。**去了 portable 的是 `SyncRoundQueue`（`coordinator/rounds.ts`，198 行）**——合流、防抖、退避、「有没有 session」的门全在里面，手机原样复用，**不许答得不一样**。

🔴 **而「操作系统有意见的那部分」在 Android 上意见特别大**：`docs/LESSONS.md` 记着**后台 JS 定时器四次咬人**。桌面那四个触发源在手机后台**一个都不会响**。所以 §2.3 必须重新回答「什么时候跑一轮」，这是本批唯一的真设计题。

### 1.3 手机上的 `sync_changes` 已经攒了三个里程碑

N2 起手机的每一次业务写入都在写 `sync_changes`（schema v2 的不变量），而 N4f 的子计划已经如实记着「新建的歌单会进 `sync_changes`，但 N5 之前没有东西会把它推出去」。

首次登录会发生什么，代码已经答了：`backfillOwed()` 读两个 generation 计数器，`done` 默认 **0**、`target` 默认 **1**（`portable/sync/backfill.ts:63,67`）⇒ **一台从未登录过的手机，首次登录必然跑全量 backfill**，为每一行现存实体制造一个 create；紧接着 `rebase` 在同一个事务里把**带 pending op 的行**的 LWW key 按服务器时钟重写（`portable/sync/rebase.ts:10-16`）。

**两条推论**：① 手机攒下的那些 pending 行不会丢，它们正是 rebase 的作用对象；② 首次登录是**一个大事务**，不是一轮普通同步——判据要单独盯它（判据 71）。

### 1.4 `imported` 行会第一次出现在手机上

N4 全期子计划 §7 明写：「手机上**没有 imported 文件**这个前提（§1.5 的整个简化压在它上面，**N5 要复核一次**）」。

同步拉的是**元数据**，`file_origin` 照拉。桌面一旦有 imported 行，手机上就会出现**一行 `imported` 且本地无文件**的歌。两个后果：

- **缓存清理**：R1/R26 说 imported 永不自动清理。清理逻辑 N4g 已经从桌面提取进 portable（`portable/library/cache.ts`），不变量跟着搬过来了——**这一半大概率没问题，但要有一条单测钉住**（判据 74）。
- 🔴 **ensure-file**：N4g 的形状是「点一首没有文件的歌 = 一次播放意图」，它会去 `reidentifySource` + 下载。而 imported 的歌**可能根本没有 `source_key`**（Go 迁移来的本地文件就是这样）⇒ 无处可下。必须有一句**明确的话**，而不是转圈或一个 INTERNAL_ERROR（判据 75）。

⚠️ **这条在真机上测不到**：本机曲库现在 **7 首全 `downloaded` / 0 首 imported**（CLAUDE.md）。所以它**只能落单测 + 一条确定的措辞**，如实记在 §7。

### 1.5 桌面那三块 UI 有 945 行，手机不需要其中的两块半

| 桌面 | 行数 | 手机要不要 |
|---|---|---|
| `settings/SyncTab.tsx` | 399 | **要**，但砍掉设备列表与撤销设备（决策 f） |
| `SyncBadge.tsx` | 245 | **语义要，实现不要**——桌面是顶栏 hover 卡片；手机四个 tab 已满（决策 i） |
| `ConflictsDialog.tsx` | 217 | **要**，收成一页 |
| `SyncFileOpsList.tsx` | 84 | **要**，最小形态 |
| `stores/sync.ts` | 259 | **不要**——那是 zustand + HTTP 轮询 daemon；手机是**进程内直接调协调器**，没有 daemon 这一跳 |

**手机与桌面最大的结构差**：桌面 GUI 隔着 HTTP 看 daemon 的 `/sync/status`；手机上协调器**就在同一个 JS 堆里**。所以 `buildSyncStatus(ctx)` 直接调用，不需要路由、不需要 store 的轮询层——照 N4b 的 hub 先例做一个进程级 store 就够。

### 1.6 `sync-labels` 是中文枚举表，和 `download-labels` 同型，但它在 GUI 里

`packages/gui/src/renderer/src/lib/sync-labels.ts`（87 行）是**纯函数 + 中文枚举**：`syncBadgeView`（五种 tone / 六句话）· `authReasonLabel`（三条）· `loginErrorMessage`（三个错误码）· `fileOpKindLabel`（四种 op）。零 React、零 Node。

N4 已经有先例：`download-labels` 的三张中文枚举表在 `@lark/shared` 两端共用。**这块照搬那个决定**，提取进 `@lark/shared/sync-labels.ts`，GUI 改成 re-export。这是一个**纯桌面批**（N5a）：characterization 先行、搬完一个字不改、桌面全绿——完全符合用户「优先你在电脑测试」的口径。

🔴 **`loginErrorMessage` 里有一句话要改**：`SYNC_INSECURE_URL` 现在的文案是「……**请勾选下面的选项**」，指向桌面 SyncTab 的复选框位置。提进 shared 之后两端共用，措辞必须与位置无关（判据 68）。

### 1.7 明文这一层现在有两道门，用户决定只留一道半

- **门①（lark 自己的）**：`portable/sync/server-url.ts:57-66`。非 loopback 的 `http://` 默认拒，闸刀是 `allow_insecure_http`，**已经在 portable 里，手机白拿**（`coordinator/login.ts:92-93`）。
- **门②（Android 平台的）**：产品构建没开 `usesCleartextTraffic`，targetSdk 36 ⇒ 明文被平台拦死。spike 构建开着（`spikes/mobile-foundation/app.config.ts:87`），产品构建故意没开。

用户的决定 = **门② 拆掉**（加一行到已有的 `expo-build-properties.android` 块）+ **门① 留着但简化**（一个开关，不做桌面那种两次确认）。

🔴 **拆门② 的代价必须记在两个地方**：`apps/mobile/src/acceptance/downloads.ts:10-18` 那段注释整段的前提是「产品构建不开 cleartext」，它现在会变成一段**说谎的注释**；判据 5 的第二半（「能不能真的拿到字节，明文规则算在内」）从此不证明任何东西。改注释，不删判据（判据 66）。

**为什么不能只给某个 IP 开洞**（写在这里免得将来有人回头想优化）：`networkSecurityConfig` 的 host 白名单是编译期 XML，而「其他用户各自的 server IP」编译期未知；Android 也没有运行时往里加例外的 API。**支持任意自建 server 与 host 白名单互斥**，只剩全局那一行。

### 1.8 `SYNC_PULL_LIMIT_MOBILE = 200` 是**空载下界**，R5 明写了 N5 要复测

`packages/shared/src/limits.ts:99` 已经有这个常量，N1 的 R5 冻结了它，但同一行的冻结文本写着：

> 实测 p95 **90.79ms**（预算 100ms）；500/批 p95 226.05ms 是它被拒绝的证据。**这是空载下界**——**N5 真接同步时须在有渲染与播放竞争的条件下复测**，超预算就降到 100（改一个常量，无协议含义）。

这是 N5 继承的一条**明账**，不是新发明的判据（判据 76）。

### 1.9 SSE 在 N0b 上机绿过，但那是前台 / LAN / dev client

N0b 判据 22 的软半边全绿（子计划 `:581`）：`subscribeEvents` **312ms 开流**、桌面推的那条经 `onChange` 到达、`unsubscribe` 之后 3 秒零帧。**事件必须来自对端才算数**这条当时就守住了。

但那次是：前台、LAN 明文、dev client。N5 的条件是公网、明文 IP、release、且要面对**进后台**。所以 N0b 那条绿证明的是「SDK 在这个运行时里能开流」，**不是**「这条流在手机的生命周期里活得下去」。

---

## §2 目标结构

### 2.1 文件布局

```
packages/shared/src/
  sync-labels.ts            ← N5a：从 GUI 提取，两端共用（§1.6）

apps/mobile/src/
  sync/
    context.ts              ← CoordinatorContext 的移动装配（§2.2）
    triggers.ts             ← 触发器移动版（§2.3），实现 SyncBackgroundHandles
    hub.ts                  ← 进程级 store + useSync hook（照 downloads/hub.ts）
    settings.ts             ← local_metadata：明文开关 + interval（§2.4）
    quarantine.ts           ← countQuarantined 的移动实现
  ports/
    device.ts               ← DeviceNameSource（决策 e）
    events.ts               ← EventsBus → library-signal 的适配
  ui/
    sync-section.tsx        ← 设置页的同步区（登录/登出/状态/明文开关）
    sync-badge.tsx          ← 徽章（决策 i 定位置）
    conflicts-screen.tsx    ← 冲突页
    file-ops-section.tsx    ← 文件操作失败的处置
```

### 2.2 `CoordinatorContext` 的移动答案（15 个字段逐条）

| 字段 | 桌面 | 手机 | 状态 |
|---|---|---|---|
| `sync` | `ctx.sync` | `new SyncRuntime()`，与 boot 同生命周期（**每进程一个**，照 `bootOnce`） | 新建 |
| `db` | `ctx.portable` | `boot.db` | ✅ 现成 |
| `files` | `ctx.files` | `boot.files`（`boot/sequence.ts:229`） | ✅ 现成 |
| `logger` | pino | `engineLogger`（`downloads/log.ts`）——**同一个环形缓冲**，设置页已经在读 | ✅ 现成，⚠️ 见风险 R3 |
| `credentials` | `nodeCredentialStore()` | `ports/credentials.ts`（SecureStore） | ✅ 现成，**但从未被真登录走过**（文件头自己写着） |
| `events` | `ctx.eventsBus` | 新适配：`LarkEvent` → `library-signal` 的 `libraryChanged()` | 新建 |
| `now` | `Date.now` | `Date.now` | ✅ |
| `deviceName` | `os.hostname()` | 决策 **e** | 新建 |
| `api` | `ctx.skybridge` | `realSkybridgeApi`（`portable/coordinator/client.ts:47`），SDK 已是 mobile 依赖 | ✅ 现成 |
| `fileOps` | `ctx.fileOps` | `boot.fileOps`（N2 就有的 `FileEffectRuntime`） | ✅ 现成 |
| `countQuarantined` | 数 `recovered-songs/` 下的目录 | 同语义，`recoveredSongsRoot()` 已存在（`ports/song-files.ts:57`） | 新建（约 10 行） |
| `intervalMin` | `config.sync.interval_min` | 决策 **d** | 新建 |
| `pullLimit` | `SYNC_PULL_LIMIT`（500） | `SYNC_PULL_LIMIT_MOBILE`（200），**§1.8 要复测** | ✅ 常量已在 |
| `version` | `ctx.version` | app.config 的 `version`（`0.1.0`，D14 的独立版本线） | ✅ |

**六个现成、一个常量已在、七个新建**，其中五个是十行以内的适配。**这就是 N1 端口化的兑现。**

### 2.3 触发器的移动状态机（**本批唯一的真设计题**）

桌面四个触发源 + 手机的现实：

| 触发源 | 桌面 | 手机（建议口径，决策 **b/c**） |
|---|---|---|
| **outbox 轮询** | `setInterval` 1s，永远 | **只在前台**。后台 JS 定时器是冻的（LESSONS 四次咬人），装了也不响 |
| **时钟** | `interval_min` | **只在前台**，且 §2.3 的 resume 触发已经覆盖了大部分它要覆盖的场景 |
| **token 刷新检查** | `setInterval` 60s | **只在前台** + **每次 resume 先查一次**（后台待久了 token 可能已过期） |
| **服务器 SSE** | 长连接，永远 | **前台开、进后台关**（决策 c）。长连接在后台会被系统切，且耗电；`SSE_COOLDOWN_MS` 的语义原样保留 |
| **人** | `POST /sync/run` | 设置页的「立即同步」 |
| 🆕 **resume** | 无 | **回前台 = 一次 `'boot'` 触发**。这是手机上取代「永远在线」的那一条 |

```
                     ┌──────────── AppState 'active' ────────────┐
                     ↓                                            │
  [stopped] ──login──→ [running]                            [suspended]
                     │   · 定时器全开                             ↑
                     │   · SSE 订阅                               │
                     └──── AppState 'background'/'inactive' ──────┘
                              （停定时器 + 断 SSE，不动 session）
```

🔴 **三条必须写死的规则**：

1. **`SyncRoundQueue` 一个进程只有一个**，所有触发都经它（合流/防抖/退避照桌面）。「两条路进同一个库」是桌面明确防住的事（`triggers.ts` 的 `attachSyncHandles` 注释）。
2. **suspend 不碰 session**——只停触发器。`teardownSession` 是登录/登出/unbind 的动词，进后台不是生命周期变化。
3. **resume 的那一轮要先查 token**，再跑同步。后台待了两小时的 access token 大概率已经过期，先跑同步就是白撞一次 401。

**如实记下的产品形状差**（不是 bug，要写进用户可见的说明）：**手机在后台不会收到别的设备的改动**，回到前台才收敛。桌面 daemon 常驻，手机不是。

### 2.4 明文开关的形状（用户已定方向，细节待确认 = 决策 **a**）

- **落点**：`local_metadata.sync_allow_insecure`（照 N4d 的 `naming_mode` / N4g 的 `cache_limit_mb` 先例）。**读路径不写库**（照 `now_playing_mode` 的规矩），缺行或非法值一律读 `false`。
- **形态**：设置页同步区一个 `Switch`「允许明文 HTTP（不安全）」，下面一行说明代价。**不做二次确认弹窗**——用户明确说「只做一个设置开关」。
- **接线**：登录时读它 → `performSyncLogin({ …, allow_insecure_http })`。门① 原样生效：关着开关填 `http://` 会拿到 `SYNC_INSECURE_URL`，UI 显示 `loginErrorMessage` 的那句（措辞见 §1.6 的修改）。
- **不做**：`usesCleartextTraffic` 的运行时开关（不存在这种东西，manifest 是编译期的）。开关只管 lark 自己那道门。
- **manifest**：`apps/mobile/app.config.ts` 的 `expo-build-properties.android` 加 `usesCleartextTraffic: true`，**带注释写明这是用户 2026-08-25 的决定 + 代价指向 §1.7**。

### 2.5 三块 UI 的落位

- **同步区**（设置页，替换 `settings-tab.tsx:87` 的「同步在 N5 开放。」）：服务器地址 + 邮箱 + 密码 + 明文开关 → 登录；已登录时显示 状态 / 待推送 / 上次同步 / 设备 ID / workspace，加「立即同步」「退出登录」。
- **徽章**：决策 **i**。
- **冲突页**：从同步区进（「N 条冲突待处理」），一页列表；每条给「用本机的」/「用远端的」两个按钮，照 `portable/sync/conflicts.ts` 的 `resolveConflict` 语义。
- **文件操作失败**：同步区里一段（「文件操作失败 N 条」+ 重试 / 丢弃），照 `SyncFileOpsList.tsx` 的最小语义。

---

## §3 批次划分

| 批 | 内容 | 在哪测 |
|---|---|---|
| **N5a** ✅ | **纯桌面**：`sync-labels` 提取进 `@lark/shared`（characterization 先行，GUI 改直接 import，`SYNC_INSECURE_URL` 措辞改写）+ **文档口径统一**（判据 65，用户 2026-08-25 要求从 N5b 提到本批——否则有一整批的时间里 `PROCESS.md` 还写着「TLS 硬阻塞」） | 电脑，桌面全测试 |
| **N5b** | manifest 那一行 + `sync/settings.ts` 明文开关 + §8.2 的两句注释 | 电脑（单测）+ 构建 |
| **N5c** | `CoordinatorContext` 移动装配（§2.2 的七个新建）+ `sync/hub.ts` | 电脑（单测 + 假 API 驱动整条登录序列） |
| **N5d** | 触发器移动版（§2.3 状态机）+ `AppState` 接线 | 电脑（虚拟时钟单测）+ 设备会话 |
| **N5e** | UI 四块（同步区 / 徽章 / 冲突页 / file-ops） | 电脑（能测的部分）+ 设备会话 |
| **N5f** | **一次打包、一次真机会话**：判据 69–73 + 76 一起跑 | 设备，用户跑 |

**N5a 可以立刻开工**（不依赖任何决策）。N5b 起需要决策 a 关闭；N5d 需要 b/c/d；N5e 需要 f/g/h/i。

---

## §4 判据（接着 N4i，从 65 起）

**归属标注**：`桌`= 桌面/单测可答 · `机`= 只有设备能答 · `文`= 文档一致性。

| # | 判据 | 归属 |
|---|---|---|
| 65 ✅ | 主计划 §4.3 有 Stage-4 修订段 + D15 行与 N5 行改写；`PROCESS.md` 的 TLS 待办改成「已选明文开关，TLS 转后续」+「下一站」那句；CLAUDE.md 加 N5 段并去掉「TLS 硬阻塞」（**N5a 完成**） | 文 |
| 66 | `acceptance/downloads.ts` 判据 5 那段注释改写：前提失效说清楚，**不删判据、不假装它还在证明什么** | 文 |
| 67 | `sync-labels` 在 `@lark/shared`，GUI 是 re-export；提取前的 characterization 测试搬完**一个字没改**地全绿；桌面 `just check` + `just test` 零回归 | 桌 |
| 68 | `loginErrorMessage(SYNC_INSECURE_URL)` 的措辞与「复选框在哪」无关，两端读着都成立 | 桌 |
| 69 | 明文开关**关着**填 `http://<公网IP>:8443` → 拿到 `SYNC_INSECURE_URL` 的那句话，**零请求发出** | 桌 + 机 |
| 70 | 明文开关**开着**同一地址 → 登录成功；SecureStore 里 `server.allow_insecure_http === true` | 机 |
| 71 | **首次登录跑全量 backfill**：登录后 `pending_count` 覆盖手机上现存的全部歌 / 歌单 / 歌词；一轮之后归零，`pushed_seq > 0` | 机 |
| 72 | 桌面那台改一首歌名 → 手机**回到前台**之后收敛到同一个名字；手机改歌手 → 桌面收敛。两边互不覆盖 | 机 |
| 73 | **歌曲本体不同步**：桌面有文件、手机上那首是「需要下载」；点它走 N4g 的播放意图路径拿回来 | 机 |
| 74 | **`imported` 行永不被自动清理**：单测造一行 `file_origin='imported'` + 一个文件，跑满清理条件，文件仍在 | 桌 |
| 75 | **`imported` 且无 `source_key` 的歌被点开**：给出一句明确的话（不是转圈、不是 INTERNAL_ERROR）。措辞进 `download-labels` 或就近的枚举表 | 桌 |
| 76 | **`SYNC_PULL_LIMIT_MOBILE` 在竞争条件下复测**（R5 的明账）：一边播放一边拉 200/批，p95 ≤ 100ms；超了就降到 100 并记录 | 机 |
| 77 | **进后台 → SSE 断开、定时器停**；**回前台 → 先查 token、再跑一轮**。三条各有断言（虚拟时钟 + `AppState` 假事件） | 桌 |
| 78 | **suspend 不碰 session**：进后台再回来，`sync.epoch` 不变、不需要重新登录 | 桌 |
| 79 | 一个进程只有一个 `SyncRoundQueue`；两个触发同时到只跑一轮（照桌面的合流语义） | 桌 |
| 80 | 冲突页：造一条冲突 → 列表看得到 → 选「用本机的」→ 冲突计数归零，且本机值被重新推出去 | 桌 |
| 81 | 文件操作失败的处置：造一条失败 op → 同步区看得到计数 → 重试 / 丢弃各走通一次 | 桌 |
| 82 | 徽章反映五种状态（`syncing` / `auth_required` / `error` / `offline` / `idle`），文案取自 `@lark/shared` 的 `syncBadgeView` | 桌 |
| 83 | **退出登录**：session 没了、binding 还在、曲库一行不少；再登录回来不重复 backfill | 桌 |
| 84 | `just check` / `just test` / `just mobile-typecheck` / bundle smoke 全绿；守卫八条不破（尤其 mobile 只 import portable/shared/skybridge SDK） | 桌 |

**设备判据只有 6 条**（69 的一半 · 70 · 71 · 72 · 73 · 76），攒成一次会话。

---

## §5 决策（a–j，**2026-08-25 全部关闭**）

| # | 决策 | 倾向 | 关键理由 |
|---|---|---|---|
| **a** | 明文开关的形状 | **一个 `Switch` + 一行说明，无二次确认**；落 `local_metadata.sync_allow_insecure`，读路径不写库 | 用户 2026-08-25 原话「只做一个设置开关」。桌面的两次确认是给「意外」设计的，而手机上这是**默认用法**——每次登录都弹一次会变成噪音 |
| **b** | 后台同步做不做 | **暂时不做，v1 只前台**（用户 2026-08-25 的措辞：记录在案，不是否决） | 后台 JS 定时器是冻的（LESSONS 四次咬人）。真要后台同步就得挂进 `lark-transfer` 的前台服务，那是一整批的工作量，而收益是「息屏时也能收到别人的改动」——一个人自用的场景里近乎零 |
| **c** | SSE 前台开 / 后台关 | **是**，跟 b 绑 | 长连接在后台会被系统切；`SSE_COOLDOWN_MS` 的语义原样保留，不发明新的重连策略 |
| **d** | `interval_min` 给不给 UI | **不给，固定 15 分钟** | 手机上真正管用的是 resume 触发（§2.3）。多一个旋钮就多一个要解释的东西，而它在手机上几乎不影响结果 |
| **e** | `deviceName` 从哪来 | **`Platform.constants.Model`（RN 内置，零新依赖）**，取不到时回退 `'Android'` | `expo-device` 是一整个新原生模块，而这个字符串**只是设备列表里的一个标签**——`ports/device.ts` 的文件头自己写着「no code keys off it」 |
| **f** | 设备列表 / 撤销设备 | **只读列表做，撤销不做**（放 N6） | 「这个 workspace 上有哪几台」是登录后第一个想确认的事；而撤销是危险动作，值得单独设计确认流。桌面有 `/sync/devices` 的现成数据 |
| **g** | 冲突页做到什么程度 | **列表 + 二选一，不做逐字段 diff** | `resolveConflict` 的语义本来就是二选一（`portable/sync/conflicts.ts:170`）。逐字段 diff 是桌面都没有的东西 |
| **h** | file-ops 失败的入口 | **同步区里一段，不做独立页** | 最小形态 84 行（桌面），且这是一个**希望永远是 0** 的计数 |
| **i** | 徽章放哪 | **设置 tab 的图标上一个小圆点 + 同步区顶部一行完整状态** | 四个 tab 已满、顶栏搜索框归歌曲/歌单。小圆点只答「要不要去看」，细节在同步区。**反对方案**：minibar 那一行——它 N4g 已经定性为「播放承诺」，不能再兼职 |
| **j** | `unbind` 做不做 | **不做** | 桌面也只有 CLI 有，且要求独占库（`cli/src/index.ts:158-173`）。手机上「退出登录」够用；真要换 workspace 是卸载重装 |

---

## §6 风险

| 风险 | 处置 |
|---|---|
| **R1 明文 + 公网 = 密码与 token 裸奔** | 用户已知并接受（§0.1）。开关旁边的说明要**说实话**，不是「不推荐」而是「你的密码会明文过网络」 |
| **R2 SecureStore 的 ~2KB 上限** | `ports/credentials.ts` 文件头自己标了「KNOWN LIMIT, unverified」——一份真凭证是 URL + email + 两个 JWT + 两个 id，**可能接近**。N5c 第一次写真 token 时**当场量一次**，超了就分键存 |
| **R3 `engineLogger` 是五行环形缓冲，且带原始错误** | 同步的日志量比下载大。要么给同步单独一个环，要么加大 RING。**脱敏仍未做**（N4e 的账），同步的错误里可能带 server URL 与 email——比下载的暴露面更敏感，**这条要在 N5c 复看一次** |
| **R4 首次登录是一个大事务** | 手机上库小（几十首量级），但 backfill + rebase 在一个事务里。判据 71 盯着；真慢了就是 N1 R5 那套分批参数的问题，不是新问题 |
| **R5 明文开关开着 + 用户填了 https 地址** | 开关只是**允许**，不是**强制**。https 地址照常走 https。要有一条单测钉住这个（不然容易写成「开了就降级」） |
| **R6 拆掉平台明文门之后，别的出网点跟着松** | 用户已明确接受（§0.1 第二条）。**如实记在判据 66 的注释里**，不要假装它还被守着 |

---

## §7 本批不会证明的事

- **TLS**（转为后续，负责人仍是用户；`PROCESS.md` 待办保留但改写）。
- **`imported` 的设备半边**（§1.4）——本机库 0 首 imported，判据 74/75 只有单测。
- **后台同步**（决策 b **暂时不做**）——「息屏时收到别人的改动」这件事本批不存在。
- **长时间 soak**（v0.2 桌面的 soak 清单 §3 那种两台设备连跑）——手机侧只做判据 72 的一次往返。
- **撤销设备**（决策 f，放 N6）· **`unbind`**（决策 j，不做）。
- **SSE 在公网明文 + release 下的长期存活**（§1.9）——判据只证明「开得起来、收得到」，不证明「挂着一小时不断」。
- **`sync_changes` 攒了很久之后首次登录的极端体量**——手机上的量由这三个里程碑的实际使用决定，没有人造大库。

---

## §8 实施修订

### 8.1 N5a 落地（2026-08-25）

- **characterization 先行**：`sync-labels.ts` 搬家前**零直接测试**（和 `download-labels` 当年一样），先在原位补 16 条钉住今天的行为，**反测过**（改两处文案 → 2 红，还原 → 16 绿），再搬。
- **搬完一个字没改**：`packages/shared/src/sync-labels.ts`，GUI 三个消费点（`SyncBadge` / `SyncTab` / `SyncFileOpsList`）改成直接 `import … from '@lark/shared'`——**不做 re-export 转发层**（多一层文件只为少改三行 import，不划算）。
- **一处有意的行为变化（判据 68）**：`SYNC_INSECURE_URL` 的文案由「请勾选**下面的选项**」改成「请先打开**「允许明文 HTTP」**」。桌面的复选框标签本来就以这五个字开头，手机的开关同名，措辞因此与位置无关。
- **两条踩到的事**：① **GUI 的 vitest 解析的是 `@lark/shared` 的 `dist/`**，不重新 `build` 就是 `syncBadgeView is not a function`（15 红），与代码无关；② shared 的 `tsc` 比 GUI 严，`noUnusedLocals` 会拒绝一个纯类型守卫变量——那条守卫本来就与 `SYNC_STATES` 的遍历重复，删掉。
- **判据 65 在本批关掉**（用户要求从 N5b 提前）：主计划的 D15 行与 N5 行改写 + Stage-4 修订段 · `PROCESS.md` 的待办与「下一站」· CLAUDE.md 加 N5 段。**历史子计划（N4f/N4g/N4h/N4i）里的「TLS 仍硬阻塞」一个字不动**——那些记录的是当时为真的事，改它们等于篡改历史。
- **`SyncTab.tsx` 的 `noExcessiveCognitiveComplexity` 警告是预先存在的**（HEAD 上在 207 行，改完在 206 行，只是被删掉的那行 import 顶上去了），不是本批引入的。

### 8.2 N5b 要顺手改的两句谎话

明文开关落地之后，下面两句注释会变成假的（现在还是真的，所以本批不动）：

- `packages/shared/src/sync-types.ts:207-209`：`allow_insecure_http` …「is confirmed **twice** in the UI before it gets here」
- `packages/core/src/portable/sync/server-url.ts:8`：「an explicit breaker … **confirmed twice in the UI** before it reaches here」

手机上是**一个开关、零次确认**（决策 a）。两句都要改成「由宿主显式表态后才到这里」这种与 UI 形态无关的措辞。

---

## §9 参考

- 接缝与协调器：`portable/coordinator/{context,runtime,runner,rounds,login,logout,refresh,status,client,session}.ts`
- 桌面装配与触发器：`daemon/src/sync/{coordinator.ts:47-66,triggers.ts}`
- 明文门：`portable/sync/server-url.ts:57-66` · `portable/coordinator/login.ts:92-93,115-116,317`
- backfill / rebase：`portable/sync/backfill.ts:63,67` · `portable/sync/rebase.ts:10-16`
- 常量：`shared/src/limits.ts:85,99`（500 / 200）
- 桌面 UI 参照（抄语义不抄实现）：`gui/…/settings/SyncTab.tsx` · `SyncBadge.tsx` · `ConflictsDialog.tsx` · `SyncFileOpsList.tsx` · `lib/sync-labels.ts` · `stores/sync.ts`
- 移动现状：`boot/sequence.ts:229-232` · `ports/{credentials,song-files,paths}.ts` · `downloads/log.ts` · `downloads/hub.ts`（store 先例）· `ui/settings-tab.tsx:87`
- 平台事实：`app.config.ts`（`expo-build-properties`）· `spikes/mobile-foundation/app.config.ts:87` · `acceptance/downloads.ts:10-18`
- 前序结论：N0b 子计划 `:581`（SSE 软判据）· N1 子计划 `:358,402`（R5 与 200 的空载下界）· N4 全期子计划 `:440`（imported 前提 + TLS）
- 主计划：`2026-08-13-m4a-and-mobile-master-plan.md` §4.3（D15 / Stage-3 / **待加 Stage-4**）
- 踩坑：`docs/LESSONS.md`（后台定时器四次 · `bootOnce` · 原生模块接线）
