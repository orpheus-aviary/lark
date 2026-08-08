# lark TS 重写进度跟踪

> 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（2026-07-16 定稿，同日三轮评审修订 R1–R32）

## v0.1 本地全功能

- [x] **M0 脚手架 + 媒体 spike**（2026-07-31）— pnpm workspace、tsconfig.base、Biome、justfile、五包骨架、信封 helper、`GET /status` 端到端、lark-media:// Electron spike（Range/206/seek/CSP/token 轮换）｜子计划：`docs/plans/2026-07-31-m0-scaffold-media-spike.md`
  - spike 结论：**六项判据全过（Electron 43.2.0），不启用签名 URL fallback，主计划 §2.4 维持**；判据 4 标准按实测修订（Chromium multibuffer 保留约 6 条 range 连接，改判「有上界且不随 seek 增长」），M4 移植清单见子计划 §6.3
  - 用户验收四项全过（2026-07-31）：`curl /status` · `just cli status` · GUI dev/build 两态显示在线且 console 无 CSP/CORS 报错 · spike 演示（播放出声 → 跳 90% 出成比例新 Range → **重启 server 换 token 后免刷新继续 seek，日志见 gen 45 `auth=ok`**）
- [x] **M1 core 数据层**（2026-08-03）— config/logger/paths（0600 原子写 + 存量 0644 收紧 + aviary 空串回退 + redact 白名单投影）、schema v1 全量 DDL + migration runner（同事务 stamp + destructive marker）+ M1-10 恢复状态机 + SQLite `BEGIN EXCLUSIVE` 迁移锁、device_uuid、songs/playlists CRUD（`…InTx` 两层 + 本地字段独立路径 + 稀疏 rank/同事务归一化 + reorder 锚点契约）、Go 迁移协议全实现（`just migrate-go`）、daemon logger 置换为 core pino/pino-roll（M0 遗留两条全清）｜子计划：`docs/plans/2026-07-31-m1-core-data-layer.md`（§7 实施记录含版本定案与副本演示结果）
  - 版本定案：better-sqlite3 12.11.1 / drizzle-orm 0.38.4 / pino 9.14.0 / pino-roll 2.2.0 / smol-toml 1.6.1 / @electron/rebuild 4.2.0；`process.versions.modules`：Node 24.13.0 = **137**、Electron 43.2.0 = **148**（双向真值探测复核；ABI recipes 已接线，`ensure-electron-abi` M4 才接线）
  - 副本演示（真实 nest 副本，2026-08-03）：对账 20 songs / 2 playlists / 4 memberships（源 20/3/24，all 丢弃）、幂等重跑 already-migrated、sqlite3 抽查全过（rank 严格递增 / imported / device_id NULL / `+08:00` 换算正确）
  - **真实库已迁移**（2026-08-05，用户确认）：`just migrate-go` 对账 20/2/4，备份 `songs.db.bak-go-2026-08-05T06-30-04-788Z` 留在 nest 里（**用户已表示 Go 版大概率不再使用**，一份备份即可）。迁移前预检：DB 行与歌曲目录 1:1、20 个目录全有 `song.mp3` 与 `lyrics.lrc`、无孤儿无残留。迁移后 M3 daemon 启动恢复例程报告**全 0**、`trash/` 空、`/audio` 206 与 `/lyrics` 对真实文件正常
  - **Go 版 songs 表没有任何来源字段**（`id/name/artist/created_at/lyrics_offset/duration`），所以迁来的 20 首 `source_key` 全为 NULL：redownload 需 LLM 重新识别；它们是 `file_origin='imported'`，**永不参与缓存清理**（R1）；补链接走 `recognize-url` + `PUT /songs/:id`
  - 用户验收通过（2026-08-03）：① `just check` / `just test` 全绿 + ABI 双向自愈（Electron 148 ↔ Node 137）② 副本 `just migrate-go` 对账 20/2/4 → 幂等重跑 → sqlite3 抽查 ③ config 演示（0644→0600 收紧、api_format 兜底 `'openai'`、Public 投影无 api_key）④ daemon 起动 `logs/lark.log` 出结构化 pino 行、终端保留 listen 提示
