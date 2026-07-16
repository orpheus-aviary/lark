# lark TS 重写进度跟踪

> 主计划：`docs/plans/2026-07-16-ts-rewrite-master-plan.md`（2026-07-16 定稿，同日三轮评审修订 R1–R32）

## v0.1 本地全功能

- [ ] **M0 脚手架 + 媒体 spike** — pnpm workspace、tsconfig.base、Biome、justfile、五包骨架、信封 helper、`GET /status` 端到端、lark-media:// Electron spike（Range/206/seek/CSP/token 轮换）
- [ ] **M1 core 数据层** — config/paths/logger、schema v1（CHECK/unique index）+ migration runner、device_uuid、songs/playlists CRUD（core 单一写入路径 + 本地字段独立更新）、Go 版 DB 迁移协议（§3.3，DB 级排他 + backup API + 原子交换，真实旧库 fixture 测试）
- [ ] **M2 daemon 基础路由** — buildServer、PID 锁、Bearer 鉴权、SSE（role=gui 在线判定 + player 命令 ack）、status/songs/playlists/audio(Range)/lyrics/player/config(PATCH)/events
- [ ] **M3 下载管线 + 链接路由** — LLM client、bilibili、URL 规范化（provider/key）、ffmpeg 封装、歌词三平台（含无 LLM 降级）、队列/进度/取消/原子落盘、resolveSongFile 链接优先 + source_* 回写、recognize-url（预览）/redownload/download 路由
- [ ] **M4 GUI 基座** — electron-vite、daemon spawn、lark-media:// 协议代理、播放器/列表/歌单/搜索/歌词/快捷键/下载栏（对齐 Go 版）
- [ ] **M5 新特性 + 对应路由** — 链接右键菜单 + 编辑对话框、缓存上限 + LRU + 固定 + /cache 路由、导入导出 + 疑似重复 UI、拖拽 reorder（稀疏 rank）、按需下载、设置页
- [ ] **M6 CLI** — 双后端、全命令、GUI 拉起、skill export
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
- 2026-07-16（三轮评审修订 R29–R32，详见主计划 §1）：token 归 daemon 生成原子发布（main 只传路径、每次重读适应轮换）、source_key 改 `bvid:cid`（p 是位置非身份，规范化时解析 p→cid）、取消 --force（daemon 存活一律禁 direct 写，推翻二轮限权方案）、v0.2 必审清单补三项（同 key 跨设备合并 / HLC rebase / rank 归一化同步语义）；同步更新 CLAUDE.md / AGENTS.md / DESIGN.md 过期表述
