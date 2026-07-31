# lark TS 重写进度跟踪

> 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（2026-07-16 定稿，同日三轮评审修订 R1–R32）

## v0.1 本地全功能

- [x] **M0 脚手架 + 媒体 spike**（2026-07-31）— pnpm workspace、tsconfig.base、Biome、justfile、五包骨架、信封 helper、`GET /status` 端到端、lark-media:// Electron spike（Range/206/seek/CSP/token 轮换）｜子计划：`docs/plans/2026-07-31-m0-scaffold-media-spike.md`
  - spike 结论：**六项判据全过（Electron 43.2.0），不启用签名 URL fallback，主计划 §2.4 维持**；判据 4 标准按实测修订（Chromium multibuffer 保留约 6 条 range 连接，改判「有上界且不随 seek 增长」），M4 移植清单见子计划 §6.3
  - 用户验收四项全过（2026-07-31）：`curl /status` · `just cli status` · GUI dev/build 两态显示在线且 console 无 CSP/CORS 报错 · spike 演示（播放出声 → 跳 90% 出成比例新 Range → **重启 server 换 token 后免刷新继续 seek，日志见 gen 45 `auth=ok`**）
- [ ] **M1 core 数据层**（下一个，**先出子计划**）— config/paths/logger、schema v1（CHECK/unique index）+ migration runner、device_uuid、songs/playlists CRUD（core 单一写入路径 + 本地字段独立更新）、Go 版 DB 迁移协议（§3.3，DB 级排他 + backup API + 原子交换，真实旧库 fixture 测试）
  - M0 遗留入口：`paths.ts` 已落地（`LARK_NEST_DIR` 覆盖 + 单测）；daemon 现用 console logger（`context.ts`），M1 换成 core 的 pino/pino-roll 时是 drop-in
  - 随 better-sqlite3 一起补 justfile 的 `ensure-node-abi` / `ensure-electron-abi`（占位注释已在 justfile，含 owl 的两条血泪教训），落地时**记录 host Node 与 Electron 两侧的 `process.versions.modules`**
- [ ] **M2 daemon 基础路由** — 扩展 M0 daemon 骨架（buildServer/信封/status/CORS 已落地）：PID 锁、Bearer 鉴权 + local-token、SSE（role=gui 在线判定 + player 命令 ack）、songs/playlists/audio(Range)/lyrics/player/config(PATCH)/events 路由
  - `/audio` 三条硬义务（M0 spike 实测，见子计划 §6.2）：尊重 backpressure、按「单曲并存约 6 条 range 流」预算 fd、响应 `close`/`error` 一次性清理；**不要用「按块封顶 206」**（实测把媒体元素打进 `MEDIA_ERR_NETWORK`）
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