- [x] **M2 daemon 基础路由**（2026-08-04）— 生命周期（PID 协议 + 状态机 first-wins + teardown/shutdown/abortBoot/requestFatal + `stop-daemon` 确权等待）、全接口 Bearer 鉴权 + Host 检查 + errorHandler 三分类、EventsBus + `/events` SSE + gui 注册/单消费者/409 恢复协议、songs/playlists（虚拟 all）/audio（Range 三义务）/lyrics/player（命令 ack 四分支）/config（clone→save→swap）/capabilities（双向覆盖守卫）、日志卫生守卫｜子计划：`docs/plans/2026-08-04-m2-daemon-routes.md`（§7 实施记录含 8 项修订与实测锁定）
  - `/audio` 三条硬义务（M0 spike 实测，见 M0 子计划 §6.2）：尊重 backpressure、按「单曲并存约 6 条 range 流」预算 fd、响应 `close`/`error` 一次性清理；**不要用「按块封顶 206」**（实测把媒体元素打进 `MEDIA_ERR_NETWORK`）
  - 实施定案：批次改为 T1+T3+T4+T2 / T5 / T6+T7 / T8+T9（boot 依赖 guiChannel，T4 必须先落地才保证每个 commit 可编译）；boot 测试注入走 `BootOptions` 形参、env 只由 `testing/boot-child.ts` 读；`just test-core`/`test-cli` 也补 build 前置（dist 消费 shared）；新增 `@lark/core/testing` 子路径（Go 库夹具）
  - 测试规模：shared 23 / core 131 / daemon 223 / cli 3，含 7 个子进程生命周期用例（真实 exit code / 信号与 listen 并发 / requestFatal 真实退出）与 capabilities 双向覆盖守卫
  - 用户验收通过（2026-08-04，副本 nest）：生命周期往返（token 轮换 / 第二实例拒启 / 停机后 pid 消失 token 保留 / GUI 收 409 后自动重注册）· CRUD + SSE 事件流 + 虚拟 all 只读 · player 单消费者接管（命令只落到最新 GUI）· `/audio` 真实 mp3 的 200/206/416 头部契约与字节一致 · config 脱敏与非法值 400。**「未知键保留」现场未验**（脚本注入时机早于 daemon 加载），由单测覆盖；语义澄清见子计划 §7.3
  - 验收产出：补了 `/audio` 多块流字节精确回归（原用例最大 body 4096 字节，截断可完全逃过测试）；三处「红」经查均为验收脚本自身问题（BSD `cmp -n` 的 EOF 语义 / 嵌套 `$()` 转义引号 / 未知键注入时机）
