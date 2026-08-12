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
- [ ] **T6 双套 e2e + `accept-sync` + 发版 0.2.0** — e2e 两套（**19 例**：dual 15 / files 4，`just test-sync-e2e`）、`just accept-sync`（**34 条**）与真机 soak（自动 **18/18**）都已做完，**只剩 T6d 发版**（soak 的 N1–N5 要等时间，用户决定暂缓）
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
  - [ ] **T6d 发版 0.2.0**（下一个会话的主题）——按 M7 的链路来：`just fetch-ffmpeg` 门禁 → `just package bundled` + `just pack-cli` → `just accept-pack bundled <dmg> <tgz>`（28 条，**必须在工作区之外跑 CLI**）→ npm granular token 发 `@orpheus-aviary/lark-cli` → GitHub release + tag。M7 的坑全在 `docs/plans/2026-08-08-m7-packaging.md` §8 与 CLAUDE.md 的 M7 段
    - 发版前要决定的两件事：**版本号 0.2.0 的 breaking 提示**（schema v2 单向，装了 0.2 就回不去 0.1.0，release notes 要写明）· **soak 的 N1–N5 是否补跑**（断网 / 合盖 / refresh 轮换 / 24h，用户已表示暂缓）
    - 发版时要跟着改的文档：`README.md` 的状态段与安装表（现在还写着 0.1.0）· `docs/DESIGN.md` · 跨仓 `../aviary/docs/{ROADMAP,DESIGN}.md` 与 `.github/profile/README.md`（0.1.0 那次是这么跟的）

⚠️ **本机真实曲库已经是 v2**（2026-08-12 soak 时被 v0.2 GUI 开过一次；用户拍板不还原）——已发布的 0.1.0 从此拒绝打开它（`user_version > LATEST`），0.2.0 发版前只能用仓库产物。库已 `sync unbind --force` 清回未绑定态，21 首 / 4 歌单完好。开发期仍一律用 `just backup-nest <目录>` 的副本 + `LARK_NEST_DIR`，**起 GUI 后先验 `/api/instance` 的 `nest_dir` 再登录**。

## 后续
- [ ] **v0.3+ 移动版设计 doc**
- [x] **跨仓待办**：`aviary/docs/ROADMAP.md` 与 `DESIGN.md`、`.github/profile/README.md` 已于 2026-08-10 跟进到 lark 0.1.0
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
