# lark TS 重写进度跟踪

> 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（2026-07-16 定稿，同日三轮评审修订 R1–R32）

## v0.1 本地全功能

- [x] **M0 脚手架 + 媒体 spike**（2026-07-31）— pnpm workspace、tsconfig.base、Biome、justfile、五包骨架、信封 helper、`GET /status` 端到端、lark-media:// Electron spike（Range/206/seek/CSP/token 轮换）｜子计划：`docs/plans/2026-07-31-m0-scaffold-media-spike.md`
  - spike 结论：**六项判据全过（Electron 43.2.0），不启用签名 URL fallback，主计划 §2.4 维持**；判据 4 标准按实测修订（Chromium multibuffer 保留约 6 条 range 连接，改判「有上界且不随 seek 增长」），M4 移植清单见子计划 §6.3
  - 用户验收四项全过（2026-07-31）：`curl /status` · `just cli status` · GUI dev/build 两态显示在线且 console 无 CSP/CORS 报错 · spike 演示（播放出声 → 跳 90% 出成比例新 Range → **重启 server 换 token 后免刷新继续 seek，日志见 gen 45 `auth=ok`**）
- [x] **M1 core 数据层**（2026-08-03）— config/logger/paths（0600 原子写 + 存量 0644 收紧 + aviary 空串回退 + redact 白名单投影）、schema v1 全量 DDL + migration runner（同事务 stamp + destructive marker）+ M1-10 恢复状态机 + SQLite `BEGIN EXCLUSIVE` 迁移锁、device_uuid、songs/playlists CRUD（`…InTx` 两层 + 本地字段独立路径 + 稀疏 rank/同事务归一化 + reorder 锚点契约）、Go 迁移协议全实现（`just migrate-go`）、daemon logger 置换为 core pino/pino-roll（M0 遗留两条全清）｜子计划：`docs/plans/2026-07-31-m1-core-data-layer.md`（§7 实施记录含版本定案与副本演示结果）
  - 版本定案：better-sqlite3 12.11.1 / drizzle-orm 0.38.4 / pino 9.14.0 / pino-roll 2.2.0 / smol-toml 1.6.1 / @electron/rebuild 4.2.0；`process.versions.modules`：Node 24.13.0 = **137**、Electron 43.2.0 = **148**（双向真值探测复核；ABI recipes 已接线，`ensure-electron-abi` M4 才接线）
  - 副本演示（真实 nest 副本，2026-08-03）：对账 20 songs / 2 playlists / 4 memberships（源 20/3/24，all 丢弃）、幂等重跑 already-migrated、sqlite3 抽查全过（rank 严格递增 / imported / device_id NULL / `+08:00` 换算正确）；**真实库未迁**，时机由用户后定
  - 用户验收通过（2026-08-03）：① `just check` / `just test` 全绿 + ABI 双向自愈（Electron 148 ↔ Node 137）② 副本 `just migrate-go` 对账 20/2/4 → 幂等重跑 → sqlite3 抽查 ③ config 演示（0644→0600 收紧、api_format 兜底 `'openai'`、Public 投影无 api_key）④ daemon 起动 `logs/lark.log` 出结构化 pino 行、终端保留 listen 提示
- [ ] **M2 daemon 基础路由** — 扩展 M0 daemon 骨架（buildServer/信封/status/CORS 已落地）：PID 锁、Bearer 鉴权 + local-token、SSE（gui 注册 + active 单消费者 + player 命令 ack）、songs/playlists/audio(Range)/lyrics/player/config(PATCH)/events 路由｜**子计划已三轮评审定稿待实现**：`docs/plans/2026-08-04-m2-daemon-routes.md`（决策 M2-1–M2-17；任务 T1–T9，四批提交，每批 commit 信息先给用户过目）
  - `/audio` 三条硬义务（M0 spike 实测，见 M0 子计划 §6.2）：尊重 backpressure、按「单曲并存约 6 条 range 流」预算 fd、响应 `close`/`error` 一次性清理；**不要用「按块封顶 206」**（实测把媒体元素打进 `MEDIA_ERR_NETWORK`）
  - 评审要点速记（详见子计划头部三轮修订记录）：PID 严格校验 + `/status` 确权、PID 锁 teardown 最后释放、boot 生命周期状态机 first-wins、gui 单消费者 + 409 恢复协议、PATCH /config clone→save→swap + 失败重载对齐、errorHandler 三分类、守卫脚本输出非空判定（rg 退出码语义相反）、测试走 boot-child + port 0
- [ ] **M3 下载管线 + 链接路由** — LLM client、bilibili、URL 规范化（provider/key）、ffmpeg 封装、歌词三平台（含无 LLM 降级）、队列/进度/取消/原子落盘、resolveSongFile 链接优先 + source_* 回写、recognize-url（预览）/redownload/download 路由
- [ ] **M4 GUI 基座** — 扩展 M0 GUI 骨架（electron-vite 三段/CSP 已落地）：daemon spawn/确权、单实例、lark-media:// 协议代理（移植 spike 定稿）、Tailwind/shadcn、播放器/列表/歌单/搜索/歌词/快捷键/下载栏（对齐 Go 版）
  - 移植清单在子计划 §6.3（privileges / URL 校验 / net.fetch 透传头 / CSP / ESM main 不得顶层 await / 401 重试风暴 / daemon 重启后重建播放器）；移植后按 T5 六项矩阵完整回归，**Electron 升级大版本同样必须重跑**
- [ ] **M5 新特性 + 对应路由** — 链接右键菜单 + 编辑对话框、缓存上限 + LRU + 固定 + /cache 路由、导入导出 + 疑似重复 UI、拖拽 reorder（稀疏 rank）、按需下载、设置页
- [ ] **M6 CLI** — 扩展 M0 CLI 骨架（@lark/cli status 命令已落地）：双后端（--direct）、全命令、GUI 拉起、skill export
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
- 2026-08-03（M1 实测定案）：better-sqlite3 定版 **12.11.1**（`process.versions.modules`：Node 137 / Electron 148，双运行时真值探测复核）；迁移锁弃 O_EXCL + pid 改 **SQLite `BEGIN EXCLUSIVE` 常驻锁库**（内核 advisory lock，kill -9 自动释放，锁文件永不删——主计划 §3.3 step 1 已标注修订）；createDatabase 三条拒绝路径判定前零写入（`journal_mode=WAL` 后移，字节级断言）；loadConfig 对存量 0644 强制收紧 0600；migrate-go 源库排他 = 真实读 + **同值写升级**双步（纯读拿不到 EXCLUSIVE 也探不到 RESERVED 写事务）；47020 探活带 `httpProbe` 开关（机器全局端口，测试关闭）；scope 字典补 `repo` / `plan`（用户确认）