- [x] **M3 下载管线 + 链接路由**（2026-08-05）— LLM client（openai/anthropic 双格式 + aviary 回退 + 任务级快照）、bilibili client（WBI 签名 search + 免签 pagelist/view/playurl/fav/collection + 风控分型）、链接识别与联网规范化（结构化 host 校验 + b23 一跳 + p→cid + 越界报错）、ffmpeg/ffprobe 封装（三级路径解析 + 可取消 + maxBuffer）、歌词三平台（全 https + 冻结启发式降级 + LLM 精选）、单 worker 队列（state/stage/revision 状态机 + batch 快照 + claim 冲突表 + 去重键 auto/显式分离 + 容量 + 全请求原子）、R22 落盘协议 + manifest(mode/had_old) + DB 事务内恢复日志 + 启动恢复七形态、daemon 十条路由 + PUT 四分支 + import + 关停接线｜子计划：`docs/plans/2026-08-04-m3-download-pipeline.md`（五轮评审修订 17+15+13+12+10 项；§7 实施记录含 gate 结果、8 项实施修订、5 个测试逼出的缺陷、实测锁定）
  - **T3 首日 gate（2026-08-05）：GO** — `just probe-bilibili` 11/11 全过。fav（`folder/info` + `resource/list`）与 collection（`seasons_archives_list`）**匿名可用**，`fetch-list` 保住全部范围；裸 `search/type` 如期被风控拦截，WBI 仍是必需
  - 实测锁定：`nav` 匿名返回 code **-101 但照给 wbi_img**（判定看字段不看 code）· `fav/resource/list` 的 `ps=20` **实返 15 条 + has_more=true**（分页只能信 has_more）· ffmpeg 输出到 `.tmp` 路径**必须 `-f mp3`** · 酷狗 `krcs` 必须带 hash + duration(ms) · 两个 static 包实测 arm64 / ffmpeg 6.0
  - 实施修订：engine 拆四文件（超 800 行硬线）· lyrics 增 `lrc.ts`/`shared.ts` · 不导出独立 `resolveSongFile`（决策树在引擎下载路径里，避免第二份 claim+落盘编排）· bilibili client 收敛成 `ctx.bilibili` 一份（两份 = 对风控两个身份）· import 复用 `landSongFile`
  - 测试规模：shared 35 / core 362 / daemon 283 / cli 3；`closeTestContext` 转 async，全部既有 `afterEach` 已跟改
  - M2 欠账已全部结清：`POST /songs/import` · `PUT /songs/:id` 的联网规范化 · `POST /download/lyrics/:id` · `download:status` 的合并（去重键 `(state, stage, revision)`，engine 侧合并而非 SSE 限频）
  - 用户验收通过（2026-08-05，副本 nest + 真实网络）：八项全过。②`source_key` 回写 + 206 字节精确 + 歌词自动派生 · ③关键词经 DeepSeek 清洗成「温柔/五月天」· ④**无 LLM 单 P 下载成功且 LLM 端点零调用**，多 P 无 `?p=` 同步 400 并报出真实分P数，`?p=3` 成功 · ⑦伪装成 .mp3 的 AAC 被容器检查挡下 · ⑧batch 建真歌单 + 终态快照 + 1001 条整请求拒。子计划 §7.5
  - 验收产出：修了三处缺陷（取消/失败的新歌下载留空目录 · import 失败文案暴露内部暂存路径 · 同一 stage 重复上报）；一处「903/953」经查是 bilibili 过滤失效条目，原行为正确
  - 验收后裁决（子计划 §7.6）：`resolveSongFile` 不抽，M5 加 task kind `ensure-file` · 无 scheme 链接按固定前缀白名单补 `https://` · `download:status` 加 `revision` · fetch-list 上限提到 200 页/5000 条 · ID3 与 av 号都不做（保持 Go 版行为）· 无 LLM 歌词启发式暂不调
- [x] **M4 GUI 基座**（2026-08-05）— Electron 宿主（spawn/确权/所有权卫生、单实例带 nest 身份、`lark-media://` 代理、token 链路）+ renderer 基座（两纪元、gui 会话与 409 恢复、lane 化 supersede、Tailwind v4 + shadcn 双态主题）+ 曲库视图 + 播放器与远程命令 + 下载栏/批量弹窗/本地导入 + 验收工具（`just backup-nest` / `just accept-gui`）
  - 子计划 `docs/plans/2026-08-05-m4-gui-base.md`（决策 M4-1–M4-14 + 差异裁决 D1–D24 + §8 实施记录）；六批提交，全仓测试 936（gui 201）
  - **六项判据在正式 GUI（build 产物）× 真实 daemon × nest 副本上复跑通过**（`just accept-gui`，15/15）：协议注册 / Range 透传 / 206+416 / seek 风暴流上界 / 生产 CSP 零 violation 且 token 不在 DOM / 重启 daemon 轮换 token 后免刷新续播；外加 GUI 退出后远程命令 409 `GUI_OFFLINE`。**Electron 升大版本必须重跑这条**
  - **daemon 侧两处增量**：鉴权 `GET /api/instance`（复用判定的唯一身份来源）+ 仅验收模式可开的两个缝（`/audio` 限速、`GET /debug/audio-streams`；正常模式 404 有守卫测试）
  - 实测坑（详见子计划 §8.2）：`contextBridge` 冻结 `larkAPI`（原生对话框驱动不了，只能注入假 picker）· CDP 打字要补 `char` + `text:'\r'` · pino-roll 写 `lark.log.1` · macOS `/var` vs `/private/var` 要 realpath · `electron-vite preview` 不吃 `--remoteDebuggingPort` · shared `ImportSongsRequest` 字段名从 `paths` 改回 `file_paths`
  - **用户验收通过（2026-08-06）**：出声、窗口行为（红叉隐藏 / Cmd+Q 退出）、观感、导入与删除均无问题；提了三条补充，两条当场修（`a9896ed`）、一条归 M5
  - 验收后修正（`a9896ed`）：① 列宽拖拽改访达式——分隔条只改左侧那一列，右侧整体平移、尾列吸收，吸不下才整表横向滚动（原实现是「未拖过的列平分剩余宽度」，拖一列会挤压邻居）；② 底部歌词区从 `min-h-14` 改固定 `h-20` 且当前行字号封顶、下载状态行改常驻占位——这两处高度会变，而曲库列表是吸收剩余高度的 flex 子元素，一变整张表就跳
