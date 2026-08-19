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

**N1 进行中（2026-08-18 开工）**——子计划 `docs/plans/2026-08-18-phase-b-mobile-n1.md`（v4，决策 a–q 全关，九批 N1a–N1i）。**N1a–N1f 已完成**，桌面测试 **2481 → 2532**（N1a 之后总量不再变动，只在包之间转移：N1f 把 49 个 coordinator 用例从 daemon 搬进 core）；Metro 图 36 → 51 → 80 → **90 个 portable 模块**。**N1f 之后，一台手机能解析的 core 已经包含 sync 全图、library 全图与整个 SyncCoordinator**——`@lark/core/portable` 之外只剩桌面专有件（`db/` 的打开与锁、ffmpeg、落盘协议、file-op 执行器、config、logger、paths 根解析）、daemon 的定时器/SSE 壳，与尚未提取的服务层 / download 编排。

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
| N1g–N1i | 服务层与 CLI 薄壳 / download 编排与 AudioLanding / 守卫收编与 R1–R5 | 见子计划 §4 | ⏳ |
| N1–N6 | 端口化 / 数据层 / 播放 / 下载 / 同步 / 收尾（框架见子计划 §5） | 各自子计划 | ⏳ |

**R1–R3 真机预跑（2026-08-18，release 构建 · 冻结设备 vivo V2408A · 移动网络与 Wi-Fi 各一遍）**——N1d 刚把 client 层搬进 portable，趁热验「**core 自己的代码**在手机上跑出同样的答案」。跟判据 23 的区别是根本性的：那次是桌面做完 core 的活、设备复现，这次设备上跑的每一行都是 `@lark/core/portable` 的 import，桌面只出**输入**与**它自己算出的参照**（`make-network-fixtures.mjs` 的 `references`，同一份 core）。

- **R1 双网络各 9/9**：`signWbiParams` 在 Hermes 上对同一组 (keys, params, wts) 产出与桌面**逐字节相同**的 `w_rid`（`ebe73d7a…`，整条 query 也相同）· buvid3 经**安装的 Random 端口**成形（RN 没有 `getRandomValues`，不装就抛——这条正是端口存在的理由）· 设备侧现取 WBI key 现签的 search 拿到 20 条 · `view`/`pagelist`/`audioStream` 全过 · b23 一跳展开与桌面同 bvid · **`openAudio()` 流式读到 268KB/40 chunk（移动网络）与 270KB/42 chunk（Wi-Fi），abort 后再读抛 `AbortError`**
- **playurl 按调用方派节点这条，现在是用 core 自己的 client 量到的**：移动网络拿到 `xy118x212x136x211xy.mcdn.bilivideo.cn:8082`（mcdn P2P 节点），Wi-Fi 拿到 `cn-bj-cc-03-03.bilivideo.com`——与桌面同一个。N0b-4a 的结论复现，且这次链路里没有任何 spike 自己的实现
- **R2 8/8**：8 条真实分享文本逐字段与桌面相同，**包括拒绝**——`bilibili.com.evil.test` 两边都抛 `InvalidSourceError`（一个悄悄接受了它的手机端会是同一个守卫上的洞）。顺带把 N0b-4c 的发现钉成了对照：真 bilibili 分享文本（标题 + b23 短链）解析成 **keyword** 而不是链接
- **R3 双网络绿**：qq 中选，三个平台都出了候选，与桌面同一组。**但 LRC 内容不是稳定的**——移动网络那遍 1233 字 64 个时间戳，Wi-Fi 那遍 1057 字 48 个：平台的搜索结果逐次会变。判据因此断言「非空 + 有时间戳 + 平台集合一致」而不是字节相等，**按字节比会是一条随机红的判据**
- **release APK 仍然会以 dev-client 的 URL 启动**（`expo run:android --variant release` 的最后一行就是它），但面板自报 `dev: false`：判断跑的是哪份 bundle 只能信 `__DEV__`，不能信启动方式（N0b-3 同一条）

正式的 R1–R5 判据仍按计划在 **N1i** 用当轮 release 构建复跑；这次预跑的价值是：**core 的业务图在真机上能跑，这件事现在就知道了，而不是等到九批之后。**

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
- [ ] **歌词平台内部并发**（T6d 记录不改）：每平台 1+3 次串行往返，约 0.5–2 秒
- [x] **跨仓待办**：`aviary/docs/ROADMAP.md` 与 `DESIGN.md`、`.github/profile/README.md` 已跟进到 lark 0.2.0（2026-08-13；0.1.0 那轮在 2026-08-10）
- [ ] **跨仓文档跟进 Phase B 起步**：`aviary/docs/ROADMAP.md` 与 `DESIGN.md` 里 lark 的一行状态还停在「0.3.0 已发」，没有 N0b GO 与「下一步 N1」——发下个版本时一并跟进即可，不必单独开一轮
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
