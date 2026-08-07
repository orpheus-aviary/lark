# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版。从零设计，可参考 `../lark-go/` 的既有实现作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 状态

🚀 **开发中**（2026-07-16 启动）。**M0 已完成**（2026-07-31：五包骨架 + `GET /status` 垂直链路 + `lark-media://` spike 六项判据全过）；**M1 已完成**（2026-08-03：config/logger/paths + schema v1 迁移基座 + songs/playlists CRUD/稀疏 rank + Go 迁移协议全实现，副本验收对账 20/2/4；**真实库已于 2026-08-05 迁移**（20/2/4，备份 `songs.db.bak-go-<时间戳>` 留在 nest 里）；子计划：`docs/plans/2026-07-31-m1-core-data-layer.md`，决策 M1-1–M1-15 + §7 实施记录）；**M2 已完成**（2026-08-04：daemon 生命周期状态机 + PID 协议 + Bearer 鉴权 + SSE/gui 单消费者通道 + songs/playlists/audio/lyrics/player/config/capabilities 路由 + 日志卫生守卫；子计划：`docs/plans/2026-08-04-m2-daemon-routes.md`，决策 M2-1–M2-17 + §7 实施记录；用户验收通过 2026-08-04）；**M3 已完成**（2026-08-05：LLM client + bilibili/WBI + 链接规范化 + ffmpeg 封装 + 歌词三平台 + 下载队列与状态机 + R22 落盘与崩溃恢复 + daemon 十条路由与关停接线；子计划：`docs/plans/2026-08-04-m3-download-pipeline.md`，决策 M3-1–M3-14 + §7 实施记录；**T3 首日 gate GO**——fav/collection 匿名可用，`fetch-list` 保住全部范围）；**M4 已完成**（2026-08-05：Electron 宿主 spawn/确权/单实例/`lark-media://` 代理 + renderer 两纪元与 gui 会话 + 曲库/播放器/歌词/下载全套界面 + `just backup-nest` / `just accept-gui`；子计划：`docs/plans/2026-08-05-m4-gui-base.md`，决策 M4-1–M4-14 + 裁决 D1–D24 + §8 实施记录；**六项判据在正式 GUI × 真实 daemon × nest 副本上复跑 15/15**）；**M5 已完成**（2026-08-06：主题进 config + `ApiError.details` 透传 + 缓存 LRU/fail-closed 探活/`/cache` 两路由 + `ensure-file` 按需下载与 pending intent + 设置页与窗口记忆 + 链接右键三件套 + 歌单导入导出两段式 + 拖拽 reorder；子计划：`docs/plans/2026-08-06-m5-features.md`，决策 M5-1–M5-20 + §8 实施记录（含 §8.4 dnd-kit spike 定案：走 legacy）；七批提交）；**M5 后续已完成**（2026-08-07：状态色 token + 行状态四通道 + 两轴排序 + 多选与批量操作；子计划：`docs/plans/2026-08-06-m5-followup-batch-actions.md`，决策 B-1–B-12；四批提交，全仓测试 1173，`just accept-gui` 15/15 + `just accept-m5` 22/22 复跑通过）；**下一步 M6（CLI）**。主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（含决策记录 R1–R32，三轮评审定稿）；进度跟踪：`PROCESS.md`。

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
│   └── cli/        # @lark/cli — 对外 CLI（bin `lark`；发布名 @orpheus-aviary/lark-cli 待 M7 定）
├── spikes/
│   └── media-protocol/  # lark-media:// 验证工程，长期保留作 M4 移植参照
├── scripts/        # 依赖方向守卫（rg 源码，不查 package.json）
└── docs/
```

依赖方向：`shared ← core ← daemon ← gui`；`cli → shared`（HTTP backend，当前唯一）+ `core`（`--direct`，M6 起）。三条守卫进 `just check`：core 禁 daemon/gui/electron、daemon 禁 gui/electron、shared 禁一切 Node builtin（`node:` 前缀与裸名都拦）。

**已决定**（主计划 §1）：不抽 `@orpheus-aviary/daemon-kit`，v0.1 直接复制 owl 模式，出现明显重复再重构。

## 注意事项

- **daemon 统一入口**：CLI 和 GUI 都通过 daemon HTTP API（默认端口 **47100**，端口段 `471xx` 归 lark）；daemon 存活时 CLI **一律禁止 `--direct` 写**（无 `--force`，R31）
- **数据目录**：`~/orpheus-aviary-nest/lark/`
- **统一响应格式**：`{"success": bool, "data": {}, "message": "..."}`；例外：`/audio`（二进制 + Range）、`/lyrics`（text/plain）、`/events`（SSE）
- **token**：由 daemon 生成并原子发布 0600 文件；GUI 侧每次读取，不进 URL/DOM/日志/媒体 src（R21/R29）
- **skybridge 预留**：v0.1 建 sync 三表**不写事件**；实体 `device_id` 仅存 skybridge 注册 ID（本地身份在 `local_metadata.device_uuid`，两域不混用）；v0.2 冻结协议后全量回填（R2/R18）
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

- **daemon 复用判定只信鉴权 `GET /api/instance`**：`/status` 只有 pid/uptime/version，token 往返也只证明「两边各有一份同样的 token 副本」（整目录复制 nest 后依然成立）。比对 `realpath(nest_dir)` + `local_api_version`，**复用永不认领所有权**，证明不了身份的分支一律弹框中止、不 spawn、不停陌生进程
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
- **`<tr>` 的 border 会被 `border-collapse` 吃掉**：选中的左竖条挂在**第一个 `<td>`**上，且未选中时也留同宽透明边框，否则选中会让整行横移 2px
- **行内复选框必须 `stopPropagation`**：否则行自己的 onClick 也会触发，把多选塌成单选——正好是勾选的反面
- **表头三态复选框的语义是「当前视图内」**：搜索/歌单已经筛过一轮，全选绝不能越过视图去够整个库
- **`mkdtemp` 建的临时目录测试要自己收尾**：`dialog-ipc` 与 M3 的 fixture 各漏了一处，累计在 `/tmp` 留下 237 个目录才被发现——建目录的 `beforeEach`/`beforeAll` 必须配对 `rmSync`

### M3 实测锁定（详见 `docs/plans/2026-08-04-m3-download-pipeline.md` §7）

- **`nav` 匿名返回 envelope `code: -101`（未登录）但照给 `wbi_img`**——WBI 取 key 判定**看字段不看 code**，看 code 会在健康环境上 fail-closed
- **`fav/resource/list` 的 `ps=20` 实返 15 条 + `has_more=true`**——分页结束只能信 `has_more`，按 ps 推断会漏掉一半；`folder/created/list-all` 匿名 `data:null`（需登录，但不在链路上，media_id 来自 URL）
- **ffmpeg 输出到 `.tmp` 结尾的路径必须显式 `-f mp3`**——推不出容器时报的是「找不到合适的输出格式」，读起来像编码器问题
- **`ffmpeg-static` / `@derhuerst/ffprobe-static` 定版 5.3.0**（实测 arm64 / ffmpeg 6.0）；两包是 CJS `module.exports = <路径>` 但 `.d.ts` 写 `export default`，NodeNext 下默认导入被当成模块命名空间，**需在导入边界一次性重标类型**
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

## Commit 规范

遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 的 Conventional Commits。

Scope：`shared` / `core` / `daemon` / `gui` / `cli` / `player` / `download` / `lyrics` / `search` / `library` / `settings` / `cache` / `link` / `skybridge` / `db` / `config` / `repo`（仓库级杂项：justfile / lockfile / README / PROCESS 等）/ `plan`（`docs/plans/` 计划文档）

## 关键参考

- 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`
- M5 子计划：`docs/plans/2026-08-06-m5-features.md`；M5 后续（多选批量）：`docs/plans/2026-08-06-m5-followup-batch-actions.md`
- M0 子计划 + spike 实测结论：`docs/plans/2026-07-31-m0-scaffold-media-spike.md`（§6 是 M4 移植清单）
- 本仓设计：`docs/DESIGN.md`
- 进度：`PROCESS.md`
- 常用命令：`justfile`（`just check` / `just test` / `just dev-daemon` / `just cli <args>` / `just accept-gui`（M4 判据 15 条）/ `just accept-m5`（M5 判据 22 条，跑真实 bilibili）/ `just spike-media-*`）
- Go 版（功能参照）：`../lark-go/`
- 跨仓架构：`../aviary/docs/DESIGN.md`、`../aviary/docs/ROADMAP.md`
- skybridge 架构：`../aviary/docs/SKYBRIDGE_ARCH.md`