- [x] **M5 新特性 + 对应路由**（2026-08-06）— 设置页（含缓存区块 + 记住窗口大小）、主题进 config、缓存上限 + LRU + fail-closed 探活 + 固定 + `/cache` 两路由、按需下载（task kind `ensure-file` + pending intent）、链接右键三件套 + 编辑对话框、歌单导入导出（两段式 + 疑似重复 UI）、拖拽 reorder
  - 子计划 `docs/plans/2026-08-06-m5-features.md`（决策 M5-1–M5-20 + §8 实施记录与 T6/T7 偏差 + §8.4 dnd-kit spike 记录）；七批提交，全仓测试 1128（shared 74 / core 426 / daemon 341 / gui 284 / cli 3）
  - **验收自跑（2026-08-06）**：`just accept-m5` **22/22**（新 recipe，真实 daemon × nest 副本 × 真实 bilibili：下载→资格分账→只删 downloaded 那一首/20 首 imported 全活→ensure-file 取回→lease 跨 drain→死 key fail-closed→导入导出 round-trip→`IMPORT_SOURCE_CHANGED`→链接 409 带 id→window 落盘 0600）；`just accept-gui` **15/15** 复跑。剩用户手动：设置页观感、主题三态、右键手感、拖拽手感、按需下载出声
  - **T7 选型 gate（2026-08-06 实跑）**：dnd-kit **走 legacy**（core 6.3.1 / sortable 10.0.0 / utilities 3.2.2 / modifiers 9.0.0）。两侧在 React 19.2.4 + StrictMode 下都干净、都能被 Radix `asChild` 合并 ref；`@dnd-kit/react` 0.5.0 输在**对现有测试套件的代价**——`@dnd-kit/dom` 要 jsdom 没有的 `PointerEvent` / `IntersectionObserver` / `elementFromPoint`，且各以未捕获异常炸掉整个测试文件，还异步改写 `role="button"` 无逃生门
  - **设置页（用户 2026-08-06 定案）**：左上角入口；编辑 `PATCH /config` 白名单已有的 `llm`（api_key 只能覆盖不能回显——`GET /config` 按 R14 只回 `has_api_key`）、`font`、`log`、`storage.cache_limit_mb`、`window`（并顺带做「记住窗口大小」，M4 只读不回写）
  - **主题进 config**：新增 `[theme] mode = "system" | "light" | "dark"`（daemon 侧 config 类型 + 默认值 + PATCH 白名单 + 测试）。冻结线：**外观（主题/字号）进 config，视图态（排序/列显隐/列宽/播放模式）留 localStorage**，别长出第三个家
  - **设置页与缓存上限同批**：`storage.cache_limit_mb` 现在写得进去但没人执行，LRU 清理落地前它是个假旋钮
  - M3 定的接法：「播放无文件歌曲 → 自动下载」加 task kind **`ensure-file`**，复用 engine 的 `#runDownload`，只改 `needsFile` 判定；**不要**另抽 `resolveSongFile`（会产生第二份 claim + 落盘编排）。互斥读 `downloads.claims` 与 `pendingSongIds()`
