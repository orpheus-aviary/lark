# lark

百灵音乐播放器的 TypeScript 重写版。原 Wails + Go 版归档为 `../lark-go/`。

## 定位

音乐桌面工具，隶属 orpheus-aviary。核心能力参考 lark-go 现有实现（播放 / 下载 / 歌词 / 搜索 / daemon 模式），新增歌曲链接体系、统一缓存模型、歌单导入导出等。技术栈对齐 owl，v0.2 起接入 skybridge 做多设备同步（歌单、歌曲元数据含来源链接；不同步歌曲文件与播放记录）。

## 状态

🚀 **开发中**（2026-07-16 启动）。M0 脚手架 + 媒体 spike、M1 core 数据层、M2 daemon 基础路由、M3 下载管线、M4 GUI 基座、**M5 新特性**（设置页 + 主题 / 缓存 LRU 与固定 / 按需下载 / 链接编辑 / 歌单导入导出 / 拖拽排序）及其后续（状态色与行状态、两轴排序、多选与批量操作）均已完成，验收 `just accept-gui` 15/15 + `just accept-m5` 22/22。**M6 CLI 已完成**（2026-08-08）：跨进程 writer lock、身份五态（`/status` 公开指纹）、`--direct` 双后端、全部命令组（songs / playlist / download / play / lyrics / cache / daemon 生命周期 / skill export），验收 `just accept-cli` 27/27。整体计划见 `docs/plans/2026-07-16-ts-rewrite-master-plan.md`，进度见 `PROCESS.md`。

详见 `docs/DESIGN.md` 与 `../aviary/docs/ROADMAP.md`。

## 开发

前置：Node ≥ 22.12（本仓锁 `.node-version` = 24.13.0）、pnpm ≥ 10、`just`、`rg`。下载用的 ffmpeg/ffprobe
由 `ffmpeg-static` / `@derhuerst/ffprobe-static` 随 `pnpm install` 带下来，不需要系统装；
系统 `ffmpeg` 只有完整 spike 校验层用得到。

```bash
pnpm install

just dev-daemon      # 前台起 daemon（127.0.0.1:47100）
just stop-daemon     # 停 daemon（先经 /status 确权，再等它真的退出）
curl http://127.0.0.1:47100/status

just cli status      # daemon 在不在、是不是本数据目录的（--json 输出信封）
just dev             # 起 GUI（自己拉起并确权 daemon；已有本 nest daemon 则复用不认领）
just gui-preview     # 用 build 产物起 GUI —— 验证生产 CSP 的唯一方式

just backup-nest [目标目录]   # 安全复制整个 nest（见下「nest 复制」）
just accept-gui [--keep]     # 六项判据 + 会话矩阵：真 GUI × 真 daemon × nest 副本
just accept-m5 [--keep]      # M5 判据：缓存清理 / 按需下载 / 歌单导入导出（真实 bilibili）
just accept-cli [--keep]     # M6 判据：真 daemon × nest 副本，驱动真实 `lark` 二进制

just check           # lint + tsc -b + 依赖方向守卫 + 日志卫生守卫 + spike fast 层
just test            # 全部 vitest

just probe-bilibili  # 打真实 bilibili，断言下载链路依赖的响应形状（不在 CI 里）
just migrate-go      # 一次性 Go songs.db 迁移（交互 y/N；先备份，迁移后 Go 版无法再打开库）
```

daemon 除 `GET /status` 外全部要 Bearer token；token 由 daemon 每次启动轮换并原子写到
`~/orpheus-aviary-nest/lark/daemon-token`（0600），客户端每次现读（不缓存）：

```bash
TOKEN=$(cat ~/orpheus-aviary-nest/lark/daemon-token)
curl -H "Authorization: Bearer $TOKEN" 127.0.0.1:47100/api/capabilities   # 自描述端点清单
curl -N -H "Authorization: Bearer $TOKEN" 127.0.0.1:47100/events          # SSE 事件流

# GUI 通道模拟器（M4 renderer 的参照实现）：注册 → 订阅 → 收命令即 ack；
# daemon 重启后旧 gui_id 会收到 409，脚本自动重新注册。
node scripts/demo-gui-sim.mjs
curl -X POST -H "Authorization: Bearer $TOKEN" 127.0.0.1:47100/player/pause
```

下载（M3）。一条链接就够，**不配 LLM 也能用**——单 P 或带 `?p=` 的链接、凭已存
`source_key` 重下，全程不碰模型；只有关键词搜索、多 P 且没写 `?p=`、以及来源失效后
重新识别才需要 LLM（在 `lark_config.toml` 的 `[llm]` 或 `aviary_config.toml` 里配）：

```bash
TOKEN=$(cat ~/orpheus-aviary-nest/lark/daemon-token)
api() { curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

# 单条下载：返回 task_id，进度看 SSE 的 download:status，详情 refetch /download/tasks
api -X POST 127.0.0.1:47100/download/song \
    -d '{"input":"https://www.bilibili.com/video/BV1Ki4y1y7HC"}'

api 127.0.0.1:47100/download/tasks              # {tasks, batches} 快照
api -X POST 127.0.0.1:47100/download/cancel -d '{"task_id":"…"}'

# 收藏夹/合集：先展开成视频列表，再整批入队（可同时新建歌单）
api -X POST 127.0.0.1:47100/download/fetch-list -d '{"type":"favorites","media_id":"96661672"}'
api -X POST 127.0.0.1:47100/download/batch \
    -d '{"groups":[{"target":{"kind":"new","name":"收藏夹导入"},
                    "items":[{"kind":"video","bvid":"BV1Ki4y1y7HC","page":null,"title":"稻香"}]}]}'

# 本地 mp3 导入（file_origin=imported，永不参与缓存清理）
api -X POST 127.0.0.1:47100/songs/import -d '{"file_paths":["/abs/path/song.mp3"]}'
```

