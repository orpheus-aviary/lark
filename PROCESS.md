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
  - [x] **T5 play / now-playing / gui / daemon / stop-daemon**（`ef27588`）— `ensureDaemon` 统一入口（只有 absent 能 spawn、pid 咬合确权、活 PID 限时重探、败方回收后复验胜者、SIGTERM→SIGKILL 双段硬截止）+ `stdio:'ignore'` 让父进程能立刻退出 + `--no-launch` 零 spawn + stop 五态矩阵（incompatible 允许停）+ 管理命令不取后端且拒 `--direct`。冒烟抓到 `--no-launch` 读错 commander 的存名而真的开了窗口
  - [x] **T6 skill export**（`21cc2ee`）— 文档按「触发词 → 输出契约 → 退出码 → 命令 → 给 agent 的规矩」排；契约测试八条，其中一条从 `index.ts` 扫命令字面量与文档双向对齐；原子写（`.lark-skill.md.tmp-` 前缀，备份全深度排除，T0 已就位）；冒烟抓到 `-o <目录>/` 两处同源缺陷（skill export 报 ENOENT、**playlist export 静默写出一个以目录名命名的文件**），抽 `lib/target-path.ts` 一份实现修掉
  - [x] **T7 `just accept-cli` + 文档收尾**（`fc05c96`）— 27 条检查全过（身份五态含子进程 stub、R31 与写锁、fresh nest 初始化、零写入整树比对、双后端对拍、真实收藏夹批量下载、demo-gui-sim 三种应答、skill × backup 交错）；跑之前抓到 **fresh nest 上 `--direct` 写没 mkdir** 的真缺陷；如实收窄「`INVALID_ID` 在 CLI 表面不可达」。归用户手动：ABI 失配 exit 3、GUI 冷启动出声、skill 的 agent 可用性（M7）