- [x] **M5 后续：观感修正 + 多选批量操作**（2026-08-07）— 子计划 `docs/plans/2026-08-06-m5-followup-batch-actions.md`（决策 B-1–B-12 + §5 实施记录）；四批提交，全仓测试 1173（gui 329）
  - **发现：lark 一直没有强调色**——`--primary` 在浅色下近黑、深色下近白，等于正文色，于是三处「激活态」全是隐形的（正在播放的行、排序下拉的当前项、播放模式按钮）。加 `--state-active`（琥珀）只管状态，`--primary` 不动
  - 行状态四通道互不打架：**琥珀 = 正在播放 · 左侧 2px 竖条 = 选中（owl 同款）· 加粗 = 已固定 · 红字 `[需要下载]` = 无文件**；竖条挂在第一个单元格（`<tr>` 边框会被 border-collapse 吃掉），常驻 2px 不抖
  - 排序改两轴：下拉选字段（默认/歌名/歌手/**时长**/**创建时间**），左半按钮切升降序（默认态置灰）——五字段若沿用 Go 的点击循环会变成九态
  - 多选：36px 复选框列 + 表头三态（语义是**当前视图内**）+ Cmd/Shift 点选 + Esc 清空（让位对话框）+ 右键 Finder 规则；批量操作条常驻在下载状态行右端（固定高度 28px，与下载状态共存，无选区时整组灰显），五个动作，添加到歌单一次请求、其余 N 次串行且部分失败如实汇报
  - **用户手感验收后再修一轮（2026-08-07，子计划 §6）**：批量条改真按钮并常驻右端灰显（推翻 B-5 的二选一）、行内按钮常驻放大、固定改行内蓝色图钉按钮（去掉「加粗=已固定」）、排序控件移进输入行让状态行铺满
  - **验收复跑**：`just accept-gui` 15/15、`just accept-m5` 22/22。期间修正 accept-m5 一处**过度指定的断言**（写死「只有一首可清理」，而真实库里用户重下过的歌同样是 `downloaded`、同样可清理——改断不变量）
- [x] **M6 CLI**（2026-08-08 完成）— 子计划 `docs/plans/2026-08-07-m6-cli.md`（六轮评审，决策 M6-1–M6-23，§8 逐批实施记录）；八批提交，全仓测试 1622，**`just accept-cli` 27/27**
  - [x] **T0 地基**（`03ae963` / `3262f55` / `0275032` / `5527bf0`）— 跨进程 writer lock + 四方接线（boot 锁序冻结、migrate-go 锁内权威重判、backupNest 复制前取锁）；`/status` 公开 `nest_fingerprint` + `local_api_version`（`LOCAL_API_VERSION` 下沉 shared 并 2→3）；`openDatabaseReadonly` 零写入只读开库 + `loadConfigReadonly`；`@lark/core/daemon-control`（pid 只读探测 / 五步 stop 协议 / 指纹）与 `native-probe`；错误码两注册表 + daemon `STATUS_BY_CODE` 穷尽类型化
  - [x] **T1 CLI 基建**（`0a6b04f`）— 身份五态（线格式显式联合 + pid 咬合）、`decideMode` 五态矩阵、`EXIT_MAP` 穷尽（七档退出码）、输出契约（`--json` 下 exit 0 ⇔ stdout 一条信封）、token 每次现读、confirm 三规则、守卫 `cli-no-daemon-gui`
  - [x] **T2 songs + playlist**（`26a2097`）— 两组命令走 HTTP、`<name|id>` 解析（歧义列候选不代选）、破坏性命令确认、导出原子写 / 导入两段式 digest；`sanitizeFileName` 下沉 shared 与 GUI 共用
  - [x] **T3 `--direct` 后端 + cache 组**（`5bb2514`）— 读只读开库不取锁 / 写持写锁、§4.1 适配矩阵、错误按类名映射（动态 import 下 instanceof 不可靠）；冒烟抓到并修掉两处双后端差异（uuid 门禁、虚拟 all）
  - [x] **T4 download / url / lyrics**（`11a65ae`）— 三种形状由 `/download/parse` 判定（单条 / 收藏夹合集 / 多行）、逐行预检与分块、batch 确认协议、`--wait` 两路轮询（任务滚出 ring → `TASK_STATE_UNKNOWN` 而非「失败」）、失败终态三码带快照；`songs url get/set/recognize --save`、`lyrics redownload/delete`。参数形状判定前移到探测 daemon 之前（零参数是 exit 2 不是 exit 4）
  - [x] **T5 play / now-playing / gui / daemon / stop-daemon** — `ensureDaemon` 统一入口（只有 absent 能 spawn、pid 咬合确权、活 PID 限时重探、败方回收后复验胜者、SIGTERM→SIGKILL 双段硬截止）+ `stdio:'ignore'` 让父进程能立刻退出 + `--no-launch` 零 spawn + stop 五态矩阵（incompatible 允许停）+ 管理命令不取后端且拒 `--direct`。冒烟抓到 `--no-launch` 读错 commander 的存名而真的开了窗口
  - [x] **T6 skill export** — 文档按「触发词 → 输出契约 → 退出码 → 命令 → 给 agent 的规矩」排；契约测试八条，其中一条从 `index.ts` 扫命令字面量与文档双向对齐；原子写（`.lark-skill.md.tmp-` 前缀，备份全深度排除，T0 已就位）；冒烟抓到 `-o <目录>/` 两处同源缺陷（skill export 报 ENOENT、**playlist export 静默写出一个以目录名命名的文件**），抽 `lib/target-path.ts` 一份实现修掉
  - [x] **T7 `just accept-cli` + 文档收尾** — 27 条检查全过（身份五态含子进程 stub、R31 与写锁、fresh nest 初始化、零写入整树比对、双后端对拍、真实收藏夹批量下载、demo-gui-sim 三种应答、skill × backup 交错）；跑之前抓到 **fresh nest 上 `--direct` 写没 mkdir** 的真缺陷；如实收窄「`INVALID_ID` 在 CLI 表面不可达」。归用户手动：ABI 失配 exit 3、GUI 冷启动出声、skill 的 agent 可用性（M7）