下载成功后会自动派生一个歌词任务（三平台并行 + 选优，没配 LLM 走确定性相似度降级）；
也可以手动重来：`POST /download/lyrics/:id`。

Go 版曲库迁移：**本机的真实曲库已于 2026-08-05 迁移**（20 首 / 2 个歌单 / 4 条成员关系），
备份留在 `~/orpheus-aviary-nest/lark/songs.db.bak-go-<时间戳>`——把它拷回 `songs.db` 就能让
Go 版重新打开。`just migrate-go` 尊重 `LARK_NEST_DIR`，所以演练一律在**副本**上做（复制
真实 nest 到临时目录再跑）；它是幂等的，对已迁移的库只会报 `already-migrated`。迁移前请先
退出 Go 版 lark 和 daemon。

### CLI（M6 进行中）

`just cli <args>` 跑的就是对外的 `lark`（全局 bin 要等 M7）。已经能用的：

```bash
just cli status                          # daemon 在不在、是不是本目录的
just cli songs list --search 周杰伦       # 也有 search / get / edit / delete / pin / unpin
just cli playlist songs 收藏              # list / create / rename / delete / add / remove / reorder
just cli playlist export 收藏 -o ~/backup # 目录目标会补 <歌单名>.lark-playlist.json
just cli playlist import ~/x.json --yes  # 两段式：先预览再带 digest 提交
just cli cache status                    # status / evict
```

三条全局规矩：

- **`<name|id>`**：歌曲和歌单都能用名字指；重名不替你挑，报 `AMBIGUOUS_*` 并列出候选。
- **`--direct`**：不经 daemon，直接开本地库。读在任何情况下都安全（只读打开、不取锁）；
  **写在 daemon 存活时一律被拒**（R31），没有 daemon 时也必须显式写出这个 flag——不会静默降级。
- **`--json` / `--yes`**：`--json` 下「exit 0 ⇔ stdout 恰好一条成功信封」，失败则 stdout 空、
  stderr 一条错误信封；破坏性命令在 `--json` 或非 TTY 下必须显式 `--yes`。退出码分七档：
  1 操作失败 · 2 用法错 · 3 环境（token / 权限 / 没有库 / ABI）· 4 没有 daemon ·
  5 有东西占着且拒绝（另一实例 / 另一个 nest / 需要迁移）· 130 中断。

媒体协议 spike（M4 移植来源）：`just spike-media-server` / `just spike-media-app` 双终端手动跑，
`just spike-media-check` 跑完整校验层。结论见 `docs/plans/2026-07-31-m0-scaffold-media-spike.md` §6；
正式实现见 `packages/gui/src/main/media-protocol.ts`，六项判据的回归跑 `just accept-gui`。

### nest 复制（通用契约）

任何时候要复制或恢复 `~/orpheus-aviary-nest/`（演练迁移、做验收副本、备份），规矩是同一套：

- **运行态文件一律不复制**：`daemon-token`、`daemon.pid`、`logs/`、两个锁库
  （`songs.db.migrate.lock` / `songs.db.writer.lock`，连同它们持锁时的 `-journal` 边车）
  ——它们属于产生它们的那个进程，复制过去只会让新实例读到别人的身份。`lark-skill.md`
  与它的临时文件同理不复制（随时可重新导出）。
- **DB 一致性**：`songs.db` 是 WAL 模式。复制前必须确认 daemon 与 GUI 都已退出、且没有
  `songs.db-wal` / `songs.db-shm` 残留；确认不了就别直接拷，走快照。
- **快照入口**：`just backup-nest [目标目录]`。它会拒绝在 daemon 存活时运行（在线备份只冻结
  数据库，冻结不了 `songs/` 与配置），备份期间用 `locking_mode=EXCLUSIVE` 持有源库，目标目录
  必须由它本次创建（拒绝已存在的目录、nest 自身及其祖先/后代、以及指回 nest 的 symlink），
  失败时只清理自己建的那个目录。默认落在 0700 的临时目录里——副本含 `lark_config.toml`，
  里面有 LLM api key。

```fish
just backup-nest                       # → /var/folders/.../lark-nest-XXXX（打印路径）
set -x LARK_NEST_DIR /var/folders/.../lark-nest-XXXX
just dev-daemon                        # 副本上起 daemon，真实曲库不受影响
```

## 技术栈（预定）

- **桌面**：Electron + electron-vite
- **后端**：Fastify + better-sqlite3 + drizzle-orm（daemon 模式，独立于 GUI 生命周期）
- **前端**：React + TypeScript + shadcn/ui + Tailwind CSS v4 + zustand
- **CLI**：commander
- **包管理**：pnpm / Lint：Biome / 测试：vitest
- **同步**：skybridge client 库（见 `../skybridge/`）

## 文档

- 本仓设计：`docs/DESIGN.md`
- 历史参考：`../lark-go/README.md`（Go 版功能清单）
- 跨仓路线：`../aviary/docs/ROADMAP.md`
- skybridge 架构：`../aviary/docs/SKYBRIDGE_ARCH.md`

## License

TBD（与 aviary 保持一致）。