- [x] **M7 打包发布 v0.1.0**（2026-08-10 已上线） — 子计划 `docs/plans/2026-08-08-m7-packaging.md`（六轮评审定稿，决策 M7-1–M7-19；批次顺序 **T0 → T3(spike) → T1 → T2 → T4 → T5**）
  - **ffmpeg 供应链重建（T0，推翻原「ffmpeg-static 锁版本」路线）**：现二进制 `--enable-nonfree` **不可再分发**（实证 2026-08-08）。交付冻结 **`bundled | system` 两个一等构建模式**（M7-16），控制面 = just **位置参数**（`just package [bundled|system]`，默认 bundled，非法值 fail-fast——`mode=` 键值写法在 just 1.46.0 下会被当成第二个 recipe，实测）；来源在 T0 首日 spike 定（甲 = Martin Riedl 构建核验采用 + 镜像；乙 = 自建最小 LGPL profile，倾向），两案都不顺 → **system 模式发布**
  - **媒体工具单一真相（T0，M7-18）**：进程级 **MediaToolsRegistry** 进 AppContext——boot 创建（missing/incompatible **不是** boot failure）、capabilities / 下载引擎 / 导入 / 一切 ffprobe 调用共享、single-flight 重探、执行失败使 ready 缓存失效；ready 判定 = **完整能力清单**（demuxer/decoder/encoder/muxer + ffprobe JSON，不止 libmp3lame）；`MEDIA_TOOLS_UNAVAILABLE` 覆盖**导入与下载**；`media_tools` 必填进 capabilities，`LOCAL_API_VERSION` **3→4**。现状是「双真相」：boot 解析一次、`ensureMp3`/`probeAudio` 每次重解析、import 独立调 ffprobe 且把错误降成普通导入失败
  - M6 留给 M7 的三件（M6 子计划 §1 推迟表 + §8.10）：**全局 `lark` bin / npm 发布名**（现在只有 `just cli`）、**`lark daemon` / `lark gui` 的打包后定位**（dev 态靠走到 `pnpm-workspace.yaml`，两个 M7 SEAM 都标在 `apps/cli/src/lib/launch.ts`）、**skill 的「agent 实际可调用」验收**
  - M6 归用户手动的两条也在 M7 一起复验：ABI 失配 exit 3、GUI 冷启动链出声
  - **签名与分发定案（用户 2026-08-08）：照 owl**——ad-hoc 签名（首选 electron-builder 一等公民 `identity: '-'`，26.15.7 起支持；不达标才回退 owl 的 `afterPack` hook。不签则 macOS Sequoia 报「已损坏」）、`hardenedRuntime:false` 不公证、只出 mac arm64 **dmg** 放 GitHub Releases、`asar:false`、README 写明首次「右键 → 打开」
  - **CLI 发布流程也照 owl**：workspace 包 `@lark/cli` 保持 `private`，用 **tsup** 打 ESM（**无 banner**——入口已自带 shebang，加了是双 shebang），产物目录冻结 `dist-publish/`，`onSuccess` 跑 `gen-publishable-manifest.mjs`（公开名 **`@orpheus-aviary/lark-cli`**、`bin: {lark, lark-cli}`、`engines.node ">=24"`、`os/cpu` darwin/arm64、deps = tsup external 的非 workspace 包）
  - ⚠️ T3 首日 spike 是 gate：**tsup 若把 `@lark/core` 整个 `noExternal` 进来，`--direct` 的动态 import 边界可能塌掉**，于是每条命令（含 `lark status`）都会加载 better-sqlite3——M6-21 的整条纪律白做，而守卫是 rg 源码的，抓不到打包产物。判据：entry chunk 无 better-sqlite3/barrel 静态引用 + Electron ABI 下 `--help` exit 0、`status` 无 daemon → exit 4 且 `DAEMON_UNAVAILABLE`
  - **验收 DMG-only 铁律（M7-19）**：`just accept-pack <mode> <dmg> <tgz>` 的判据 2–5、10 只对**只读挂载的传入 DMG** 内那一个 Lark.app 执行，禁读 `release/<mode>/` 目录，验收前后复核 DMG SHA 未变；bundled 还要用 DMG 内的二进制跑**真实转码闭环**（M4A → MP3 → ffprobe JSON），stub 伪造不了
  - [x] **已发布**：[Release v0.1.0](https://github.com/orpheus-aviary/lark/releases/tag/v0.1.0)（bundled，`Lark-0.1.0-arm64.dmg`，sha256 `e8ccc68f…`）+ [`@orpheus-aviary/lark-cli@0.1.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)（sha `f3f69c30…`，registry 回读一致）；tag `v0.1.0` → `9581bbc`。`just accept-pack bundled` **28/28**、`accept-cli` 27/27、`accept-m5` 22/22、`accept-gui` 15/15、全仓测试 1697
  - [x] **T1 GUI 打包链** / **T2 打包后定位** / **T3 CLI 发布物** / **T4 许可交付** / **T5 accept-pack**（子计划 §8.4–8.10）
  - 发版实测：仓库首次 push（128 commit）· github 网络三通其一，`git push | tail` 会吞掉退出码 · npm 必须用带 2FA bypass 的 granular token，且新包发布后 CDN 还会缓存 404 约 40 秒 · **图标返工两次**（灰色光晕要按饱和度而不是 alpha 找边界；owl 的外 40 像素是全透明的，图标本该带透明留白）
  - **许可交付**：LICENSE = MIT；NOTICE 覆盖**全部生产依赖**（renderer 产物不保留 `@license` 文本、files 的 `!**/*.md` 又排掉 tailwind-merge/sonner 的 LICENSE.md——聚合进 NOTICE 是唯一交付面），FFmpeg/LAME 只是 bundled 的附加段；验收做覆盖检查防新依赖漏更新
  - [x] **T0 ffmpeg 供应链 + MediaToolsRegistry**（2026-08-10）— 首日 spike 定案**自建最小 LGPL profile**（FFmpeg 8.1.2 + LAME 3.100，`ffmpeg 2.3MB + ffprobe 2.2MB`，`License: LGPL version 2.1 or later`；甲 Riedl 构建虽无 nonfree 但是 GPLv3 + 30 个静态外部库，义务面太大）；`vendor/ffmpeg.lock.json` + `just fetch-ffmpeg`（源码 SHA → 构建 → configure 与锁值逐字节比对 + nonfree 门禁 → 能力清单 → **真实 M4A→MP3→ffprobe JSON 闭环**，stub 实测被拒）；core 删两个 static 包 + 四级 resolver（env / `LARK_MEDIA_TOOLS_DIR` 完整性判定 / Homebrew 惯例位 / PATH）；**MediaToolsRegistry 进 AppContext**（single-flight + 5s 节流 + 执行失败使 ready 失效 + 能力级 ready），engine / `ensureMp3` / `probeAudio` / import 全部同源；`MEDIA_TOOLS_UNAVAILABLE` 两注册表 + 503 + CLI exit 3；`media_tools` 进 capabilities，`LOCAL_API_VERSION` **3→4**；GUI 设置页「媒体工具」区块 + 下载栏空闲位提示；dev/test 链 vendor 优先（justfile 顶层 export）——**整套测试因此跑在最小构建上**。`just check` 绿，全仓测试 **1663**。子计划 §8.1–8.3

## v0.2 skybridge 接入

子计划 `docs/plans/2026-08-11-v0.2-skybridge-sync.md`（六版终版，决策 D1–D8 全关闭，R32 三项已在 §3.3/§3.4/§3.5 落地）。批次 T0–T6 见 §7。

- [x] **T0 地基**（2026-08-11）— skybridge client/proto 钉 0.1.4（零传递依赖）；migration `0002-sync-activation`（四新表 `sync_tombstones`/`sync_file_ops`/`sync_dead_letters`/`sync_binding` + `conflict_record` 补 owl 0011 四列 + `sync_cursor` 按 `(server_id, workspace_id)` 重建 + `idx_songs_source_key` 去 UNIQUE + 两个 generation 键，**零 SQL 回填**）；`assertSchemaV1` → `assertSchemaV2`（新表新列 + 索引反向断言：UNIQUE 混进来要拒）；实体字符串上限与 sync 协议数值下沉 `shared/limits.ts`；`shared/sync-types.ts`（entity/op/payload/status/请求形状）；11 个错误码进三处穷尽守卫；config `[sync] interval_min = 5`
  - **`LOCAL_API_VERSION` 不在 T0 动**：接口面要到 T3 才变（路由 + capabilities 一起 bump）
  - 冒烟：真实曲库副本（21/4/4，v1）经 daemon 启动就地升到 v2，行数不变、六张 sync 表就位、outbox 为 0、`GET /config` 出 `sync.interval_min`
  - 全仓测试 **1713**（shared 79 / core 578 / daemon 339 / cli 371 / gui 346）
- [x] **T1 core 基座**（2026-08-12）— 四批：**T1a** 纯底座（`changes`/`lww`/`hlc`/`tombstones`/`payloads`，零改既有代码）· **T1b** file-effect journal + `FileEffectRuntime`（FIFO/退避/retry/discard/脱敏列表） · **T1c** emit 接线与五处重构（songs / playlists / rank / lyrics / transfer） · **T1d** backfill 三径 + 注册 rebase。core 测试 **690**
  - **批内重排**：rebase 从 T1a 挪到 T1d 与 backfill 同批——两者只在登录安装事务里跑，共享「扫 pending LWW op」的查询与夹具
  - **emit 落事务的方式**：`sqliteOf(db)`（drizzle `$client`）而不是给 15 个 `…InTx` 加形参——只有一条连接，取自 db 对象就不可能落错事务
  - **`deleteSong` 改异步**：事务 {删行 + 级联 + 墓碑 + emit + journal} 后 drain，删掉 v0.1 的 trash 两阶段补偿（提交点在文件动之前，崩了只往一个方向恢复）
  - **rank 全部离开 LWW 通道**（D7）：拖拽 = rank-only + `set_rank`；归一化 = rank-only + 一条 `reorder`（超 4000 退化逐行）；add = **成对 emit**（create 不带 rank）
  - **D8 四处审计结果**：`assertKeyFree` 改「key 变了才查」· `findSongByKey` 两条命中 → `AMBIGUOUS_SOURCE_KEY` · 导入走同一函数 · **缓存探活不用改**（从自己那一行读 key，探活后复查同一行）
  - **实测锁定**：SQLite `json_set(payload,'$.x',?)` 把绑定数字写成 `1800000000000.0`（`json_type` = **real**）——rebase 自己的产物会被 `='integer'` 的门挡住，看不见也改不动。改成 `CAST(? AS INTEGER)` 写、门放宽到 `IN ('integer','real')`，并加了「二次 rebase 能看见首次结果」的回归测试
  - **staging 分支未实现**（`write_lyrics` 只做 inline）：校验器对 `lrc` 的上限 256KB = inline 上限，而 emit 护栏是整条 change 240KB，合规 peer 发来的歌词必然装得下——v0.2 没有 staging 的生产者
- [x] **T2 core engine**（2026-08-12）— `apply.ts`（四道门定序：父墓碑门 → ⚡ 回声分支 → self-replay → LWW；song/playlist 墓碑永久胜出、membership 三分支复活；reorder 去重/忽略未知/未提及者保序追加尾部；file 效应全部进 journal；未知或非法 change 存整条 envelope 进 dead-letter 并继续）· `conflicts.ts`（记录 + `expected_current` CAS 解决，`local` 走普通写路径重新 emit）· `engine.ts`（`SkybridgeClientLike` 接口让 core 零 skybridge 依赖、cursor 按 `(server_id, workspace_id)` 绑定参数、apply 与 cursor 同事务、提交后才 drain、push 双重装箱、duplicates 视为已结算、零 ack 即停、协作式取消、每轮学服务器时钟）· `retention.ts` · `retry.ts`。core 测试 **743**
  - **本批判断**：membership `delete` 不设父墓碑门（计划只对 create/set_rank 要求）——父没了也要能记下这次移除；retention 期限 30 天、同步失败退避梯度（10s/30s/1m/5m/15m）计划未冻结，由本批定
- [x] **T3 daemon**（2026-08-12）— 四批：**T3a** core 接缝（`skybridge.toml` 凭证 / binding 单例 / unbind / 七个错误类 / HTTPS 门 / duplicates / backup 排除）· **T3b** session + login/logout（冻结序列 + 全程补偿 + toml 回滚 + epoch 互斥）· **T3c** runner + 三触发器 + refresh + status + boot drain 接线 · **T3d** 路由九条 + conflicts 四条 + `LOCAL_API_VERSION` **4→5** + capabilities + 日志卫生。daemon 测试 **433**（339 → +94），全仓 **2038**
  - **conflicts 四条定为** list / count / detail / resolve（用户拍板）：badge 只要 count，冲突页要 payload，两者代价差一个数量级
  - **push-on-mutation 用 owl 的 outbox 轮询**（用户拍板，1s 探 `MAX(local_seq) WHERE synced_at IS NULL` + 去抖 800ms / 封顶 5s + 退避带抖动）。owl 的两条理由在 lark 只成立一半（daemon 全程持写锁 → 无进程外写者；挂 EventsBus 也在提交后），但 lark 自己有更硬的一条：**backfill 与 conflict resolve 都 emit 却不发曲库事件**，事件方案得靠「记得补触发」
  - **device 重打戳不受「本事务写了 binding」约束**：换设备发生在重登时，binding 早已写好，加这个门会让 §3.7 的「设备更换」分支永远不可达。回填/rebase 仍按原条件
  - **旧 session 在 install 事务之前拆**：回填与 rebase 重写未推送变更的 key，在途的一轮会推旧 key 而本地留新 key。代价是事务失败时 session 已没，catch 里按（已还原的）toml 重新 restore
  - **refresh 回来按「凭证身份」而非只按 epoch 决定装不装**：唯一能中途改 epoch 的是某轮吃 401 调 `dropSession`（它不能进 mutex，否则等自己），而新 token 正是那个 401 的解药——只看 epoch 会把它丢掉并把用户推去输密码
  - **§3.7 的 ⑤「retention watermark」不做**：lark 的裁剪口径是「`synced_at IS NOT NULL` 且超 30 天」，首登前的行 `synced_at` 必为 NULL，watermark 加不了保护（owl 需要它是因为口径不同）
  - **backup 排除 `skybridge.toml` 从 T6 提前到 T3a**：凭证文件这一批就出现在 nest 里
  - **实测锁定**：`app.inject` 的返回类型含 `void`，包一层 helper 必须显式标返回类型（M3 的老坑，vitest 用 esbuild 不报、`tsc` build 才报）· 墓碑的 `device_id` 存的是 `''` 不是 NULL（LwwTriple 入口就归一化了），首次注册的重打戳三种写法都要收 · `lifecycle` 把函数排进微任务，测「谁先谁后」必须等被测函数**真的进去**再动手
  - **boot 冒烟**（临时 nest）：日志顺序 `sync file journal drained` → `songs store recovered` → `sync session restored` → `sync triggers started` → `daemon listening`；`/status` 报 `local_api_version: 5`；`/sync/status` 全字段就位；capabilities 65 条含 sync 九条 + conflicts 四条
- [x] **T4 GUI**（2026-08-12）— 三批：**T4a** `stores/sync.ts` + 三个 sync SSE 事件接线 + StatusBar 徽章与 popover · **T4b** SettingsDialog 拆包 + `ui/tabs.tsx` + 同步 tab（登录/登出、设备与吊销、轮询间隔、file-ops）· **T4c** 冲突 Dialog（`expected_current` CAS）+ 列表「重复」标记 + CDP 冒烟。gui 测试 **378**（346 → +32），全仓 **2070**
  - **形态三问用户拍板**：设置页加 Tabs（常规 / 同步，`radix-ui` 已在依赖里无新包）· 「列表同 key 标重复」纳入 T4（否则用户只看到「重复 2」却不知是哪两首）· 冲突页做独立 Dialog 从 popover 进（GUI 无路由，二级界面一律 Dialog）
  - **T0 起 `just typecheck` 一直是红的**：`PublicLarkConfig` 加了 `sync` 段，gui 的两处 config fixture 没跟（`stores/config.test.ts` / `SettingsDialog.test.tsx`）——vitest 用 esbuild 不做类型检查，只有 `tsc -b` 会报，T4a 一并修
  - **SettingsDialog 的 open 收进 store**（`stores/settings-ui.ts`）：popover 是第二个入口，「你还没登录」而没有按钮可点是死路；两个组件共享不了 `useState`
  - **徽章的注意力计数 = 冲突 + 永久失败的 file op**：这两样只有人能清；隔离数 / 重复数 / dead-letter 是可见但不催办的信息，只在 popover 里列
  - **file-ops 列表抽成共用组件**（`SyncFileOpsList`）：popover 与设置页都是遇到卡住文件操作的正当场所，两份「重试 / 放弃」等于两次把危险的那个写错的机会
  - **冲突页只列有差异的字段**：差异本身就是被问的那个问题；`expected_current` 取记录里的 `remote_key`，409 `CONFLICT_VERSION_MISMATCH` → 提示「又被改过」并重拉列表，而不是报一句失败
  - **重复标记按「当前视图」算**（`lib/duplicates.ts`）：跨歌单的一对由 `/sync/status` 计数与 T5 的 `lark songs --duplicates` 负责，`all` 视图下必然同时可见
  - **CDP 冒烟 9/9**（全新空 nest + 真 daemon + build 产物）：未配置态徽章文案 → popover 说明与「去登录…」→ 打开设置 → 同步 tab 出登录表单 → 勾选明文 HTTP 后仍需二次确认 → 取消后零 `/sync/login` → 无 console error。**两处脚本坑**：Radix Tabs 的 trigger 不吃合成 `.click()`（激活在 `mousedown`，要补 mousedown/mouseup）· 按文本找按钮必须**精确匹配**——复选框 label 的文案里也有「登录」，`includes` 会点到 label，反而把刚勾上的跳闸开关又关掉（表现成「点了登录什么都没发生」）
- [x] **T5 CLI**（2026-08-12）— `sync` 七命令（status / login / logout / run / file-ops / config-show / unbind）+ `songs list --duplicates` + skill 文档；cli 测试 **395**（371 → +24），全仓 **2094**，`just accept-cli` **27/27** 复跑通过
  - **三条归属冻结**：login / logout / run / status / file-ops 走 **daemon**（会话、refresh 定时器、轮的合并都在那儿，CLI 里再来一个同步器就是第二个身份在推同一批变更）· `unbind` 走**独占本地库**（停 daemon + 写锁）· `config-show` 只读凭证文件，**没有 daemon、没有库也能用**——它正是「同步坏了」时要看的东西
  - **`withExclusiveLibrary`**（index.ts）：不是把 `--direct` 当用户选项，而是当这条命令的事实。先自己判定身份（daemon 活着 → `DAEMON_RUNNING_BLOCKED` 并直说「先 stop-daemon」，而不是矩阵里那句「去掉 --direct 走 HTTP」），再按普通直连写路径走完写锁
  - **密码没有 flag**：只有静音 prompt 或 `--password-stdin`（`--password` 会进 shell 历史与 `ps`）。muted readline 的做法是先 `question()`（提示词同步写出）**再**换掉 `_writeToOutput`——顺序反了提示词自己也会被吞
  - **明文 HTTP 两道确认**与 GUI 同构：flag 说「我知道」，confirm 说「代价是什么」；`--json` 下没有 `--yes` 就不发请求
  - **unbind 的丢弃数量在提问前给出**（R5-P1-3）：为此给 Backend 加了 `syncPendingChanges()`（直连读 `countUnpushedChanges`）——「确认框说不出丢多少」等于没确认。未绑定过的库 unbind 是幂等空操作，如实说明
  - **`--duplicates` 拒绝一切收窄的 flag**（`--search` / `--limit` / `--offset`）：另一半在第二页或不匹配搜索时，重复对会看起来像单曲——正好是这个 flag 存在的理由。分页按 1000 扫全库，`--json` 出平铺列表（每行自带 key，调用方自己分组）
  - **`accept-cli` 的夹具在 T0 就坏了（本批修）**：harness 复制的是真实 nest 的 **v1** 副本，而 v0.2 的只读打开拒绝迁移（零写入是设计），于是整个「无 daemon」阶段全是 `MIGRATION_PENDING`。修法是复制后按用户的做法升一次级（起一次 daemon 再停）。**这条同时是给用户的真实提醒**：v1 库在 v0.2 下，`--direct` 读也要先起一次 daemon
  - **冒烟**（真 daemon × 全新 nest）：status/config-show/file-ops 空态 · 无会话 `run` → `SYNC_AUTH_REQUIRED`(3) · 明文 http 无 flag → `SYNC_INSECURE_URL`(2) · 有 flag 无 `--yes`（非 TTY）→ `USAGE_ERROR`(2) · 有 flag 有 `--yes` → 真去连（服务器不可达 → `SYNC_UNAVAILABLE`(1)）· daemon 活着 unbind → `DAEMON_RUNNING_BLOCKED`(5)，停机后 0 · 无 daemon 时 `status` → 4 而 `config-show` 照常 0
- [x] **T6 双套 e2e + `accept-sync` + 发版 0.2.0** — e2e 两套（**19 例**：dual 15 / files 4，`just test-sync-e2e`）、`just accept-sync`（**34 条**）、真机 soak（自动 **18/18**，N1–N5 用户决定暂缓）与 **0.2.0 发版**全部完成
  - [x] **T6a 进程内 dual e2e**（2026-08-12）— 三个 lark 库（A/B/C，各自 `:memory:` core + 独立注册设备）对一台**进程内真 skybridge server**；L1–L15 / L18 / L19 共 15 例。**元数据 only**：三个设备在一个进程里无法各占一个 nest（`LARK_NEST_DIR` 是进程全局的），所以文件效应只断言 journal 行，真文件归 T6b
    - **server 依赖形态（用户拍板，偏离计划 §4.1 的「devDependency + 动态 import」）**：`@orpheus-aviary/skybridge-server` 是 `private: true` 未发 npm，**不进依赖**，运行时按「已安装包 → `LARK_SKYBRIDGE_SERVER` → 兄弟仓构建产物」解析，找不到就 skip；`just test-sync-e2e` 置 `LARK_SYNC_E2E_REQUIRED=1` 把 skip 变成硬失败，保证 recipe 不会静默绿。lark 单独 clone 后 `pnpm install` 永远不坏
    - 🐛 **抓到真缺陷并修**：`applySongDelete` / `applyPlaylistDelete` 把入站墓碑与 `max(行, 墓碑)` 比较，于是**编辑晚一毫秒的设备能留住别人已经删掉的歌**——而对端的 `applySongPut` 一旦有墓碑就无条件拒绝后续 update，两边永远不再和解。§3.2 的「song/playlist delete 永久胜出」只实现了一半。改成**只与墓碑比较**（幂等仍在），membership 保持原样（复活是 D6 要的）。三条确定性回归进 `apply.test.ts`
    - **两条被测出来的语义**（现已写进用例注释）：① 两端各自复活的成员可能带着**相同的 rank** 落地，拖拽在等值 rank 之间无处可插——先归一化才有意义；② **⚡ op 在自己的回声回来之前不算尘埃落定**：一轮是先拉后推，所以拖拽后的第一轮会重放更早的 `reorder` 把顺序拨回去，等自己的 `set_rank` 以更高 `server_seq` 回来才稳（本地 rank 始终没丢，只是顺序抖一轮）
    - `rebase.ts` 里两个**字面 NUL 字节**（复合 map key 的分隔符）改成 `\u0000`：它让 grep / rg 把整个文件判为二进制**静默跳过**，而本仓的守卫脚本全是 rg 写的
  - [x] **T6b 多进程文件 e2e**（2026-08-12）— A = 本进程（core，内存库），B = **真 daemon 子进程 + 独立 nest**，中间一台进程内 server；4 例：跨设备歌词落成真文件 · 远端删除把 imported 音频移进 `recovered-songs/` 且**重启后计数仍在** · 崩溃残留的 journal 行在 **boot 时先于 recovery** 被 drain（顺序从**日志文件**读，daemon 只往 stdout 打 listen 行） · 失败 file-op 的两条出口
    - **一条断言被产品纠正**：`retry` 会重置 attempts，于是该行不再是「永久失败」，`discard` 按 R5-P1-1 答 **409 `FILE_OP_BUSY`**——测试改成把这条规则本身测出来
    - **夹具坑**：`write_lyrics` 的 `staging` 分支 v0.2 无生产者、被忽略，planted staging 路径**失败不了**；能真失败的是「歌曲目录是个普通文件」（ENOTDIR）
    - 计划 §6 的「pending 歌词 + 远端删除 → 隔离不删」没在这里重做：`file-ops.test.ts` 已确定性覆盖那个 arg 快照判定，跨进程重来一遍更慢更脆且无新信息
  - [x] **T6c `just accept-sync` + soak checklist**（2026-08-12）— `scripts/accept-sync.mjs`，**34 条判据 34/34**（A 前置与守卫 3 · B 凭证与备份 4 · C HTTPS 门 5 · D CLI 九条 9 · E 跨设备闭环 6 · F GUI CDP 7）。手动那半在 `docs/plans/2026-08-12-v0.2-soak-checklist.md`（真实云端 server 的明文跳闸 / refresh 轮换 / 断网合盖，本地 loopback 永远走不到）
    - **形态**：一台**真 skybridge server 子进程**（临时 db，端口 0 探空）+ **两台真 daemon**——设备 A 是真实曲库副本走 `lark` 二进制，设备 B 是独立 nest 的 `boot-child`（47101）走 HTTP。三段 ABI：node 跑 CLI 与两台 daemon → electron 跑 GUI 段（重启 A 的 daemon，GUI 走复用路径）→ 回 node 跑 `unbind`（直连写）
    - **server 是硬失败不是 skip**（与 e2e 相反）：解析顺序 `LARK_SKYBRIDGE_SERVER_BIN` → 兄弟仓 `dist/bin` → 已安装包；「静默绿」比「跑不了」更糟
    - **冲突/重复的制造靠「登出窗口」**：A `sync logout` 后编辑，改动留在 outbox 未推送——这既是冲突记录的 pending 门（§4.6）要的，也是同 key 共存要的（两端各自本地 `assertKeyFree` 都通过）。顺带把 `logout` 幂等与重登续传一起测了
    - **实测抓到四处**（三处是 harness 自己的，一处是判据写法）：
      - **`--yes` 是全局 flag、`--allow-insecure-http` 是子命令 flag**，位置放反 commander 自己退 1，长得和被测的拒绝一模一样（C3/C4 首跑假红）
      - **`--json` 下 `sync unbind` 先往 stderr 打「要丢多少」再打错误信封**：整段 stderr 不是 JSON，`JSON.parse` 全流会拿不到 `error_code`——改成**从最后一行往前找**第一条能解析的
      - **隔离目录是 `<song_id>-<op_uuid>`**（每 op 稳定，重放落同一处），不是 `<song_id>`
      - **夹具四首歌必须互不相同**：首跑把「被远端删除的那首」和「重复对的一半」选成了同一首，删除顺手把重复对拆了，F6 于是量到 0 个 `[重复]`——测出来的是夹具 bug 不是产品 bug
    - 判据 A2/A3 直接 import 三份 **dist**（shared 注册表 / daemon `statusForCode` / CLI `EXIT_MAP`）对账：11 个 sync 码全在，51 个信封码零孤儿
    - **真机 soak 已跑（2026-08-12，自动部分 18/18）**：真实云端 server（0.1.4，阿里云明文 HTTP + 公网 IP）× 一次性账号 × 设备 A（GUI + 真实曲库副本，人工走 S1–S3）+ 设备 B（第二 nest 的 daemon）。逐条记录与三条教训见 `docs/plans/2026-08-12-v0.2-soak-checklist.md` §7；N1–N5（断网 / 合盖 / refresh 轮换 / 长跑）与收尾未做
      - **踩过一次真的**：起 GUI 时 `env LARK_NEST_DIR=…` 没生效，GUI 开了**真实曲库**并登录，真库因此升到 schema v2（单向，已发布的 0.1.0 从此拒绝打开）且绑到了 soak 账号、推了 1250 条。数据零损失（全是增量上行），`sync unbind --force` 清回未绑定态（54 条簿记行，`discarded_changes: 0`）。**checklist 因此加了硬前置：登录之前先用 `/api/instance` 验 `nest_dir`**
      - **`resolve('local')` 会被同 key 守卫挡下**（可复现的真实边角）：冲突挂起期间别的设备把这首歌的 source key 给了另一首，恢复本机版本走的是普通写路径 `updateSongInTx` → `assertKeyFree` → `SOURCE_KEY_CONFLICT`。v0.2 不改——apply 允许共存、本地写不允许，两条各自都对；报错说得清是哪一首占了 key，清掉再恢复即可
      - **soak 夹具的同一类错误又犯一次**：一首歌同时当「冲突方」和「重复 key 的一半」，于是 LWW 整行覆盖把 key 抹了（重复数 0）、恢复又撞守卫。换两首全新的歌重跑即 2/2
  - [x] **T6d 发版 0.2.0**（2026-08-13）—— [Release v0.2.0](https://github.com/orpheus-aviary/lark/releases/tag/v0.2.0)（bundled，`Lark-0.2.0-arm64.dmg`）+ [`@orpheus-aviary/lark-cli@0.2.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。绑定：tag `v0.2.0` → **`4eadb85`**；dmg `fa734c6844fd0926…`（147,392,633 字节，验收前后一致）；tgz `a147329cdb159871…`，registry 回读的 `dist.shasum` = 本地 `npm pack` 的 `65037920…`。门禁：`just check` · `just test` **2098** · `just test-sync-e2e` **19/19** · `just accept-pack bundled` **28/28**（`accept-sync` 34/34 已在 T6c 的同一份代码上跑过，本次未复跑，用户拍板）
    - **发版链路完全照 M7 §3.5 的九步**（每步用户确认），无偏离；`accept-sync` 与 soak N1–N5 未复跑是显式决定，不是遗漏
    - 🐛 **两处「发版才会红」的东西**（都在本批修）：`accept-pack` 的 §9 与 §4a 把 `LOCAL_API_VERSION` 写死成 4，而 T3d 已升到 5 —— 判据本身随协议走，不然每次协议升级都要靠人记得改 · `server.test.ts` 把 `/status` 的 version 断言写成字面 `'0.1.0'`，改成读 `DAEMON_VERSION`（常量是不是发版号由 accept-pack §9 管，这里要证的是「/status 报的是那个常量」）
    - 🐛 **`accept-pack` 少一条 `ensure-node-abi`**：它的前一步 `just package` 必然把 workspace 的 better-sqlite3 留在 **Electron ABI 148**，而 harness 自己要 import core 跑 `backupNest`（判据 5 的 nest 副本）——「每个被测运行时自带 binding」这句话对**被测对象**成立，对 harness 不成立。本次是手工 `just ensure-node-abi` 顶过去的，recipe 已补
    - **图标不是产物问题**：`icon.icns` 重新生成后与库里那份**逐字节相同**（`d57be67b…`），128px 最外圈 0/508、透明边距 4.7%，装出来的 0.1.0 里也是同一个 SHA——§8.10 那次修在产物上是成立的，还看得见灰圈是 **macOS 的图标缓存**。清法：删 `~/Library/Caches/com.apple.iconservices.store` + 删本用户 `/private/var/folders/**/com.apple.dock.iconcache` + `lsregister -f <app>` + `killall Dock Finder`（都不需要 sudo，比 `lsregister -kill -r` 全库重建轻）
    - **147MB 的 dmg 上传会超过工具 10 分钟上限**：`gh release upload` 要放后台跑，前台重试循环会在半路被杀掉且留下空资产。M7 §8.9 那条「`git push | tail` 吞退出码」的同类问题——发版链路上每一条网络命令都要能自己报成败
    - 记录同步：`README.md`（状态段 + 安装表 + sync 命令 + 验收矩阵）· `apps/cli/README.md`（npm 页面：sync 七命令 + 不可逆升级警告）· `docs/DESIGN.md`；跨仓 `../aviary/docs/{ROADMAP,DESIGN}.md` 与 `../.github/profile/README.md` 另仓单独提交

⚠️ **本机真实曲库是 v2**（2026-08-12 soak 时被 v0.2 GUI 开过一次；用户拍板不还原）——0.1.0 从此拒绝打开它（`user_version > LATEST`），0.2.0 发版后这已经不再是限制。库已 `sync unbind --force` 清回未绑定态，21 首 / 4 歌单完好。开发期仍一律用 `just backup-nest <目录>` 的副本 + `LARK_NEST_DIR`，**起 GUI 后先验 `/api/instance` 的 `nest_dir` 再登录**。

## v0.2.1（开发中，**先攒不发**）

0.2.0 发布后发现的小问题，本地修完攒着，凑够一批再走 M7 §3.5 的九步（内容变了就不能复用版本号，M7-11）。

**当前状态**：版本号九处已升 **0.2.1**，本地 alpha 已打（`packages/gui/release/bundled/Lark-0.2.1-arm64.dmg`，SHA-256 `cbfa38f04e5140ada…`，包内 icns `a41c7d1b…` 与仓库产物逐字节相同），用户自用中。**未 tag、未发 Release、未 npm publish**；`README.md` 与跨仓文档仍写 0.2.0——那是**已发布**的版本，发版当天才跟着改。发版前要补跑的：`accept-pack bundled <dmg> <tgz>`（28 条）与至少一遍 `just test-sync-e2e`。

- [x] **删除文案在撒谎**（2026-08-13）—— GUI 三处确认框写着「音频与歌词文件会一并移入废纸篓」，实际是 `rm(songDirPath, {recursive:true, force:true})`（`packages/core/src/sync/file-ops.ts:594`，policy `local`）：**既不进 macOS 废纸篓，也不进 nest 的 `trash/`**。v0.1 的两阶段是搬进 `~/orpheus-aviary-nest/lark/trash/`，跟用户理解的「废纸篓」本来就不是一回事，T1c 删掉那套补偿之后连它也没了——这句文案从 M5 写下起就没准过。改成「会一并永久删除，不进废纸篓」（`SongList.tsx:366` / `SongRow.tsx:269` / `BatchActionBar.tsx:96`），`ConfirmDialog.tsx` 的注释与 `skill-template.ts` 给 agent 的说明一并更正；CLI 那句「删除 N 首歌（连同音频与歌词文件）」本来就准确。gui 378 / cli 395 复跑绿
  - `docs/plans/2026-08-06-m5-followup-batch-actions.md` 的判据 B-8 仍写着旧文案——那是当时的计划记录，不改；`accept-m5` 没有断言这句话，所以不存在判据与实现脱钩
- [x] **图标那圈灰是 macOS 垫的底板，不是我们的图**（2026-08-13 定位并修复）—— 用户的实机截图显示 lark 图标外有一圈灰框而 owl 没有。用 `NSWorkspace.icon(forFile:)` 现场渲染复现：两者系统 tile 都是 412/512，**lark 中线每边 50px 灰**（`rgb(193,193,194)`→`rgb(145,145,145)`），owl 0px。而 `icon.icns` 里根本没有灰（外圈 alpha = 0，十档尺寸边距 4.3–4.9%，与 owl 同构）——**是新系统把 app 图标合成进标准 tile 时垫的默认浅灰底**：icns 的 alpha 不像一块实心圆角方块，系统就缩小你的图并垫底。lark 的插画顶部是藤蔓花枝、枝叶之间有**透明缺口**，于是不被当作 tile；owl 内部是整片实心天空，直接铺满
  - **A/B 已证**：同一份 app 复制两份、**改成不同 bundle id**（关键：LaunchServices 按 id 缓存图标，不改 id 的话换了 icns 也渲染出旧图，第一次实验就这么假绿过），A 用现状 icns、B 用「超椭圆蒙版 + 不透明底色 + 插画铺到边」的候选 → A 仍 50px 灰、**B 归零**，与 owl 一致。实验产物已从 LaunchServices 注销并删除
  - **已落地进 `build-icons.mjs`**：脚本不再只是 sips 缩放，而是先造 tile master——`contentBox` 裁到内容 → 铺满 1024 → 叠 n=5 超椭圆蒙版（Apple 连续圆角的近似，4×4 超采样）→ 藤蔓缺口后面填插画边缘的中位色 `rgb(71,96,56)`，再交给 sips 出十档。为此内嵌了一个只认 8-bit RGBA 的 PNG 编解码（sips 只能用**颜色**补边，而不能有颜色正是需求本身；蒙版更不是 sips 能表达的）。复验：新 icns 装进改了 bundle id 的 app 副本，`NSWorkspace` 渲染灰边 **0px**
  - **判据换了**：旧的「产物最外圈不透明像素 = 0」只防得住源图的灰光晕，防不住这次的底板——新图正是要铺满画布，最外圈**必然**有不透明像素。新判据是「系统渲染出来的图在 tile 内没有灰边」，已写进 CLAUDE.md 与 `build-icons.mjs` 的注释
  - 若将来艺术图重画成边缘实心的圆角方块，蒙版这一步就成了 no-op，可以删——注释里写了怎么判断
  - **三条已排除的死路**，别再走：清缓存（只对灰光晕那种陈旧渲染有效）· 拉大到 97.5%/100%（owl 自己也只有 91%，尺寸从来不是原因）· 腐蚀 alpha 抹掉深绿描边（露出插画浅色底与裁断的枝叶，更丑）

## v0.3.0 m4a 统一 + 一次性迁移 + PC 三项（Phase A）

主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md`（v11，九轮评审）+ 子计划 `docs/plans/2026-08-13-m4a-unification.md`（v3，判据 1–61 / 决策 a–n）。批次 T0a → T1 → T1b → T2 → T3 → T4 → T5 → T5b → T6。

**当前状态（2026-08-17）**：**T0a → T5b 已完成并提交，T6 的验收与手测已完成**，剩九步发版。canonical 是 `songs/<id>/song.m4a`，vendored ffmpeg 零外部库、不能再产 mp3；迁移从 core 一路接到了 daemon / GUI / CLI——**一个 0.2.x 曲库现在可以自己走完转换并把窗口交回曲库**（判据 33 的真实副本闭环见 T6b）；导入收 **shipped profile 读得开的一切**；PC 三项已交付，**协议定稿在 `LOCAL_API_VERSION = 6`**。测试 **2419**（shared 79 / core 985 / cli 417 / daemon 495 / gui 443）+ e2e 19 + accept 系列全绿。

**T2（迁移 core）已完成**：T2a 错误分型表 → T2b 删 Go 迁移 → T2c schema v3 + ledger → T2d recovery 版本化 + `migration-backup/` → T2e scanner → T2f converter。

**T3（daemon / GUI / CLI 接线）已完成**：T3a 三层 context + 阶段机 + runner → T3b 迁移三路由 + file-ops 白名单 → T3c GUI 迁移屏 + 设置页备份区块 → T3d CLI 口径。判据 15–22、51、59、61 已落测试；**判据 54 不在 T3**（它是 §7 的 F3，属 T5b，子计划 §3 的 gate 列错了批次）。

**T4（导入矩阵）已完成**：T4a 九个真容器夹具 + `toneWav` 扩 PCM 形态 → T4b 矩阵本体（shared 格式清单 + core 判定 + `warnings`/`error_code` + daemon/GUI 接线）。判据 31、53 已落测试。

**T5（PC 三项 + 协议定稿）已完成**：T5.1 命名清洗 → T5.2 阶段 + 字节进度 → T5.3 下载面板 + cancel-all → T5.4 `LOCAL_API_VERSION` 升 6。判据 23–30、32 已落测试。中间掉出一个**验收工具自己的洞**（`tsc -b` 跳过 gui），单独修了。

**T5b（「已实现未实装」修复批）已完成**：五个提交，按「谁在撒谎」分组——daemon 的三个活设置（`fa5b6b0`）→ 冲突恢复（`2c490f6`）→ GUI 的设置页与右键菜单（`444fe7c`）→ CLI 的空转 flag 与 stderr 承诺（`ba187f1`）→ 唯一没解码的标题（`916d750`）。F1–F17 全关闭，判据 35–47、54 已落测试。

**开工前要知道的两件事（T6 已各自了结）**：① 真实曲库现在是 7 首全 `downloaded` / 0 首 imported，**A 类（imported 永不删除）在真机上没有样本**——`accept-m5` 早已自造夹具，`accept-sync` 的 E5 到 T6 才发现同病（见 T6a）；② `accept-pack` 的 `LOCAL_API_VERSION` 由 T5.4 统一改成 6。

- [x] **T0a 供应链前半**（2026-08-13）— 先入库 mp3 夹具，再给 vendored ffmpeg 加 AAC 编码器与 ipod 封装器，**LAME 暂留**（生产 `ensureMp3` 要到 T1 才切 m4a，先删就是断链）
  - **`scripts/fixtures/tone-1s.mp3` 入库**（25748 字节，sha256 `25d43ca2…`）：`toneWav(1)` → 当前 vendored ffmpeg 的 libmp3lame，参数与彼时的 `ensureMp3()` 逐字一致（192k / 44.1kHz / `-f mp3`），所以它就是「0.2.x 写进 `songs/<id>/song.mp3` 的那种文件」——迁移链闭环拿它当输入。同一构建跑两次字节相同（实测）。**顺序不可倒**：T1b 删掉 LAME 之后本仓再没有任何 mp3 编码器，配方就只剩历史价值。来历与 sha256 记在新增的 `scripts/fixtures/README.md`
  - **lock 增量**：`--enable-encoder='aac,libmp3lame'`、`--enable-muxer='ipod,mp3'`、decoder 补 `pcm_u8,pcm_s24le,pcm_s32le`（§4-a 的 WAV 支持面，**一次改完只重建一次**；对应的「各配真实样本 gate」随 T4 导入矩阵落）。`build_script_version` → 2
  - **能力清单只加当下用得上的两项**（`encoder aac` / `muxer ipod`）：`REQUIRED_CAPABILITIES` 是全有全无的 ready 门，注释写着「pipeline 要什么就是什么，不多一项」——ALAC/vorbis/opus/PCM 要到 T4 才有人解码，现在加进去等于让缺它们的 system-mode ffmpeg 连下载都做不了。configure 已经带上，T4 加清单不必再重建
  - **闭环判据从一条变四条**（`closedLoops()` 表驱动，逐条验容器 + 音轨 codec + 时长）：WAV→AAC→m4a（导入/新下载的编码侧）· m4a→copy→m4a（**bilibili remux，T1 之后每次下载都走的热路径**）· mp3→AAC→m4a（0.3.0 迁移链）· m4a→mp3（0.2.x 遗留，随 T1b 一起删）。原判据只验 `format_name`，copy 把音轨丢光也照样过——补了 `-select_streams a:0` 的 `codec_name`
  - **toneWav 走精确路径 import**（`dist/testing/tone-wav.js`）而不是 `@lark/core/testing` barrel：barrel 里有 Go 库夹具 → 加载 better-sqlite3，而这个脚本是 `just package` 的前置，那时 workspace 的 binding 正是 Electron ABI（accept-pack 那条「harness 自带 ABI 不成立」的同源教训）
  - **gate**：`just fetch-ffmpeg` 四条闭环全绿 + `just check` + `just test` **2099**（core +1：「能产 mp3 但产不了 m4a 的 0.2.x 构建 → incompatible」）+ 真实 bilibili 下载不回归（`accept-m5` 第 3 段实跑：`BV1GJ411x7h7:137649199`，5,097,217 字节落盘、source 三元组回写）
  - ⚠️ **`accept-m5` 跑不完了，与本批无关（当场修掉，见下条）**：第 4 段（缓存）假定真实曲库里「至少一首带文件的 imported」，而用户当天（2026-08-13 15:58–16:24）清库重下，现在是 7 首全 `downloaded` / 1 歌单 / 0 imported，`imported[0]` 直接 undefined 崩掉。同一件事还抽掉了**迁移判据 33 的 A 类样本**（imported 永不删除那条分支）——T2/T6 要验 A 类得自己造
- [x] **T1 canonical m4a**（2026-08-14）— 三小批。**T1-1 探测与转换原语**（`38b1fe8`）：`probeAudio` 从「时长 + 容器」扩成 `AudioProbe`（容器 / **全局 stream.index** / codec / 采样率 / 声道 + layout / 封面图与真视频轨之分 / 时长），`planAudioConversion` 是**纯函数**——AAC-in-MP4 → `-c copy`、裸 ADTS → copy + `aac_adtstoasc`、其余 → `aac 192k`（>48k 降采样、>2 声道下混），每条都 `-map 0:<全局 index>`。纯函数是因为最小 profile 没有 ADTS **封装**器，`copy-adts` 这条永远造不出真输入（T4 的导入矩阵补入库 `.aac` 夹具），参数断言是诚实的覆盖方式
  - **T1-2 切换 canonical**：`song.mp3` → **`song.m4a`**（`CANONICAL_AUDIO_FILE` 一处定义，`resolve.ts` / `file-ops.ts` 隔离目录都从它取）· tmp 名 `.song.<task>.m4a.tmp` · `/audio` 的 `Content-Type: audio/mp4` · `songFileInfo(id, { audioMode })` **强制显式传**（`migration-pending` 时才认 legacy mp3；路径函数不偷偷读 DB，daemon 业务路由在迁移期本就关着，所以现在全传 canonical，T3 让 CLI direct 从 pending 标记派生）· **导入变成转换而不是拷贝**（用户文件原地读、不再复制进库，少一个暂存步骤；扩展名闸门仍只收 .mp3，T4 才放宽）
  - **T1-3 按 codec 选流**：`BiliAudioStream` 增 `codecs` / `isAac`，候选**先按 codec 再按带宽**——AAC 原样 copy，别的要重编码，所以 132k 的 AAC 胜过 320k 的非 AAC（多出来的码率过不了编码器）。`codecs` 缺失一律当非 AAC（猜错的代价只是一次多余转码，反向猜错会宣称一个文件撑不起的 copy）。**决定权始终在探测**：DASH 里写 `mp4a.40.2` 而实际不是，也只会被转码而不会被错误 copy。真实 API 实测：`BV1GJ411x7h7` → id 30280 / `mp4a.40.2` / `isAac: true`
  - 🐛 **`+movflags faststart` 是被 accept-gui 逼出来的**：MP4 默认把索引（`moov`）写在音频**之后**，而 lark 的音频永远经 HTTP 给媒体元素——30 分钟夹具首跑 `duration=undefined`，播放器唯一发出的请求是文件最后 0.1%。加 `-movflags +faststart`（一次重写换 moov 前置）后 duration/seek/跨重启续播全过。单测断言的是**真文件里 moov 在 mdat 之前**，不是参数里有没有那个 flag
  - 🐛 **媒体流把 renderer 的 socket 池吃光了（真缺陷，本批修）**：Chromium 每 origin 六条 socket，而 lark 的 SSE、每个 API 调用、每条 range 音频请求（`lark-media://` 的上游那一跳跑在**同一个 session** 上）都指向同一个 origin。canonical m4a 播放时稳定占满六条，于是 **renderer 连 `/status` 都发不出去**（实测超时 5s，同一时刻 harness 从 Node 侧请求 3ms 返回）——表现是「daemon 重启后 GUI 再也不重新注册」，而音频一路正常，什么都不像坏了。修法：`lark-media://` 的上游改用**独立 partition 的 session**（`session.fromPartition(...).fetch`），媒体与 API 各占各的池
    - **第一版修错了且静默无效**：`net.fetch(url, { session })` —— `net.fetch` **根本没有 session 选项**（init 是 RequestInit，多传的字段类型检查不拦），要用 `Session.prototype.fetch`。为此补了 `media-protocol.test.ts`：断言上游走的是 partition session 的 `fetch`、`net.fetch` 零调用
  - **accept-gui 的节流从 48 KiB/s 提到 192 KiB/s**：mp3 没有索引、从第一帧就能播；m4a 必须先读几百 KB 的 moov，48 KiB/s 下每次加载十秒——量的是拨号网速不是产品。192 KiB/s 仍然远不够 30 分钟文件缓冲到 90%（判据 2/4 的意义不变）
  - **gate**：`just check` · `just test` **2118**（core 832 / gui 379）· `just test-sync-e2e` **19/19** · `just accept-m5` **22/22**（真实 bilibili 下载现在是 **copy remux**：5,401,140 字节的原始 AAC，不再是 5,097,217 字节的转码 mp3）· `just accept-gui` **15/15**（真 Electron 媒体元素放 m4a）
  - ⚠️ **0.3.0 的开发版看 0.2.x 曲库 = 一首歌都没有文件**：`has_file` 只认 `song.m4a`，副本里的 21 个 `song.mp3` 一个都不算——这正是 T2/T3 迁移要解决的，也是「开发期只对副本操作」的又一条理由（缓存清理同理，看不见就不会删）
- [x] **T1b 供应链后半：删掉 LAME**（2026-08-14）— 应用链已经不产 mp3 了，供应链跟上：configure 去掉 `--enable-libmp3lame` / `--enable-encoder=libmp3lame` / `--enable-muxer=mp3`，LAME 的 source 条目、构建段与 `PREFIX` 一并删除——**profile 现在零外部库**（`--extra-cflags` 里那对 `-I../prefix/include` / `-L../prefix/lib` 也没有存在理由了），`build_script_version` → 3
  - **mp3 的 demuxer / decoder / parser 全部保留**：迁移要**读** 0.2.x 写下的东西，导入也要。清单里 mp3 出现两次，两次都是读路径
  - **`REQUIRED_CAPABILITIES` 去掉 `encoder libmp3lame` 与 `muxer mp3`**：它是全有全无的 ready 门，继续要求一个我们不用的编码器，等于对着一台完全能跑 lark 的机器说「不兼容」。新增一条测试断言「没有 mp3 编码器也 ready」
  - **`ensureMp3` 从 core 删除**，它独有的四条覆盖（缺二进制的报错文案 / 自己的超时 / 已 abort 的 signal 不 spawn / 覆盖既有输出）原样移到 `processAudio`
  - **`accept-pack` §3f 的闭环换成迁移那一条**（`tone-1s.mp3` → aac/ipod → ffprobe，验容器 + 音轨 codec）：原来那条用 libmp3lame，删了 LAME 之后**只会在发版当天红**——0.2.0 那次「判据落后于协议」的同款教训，这次提前改
  - gen-notices 文案「转成 mp3」→「转成 m4a」（FFmpeg 段现在只列 FFmpeg 一个库）· README「外部库只有 LAME」→「无任何外部库」· justfile 注释同步 · `scripts/fixtures/README.md` 的配方改成「来历记录，已跑不动」
  - **gate**：`just fetch-ffmpeg --force` 重建后三条闭环全绿（configure 与锁值逐字节一致、无 nonfree）· 全仓无 mp3 产出调用（rg 只剩注释与「模拟一台有 libmp3lame 的机器」的测试桩）· `just check` · `just test` **2115**（core 829）· **`just accept-m5` 22/22**——真实 bilibili 下载走 copy remux，**导入的 mp3 在没有任何 mp3 编码器的工具链上转成了 m4a**
  - 产物 4.5MB（ffmpeg 2,369,480 + ffprobe 2,175,736），与带 LAME 时基本持平；NOTICE 重新生成后 FFmpeg 段只剩一个库
- [x] **T2a 错误分型映射表 + 夹具**（2026-08-14）— 子计划要求 T2 的第一个提交是**表**而不是代码，理由是这张表决定「什么时候可以删掉用户的 mp3」。落地 = 子计划新增 **§9 附表 A**（四路信号 / 八条判定顺序 / 两张 pattern 清单）+ `core/src/migration/{error-class,verify}.ts` + 36 条判据，**内容类每一条都由真实 vendored ffmpeg 跑真实损坏 mp3 产出**（`damageMp3()` 从 tracked 的 `tone-1s.mp3` 派生 `unreadable`/`truncated`/`scrambled`/`junk`/`empty`；单元测试破例用 `scripts/fixtures/` 是因为 T1b 之后本仓再没有能造 mp3 的东西，README 已记）
  - 🐛 **ffmpeg 的退出码看不见截断（实测，改了设计）**：把夹具截到 12000/25748 字节喂进去——ffmpeg 打一行解码抱怨、**退出码 0**、写出完全合法的 m4a，里面只有 **0.47 秒**（原 1.0 秒）；中段刷 `0xff` 的那份是退出 0 / **0.29 秒**。只信退出码的迁移会 unlink 掉 mp3 再留下三分之一首歌。于是「验证 m4a」定义成 `assessCanonicalAudio()` 的五条（有音频流 · aac · mp4 族 · **时长 > 0** · **时长 + 容差 ≥ 源时长**，容差 `max(0.25s, 1%)`，只拦缩短不拦变长——AAC 的 priming 采样本来就让产物略长）
  - 🐛 **环境错误会连带打印解码噪声**：转码中途磁盘满，stderr 里 `No space left on device` 与 `Header missing` 同时在场，先查哪张表就决定这首歌会不会被删——**环境 pattern 必须先于内容 pattern**，专门配了回归测试
  - **超时不是中止**：两者从 `withTimeout` 出来长得一模一样（都是 AbortError，wrapper 文案都是 `cancelled or timed out`），唯一能分开它们的是**调用方自己的 signal**。取消 → 回 pending 续跑；超时 → 环境类、停 pass、不动文件
  - **同一个 errno 按步骤分流**：`convert` 步的 EACCES 是 spawn 失败（环境，装个能用的 ffmpeg），`file_action` 步的 EACCES 是这一首的目录（`blocked`，不停整个 pass）；而 `ENOSPC`/`EROFS`/`EIO` 这类**两个步骤都算环境**——磁盘满不因为碰巧在 rename 时冒出来就降格
  - gate：`just check` · `just test` **2151**（core 865）
- [x] **T2b 删掉 Go 迁移实现**（2026-08-14，子计划 §4-l 用户拍板）— 删 1192 行：`db/migrate-go.ts`（513）+ 它的测试（374）+ `db/probe-go.ts`（47020 探活）+ `scripts/migrate-go.mjs` + justfile recipe + core barrel 的两行导出
  - **拒绝路径整条保留**：`isGoLegacyDb()` 的指纹识别、`GoMigrationRequiredError`、`createDatabase`/`openReadonlyDatabase` 的两个分支、CLI 的 `MIGRATION_REQUIRED` 映射都不动——不认这个形状的话，Go 库会落进「未知 v0 schema」，同样是拒绝但没有任何指路。文案改成「本版本删了导入器，用 0.2.x 的 checkout 跑一次 `just migrate-go` 再升级」，daemon 的引导语同步，`boot.child.test.ts` 加断言 `0.2.x`
  - **`fixture-go-db.ts` 留着**：它是造 Go 形状库的夹具，而拒绝路径的测试（`readonly` / `db/index` / daemon boot 子进程）正靠它——删了迁移不等于删了「拒绝得对不对」
  - **writer lock 从四方变三方**（daemon / `--direct` 写 / backup-nest）：`writer-lock.test.ts` 里三条 migrate-go 用例删除，其中「拒绝未知 v0 库时字节不变」这条属性由 `createDatabase` 自己的字节级断言继续覆盖。CLAUDE.md / DESIGN.md 的「四方共守」同步
  - **`createConsoleLogger` 顺手删了**（F16 的第一项）：审计时报「零调用」，其实唯一的调用者是 `scripts/migrate-go.mjs`（.mjs 不在 TS 扫描面内）——这次连调用者一起没了
  - gate：`just check` · `just test` **2130**（core 844，−21）
- [x] **T2c schema v3：0003 + ledger + 契约**（2026-08-14）— `LATEST_KNOWN_VERSION` **2 → 3**；`0003-audio-m4a` 建 `audio_migration` ledger（主键 `object_key` = `songs/` 下的目录名，**`song_id` 可空且无外键**——旧 file-op 可能指向已删的歌，孤儿目录甚至不是 UUID，拿 song_id 当主键要么丢这些行要么给它们编造曲库条目）+ 置 `audio_migration_pending`
  - **flag 与 `user_version=3` 同一事务**：`applyForwardMigrations` 本来就把 SQL 和版本戳一起提交，所以 flag 写在**迁移 SQL 里**而不是之后一条语句——否则存在「已是 v3、还没标 pending」的窗口，死在里面的库下次会以普通 v3 打开，它的 `song.mp3` 从此没人再看一眼。配了反向测试：给 0003 尾部接一条必然失败的语句，断言版本戳、flag、ledger 表**一起回滚**
  - **反方向的窗口留在 `createDatabase`**：全新库（v0 且 schema 空）跑完链条后立刻清 flag，崩在「commit 后、clear 前」只让下次多扫一次空目录。方向永远是多迁不漏迁，两条都有测试
  - **`assertSchemaV2` → `assertCurrentSchema`**（三调用点：create / readonly / recovery）。以前靠「改名逼所有调用点红」来保证有人重新想过签名，三个版本下来那只是 churn；换成**新增 `schema-signature.test.ts` 的完整性判据**：拿全新迁移链建库，断言 `REQUIRED_COLUMNS` 的键**恰好等于**库里的用户表集合——以后加表忘了改签名，会在这里红，不必再记得改名仪式
  - 🚨 **从这一批起，开发版碰 v2 库就会把它单向升到 v3**（dev daemon / `--direct` 写 / 测试指错 `LARK_NEST_DIR` 都算），而装在 `/Applications` 的 0.2.0 从此拒绝打开它。CLAUDE.md 顶部的警告已升级成 🚨
  - **中间态（T3 补齐）**：daemon 还没有 pending 门与 runner，所以此刻 v2 库升上来之后会**照常提供服务**，只是 `has_file` 全 false（只认 m4a）。`accept-cli` 的「复制后升一次级」夹具靠起 daemon 完成，T6 复核
  - gate：`just check` · `just test` **2146**（core 860，+16）
- [x] **T2d legacy 消化：recovery 版本化 + `migration-backup/`**（2026-08-14）— 迁移跑之前，boot 要先把 0.2.x 留下的崩溃残留收拾干净（主计划 §3.2-11），而那些残留说的是 `song.mp3` 的世界
  - **landing manifest 加 `version` + `audio_file`**：没有 `version` 键 = 0.2.x 写的 = v1 = `song.mp3`。不能靠「看磁盘上有什么」猜——recovery 要分辨的恰恰是磁盘状态相同的那几种情况（`had_old` 那条判据就是为此存在的）。`audio_file` 会被 join 进路径且来自磁盘，所以按**白名单**校验（只认两个我们写过的名字），越界的 manifest 当「不可读」处理，配了 `../../../lark_config.toml` 的判据
  - **恢复决策表整表跑两遍**（`describe.each` 的两个 era，判据 19）：form 1–7 + 不可读 manifest，v2/v1 各一遍。form 3 的断言点在于 backup **按当时那个名字**还原——mp3 还原成 `song.m4a` 会被 scanner 当成「已迁移」跳过，然后以 `audio/mp4` 播一个 mp3
  - **孤儿判定改双名**：`songs/<id>/` 里有 `song.mp3` 也算孤儿。只认 canonical 的话，0.3.0 首次开 0.2.x 库会从每一个孤儿旁边走过去
  - **file-op 的 `DeleteRemoteArg` 加 `audio_file`**：没有这个字段 = 0.2.x 的 op = `song.mp3`。这条不是修辞——执行器是「按名字把不可替代的音频挪进 `recovered-songs/`，**紧接着 `rm -rf` 整个目录**」，名字对不上就等于把一首 imported 删掉而不是救下来。定位时两个名字都查（快照的优先）：定位资产不是推断，而下一步是不可逆的
  - **`migrationBackupDir()` 进 paths**（`lark/migration-backup/`，§4-b）：在 `songs/` 树之外，所以缓存清理（走曲库）、同步（走歌）、recovery（走 `songs/`）结构性地够不着它；`backup-nest` 是 deny-list，天然包含——补了判据钉住这一条
  - gate：`just check` · `just test` **2160**（core 874）
- [x] **T2e ledger 读写 + scanner**（2026-08-14）— `migration/ledger.ts`（状态词汇表 + 行读写）与 `migration/scanner.ts`（走 `songs/` 目录树，不走曲库表）
  - **一行一个「对象」，而且只给持有 mp3 的目录建行**：`total` 因此等于工作量而不是曲库大小，「`songs/` 树内无 mp3」这条完成条件也有了对应的行。只有 `song.m4a` 的目录跟这一趟没关系，不建行
  - **走目录树是有理由的**：0.2.x 库里可以有「行已删、file-op 还指着」的目录，也可以有崩溃留下的、根本不是歌的目录，两种都握着 mp3。按表遍历会把它们永远留在磁盘上
  - **class 判定与缓存清理同源**（R26）：`downloaded` + provider 在可重下集合内 + key 非空 → R，否则 A，没有曲库行 → orphan。**pinned 不参与**——它说的是「别回收」，而迁移不是回收（产物保住了内容）。补了「provider 是本 build 取不到的那种」判据：写路径今天造不出这种行（`normalizeSource` 拦），但将来加了第二个 provider，那个 build 写的库就能被这个 build 打开
  - **重扫的边界**：终态行原样不动；`converting`/`discarding`/`backing_up`/`blocked` 一律不碰（它们带着 `resume_state`，重置成 pending 会重启一次已经半提交的转换）；只有 `pending` 会**重新判 class**——两次启动之间用户可能把 source 修好了，而 class 决定这首歌的 mp3 能不能删
  - **`blocked_file_op` 的两条出路**：op 没了 → 回 pending；op 没了**且对象也不在了** → 直接删掉 ledger 行。后者是「file op 自己把歌带走了」（一次同步删除、一次隔离），把它记成迁移故障等于给用户自己下的命令报警，而且那行永远settle 不了
  - gate：`just check` · `just test` **2180**（core 894）
- [x] **T2f converter：单曲状态机 + 协调表**（2026-08-14）— `migration/{converter,backup,preflight}.ts`，28 + 5 条判据（判据 1、5–13、50、52），转换全部跑**真 ffmpeg + 真 mp3 夹具**
  - **协调表不是第二套实现，它就是正向路径**：每一步都先问「目录里有什么、备份里有什么」再决定，所以「中断后恢复」走的是当初把它带到那儿的同一套规则。**唯一的例外是 `discarding`**——它记的是磁盘无法表达的那件事：实时探活已经说过「这首还能重下」。ledger 一律**先写后做**（`converting` 在 ffmpeg 之前、`discarding` 在 unlink 之前），所以崩溃后行永远比现实「多说了一点」，而不是少说
  - **A 类的 `asset_missing` 压过一个完好的 m4a**（协调表原文，实现时差点写错）：mp3 不见了、备份里也没有，即使 m4a 完全有效也记 `asset_missing` 而**绝不 done**——转换是有损的，它从来不是「被保住的那个东西」
  - **静默截断是靠时长判据拦下来的**：`truncated` 夹具走完整条链，ffmpeg 退出 0、产物合法，`assessCanonicalAudio` 认出它短了 → 走内容失败分支 → 探活 → 入 backup。没有这一条，R 类会删掉原件留下半首歌（附表 A.4）
  - **⚠️ 与主计划 §3.2-9 的一处偏离（更保守，已实测）**：`blocked` 行的重试**不重放 `blocked_action`**，而是重新按磁盘判定。逐条推演过四种 blocked 场景，结果要么相同、要么更保守（最坏情况是多探活一次网络）；`blocked_action` 因此是报告字段而不是执行指令。理由是一条写在失败之前的记录可能已经过时，而磁盘不会与自己不一致
  - **备份永不覆盖**：目标已存在时比 size + SHA-256（1MiB 分块流式读，别把整首歌读进内存）——一致就是「这次移动上次已经做完了」，不一致就把新来的这份放到 `<key>.reconcile-N.mp3` 并记 `reconcile_action`，两份都不删。孤儿走 `migration-backup/orphans/`，且**不转换**（没有行指向它，转出来也没人能放）
  - **探活由 daemon 注入**（§4-h）：`canRedownload(sourceKey, signal)` 是缓存清理那一个实现（R26 同源），core 不反向依赖 daemon。**探活自己抛错 = 保留文件**——没网、被限流、响应异常，没有一样是删掉唯一副本的许可
  - **预检三项各自拦截**（判据 1）：能力清单 / 目录可写（真去建目录写一个字节，`access(W_OK)` 对只读挂载和满盘都会说通过）/ `free ≥ max(500MB, 最大单曲 × 3)`——三份是因为源文件、临时产物、备份可以同时存在；不做「整批预留」，那个估算不可能诚实（m4a 比 mp3 小）
  - gate：`just check` · `just test` **2213**（core 927）
- [x] **T3a 三层 context + 阶段机 gate + runner**（2026-08-14，`05873c0`）— daemon 拆成 **BaseContext**（DB / config / logger / mediaTools / **bilibili** / token / 两条总线 / guiChannel）+ **NormalRuntime**（player / audioStreams / cacheLeases / cacheScheduler / downloads / sync / fileOps，**activation 时才构造**）。判定线不是「贵不贵」而是「白名单 handler 要不要」——`bilibili` 进 Base 是因为迁移的弃置探活复用缓存清理那一个实现（R26），而**一个进程两个 client = 对风控两个身份**
  - **late-bound 字段读早了直接抛 `RuntimeNotReadyError`**，不是 `undefined`：gate 让这不可达，而一旦 gate 破了，我们要的是当场喊出来，而不是三层调用之后的「cannot read property of undefined」
  - **gate 读内存里的 phase，不读 DB 那个 flag**：flag 是在 activation **中间**清掉的，逐请求读它会在「runtime 还没建好」的窗口里放开业务路由。三个 preHandler 的顺序是契约：Host → Bearer → 迁移 gate，**401 必须先于 503**（没有 token 的人不该知道这个库正在做什么）
  - **pass 在 `listen()` 之后才起**（§3.2-3）：一个没人能看见的迁移，和一个启动时卡死的 daemon，从外面看一模一样
  - 🐛 **boot 先 drain file-op journal 再迁移**——所以「排队中的 op 占住目录」根本占不住：它会被执行掉、连歌一起带走。**只有 attempts 到顶的永久失败 op 才是真路障**，子进程判据的夹具据此改写（第一版就是这么假绿的）
  - **`onFinished` 自己幂等**：pass 跑第二次会再次到达完成态，而激活只有一次——把 guard 放在调用方，等于让别人替它记住
  - gate：`just check` · `just test` **2243**（daemon 433→463：gate 16 + runner 12 + 子进程 2）
- [x] **T3b 迁移三路由 + file-ops 白名单**（2026-08-14，`b910c32`）— `GET /api/audio-migration`（报告，**pending 清掉后仍可读**，ledger 就是那份记录）· `POST …/retry`（重新预检并继续，**kick 不 await**：一趟 pass 是分钟级而这是一个按钮，进度屏本来就在轮询）· `POST …/backup/clear`
  - **清空备份四道锁**：不在白名单（迁移期直接 503——pass 还在往那个目录里搬文件）· 要 `confirm: true` · 走迁移 mutex · **core 删的是目录本身而不是 ledger 里的路径**，逃逸因此是结构上不可能而不是「查过了」。另配 `resolveBackupPath` 把越界的 `backup_path` 挡在计数与删除之外
  - **ledger 先忘记备份，文件后删**：崩溃能留下两种谎，「没有备份」而文件还在只值一次重跑，「你的原件安全地躺在备份里」而它已经没了要赔一个文件
  - **file-op 三端点进白名单**：一个放弃了的同步 op 占着歌曲目录，pass 碰不得，没有这扇门迁移永远完不成。它们是唯一**两个阶段都服务**的路由——按 phase 选执行器（pending 用迁移自己的，normal 用 `ctx.fileOps`），处理完 kick 一次 pass 重扫
  - **core 多了一个窄 logger（`StructuredLogger`）**：`FileEffectRuntime` 与 converter 只调 `info`/`warn`，却要着 pino 的全表面，逼得 daemon 用自己的四方法 logger 时只能 cast
  - gate：`just check` · `just test` **2264**（core 937 / daemon 474）
- [x] **T3c GUI 迁移屏 + 设置页备份区块**（2026-08-14，`458e34f`）— 迁移期没有曲库可给：业务路由全 503，而 `App` 一挂载就有五个 store 去 fetch。所以门开在 `App` **外面**（`BootGate` 探 `/status`），三条出路里第三条最值得写下来：**探不到的 daemon 不是正在迁移的 daemon**——落回正常 app（M4 起它自己会处理离线），卡在探测上只会把「daemon 正在启动」变成一个空窗口
  - **进度屏不只是进度条**：三种停法里有两种要人，两个入口都在这儿——`blocked_environment` 给原因 + 「重新检测并继续」，`blocked_file_op` 直接复用同步设置那份 retry/discard 列表
  - **设置页「迁移备份」**：占用 / **其中不可再生的那部分**（`kept_unconverted` 的原件，其余都有 m4a 在旁边）/ 打开目录 / 清空（确认框点名那两个数）/ 「重新下载 N 首」（`lost` 的那些——它们是探活说过「还能重下」才被丢弃的）。**打开目录的 IPC 不收参数**：main 自己算那一个目录，收路径的版本等于一个起了好名字的「随便打开点什么」
  - 🐛 **store 存报告前要验形状（真缺陷，本批修）**：`refreshReport` 原样存下 200 响应，而 settings 既有测试的桩对任何 URL 都回 config → `report.counts.total` 炸掉整个设置页，10 个既有测试同时红。**404 有 catch 兜着（0.2.x daemon 就是这样），形状不对的 200 没有**
  - **进度条用原生 `<progress>`**：`role="progressbar"` 挂 div 上过不了 a11y lint（要求可聚焦），而补个 `tabIndex` 只是骗规则；原生元素自带语义、值不用三个 aria 属性同步，`accent-color` 一行就上了琥珀色
  - gate：`just check` · `just test` **2286**（gui 379→396）
- [x] **T3d CLI 口径**（2026-08-14，`8b3c9f6`）— `--direct` 写在 pending 时拒绝（`AUDIO_MIGRATION_PENDING`，exit 5），**检查放在 `createDatabase` 之后**：那一次调用正是把 0.2.x 库变成这个状态的人，而全新库不会中招（同一次调用会替它清掉 flag）。**拒绝时把写锁还回去**——攥着它等于让唯一能修好这个库的 daemon 起不来
  - **读继续开着，但要问库「哪个名字算音频」**：迁移期没轮到的歌**有**音频（mp3），报 `has_file: false` 等于让用户去下载自己已经有的东西。mode 在 open 时读一次就够——它只会**放宽**判定，pass 中途跑完不会让答案变错
  - **`lark status` 多一行**：它是迁移期唯一还工作的命令，所以「为什么别的命令都在 503」这句话属于它
  - **判据 15 的另一半用子进程跑**：v1 landing manifest（没有 `version` 键）+ 它的 `.replace.<task>.bak`，磁盘上**没有** `song.mp3`——只有 boot 的 legacy recovery 能把它还原出来，然后同一次 boot 的扫描把它转掉。断言 `song.m4a` 存在，这条路径以外没有别的方式让它成立
  - gate：`just check` · `just test` **2288**（cli 395→401 / daemon 475）
- [x] **T3 真机演练**（2026-08-14）— 拿真实曲库的**副本**（`just backup-nest` → scratchpad）造齐五种状态：0 号 imported + 好 mp3（转换后原件进备份）· 1 号 imported + 截断（`kept_unconverted`，唯一副本）· 2 号 downloaded + 截断（探活 → lost）· 3 号被 attempts=5 的 file op 占住 · 4–6 号正常；外加把 `migration-backup/` 建成 0500 让预检当场拦下
  - **安全闸是「先起 daemon 再开 GUI」**：daemon 由我带着 `LARK_NEST_DIR` 起在副本上并用 `/api/instance` 验过 `nest_dir`；GUI 若环境变量没生效，它比对 nest 不一致会**弹框中止**（不 spawn、不碰真库）。真库复验：`user_version` 仍是 **2**，七首歌仍是 `song.mp3`
  - 用户实测五步全过：环境暂停屏 → chmod 后点「重新检测并继续」→ 进度跑 → 卡在 file op 的列表 → 处理完**窗口自己切回曲库** → 设置页备份区块的数字与按钮都对
  - 🐛 **顺手抓到一个与迁移无关的老缺陷**（本次修复）：`mainWindow` 只按 `!== null` 判活，而**被销毁的 BrowserWindow 仍是一个正常 JS 对象**——窗口被销毁（渲染进程被杀、teardown 里挨了 SIGTERM）之后，下一次点 dock 触发 `activate` → 对尸体调 `show()` → 未捕获异常打死整个 app，**留下一个关不掉的错误弹框**（关它的那个进程刚死）。收敛成 `window-ref.ts` 的 `WindowRef`：**每次用的时候问，不记**（`isDestroyed()`），`closed` 事件只是顺带清引用，且旧窗口的事件不许把新窗口清掉
- [x] **T4a 导入矩阵的夹具**（2026-08-14，`fe93897`）— 矩阵要覆盖 ALAC / ADTS / FLAC / Vorbis / Opus / 封面 / 双音轨 / 真视频 / 无音频，而 vendored profile 这九种**解得开、一个也编不出**。所以它们和 `tone-1s.mp3` 同源同理由：外部 ffmpeg（Homebrew 8.1）造一次、按 sha256 冻结、配方与来历写进 `scripts/fixtures/README.md`；取用走 `fixturePath(name)`，名字是联合类型（拼错是类型错误，不是几层之后的一句 ffprobe 抱怨）
  - **ipod muxer 会把音频挪到 stream 0**，`-map` 先给封面也没用（实测）：所以「音频不在 0 号」的真文件只有 `tone-1s-video.mp4`（h264 在 0、AAC 在 1）——它顺带成了**判据 60 的真文件证据**，序数 `0:a:0` 与全局 `0:1` 在这个文件上选出不同的流
  - **双音轨文件的容器时长是更长的那条**（2.0s），被选中的第 0 条只有 1.0s。夹具建好就把一个既有缺陷照出来了，见 T4b
  - **PCM 形态归 `toneWav()` 现造**（`pcm_u8/s16le/s24le/s32le/f32le` + **`pcm_f64le` 当被拒样本**）：这些纯 Node 写得出，没有理由入库
- [x] **T4b 导入矩阵**（2026-08-14，`5bd2096`）— 曲库只有一种格式，导入本来就是转换，所以问题从「这是不是 mp3」变成「这文件里有什么」。探测回答，`planAudioConversion` 决定 copy / copy-adts / transcode；这一批只做决策表表达不了的两件事：**哪些回答是拒绝**，以及**成功了还欠用户哪句话**
  - **三条拒绝，严格在前**：真视频轨（封面不算——mp3 与 m4a 普遍带封面）→ 完全没有音频流 → codec 不在白名单。顺序有实义：音乐视频两条都命中，而「这是视频文件」才是有用的那半句
  - **codec 白名单列的是「到得了的」，不是 profile 解码器全表**：`aac_fixed`/`mp3float` 从不作为 `codec_name` 出现，`aac_latm` 需要 profile 没建的 LOAS/TS demuxer。**`pcm_f64le` 是这条白名单唯一真正在拦的东西**——ffprobe 认得出它，ffmpeg 到了才说 `no decoder found`，拦在 spawn 之前才换得到一句关于格式的话
  - **扩展名不再判定**，降级成与文件对话框共用的一份清单（`IMPORT_AUDIO_EXTENSIONS`，两边不同步就等于对话框给的文件 daemon 不收）。所以**装着 AAC-in-MP4 的 `.mp3` 现在正常导入**并走 copy——daemon 那条「伪装成 .mp3 就拒绝」的老判据因此反了过来，现在它证明的是「按文件是什么收，不按它叫什么」
  - **`ImportResultData` 两臂各长一个字段**：`imported[].warnings`（丢了第二条音轨 / 无损源已变 AAC——**导入成功了，只是要说清副本不带什么**）、`failed[].error_code`。三个 `IMPORT_*` 码**单开一个 registry**：它们坐在 200 里，既到不了信封也到不了任务，塞进那两个既有闭集等于让 daemon 的状态表和 CLI 的 exit map 认领自己产不出的码
  - 🐛 **多音轨的时长记错了**（夹具照出来的）：容器时长是**最长**那条轨，而我们只留第 0 条——`probeAudio` 现在在「音轨 >1 且流自己报了时长」时用流的
  - **矩阵测试必须显式指向 vendored 构建**：`resolveMediaTools()` 默认挑 Homebrew，而这套判据的全部内容就是「我们要发的那个 profile 读不读得开」——在开发机上它会全绿地放走一个缺解码器的构建。`vendoredToolsDir()` 有就用它（`LARK_MEDIA_TOOLS_DIR`），没有再回落
  - **profile 守卫进了单测**（`media-tools/profile.test.ts`）：读 `vendor/ffmpeg.lock.json` 的 configure，断言白名单里每个 codec 有解码器、每个扩展名有 demuxer、`REQUIRED_CAPABILITIES` 全在、encoder 恰好只有 aac。T1b 已经裁过一次这个 profile，下一次裁不能把导入对话框还在提供的解码器裁掉——那种失败会以「某个用户的 flac 导不进来」的形式，在造成它的那次提交很久之后才出现
  - gate：`just check` · `just test` **2318**（core 937→961 / gui 401→402）
- [x] **T5.1 命名清洗**（2026-08-15，`817efe8`）— 那个复选框写着「原标题」，而两个分支存的是同一个字符串：收藏夹场景里列表标题**就是**视频标题，勾不勾都一样，所以没人能靠用它发现它坏了。「不勾就回退 LLM」只对关键词成立——注释描述的是链接路径上不存在的东西
  - **命名是提交者选的模式，挂在 target 上**：`original` 是 M3-7 原样（标题照存、UP 主当歌手，同一个 URL 永远同一首歌），`clean` 显式要那一次模型调用，读不出来就回退到同样这两个值。两条 wire 通道各自说清楚：batch item 带 `naming`，`/download/song` 带 `naming_mode`（链接必填、关键词拒绝——关键词没有标题可保留）
  - **模式故意不进 dedupe key**：进了就等于同一个视频下载两遍去存两个名字。所以「同一视频、另一种命名」是**拒绝**而不是合并——合并会让第二个提交者悄悄拿到第一个人的答案。全量预检跑在容量检查与歌单事务**之前**（判据 26）：merge 到第 40 项才发现冲突时，歌单已经建出来了
  - 🐛 **abort 必须重抛，而它的差别只在一种形态下看得见**：`inferSongInfo` 原本 `.catch(() => null)`，把取消当成「模型没答上来」降级。第一版测试**在没有修复的情况下也是绿的**——因为下游任何一次网络调用都会撞上同一个已 abort 的 signal，任务照样进 cancelled。真正的差别在**「这首歌本地已经有文件」**：那条路径上 resolveTarget 之后再没有网络，任务会一路走过 commit point 报成功，还把歌加进用户已经取消掉的歌单。判据 27 的夹具因此先下一遍、再下第二遍
  - **`llm_available` 进 capabilities**：理由与 `media_tools` 同源——没有模型时 `clean` 会被拒，客户端得能先灰掉它。GUI 弹框默认「清洗命名」（记忆上次选择，仍每次问），没配 LLM 时自动退回原标题并禁用
  - gate：`just check` · `just test` **2345**
- [x] **`tsc -b` 跳过 gui**（2026-08-15，`26e10d3`）— gui 的两个 project 没声明 `references`，于是 tsc 的 up-to-date 判定只比它自己的源文件与 buildinfo，**`@lark/shared` 的 .d.ts 变了它不重跑**：一个 wire 类型改动可以在 `just check` 全绿的情况下把 renderer 留在错的类型上，直到 gui 里恰好又有别的东西改动。**两个假绿叠在一起**——我当时用 `pnpm --filter @lark/gui exec tsc --noEmit` 复核，而 gui 根 tsconfig 是 `files: []` + references，那条命令**什么都不检查**。加上 references 后正反都验过：改坏 shared，`tsc -b` 现在会报出 gui 的错
- [x] **T5.2 阶段 + 字节进度**（2026-08-15，`f6bcc14`）— 状态行从第一个字节到最后一个都写着「下载中」，40MB 的歌在慢网上与卡住无从分辨。传输现在数字节，snapshot 与 `download:status` 同时带 `received_bytes` / `total_bytes`
  - **节流在 engine，不在传输也不在接收端**：只有 engine 知道自己上次发了什么。阈值 §4-d（≥500ms 且（≥1% 或 ≥256KiB））；**阶段切换先 flush 再归零**——停在 97% 的进度条比没有进度条更糟；终态也归零，否则已完成的行会永远显示 63%
  - **`total_bytes` 是 null 不是 0**：「不知道多大」和「空文件」对进度行是两个问题，两个渲染器分别回答（有分母给百分比，没有给 MB）
  - **`(state, stage, song_id)` 不再唯一**：字节进度是第四条轴，原来那条「相邻事件不得三元组相同」的不变量因此改写成「四元组 + 每个任务内 revision 单调」
  - **CLI 的 `Streams` 长出 `errLine` + `tty`**：TTY 同行覆盖（`\r\x1b[K`，收尾清行），非 TTY 每 10% 打点、无总量退化成每 5MiB 或每 2 秒，`--json` 全静音。阶段文案统一到主计划 §3.6-2，`converting` 改叫「处理音频」——0.3.0 起 AAC 源是重封装，同一个阶段干着百分之一的活不该自称转码
  - gate：`just check` · `just test` **2354**
- [x] **T5.3 下载面板 + cancel-all**（2026-08-15，`0856c3b`）— popover 换成独立面板（进行中 / 排队中 / 已结束三段），术语按 §3.6-3 冻结：**取消任务 · 清除记录**，删除歌曲不在这里
  - **`POST /download/cancel-all` 先 snapshot 再逐个**：取消会释放 worker、worker 会拉起下一个排队任务，边读活列表边取消就是追自己的尾巴。逐项返回，因为三种结果本来就不同——排队的当场停、运行中的是「已请求」（返回时仍是 running）、过了 commit point 的**取消不了**（那是一首下完的歌，不是抗命），toast 照实说
  - **「清除记录」是客户端的**：它说的是这个窗口的列表，不是 daemon 的 ring——另一个窗口有它自己「读过什么」的账
  - 🐛 **`排队中` 既是分区标题又是任务状态文案**，`getByText` 直接撞出两个命中。分区标题改成 `<h3>`（role=heading）才分得开——顺带也是屏幕阅读器该有的结构
  - gate：`just check` · `just test` **2363**
- [x] **T5.4 协议定稿 v6**（2026-08-15，`66b51e5`）— 真正需要版本闸的只有一条：`/download/song` 现在**必填** `naming_mode`，而 v5 daemon 会把它当未知字段拒掉。其余（字节进度 / `naming` 阶段 / cancel-all / `/api/audio-migration`）都是增量
  - capabilities 补齐 `audio_format` 与 `import_formats`（`llm_effective_format` 是 §7 的 F5，留在 T5b）；`accept-pack` 里两处字面量 `5` 同批改——0.2.0 的教训就是写死在验收脚本里的协议版本只会在发版当天红
  - 判据 32 特意写成字面量 5 而不是 `LOCAL_API_VERSION - 1`：它说的是「0.2.x 那个 daemon」这件历史事实
  - gate：`just check` · `just test` **2365**
- [x] **T5b F1/F5/F7 三个「保存了但没人接手」的设置**（2026-08-16，`fa5b6b0`）— 共同的形状：写盘成功、回读正确、界面照常，而**真正持有这个设置的东西没被告知**
  - **`sync.interval_min` 只在 boot 读一次**：timer 一直按旧周期跑到重启，而设置页、config 文件、`GET /config` 三处都说新值。triggers 暴露 `rearmScheduler`，PATCH 只在值真的变了时调（同值再保存不该重置周期）。**重新计时而不是缩短当前周期**——「每 5 分钟」从你按下保存那一刻算起，这既是用户的意思也是更好守的承诺
  - **缓存上限调小无人触发清理**：三个触发点里没有「用户刚把它调小」。只有**变小**才排清理，且 `0 = 不限` 是最大值——从 0 改成 900 是缩小，纯数值比较会读反
  - **`llm.api_format` 无域校验**：客户端只认 `anthropic`，其余一律当 OpenAI，所以一个拼错的值会被保存下来然后**静默说错协议**。收成闭集（进来时拒、从盘上读到非法值时收敛回 `''` = 跟随 aviary，而不是收敛到某个没人选过的协议）
  - **测试要能看见 timer**：判据 35 用真定时器 + `vi.useFakeTimers`，断言的是 `tickScheduler` 的**调用节奏**而不是同步轮次（轮次还要有 session，那是另一件事）。反向验过：去掉 re-arm 这条测试变红
  - gate：`just check` · `just test` **2375**
- [x] **T5b F2/F3/F9 冲突恢复与它的说法**（2026-08-16，`2c490f6`）— 「保留本机」在没有本机 payload 时把 `'{}'` 解析成七个 undefined，每个字段回落成现值，**bump 一次 LWW 并推一条什么都没改的更新**，同时告诉用户你的版本回来了
  - **拒绝写在 core**：GUI 禁用按钮只是礼貌，CLI 和旧 GUI 也得挡住。「保留远端」不需要 payload，所以两者里只拒一个
  - **差异表漏了 `source_provider` / `source_key`**——而它们是 `apply.ts` 判定冲突的七个字段里的两个，于是「只有链接不同」的冲突渲染成一个表头加两个按钮；两边完全相同时也有兜底文案
  - toast 把 `applied` 说成「拉取」——夹具恰好 `pulled === applied`，所以它一直读起来是对的
  - gate：`just check` · `just test` **2385**（含 GUI 侧）
- [x] **T5b F4/F5-UI/F6/F8/F17 GUI 的五处**（2026-08-16，`444fe7c`）— 「去登录…」落在常规 tab（Tabs 改受控，开门的人指定房间）· `api_format: ''` 被显示成 openai 且选一次就回不去（`''` 成为独立选项并带上它当前解析成什么；**Radix 不许 `Select.Item` 的 value 是空串**，替身翻译只发生在这一个 Select 的两端）· 清了 key 的占位符没提 aviary 回退 · 歌词偏移归零时 badge 卡住 · 右键三项在多选时只作用于右键那一行
  - **同一个词既当分区标题又当状态文案就会撞**：面板那批已经踩过一次，这批的教训是**测试要顺着真实的门走**——判据 38 断言的是「点了『去登录』之后 tab 是 sync」，而不是直接 set 一个 store 字段
- [x] **T5b F11–F15 CLI**（2026-08-16，`ba187f1`）— `--allow-partial` 只在收藏夹分支被读，`--batch` 与单链接下**收下即忽略**（正是这批要清的形状）；`--json` 成功路径三处 stderr 泄漏；`--direct` 只查长度所以写得进 HTTP 会拒的空名/未 trim 名；`skill export -o` 不问就覆盖而 `playlist export -o` 会问；`songs list --duplicates` 放行改不了输出的 `--sort/--order`
  - **两处 `--allow-partial` 的拒绝时机不同**：`--batch` 在参数形状层就拒（不碰 daemon），而「单个输入是不是列表」只有 parse 之后才知道，所以那条要多花一次分类——**两条都说，不留一条静默**
  - `--direct` 对齐的是**路由的语义而不是 core**：sync apply 的远端写路径不受本地输入边界约束
- [x] **T5b F10/F16 最后两处**（2026-08-16，`916d750`）— `view.title` 是 bilibili 那边唯一没过 `decodeEntities` 的标题，0.3.0 让它开始要紧（`original` 命名把这个串原样存进曲库），UP 主名同路；logger 头注释说文件轮转服务「daemon/GUI」，而 GUI 从来没有自己的 logger
  - **一条计划里当年就写错的话也改了**：`2026-08-05-m4-gui-base.md` 把「不勾原标题 → 回落 LLM/视频自身标题」写成契约，而链接路径上根本没有 LLM——它记录的是这个缺陷本身，所以就地批注而不是删掉
- [x] **T5b 收尾清理**（2026-08-16）— 删掉三个没人消费的导出（`progressLabel` 只被同文件用、`IMPORT_FILE_ERROR_CODES` 只用来派生类型就该是纯类型、两个没人 import 的类型别名）；清掉 `/var/folders/.../lark-*` 下 22 个残留测试 nest
  - **那些残留是「跑挂的测试」留下的，不是代码漏了 `rmSync`**：11 个前缀 × 2 次，时间戳正好对上两次红的 `just test`——`pnpm -r` 一个包失败会杀掉并行的其它包，它们的 `afterAll` 就没机会跑。全绿的运行零残留（今天的几次都验过）
- [x] **`accept-m5` 自造 imported 夹具**（2026-08-13）— 缓存段测的是「导入永不被回收」这条不变量，夹具却一直借用户库里的 imported 歌，于是一次清库就把产品验收变成了别人听歌习惯的人质。改成自己 `POST /songs/import` 两份入库 mp3 夹具（一份 pin 一份不 pin，后者证明「不 pin 也没被动」），**seed 失败直接 throw 而不是判据红**——0/22 看起来像产品坏了，实际是 harness 没起步。仍是 **22/22**（实跑：evicted 8 / freed 50.9MiB / 2 个 import 全活）
  - ⚠️ **`accept-pack` §3f 仍是 M4A→MP3 闭环**，用的是 libmp3lame：T1b 删 LAME 之后它必红。子计划 §1.2 已把 accept 系列字面量归到 T5 定稿批 + T6 复核，别等到发版当天才发现

- [x] **T6a 验收脚本复核**（2026-08-17）— 四处**真问题**，都是「判据没跟着协议走」的同一种病，只是发作点不同
  - **判据 55（spike 换 m4a）根本没做过**：spike 的 fixture 还是 30 分钟 mp3、harness 还在断言 `audio/mpeg`——它在验证一个 lark 已经不说的协议。换成 AAC/mp4（`+faststart`，实测 `moov@32 / mdat@311063`），server 的 Content-Type、harness、`--smoke`、accept-gui 的 FIXTURE 四处跟着走。`just spike-media-check` 全层过（真 fixture + 节流 + Electron smoke）
  - 🐛 **五个 accept harness 全都会在迁移窗口里开始断言**：它们都跑在真库副本上，而副本是 schema v2——daemon 一开它就当场转音频，这段时间 `/status`、`/api/instance`、`/api/capabilities` 答 200 而**业务路由全 503**。新增 `scripts/lib/library-ready.mjs`：等到 `phase === 'normal'` 才往下走，`blocked_environment` / `needs_attention` 直接抛（这两个状态自己变不成 normal，等下去只会耗光超时）。accept-cli 的「一次 daemon 启动完成升级」尤其要它——`lark daemon` 在**服务之前几分钟**就返回了，原样 `stop-daemon` 会把副本停在半程
  - 🐛 **accept-m5 的下载请求还是 v5 形状**：T5.1 之后 `/download/song` 对链接必填 `naming_mode`，它没带，实跑当场炸在 `task_id undefined`。这正是 0.2.0 那条「写死在验收脚本里的协议版本只会在发版当天红」的第二次发作，只是这次是**字段**不是版本号
  - 🐛 **accept-sync 有两条判据在拿用户的听歌习惯当夹具**：E5 要一首「不可重下」的歌（imported），而 8-13 清库之后一首都没有了；D3 断言 `backfill == 全库`，可副本里本来就躺着 6 首歌的**未推送 `create`**（正常写入都会 emit，与绑定无关）。E5 改成自造两个 imported 夹具（accept-m5 §5 的教训晚了一个版本才走到这里），D3 改成断言**没有歌被漏下**（`backfill.songs == 缺 create 的数量`，且登录后每首都有 create）——F3 是 E5 的下游，跟着回绿
  - `sync.files.e2e.ts` 的导入夹具原来指着 spike 那个 **gitignored** 的 30 分钟文件，改用 tracked 的 `tone-1s.m4a`
  - 🐛 **发版当天门禁复跑又抓到两处**：① `accept-cli` 的 §6-13 把**真实收藏夹的条目数写死成 4**，而那个收藏夹现在有 5 个视频——`0 5/4`，全部成功却判红；判据真正要说的是「一个 URL 展开成了若干项且每项都落到终态」。② `accept-gui` 判据 6 偶发 `t=2.7`：**harness 只等 9 秒，而恢复状态机自己的截止时间是 10 秒**（`RECOVERY_TIMEOUT_MS`），慢一次的重挂（限速链路上重读 `moov`）就会被量在半路。改成轮询「位置回到重启前」而不是猜秒数——复跑报 `t=1127.2 (was 1127.0)`，恢复其实是精确的
  - **两条都是同一类**：判据不该把「此刻恰好如此」当成契约——远端列表的条数、一次重挂要花多久，都是环境而不是产品的承诺
  - gate：`just check` · `just test` **2396** · accept-cli 27/27 · accept-m5 22/22 · accept-gui 15/15 · `test-sync-e2e` 19/19（真 server，没 skip）· `accept-sync` 33/33 · `fetch-ffmpeg --verify` 三条闭环
- [x] **T6b 判据 33：真实副本库迁移闭环**（2026-08-17）— `just backup-nest` 复制真库（7 首全 R 类）→ 带 `LARK_NEST_DIR` 起 daemon → **7/7 done**，`lost / blocked / kept_unconverted / asset_missing` 全 0
  - 磁盘复验：**0 个 mp3 / 7 个 song.m4a**，歌词全在，`migration-backup/` 空（R 类的原件是验证过产物之后删的，本就不留备份）；schema **v3**、ledger 七行全 done；逐首时长对得上（`219.05068 → 219.050000`）；`/audio` 回 `audio/mp4`，200 与 206 都对
  - **真库复验**：仍是 7 个 `song.mp3`，`--direct` 读它仍报 `MIGRATION_PENDING`（`user_version` 未动）
  - 顺手把 **F7 的另一半**验了（判据 41 此前只有单测）：上限从「不限」改成 10MB，**不重启、几秒内** 128.9MB/29 文件 → 7.8MB/11 文件，导入与歌词那 111KB 不可回收部分一动不动
- [x] **T6c 用户手测 T4 / T5 / T5b**（2026-08-17）— 清单 `docs/plans/2026-08-16-v0.3-manual-test-checklist.md`（导入矩阵 16 条 + 命名 7 条 + 进度 3 条 + 面板 4 条 + T5b 六处 + 收藏夹 smoke），环境是真库副本 + 14 个编号夹具。功能全过，**但用出来六处产品问题**，逐条修完
  - **下载列表说不出自己在下什么**：行首是「已有歌曲」或一条裸链接。wire 给任务加 `title` / `artist`（快照与 `download:status` 都带）——从歌曲出发的任务**入队即有名**，链接在 `naming` 解析出结果那一刻有名；命中库里已有歌时显示**那首歌自己的名字**（下载不改名，列表也不该说它会）
  - 🐛 **顺手抓到 T5.2 的漏装**：GUI store 处理 `download:status` 时只写 state/stage/revision，**把 `received_bytes` / `total_bytes` 丢了**——字节进度只有整表刷新时才动，正常下载全程不显示数字。这正是清单 3.2 想验的东西，而它一直是隐形的
  - **同一首歌两行长得一样**：下载与它派生的歌词是两个任务，统一名字之后就成了同一行出现两次。行首加类型标签（`歌词` / `重新下载` / `按需下载`），普通下载不带标签——每行都挂个标签等于没标
  - **面板排序**：进行中 / 排队中按队列顺序（先提交在上，一批四十个不会在你看的时候自己动），已结束**最新在最上**；取消掉、没有 `finished_at` 的按提交时间排
  - 🐛 **队列顺序是「先跑完所有下载，再跑所有歌词」**（用户怀疑，实测证实：先写断言再改代码，红的那次打印 `['download','download','lyrics']`）——单 worker FIFO，而歌词续作是在下载成功后 `push` 到队尾的。改成**续作插队首**（`runNext`）：每首歌音频+歌词齐了才轮到下一首；手动排的歌词任务不插队
  - **键盘路径**：命名弹框打开时焦点落在记忆的那个选项上（Radix 默认聚焦第一个可聚焦子元素 = 取消，第二次回车会把提交扔掉），←/→ 切换且高亮跟着焦点走；批量弹框焦点给「确认下载」。**批量那处第一版没修对**——收藏夹路径下列表还在加载、按钮禁用，effect 在加载完成后放焦点所以看着是对的；而**粘多个链接**不需要请求，按钮开局就可用，于是 Radix 的 FocusScope 在 mount effect **之后**又抢了回去。改在 `onOpenAutoFocus` 里接管，并把测试改到那条路径上（去掉修复即红）
  - **横条状态行**：加任务名（`max-w-56` + `truncate`，一条没解析出名字的长链接不许把阶段与取消按钮挤出行）与「还有 N 个排队」（N 不含正在显示的那一个）
  - **点击判定两处**：第一列整格都是复选框的目标（以前点格子空白会冒泡到行，把二十行的多选塌成一行）；歌名/歌手**只有文字本身**可双击改名（那个按钮原来 `block w-full` 撑满整格，短标题右边的空白也成了改名区），空白重新归行——双击 = 播放
- [x] **T6d 歌词慢：瓶颈实测**（2026-08-17）— 用户报「下载歌词很慢」。分段计时（deepseek-v4-flash，9 个候选）：三平台并发抓取 **1.0 / 1.8 / 3.3 秒**，**LLM 选优 2.3 / 16.6 / 22.8 秒**，启发式 **1–2ms 且三次都与 LLM 选了同一个**
  - 它用的是通用 `llm` 超时 **60 秒**，而这一步的兜底（`pickByHeuristic`）是确定性的、1ms 出结果——配比本来就错，而 T6c 把歌词插到每首歌后面之后它才成为必经路上的等待。新增独立超时 `lyricsSelect = 10s`；测试用一个永不回应的 fetch 验「40ms 后拿到启发式结果且总耗时 < 2s」（仍挂在 60s 预算上这条会红）
  - **记录不改**：每个歌词平台内部是 `for … await`（搜索 + 最多 3 条逐条取），并发化约省 0.5–2 秒，但它不是瓶颈，而且要对人家接口多开三倍并发——单独开批再说

- [x] **T6e 发版 0.3.0**（2026-08-17）— 九步照 M7 §3.5 走完，零偏离。[Release](https://github.com/orpheus-aviary/lark/releases/tag/v0.3.0) + [`@orpheus-aviary/lark-cli@0.3.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)，tag → **`9cf9d97`**
  - 门禁（全部跑在**将要发布的那个 HEAD** 上）：`just check` · `just test` **2419** · accept-cli 27/27 · accept-m5 22/22 · `test-sync-e2e` 19/19 · accept-sync 33/33 · accept-gui 15/15 · `fetch-ffmpeg --verify` 三条闭环 · **accept-pack 28/28**（对着固定产物）
  - 产物：`Lark-0.3.0-arm64.dmg` 147,776,045 字节 sha256 `0dfd78c0950b492c5d11113fa46945cadda480d6b6afb8ea5edc0ceb3481a59f` · `orpheus-aviary-lark-cli-0.3.0.tgz` 517,752 字节 sha256 `1c938ed9bb3dd968817910a9bbc88fce7b7df97661d437b1eca59993761043c9`（npm 上的 shasum `f4b3617a…` 与 dry-run 一致）
  - **复跑门禁不是形式**：accept 系列是在 T6c/T6d 的改动之前跑过的，复跑当场红了两条（收藏夹条数、9 秒等待），修完才允许打包——「发布物与已验收 HEAD 严格绑定」这条规矩今天真的拦下了东西
  - 记录同步：`README.md`（版本 / 两种单向升级 / m4a 与导入 / 清洗命名）· `apps/cli/README.md`（升级警告 + `--clean-name`）· CLAUDE.md 状态段与实测锁定 · 本文件。**跨仓同日跟进**：`../aviary/docs/{ROADMAP,DESIGN}.md`（主线图多一步 Phase B 移动端）与 `../.github/profile/README.md`，各自单独提交

## Phase B Android 移动版（`apps/mobile`）

主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` §4（D1–D17）+ N0 子计划 `docs/plans/2026-08-17-phase-b-mobile-n0.md`（**v4**，三轮评审定稿：判据 1–26 / 决策 a–l / R1–R5）。批次 N0a → N0b → N1 → N2 → N3 → N4 → N5 → N6；**N1 起每批开工前另出子计划**。

**版本口径**：APK 独立版本线 0.1.0 / versionCode=1（D14）。桌面 Phase B 期间不必发版；N1 的重构落 main、随下个桌面版本自然发出。中途若发桌面 0.3.x，先复跑 accept 全系列。

**当前状态（2026-08-17）**：**N0a 全部 + N0b-1 + N0b-2 + N0b-3 已完成**。桌面测试 **2480**（加 `@noble/hashes` 之后复跑，逐包相等）；真机 vivo V2408A / Android 15（档案见子计划 §9）。**D4 出口已冻结**（expo-sqlite + per-call transient shim + drizzle 走 `pnpm patch`）。**N0b-3 的 release 实测**：冷启动余量两个数量级（2k 库开库到首屏 max 29.93ms / 预算 3s）· backfill 500 首一段 64.36ms（p95）· **apply 的生产批 500 过不去（p50 164ms），暂定 200/批**（72.98ms）· md5 端口 0.02ms 远超预算，**sha256 的阈值改绑真实歌词尺寸**（1.94ms / 预算 10ms；256KB 上限的 86.81ms 作为标注最坏值记录，用户拍板） · **`globalThis.crypto.getRandomValues` 不存在**、`atob` 与 `Buffer.from(base64)` 在 7 个样本里 2 个发散 → 两者都必须走端口 · **`globalThis.fetch` 就是 `expo/fetch`**，manual redirect / 204 / 流式 `res.body` 三条全过（N1 不必为 fetch 做注入选型）。**N0b-4a 已完成（2026-08-18）**：判据 **22 四条硬 gate 全绿**（login / pushChanges / pullChanges / refresh，SSE 软判据也全绿——桌面 nudge 推的change 经 `onChange` 到达、`unsubscribe` 后零帧）· 判据 **23 双网络各一遍全绿**（md5 端口复现 core 的 `w_rid`、签名 search URL、免签三端点，Wi-Fi 与电信 5G 结果一致）· 判据 19 的**流探针一半**完成，两条实测：**流 URL 只在签发它的那张网上有效**（playurl 按调用方 IP 派节点，桌面签的 `cn-bj-cc-*` 在 5G 上连不上，`adb shell curl` 独立复现），**最低 header 要求按节点而非按平台**（cc 节点缺 `Referer` 403；移动网络派来的 mcdn `:8082` 节点零 header 也给 206，content-type 是 `application/octet-stream`）。音频夹具已产并 push（短 2:17 取自用户收藏夹最短一条；长 37:07 收藏夹里没有，另搜）。

**N0b-4b 已完成（2026-08-18）——D17 出口冻结：raw fMP4 直存达标，GO，不需要 remux**。两条 bilibili 原始字节在 ExoPlayer 上加载 119ms、**时长与 ffprobe 逐毫秒相同**、seek 0/25/50/95% 偏差 ≤0.001s、37 分钟长曲 95% 处 0.256s，单 player 与 playlist 各一遍；后台+锁屏 **330.6s 播放推进 329.9s 零暂停**；锁屏元数据与媒体键（`MEDIA_PAUSE`/`MEDIA_PLAY`）可用；焦点瞬时抢占自动恢复（bilibili 请求 `GAIN_TRANSIENT`）、永久抢占（网易云完整 GAIN）停住且不自恢复。§3.2 的三级兜底一级都没进。**两条红都不是存储格式问题、归 N3**：① **蓝牙断连不暂停而是转外放**（media3 的 `handleAudioBecomingNoisy` 默认关、expo-audio 未暴露，RN 侧也没有该事件 → 要打补丁或自建小原生模块）；② **`release()` 不先 `pause()` 留下停不掉的音轨**（#47569 在 57.0.3 上实证仍在，只有 `am force-stop` 能收 → pause-before-release 是硬要求）。

**N0b-4c 已完成（2026-08-18）——判据 24 绿（软），D13 入口形态不降级**（`expo-share-intent@8.0.1` + `expo-linking@57.0.6`，release 构建）。真 bilibili **8.83.0** 视频页 分享 → 横滑出「更多」→ 系统 chooser 里 **「lark spike」在列** → 点它 → spike **冷启动 +15ms** 收到并原样显示 `莫愁乡--（OfficialMusicVideo）亚细亚旷世奇才 https://b23.tv/cfzPKZX`；系统解析器侧的客观证据是 67 个 text/plain SEND handler 里有我们。合成矩阵三条路径（冷启动 / 后台存活 / 前台 onNewIntent）全绿，文本由主机**逐字符回读比对**（CJK · 换行 · emoji · `?p=2`）。**四条实测**：① **分享文本里没有 bvid，只有 b23.tv 短链**且 `EXTRA_TITLE` 为空 → N4 的添加页在展开短链（一次 `redirect:'manual'` 往返）之前识别不出任何东西，必须有「正在解析」态；② **收藏夹的分享直接进 bilibili 自己的发动态发布器**，到不了系统面板 → 收藏夹/合集只能靠粘贴框；③ **`performance.now()` 在 RN Android 上是 `SystemClock.uptimeMillis()`**——不从 JS context 起算，且**深睡期间不走**（实测与 `/proc/uptime` 差 13.5 小时 = 手机睡的那一夜），跨熄屏算「过了多久」不能问它；④ **payload 是易失的**（`resetOnBackground` 默认开，切后台即清），添加页必须挂载即消费。

**N0b-5a 已完成（2026-08-18）——判据 26 绿，D16 机制落定**。**零写打开取候选 ①（copy-then-open）**：50.2MB 库 copy+open+读 install_id **max 75.36ms**，带 4.0MB 热 WAL 时 **max 149.51ms**（预算 500ms），两组的**原件 size+mtime 五轮前后逐字节不变**，而恢复确实落在副本上（副本的 `-wal` 4,128,272 → 0 字节）；racing-writer 反测 → `FailClosedError`。**no-backup 侧取 SecureStore**（`requireAuthentication: false`），**卸载重装后读不出**，判定落到「fresh」。**backup 排除三层客观判据 10/10**（`just spike-mobile-backup-audit`）：APK 的 merged manifest（`allowBackup=false` + 两个属性经资源表翻回名字确认指向我们那两份）· 两份规则文件各 9 个 domain（`<cloud-backup>` 与 `<device-transfer>` 都有）· `bmgr backupnow` 答 **`Backup is not allowed`** 而同一轮控制组答 `Success`、`dumpsys backup` 里没有我们、restore 回 `0 packages`。**四条实测**：① `allowBackup=false` 只关云备份、关不掉 D2D（那要 `<device-transfer>`）；② **expo-secure-store 默认会抢那两个 manifest 属性**，必须 `configureAndroidBackup: false`，我们的 plugin 见到被占用直接抛错；③ **证据要取在能观测到的那一刻**——第一版查「副本旁边有没有 `-wal`/`-shm`」恒为假，因为关闭连接本身会 checkpoint 并删掉它们；④ **一个 `Uint8Array` 既是值也是对象**，shim 把它当成命名参数表（`bound key '0' …`），已修并在契约补一条 lone-bytes 用例（core 1046 → **1047**，全仓 **2481**）。缺口如实记：设备 API 35，`fullBackupContent` 那条老路只能静态检查；完整 D2D restore 与 fail-closed 分支仍归 **N2 gate 的四组**。**N0b-5b 已完成（2026-08-18）——判据 25 绿，N0b = GO，Stage-2 已落**。**D14 落定**：applicationId `com.orpheusaviary.lark` · APK 0.1.0 / versionCode 1 · keystore `lark-release.jks`（PKCS12 / alias `lark` / RSA 4096 / 有效期至 **2054-01-03** / 证书 SHA-256 `38:54:4C:9F:…:F6:3D`）· **决策 g 由用户拍板**：keystore 与密码**同放** `orpheus-aviary/android-keystore/`（git 仓之外，0700/0600，**不进钥匙串**，每次构建现读，备份由用户拷 U 盘）· **恢复演练过**（整个目录拷走，只用副本签 APK，`apksigner verify` 的指纹逐字符相同）。**政策快照**（查官方页与 FAQ）：2026-09-30 只覆盖巴西/印尼/新加坡/泰国的参与商店，**adb 安装明确豁免**，测量设备在中国不在首发之列，**2027 全球扩大**才相关；真要注册时 **limited distribution account**（免费、无政府 ID、上限 20 台）匹配，注册对象是包名 + 证书 SHA-256。**判据 14/16 因契约扩了一条用例而复跑**：expo **57/0/0** · 漏版反测 55/2 · op-sqlite **51/0/6**。**两条实测**：① **Gradle 的 bundle 任务看不见 `packages/core/dist` 的变化**（core 重建了，APK 里还是旧的，面板上连断言文案都是旧的），release recipe 因此先删生成的 bundle 再构建；② **同一个「Uint8Array 既是值也是对象」的歧义把两个适配器都咬了**，op-sqlite 那边更安静（blob 什么也没绑上、列读回 NULL）——正说明这条该由契约说一次。**GO/NO-GO：GO**（判据 11–26 全完成、gate 全绿、三条 NO-GO 线一条没碰）。

**N1 进行中（2026-08-18 开工）**——子计划 `docs/plans/2026-08-18-phase-b-mobile-n1.md`（v4，决策 a–q 全关，九批 N1a–N1i）。**N1a–N1i 已完成**（判据 22 的「对新构建产物复跑 accept 全系列」尚未做），桌面测试 **2481 → 2532 → 2571 → 2576 → 2578**；Metro 图 36 → 51 → 80 → 90 → 94 → **97 个 portable 模块**，且 bundle smoke 自 N1i 起就在 `just check` 里（整条 ~9s）。**N1h 之后，一台手机能解析的 core 包含 sync 全图、library 全图、SyncCoordinator、LibraryService 与整条下载编排**——`@lark/core/portable` 之外只剩真正属于这台机器的东西：`db/` 的打开与锁、ffmpeg 与落盘协议（`download/{audio-landing,ffmpeg,resolve,import}.ts`）、file-op 执行器、config、logger、paths 根解析，加上 daemon 的定时器/SSE 壳与 wire 层。**只剩 N1i**（守卫收编 + R1–R5 + D5 分段冻结）。

**N2 子计划已出（2026-08-19，v1 → v2 → v3，两轮评审收敛）**——`docs/plans/2026-08-19-phase-b-mobile-n2.md`，七批 N2a–N2g / 判据 22 条，修订对照在子计划 §8 与 §8.1。**两轮评审的性质相同：都不是「写漏了」，是「按它实施会红」。**

**N2a 已完成（2026-08-19，`b5c95f5`）——`apps/mobile` 立项**。Expo 57 + CNG，applicationId `com.orpheusaviary.lark` / versionCode 1 / **minSdk 26**（决策 a），`plugins/with-backup-rules.js` 从 spike 复制一份（`apps/` 不 import `spikes/`）。**判据 2/3/4 绿**：与 spike 共有的依赖逐字节同版（`react-native 0.86.2` 对得上 Expo 的 `bundledNativeModules.json`），三条反测各自点名——barrel import 报 `apps/mobile/src/App.tsx:16`、`node:fs/promises` 由 Metro 打出 import stack、非 portable 的 core 模块由 escapee 检查点名。**两条守卫作用域从 spike 扩到 spike + mobile**（`check-spike-mobile-imports.sh` → `check-mobile-imports.sh`；bundle smoke 建两个 bundle），驱动脚本改吃 `LARK_PACKAGE` / `LARK_APP_ROOT`。`just check` 8s 上下、`just test` **2578 不变**。**判据 1（真机装起显首屏）等手机**。

**N2b 桌面那半已完成（2026-08-19，`eb6a28e`）**：`ensureDeviceUuid` 下沉为 `portable/db-identity.ts`（桌面 `db/index.ts` 改调它并保留 re-export，25 条 `db/index.test.ts` 与两套 daemon e2e 一个字没改）；§2.4 的打开分派落 `portable/open-library.ts`，拆成 **`classifyLibrary`（零写，步骤 ③ 跑在副本上）+ `prepareLibrary`（步骤 ⑦，`onVerdict` 钩子是宿主唯一被允许设 WAL 的时刻）**——放 portable 而不是 `apps/mobile`，就是为了让六格在桌面 test runner 上跑得起来。**六个变异逐条验红**，其中一个抓到自己的测试有洞：converge 用例第一版只断言返回值、没断言持久化，于是「mint 了不落库」是绿的（已补 `expect(stored()).toBe(after)`）。判据 7 的「`core/migration/` 不进图」排在通用 escapee 规则**之前**，否则它是不可达的死代码——`core/migration/`（桌面 ffmpeg 那套）与 `core/portable/migrations/`（schema 链）差一个字符、结论相反。桌面测试 2578 → **2596**。

**N2b 真机验收（2026-08-19，release 构建、冻结设备 V2408A / Android 15 / API 35）——判据 1 绿 + 自检 6/6**。`com.orpheusaviary.lark` 与 `…lark.spike` 同机共存、MainActivity 在前台、首屏三行都在（`schema v3` / `protocol v6` 是从 portable 与 shared 真读出来的，说明 97+ 个 portable 模块在真机上真的解析并执行）。APK 合并 manifest：`minSdkVersion=26` / `targetSdkVersion=36` / `versionCode=1` / `versionName=0.1.0`。数据层自检六条全过：fresh 到 v3 · `0003` 的标志清成 `'0'` 且行还在 · 重开是 `current` 且不动标志 · **步骤 ⑨ mint 出的 uuid 重开还在且幂等** · **收敛后第一次写抛「device_uuid is missing」、跑完 ⑨ 才写得进（新 uuid 与旧的不同——决策 j）** · 更高版本库被 `IncompatibleDbError` 拒绝。

- **第一轮是 5/6，红的那条是我自己的断言写反了**：`openLibrary` 按 §2.2 只做 ⑥⑦，**不产 `device_uuid`**（⑨ 归 N2c 的身份门），而用例假设「开完就该有」。修成断言真正的不变量（开完没有 → mint → 重开还在 → 幂等），并在桌面 `open-library.test.ts` 补一条「`prepareLibrary` 不 mint」守着同一件事。**面板的第一条红是它自己的断言——这正好证明它不是白跑的**。桌面测试 2596 → **2599**

**N2c 进行中（2026-08-19）——身份门的机制半边已接进启动路径**。`identity/{state,store,snapshot,converge}.ts` + `ports/credentials.ts` + `boot/sequence.ts`（§2.2 的 ①–⑫ 一条线一个文件），`App.tsx` 挂载即走 `runBootSequence()`——**到 N2c 才允许接持久化启动入口**，因为在此之前那等于一个会把恢复库当自己库打开的构建（§3）。**判据 19①② 真机绿**：第一次 `fresh` → 双侧写 `install_id`；force-stop 冷启第二次判 `normal`，install_id 与 device_uuid **逐字符不变**——这正是 v2 那个「第二次启动清掉自己刚建的库」的回归测试。

- **§2.2.1 的判定表做成纯函数并单独给 `apps/mobile` 配了 vitest**（`include` 只收 `identity/state.test.ts` 一个文件）：两轮评审的 bug 都长在这张表上，值得用秒级测试而不是「构建-安装-点按」去试错。10 条用例；两个变异验红——把「fresh 由身份判定」写回去（**v2 原样的 bug**）只有为它写的那条红，把 intent 降到 settled 行之后 3 条红
- **一个实现细节值得记**：intent **读不出来时当作没有是安全的**——它写在步骤 ⑤（DB 尚未被碰），落回 settled 行会重新推出同一个结论。intent 买的是幂等（同一个 id），不是正确性
- **converge 比 §2.2.2 的清单多做一件**：`bumpBackfillTarget`。`unbindLibrary` 清同样这些表时也 bump，理由相同——outbox 没了，活下来的东西必须重新发布。不做的话症状要到 N5 才出现，且表现为「同步正常但从不发送已有的东西」
- **步骤 ⑪ 的 boot drain 是注释占位不是空调用**：执行器归 N2d，塞一个 no-op 占位会让顺序看起来已经落实
**N2c 已完成（2026-08-19）——四组 gate 全绿**（16b 已搁置）。验收通道按决策 o 落地：**entrypoint 分叉在 Metro 的模块图上而不是运行期开关**（`metro.config.js` 在 `LARK_ACCEPTANCE=1` 时把 `./src/root` 重定向到 `./src/acceptance/root`）——这样「生产 bundle 里没有 `acceptance/`」才是**守卫查得了**的事，运行期开关永远查不了。两个 artifact 同包名同签名（`just mobile-android-release` / `just mobile-acceptance-release`），不能共存是决策 o③ 认下的代价。

- **判据 16a：10/10**（`just mobile-backup-audit`，真 APK 的 merged manifest + 编译后资源翻回名字 + `bmgr` 三层）。`<device-transfer>` 的九个 domain **在 APK 里是齐的**——搁置的 16b 是「走一遍手机搬家」，不是这份声明
- **判据 17 / 18 / 19②③④⑤⑥：真机 8/8**（acceptance artifact，release 构建）
- **守卫双向都验过**：从产品 import 一个 `acceptance/` 模块 → 红并点名；`LARK_ACCEPTANCE=1` 建出来的图里**必须**有 acceptance 模块（`just mobile-acceptance-smoke`）——**只有后一条能发现「分叉悄悄不分叉了」**，否则生产那条断言会永远绿而每次验收测的都是产品
- **第一轮 6/8，两条红是真 bug**：converge 崩在 DB 事务之后重启会整段重跑，所有 `DELETE` 幂等而 `bumpBackfillTarget` 不是（`backfill 1 → 3`）。判据 19④ 的「只清一次」当时读起来像措辞，实际是唯一能观测它的断言。修法见 `docs/LESSONS.md`
- **决策 o④ 收窄**：D16 自己的判据一条也不需要推文件——夹具在设备上**用真路径造真库再把身份拿掉**（那正是恢复干的事）；`adb push` 通道只服务判据 14 的真实桌面副本，随 N2f 落地
- **崩溃点用「抛」模拟**：持久化状态与真 kill 相同、点位是选的不是猜的；唯一差别（开着的句柄 / 热 WAL）如实记在 `d16.ts` 的头注释里，**到 N2d 的 drain 才重要**
- **步骤 ⑪ 的 boot drain 仍是注释占位**（执行器归 N2d）

**N2d 进行中（2026-08-19）——决策 a 的 native module 与两个端口已落地，判据 9 / 10②③ / 11 真机 7/7**（acceptance artifact，release）。`modules/lark-fs` 自建 Expo native module：一个 `moveAtomic`，`Files.move(REPLACE_EXISTING, ATOMIC_MOVE)`，**没有降级分支**（不支持时直接抛 = 判据 10④ 由实现保证）。判据 10⑤ 已由 APK 合并 manifest 断言 `minSdkVersion=26`。`FileSystemPort` / `PathsPort` 实现完成；`writeTextAtomic` 的临时文件是同目录兄弟 `.<basename>.<uuid>.tmp`，前缀可扫。

- **SDK 57 的 `expo-module-gradle-plugin` 既不推导 `namespace` 也不推导 `versionName`**，两个都要自己写；后者的报错是从 `node_modules/expo/android/build.gradle` 抛出来的，看着像 expo 自己的问题
- **三条红各逮到一个真问题**（无一是断言写错）：Expo 的 `AsyncFunction` 转换 lambda 返回值 → `Files.move` 的 `Path` 变成 `Unknown type: sun.nio.fs.UnixPath` · `just` 的 `*ARGS` 拆掉引号 → 一整组结果读的是另一块面板 · `installPortableRuntime` 里多余的 `installed` 标志缓存了 portable 拥有的状态，`resetRandomForTesting()` 之后永久失配。三条都在 `docs/LESSONS.md`
- **判据 11 是先意外撞上、再转成正式用例的**：验收入口不挂载即启动，于是 `no RandomSource` 自己冒了出来——端口按设计 fail-loud
- **判据 10①（gate）真机绿**（`just mobile-fs-instrumentation`，两线程 + barrier，2000 轮原子替换）。反测**正向断言自己看见了窗口**；把它指向 `AtomicMove.atomic` 后以自己写的那句话失败——**所以原子那条不是恒真**。顺带一个网络坑：`junit:4.13.2` 从 Maven Central 回 403（两个域名都是，Google Maven 与阿里云镜像正常），由用户在网络侧解决，不是构建配置问题
**N2d 后半（一）：控制面已进 portable（2026-08-19，决策 k）**。桌面 `FileEffectRuntime` 424 行拆成两半：调度与**四种 op 的语义**去了 `portable/sync/file-ops-runtime.ts`（drain / retry / discard / claims / 退避 / dead-letter / `deleteRemote` 的分支矩阵 / `locateAudio` / 空歌词即无歌词），桌面 `core/src/sync/file-ops-runtime.ts` 只剩 `nodeSongFiles()`（五个动词）+ 一个把宿主端口预置好的子类 + `recovered-songs/` 的两个 boot 扫描。**call site 一个字没改**（daemon context / boot / `--direct` 仍是 `new FileEffectRuntime({ sqlite, … })`）。

- **新端口 `SongFilesPort`（五个动词）而不是给 `FileSystemPort` 加方法**：后者是**文件级**的「用到的那点面」，而执行器要的是目录级的三件（删目录、把一个文件挪进 `recovered-songs/`、把整个目录挪进去）+ 两个存在性问题。分开之后，一个还没有 journal 要 drain 的宿主一眼能看出自己缺的是哪半。词汇沿用 `PathsPort`：只说 song id 与 quarantine **名字**，`join` 与 R10 都留在适配器
- **`quarantineExists` 是个问句不是 `moveIfAbsent`**：目标已存在意味着「移动发生过、崩在它之后」，该丢下剩余目录还是合并，是执行器的判断，不是宿主的
- **`LYRICS_FILE` 上提到 `ports/paths.ts`**：桌面 `paths.ts` 与 mobile `ports/paths.ts` 各拼各的 `'lyrics.lrc'`，而执行器现在要**按名字**搬这个文件——三处同一个字符串，收到一处
- **判据 12 的桌面那半：原 23 条 + 新 4 条全绿**（core 1175 → 1179，全仓 2599 → 2603；`just test-sync-e2e` 19 条不变）。既有那 23 条现在跑的就是 portable 的决策，**它们原样绿正是「零行为变化」的证据**
- **三个变异逐条验红，其中一个证明新用例不是凑数**：把 `keepLyrics` 写死 false → 红 4 条；**把 `locateAudio` 改成不查存在直接回首选名 → 只有新加的「崩溃重入」那条红**（原 23 条全绿——一个崩溃后会重复搬运的执行器能通过 N2d 之前的全部测试）；把「arg 读不出来」从抛改成静默成功 → 只有新加的 dead-letter 那条红
- **崩溃重入的造法**：不是 `kill`，是**只破一个动词**（`removeSongDir` 第一次抛）——那正是「进程死在两次宿主调用之间」留下的持久状态：文件已救出、目录还在、行还在。顺带这是唯一直接驱动端口缝的用例，而缝正是手机要替换的东西
**N2d 已完成（2026-08-19）——判据 12 真机 9/9，N2d 全绿**（acceptance artifact，release，冻结设备 V2408A）。移动端 `SongFilesPort` 五个动词落 `ports/song-files.ts`，启动序列第 ⑪ 步从注释占位换成真的 drain，`BootResult` 多带 `fileOps` + `drained`（N2e 的服务层必须复用**这一个** runtime——两个 runtime 管一条 journal 就是两套 claim 仲裁）。

- **expo 的两条 move 语义是照 `fsops/CopyMoveStrategy.kt` 读出来的，不是猜的，而且两条都被反测点着**：`File → Directory` 要求目标目录**已存在**（`prepareAsDestination` 抛 `DestinationDoesNotExistException`）· `Directory → Directory` 按目标存不存在分叉——不存在则源**变成**它（父目录要在），存在则源被**塞进它里面**。后者执行器永远不该走到，所以适配器把它变成显式抛错，而不是安静地嵌一层
- **判据 12③ 用的是真 SIGKILL，不是抛**——这笔债是 `d16.ts` 自己记下的（「a death in the middle of the file-op drain leaves half a file operation, which is not a database state at all」）。做法：面板把 drain **停在自己选的点上**（`removeSongDir` 里，两次抢救之后、删目录与删行之前）并显示 `PARKED`，`am force-stop` 打下去，重启后按 `local_metadata` 里的夹具断言。**点是选的、kill 是真的**——决策 o⑤ 要的那两件同时成立
- **四个变异逐条验红**：`quarantineSongFile` 不建目标目录 → 只有矩阵那条红（`executed 1 of 6`）· `quarantineSongDir` 不建 `recovered-songs/` → 两条红 · `removeSongDir` 去掉 `exists` 守卫 → **只有「四种 op」那条红，而且只因为我在写反测前刚补了那个用例**（见下）· **把第 ⑪ 步的 drain 删掉 → 12③ 与 12⑥ 双双红，12⑥ 的失败文案就是 `the boot drain executed 0 of the 1 waiting`**
- **两个用例是「想反测怎么破」时补出来的，不是跑红了才补的**：① `delete_song_files` 的 local 分支**不问 `songDirExists` 直接删**，所以「目录已经没了的本地删除」是 `removeSongDir` 唯一一个会收到不存在目录的入口——原来七条一条都没走它，`exists` 守卫等于没测；② `quarantineExists` 的 **true 分支**（移动发生过、崩在它之后）原来也没人走——造它要把重放的 op 指回**它自己的 target**，另起一个 target 的第二条 op 走的是「没东西可搬」那条路，证明不了任何事
- **顺带一条要如实记的**：D16 的判据 19⑥ 现在有了真的 drain 之后仍然绿，是因为它塞的那条 op 是 `song-x`（过不了 uuid 门）——它断言的是「收敛不动 `sync_file_ops`」，**「并由第 ⑪ 步执行掉」那半由判据 12⑥ 覆盖，不是 19⑥**
- **`recovered-songs/` 的空目录清扫（桌面的 `pruneEmptyQuarantines`）移动端没做**，理由：唯一会造出空目标的是 `quarantineSongFile` 的「建目录后崩」，而那条路径的重放**不查 `quarantineExists`**（只有 `quarantine_song_files` 查，且它的目标是被 rename 本身创建的），所以空目标只是不好看、不会让任何判定说谎。桌面清它是因为 `countQuarantined()` 会把它算成一次隔离——**N5 加徽章时要一起把这条补上**

**N2e 已完成（2026-08-19）——判据 13（gate）真机 18/18**（acceptance artifact，release）。`services/library.ts` 组装 `createLibraryService`，四件依赖**全部来自 `BootResult`**；`acceptance/library-contract.ts` 是第三个 hook，**`cases.ts` 一个字没动**（`services/contract/index.ts:6` 那句承诺兑现）。

- **`files` 也上提进 `BootResult`**：端口明写这一对要「作为调用方已经收到的那个 context 的字段」一起走，就是为了不让两处各造一份模块全局。第 ⑪ 步要它，服务层也要它——同一个 `fileOps` 的理由，同一句话
- **hook 的翻译层是三个里最短的**（没有 wire、没有退出码，直接握着 service），所以它也是**最敏感的那个**：一条用例在这里绿，等于在 service 本身上绿。**没映上的错误原样抛**，不塞成 `other`——`other` 一律算失败，抛出去至少带栈
- **每例一次完整启动序列**（18 次）。直接开库更快，也就不再测应用真正走的那条路了
- **两个变异逐条验红，第二个是这批真正的收获**：① 删掉 `requiredName` 的 `.trim()`（计划要求的破法）→ **红的正是两条 §7 F13 用例**，文案就是当年那个 bug：`a blank playlist name: expected a refusal, got a result`；② **从 hook 的映射表里删掉 `NotFoundError`** → 两条红（`一个用不上的 uuid` 与 `删歌之后再读`），报 `expected a ContractRefusal, got NotFoundError`——**证明那张四行表是承重的，而计划 §1.3 记的「v1 漏了 `NotFoundError`」正是漏掉它会怎样**
- **`cacheStatus` / `runEviction` 的选项定为 `NO_PLAYER_CACHE_OPTIONS`**（`limitBytes: 0` / `isExcluded: () => false` / `streamCount: () => 0`）：播放器归 N3、音频流归 N4，现在诚实地答「没有」而不是留一个到时候会安静作废的占位。缓存**功能**仍是 N4 的，这里只是因为契约的 cache 那一例是 N2 gate 的一部分
- CLI 那条 `it.skip('mobile hook — lands with the mobile app (N2)')` 换成了真断言（18 例），全仓 2603 → **2604**
- **三块旧面板复跑过**（`BootResult` 加了字段、boot 里 `files` 只造一次）：file-op 7/7 · fs 7/7 · D16 8/8

**N2f 前半（一）：排序落点 + 夹具导入通道（2026-08-19）**。`song-sort.ts` 整个搬进 `@lark/shared`（决策 n），桌面四个消费者改吃 `@lark/shared`，`stores/view-prefs.ts` 原地不动（zustand + localStorage 各端各留适配器）；测试跟着走，shared 79 → 90 / gui 443 → 432，全仓 **2604 不变**。真库副本（7 首 / 1 歌单 / 7 个目录）已经在手机上，启动判 `normal`。

- **Hermes 上 `Intl.Collator('zh-CN')` 是真的**（真机 3/3）：`安静 · 半岛铁盒 · 稻香 · 龙卷风` 是拼音序，而**码点序会是** `半岛铁盒 · 安静 · 稻香 · 龙卷风`。用例把两句都断言了——**没有 ICU 的 Hermes 不抛，它回落成码点序**，只断言「等于拼音序」的用例分不出「回落」和「没排」
- 🔴 **`adb push` 到 `/sdcard/Android/data/<pkg>/files/` 应用读不到**（两轮实测）：① push 会把中间目录建成 `shell` 所有，应用随后在 `Android/data` 就被挡住——可见性探针答 `0✓/Android✓/data✗/<pkg>✗/files✗`（对照：spike 那个目录是 `u0_a337`，应用自己建的）；② 光问 Android 要路径也不够——expo 的权限判定是对**路径本身**做 `File(path).canWrite()`（`FilePermissionService.kt`），不存在的目录不可写，于是「这个应用有权建的地方」被拒成 `Missing 'WRITE' permission`
- **所以 `modules/lark-fs` 破例长出第二个函数**（`externalDirectory(name)` = `getExternalFilesDir(null)` + `mkdirs`）。模块原本明写「deliberately one function」，这次是**实测逼出来的**而不是图方便：JS 既拿不到这个路径，也建不了这个目录，而 `getExternalFilesDir` 不是查询——**它以本应用的身份把地方建出来**，adb 之后才推得进去、应用才读得回来。`just mobile-push-fixture` 因此在目标不存在时**拒绝执行**并让人先点一次按钮，而不是自己 `mkdir` 出一个谁也打不开的目录
- **导入通道自己做两处身份改写**（决策 o「本次定死」的落地）：`install_id` 写成本机 committed 值、**删掉 `device_uuid`** 让第 ⑨ 步重铸。两条各验红一次：去掉前者 → 启动判 `converge`（判据 14 会变成在测 D16）；去掉后者 → `582fb1df… → 582fb1df…`，**手机继承了桌面的本机身份**（决策 j 说两台安装绝不能共享的那个值）
- **第二条反测先逼我修了断言**：原来那句「库里存的 uuid 等于 boot 返回的」**恒为真**——⑨ 是新铸的还是沿用桌面的都成立。改成在删之前先把桌面那个读出来带回，再断言两者不同

**N2f 后半（二）：四 tab + 曲库/歌单 UI（2026-08-19）——判据 14 / 15 真机 26/26**（`just mobile-accept-library`，生产 artifact）。`src/ui/` 七个文件：四 tab（歌曲｜歌单｜添加｜设置，D9）· 搜索 + 排序 · 行动作（改歌名/改歌手/固定/删除）· 歌单列表与详情（新建/改名/删除/加歌/移除）· 添加与设置的显式空态。**零新依赖**——没上 zustand，也没上手势栈（决策见 §8.3）。

- **判据 14 的排序是跨设备对照，不是自洽**：期望顺序由**主机**用同一份 `songs.db` + 同一个 `sortSongs` 算出来，手机屏幕上的顺序要逐首相同。面板做不到这件事，它只能证明手机跟自己一致
- **两条反测各点着该点的**：① UI 不再调 `sortSongs` → 歌名/时长/方向键/「控件不是死的」四条红；② 设置里的「曲库目录」计数改成常数 → **只有「目录跟着没了」那条红**（`0 个 → 0 个`），而「曲库少了一首」照绿——两个观测量确实是独立的
- **如实记一条口径限制**：这份曲库上 **歌手 与 创建时间 两个字段的升序恰好等于默认序**，所以它们的用例在变异下仍是绿的——它们证明的是「没排错」，不是「排了」。真正拦住「控件是死的」那条是 `distinct orders > 1`
- 🔴 **按 BACK 再回来，曲库打不开**（真机实测）：Activity 被销毁而进程还在，第二次 `runBootSequence` 报 `NativeDatabase.prepareSync … NullPointerException`。根因在 expo-sqlite 57.0.1：`OnDestroy` 想关掉缓存的数据库，**而 `removeAllCachedDatabases()` 返回的就是它刚清空的那个 list**，`forEach` 走了个空——留下一批原生已经没了的 JS 句柄。修法是 `bootOnce()`：**启动序列本来就是进程级的**（身份门、迁移、drain），因为一个屏幕重新挂载就再跑一遍，本身就是错的。验收仍直接调 `runBootSequence`（它的活就是反复从自选状态启动）
- 🔴 **`SafeAreaView` 在 Android 上是空操作**：标题直接画在状态栏上（截图可见）。加 `StatusBar.currentHeight` 的 padding
- 🔴 **驱动脚本的两处会安静地测错东西**（都直接观察到）：① `tap` 先滚到顶，**25 次滑动落在打开的 modal 背板上就把它关了**，之后报「找不到标签」，而在那之前的一整轮结果读的是背后那一屏——新增不滚动的 `tap-visible`，并把验收脚本的默认也改成它（按的全是固定控件或已在视野里的行，滚动从一开始就不该是默认）；② `tap` 是**子串匹配**，给设置页加了个「歌曲目录」之后，每一次 `tap "歌曲"` 都按在这个字段上、静静地留在设置页——改成**精确匹配优先、子串兜底**，并把字段改名成「曲库目录」。两条都进 `docs/LESSONS.md`
- **另加了一个 `dismissKeyboard()`（先问 `mInputShown` 再发 BACK，因为没有 IME 时的 BACK 会直接退出应用）**——但要如实说：促使我加它的那两次失败**后来查明是人在动手机**（用户以为跑完了就退出了应用），所以「IME 吃掉第一次点击」这条**没有被证实**。改动留着是因为它本身更稳，不是因为它修好了什么
- ⚠️ **26/26 是在同一份生产代码上跑出来的**（脚本随后只改了健壮性）；**修完驱动之后的完整复跑还没拿到**，几次尝试都被人为操作打断。下次上手先跑一遍 `just mobile-accept-library` 收口
- **`adb shell input text` 只能打 ASCII**（中文会从 `InputShellCommand.sendText` 抛 Java 栈）。所以搜索用的针**从夹具里选**——最长的、命中一部分而非全部的拉丁串（这次是 `LeoFM`，2/7）；中文搜索与 trim 那半由 LibraryContract 的用例在同一台手机上覆盖。`drive.mjs type` 现在自己拦下非 ASCII 并说清楚
- **「删歌带走目录」需要一个能从外面看见的观测量**：`songs/` 是应用私有的，adb 看不了，所以设置页多了「曲库目录 N 个」（真读磁盘）。这也正是判据 15 里「journal 已消费」的证据——`deleteSong` 返回前会 drain，目录还在就说明写下的效果没执行

**N2f 收尾：用户手测一轮，六处改动（2026-08-19，`4f5f442`）——N2f 完成**。手测比机器快，也看见了机器看不见的东西（六条里没有一条是判据能发现的）：

- **行的点击是播放，菜单是自己的按钮**（右侧 ⋮，44dp）。原来「点行出菜单」在手机上不是人预期的动作。播放器要到 N3，所以这一下现在**明说**「播放在 N3 开放」而不是没反应——吞掉点击的行会被当成坏了
- **图钉用桌面的图标和桌面的颜色**，位置在时长之后而不是歌名之前。颜色不是挑的：把桌面暗色主题的 `--state-pinned: oklch(0.72 0.16 255)` 换算成 `#59a6ff`；顺手把 `--state-active`（琥珀 `#efb146`）也放进 theme **留着不用**，N3 的播放行必须是那一个琥珀，不是那时候另挑的一个。图标栈因此引入 `react-native-svg@15.15.4`（照 Expo `bundledNativeModules`）+ `lucide-react-native@1.33.0`，桌面 `just check` / `just test` 复跑无回归
- **删歌要确认**（「删除《歌名》？」→「删除，连同它的文件」）。只有删除问，因为**其他动作都能反着做一遍**，而删歌带走音频、手机上没有撤销也没有回收站
- **取消要落在保存落的地方**：改歌名/改歌手的取消现在直接回列表，底下那层菜单一起关。回到菜单等于还要再点一次才能离开
- **歌单页不显示虚拟 `all`**。这是**这一屏的呈现选择**，不是跟库不一致——`listPlaylists()` 照旧把它放第一位（M6 的契约在服务层settled）；手机的「歌曲」tab 本来就是全部歌曲，再列一遍就是同一份东西出现两次，而桌面之所以列是因为它的曲库视图和歌单列表是两个地方
- **底部 tab 条被手势条压着**：Android 不给这个 inset（除非上 `react-native-safe-area-context`），先加 22px 底部留白
- **验收脚本跟着改了一处**：歌单页的标记从「全部歌曲」换成「新建歌单」，否则它会因为这次改动误报
- **清理**：删掉 `db/self-check.ts`（N2b 的数据层自检面板，N2f 之后没有任何调用者；它那六条判断已由桌面 `open-library.test.ts` 与 PROCESS 的 N2b 段留存）

**N2g 已完成（2026-08-20）——判据 20 / 21 绿，N2 全部完成**。两个模块 + 两份单测：`packages/shared/src/now-playing.ts`（`nowPlayingTitle` + `NowPlayingMode` + `isNowPlayingMode` + 64 code point 上限）与 `packages/core/src/portable/now-playing-mode.ts`（`local_metadata.now_playing_mode` 的读写，决策 c）。全仓 2604 → **2628**（shared 90 → 101、core 1179 → 1192）；portable 的 Metro 图 101 → **102 个模块**。**这批不需要手机**：判据 20 是纯函数、判据 21 是 `SqliteLike` 上的断言，而 **N2 本来就不断言任何蓝牙行为**（没有播放器、没有带屏接收端）。接线与开关归 N3。

- 🔴 **计划的「回落四条」落地成三个分支**：② `lyrics.length === 0` 与 ③ `currentLrcIndex === -1` **不是两个能各自杀死的判断**——空数组进 `currentLrcIndex` 只能回 -1（`lrc.ts:75` 的二分在 `high = -1` 时不进循环），写成两个 `if` 的话第二个是死代码，而判据 20 要求「删掉该分支那条必须红」对死代码不成立。实现因此收成一句 `const line: LrcLine | undefined = lyrics[currentLrcIndex(...)]`：**②③ 共用一个守卫、各留一条用例**（删掉守卫两条一起红）。这是子计划 §8 那条 P1-4 的同一个形状再走一格——**v1 五条 → v2 四条 → 落地三个分支**，每次都是「这两件事函数分不开」
- **五个变异逐条验红**（判据 20 的「每条都要有反测」）：① 删 `mode === 'title'` → 4 红 · ② 删 `line === undefined` 那半 → ②③ 两条红（`Cannot read properties of undefined (reading 'text')`）· ③ 删 `line.text === ''` 那半 → 间奏那条红（`expected '' to be '晴天'`）· ④ `[...text]` 换成 `text.split('')` → emoji 那条红 · ⑤ 上限整个拿掉 → 3 红
- **emoji 用例的那一个前缀是承重的**：`'🎵'.repeat(70)` 按 UTF-16 切在 64 上**正好落在代理对边界**，naive 实现照样绿。加一个 `あ` 把 naive 的切点顶到奇数单元，孤代理才出得来。断言顺序也跟着改——**孤代理那条排在长度之前**，否则长度先红，真正要证的那条永远不执行（同一个形状 N2f 的排序用例里也遇过：先红的断言会盖住后面的）
- **三个变异验红判据 21**：读路径顺手写回 → 六条「不改库」红 · 去掉 `isNowPlayingMode` → 八条红 · upsert 退回普通 INSERT → 「一行」那条红
- **为什么 config 那半在 portable 而不在 shared**：它要 `SqliteLike`。落 `local_metadata` 跟 `device_uuid` 同表同域（per-install 本地偏好），**写它不产 `sync_changes`**（有一条用例守着）；**读路径永不写库**——一个看不懂的值是「另一个版本的这台设备写的」，不是「可以覆盖的」，一个会「修好」自己读不懂的东西的启动路径，就是降级会吃掉设置的那条路

**N3 子计划已出（2026-08-20，v1 → v4，一轮反例评审收敛）**——`docs/plans/2026-08-20-phase-b-mobile-n3.md`，六批 N3a–N3f / 判据 25 条 / **决策 a–p 全部关闭**，修订对照在 §8。**评审逮到两条我的事实错误**：① `AudioStatus.error: string | null` 是存在的（`Audio.types.d.ts:243` + `AudioPlayer.kt:158` 的 `onPlayerError`）——v3 读到 `:215` 就停了，**从一个截断的阅读里断言了一个否定**，于是把「错误只能靠超时表达」写进了设计；② 桌面的 `player/queue.ts`（串行 + generation）是**零 import 的纯 TS**，v3 把它整条归进「不能共享」，等于让移动端没有竞态模型。

- 🔴 **锁屏/车机的「上一首 / 下一首」在钉版上不存在**：`AudioMediaSessionCallback.kt:27-31` 在 `onConnect` 里显式 remove 掉四个曲目导航命令。我又往下查了一步——`AudioControlsService.kt:374` 与 `:455` **两个 MediaSession 注册点用的是同一个 callback**，所以**换 `AudioPlaylist` 也救不了**（评审给的三个选项里第二个不成立）。**用户决定 v1 收窄**：锁屏只承诺播放/暂停/seek，切歌回 app 里；代价是蓝牙歌词开着时「车机上看得见歌词、方向盘上却切不了歌」，逃生口（改 Kotlin + 拦命令 + 桥接 JS + 维护补丁）定价后记在 §1.9
- **「抽五个纯函数」原本没有可抽的东西**：`next`/`prev`/`advanceAfterEnded` 调 `get()`、`ctx`、`ops.play`。v4 先定义 `QueueDecision`（`play`/`restart`/`stop`/`reject` + reason），**播放与提示归宿主**——这顺带解掉了 §2.4 说「静默拒绝」而决策 n 说「主动按键要出声」的两头话
- **四条判据本来是概率题**：shuffle（注入 `random`）· 蓝牙歌词「调用次数 ≈ 歌词行数」（漏了去重，真值是**相邻不同输出的段数**，改成与主机算出的期望值对照）· 「内存无单调增长」（删掉，几十秒内受 GC 干扰）· 音频焦点「测的时候再写成判据」（三条行为开工前冻结）。另有一条规则自相矛盾：「每格一个变异且**不能连带红**」与共享 helper 冲突——共享行为被改坏本来就该多条一起红，改成「每格要有一个**只属于它的**变异」
- **删歌之后队列收敛没有通道**：`library-context.tsx:62` 的 `changed()` 只 `setView`，React 之外没人收得到。取最小做法（`changed()` 顺带打一个可订阅信号，约 15 行），**不做通用 reconcile 协议**——N5 的同步删除到时候接同一个信号
- **N3b 因此是一个零手机的纯桌面批**（真机四模式从 N3b 移到 N3c，那里才有可驱动的生产 UI）

**N3a 已完成（2026-08-20，判据 1/2/3①④/3b/5）——播放内核**。`apps/mobile` 加 expo-audio **57.0.3**（与 spike 逐字节同版，hoist 之后全仓一份）+ 原生配置；`player/` 四个文件（session / driver / store / index）；`createOperationQueue` 从 gui 搬进 `@lark/shared`（决策 p）。全仓 2628 → **2642**（shared 101 → 106 与 gui 432 → 427 是搬迁的账，mobile 10 → 24 是新的竞态单测）。

- **判据 3b（gate）4/4，两个否定断言各自验红**：合并 manifest 里 `POST_NOTIFICATIONS` 在、`RECORD_AUDIO` 不在、播放前台服务已注册、录音服务未注册。写反测时发现第 4 条守的其实是**另一个选项**——`recordAudioAndroid` 管权限，录音服务由 `enableBackgroundRecording` 管（`withAudio.js:71`），两个各打开一次才各自点着。**「这是 recordAudioAndroid 的另一半」是一句读起来很顺的假话**
- **判据 3（gate）的原文和后台播放矛盾，跑的时候才撞上**：v4 初稿写「每条路径之后都看不到活跃播放器」，可开了后台播放，按 home、按 BACK 本来就该继续响。改成对**我们名下的活跃播放器数**断言：切歌恰好一个 · 显式停止零个 · BACK 继续播且仍是一个。**①④ 已绿**（连切三首每次都是 1；BACK 之后前台是 launcher 而播放继续，回前台 UI 上 `▶` 还在那一首——进程级单例扛住了 Activity 重建，`bootOnce` 同一条理由）；②③ 与判据 4 的设备那半需要 acceptance 夹具，随 N3c
- 🔴 **反测把 #47569 在我们自己的应用里复现了**：去掉 `destroy()` 里的 `pause()` → 切歌之后**两条 `state:started` 的 AudioTrack 同时在响**。所以 driver 的面**没有 `remove()` 可调**，只有一个 `destroy()`（pause → 300ms → clearLockScreenControls → remove），这不是纪律是结构
- **`AudioStatus.error` 存在，v3 计划里「错误只能靠超时」是错的**（评审逮到）：`Audio.types.d.ts:243` + `AudioPlayer.kt:158` 的 `onPlayerError`。load 因此是三个终态赛跑（loaded / error / watchdog），watchdog 只管「什么终态都没来」，坏文件不必白等 15 秒
- **竞态模型是两个机制，不是一个**：lane（串行，桌面搬来的 `createOperationQueue`）+ intent 计数（最后一次点击胜出）。**只有 `play` / `stop` claim intent**——让 `seek` 也 claim 会变成「拖进度条取消加载」，那是防竞态的机制自己造出来的竞态。五个变异里四个验红（去 lane · 去放弃机制 · 放弃时销毁「当前的」而不是「自己建的」· 让 seek claim），**第五个没红**：`toggle` 里的 `state.loading` 守卫在 lane 之下根本轮不到，是死代码，删了——**和 N2g 的回落 ②③ 同一个形状，一个批次之后又来一次**
- 🔴 **锁屏一开始只有歌名歌手，没有任何按钮**（用户手测报的）。一张下拉截图定案：**同屏正下方 bilibili 的通知有五个按钮**。根因两层——① expo-audio 只在 API ≤ 32 给通知 `addAction`，33+ 指望 System UI 从 MediaSession 画，而 OriginOS 把它当普通通知画；② **`pnpm patch` 改它的 Kotlin 默认无效**，SDK 57 的模块消费的是包内预编译 AAR，要 `expo.autolinking.buildFromSource` 才走源码。两条都进 `docs/LESSONS.md`。修完是**后退 10s ｜ 播放/暂停 ｜ 前进 10s** 三个按钮，用户手测可用
- **已知不做**：没有进度条、展开态按钮行居左（2026-08-20 用户决定）。居左是系统模板的排法不是我们的 bug——bilibili 的按钮起点与间距完全相同，只是数量填满了整行；要居中得给通知换自建 `RemoteViews`，代价见子计划 §1.9
- **判据 5 = 用户手测通过**（连续播放远超 5 分钟，含后台与锁屏）。**如实记口径差异**：没有按 §1.7 的协议做两侧采样，机器侧的证据只有「BACK 之后前台是 launcher、`dumpsys audio` 仍是 1」那一次

**N3b 已完成（2026-08-20，判据 6 gate / 7）——队列语义只写一遍**。`decideNext` + `QueueDecision` + UI 循环序进 `@lark/shared/play-queue.ts`；`local_metadata.play_mode` 进 `portable/play-mode.ts`（决策 g，照 `now-playing-mode.ts` 的形状）；桌面改吃。全仓 2642 → **2665**（shared 106 → 129、core 1192 → 1196）。**整批不需要手机。**

- **「抽五个纯函数」原本没有可抽的东西**（评审属实）：`next`/`prev`/`playAt`/`randomOther`/`advanceAfterEnded` 调 `get()`、`ctx`、`ops.play`。先定义**返回值**（`play` / `restart` / `stop` / `reject` + reason），桌面那五个函数体才塌成一个 20 行的翻译器 —— **`indexOfCurrent` 与 `playAt`、`randomOther` 被编译器报成没人用**，又是 N1h 那个「切面画对了的信号是一整段代码变成死代码」
- **这个返回值顺带解掉了计划里的两头话**：§2.4 写「静默拒绝」而决策 n 写「主动按键要出声」。纯函数只产出 `reject + reason`，**出不出声是宿主的事**——桌面照旧把 message 递给远程 ack 通道不显示，移动端 N3c 会 toast
- **两个 trigger 在两处分道扬镳，而这是照抄桌面而不是新设计**：① 当前歌不在队列里，`ended` → `stop`（桌面 `advanceAfterEnded` 调 `stopPlayback` 返回 ok:true），`next`/`prev` → `reject`（桌面返回 ok:false 带话）；② 邻居没有文件，同样分。**「手动 next 在 sequential 下 wrap 而自然放完不 wrap」也不是笔误**——`ops.next` 用 `%`，`advanceAfterEnded` 显式判末尾：按键是意图，放完不是
- **八个变异逐条验红，各有各的签名**（判据 6 的「每格要有一个只属于它的变异」）：sequential 末尾停 → 1 红 · repeat-one 提前返回 → 1 红 · shuffle 不排除当前 → 3 红 · shuffle 不过滤有无文件 → 1 红 · not-in-queue 不分 trigger → 3 红（全是 ended 那三条）· prev 也往前走 → 2 红 · `has_file !== false` 改成 `=== true` → 8 红 · shuffle 接管 prev → 1 红
- **shuffle 的 `random` 是注入的**（评审属实：概率测试会被反复重跑到绿为止）。两个确定性实现（永远取第一个 / 永远取最后一个）就把「随机另一首」和「恒定挑同一首」分开了
- **判据 7 绿**：gui **427 不变**，`player.test.ts` / `Controls.test.tsx` / `StatusBar.tsx` 只改 import 来源
- **范围修订：移动端 store 的队列与模式挪到 N3c**。它要三样 boot 之后才存在的东西（按 id 现读库、`sqlite`、库变更信号），而 `player/index.ts` 是 import 时就建好的进程级单例。在没有消费者的批次里先发明「boot 之后绑上去」的接口，是给一个还看不见形状的问题做设计

**N3c 已完成（2026-08-20）——minibar / 全屏页 / 队列面板，判据 8–15**。移动端 store 接上队列快照与模式、`LibraryService.readLyrics`（决策 h）、库变更信号（§2.8）、三个 UI 文件 + 一个共用进度条。全仓 2665 → **2684**（core +7、mobile 24 → 36）。**零新依赖**：进度条是 RN 自带的 `PanResponder`，全屏页是 `Modal`，队列面板复用 N2f 的 sheet。

- **判据 13（队列是快照）绿**：歌单起播 → 切「歌曲」tab → 排序改成时长 → 开面板，**第 2 / 4 首**与歌单顺序逐项不变。**判据 14 绿**：删队列里非当前的一首 → `第 2 / 6 首 → 第 2 / 5 首` 且它从列表消失、播放不受打扰；**删正在播的那首 → 活跃播放器 0、minibar 整个消失**（不滑到隔壁——删除不是一条关于「接下来播什么」的指令）
- **判据 8 的接线绿**（自然放完 → 自动下一首，用拖进度条到尾巴触发）；**四模式各一次的完整矩阵由判据 6 的纯函数单测承担**，真机这一条只验接线
- **判据 9/12 由用户多轮手测通过**，产出 **11 处改动**（下面两段）。⚠️ **判据 10 的「offset ± 写库并立即生效」当时根本没做**——全屏页只有模式键 / 上一首 / 播放 / 下一首 / 队列五个控件，这条记录写宽了（N3d 复核时发现，控件与验收都在 N3d 补上）。**判据 11**（琥珀播放行）截图确认。⚠️ **判据 15 的「点没有文件的歌」没验**——这个夹具库里没有 `has_file === false` 的歌；歌词三态里「无歌词」也没遇上（4 首都有歌词），**如实记着**
- 🔴 **`locationX` 是相对「被触摸的那个子视图」的，两次咬人**：① 点进度条**大概率跳回开头**——手指落在圆头或已填充那段上时，触摸目标是那个小 View，`locationX` 只有几像素，**越是精准点在当前位置越必然发生**；修法是子视图 `pointerEvents="none"`。② 修完之后**拖动起手一瞬间往前滑一截、然后跟位移而不是跟手指**——**症状本身指明了方向**：grant 的读数可信、move 的不可信。改成在 page 空间锚一次（grant 时 `pageX - locationX` 就是 track 左边缘，同步、不用 `measureInWindow`），之后每次 move 是 `pageX - origin`，不累加所以不漂。判据取「**拖到某个位置 = 点击那个位置**」，两条路给出逐字符相同的时间
- 🔴 **加了秒数显示，`uiautomator dump` 直接失败**（`could not get idle state` 且不写文件）——它要等窗口 idle，而走着的时钟永远不 idle。**症状是驱动脚本报「屏幕上没有这个标签」**，一个完全错误的诊断。`drive.mjs` 改成重试三次后说出真正原因。同一批还教会了它读 `content-desc`——播放器的传输键是图标，标签在 `accessibilityLabel` 里，**N2f 那条「控件一律带可见文字」是驱动器的局限不是设计原则**
- **两处百分比布局各错一次**：队列面板 6 首只画 2 行（`maxHeight: '70%'` 挂在一个自己没有高度的父节点上 → 改成算出来的像素）；大歌词不跟着滚（改成按 `onLayout` 实测每行 y——「行高 × 序号」在长行换行之后越往下偏得越多）
- **手测出来的其余几件**：队列开在歌词页**之上**而不是替换它（原来两个覆盖层共用一个状态所以互斥）· 歌词页滚动条常驻 · 队列面板里能换循环模式 · minibar 三排（歌名大一号 / 歌词居中且常驻占位 / 进度条可拖带圆头）· 歌单页的行也改成「点播放、⋮ 出菜单」
- **范围修订**：移动端 store 的队列与模式从 N3b 挪到本批（要 boot 之后才存在的三样东西：按 id 现读库、`sqlite`、库变更信号，而 `player/index.ts` 是 import 时就建好的进程级单例）

**N3d 已完成（2026-08-20）——蓝牙歌词接线 + 设置页开关，判据 16/17/18**。`apps/mobile/src/player/now-playing.ts`（订阅 → `nowPlayingTitle` → 去重 + 节流 → `updateLockScreenMetadata`，外加每首歌的计数）· store 加一个**同步且不进 lane** 的 `publishNowPlaying` · 设置页的开关与诊断行 · 主机侧期望值脚本 `spikes/mobile-foundation/scripts/now-playing-expect.mjs`（`just mobile-now-playing-expect`）。全仓 2684 → **2699**（mobile 36 → 51）。**顺带补上 N3c 漏掉的 offset ±。**

- **判据 16 绿**：开关默认**关**（缺行 → `'title'`）；打开后 `dumpsys media_session` 的 metadata TITLE **逐句跟着歌词走**——采样到的 27 次变化与主机同一份 `nowPlayingTitle` 算出的 27 段**逐项同序**；关掉**当场**变回歌名（`metadata: size=5 → 4`，album 槽一起清空）
- **判据 17 绿，跨设备对照**：设备 **34 次 · 最短间隔 4506 ms · 播放到 197.9s**，主机 `now-playing-expect ... 197.9` 算出 **34 次**。**期望值的可信度来自「五个 tick 相位扫描」**——同一首歌用 0/100/200/300/400ms 五个 tick 相位各算一遍，数一致才说明没有短于一个 tick 的段落、这个数才配拿去要求设备。真实曲库里 **7 首有 3 首被脚本拒收**（`东风志` / `同道殊途` / `莫问归期` 开头的「作词 / 作曲」半秒一行），**这条判据本来就有一半会变成概率题**
- **最短间隔 4506 ms 不是随便一个数**：这首歌最密的两句相隔 4.5s。节流的 500ms 在真实歌词上几乎永远不咬人——它防的是病态输入，不是常态
- **关开关那一下是在暂停状态验的**，正好打在设计上：暂停的播放器一个 tick 都不发，所以 `setMode` **绕过节流强发一次**；否则车机上会一直挂着最后那句歌词。这条判据本身就是那段代码的反测
- **判据 18（只记录不判定）：queue 陷阱的前提条件是成立的。** 我们的 session 是 `androidx.media3.session.id. com.orpheusaviary.lark/androidx.media3.session.id./571`，`queueTitle=null, **size=1**`、`active item id=0`——**队列非空**，正是 AOSP `MediaPlayerWrapper.isMetadataSynced()` 会去比对 queue item 与 metadata 的那个分支；而 expo-audio 建的是 `MediaItem.fromUri(uri)`（`AudioModule.kt:868`，**不带 title**），所以 queue item 的 title 永远不可能等于我们写进去的歌词行。**`CALLBACK_TIMEOUT_MS = 2000` 的触发条件齐了，有没有真的延迟——没有带屏接收端，测不了。**
- **歌名去 album 槽**：标题被歌词占用时 `albumTitle = 歌名`（间奏与关掉时不带，`MetadataInjectingPlayer.getMediaMetadata` 逐字段重建，省略即清空），落到手机通知上是 `setSubText`。**未实测**——没有接收端，写下来是因为它零成本且是歌名唯一能活下来的位置
- **offset ± 补上并验了**（全屏页歌词下方一行，0.5s 一步、与桌面同图标同步长；`lyrics_offset` 写库 → 库变更信号 → store → UI 与蓝牙标题一起动）。**验收撞上一个卡在刀刃上的例子**：暂停在 197.939s、那句歌词起点 195.42s，**offset 拨到 −2.5 时目标 195.439 比边界只大 0.019 秒，标题纹丝不动；再拨一格 −3.0 才翻到上一句**。两端用的是同一个 `currentLrcIndex(lines, time, 库里的 offset)`，这比「看着变了」强得多。屏幕上那个数字是**从 sqlite 读回来的**（`state.song` 来自库变更信号后的现读），所以它同时也是写库的证据
- 🔴 **`dumpsys media_session` 的 `PlaybackState.position` 只在状态变化时更新**，不是当前播放位置。采样脚本一开始拿它对时间轴，看起来「设备比主机快 3 秒」——其实读的是陈旧值。**标题的顺序可信，那个 position 不可信**；判据 17 的时间因此取自 app 自己的诊断行（计数与播放位置在同一帧里）
- **`mode` 每首歌重读一次库**（§2.5 原文），不是「读一次缓存到底」：今天只有开关会写它，但一次 prepared read 的代价换掉「万一别处写了呢」这个问题，是划算的

**N3e 已完成（2026-08-20）——蓝牙断连不转外放，判据 19（gate）/ 21；判据 20 按用户决定搁置**。新增 `apps/mobile/modules/lark-audio`（本仓第二个自建 Expo 原生模块）+ store 的显式 `pause()` + 在 `player/index.ts` import 时订阅。全仓 2699 → **2701**。

- **判据 19 绿（用户手测）**：耳机断开 → 音乐**暂停**、扬声器一声不出；耳机连回来 → **仍然停着**，不自动续播（恢复是用户的决定，与接完电话同一条原则）
- **反测不需要再装一个坏包**：N0b-4b 就是在这台机器、这个 expo-audio 版本上量到坏掉的形态的（旧 AudioTrack 转 `paused`、同时新起一个 `deviceId:3` = speaker 的 `started`），而那次测量发生在修法存在**之前**。**一个在修复前取得的失败测量，就是这条判据的反测**
- **暂停不在原生做**：模块收到广播只 `sendEvent` 就结束，暂停走 store。原生抄近路会多出一条「能停下播放而 store 不知道」的路径。JS 那一跳是微秒级，对上一次音频路由切换不构成风险
- **新加的是 `pause()` 不是复用 `toggle()`**：调用方是「耳机被拔出来了」，它**必须不能启动播放**——`toggle` 在暂停态会续播，也就是拔耳机把音乐**打开**。单测把 `pause` 换成 `toggle` 立刻红
- 🔴 **`ACTION_AUDIO_BECOMING_NOISY` 是受保护广播，模拟不了**：`adb shell am broadcast -a android.media.AUDIO_BECOMING_NOISY` 抛 SecurityException（shell 不是 system uid）。**这条判据没有干跑的办法，只有真的断开一次**
- **判据 21 记录完毕，结论是「原样留着」**：焦点请求是 `gain: GAIN_TRANSIENT`（`req=2`）· `flags: DELAY_OK` · `attr: usage=USAGE_UNKNOWN content=CONTENT_TYPE_MUSIC`，而实际播放的 AudioTrack 是 `usage=USAGE_MEDIA content=CONTENT_TYPE_UNKNOWN`——**两组属性确实不一致，N0b-4b 那条怀疑属实**；都由 expo-audio 自己发出（`AudioModule$$ExternalSyntheticLambda1`），我们没有插手的地方。决策 f 是「判据 20 全过就不动」，而 20 不测了，所以**没有行为证据支持去改它**：改焦点请求是拿一个更难查的病换一个还没出现的病
- **`GAIN_TRANSIENT` 有一个用户会感觉到的后果，写在这里等实际使用验证**：lark 抢焦点时是在告诉别的应用「我只是临时的」，所以别的播放器被打断后，**等 lark 停下来可能会自己接着放**。一个音乐播放器通常该请求完整的 `GAIN`
- **`EventsMap` 要 `type` 不能 `interface`**：`NativeModule<TEventsMap>` 的约束是 `Record<string, (...args:any[])=>void>`，而 interface 没有隐式索引签名——`error TS2344: Type 'LarkAudioEvents' does not satisfy the constraint 'EventsMap'`

**范围修订：判据 20（音频焦点行为表）搁置**（2026-08-20 用户决定，「属于是比较少见情况，之后实际使用过程中测」）。照判据 16b 的先例：**搁置的是验收，而这一条连实现都不是我们的**——焦点行为整个由 expo-audio 提供，lark 一行代码都没写，所以不存在「声明了但没验过」的实现面。不做的是那张三条行为表的逐条断言：来电 → 暂停且通话结束**不自动恢复** · 另一个应用开始播放 → 暂停不恢复 · 导航语音 → 压低音量后恢复。**代价一句话**：「来电时会不会暂停、通话完会不会自作主张续播」在 N3 没有证据，推给实际使用；判据 21 已经把当前的请求参数记下来，真撞上问题时从那里改起。

**N3f 已完成（2026-08-20）——进度记忆 + 收尾，判据 22（gate）/ 23 / 24 / 25，外加 3②③ / 4 / 5 的补跑。N3 整个里程碑到此结束。** 新增 `portable/last-playback.ts`（+ 22 条单测）· store 的 `restore` / `remember` / `play(…, startAt)` · `index.ts` 的 `AppState` 订阅与 restore-once 门 · acceptance 的 `playback.ts`。全仓 2701 → **2729**（core 1199 → 1221、mobile 53 → 59）。

- **判据 22 全绿**。① 前台播 3 分钟 → `am force-stop`（杀在 212.7s）→ 重开：同道殊途 · **3:00 / 7:50** · 暂停态 · 列表那行是琥珀。**恢复的位置正好 180.0 秒**——这个数本身就是 60 秒节拍的签名，暂停与进 background 都写不出整分钟，比单测的变异更硬。② 按播放**之前**：活跃播放器 0、我们的 media session 0、**没有 posted 的通知**（`dumpsys notification` 里只有 channel 定义）。③ 按下播放 → 182.6s，从 180 续上。④ ⏭ 去了**何以歌**——歌单的下一首，而不是「歌曲」tab 排序里的下一首（叹云兮），队列确实按存下来的 `source` 重建
- **判据 23 跑在桌面单测上**（22 条）：十四条失效用例逐条断言**「那一行原封不动」**。两条口径值得单记：`duration === 0` 的老库**不拿它当上界**（否则整个导入库的位置全被否掉），而**恰好等于 duration 视为放完**；歌单被删或被清空 → **队列退回整库、歌仍然恢复**
- **判据 24 绿**：27 秒内连切 30 次 → 活跃播放器**恰好 1**，media session 数**前后都是 2**
- **判据 25 绿**：跑完还能换歌、开全屏页、开队列面板（面板正确显示「第 3 / 3 首」）
- **判据 5 复跑绿**：熄屏后台**播放推进 360 秒零暂停**，主机侧全程 1 个活跃播放器。**这仍然只证明「不是一开始就断」**——耐久性（数小时）在 N3 依旧没有证据（决策 k）
- **判据 4 绿（acceptance 3/3）**：空文件 **410ms**、4KB 非音频 **343ms** 被 `status.error` 拒绝，而 watchdog 是 15000ms；不存在的 uri **3346ms**，**也是播放器结束的**不是 watchdog。**判据 3③ 绿**：三次失败加载之后活跃播放器 0
- **判据 3② 绿**：播放中把 lark 从后台任务里划掉 → 进程消失、活跃播放器 0、声音停了。**「显式停止」生产版原本没有入口**（`store.stop()` 零调用方，N3a 注释说的「unmounting the app」并不存在）→ 收尾时把「删掉正在播的那首」那条路改成调用 `stop()`：它本来就是 `stop` 的近似复制，只差没清 queue，而那是一个属于已经不存在的歌的 queue
- 🔴 **失败加载会漏一个 media session**：acceptance 三次失败之后留下三个 `ExpoAudioBasicMediaSession_<hash>`，`remove()` 收不掉；而生产版连切 30 次一个都没多。差别是生产版走 `setActiveForLockScreen` 用共享 session，没激活过的 player 拿的是自己那个 basic session。**只在错误路径上漏，而错误路径停死播放且不重试**，量级封顶——如实记着，不修
- 🔴 **`dumpsys notification` 里的 `orpheusaviary` 命中大多是 channel 定义不是通知**：断言「没有媒体通知」时按包名 grep 会得到 5 条命中然后误判。要看的是有没有 posted 的条目

**N4 子计划已出（2026-08-20，v1 → v2，一轮反例评审收敛）**——`docs/plans/2026-08-20-phase-b-mobile-n4.md`，七批 N4a–N4g / 判据 40 条 / **决策 a–p 待关闭**，修订对照在 §8。**用户同日拍板四条范围**：TLS 移出（见下）· LLM 设置页进 N4 · 收藏夹/合集批量进 N4 · 加 dataSync 前台服务。开工基线实测双绿：`just check` exit 0（含 `spike-media-test` 全段）、`just test` exit 0 / **2729 passed**。

- 🔴 **明文流是本批的头号未知**：N0b-4a 与 R1 在移动网络上拉到的 `*.mcdn.bilivideo.cn:8082`，两轮都跑在 **spike 的构建**上，而 spike 显式开了 `usesCleartextTraffic: true`（`spikes/mobile-foundation/app.config.ts:87`）；`apps/mobile` 没有这一行。如果那是 http URL，产品 release 会在 **4G 下每首歌都失败而 Wi-Fi 全绿**。判据 5 排在写任何 UI 之前，三条出路已定价（优先改选流规则去用 `backupUrl`，而不是放开明文）
- 🔴 **v1 把孤儿写去了 `recovered-songs/`，错的**：桌面崩溃孤儿进 `trashDir()/recovery-*`（`resolve.ts:456`），而 `recovered-songs/` 是远端删除抢救不可重建资产的地方、**会被 `/sync/status` 的 `quarantined_count` 数**（`paths.ts:106-115`）。照 v1 实现会在 N5 上线那天把同步隔离统计污染掉。同段还漏了 `skipSongIds: pendingFileOpSongIds(...)`——桌面 `boot.ts:399` 有，漏了它会让一次待重试的远端删除被清扫先搬走
- 🔴 **preflight 提取会静默改协议**：daemon 对「短链展开后仍是短链」答 **400 INVALID_SOURCE**（`routes/download.ts:87`），而 portable 的等价物 `resolveInput` 抛 `NormalizeFailedError` → **502**；`routes/download.test.ts` 里**短链用例一条都没有**，所以「路由测试原样绿」在这条上是空的。修法便宜：`resolveInput` **生产零调用方**，先补 characterization 钉住 400，再让它迁就
- **时长方案改成阶梯**：`MediaMetadataRetriever`（不碰音频焦点）→ 不达标退瞬时 player → **上游 `page.duration` 永远只做诊断**，用它兜底正好破坏端口「行按落地写」的不变量。顺带更正 `engine.ts:904` 的注释：重下**有** page 可引用（`probeSourceKey` 回的是完整 `NormalizedSource`）
- **前台服务起在用户手势那一刻**，不是任务入队那一刻——入队前还有一段网络预检，用户在这期间切后台就撞上 Android 12+ 的后台启动限制；`onTimeout` 要**停 queued + running 全部**；「被系统暂停」只在应用内可见（没有 `expo-notifications`）；**通知权限今天只在首播申请**（`player/session.ts:14`），先下载的用户看不到下载通知
- **进程级 download hub 必须和引擎同批出生**：`EngineCallbacks` 只在构造时给（`engine.ts:122-128`），没有动态订阅面
- **分享 intent 的消费点在根层**：`ui/shell.tsx:52` 是条件挂载而默认 tab 是「歌曲」，挂在添加页上冷启动**永远收不到**，而 payload 又是易失的

**范围修订：TLS（D15）移出 N4**（2026-08-20 用户决定，主计划 §4.3 已加 **Stage-3 修订**）。准确口径：**不阻塞 N4 的任何子批**（下载链路不碰 skybridge），**硬阻塞 N5**——server 今天仍是 `http://<公网IP>:8443`，移动端 v1 是 https-only。N5 开工前必须补完 TLS（域名 + 证书 + 自动续期 + 反代 + 两端 `server_url` 迁移 + 真机连通），或单独决定移动端的明文口径。**不算被 N4 消掉**，见「后续」段的待办。

**决策 a–p 全部关闭**（2026-08-20 用户逐条过目「全部确认」，子计划 §5 是定案）。

**N4a 已完成（2026-08-20，纯桌面批，四个 commit）——判据 1–4 全过（1·3 是 gate）。桌面零行为变化，移动实现照冻结的端口写。** 全测试 2729 → **2736**（core 1221 → 1226、daemon 465 → 468；新增短链 characterization ×3、expectedDuration ×1、契约多出的 transfer ×3）。
- **preflight 提取**（`refactor(download)`）：`resolveOne`/`preflightSingle`/`preflightBatch`/`fetchList` 进 `portable/download/preflight.ts`，daemon 路由变薄壳（只剩请求体形状 + `naming_mode` 两条 INVALID_BODY + fetch-list 体读）。顺序照 §2.4 固定：**先补短链 characterization 钉住 400**（`routes/download.test.ts` 原来一条短链用例都没有，靠 `ctx.bilibili.expandShortLink` 打桩）→ 改 `resolveInput` 从 `NormalizeFailedError`(502) 改抛 `InvalidSourceError`(400)（生产零调用方，只动 `link.test.ts` 一条）→ 提取。错误码对照表逐条在路由测试里。
- **AudioLanding 签名冻结 + expectedDuration**（`feat(download)`）：端口加 `request: {url, headers, timeoutMs}`（原生下载用，与 `openStream` 二选一）+ 错误归一契约写进端口注释；client 加 `describeAudioRequest`（共用 `openAudio` 的 `headers()`）。`expectedDurationSeconds` 从 `resolved.source.pages[page-1].duration` 接线，新歌与重下**两条路都有值**（改掉 `engine.ts` 那条「重下没 page」的错注释）。
- **AudioLandingContract 八条 + 桌面 hook**（`test(download)`）：桌面原来手写的 5 条（commit 协议 + 两条 lifecycle）→ `portable/services/contract/audio-landing/`（纯 case + runner + hooks），加 3 条 transfer（非2xx→BilibiliApiError / 超时→中止failed / 取消→cancelled）。桌面 hook 用**真 client + 本地小 HTTP server**（`/ok` `/500` `/hang`）驱动，so `openAudio` 的真实归一在测。`audio-landing.test.ts` 整个换成跑契约。**N4b 加移动 hook，不碰 case**。
- **缓存运行时提取**（`refactor(cache)`，决策 g）：`EvictionScheduler` + `SongLeaseRegistry` + `canRedownload` 进 `portable/library/eviction-runtime.ts`，scheduler 改吃注入的 `EvictionRuntimeDeps`（不再吃 `AppContext`）。**关键是 `defer`**：桌面注入 `setImmediate`（延后宏任务的那条不变量，判据 4 的反测），手机将注入 `setTimeout(fn,0)`。daemon 留 `createEvictionScheduler(ctx)` 装配 + `isExcluded`/`readCacheStatus`/`canRedownload`(BaseContext 壳)，并 re-export 运行时（`new EvictionScheduler(ctx)` → `createEvictionScheduler(ctx)`，其余 import 路径不动）。Metro portable 模块 109。

**N4b 进行中（2026-08-20，用户定「集中开发集中测」——先把 N4b 代码写到能编译，再一次跑完真机判据 5–14；设备已连）。离线可写的先写，逐个给用户看 commit；Kotlin 与判据 5–14 攒到设备 session 一起。**
- **N4b-1 ✅ `3fb15ec`**：`apps/mobile/modules/lark-media`——MMR 时长探测（一个 `AsyncFunction readDurationSeconds`，照 lark-fs 模板）。TS 过、imports/biome 过；**Kotlin 只能真机 build 验**（judge 8）。
- **N4b-2 ✅ `9f3fc6c`**：`apps/mobile/src/ports/audio-landing.ts`（`createMobileAudioLanding`）。**落盘反桌面序（decision c）：② 非 AAC 拒绝 → ③ 原生下载到 `.download.<taskId>.tmp` → ④ MMR 读时长 → ⑤ commit 行 + touchLastAccessed 一个事务 → ⑥ 原子替换**，不做 manifest（崩在 ⑤⑥ 之间自愈）。非 AAC 拒绝 = **`AudioNotAacError` → 任务码 `AUDIO_NOT_AAC`**（非 CodedError，`describeTaskError` 映射，只进 `TASK_ERROR_CODES`——daemon 转码永不产它，**首个纯 task-only 码**）。transfer 是缝（默认 `File.downloadFileAsync`：非 2xx→reject、abort→AbortError、Android 直接流进目标文件失败留半个）；错误归一在 land（abort 原样传、其余非 abort→BilibiliApiError）。shared 129 / core 1226 / cli 9 / errors 66 全绿。
- **N4b-3 ✅ `7ef6935`**：启动清扫 ⑪b（`boot/sweep.ts`）+ trash 命名空间。桌面七形态在这里塌成**三条规则**（没有 manifest，决策 c）：① journal 还认领的 song id 一律不碰（`skipSongIds: pendingFileOpSongIds`）② `.…tmp` 残留删掉（复用 `sweepWriteResidue`）③ 无行的目录：有音频 → `trash/recovery-<ts>-<rand>/<id>/`，什么都没有 → 删。**⑪ → ⑪b → ⑫ 写进 `sequence.ts` 那份「不许移动的排序」清单**（对 N2 §2.2 冻结段落的显式修订）；`BootResult` 多 `swept`。acceptance `sweep.ts` 六条场景（判据 11 的盘上状态那半 · 12 · 13），**判据 13 的反测是能跑的场景**（同夹具不传 skip set → 目录必须被搬走）。
- **N4b-4 ✅ `0ab57f4`**：`downloads/{engine,hub}.ts`。hub = 进程级 external store（照 player 的形状），**必须与引擎同批出生**（`EngineCallbacks` 只在构造时给）；`downloadRuntimeOnce` 是第三处「每进程一次」（Activity 重建会让 `App` 重挂，两个引擎 = 两个队列两本 registry）。**长命 `FileEffectRuntime` 用 `claims: engine.claims` 重建并交给 `createLibrary(boot, fileOps)`**（boot 那本只管 drain，drain 完退役——桌面同形）。`audioStream` 移动端 15 分钟（仍是整条传输 deadline 不是停滞计时）；`getLlmConfig` 诚实空（`NO_LLM_CONFIG`，照 `NO_PLAYER_CACHE_OPTIONS` 先例，真配置在 N4e）。
- **N4b-5 ✅ `8e3cfc0`**：契约移动 hook（`acceptance/audio-landing.ts`）+ 音频夹具通道 + 判据 7/8 场景。🔴 **契约第一次跑就证伪了 N4b-2**：`land` 的 ⑤ 提交事务没有 try/catch，commit 抛出时 tmp 与新歌目录都留着，而契约 2/3 例断言「什么都不许剩」「整个目录要没」——桌面 `landSongFile` 从 M3-7 就有 `rollback`，移动端这一半从没写。已修成 `discard()`（tmp + `mode==='new'` 连目录），三条失败路径共用，提交失败包成**同一个 `DownloadCommitError`**；`land` 复杂度 32 → 19。夹具：`just mobile-push-audio-fixtures` 推 N0b 两条曲目 + **ffprobe 真值由主机 core 的 `probeAudio` 产**（short 实测 136.835215s），manifest 带 `bvid`。**`app.config.ts` 不用改——`INTERNET` 已在生成的 merged manifest 里（Expo 模板给的）**，判据 16 的这一半现在就是绿的。
- **N4b-6 ✅ `67cebed`**：`acceptance/downloads.ts`——判据 5（两行：scheme 是不是 https · 产品构建能不能真读到字节，**每次运行先清 `probed` 缓存**，因为要两张网各跑一遍）· 判据 6（真 bilibili 视频 → 落库落盘，**等任务走 hub 不轮询引擎**，callback 没接就会挂住 = 正确答案）· 判据 14（claims 共享 + 反测场景）。三条决定如实记：**判据 14 用「直接在 `engine.claims` 取 claim」代替「真下载中途删」**（验的是接线：library 的 runtime 用的是不是引擎那本 registry；真下载取的是同一本里的同一个 claim，但要多一张网一条流一个计时窗口）· **判据 6 的 ±1s 对照的是「桌面 ffprobe 读同一个分 P」不是同一个文件**（release 构建 app 私有目录 `adb pull` 不出来）· **下载套件跑完不 `resetInstall()`**（唯一一个，判据 6 的产物就是那首歌，装回 release 构建按播放 = 「能播」那条）。
- **N4b 设备 session（2026-08-21，V2408A，acceptance release 构建，我驱动）——判据 5 · 6 · 7 · 8 · 10 · 11（盘上状态那半）· 12 · 13 · 14 全绿。** 三套面板：downloads **5/5** · landing **13/13** · sweep **6/6**。
  - 🟢 **判据 5（硬 gate）答案：不是明文。** 移动数据（电信 5G，`NOT_VPN`，默认网络已 `dumpsys connectivity` 核过）上 playurl 派的是 **`https://xy220x202x9x156xy.mcdn.bilivideo.cn:8082`**（`mp4a.40.2` / isAac），产品构建 range 请求回 **206 · `application/octet-stream` · `content-range bytes 0-1023/3690190`**。**§1.3 的三条出路一条都不用走**——不改选流规则、不加域名白名单、更不碰 `usesCleartextTraffic`；N0b-4a/N1i 那两轮成功不是 spike 的明文开关给的。**Wi-Fi 那一遍也绿**（`https://cn-bj-cc-03-03.bilivideo.com`，206 · `video/mp4` · 同一个 `content-range …/3690190`）——**两张网都是 https，判据 5 完全关闭**；顺带复现 N0b-4a 那条「content-type 按节点不同」（mcdn 是 `application/octet-stream`，cc 节点是 `video/mp4`），**任何按 content-type 判断是不是音频的新代码都会错**。
  - 🟢 **判据 6**：`莫愁乡--（OfficialMusicVideo）亚细亚旷世奇才` · **136.836s vs 桌面 ffprobe 136.835215s = Δ0.001s** · `file_origin=downloaded` · `source_key=BV176M3zPEZu:30584670526` · **lyrics 任务 succeeded / 1452 字符 lrc**。**「能播」已验**：装回产品 release 构建，曲库里就是它（`1 首 · 亚细亚旷世奇才 · 2:17`），按播放后 `dumpsys audio` 有 **1 个 `state:started` 的 AudioTrack**（`usage=USAGE_MEDIA` / 44100Hz / 2ch，与夹具的 44.1kHz 2ch 对上）+ media3 session 已注册；`uiautomator dump` 当场报 `could not get idle state`，正是「播放中窗口永不 idle」那条已知症状。
  - 🟢 **判据 8**：long **Δ0.000s**（2226.646s）· short **Δ0.001s**。**决策 b 的 A（MMR）成立，不用退 B。**
  - **三个真问题（都已修 + 进 LESSONS）**：① **`lark-media` 少 `android/build.gradle`**，autolink 静默跳过 → 一启动就 `Cannot find native module 'LarkMedia'` 闪退（tsc/biome/bundle smoke 全照不到）→ 补文件 + 新守卫 `scripts/check-mobile-native-modules.sh` 进 `just check`（反测会红）；② 🔴 **MMR 读得出时长 ≠ 文件完整**——fMP4 的 `moov` 在文件头，3.7MB 曲目的前 64KB 读回来是完整 136.8 秒，截断的下载会被提交成歌 → **落盘加 ③b 完整性检查**（落地字节 < 源声明的 total 就当传输失败；计划 §2.3 已记这条修订，实测原生下载 `native progress ×8 last 3690190/3690190`，**守卫在生产上是上了膛的**）；③ 合成 signal 在 `abort` 监听器里同步读 `reason` 是 `undefined`（一个微任务后才是 `AbortError`）——**我一度用「timeout 场景一律算超时」把它改绿，那是买绿**，已改回严格判别并把归不了类的错原样报出来，一轮定位真因。
  - **一条诊断自己错过**：`task.total_bytes` 在终态任务上恒为 `null`，因为引擎每次 stage 变化都 `#resetProgress`，而落盘传输后会 `reportStage('saving')`——它说明不了 ③b 有没有 total 可比。改成报原生下载器实际回调的数。
- **判据 9 与判据 11 的真崩溃点已补完（同一次 session 收尾，用户 2026-08-21 决定放 N4b）**：
  - 🟢 **判据 9**：一边放 short 夹具、一边用 MMR 读 **long（37 分钟）**那条 —— `read 2226.646s in 22ms · 0.8s → 1.7s · never stopped`，主机在**同一刻**数到**恰好 1 个 `state:started` 的 AudioTrack**。**MMR 不碰音频焦点这条从「文档这么写」变成实测。** 场景是两个按钮（arm 停在还在放的状态 / stop 收），因为「系统握着几个 AudioTrack」不是 JS 看得见的事；arm **不开库**，不该为一个跟曲库无关的问题清掉别人的行。
  - 🟢 **判据 11 的真崩溃点**：`createMobileAudioLanding` 加 `crashPoint`（⑤ 与 ⑥ 之间，**park 而不是抛**——抛会展开栈，SIGKILL 不会），arm → `am force-stop` → 重启 → `row still says 136.836s · no canonical file（读作「需要下载」）· .tmp swept · directory kept`，逐字对上崩溃状态表「⑤ 之后 ⑥ 之前（new）」那一行。
  - **判据 11 的反测（不做启动清扫 → `.tmp` 必须还在）没有运行时开关**，如实记着：这条断言只有 ⑪b 跑过才可能成立，而 skip set 那条反测在 sweep 套件里是能跑的。
**N4c 完成（2026-08-21）——判据 15–19 + 41–43 全关（18 只有单测，如实记）。三批 N4c-1/2/3，决策 a–j 全关。**
- **N4c-1 = `modules/lark-transfer`**（dataSync 前台服务：Kotlin service + 通知渠道 + `onTimeout` + 模块自带 manifest）+ `acceptance/foreground.ts`（长曲下载入口与反测）+ **acceptance 面板改成数据驱动列表**（17 个手写 Pressable → `SUITES` 表，复杂度 23 → 过；顺带去掉「运行时把按钮标签改成 Running…」，`drive.mjs` 按标签找按钮，改名会让它第二次按不中）。
- 🟢 **判据 16（merged manifest）**：`FOREGROUND_SERVICE` · **`FOREGROUND_SERVICE_DATA_SYNC`**（**模块自带 `AndroidManifest.xml` 合并进来了——§1.4 那条「不写第四个 config 插件」的路走通**）· `INTERNET` · `LarkTransferService` 的 `foregroundServiceType="dataSync"`，而 expo-audio 的 `AudioControlsService` 仍是 `mediaPlayback`。服务实测起得来：`isForeground=true` · `types=0x00000001` · 通知在 `lark.downloads` 渠道。
- 🔴 **判据 15 当场改写（原文两侧都绿，什么也没证明）**：原判据是「熄屏 4 分半下完 54.3MB」——**带服务与不带服务都逐字节下完**（`landed 54273999 of 54273999` ×2）。4 分半、内存宽裕、刚离开前台时 Android 根本不回收这个进程，**熄屏时长不是区分变量**。改成 **应用切后台 + `adb shell am kill`**（只杀「可以安全杀掉的」进程，**豁免持有前台服务的**）：不带服务 `pidof` **为空**，带服务 **pid 11213 存活**并在熄屏 3 分钟后 `task succeeded · 54273999/54273999 · 2226.646s`。子计划 §4 判据 15 已改写并附原文。
- ✅ **§1.6 答掉、决策 j 关闭**：熄屏下 `File.downloadFileAsync` 的传输照走（原生线程，chunk 不等 JS），**不加 wake lock**。
- **路上两个真 bug**：① 🔴 **Expo `AsyncFunction` 的最后一个表达式就是返回值**——`startForegroundService` 回 `ComponentName`，桥转不了，JS 拿到 `has been rejected. → Unknown type: class android.content.ComponentName`，**而服务其实已经起来了**；副作用型的 AsyncFunction 末尾要显式 `Unit`。② 长曲 BV1LtgV6ZE2U **有 2 个分 P**，链接不带 `?p=1` 会撞多 P 的 LLM 门（`LlmNotConfiguredError`）——**这是 N4a 提取的那条判断在设备上正确生效**，顺带把判据 28 的一半提前验了。
- **我自己的一条操作教训**：第一次 tap 完 arm 就直接看 `dumpsys`、看到服务在就熄屏等了四分半——服务在只是上面①的副作用，**下载根本没入队**。每一步的绿都要自己读过，不能靠旁证推断。
- **N4c-2 = `downloads/foreground.ts` 状态机**（全离线，测试 2759）：`arm` / `settle` / `handleTimeout` 三个入口 + 注入四样（service · hub 的 subscribe/getState · engine 的 snapshot/cancel · now/delay），降级态与 phase 存进 hub（决策 e），`engine.ts` 装配控制器并把 `onTimeout` 接上，通知权限走 `ensureAudioSession()`（决策 g）。**22 条单测**。
- 🟢 **判据 18 全绿（单测）**：`onTimeout` → **queued 与 running 一起取消** → `stop()`，且**取消在 stop 之前**，phase 置 `paused-by-system`。**6 小时配额没有真机证据，如实记「有代码路径、有单测、没有真机证据」。**
- 🟢 **判据 17 的逻辑半边全绿**：①手势那一刻就 `start`（此时零入队）· ②活动归零 **2 秒后**才停（1999ms 不停）· ③起不来照常下完、`degraded` 在 hub 里读得到且不碰任何任务。剩下的一半是 Android 在说话，留给 N4c-3。
- **v1 状态机有两个「没有触发源」的洞，都当场补上并记进子计划 §8**：① **`arming → idle` 那条边**——「预检后零入队」恰恰是没有 hub 事件，于是控制面是 `arm()` + `settle()` 两个调用（后者在调用方 `finally` 里）；② **`paused-by-system` 没有出边**——冻结的图只冻自动边，再点一次下载是用户的决定，配额真没了会落进 `degraded`。另有六条修订（`degraded` 归零也调 `stop()`、降级态带 `reason`、先置 phase 再取消、queued 先于 running、通知标题/正文分工、去重与节流分开测）。
- 🔴 **一条自己踩的假绿**：去重与节流并成一条断言时，**实现里完全没有去重也照样绿**——节流自己把重复的丢掉了。拆成两条、各自反测点着之后才算数。**八条反测逐条跑过**，列在 `foreground.test.ts` 文件头。
- **顺带的真实变化**：`downloads/engine.ts` 现在 import `modules/lark-transfer`，**生产 bundle 启动时就 `requireNativeModule('LarkTransfer')`**（此前只有 acceptance 构建碰它）——判据 20 后半句想要的正是这个性质。
- **N4c-3 = 真机验收**（子计划 §9 有逐条对照表）：acceptance 面板加六个入口（三态观测 · 降级态注入 · 后台 arm 的 arm/check 一对 · 停两次 · 两个服务的 arm/stop 一对），`DownloadRuntimeDeps` 加 `service` 注入缝。**判据 17 · 19 · 41 · 42 · 43 全关**，每条都是「应用自述 + 主机独立核对」两侧。（**本批新增的三条编号从 41 起**——N4 主计划把 20–25 给了 N4d，子计划再用一次 20–22 会让同一个里程碑里的「判据 22」指两件事。）
- 🟢 **17①②**：服务在**手势那一刻**起来（`phase arming · 0 active tasks`，主机 t+2s 见到 `isForeground=true · types=0x00000001 · 渠道 lark.downloads · importance=2`），25 秒**什么也没入队**的停泊期里一直在；活动归零 **+1.0s 还在、+3.5s 已停**，主机在 t+30s 看到它消失。**17③** 注入拒绝：`degraded / ERR_LARK_FGS_NOT_ALLOWED`，下载照样成功，且**没有对着不存在的服务说 update**。
- 🟢 **42**：服务 t+0 起、t+7 停，连停两次不抛，收尾时本包通知数 **0**。🟢 **43**：两个服务共存 **~45 秒**（`AudioControlsService` + `LarkTransferService`），t+21s **两条通知都在**，其间 `state:started` 的 AudioTrack 恒为 1，停下载不影响播放。🟢 **41**：守卫绿 + **生产包装机后正常启动**（启动即 `requireNativeModule('LarkTransfer')`，没抛）。
- 🟢 **19**：`pm clear` 后 `granted=false` → 点下载（**全程未播放**）→ 3 秒内 `granted=true`、服务在、通知在 `lark.downloads`。**反测**：`pm revoke` 后服务照起（t+3s、t+15s 都在）、**通知一条都没有**。（**对话框本身没截到**——这台机器三秒内就 granted 且带 `USER_SET`，是它代答还是弹了没抓到无证据；要证的「申请发生在下载路径上」成立。）
- 🔴 **反测答出第三种行为，并且改了代码**：**后台的 `startForegroundService()` 在这台机器上既不抛也不起——被延后到应用回前台**（后台窗口 16 秒 · 0.4 秒一采 · 一次没见到；回前台立刻出现）。① 对设计：反测比预想的更硬，「入队时刻起服务」= 整个下载期间毫无保护。② 对代码：`start()` resolve 只等于「系统收下了请求」，状态机原本只认抛异常，**这一整类下判据 17③ 的「降级态可读」是假的** → 加 `START_CONFIRM_MS`（start 成功后 2 秒回头确认一次，不 await、只降不升，落 `ERR_LARK_FGS_NEVER_STARTED`），带 generation 与 phase 两道守卫，单测 5 条 + 反测 3 条。**产品线够不到这条路径**（arm 永远由手势触发）。
- 🔴 **反测的第一版是错的**：用 `await wait(10_000)` 安排「后台 10 秒后 arm」——后台 JS 定时器冻结，那句 wait 到回前台才到期，arm 其实发生在前台，**得到一个看起来成立的反面结论**。改用 `AppState` 的 `change` 回调才测到真东西。
- **三条采样陷阱**（已进 `docs/LESSONS.md`）：**前台服务通知有约 10 秒延后**（前 10 秒 `dumpsys notification` 查不到，会误判成「服务在但通知没了」）· **`pm revoke` 会杀进程**、**`pm clear` 连外部夹具目录一起清** · **已在库里的曲目会把「长下载」变成 4 秒**（判据 22 第一次只共存 4 秒，验过程要先清库）。
- **本批不证明的**：6 小时配额（判据 18 只有单测）· 判据 43 量到的是「传输服务自己退场」而不是「取消进行中的下载」（长曲 45 秒自己下完了，对主张等价但记着差别）。
- **N4d 开工**（添加页 v1 + 任务列表 + 分享 intent）：子计划 `docs/plans/2026-08-21-phase-b-mobile-n4d.md`（三批 N4d-1–3 / 判据 20–25 + 新增 44·45）。**决策 a–j 于 2026-08-23 全部按倾向关闭，§5 是定案**。N4c 留给它的两件是 **`arm()`/`settle()` 接到提交按钮**（N4 决策 f）与 **hub 里的 `foreground` 渲染成降级提示**（N4 决策 e）。

#### N4d-1（2026-08-23）依赖与地基 —— 桌面全绿，设备那一步待跑

- **决策 a 落地：三张中文标签表提升进 `@lark/shared`**（新 `download-labels.ts`）。GUI 那份删掉、两个 importer 改成 `@lark/shared`；CLI `wait.ts` 的 `STAGE_TEXT` 拷贝删掉、改读 `STAGE_LABELS`（`stage === null → '排队中'` 留在 CLI，那是它的渲染口径不是枚举的）。**文案一个字没改**，`progressLabel` 从私有改成导出（手机要同一条进度短语）。**新增 17 条测试**——两份拷贝原本都没有测试，而「加一个 stage 会红」正是提升的理由。
- **决策 k + f 落地：`portable/naming-mode.ts`**。与 `play-mode` / `now-playing-mode` 同族（`local_metadata` 一个键、读路径永不写库、值域外读成默认并 warn），**但读与默认拆成两个函数**：`readNamingMode` 回 `DownloadNamingMode | null`（`null` = 从没选过），默认由 `resolveNamingMode({ remembered, hasLlm })` 决定——`clean` 在没有模型的装机上不是偏好而是一堵墙，所以默认不能是常量。**记住的值永远优先**，包括「记着 clean 但模型没了」（chip 会 disabled 并说明原因，替用户改选择比一个带理由的灰按钮更糟）。**17 条测试**。
- **决策 d 落地 + 判据 23 的逻辑半边：`downloads/cancel.ts`**。取消的三种结果（`cancelled` / `refused` / `already-done`）各自作答，「全部取消」是 N 个答案不是一个。**与 `handleTimeout` 共用的是口径与顺序**（`isActive` + `activeInSweepOrder`，queued 先于 running），**错误策略两边各留各的**：系统收权那条对无法解释的错误照旧向上抛（N4c 的断言原样保留），用户点取消那条把 `TASK_NOT_FOUND` 读成「已经结束了」——id 来自这块屏幕刚渲染的列表，它消失只可能是终态后被 ring 滚掉。**14 条测试**，含「一条过了落盘点不能让另外两条报失败」与「不能整批报成功」。
- **`downloads/use-downloads.ts`**（hub 的 `useSyncExternalStore` hook，无 selector 参数——selector 的返回值会被 `Object.is` 比较，正是 hub 特意避开的无限重渲染）+ **`ui/task-list.tsx`**（决策 c：直接渲染引擎自己的 ring，进行中在上、终态最近 20 条；降级/配额两条提示；失败行显示 `error_message` 原文）。**接进了占位的 AddTab**，否则这一批的东西在设备上看不见——粘贴框仍是 N4d-2。
- 🟢 **§1.6 的 `singleTask` 风险在主机上就答完了，不成立**：两次 prebuild 对拍（插件整块摘掉一次、装回去一次，diff 生成的 `AndroidManifest.xml`）——**插件的全部改动是一个 `<intent-filter>`**（ACTION_SEND + `text/*` + DEFAULT），别的一个字没动。`launchMode="singleTask"` **本来就是 Expo SDK 57 模板的默认值**，插件的 `withAndroidMainActivityAttributes.js:32` 只是把同一个值又写了一遍。**任务栈语义从 N2 起没变过**，`bootOnce` 与 N3 的所有真机 session 一直在它下面跑。判据 44 因此收窄成「新依赖没把构建和启动搞坏」，仍要在设备上走三条路径。D16 的两条 backup 属性在 prebuild 后仍是我们自己的 xml（`with-backup-rules` 没抛）。
- **桌面基线**：`just check` exit 0（八条守卫 + 两个 bundle smoke）· `just test` exit 0 / **2812 passed**（shared 146 · core 1243 · mobile 100 · cli 428+9 skipped · daemon 468 · gui 427）· `just mobile-typecheck` exit 0。依赖变动（`expo-share-intent@8.0.1` + `expo-linking@57.0.6`）后的常驻规矩已复跑。
- 🟢 **判据 44 全绿**（2026-08-23 真机，冻结设备 vivo V2408A，release 装机）：**冷启动**前台是 `.MainActivity`、pid 存活、logcat 无 FATAL · **按 BACK 退出再打开**——进程号不变（25875）而 ActivityRecord 与 task 都换了（`2ca8b91/t18922` → `401cd6e/t18923`），**即 Activity 真的被销毁重建了**，正是 N2 那个 expo-sqlite 陷阱的原地，`bootOnce` 顶住，无 `NullPointerException` / `prepareSync` · **去设置再切回来**同一个 ActivityRecord（`401cd6e`），`singleTask` 只有一个实例。装好的 APK 上另外两条也核过：**系统的 ACTION_SEND 解析器已经列出 `com.orpheusaviary.lark.MainActivity`**（判据 22 的前置成立），`FOREGROUND_SERVICE_DATA_SYNC` 仍在（N4c 的模块自带 manifest 没被新插件挤掉）。任务列表这块新屏幕在 release 下渲染正常（空态「还没有下载任务」；无活动任务时不出「全部取消」，`phase=idle` 时不出降级条）。

#### N4d-2（2026-08-23）添加页 v1 —— 桌面全绿，五条判据等设备

- **`ui/add-tab.tsx` 落地 §2.2 的状态机**：粘贴框（400ms 去抖，决策 g）→ 离线 parse → 命名 chip（`clean` 无模型时 disabled 并写明原因，决策 f）→ 目标（默认「仅曲库」+ `Sheet` 选已有歌单，决策 b）→ 提交 → 清空回任务列表。**shell 的占位 AddTab 删掉**，四个 tab 现在都真的做事。
- **`downloads/preflight.ts` 是 portable 的薄壳**：`recognise`（离线 parse + 至多一次短链跳，`onResolving` 在跳之前同步触发 = 判据 21 的落点）+ `submitDownload`（`arm()` → `preflightSingle` → `enqueue` → `finally settle()`，N4c 决策 f 留下的最后一处接线）。
- 🔴 **加了一层计划里没有、但判据 22 没有它就过不去的东西：`findSource`**。N0b-4c 实测的分享原文是**标题和短链在同一行**（`EXTRA_TITLE` 为空），整行读作自由文本 → keyword → 撞 LLM 门，于是**手机上最可能的那种输入会被拒绝，「正在解析」从一次真实分享里永远到不了**。只在整行读作 keyword 时启动，每个候选原样过 `parseSongInput`（结构检查一条不少），第一个可用的胜出；解析成 URL 却被拒的那个会被记下来，因为「youtube 不是 B 站链接」比「关键词搜索需要配置 LLM」说明得多。详见子计划 §8.2-1。
- **三处顺带修正**：提交不再重复展开短链（`recognise` 交回的已经是展开后的 item）· **引擎与预检共享一个 `BilibiliClient`**（此前是两个匿名 buvid + 两份 WBI 缓存）· keyword 的拒绝语**由 portable 现说不抄**（真的调一次 `preflightSingle`，零网络），唯一自己写的句子是收藏夹/合集那条——portable 那句点名了手机上不存在的两个 HTTP 路由。
- **18 条新单测**（判据 21 · 25 的逻辑半边 + arm/settle 的括号），**三条反测逐条跑过、都红在该红的那条**：`onResolving` 挪到 hop 之后 → 判据 21 那条红 · 拿掉 `findSource` → 分享文本三条红 · `settle` 移出 `finally` → 两条红。
- **桌面基线**：`just check` exit 0 · `just test` exit 0 / **2830 passed**（mobile 118）· `mobile-typecheck` exit 0。
- 🟢 **判据 20 · 21 · 23 · 25 全绿**（2026-08-23 真机 session，冻结设备 vivo V2408A，release，5G）：
  - **20**：粘 `b23.tv` 短链 → 预览 `BV176M3zPEZu`「短链已展开 · 第 1 P」→ 提交 → 下载 + 派生歌词两条任务 → **歌曲 tab 有它、2:17、无「需要下载」标记、曲库目录 1 个**。长曲那条另测：54MB 约 6 秒下完，**时长 37:07** 说明整文件落盘（N4b 的 ③b 完整性检查过）。**一条如实记的：进度没采到**——传输比第一次采样还快完成，进度是在判据 23 的长曲上看到的（`下载音频`）。
  - **21**：screencap 连拍抓到瞬态——**spinner + 「正在解析短链…」**，此时提交按钮仍禁用；随后落到真实 bvid。（`uiautomator dump` 一次约 700ms，比「去抖 + 一跳」还慢，抓不到。）
  - **23**：长曲重下、在 `下载音频` 阶段点取消 → 回答「已取消《…》」、任务终态 **已取消**；**曲库 1 首 / 曲库目录 1 个，两数相等 = 没留残骸**。聚合与文案那半按判据原文归单测（14 条）。
  - **25**：`https://www.youtube.com/watch?v=x` → 「www.youtube.com 不是 B 站链接…（下载只支持 bilibili.com）」· 一段乱码 → **portable 的原话**「关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接」· 顺带撞到第三句「视频链接里的 id 不是合法 BV 号…」。
- 🔴 **判据 24 在这个构建上无法在设备上验证，推到 N4e**：决策 f 决定了没有模型时默认 `original` 且 `clean` 是灰的——屏幕上**只有一个可选模式**，「选过一次下次默认是它」没有可观测差别。逻辑半边 17 条单测守着（读写往返 + `resolveNamingMode` 三条规则 + 「记着 clean 但模型没了不改选择」）。形状同 N4c 的判据 18：**有代码路径、有单测、没有真机证据**。
- 🔴 **真机当场逼出一个排序 bug 并修掉（新增 `downloads/rows.ts` + 7 条单测）**：`engine.snapshot()` 交回 Map 插入序（**最旧在前**），而 `hub.ts` 头注释写的是「Newest first」——列表照着它 `slice(0, 20)`，于是**最新的终态排在最底下、砍掉的也是最新的**，与决策 c 的「终态只留最近 20 条」相反。**是设备逼出来的，但设备看不见它**：`FlatList` 只渲染放得下的行，被排到屏幕外的行和不存在的行长得一样（取消明明成功，列表里却找不到那条）。顺序因此提成纯函数去测，设备只复验一个人眼看得出的差别——**一次下载派生的「歌词」任务后完成，现在排在最上面**。两条踩坑进 `docs/LESSONS.md`（还有一条：`input tap` 打在输入法窗口上，而 `uiautomator dump` 只报应用坐标）。
- **另一处顺带实测**：格式合法但不存在的 BV 号，预检的 `pagelist` 当场回 -400 → **页面上直接显示「bilibili API error -400: 请求错误」，根本没有任务进队列**——正是 §1.1 想要的「不要提交之后从任务列表里冒出一条红字」。
- **收尾基线**：`just check` exit 0 · `just test` exit 0 / **2837 passed**（mobile 125）· `mobile-typecheck` exit 0。

#### N4d-3（2026-08-23）分享 intent —— **N4d 完成**

- **`share/intent.ts`（根层 hook）+ `share/draft.ts`（内存单例）**，拆两个文件的理由同 `rows.ts`：hook 引原生模块测不了，而要守的规则（**取走即清空 · 通知不等于消费 · 空分享不算草稿**）一个 import 都不需要。**10 条单测**，两条反测都红在该红的那条。接线三处：`App` 顶上挂 hook（**在 boot 状态之上**，冷启动的分享在 bundle 跑起来十几毫秒后就到，那时库还没开）· `Shell` 的初始 tab 读 `hasShareDraft()`（**不消费**）并订阅切 tab · `AddTab` 在 `useState` 初值和订阅里各取一次（前者管冷启动，后者管「已经停在添加 tab」——那时 `setTab('添加')` 是空操作、不会重新挂载它）。
- 🟢 **判据 22（gate）绿，四条路径 + 完整反测**：**真 bilibili app 视频详情页分享 → 冷启动开在「添加」**（默认 tab 是「歌曲」）；合成 intent 的**前台**（`intent has been delivered to currently running top-most instance` = `singleTask` + `onNewIntent`）、**后台存活**（任务被拉回前台）、冷启动。**反测走了完整一轮构建**：`useShareIntentBridge()` 从 `App` 搬进 `AddTab` → 重新装机 → 冷启动分享落在「歌曲」、**什么也没收到**；还原重装后又收得到。
- 🟢 **判据 45 绿**：消费过之后 force-stop 重开 → 落在默认「歌曲」tab、添加页是空的（草稿不诈尸）。
- 🟢 **真机直接兑现了 §8.2-1 那个偏离计划的改动**：bilibili 发来的是 `当你意识到这首歌不是《东南苦行山》时…… https://b23.tv/3Prw96Q` ——**标题和短链同一行**，预览显示「从这段文字里认出了链接 · 短链已展开 · 第 1 P」+ `BV1MN9ZBCE8i`。**没有 `findSource` 这一条会撞 keyword 门**，「正在解析」从一次真实分享里永远到不了。
- **N4d 收尾基线**：`just check` exit 0 · `just test` exit 0 / **2847 passed**（shared 146 · core 1243 · **mobile 135** · cli 428+9 skipped · daemon 468 · gui 427）· `mobile-typecheck` exit 0。
- **N4d 未结的一条**：**判据 24 推到 N4e**（无模型的构建上只有一个可选命名模式，没有可观测差别；17 条单测守着逻辑半边）。**下一步 N4e**：LLM 设置页与它解锁的四条能力（关键词 / clean 命名 / 多 P 选集 / 重新识别），外加判据 24 的设备半边。子计划 `docs/plans/2026-08-23-phase-b-mobile-n4e.md`（三批 N4e-1–3 / 判据 24 + 26–30）。**决策 a–i 于 2026-08-23 全部按倾向关闭，§5 是定案**。用户同日拍板三条：**手机上填与桌面同一份 url + model + key** · **设置页加「测试连接」** · 🔒 **移动端的 LLM 配置只有「设置页本地填」这一个渠道**——没有 aviary 回退、不从桌面导入、不进同步、不内置默认端点（子计划 §0 有渠道冻结段）。

#### N4e-1（2026-08-23）存储与接线 —— 三道门第一次可以开

- **`portable/llm-config.ts`（新）+ 18 条单测**：`local_metadata` 的 `llm_url` / `llm_model` / `llm_api_format`，形状照 `now-playing-mode.ts`（读路径永不写库、不认识的值 warn 一次并回缺省、不进 `sync_changes`）。**决策 a 落地**：值域只有 `openai` / `anthropic`，缺省 `openai`；桌面合法的 `''`（= 跟随 aviary）在这里是「不认识的值」——`''` 打头的六个 junk 各一条用例，行原样不动。**三个键一起写**（`transaction().immediate()`）：半份配置 = 新 url 配旧 model，那是没人填过的组合、失败起来还像 provider 的错。url/model **写入时 trim**（`chatCompletion` 只 trim url，model 是原样进请求体的）。
- **`apps/mobile/src/settings/llm.ts`（新）**：库里三个字段 + SecureStore 的 `lark.llm.api_key` 拼成一份 `LlmConfig`。**全同步读**（`SecureStore.getItem` 是同步的，N2c 起就靠这一点），**没有缓存**（§1.2：缓存会让「刚在设置页改完、添加页还是旧的」成为新 bug）。`saveApiKey` 与 `clearApiKey` 分成两个函数，是因为设置页不回显 key——空输入框的意思是「别动它」，只有「清除」才是删。`testLlm()` 用**草稿**（决策 f）跑一次最小 completion，**deadline 取 `DEFAULT_TIMEOUTS.llm`**，与真命名调用同一个预算：测试比它预测的那件事更早放弃，报出来的失败产品本来不会有。
- **`downloads/engine.ts` 换成现读、`NO_LLM_CONFIG` 删除**：`getLlmConfig: () => readLlmConfig(boot.db.sqlite)` · `hasLlm: () => hasLlmConfig(boot.db.sqlite)`。四处消费端（preflight 的三道门 + `reidentifySource`）**一个字没改**——它们本来就在按 `deps.hasLlm` / `deps.llm` 分支，这一批只是让那个布尔值第一次可以是 `true`。**决策 d 写进了 `DownloadRuntime.hasLlm` 的注释**：不订阅是因为四个 tab 条件挂载、设置页与添加页不可能同时可见，将来加分栏或 modal 时这是第一个断的假设。
- **两条反测都红在该红的地方**：① 去掉 `writeLlmEndpoint` 的事务 → 「是全三个或一个都不是」当场红（写到第三句才失败，前两句已经落了）；② 往 `settings/llm.ts` 塞一句 `import 'node:crypto'` → Metro 打出完整 import stack（`settings/llm.ts ← downloads/engine.ts ← App.tsx ← root.ts ← index.ts`），**证明这个新文件真在图里**，不是「孤立文件塞什么都是绿的」那一种。
- **基线**：`just check` exit 0 · `just test` exit 0 / **2862 passed**（shared 143 · **core 1261** · mobile 135 · cli 428+9 skipped · daemon 468 · gui 427，较 N4e 子计划记的 2844 +18）· `mobile-typecheck` exit 0 · bundle smoke **111 个 portable 模块**（+1）。
- **本批留给 N4e-2 的两件**：① **脱敏还没做**（§6 第二行 / 判据 30②）——`chatCompletion` 在非 2xx 时把 provider 的响应体原样塞进错误文案，`testLlm` 现在也原样往回递；判据 30 排在 N4e-2，脱敏落在哪一层（core 的 `chatCompletion` 一处管三个采样点，还是显示侧各管各的）跟它一起定；② **`AddTab` 在渲染体里读 `hasLlm()`**（§1.5 记着的形状）——以前读的是常量、免费，现在每次重渲染都是一次 SQLite + 一次 Keystore 往返，而这块屏幕**每敲一个字就重渲染一次**。正确性不受影响（决策 d 只要求重挂载时重读），要不要收成 per-mount 由 N4e-2 一并处理。


- **N4b 判据 5–14 全部关闭（head `fd38d09`）。** 下一步 **N4c dataSync 前台服务**——子计划已出：`docs/plans/2026-08-21-phase-b-mobile-n4c.md`（**v1 待评审**，三批 N4c-1–3 / 判据 15–22 / 决策 a–j 待关闭）。**开工前必须先答的一件**：`File.downloadFileAsync` 的传输在熄屏时到底跑在哪（§1.6）——答错了整批形状要改（决策 j 的 wake lock 翻面），所以 N4c-1 的第一件事就是量它。




**范围修订：判据 16b（D2D device-transfer restore）搁置**（2026-08-19 用户决定，「这不是第一版软件需要保证的」）——子计划 §8.2 存了原文与接回步骤。**搁置的是验收不是实现**：`<device-transfer>` 的九个 domain 照写（与 `<cloud-backup>` 同一份 xml 的两段），判据 16a 仍逐 domain 验文件内容；不做的是走一遍系统「手机搬家」再断言四类数据没过来，于是**这一半是「声明了但没验过」**。代价可控的理由：D16 的兜底不在排除规则上而在收敛上，**判据 17 注入的正是「OEM 无视排除、DB 真被恢复了」那个夹具且没有搁置**——排除规则失效恰恰是它的前提。N2c 的 gate 因此是 16a / 17 / 18 / 19 四组。

**决策 a–o 已于 2026-08-19 全部关闭**（用户「照建议关」），子计划 §5 是定案。建议里留白的三处由这一轮一并定死：**决策 a** 取自建 Expo native module + **minSdk 升 26**（判据 10⑤ 因此从「API 24/25 模拟器复跑」改成「断言合并 manifest 的 minSdkVersion = 26」，判据 10① 一律走 instrumentation 两线程 + barrier，`AsyncFunction` 只是「别卡 JS 线程」的理由不是验证机制）· **决策 c** 的 config 字段定为 `local_metadata` 的 `now_playing_mode`（值域 `'title' | 'lyrics'`，缺行或非法值一律读成 `'title'` 且不写回，无版本字段——语义变了就换 key）· **决策 o** 的判据 14 走 **normal**（acceptance 导入通道同时写 DB 侧 `install_id` = 本机 committed 值），理由是 converge 会清 binding/sync 并重建 `device_uuid`，把曲库判据的失败和 D16 的失败搅在一起；converge 由判据 17/18 专测。

**v1 的三条 P0 都不是「写漏了」，是「按它实施会红」**（逐条已代码复核）：

- **移动 bootstrap 缺 `device_uuid` → 一切业务写入抛错**：`ensureDeviceUuid` 在 `db/index.ts:145`，签名吃的是 **`BetterSqlite3.Database`**——N1 没把它端口化，它留在了桌面那半；而 `readLocalDeviceUuid`（`portable/sync/changes.ts:100`）缺行即抛，每一次会 emit `sync_changes` 的写入都过它。v1 的六步 bootstrap 只迁移、验 schema、清 pending，判据 11 的契约与判据 13 的全部写路径会在第一次写入时红。→ 下沉为 portable 的 `ensureDeviceUuid(sqlite: SqliteLike)`（uuid 取 Random 端口），桌面 re-export，桌面现有四条测试原样绿是零行为变化的判据
- **「删除只入队不执行」与现有服务和契约直接冲突**：`portable/library/songs.ts:382` 的 `deleteSong` 在事务后**无条件** `await options.fileOps.drain()`，而契约那一例的名字就叫「deleting a song takes its files with it, not just its row」（`contract/cases.ts:255-262` 断言 `!songFilesExist`）。「只入队」「契约 18 例全绿」「删除后目录还在」三条**不可能同时成立**。→ **file-op 执行器与 boot drain 从 N4 提前到 N2**，判据改成「journal 已消费且目录已删除」
- **D16 排在打开原库之后 = 它自己的不变量不成立**：v1 把正常打开与迁移放 N2b、D16 放 N2f，等于让身份门跑在它要保护的东西后面。→ §2.2 **冻结启动序列**：`installPortableRuntime → 源文件在不在 → copy-then-open 身份判定 → 必要时收敛 → 打开原库 → 版本分派/迁移 → ensureDeviceUuid → 服务/UI`；D16 提前到 N2c，N2b 明令不推真实副本。顺带补上 v1 缺的定义（SecureStore key 与状态转移表 · fail-closed 清哪些表 · **不复用 `unbindLibrary`**——它为「用户主动解绑」而写、带 pending 检查且要完整 `CredentialStore`（`unbind.ts:51-67`）· **收敛后 `device_uuid` 必须重建**，否则两台安装共享本机身份）

**另外五条 P1 也都属实**：① 打开协议只写了 fresh 库，而 `db/index.ts:51-58` 有**六类分派** → 补完整矩阵 + 决策「v1/v2 库拒绝而不迁移」；② **判据 10 会假绿**——桌面的「读 400 次」之所以观测得到，是因为 `writeTextAtomic` 是异步的给了事件循环窗口（`node-fs.test.ts:60`），同步 native 调用下同线程轮询恒为真，换成 `moveSync(overwrite)` 也全绿；顺带 **`FileSystemModule.kt:32` 是 `@RequiresApi(O)` = API 26 而 prebuild 实测 minSdk 24**，且 CNG config plugin ≠ Expo native module（前者改生成的原生工程，后者要自己的源码 + autolinking）；③ **真机夹具跑不起来**——`Paths.document` 是私有目录、release 包 push 不进去，两个驱动脚本还硬编码 `com.orpheusaviary.lark.spike`（`drive.mjs:32` / `backup-audit.mjs:28`），且真实桌面 v3 副本天然没有移动端 install_id、推进去会主动 fail-closed；④ **蓝牙歌词的两条回落不可区分**——`parseLrc` 只收带时间戳的行，「没有歌词」与「纯文本无时间戳」都返回 `[]`，五条并成四条；⑤ **「四种排序」没有落点**——`shared/types.ts:57` 只有三个字段，`default`/`duration` 是 GUI renderer 本地逻辑而守卫禁止 mobile import GUI。

**两处数字更正**：`LibraryService` 是 **22** 个方法（v1 写 24、评审说 21，都不对）；契约 **18 例六组**含 cache 1 + transfer 1，所以 mobile hook 必须接 `exportPlaylist` 与 `cacheUsedBytes`，即使这两块的产品功能在 N4/N6。

v1 那条读源码读出来的发现原样保留：

- 🔴 **expo-file-system 57.0.4 在 Android 上没有原子替换**，而 `FileSystemPort.writeTextAtomic` 的合同要求「同目录临时文件 + 原子 rename 覆盖」（`portable/ports/fs.ts:41-61`，N1 §2.4 明写做不到要带回来做决策、不许适配层悄悄弱化）。两条路都堵着：**`moveSync(dst,{overwrite:true})` 先删目标再 rename**（`fsops/CopyMoveStrategy.kt:88-91` 的 `deleteRecursively()`，之后第 95-99 行那句自称 "Fast path: atomic rename" 的 `renameTo` 才跑）——窗口里读到的是「文件不存在」，而 `readText` 把不存在返回成 `null`，也就是**「歌词没了」而不是「歌词是旧的」**；**`rename(newName)` 拒绝已存在的目标**（`FileSystemPath.kt:201` 的 Kotlin `Path.moveTo` 默认 `overwrite = false`）。这正是 N1 §8 预留的那个「单独决策」，成了 N2 的决策 a（建议自建微型 Expo module 走 `Files.move(..., REPLACE_EXISTING, ATOMIC_MOVE)`）。顺带确认**五个端口调用的同步变体都在**（`info()` / `delete()` / `write()` / `textSync()` / `moveSync()`），缺的只有原子性这一条
- **蓝牙歌词进 v1，只做 Android**（2026-08-19 用户决定，主计划 §4.5 已加修订段）：机制是**复用 AVRCP 的 TITLE 字段**（关 = 歌名，开 = 当前歌词行），应用侧不碰蓝牙 API 只写系统 Now Playing。**桌面整个不做**——`MPNowPlayingInfoCenter → AVRCP` 这一跳查不到 Apple 的任何承诺，而桌面只有 mac 一个 target。落点：判定函数（`@lark/shared` 纯函数，唯一有逻辑的地方）+ config 字段 → **N2**；订阅/节流/开关 UI → **N3**。`expo-audio@57.0.3` 的 `updateLockScreenMetadata` 已经是**同步** API（`AudioModule.kt:516` 注册为 `Function`），底层 `MetadataInjectingPlayer` 自带去重，**不需要写原生模块**。**未实测的风险**：AOSP `MediaPlayerWrapper.isMetadataSynced()` 在 queue 非空时比对 queue item 与 metadata 的 (title, artist)，不一致要等 `CALLBACK_TIMEOUT_MS = 2000` 才推——歌词写进 title 正中这个分支。用户**没有带屏蓝牙接收端**，两个实测都不做，先按成熟方案开发

**N1a 的六条实测**：

- **`TextDecoder` 的默认值会静默改掉桌面行为**：它**剥掉** BOM 而 `Buffer.toString('utf8')` 留着，而 `parseAndValidate` 的下游是 `JSON.parse`——它拒绝带 BOM 的文本。照默认写，带 BOM 的导入文件就从「报错」变成「静默接受」。`decodeUtf8` 因此是 `{ ignoreBOM: true }`（这个选项名是反的：true = 保留），BOM 作为第五条 decode 夹具进了常跑测试
- **宽松 base64 有两处 `atob` 之外的分歧**：`Buffer.from(v,'base64')` **遇到第一个 `=` 就停**（哪怕在串中间），且读的是每个 UTF-16 单元的**低字节**——所以夹在中间的 `歌`（U+6B4C）贡献的是 `L` 而不是被跳过。端口按这两条写，20,000 条随机串差分（两套字母表 + padding + 空白 + 非法 ASCII + CJK + 代理对）零分歧
- **守卫的全局 token 半只能读代码**：裸词会红掉「better-sqlite3 hands back a Buffer」这种正确注释；只按代码形态匹配、但不剥注释，仍会红掉 `portable/runtime/base64.ts`——**一个端口必须能说出它在移植什么**。最终形态 = 先剥 `//` 与 JSDoc 再按形态匹配，八条探针（六种代码形态红 / 注释与 JSDoc 绿）
- **`async` 不等于非阻塞，所以整文件 digest 没有缺省**：Promise 包一层同步 noble 照样卡 JS 线程而调用方看不出来。桌面经 core barrel 装 `node:crypto`，移动端在 N6 开放歌单导入前必须自己装，**未装即抛**就是那道门
- **原子写要观测不要断言**：6MB 替换在飞的时候读目标 400 次、每次必须整旧或整新，另一条抓临时文件必须是同目录兄弟（跨文件系统 rename 等于复制，复制就有那个截断窗口）。两条在换成朴素 `writeFile` 时都红——**先把实现换掉跑一遍**才知道测到了
- **Metro smoke 读的是图不是源码**：`expo export:embed` + sourcemap 的 `sources`，1.5s 一次。它能答 rg 守卫答不了的三件事（依赖自己 import 了 builtin / 包的 export map 在 Metro 下解析成另一个文件 / 经 dist 传递进来的 import）。两条反测都点着：portable 里塞 `node:fs` → 报出**具体是哪个 portable 文件**；让一个纯 JS 的 core 模块混进图 → 报出 `download/link.js` 与 `errors.js`。**recipe 必须先 `build-core`**——spike 经 dist 消费 core，源码改了不编译对 Metro 不存在（N0b-5b 同一条）

| 批 | 内容 | 本批 gate | 状态 |
|---|---|---|---|
| Stage-1 | 主计划 §4.3 两处语义修订（N0a 行 c2 收窄 / N0b 收窄为平台 spike ↔ N1 加 R1–R5 与 D5 分段冻结）+ 本段开张 | 单事实源：Stage-1 不做完，N0a 不开工 | ✅ 2026-08-17 |
| N0a-1 | `portable/` 搬迁（schema + migrations + migrate + schema-signature + errors 三类 + `migration/pending.ts`）+ `SqliteLike` + exports + 守卫（判据 1–4、7–10） | `just check` + `just test` 绿 | ✅ 2026-08-17 |
| N0a-2 | DatabaseContract harness（52 例 / 6 组）+ better-sqlite3 文件库包壳 + fake-leaky 反测（判据 5–6） | core 测试绿，假绿检查记录在案 | ✅ 2026-08-17 |
| N0b-1 | spike 脚手架 + 内部包白名单守卫 + workspace 共存（判据 11–13） | **12、13 绿** | ✅ 2026-08-17 |
| N0b-2 | expo-sqlite shim + harness 真机 + migrations/pending + op-sqlite 对照 + drizzle 定案（判据 14–17） | **14、15、17 绿**，D4 出口写定 | ✅ 2026-08-17 |
| N0b-3 | 卡顿 proxy + crypto 定案 + Web 标准全局面清查（判据 18、20–21） | **18 绿** + 20 定案 + 21 清单产出 | ✅ 2026-08-17 |
| N0b-4a | 桌面夹具（音频 + `openAudio()` header 集 + WBI 三件套）+ bilibili 探针 + skybridge SDK（判据 22、23 与判据 19 的流探针一半） | **22 四条硬 gate 绿**、23 双网络绿 | ✅ 2026-08-18 |
| N0b-4b | 播放判定（判据 19 的 expo-audio 一半：时长/seek/暂停/后台锁屏/焦点/蓝牙断连，单 player 与 playlist 各一遍） | **D17 判定写定：raw 直存达标 GO**；两条 expo-audio 行为缺口留给 N3 | ✅ 2026-08-18 |
| N0b-4c | 分享 intent（判据 24，`expo-share-intent@8.0.1`：真 bilibili 分享 + 冷/后台/前台三路径 + 文本逐字符回读）+ §9 汇总 | 24 记录（软判据） | ✅ 2026-08-18 |
| N0b-5a | D16 机制（判据 26）：backup 排除 CNG plugin + SecureStore 载体 + copy-then-open 协议与计时 + 三层客观判据 | **26 绿** | ✅ 2026-08-18 |
| N0b-5b | D14 落定（判据 25）+ GO/NO-GO 汇总 + **Stage-2 主计划修订** | **25 绿；N0b = GO** | ✅ 2026-08-18 |
| N1a | 地基：错误 45 类 + `StructuredLogger` 进 portable · `portable/runtime/` 四件与全部触点改写 · `portable/ports/` 六接口 + 桌面 adapter · 守卫全局 token 半 · Metro bundle smoke recipe | 全测试 + 判据 3–7、19 | ✅ 2026-08-18 |
| N1b | 断边与拆分：`DownloadTarget`/`findSongByKey` 下沉 · file-ops A/B 拆分 + `FileEffectLike` · `countQuarantined` 注入化 | 全测试 + 判据 8 | ✅ 2026-08-18 |
| N1c | PortableDb 收敛（`sqliteOf` 退役 + 类型换血）· FileContext/CredentialStore 接线 · 守卫 `sqliteOf` rg=0 | 全测试 + e2e 19 + 判据 9 | ✅ 2026-08-18 |
| N1d | download client 层进 portable（9 模块 + lyrics/ + 测试，24 文件 8 行改动） | 全测试 + 守卫 + smoke（36 → 51 模块） | ✅ 2026-08-18 |
| — | **R1–R3 真机预跑**（计划 §4 建议动作；正式判据仍在 N1i） | **R1 双网络各 9/9 · R2 8/8 · R3 双网络绿** | ✅ 2026-08-18 |
| N1e | sync + library 强连通体进 portable（52 文件搬迁，正文零改动；两个音频文件名常量随 `PathsPort` 走） | 全测试 + 守卫 + smoke（51 → 80 模块）+ e2e 19 | ✅ 2026-08-18 |
| N1f | SyncCoordinator 提取（八文件 + triggers 对半拆 + `CoordinatorContext`；daemon 只剩组装与定时器/SSE 壳） | 全测试 + 守卫 + smoke（80 → 90 模块）+ e2e 19 + **`accept-sync` 34/34** | ✅ 2026-08-18 |
| N1g | LibraryService + daemon 路由与 CLI direct 同时消费（两个 commit：服务层 / LibraryContract 18 例 × 两 hook） | 全测试 **2571** + smoke（90 → 94 模块）+ **`accept-cli` 27/27** + **contract 两 hook 全绿、mobile hook 显式 skip** | ✅ 2026-08-19 |
| N1h | AudioLanding 切面 + download 编排进 portable（两个 commit：切面与 commit 协议测试 / engine·batches·pipeline 搬迁） | 全测试 **2576** + smoke（94 → 97 模块）+ **`accept-m5` 22/22**（真 bilibili） | ✅ 2026-08-19 |
| N1i | 守卫收编（Metro smoke 进 `just check`）+ `SYNC_PULL_LIMIT_MOBILE` + R5② 接线测试 + **R1–R5 真机全绿** + D5 分段冻结 + 文档 | 全测试 **2578** + 七守卫 + **R1 9/9 · R2 8/8 · R3 绿 · R4 绿 · R5 绿** | ✅ 2026-08-19（判据 22 的发布物复跑待定） |
| N2 | `apps/mobile` 本体 + **D16 身份门** + 数据层（含 `ensureDeviceUuid` 下沉）+ 端口实现与 **file-op 执行器** + 服务层接线 + 四 tab 骨架 + 蓝牙歌词判定函数（七批 N2a–N2g） | 子计划 `docs/plans/2026-08-19-phase-b-mobile-n2.md` 判据 22 条 | ✅ **2026-08-20 全部完成**（判据 1–21 全过；**16b 与 14 的拖柄重排已按用户决定不做**，见 §8.2/§8.3）；全测试 **2628** |
| N3 | 播放：PlayerDriver + 队列与四模式 + minibar / 全屏页 / 队列面板 + 后台锁屏 + 蓝牙歌词接线（六批 N3a–N3f） | 子计划 `docs/plans/2026-08-20-phase-b-mobile-n3.md` 判据 25 条 | ✅ **2026-08-20 全部完成**（六批 N3a–N3f，判据 1–19 + 21–25 全过；**18 与 21 只记录不判定**、**20 已按用户决定搁置**、15 的「无文件的歌」夹具里没有）；全测试 **2729** |
| N4 | 下载：移动 AudioLanding + 落盘协议 + 启动清扫 + 添加页 + 分享 intent + **LLM 设置页** + **收藏夹/合集批量** + **dataSync 前台服务** + ensure-file + 缓存管理 + 歌单导出（七批 N4a–N4g） | 子计划 `docs/plans/2026-08-20-phase-b-mobile-n4.md` 判据 40 条 / 决策 a–p | 🛠 **开发中**：**N4a**（纯桌面，判据 1–4）· **N4b**（判据 5–14）· **N4c**（三批，判据 15–19 + 41–43，子计划 `docs/plans/2026-08-21-phase-b-mobile-n4c.md`）**均已完成**（2026-08-21，测试 **2764**）。下一步 **N4d**（添加页 v1 + 任务列表 + 分享 intent，子计划 `docs/plans/2026-08-21-phase-b-mobile-n4d.md` **v1 待评审**，判据 20–25 + 44·45） |
| N5–N6 | 同步 / 收尾（框架见 N0 子计划 §5） | 各自子计划 | ⏳ |

**R1–R3 真机预跑（2026-08-18，release 构建 · 冻结设备 vivo V2408A · 移动网络与 Wi-Fi 各一遍）**——N1d 刚把 client 层搬进 portable，趁热验「**core 自己的代码**在手机上跑出同样的答案」。跟判据 23 的区别是根本性的：那次是桌面做完 core 的活、设备复现，这次设备上跑的每一行都是 `@lark/core/portable` 的 import，桌面只出**输入**与**它自己算出的参照**（`make-network-fixtures.mjs` 的 `references`，同一份 core）。

- **R1 双网络各 9/9**：`signWbiParams` 在 Hermes 上对同一组 (keys, params, wts) 产出与桌面**逐字节相同**的 `w_rid`（`ebe73d7a…`，整条 query 也相同）· buvid3 经**安装的 Random 端口**成形（RN 没有 `getRandomValues`，不装就抛——这条正是端口存在的理由）· 设备侧现取 WBI key 现签的 search 拿到 20 条 · `view`/`pagelist`/`audioStream` 全过 · b23 一跳展开与桌面同 bvid · **`openAudio()` 流式读到 268KB/40 chunk（移动网络）与 270KB/42 chunk（Wi-Fi），abort 后再读抛 `AbortError`**
- **playurl 按调用方派节点这条，现在是用 core 自己的 client 量到的**：移动网络拿到 `xy118x212x136x211xy.mcdn.bilivideo.cn:8082`（mcdn P2P 节点），Wi-Fi 拿到 `cn-bj-cc-03-03.bilivideo.com`——与桌面同一个。N0b-4a 的结论复现，且这次链路里没有任何 spike 自己的实现
- **R2 8/8**：8 条真实分享文本逐字段与桌面相同，**包括拒绝**——`bilibili.com.evil.test` 两边都抛 `InvalidSourceError`（一个悄悄接受了它的手机端会是同一个守卫上的洞）。顺带把 N0b-4c 的发现钉成了对照：真 bilibili 分享文本（标题 + b23 短链）解析成 **keyword** 而不是链接
- **R3 双网络绿**：qq 中选，三个平台都出了候选，与桌面同一组。**但 LRC 内容不是稳定的**——移动网络那遍 1233 字 64 个时间戳，Wi-Fi 那遍 1057 字 48 个：平台的搜索结果逐次会变。判据因此断言「非空 + 有时间戳 + 平台集合一致」而不是字节相等，**按字节比会是一条随机红的判据**
- **release APK 仍然会以 dev-client 的 URL 启动**（`expo run:android --variant release` 的最后一行就是它），但面板自报 `dev: false`：判断跑的是哪份 bundle 只能信 `__DEV__`，不能信启动方式（N0b-3 同一条）

正式的 R1–R5 判据仍按计划在 **N1i** 用当轮 release 构建复跑；这次预跑的价值是：**core 的业务图在真机上能跑，这件事现在就知道了，而不是等到九批之后。**

**N1i 的 R4/R5 实测（2026-08-19，release bundle · Hermes · 冻结设备 vivo V2408A · 结果经 probe-host 回传）**——这是 N0b-3 那个 statement-shape proxy 第一次被**真函数**替掉：`runFullBackfillInTx` 与 `applyChangesInTx` 直接从 `@lark/core/portable` import，不是复刻。

| 判据 | 结果 | 数 |
|---|---|---|
| **R4** `runFullBackfillInTx`，2000 首欠着 | ✅ | **605.41ms**；`songs === 2000`（5 歌单 / 1000 membership）；**第二次跑回 0**——证明第一次不是空转 |
| **R5①** `SYNC_PULL_LIMIT_MOBILE` | ✅ | 200 |
| **R5③** `applyChangesInTx`，200/批 | ✅ | p50 83.52 / **p95 90.79ms**（预算 100ms）；**applied 2000、skipped 0、dead-lettered 0** |
| R5③ 500/批（参照，不判） | 记录 | p50 205.92 / p95 **226.05ms**；**applied 5000 of 5000、skipped 0**——延续 round 计数之后才干净（第一版跑在 200 已盖过戳的夹具上，只 applied 2400，一半是廉价拒绝） |

**R1–R3 复跑（同一轮 release 构建，2026-08-19）**——`R1 9/9`（**移动网络**；Wi-Fi 这轮未复跑，N1d 预跑时双网络都绿，按用户决定不再跑一遍）· `R2 8/8` · `R3` 绿。逐条：WBI `w_rid` = `ebe73d7a091cca142e72c9b4c3ff1c19` 与桌面**逐字节相同**且整条 query 相同 · buvid3/buvid4 经**安装的 Random 端口**成形 · search 20 条 · `view`/`pagelist`/`audioStream` 全过 · **`openAudio()` 流式读到 268,531B / 40 chunk，abort 之后再读抛 `AbortError`** · b23 短链一跳展开与桌面同 bvid · 歌词 qq 中选（1057 字 / 48 时间戳，候选平台集与桌面一致）。**N0b-4a 的节点差异第三次复现**：手机拿到 `xy220x202x9x147xy.mcdn.bilivideo.cn:8082`（mcdn），桌面同时刻拿到 `cn-bj-cc-03-01.bilivideo.com`——playurl 按调用方 IP 派节点这条，现在有三轮独立证据。

**R5② 的证据在桌面而不在手机**：`portable/coordinator/pull-limit.test.ts` 用捕获型 client 断言 `pullChanges(…, 200)` 真经 `engine.ts` 的 `options.pullLimit ?? SYNC_PULL_LIMIT` 缝传下去；把那句改成写死 `SYNC_PULL_LIMIT` 反测立刻红。

**R5 的四条实测**：

- **proxy 是乐观的，而这正是 R5 存在的理由**：N0b-3 的 statement-shape proxy 给 200/批报 72.98ms，**真 `applyChangesInTx` 是 90.79ms——慢 24%**；500/批 proxy 报 164ms(p50)，真函数 **p50 205.92 / p95 226.05ms**。**200 过了但余量只剩 ~10%**，且这是**空载下界**（空闲手机、2000 首库、没有渲染与播放竞争）。N5 真接同步时要在有竞争的条件下复测；超了就降到 100。**用户体验口径写明**：这段只在「离线很久回来追进度」时出现，表现为 10 次 ~90ms 的顿挫（中间隔着网络往返），滑列表看得见、不操作看不见；**音频走原生 media3，不受影响**；数据与协议完全不受影响
- **「快」本身是可疑信号，除非同时断言干了活**：第一次真机跑 R5③ 是 14ms/批的漂亮数字，而 `applied 0, skipped 2000`——payload 少了 `created_at_ms`，2000 条全被 dead-letter，dead-letter 也计进 skipped。抓住它的是「applied 数也算判据」那一条断言。**同一个形态第二次出现在参照行**：500 那轮跑在已被盖戳的夹具上，一半是廉价拒绝
- **fail-loud 的端口在真机上第一次证明了自己**：面板忘了 `installPortableRuntime()`，`runFullBackfillInTx` 一 mint uuid 就抛 `no RandomSource: this host has no crypto.randomUUID`。RN 没有 `getRandomValues`（N0b-3 量过），N1a 选的是**未装即抛**而不是静默兜底——所以这里得到的是一句准确的话，而不是 2000 个坏 uuid
- **release 面板的失败只写在屏幕最底下**：`console.log` 到不了 logcat，`uiautomator dump` 只列当前屏，所以「点了没反应」既可能是还在算、也可能是早就抛了。分辨方法是**量 app 的 CPU**（0.0% + 累计 16s = 没在干活；146% = 在干活），再慢速上滑到底读 `runner threw:` 那一行

**N1h 的三条实测**：

- **切面画对了的信号，是编译器把一整段代码报成「没人用」**：`fetchAudio` 连同 `StagedAudio`、`countingStream`、四个 `node:` import 与 `PipelineDeps.mediaTools`，在 AudioLanding 落地之后全部变成死代码——**engine 的最后一个 Node 方向 import（`MediaToolsProvider`）也跟着没了**，因为工具链现在属于落地实现而不是队列。搬迁那个 commit 的 diff 因此**只有删除、没有新增**：正文逐行比对下来，改动全是「不再需要的地方」
- **`saving` 只能由落地自己报，而这会挪动一条冻结不变量的机制**：engine 原本在 fetch 与 land 之间设这个阶段，而从一次 `land()` 之外已经看不见那个时刻了——提前设就把事件序倒成 saving → downloading → converting。但进入 `saving` 同时是**冻结目标歌单列表**的那一下（二轮评审 ⑫），所以 `commit` 现在**在自己跑的时候**读 `task.playlistIds`，而不是读一个提前捕获的数组。同一份列表、同一个时刻，且本来就该在冻结之后读
- **不为一个没人读的字段加一次网络往返**：`expect.expectedDurationSeconds` 要的是分 P 时长，而 `choosePage` 只回页码——填它得多打一次 `pagelist`，为的是一个桌面**故意忽略**的参照值（它探的是真到货的字节，因为一条自称 `mp4a.40.2` 却送别的东西的流会被拷成播不了的 canonical 文件），而 redownload 从存下来的 key 解析、根本没有分 P 可引。改成可空、传 `null`，§8 本来就把跨宿主签名留到 N4

**N1g 的四条实测**：

- **两个 hook 不一样敏感，而这件事只有把规则拆掉跑一遍才看得见**：LibraryContract 十八例第一次两边全绿。把 service 的 `requiredName` 里那句 `.trim()` 删掉重跑——**CLI hook 红两例，daemon hook 全绿**。因为 daemon 的 `optionalString` 自己先 trim 了，递给 service 的值已经满足了半条规则，那两例在 daemon 上测的其实是「wire 修过之后还有人拒绝」。补 `stringField`（只查类型、原样递进去）之后再破一次：**两边同样红两例**。**「绿」不是证据，「破了会红」才是**——这条 M5/T5 记过两次，这次是它在一个跨宿主契约上的形态
- **`CodedError` 有语义，不是「带 code 的错误」的意思**：`LibraryInputError` 第一版继承了它，`errors.test.ts` 当场红三条——那个基类的意思是「携带客户端会收到的那个 wire code」，而这个错误存在的全部理由恰恰是**库对前端该报什么码没有意见**。降成普通 `Error` 之后由两边各自翻译（daemon 按 field 归 `INVALID_BODY`/`INVALID_QUERY`，CLI 归 `USAGE_ERROR`）。**一个反射式的注册表测试挡下了一次建模错误**
- **消费服务层的信号是编译器报出一串死代码**：daemon 两个路由文件 + CLI direct 接上 service 之后，`tsc` 报的每一条都是 unused import / unused const——`listSongs`、`getPlaylistSongs`、`SEARCH_MAX`、`writableId`、`validId`、`requiredName`……**没有一条是「要改的地方」，全是「不再需要的地方」**。如果报的是类型不匹配，说明服务层的面画错了
- **契约夹具不许假设插入顺序**：「虚拟 all 是每首歌按创建顺序」第一版断言「先 seed 的排前面」，同毫秒创建的两行在 `created_at` 上打平、回落到 id（M5 记过）。改成**跟它被定义成的那个查询逐首比**（`listSongs({sort:'created_at',order:'asc'})`）——既 tie-safe，又正好是这条规则真正的内容

**N1f 的四条实测**：

- **判据 F5 读错了元素，而它的对错取决于一次后台推送赶不赶得上**（`accept-sync` 连红两次）：徽章按钮的 `innerText` 是「标签 + 注意力计数」拼起来的，而标签本身在有未推送变更时就是 `待同步 1`——于是「按钮文本还以 1 结尾吗」分不清「冲突还在」和「这次 resolve 自己 emit 的那条变更还没被 outbox 触发器推走」。两次红的那一刻 `count 0 · attention 0`，**解决冲突完全成功**；红的只是 800ms 静默 + 1s 轮询有没有落在它等的 1500ms 里。改成读注意力那个 `span`（按钮不在时返回 `null` 而不是 0，否则窗口没渲染出来也算通过）。与 T5 的「同一个词既当分区标题又当状态文案就会撞」同一个形状：**两个数字渲染进一个字符串，断言就只能猜是哪一个**
- **决策 h 没算到夹具**：五个 coordinator 测试全部跑在 daemon 的 `createTestContext` 上（一个带下载引擎、播放器、媒体工具链的完整 `AppContext`），而它搬不进 core。所以「单测跟代码走」的实际代价是**另造一个 `CoordinatorContext` 夹具**（`@lark/core/testing` 的 `createCoordinatorHarness`：真数据库 + 真文件系统 + 真凭证文件，只有 SDK 与时钟是假的）+ `fake-skybridge` 一起搬进 core testing。账本对得上：daemon 495 → **446**，core 1098 → **1147**，全仓 **2532 不变**。daemon 侧的覆盖没丢——`routes/sync.test.ts` 守着线，两套 e2e 守着真 server
- **skybridge SDK 在 Metro 里解得开**（决策 c 由此从纸上变成事实）：`@orpheus-aviary/skybridge-client` / `-proto` 静态进 `portable/coordinator/client.ts` 之后，portable 的 Metro 图 80 → **90 个模块**，bundle 1.5MB。这条只有 bundle smoke 答得了——rg 守卫的禁用清单里本来就没有它们
- **`api` 必须离开 SyncRuntime**（子计划 §1.3）：它原本是 `SyncRuntime` 的字段并**默认落到 `realSkybridgeApi`**，也就是说一个没人注入的 runtime 会自己去连真服务器。移到 `CoordinatorContext` 且必填之后，`ctx.sync.api` 变成 `ctx.api`，daemon 的 `BaseContext` 长出一个 `skybridge` 字段。**coordinator 因此可以在一个还不知道怎么联网的宿主上构造出来**

**N1e 的一条实测**：

- **文件名不是路径，所以它属于端口**：`sync/file-ops.ts` 要 `CANONICAL_AUDIO_FILE` 才能说「这首歌的音频在不在」，而 N1a 把这两个常量从 `library/lyrics.ts` 挪进了桌面的 `paths.ts`（那里有 `node:os`/`node:path`），留一行 re-export 顶着。搬到 portable 的那一刻这行 re-export 就没有源了——**挪错了一层，一个批次之后才显形**。`song.m4a` 在每个宿主上是同一个串，join 才是宿主的事：定义因此进 `portable/ports/paths.ts` 与 `PathsPort` 同住，`paths.ts` 反过来 re-export 保住桌面的读法。这是本批唯一不是 `git mv` 的改动，其余 52 个文件**导入块之外逐字节相同**（拿搬迁前的内容逐个比，不看 diff——N1d 同一条）

**2026-08-17 范围修订（用户决定）——「歌单导入导出」从「明确不做（v1）」移进 v1**（主计划 §4.5 + D12 已改，N0 子计划 §5 的 N4/N6 已加）：

- **N4**：歌单导出 → 系统分享面板（cache 目录 + `expo-sharing`，不碰 SAF，与分享 intent 接收侧同一片原生区域）
- **N6**：导入桌面导出的去 id 文件（`expo-document-picker`；**必须在 N4 之后**，否则导入进来的是一库点不响的行；成本在预览/提交 UI 不在文件 IO）
- D12 的「私有目录卸载即删」只约束**音频**导入：歌单 json 产出的是带 `source_key` 的行 + `downloaded` 文件，全部可重建
- 做 N6 那一节时**连带评估 §9 N0b-3 的「出口 B」**：整文件 sha256 在 10,000 首上限（约 2MB）要一来一回约 1.3s

**开工前要知道的**：

- **N0b 是平台 spike，不是业务图验证**：core 业务模块（bilibili client、link、歌词、backfill、apply、file-ops）要到 N1 端口化后才能被 Metro 解析（`wbi.ts:21` 直接 `node:crypto`、`backfill.ts:29` 直接 `node:fs/promises`）。spike 内**禁止复制 core 实现来假装验证 core**——凡探针需要 core 才能算出的输入（WBI 签名、带签流 URL、header 集），一律由桌面用真 core 产出成 fixture。真实业务图归 N1 出口的 **R1–R5**
- **前置条件三件**：一台 Android 真机（同时是测量协议的**冻结设备**，换设备 = 数值判据全部重测）· 本机 Android 构建链（JDK + SDK + adb，`expo run:android` 本地构建不依赖 EAS）· TLS（D15）与 N0 无耦合（spike 允许 LAN 明文 HTTP，产品线 https-only 不动，死线仍是 N4）
- 🚨 **N0b 起 Expo 进桌面 workspace**：每次 `pnpm install` 变动后必须复跑桌面 `just check` + `just test`（判据 13，常驻义务）
- **待用户拍板**：决策 g（keystore 加密凭证库选择），N0b-5 前定；其余 a–l 已按建议关闭
- **判据 19 已按用户决定修订**（2026-08-17）：后台 + 锁屏 **30min → 5min**、耳机拔出 → **蓝牙断连**（设备无耳机孔）。代价写在子计划 §3.2：5 分钟到不了 vivo 收后台的尺度，这条从此只证明「不是一开始就断」，耐久证据推给 N3 整晚 soak；有线拔出路径本设备不可测

## 后续
- [x] **跨仓文档跟进 0.3.0**（2026-08-17）：`aviary/docs/ROADMAP.md` 与 `DESIGN.md`、`.github/profile/README.md`
- [x] **Phase B 移动版子计划**（2026-08-17，`aa63eac`）：N0 详案 + 全期框架 → 上面的 Phase B 段
- [ ] 🔴 **TLS（D15）—— N5 的开工前置**（2026-08-20 从 N4 移出，主计划 §4.3 Stage-3 修订）：skybridge server 现为 `http://<公网IP>:8443`，移动端 v1 是 https-only。N5 开工前二选一：补完 TLS（域名 + DNS · 证书 + 自动续期告警与演练 · 反代 · 两端 `server_url` 迁移 · 真机连通），或单独决定移动端的明文口径。负责人 = 用户，AI 协助
- [ ] **歌词平台内部并发**（T6d 记录不改）：每平台 1+3 次串行往返，约 0.5–2 秒
- [x] **跨仓待办**：`aviary/docs/ROADMAP.md` 与 `DESIGN.md`、`.github/profile/README.md` 已跟进到 lark 0.2.0（2026-08-13；0.1.0 那轮在 2026-08-10）
- [ ] **跨仓文档跟进 Phase B**：`aviary/docs/ROADMAP.md` 与 `DESIGN.md` 里 lark 的一行状态还停在「0.3.0 已发」，没有 Android 版这条线（现已到 N4d：手机上能播、能粘链接下载、能接分享）——发下个版本时一并跟进即可，不必单独开一轮
- 归用户手动、尚未做的：**skill 的「agent 实际可调用」验收**（M6 起挂着，M7 也没做——需要真的让一个 agent 照 `lark skill export` 的说明书跑几条命令）

## 决策记录

- 2026-07-16（用户确认）：统一缓存模型 / mp3 + 打包 ffmpeg / 导入按需下载 / 仅 macOS arm64 / 端口 47100（`470xx` 归 owl、`471xx` 归 lark）
- 2026-07-16（计划内定）：SSE 替代 WS、JSON 导出、Go DB 迁移、不抽 daemon-kit
- 2026-07-16（一轮评审修订 R1–R17，详见主计划 §1）：file_origin 清理不变量（导入文件永不自动清理）、v0.1 不写 sync 事件 + v0.2 全量回填、all 虚拟化、owl 式迁移协议、lark-media:// 媒体鉴权、recognize 纯预览、稀疏 rank、provider key 身份、原子落盘、UUID 强校验 + openExternal 仅 http/https、SSE 在线判定 + 命令 ack、导入去重只认 key、单账户单资料库、PATCH /config、信封例外、LLM 降级路径、asar:false + ffmpeg 锁版本 + GPL 许可交付
- 2026-07-16（二轮评审修订 R18–R28，详见主计划 §1）：身份域拆分（实体 device_id 仅存 skybridge 注册 ID、本地身份在 local_metadata.device_uuid）、playlist_songs 补 lww_counter + created_at 同步不可变、DB 级排他迁移（.migrate.lock + EXCLUSIVE + backup API + swap 回滚）、token 模型对齐 owl + M0 媒体 spike、全写路径原子化（导入/删除/歌词）、schema CHECK + provider key 唯一索引、虚拟 all 只读语义、CLI 歧义报错、清理前联网探活 fail-closed + 不可回收上报、导入单事务/上限/版本校验、维持 ad-hoc 签名
- 2026-07-31（M0 实测定案）：Electron 锁 **43.2.0**（owl 的 34 已 EOL，取最新受支持大版本），全依赖精确锁版 + 提交 lockfile；transport 仅 GET 默认重试（M0-7）；renderer CSP 单一来源 = Vite 插件（`order: 'post'`，dev 额外放宽 `script-src 'unsafe-inline'`，因 React Fast Refresh preamble 是内联 script）；Electron ESM main 不得顶层 await `app.whenReady()`；**vite 用 `pnpm.overrides` 钉 7.3.6**——只锁直接依赖挡不住传递范围把 vite 抬到 8，而 electron-vite 5 peer 只到 7，失效方式是静默的（build 仍「成功」但 electron 被打进 main bundle）
- 2026-07-16（三轮评审修订 R29–R32，详见主计划 §1）：token 归 daemon 生成原子发布（main 只传路径、每次重读适应轮换）、source_key 改 `bvid:cid`（p 是位置非身份，规范化时解析 p→cid）、取消 --force（daemon 存活一律禁 direct 写，推翻二轮限权方案）、v0.2 必审清单补三项（同 key 跨设备合并 / HLC rebase / rank 归一化同步语义）；同步更新 CLAUDE.md / AGENTS.md / DESIGN.md 过期表述
- 2026-08-05（M3 实测定案）：bilibili fav/collection **匿名可用**（T3 gate GO，`fetch-list` 保住全部范围）；`nav` 匿名 code -101 但携 `wbi_img`（判定看字段）；`fav/resource/list` 短页 + `has_more` 才是分页真值；ffmpeg 输出到 `.tmp` 必须 `-f mp3`；酷狗三端点全支持 https（Go 的两处明文 http 无必要），`krcs` 必须带 hash + duration(ms)；`ffmpeg-static` / `@derhuerst/ffprobe-static` 定版 **5.3.0**（实测 arm64 / ffmpeg 6.0，两包 `.d.ts` 的 `export default` 与 CJS 实际导出不符，需在导入边界重标类型）；engine 按 800 行硬线拆四文件；bilibili client 全 daemon 一份（`ctx.bilibili`）
- 2026-08-10（M7 实测定案 + 发版）：**`ffmpeg-static` / `@derhuerst/ffprobe-static` 已移除**——其二进制 `--enable-nonfree`，不可再分发（**推翻 2026-08-05 那条定版 5.3.0 的记录**）；改为自建最小 LGPL profile（FFmpeg 8.1.2 + LAME 3.100，4.5MB），`vendor/ffmpeg.lock.json` 锁定、`just fetch-ffmpeg` 做门禁（configure 逐字节比对 + nonfree 拒绝 + 能力清单 + 真实闭环）；交付 `bundled | system` 两个一等模式，控制面是 just **位置参数**；媒体工具收敛成 `ctx.mediaTools` 单一真相（ready 判定 = 完整能力清单，非 `-version` 退出 0），`MEDIA_TOOLS_UNAVAILABLE` 覆盖导入与下载、`LOCAL_API_VERSION` 3→4；打包后进程定位全部出自同一个 `resolveAppBundle()`，`open` 的正常退出不算崩溃；LICENSE = MIT，NOTICE 聚合全部生产依赖（195 个）且带覆盖检查；**v0.1.0 于 2026-08-10 发布**（bundled dmg + `@orpheus-aviary/lark-cli`，tag `9581bbc`）
- 2026-08-07（M5 后续定案）：**lark 引入独立状态色 `--state-active`（琥珀），`--primary` 不动**——shadcn 中性色板里 `--primary` 与正文同色，`text-primary` 当激活态用一直是隐形的（正在播放 / 当前排序 / 播放模式三处）；行状态定为四通道（琥珀=播放中 · 左竖条=选中 · **蓝色图钉按钮**=已固定 · `[需要下载]`=无文件；行内按钮常驻不悬浮），竖条挂第一个 `<td>`（`<tr>` 的 border 会被 border-collapse 吃掉）；排序改两轴（下拉选字段 / 按钮切方向），补 `时长` 与 `创建时间`；多选选区是**有序 id 列表 + 锚点**，表头三态语义限「当前视图内」，批量删除/移除/固定 N 次串行、添加到歌单一次请求，部分失败如实汇报；右键在选区内一律按批量走（否则「选三首删一首」）
- 2026-08-06（M5 实测定案）：`[theme] mode` 进 config，冻结「外观进 config、视图态留 localStorage」；缓存删除临界区 = **file claim + 重读行 + 重新 stat + 复查排除集/流计数，与 unlink 之间零 await**（探活是 await，期间一切可变）；下载完成触发的清理必须 `setImmediate` 延后到 claim 释放之后，否则永远清不掉刚下载的歌；`ensure-file` 成功授予 **60s lease**，跨 drain 保护到 `/audio` 真正开流；导入两段式靠 **SHA-256** 咬合（`reuse[].index` 只在字节一致时有意义），`(provider,key)` 命中优先级高于任何 reuse 指令；dnd-kit **走 legacy**（新架构 `@dnd-kit/dom` 依赖 jsdom 缺失的三个浏览器 API，且以未捕获异常炸整个测试文件），整行拖拽必须自建 activator 排除 input/button，`useSortable` 默认 `role="button"` 会毁掉 `<tr>` 的表格语义
- 2026-08-03（M1 实测定案）：better-sqlite3 定版 **12.11.1**（`process.versions.modules`：Node 137 / Electron 148，双运行时真值探测复核）；迁移锁弃 O_EXCL + pid 改 **SQLite `BEGIN EXCLUSIVE` 常驻锁库**（内核 advisory lock，kill -9 自动释放，锁文件永不删——主计划 §3.3 step 1 已标注修订）；createDatabase 三条拒绝路径判定前零写入（`journal_mode=WAL` 后移，字节级断言）；loadConfig 对存量 0644 强制收紧 0600；migrate-go 源库排他 = 真实读 + **同值写升级**双步（纯读拿不到 EXCLUSIVE 也探不到 RESERVED 写事务）；47020 探活带 `httpProbe` 开关（机器全局端口，测试关闭）；scope 字典补 `repo` / `plan`（用户确认）
