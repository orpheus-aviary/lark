# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版。从零设计，可参考 `../lark-go/` 的既有实现作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 状态

🚀 **v0.1.0 已发布**（2026-08-10）—— [Release](https://github.com/orpheus-aviary/lark/releases/tag/v0.1.0)（`Lark-0.1.0-arm64.dmg`，bundled 模式）+ [`@orpheus-aviary/lark-cli@0.1.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)，tag → `9581bbc`。

M0–M7 全部完成，每个里程碑的子计划、决策与实测记录见 `docs/plans/` 与 `PROCESS.md`：

| | 内容 | 验收 |
|---|---|---|
| M0 | 五包骨架 + `lark-media://` spike | 六项判据全过 |
| M1 | core 数据层 + Go 库迁移协议 | 真实库已迁（20/2/4） |
| M2 | daemon 生命周期 + 全路由 + SSE | 用户验收通过 |
| M3 | 下载管线（bilibili / LLM / 歌词 / 原子落盘） | T3 gate GO |
| M4 | GUI 基座 + 媒体协议移植 | `accept-gui` 15/15 |
| M5 | 缓存模型 / 按需下载 / 歌单导入导出 / 多选批量 | `accept-m5` 22/22 |
| M6 | CLI（双后端 + 身份五态 + skill export） | `accept-cli` 27/27 |
| M7 | 打包发布（ffmpeg 供应链 + 两模式 + 许可交付） | `accept-pack` 28/28 |

v0.1.0 基线测试 1697（shared 74 / core 569 / cli 371 / daemon 337 / gui 346）。

🚧 **v0.2 skybridge 同步开发中**——子计划 `docs/plans/2026-08-11-v0.2-skybridge-sync.md`（六版终版，决策 D1–D8 全关闭）。批次 T0–T6：

| 批 | 内容 | 状态 |
|---|---|---|
| T0 | 依赖钉版 + migration `0002-sync-activation` + 类型/错误码/`[sync]` config | ✅ |
| T1 | core 基座（hlc/lww/tombstones/backfill/file-ops/emit 接线，四小批 a–d） | ✅ |
| T2 | core engine（runSync / apply / conflicts CAS / retry / retention） | ✅ |
| T3 | daemon（凭证与 binding / login 序列 / epoch / runner 与三触发器 / 路由 / boot drain，四小批 a–d） | ✅ |
| T4 | GUI（徽章 + popover + 设置页 Tabs + 冲突页 + 列表重复标记，三小批 a–c） | ✅ |
| T5 | CLI（sync 七命令 + `songs list --duplicates` + skill export） | ✅ |
| T6 | 双套 e2e ✅（19 例）+ `accept-sync` ✅（34/34）+ 真机 soak ✅（自动 18/18，N 系列缓做）+ 发版 0.2.0 ⏳ | 🚧 |

当前测试 **2098**（shared 79 / core 813 / cli 395 / daemon 433 / gui 378）+ **e2e 19**（`just test-sync-e2e`）+ **accept-sync 34**（`just accept-sync`）。两者都需要 skybridge server：e2e 找不到就 skip，accept-sync 找不到就**失败**。每批的实施记录、判断与实测锁定见 `PROCESS.md` 的 v0.2 段；手动 soak 清单见 `docs/plans/2026-08-12-v0.2-soak-checklist.md`。

⚠️ **本机真实曲库已经是 schema v2**（2026-08-12 soak 时被 v0.2 GUI 开过一次，用户拍板不还原）——已发布的 **0.1.0 从此拒绝打开它**（`user_version > LATEST`），0.2.0 发版前只能用仓库产物。它已 `sync unbind --force` 清回未绑定态，21 首 / 4 歌单完好。开发期仍一律 `just backup-nest <目录>` + `LARK_NEST_DIR` 用副本，**起 GUI 后先用 `/api/instance` 验 `nest_dir` 再登录**。

**每个里程碑先出子计划**（`docs/plans/<日期>-<里程碑>.md`）经用户过目再动手，实现按任务分批、每批提交前给用户看 commit 信息。

## 技术栈

- **语言**：TypeScript (ESM)
- **桌面**：Electron + electron-vite
- **后端 daemon**：Fastify + better-sqlite3 + drizzle-orm
- **前端**：React + shadcn/ui + Tailwind v4 + zustand
- **CLI**：commander
- **包管理**：pnpm
- **Lint**：Biome
- **测试**：vitest

## 仓库结构

```
lark/
├── packages/
│   ├── shared/     # @lark/shared — Node-free 线协议（类型、HTTP client、SSE、api-paths）
│   ├── core/       # @lark/core — 业务逻辑（db、songs/playlists、下载、歌词、缓存、config、logger）
│   ├── daemon/     # @lark/daemon — Fastify server + `lark daemon` 入口
│   └── gui/        # @lark/gui — Electron main/preload/renderer
├── apps/
│   └── cli/        # @lark/cli — 对外 CLI（发布为 @orpheus-aviary/lark-cli，bin `lark` / `lark-cli`）
├── spikes/
│   └── media-protocol/  # lark-media:// 验证工程，长期保留作 M4 移植参照
├── scripts/        # 依赖方向守卫（rg 源码，不查 package.json）
└── docs/
```

依赖方向：`shared ← core ← daemon ← gui`；`cli → shared` + `core`（静态只碰零原生子路径 `paths` / `config` / `daemon-control` / `native-probe`，barrel 只在 `--direct` 分支 dynamic import）。四条守卫进 `just check`：core 禁 daemon/gui/electron、daemon 禁 gui/electron、shared 禁一切 Node builtin（`node:` 前缀与裸名都拦）、cli 禁 daemon/gui/electron **且禁静态 import core barrel**。

**已决定**（主计划 §1）：不抽 `@orpheus-aviary/daemon-kit`，v0.1 直接复制 owl 模式，出现明显重复再重构。

## 注意事项

- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API（默认端口 **47100**，端口段 `471xx` 归 lark）；daemon 存活时 CLI **一律禁止 `--direct` 写**（无 `--force`，R31）
- **跨进程写互斥**（M6 T0）：daemon / `--direct` 写 / migrate-go / backup-nest 四方共守 `songs.db.writer.lock`（常驻 SQLite 锁库，`BEGIN EXCLUSIVE`，kill -9 自动释放，**锁文件永不删**）；锁序冻结 **writer → migrate → 真库 EXCLUSIVE**；读路径不取任何锁（只读打开、零写入）
- **数据目录**：`~/orpheus-aviary-nest/lark/`
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`；例外：`/audio`（二进制 + Range）、`/lyrics`（text/plain）、`/events`（SSE）
- **token**：由 daemon 生成并原子发布 0600 文件；GUI 侧每次读取，不进 URL/DOM/日志/媒体 src（R21/R29）
- **skybridge 同步**（v0.2，schema v2 起）：实体 `device_id` 只存 skybridge 注册 ID（本地身份在 `local_metadata.device_uuid`，两域不混用）；凭证在**独立文件** `~/orpheus-aviary-nest/lark/skybridge.toml`（0600，不进 `/config` 通道，**backup 每一层都排除**）；`LOCAL_API_VERSION` = **5**（`/sync/*` 与 `/conflicts/*`）
- **媒体文件**：歌曲本体不同步、不走 attachment——各设备凭 `source_key`（bilibili = `bvid:cid`）按需下载；歌词文件永不参与缓存清理
- **缓存清理不变量**：只清理 `file_origin='downloaded'` 且清理前探活确认可重下的文件；imported（含 Go 迁移曲库）是用户资产，永不自动清理（R1/R26）

### M0 实测锁定（改动前先读 `docs/plans/2026-07-31-m0-scaffold-media-spike.md` §6）

- **版本**：Electron **43.2.0**、Node 24.13.0（`.node-version`）、全依赖精确锁版；**vite 用根 `pnpm.overrides` 钉 7.3.6**——只锁直接依赖挡不住传递范围把它抬到 8，而 electron-vite 5 的 peer 只到 7，失效方式是静默的（build 照样成功，但 electron 被打进 main bundle）
- **Electron ESM main 不得顶层 `await app.whenReady()`**：ready 只在入口模块求值完成后才发，顶层 await 直接死锁（不开窗、无输出、无退出）。包一层 `async function bootstrap()`
- **renderer CSP 单一来源 = gui 的 Vite 插件**（`order: 'post'` + `head-prepend`）；`index.html` 不手写 meta。dev 比生产多两处放宽：`connect-src` 加 HMR socket、`script-src` 加 `'unsafe-inline'`（React Fast Refresh preamble 是内联 script）
- **M2 的 `/audio` 三条义务**（spike 实测）：尊重 backpressure（写回调 + 速率，不能只按时间节流）、按「单曲可能并存约 6 条 range 流」预算 fd、在响应 `close`/`error` 上做一次性清理（幂等 guard）。**不要用「按块封顶 206」缓解慢速来源**——实测会把媒体元素打进 `MEDIA_ERR_NETWORK`
- **transport 重试**：仅 GET 默认重试（2 次），且只重试 fetch 网络层异常；收到响应后 401/5xx/非 JSON 一律不重试（M0-7）

### M1 实测锁定（详见 `docs/plans/2026-07-31-m1-core-data-layer.md` §7）

- **版本定案**：better-sqlite3 **12.11.1**（engines 显式列 Node 24.x；13.0.x 发布两周不追新首发）、drizzle-orm 0.38.4、pino 9.14.0、pino-roll 2.2.0、smol-toml 1.6.1、@electron/rebuild 4.2.0；`process.versions.modules`：**Node 24.13.0 = 137、Electron 43.2.0 = 148**（双运行时真值探测复核）
- **ABI recipes 已接线**：`ensure-node-abi` 挂 test / test-core / test-daemon / dev-daemon / migrate-go；`ensure-electron-abi` 已落地但 **M4 才接线**（M1–M3 无 Electron 内加载 better-sqlite3 的入口）；core 的 vitest 用 **fork 池**（worker 池下原生模块有崩溃前科，M1-14）
- **迁移锁**：`songs.db.migrate.lock` 是**常驻** SQLite 锁库（持锁 = 连接上 `BEGIN EXCLUSIVE`，内核 fcntl 锁，kill -9 自动释放）——**锁文件永不删除**，其存在与否不携带语义
- **createDatabase 判定前零写入**：`journal_mode=WAL` 必须在三条拒绝路径（>LATEST / Go 旧库 / 未知 v0 非空库）判定之后才设——提前设会把仍在日常使用的 Go 库从 DELETE 静默改成 WAL（测试有字节级不变断言）
- **loadConfig 强制收紧 0600**：存量 0644 的 `lark_config.toml` 即使只加载不保存也会被 chmod 0600，chmod 失败即抛错不带病运行
- **migrate-go 的 EXCLUSIVE 触发**：owl 的「真实读」之上还需一次同值写升级（`BEGIN IMMEDIATE` + `PRAGMA user_version=0`）——纯读探不到外部未提交写事务（RESERVED），也拿不到真正的排他锁

### M2 实测锁定（详见 `docs/plans/2026-08-04-m2-daemon-routes.md` §7）

- **boot 只有一个执行者**：信号在 boot 驱动期只由 `requestStop` **记录**原因，teardown 由 boot 的三个 checkpoint（listen 前 / listen 后 / running 后）执行——handler 自己 teardown 会与仍在 `await listen()` 的续体并发关 server。`requestFatal` 幂等且**非等待**（路由先回 500 再 `setImmediate` teardown，await 必死锁）
- **测试注入走 `BootOptions` 形参**（`port` / `stallBeforeListenMs` / `fatalAfterMs`），三个 env 只由 `packages/daemon/src/testing/boot-child.ts` 读；正式 CLI 恒 47100
- **`just test-*` 一律前置 build**：core / daemon / cli 都通过 **dist** 消费 `@lark/shared`，改了源码不重建就跑测试会静默用旧 dist
- **Fastify 5 自带 `text/plain` 解析器**：想触发 415 要用 `application/xml` 之类未注册解析器的类型
- **`reply.hijack()` 后 onSend 不跑**：SSE 的 CORS 头必须手写回显，且先过 `isOriginAllowed`
- **`/audio` 用 `reply.send(stream)`**（背压由 pipe 满足）+ 挂在 `reply.raw` 与 stream 双方 `close`/`error` 上的**幂等 release guard**；`audioStreamCount()` 在 abort 后必须归零
- **日志卫生守卫**：判定看「捕获输出非空」（`rg` 无命中退出 1 才是通过态）；`// log-hygiene: console-ok` 豁免注释必须与 `console.` **同一行**——Biome 会把多行调用的参数换行，注释被推走就照样报红，所以多行文案先赋值给常量再单行输出
- **测试里改 env 用 `vi.stubEnv`**：Biome 拦 `delete process.env.X`，而 `= undefined` 在 Node 里会写成字符串 `'undefined'`

### M4 实测锁定（详见 `docs/plans/2026-08-05-m4-gui-base.md` §8）

- **daemon 复用判定只信鉴权 `GET /api/instance`**（M4 口径；**M6 T0 起 `/status` 另有公开 `nest_fingerprint`，见下方 M6 段**）：M4 时 `/status` 只有 pid/uptime/version，token 往返也只证明「两边各有一份同样的 token 副本」（整目录复制 nest 后依然成立）。比对 `realpath(nest_dir)` + `local_api_version`，**复用永不认领所有权**，证明不了身份的分支一律弹框中止、不 spawn、不停陌生进程
- **`contextBridge` 冻结 `window.larkAPI`**：改它的字段会**静默失败**（CDP 里覆盖 `pickMp3` → 真的弹出原生对话框）。测试要整体替换 `window.larkAPI` 对象
- **CDP 打字**：窗口不是系统焦点时 `Input.dispatchKeyEvent` 只发 `keyDown` 进不了 React，必须补 `char` + `text: '\r'`
- **pino-roll 写的是 `lark.log.1`**（不是 daemon 打印的 `lark.log`）——读日志断言要 glob `lark.log*`
- **macOS `mkdtemp` 给 `/var/…`、daemon 报 `/private/var/…`**：凡是要跟 daemon 的 `nest_dir` 比对的路径都先 `realpath`
- **`electron-vite preview` 不吃 `--remoteDebuggingPort`**（只有 `dev` 有）：验收直接用 Electron 二进制跑 build 产物
- **只读连接打开 WAL 库会造出 `-wal`/`-shm` 且关闭不删**：断言「副本无边车」必须在打开副本之前
- **两纪元不许混用**：`connectionEpoch`（每次 hello，只刷新）vs `daemonGeneration`（token 内容或 `/status.pid` 变了才递增，**只有它**能 remount 媒体元素，且换代后必须跑带失败终态的恢复状态机）
- **播放器命令共用一条串行队列**（本地点击 + 远程命令），超过 **2.5s** 才轮到的远程命令直接丢弃不 ack（daemon 3s 已回 504）
- **`has_file` 是每次请求现探的磁盘状态**：列表拿到后文件被删，GUI 仍会尝试播放并走 media error 停播；刷新后才灰显拒播

### M5 实测锁定（详见 `docs/plans/2026-08-06-m5-features.md` §8）

- **清理的删除临界区里不许有 await**：探活是 await，期间歌可能被 pin / 改 key / 重下 / 开始播放——取 file claim 后必须**重读行 + 重新 stat + 复查排除集与 per-song 流计数**，再 `unlink`，全程同一个同步段；claim 释放冻结成 `try/finally`（cache 没有 engine 的 `releaseOwner` 兜底）
- **下载完成触发的清理要 `setImmediate` 延后**：`onSucceeded` 在 `#finish` 内同步发出，此刻任务**仍持有 file claim**，立即清理会把刚下载的歌当 busy 跳过且没有补跑；同理 `onSucceeded` 是 void 回调，从里面抛错会穿透 `#finish` 把已提交的成功任务错标 failed（scheduler 必须同步不抛）
- **`config-types.ts` 的 doc 注释里不能出现 `songs/*/song.mp3`**：`*/` 提前闭合注释，Biome 报的是 parse error 而不是格式问题
- **core 测试的 `source_key` 必须像真的**（`/^BV[0-9A-Za-z]+:\d+$/`），且同一 `(provider, key)` 全库唯一——多首歌各要各的 key
- **同毫秒创建的行让「按 created_at 排序」的断言不确定**：导出的两处排序都带 `id` / `song_id` 兜底，测试要么回填 `created_at`，要么按 id 组期望值
- **导入两段式靠 SHA-256 咬合**：commit 重读文件、digest 不符即拒——`reuse[].index` 只有在字节一致时才指向用户看过的那一条
- **dnd-kit 走 legacy**（core 6.3.1 / sortable 10.0.0 / utilities 3.2.2 / modifiers 9.0.0）：新架构 `@dnd-kit/dom` 依赖 jsdom 没有的 `PointerEvent` / `IntersectionObserver` / `elementFromPoint`，每个都以**未捕获异常炸掉整个测试文件**
- **`useSortable` 默认 `attributes` 带 `role="button"`**：落在 `<tr>` 上会让 `getAllByRole('row')` 全数落空，必须 `attributes: {role: 'row'}` 覆盖
- **dnd-kit 的 `PointerSensor` activator 不看目标元素**（只判 `isPrimary` / `button===0`）：整行拖拽必须自建 activator 排除 `input/textarea/select/button/a/[contenteditable]`，否则在内联编辑框里拖选文字就会重排歌单
- **jsdom 里 `getBoundingClientRect` 恒为 0**：dnd-kit 的碰撞检测在测试里没有意义——落点判定写成纯函数单测，拖拽手感交给 CDP 验收
- **renderer 测试没有 jest-dom 匹配器**：`toHaveValue` / `toBeChecked` 报 "Invalid Chai property"，断言要读 `.value` 与 `aria-checked`；`vi.fn(() => …)` 的 `mock.calls[0][0]` 在 tsc 下是空元组，要断言入参就得给 mock 显式形参类型
- **main 项目测 `dialog-ipc.ts` 要 `vi.mock('electron')`**，且必须连 `window.ts` 顶层的 `app.on('before-quit')` 一起假掉

### M5 后续实测锁定（详见 `docs/plans/2026-08-06-m5-followup-batch-actions.md` §5）

- **lark 没有强调色**：shadcn 中性色板的 `--primary` 浅色近黑、深色近白，与正文色同值——`text-primary` 当「激活态」用是**隐形的**（正在播放的行、当前排序项、播放模式激活态三处都中招过）。状态色走独立的 `--state-active`（琥珀），不动 `--primary`（按钮/勾选框/tooltip）
- **状态色都走独立 token**：`--state-active`（琥珀 = 正在播放）与 `--state-pinned`（蓝 = 已固定）；「未激活」用 `text-muted-foreground` 而不是白色——白色在浅色主题上等于隐形
- **`<tr>` 的 border 会被 `border-collapse` 吃掉**：选中的左竖条挂在**第一个 `<td>`**上，且未选中时也留同宽透明边框，否则选中会让整行横移 2px
- **行内复选框必须 `stopPropagation`**：否则行自己的 onClick 也会触发，把多选塌成单选——正好是勾选的反面
- **表头三态复选框的语义是「当前视图内」**：搜索/歌单已经筛过一轮，全选绝不能越过视图去够整个库
- **`mkdtemp` 建的临时目录测试要自己收尾**：`dialog-ipc` 与 M3 的 fixture 各漏了一处，累计在 `/tmp` 留下 237 个目录才被发现——建目录的 `beforeEach`/`beforeAll` 必须配对 `rmSync`

### M6 实测锁定（详见 `docs/plans/2026-08-07-m6-cli.md` §8）

- **`BEGIN EXCLUSIVE` 会在锁库旁留 `-journal`**：备份自己持写锁，所以遍历 nest 时那个边车**一定在**——凡是「复制 / 比对 nest 目录」的逻辑都要按前缀排除两个锁库
- **同进程两个连接照样互斥**：SQLite 在进程内自己记 inode 锁状态，双迁移器 / 双写者的竞争能在单进程测试里真实复现
- **`/status` 的身份字段是必填的显式联合**：两个字段都合法 = M6 形，两个都缺 = pre-M6 形，**半套或畸形一律 unverifiable**（不猜）；指纹一律对 `realpathMissingOk(larkDir())` 求，fresh nest 才能和 daemon 建目录后的结果对上
- **动态 import 的 core 不能用 `instanceof`**：`--direct` 后端按 `err.name` 匹配错误类——动态 import 的模块对象与静态 import 的不是同一个
- **双后端差异要靠冒烟才看得见**：已抓到两处——路由层的 uuid 门禁（直连少了会把 `INVALID_ID` 报成 `NOT_FOUND`）、虚拟 `all` 由 daemon 拼装（直连少了会让「按名字引用歌单」随 daemon 在不在而变）
- **`search` 是 `LIKE` 子串预筛，不是判定**：`<name|id>` 解析必须在结果里再做精确匹配；SQLite 的 `LIKE` 对 ASCII 大小写不敏感，假后端写成 `includes()` 会制造不存在的 bug
- **同样是 POST，能不能省掉 body 取决于路由读不读它**：`recognize-url` 走 `objectBody`，无 body 的 POST 被判 `INVALID_BODY`（要发 `{}`）；`redownload` / `download/lyrics/:id` 不读 body，无 body 照常
- **参数形状的判定要跑在探测 daemon 之前**：否则 `lark download`（零参数）在没有 daemon 时报 `DAEMON_UNAVAILABLE`(4)，把用户支去启动一个同样会拒绝它的 daemon——`withBackend` 的 precheck 缝就是干这个的
- **「哪一行是关键词」只有 `/download/parse` 知道**：本地按「不像链接就是关键词」判 500 字上限会误杀长 URL；预检放 parse 之后仍能按行号报错（items 与行一一对应），8192 单行上限才是必须在分块之前的本地判定
- **任务滚出 ring 是 `TASK_STATE_UNKNOWN` 不是失败**：终态任务只留最近 100 条，查不到 ≠ 失败；批次各项自带终态快照，所以批次能活过它自己的任务
- **commander 把 `--no-x` 存成 `x: false`，从来不是 `noX: true`**：按声明时的名字去读，flag 静默失效——`lark play --no-launch` 因此真的开过一个 GUI 窗口。翻译写成显式函数并配回归测试
- **daemon 先写 pid 文件再 listen**，所以「pid 活着但 `/status` 不应答」是**正在启动**的正常中间态，不是陌生进程——`ensureDaemon` 对它做限时只读重探（10s）而不是当场 fail-closed
- **虚拟时钟的 `sleep` 必须 yield 宏任务**（`setImmediate`）：`Promise.resolve()` 让轮询循环一路跑到 deadline，期间 child 的 `exit` 事件（定时器）永远排不上，测出来的是「超时」而不是被测的分支
- **CLI 不能 import electron**（守卫会拦），要 Electron 二进制就读 `node_modules/electron/path.txt` 拼 `dist/`；daemon 侧用 `process.execPath` + `packages/daemon/dist/cli.js`。两处定位都在 `lib/launch.ts`——M7 已给它们补了打包分支，见下方 M7 段
- **`-o <目录>/` 里的末尾分隔符就是「这是目录」**：只用 `existsSync && isDirectory()` 判，不存在的目录会被当成文件路径——skill export 报 ENOENT，playlist export 更糟（静默写出一个以目录名命名的文件）。判定收敛在 `lib/target-path.ts` 一处
- **验收脚本里 `spawnSync` 会堵住事件循环**：进程内起的 HTTP stub 永远答不上被同步 spawn 的 CLI，五态 stub 判据会全变成「没人监听」——stub 要放子进程
- **`INVALID_ID` 在 CLI 表面不可达**：每个 id 参数都是 `<name|id>`，先过解析——uuid 形状查不到 → `NOT_FOUND`，非 uuid → 当名字搜 → 还是 `NOT_FOUND`。id 门禁仍在（直连补的那个），只是命令行走不到
- **`backupNest` 只在 daemon 停掉后能跑**（在线备份只冻结 DB），验收脚本里凡涉及备份的检查都得排在停机之后
- **管理命令（`status` / `daemon` / `stop-daemon`）不取后端**：它们说的是进程不是曲库，走后端会导致「库坏了就停不了 daemon」；`--direct` 在这一层直接拒

### M7 实测锁定（详见 `docs/plans/2026-08-08-m7-packaging.md` §8）

- **ffmpeg 是自建的，不是装来的**：`ffmpeg-static` / `@derhuerst/ffprobe-static` 的二进制 `--enable-nonfree`，**不可再分发**（连 GPL 都不行）。现在 `just fetch-ffmpeg` 从源码建最小 LGPL profile（FFmpeg + LAME，4.5MB），锁在 `vendor/ffmpeg.lock.json`。它是**发版门禁**：源码 SHA → configure 与锁值逐字节比对 → 见 nonfree 即拒 → 能力清单 → 真实 M4A→MP3→ffprobe 闭环。`just package bundled` 每次前置跑它，stub 过不了第一道（不是 Mach-O）
- **configure 串必须路径无关**（`--prefix=../out` 这类相对路径）：绝对路径会烙进二进制、`-show_program_version` 读得到，锁值就绑死在某台机器的目录上
- **媒体工具单一真相 = `ctx.mediaTools`（MediaToolsRegistry）**：capabilities / 下载引擎 / `probeAudio` / import 全部共享一份。`ensureMp3` 与 `probeAudio` **接收已解析的路径**，不许自己再找——以前各找各的，能出现「capabilities 报没有 ffmpeg，下载却通过 Homebrew 成功」。`ready` 缓存到执行失败（ENOENT/EACCES）才失效，`missing`/`incompatible` 按 ≥5s 节流重探
- **ready 判定是完整能力清单**（demuxer mov/mp3 · decoder aac/mp3 · encoder libmp3lame · muxer mp3 · file protocol · ffprobe JSON），不是 `-version` 退出 0——后者一个 shell 脚本就能过
- **ffmpeg 的清单输出**：`-hide_banner -v quiet -X` **只认第一个清单选项**（串多个只出第一个）；分隔线是 ` ---` 不是 ` --`（8.1 还多一列设备标志），按字面 `--` 匹配会把好构建判成「缺全部能力」
- **单测不能用 `-f lavfi` 造 fixture**：最小 profile 没有 lavfi 也没有 AAC 编码器。改用 `@lark/core/testing` 的 `toneWav()`（纯 Node 写 44 字节头 + 正弦），真 m4a 容器只在 `fetch-ffmpeg` 与 accept-pack 的闭环里用（入库夹具 `scripts/fixtures/tone-1s.m4a`）
- **`just package [mode]` 是位置参数**：`mode=system` 这种写法在 just 1.46.0 会被当成第二个 recipe 名（实测报 "does not contain recipe"）
- **`identity: '-'` 在 electron-builder 26.15.3 上是一等公民**（产物 `flags=0x2(adhoc)`）；owl 的 `afterPack` 钩子仍保留，幂等，不赌版本行为
- **打包后定位**：dev 与 packaged 由「能否走到 `pnpm-workspace.yaml`」一次决定。打包态所有路径来自**同一个** `resolveAppBundle()`——包内 Electron 跑包内 daemon 用包内 ffmpeg，`lark gui` 用 `open <该路径>` 而不是 `open -a Lark`（`-a` 由 LaunchServices 挑，可能挑到另一份）
- **`/usr/bin/open` 正常退出不是崩溃**：`LaunchCommand.expectsImmediateExit` + `LaunchedChild.state.exitCode`——按 dev 的「退出即崩溃」判，每一次打包态 `lark gui` 都会在窗口出现前失败
- **验收脚本必须从工作区之外跑 CLI**：仓库内跑时 `isDevCheckout()` 一路走到 `pnpm-workspace.yaml`，`LARK_APP_PATH` 被完全忽略——判据 10 会静默测成 dev 分支（踩过）
- **renderer 不能 `fetch('lark-media://…')`**：CSP 的 `connect-src` 没这个 scheme（媒体走 `media-src`）。观测 206 要么经 daemon 的 player 命令驱动 + 读日志的 `audio range` 行，要么用媒体元素
- **图标**：源图的灰光晕**不透明**，量边界要用饱和度不是 alpha；图标本该是四周有真透明留白的方块（owl 外 40px 全透明、占 90%）。`build-icons.mjs` 只做缩放，用备好的 `lark-icon-source.png`，配方写在注释里。判据：产物最外圈不透明像素 = 0
- **发版**：npm 拒绝 `npm login` 的会话凭据（要 2FA），必须用带 bypass 的 granular token；发布成功后 CDN 还会缓存 404 约 40 秒（`npm access get status` 走 API，那时已经对）。github 在本机三通其一，且 **`git push … | tail` 会吞掉退出码**（管道返回 tail 的）

### M3 实测锁定（详见 `docs/plans/2026-08-04-m3-download-pipeline.md` §7）

- **`nav` 匿名返回 envelope `code: -101`（未登录）但照给 `wbi_img`**——WBI 取 key 判定**看字段不看 code**，看 code 会在健康环境上 fail-closed
- **`fav/resource/list` 的 `ps=20` 实返 15 条 + `has_more=true`**——分页结束只能信 `has_more`，按 ps 推断会漏掉一半；`folder/created/list-all` 匿名 `data:null`（需登录，但不在链路上，media_id 来自 URL）
- **ffmpeg 输出到 `.tmp` 结尾的路径必须显式 `-f mp3`**——推不出容器时报的是「找不到合适的输出格式」，读起来像编码器问题
- ~~`ffmpeg-static` / `@derhuerst/ffprobe-static` 定版 5.3.0~~ → **M7 已移除**：两包的二进制是 `--enable-nonfree`，不可再分发。现在 ffmpeg 由 `just fetch-ffmpeg` 自建（见下方 M7 段）
- **酷狗三端点全支持 https**（Go 版两处明文 http 无必要）；`krcs.kugou.com/search` **必须带 `hash` + `duration`（毫秒）**，只给 keyword 返回空候选
- **LRC 正则不能一份带 `g` 的同时用于 `.test()` 和 `matchAll`**——`.test()` 留下的 `lastIndex` 会让下一次匹配从半路起步
- **落盘协议只承诺进程崩溃（kill -9）一致性**，不承诺断电（与 M1 同口径）；`.pending` manifest 的 `had_old` 是唯一能区分「崩在 bak 之前」（当前 song.mp3 是完好旧文件，**必须保留**）与「崩在 rename 之后」（未提交新文件，必须删）的信息
- **恢复例程结束时删掉全部 `download.commit.*` 日志行**，不只悬空的——恢复已消费掉所有 manifest，只删悬空的会让库里每次下载永久涨一行
- **`bilibili` client 全 daemon 一份（`ctx.bilibili`）**——同进程两个 client = 两份 WBI/buvid 缓存 = 对风控是两个身份
- **`closeTestContext` 已转 async**，daemon 测试全部 `afterEach` 必须 `await`；漏 await 在 fork 池下表现为句柄泄漏而非断言失败
- **`app.inject` 返回含 `void` 的交叉类型**，包一层 helper 时 `await` 不收窄，helper 必须显式标注返回类型
- **路径遍历 id（`../etc`）被路由器归一化后落到未注册路由 → 404**（不进 handler）；单段非 uuid 才是 400
- **无 scheme 的粘贴按固定前缀白名单补 `https://`**（尾斜杠是防 `bilibili.com.evil.test` 的关键）；带 `:` 的输入到不了修复分支——`new URL()` 把 `:` 前的部分当 scheme，在 https 检查处即拒
- **暂存目录先于传输存在**（同卷 rename 的前提），所以任务未提交就结束时要按「DB 无该行」删掉它；`landSongFile` 只补偿它见过的失败
- **`download:status` 带 `revision`**：`(state, stage)` 不唯一（绑定 song_id 时 stage 仍是 `resolving`）
- **M5 的按需下载加 task kind `ensure-file`**，复用 `#runDownload`；不要另抽 `resolveSongFile`

### v0.2 T0–T3 实测锁定（详见 `PROCESS.md` v0.2 段与 `docs/plans/2026-08-11-v0.2-skybridge-sync.md`）

- **sync 的两条通道不许混**：LWW put/墓碑（`create`/`update`/`delete`）带三元组、比键、**跳过自己的回声**；元数据 op（`set_lyrics`/`clear_lyrics`/`reorder`/`set_rank`）无键、只按 `server_seq` 定序、**自己的回声也要重放**——任何 rank 进 LWW 通道都会分叉（D7）
- **rank 全部离开 LWW**：拖拽 = rank-only + `set_rank`；归一化 = 一条 `reorder`（超 4000 退化逐行）；add = **成对 emit**（create 不带 rank）
- **同 `(provider,key)` 允许共存**（D8，0002 去 UNIQUE）：by-key 查找两条命中即 `AMBIGUOUS_SOURCE_KEY`，不猜
- **SQLite `json_set(payload,'$.x',?)` 把绑定数字写成 `…000.0`**（`json_type` = real）：rebase 要 `CAST(? AS INTEGER)` 写、门放宽到 `IN ('integer','real')`，否则看不见自己的产物
- **file-effect journal 的 arg 是快照**：执行器零推断（远端删除的 `audio_origin` 与 `lyrics_disposition` 都在入队事务里定）；boot **先 drain journal 再 recovery**，recovery 跳过 journal 还占着的目录
- **墓碑的 `device_id` 存 `''` 不是 NULL**（`LwwTriple` 入口就把「没有设备」归一化了）——首次注册的重打戳要同时收 NULL / `''` / 本地 uuid 三种写法
- **login 的补偿顺序冻结**：先 revoke（**仅本轮新注册的设备**）再 remote logout——logout 作废整个 token family，反序就没凭证可 revoke 了；复用的存量设备**绝不 revoke**
- **旧 session 在 install 事务之前拆**：回填与 rebase 重写未推送变更的 key，在途的一轮会推旧 key 而本地留新 key
- **一轮里吃了 401 只能 `dropSession`**，不能 `teardownSession`——后者要等在途的轮，而在途的就是自己
- **push-on-mutation 走轮询不走事件**：`emitSyncChange` 在调用方事务内（事件可能早于 COMMIT 或在回滚后存活），而挂事件总线又漏掉 backfill 与 conflict resolve 这两条只 emit 不发曲库事件的路径
- **e2e 的 server 不进依赖（T6）**：`@orpheus-aviary/skybridge-server` 是私有包，运行时按「已安装 → `LARK_SKYBRIDGE_SERVER` → 兄弟仓 `packages/server/dist/src/index.js`」解析，缺了就 skip；`just test-sync-e2e` 用 `LARK_SYNC_E2E_REQUIRED=1` 把 skip 变硬失败
- **song / playlist 的删除只与墓碑比较**（T6a 修，§3.2）：与 `max(行, 墓碑)` 比会让「编辑晚一毫秒」的设备留住别人删掉的歌，且对端有墓碑后拒绝一切 update，永久分叉；membership 仍是 LWW 可复活
- **⚡ op 在自己的回声回来之前不算稳**：一轮先拉后推，拖拽后的第一轮会重放更早的 `reorder` 把顺序拨回去，等自己的 `set_rank` 以更高 `server_seq` 回来才定；测试要跑够轮次
- **源码里别放字面 NUL**：`rebase.ts` 曾用裸 `\0` 当复合 key 分隔符，grep / rg 直接把文件当二进制**静默跳过**（本仓守卫全是 rg 写的），改用 `\u0000`
- **CLI 的归属（T5）**：`sync` 的 login/logout/run/status/file-ops 走 daemon，`unbind` 独占本地库（停 daemon + 写锁），`config-show` 只读凭证文件（无 daemon 无库也能用）；密码只有静音 prompt 或 `--password-stdin`，没有 `--password` flag
- **v1 库在 v0.2 下 `--direct` 读也要先起一次 daemon**：只读打开拒绝迁移（零写入是设计），报 `MIGRATION_PENDING`——`accept-cli` 的夹具因此在 T0 就坏了，T5 已给 harness 补上「复制后升一次级」
- **GUI 的两条口径（T4）**：徽章的「注意力计数」只算冲突与永久失败的 file op（只有人能清的两样），隔离/重复/dead-letter 只在 popover 里列；列表的「重复」标记按**当前视图**算，跨歌单的一对由 `/sync/status` 与 `lark songs --duplicates` 负责
- **CDP 驱动 Radix Tabs 要补 `mousedown`**（激活不在 click 上），且按文本找按钮必须精确匹配——明文 HTTP 复选框的 label 文案里也有「登录」，`includes` 会点到 label 把跳闸开关关掉
- **`lifecycle` mutex 把函数排进微任务**：测「登出插在 refresh 中间」必须等被测函数**真的进去**再动手，否则测到的是排队而不是交错
- **真机 soak 的两条（T6c，2026-08-12）**：**起 GUI 之后、登录之前必须用 `/api/instance` 验 `nest_dir`**——`env LARK_NEST_DIR=…` 一旦没生效，GUI 就会打开**真实曲库**，一次登录把它升到 schema v2（单向，0.1.0 从此打不开）并绑到测试账号；数据不会丢，`sync unbind --force` 能清回未绑定态 · **`resolve('local')` 会被 `SOURCE_KEY_CONFLICT` 挡下**：它走普通写路径 `updateSongInTx`，而冲突挂起期间别的设备可能把这首歌的 source key 给了另一首——apply 允许共存、本地写不允许，两条各自都对，清掉另一首的 key 再恢复即可
- **`accept-sync` 的四条（T6c）**：`--yes` 是全局 flag、`--allow-insecure-http` 是子命令 flag，**位置放反 commander 自己退 1**，与被测的拒绝长得一样 · `--json` 下 `sync unbind` 先往 stderr 打「要丢多少」再打错误信封，**取 `error_code` 要从 stderr 最后一行往回找**，别 parse 整段 · 隔离目录是 **`<song_id>-<op_uuid>`** 不是 `<song_id>` · 制造冲突/重复靠 **`sync logout` 的离线窗口**（pending 门要未推送的本地改动；同 key 共存要两端各自 `assertKeyFree` 都过），且**夹具的四首歌必须互不相同**——把「被远端删的那首」和「重复对的一半」选成同一首，删除会顺手拆掉重复对

## Commit 规范

遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 的 Conventional Commits。

Scope：`shared` / `core` / `daemon` / `gui` / `cli` / `player` / `download` / `lyrics` / `search` / `library` / `settings` / `cache` / `link` / `skybridge` / `db` / `config` / `repo`（仓库级杂项：justfile / lockfile / README / PROCESS 等）/ `plan`（`docs/plans/` 计划文档）

## 关键参考

- 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（§1 R17 已修订：ffmpeg-static 不可再分发）
- **v0.2 子计划**：`docs/plans/2026-08-11-v0.2-skybridge-sync.md`（§3 协议冻结 / §4 落点 / §5 不变量清单 ㉑–㉚ / §7 批次 / §8 决策 D1–D8）；实施记录在 `PROCESS.md`
- M7 子计划：`docs/plans/2026-08-08-m7-packaging.md`（§3.0 ffmpeg 供应链与 MediaToolsRegistry、§3.5 验收与发版、§5 决策 M7-1–M7-19、**§8 实施与发版记录**）
- M6 子计划：`docs/plans/2026-08-07-m6-cli.md`（§8 逐批实施记录 + §6 验收判据）
- M5 子计划：`docs/plans/2026-08-06-m5-features.md`；M5 后续（多选批量）：`docs/plans/2026-08-06-m5-followup-batch-actions.md`
- M0 子计划 + spike 实测结论：`docs/plans/2026-07-31-m0-scaffold-media-spike.md`（§6 是 M4 移植清单）
- 本仓设计：`docs/DESIGN.md`
- 进度：`PROCESS.md`
- 常用命令：`justfile`（`just check` / `just test` / `just dev-daemon` / `just cli <args>`（= 对外的 `lark`）/ `just accept-gui`（M4 判据 15 条）/ `just accept-m5`（M5 判据 22 条，跑真实 bilibili）/ `just accept-cli`（M6 判据 27 条，驱动真实 `lark` 二进制）/ `just test-sync-e2e`（v0.2 两套 e2e：三设备元数据 + 多进程文件）/ `just accept-sync`（v0.2 判据 34 条：真 skybridge server + 两台 daemon + 真 GUI，`--skip-e2e` 跳过前置套件）/ `just fetch-ffmpeg`（自建 vendor ffmpeg + 门禁）/ `just package [bundled|system]` / `just pack-cli` / `just accept-pack <mode> <dmg> <tgz>`（M7 判据 28 条，对着发布物本身跑）/ `just spike-media-*`）
- Go 版（功能参照）：`../lark-go/`
- 跨仓架构：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`
- skybridge 架构：`../aviary/docs/SKYBRIDGE_ARCH.md`