- [ ] **M7 打包发布 v0.1.0** — electron-builder mac arm64（asar:false）、ffmpeg-static/ffprobe-static 锁版本 + 打包后冒烟测试、FFmpeg 许可交付、ABI recipes、验收清单

## 后续

- [ ] **v0.2 skybridge 接入** — 开工前 design doc 冻结 sync v1 协议（payload/墓碑/LWW 三元组/全量 create-op 回填）
- [ ] **v0.3+ 移动版设计 doc**
- [ ] **跨仓待办**：更新 `aviary/docs/ROADMAP.md`（lark 已启动，主线图示与文字条件不一致以文字为准）

## 决策记录

- 2026-07-16（用户确认）：统一缓存模型 / mp3 + 打包 ffmpeg / 导入按需下载 / 仅 macOS arm64 / 端口 47100（`470xx` 归 owl、`471xx` 归 lark）
- 2026-07-16（计划内定）：SSE 替代 WS、JSON 导出、Go DB 迁移、不抽 daemon-kit
- 2026-07-16（一轮评审修订 R1–R17，详见主计划 §1）：file_origin 清理不变量（导入文件永不自动清理）、v0.1 不写 sync 事件 + v0.2 全量回填、all 虚拟化、owl 式迁移协议、lark-media:// 媒体鉴权、recognize 纯预览、稀疏 rank、provider key 身份、原子落盘、UUID 强校验 + openExternal 仅 http/https、SSE 在线判定 + 命令 ack、导入去重只认 key、单账户单资料库、PATCH /config、信封例外、LLM 降级路径、asar:false + ffmpeg 锁版本 + GPL 许可交付
- 2026-07-16（二轮评审修订 R18–R28，详见主计划 §1）：身份域拆分（实体 device_id 仅存 skybridge 注册 ID、本地身份在 local_metadata.device_uuid）、playlist_songs 补 lww_counter + created_at 同步不可变、DB 级排他迁移（.migrate.lock + EXCLUSIVE + backup API + swap 回滚）、token 模型对齐 owl + M0 媒体 spike、全写路径原子化（导入/删除/歌词）、schema CHECK + provider key 唯一索引、虚拟 all 只读语义、CLI 歧义报错、清理前联网探活 fail-closed + 不可回收上报、导入单事务/上限/版本校验、维持 ad-hoc 签名
- 2026-07-31（M0 实测定案）：Electron 锁 **43.2.0**（owl 的 34 已 EOL，取最新受支持大版本），全依赖精确锁版 + 提交 lockfile；transport 仅 GET 默认重试（M0-7）；renderer CSP 单一来源 = Vite 插件（`order: 'post'`，dev 额外放宽 `script-src 'unsafe-inline'`，因 React Fast Refresh preamble 是内联 script）；Electron ESM main 不得顶层 await `app.whenReady()`；**vite 用 `pnpm.overrides` 钉 7.3.6**——只锁直接依赖挡不住传递范围把 vite 抬到 8，而 electron-vite 5 peer 只到 7，失效方式是静默的（build 仍「成功」但 electron 被打进 main bundle）
- 2026-07-16（三轮评审修订 R29–R32，详见主计划 §1）：token 归 daemon 生成原子发布（main 只传路径、每次重读适应轮换）、source_key 改 `bvid:cid`（p 是位置非身份，规范化时解析 p→cid）、取消 --force（daemon 存活一律禁 direct 写，推翻二轮限权方案）、v0.2 必审清单补三项（同 key 跨设备合并 / HLC rebase / rank 归一化同步语义）；同步更新 CLAUDE.md / AGENTS.md / DESIGN.md 过期表述
- 2026-08-05（M3 实测定案）：bilibili fav/collection **匿名可用**（T3 gate GO，`fetch-list` 保住全部范围）；`nav` 匿名 code -101 但携 `wbi_img`（判定看字段）；`fav/resource/list` 短页 + `has_more` 才是分页真值；ffmpeg 输出到 `.tmp` 必须 `-f mp3`；酷狗三端点全支持 https（Go 的两处明文 http 无必要），`krcs` 必须带 hash + duration(ms)；`ffmpeg-static` / `@derhuerst/ffprobe-static` 定版 **5.3.0**（实测 arm64 / ffmpeg 6.0，两包 `.d.ts` 的 `export default` 与 CJS 实际导出不符，需在导入边界重标类型）；engine 按 800 行硬线拆四文件；bilibili client 全 daemon 一份（`ctx.bilibili`）
- 2026-08-07（M5 后续定案）：**lark 引入独立状态色 `--state-active`（琥珀），`--primary` 不动**——shadcn 中性色板里 `--primary` 与正文同色，`text-primary` 当激活态用一直是隐形的（正在播放 / 当前排序 / 播放模式三处）；行状态定为四通道（琥珀=播放中 · 左竖条=选中 · **蓝色图钉按钮**=已固定 · `[需要下载]`=无文件；行内按钮常驻不悬浮），竖条挂第一个 `<td>`（`<tr>` 的 border 会被 border-collapse 吃掉）；排序改两轴（下拉选字段 / 按钮切方向），补 `时长` 与 `创建时间`；多选选区是**有序 id 列表 + 锚点**，表头三态语义限「当前视图内」，批量删除/移除/固定 N 次串行、添加到歌单一次请求，部分失败如实汇报；右键在选区内一律按批量走（否则「选三首删一首」）
- 2026-08-06（M5 实测定案）：`[theme] mode` 进 config，冻结「外观进 config、视图态留 localStorage」；缓存删除临界区 = **file claim + 重读行 + 重新 stat + 复查排除集/流计数，与 unlink 之间零 await**（探活是 await，期间一切可变）；下载完成触发的清理必须 `setImmediate` 延后到 claim 释放之后，否则永远清不掉刚下载的歌；`ensure-file` 成功授予 **60s lease**，跨 drain 保护到 `/audio` 真正开流；导入两段式靠 **SHA-256** 咬合（`reuse[].index` 只在字节一致时有意义），`(provider,key)` 命中优先级高于任何 reuse 指令；dnd-kit **走 legacy**（新架构 `@dnd-kit/dom` 依赖 jsdom 缺失的三个浏览器 API，且以未捕获异常炸整个测试文件），整行拖拽必须自建 activator 排除 input/button，`useSortable` 默认 `role="button"` 会毁掉 `<tr>` 的表格语义
- 2026-08-03（M1 实测定案）：better-sqlite3 定版 **12.11.1**（`process.versions.modules`：Node 137 / Electron 148，双运行时真值探测复核）；迁移锁弃 O_EXCL + pid 改 **SQLite `BEGIN EXCLUSIVE` 常驻锁库**（内核 advisory lock，kill -9 自动释放，锁文件永不删——主计划 §3.3 step 1 已标注修订）；createDatabase 三条拒绝路径判定前零写入（`journal_mode=WAL` 后移，字节级断言）；loadConfig 对存量 0644 强制收紧 0600；migrate-go 源库排他 = 真实读 + **同值写升级**双步（纯读拿不到 EXCLUSIVE 也探不到 RESERVED 写事务）；47020 探活带 `httpProbe` 开关（机器全局端口，测试关闭）；scope 字典补 `repo` / `plan`（用户确认）
