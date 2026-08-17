# lark

百灵音乐（TypeScript 版）—— `orpheus-aviary` 项目下的桌面音乐工具：播放、从 bilibili 下载、
自动配歌词、歌单管理。Electron + Fastify + React，附一个给人和 agent 用的 CLI。
原 Wails + Go 版归档为 `../lark-go/`。

## 状态

当前版本 **0.3.0**（2026-08-17；首发 0.1.0 在 2026-08-10，0.2.0 在 2026-08-12）。
- 仅 macOS Apple Silicon（arm64）
- GUI 为 ad-hoc 签名（未 notarize），首次运行需绕过 Gatekeeper
- 无自动更新

v0.1 是本地全功能版：曲库 / 播放器 / 下载管线 / 歌词 / 缓存模型 / 歌单导入导出 / CLI。
v0.2 接入 **skybridge 多设备同步**：歌曲与歌单的元数据、歌词跨设备同步（音频本体不同步，
各设备凭来源按需下载），冲突由你来判。
v0.3 把曲库统一成 **m4a（AAC）**：下载 bilibili 的 AAC 不再转码而是原样重封装，导入收下
自带 ffmpeg 读得开的一切（m4a/mp4 · aac · mp3 · flac · wav · ogg/oga/opus，按文件内容判定而不是
扩展名）。另外三项：下载可选**清洗命名**（让 LLM 从视频标题里读出歌名与歌手）、下载有了
字节级进度与独立的任务面板。

> ⚠️ **0.3.0 会把曲库升到 schema v3，并把已有的 mp3 一次性转成 m4a，两者都不可逆**。
> 升级后 0.2.x 将拒绝打开 `~/orpheus-aviary-nest/lark/songs.db`；转换全程在窗口里可见、可中断续跑，
> 导入的（不可重新下载的）原始文件会移进 `~/orpheus-aviary-nest/lark/migration-backup/` 留给你处置，
> 而下载来的原件在产物验证通过后删除。**想留退路就先 `just backup-nest <目录>`（或整目录复制）。**
> 不登录同步也会升级：迁移发生在 daemon 启动时。

整体计划见 `docs/plans/2026-07-16-ts-rewrite-master-plan.md`，同步的设计与决策见
`docs/plans/2026-08-11-v0.2-skybridge-sync.md`，进度见 `PROCESS.md`。

## 下载安装（macOS arm64）

1. 前往 [Releases](https://github.com/orpheus-aviary/lark/releases) 下载最新 `Lark-<version>-arm64.dmg`
2. 双击 dmg，把 `Lark.app` 拖进 `/Applications`
3. Finder 里 **右键 `Lark.app` → 打开** → 弹窗再点「打开」（只需一次；macOS 会拦截 ad-hoc 签名应用）

安装包有两种，Release 页写明是哪一种：

| | 自带 ffmpeg | 你要做的 |
|---|---|---|
| `bundled`（0.1.0 / 0.2.0 / 0.3.0 发的都是这种） | 是（自建 LGPL 构建，见 License） | 无 |
| `system` | 否 | **下载前**先 `brew install ffmpeg`——没有它下载与导入都不可用 |

装完在「设置 → 媒体工具」能看到当前用的是哪一份 ffmpeg。

## CLI

给 agent / 人用的曲库与下载入口，也可以脱离 GUI 单独使用：

```bash
npm i -g @orpheus-aviary/lark-cli   # 提供 lark / lark-cli 两个命令，需 Node ≥ 24
```

```bash
lark status                 # daemon 在不在、是不是本数据目录的
lark songs list --search 周杰伦
lark download <链接或关键词>
lark play <歌名>             # 必要时自动拉起桌面端
lark sync status            # 同步：绑定、待推送、冲突、卡住的文件操作
lark skill export           # 导出给 agent 看的说明书
```

`--json` 下「exit 0 ⇔ stdout 恰好一条成功信封」，失败则 stdout 空、stderr 一条错误信封；
退出码七档（1 失败 · 2 用法 · 3 环境 · 4 没有 daemon · 5 被占用/拒绝 · 130 中断）。
`lark --help` 是完整列表。

## 数据目录

所有数据在 `~/orpheus-aviary-nest/lark/`：
- `songs.db` — 曲库 · `songs/<uuid>/{song.m4a, lyrics.lrc}` — 歌曲文件
- `lark_config.toml` — 本地偏好（含 LLM key，0600）· `logs/` — 日志（按大小轮转）

**复制 / 备份 nest 用 `just backup-nest`**：运行态文件（token、pid、日志、两个锁库）一律不复制，
数据库是 WAL 模式、必须停机后再拷。契约与理由见 `CLAUDE.md`。
卸载：删 `/Applications/Lark.app` + `~/orpheus-aviary-nest/lark/`。

## 开发

需 Node 24（`.node-version`）、pnpm ≥ 10、`just`、`rg`、macOS（dmg 打包）。

```bash
pnpm install
just fetch-ffmpeg    # 自建 vendor/ffmpeg（约 4 分钟，之后是 no-op）；不跑则回落系统 ffmpeg

just check           # lint + tsc -b + 依赖方向守卫 + 日志卫生守卫 + spike 快检
just test            # 全部 vitest
just dev             # 起 GUI（自己拉起并确权 daemon）
just dev-daemon      # 只起 daemon（127.0.0.1:47100）
just cli <args>      # 跑仓库里的 CLI，等价于装出来的 lark

just package bundled # 打 dmg（bundled|system 两种模式）→ packages/gui/release/<mode>/
just pack-cli        # 打 npm tarball
```

验收矩阵（都跑真实进程，不是 mock）：

```bash
just accept-gui      # 媒体协议六项判据：真 GUI × 真 daemon × nest 副本
just accept-m5       # 缓存清理 / 按需下载 / 歌单导入导出（打真实 bilibili）
just accept-cli      # 驱动真实 lark 二进制，双后端 + 身份五态
just test-sync-e2e   # 同步的两套 e2e：三设备元数据 + 跨进程文件效应
just accept-sync     # 真 skybridge server × 两台 daemon × 真 GUI
just accept-pack <mode> <dmg> <tgz>   # 对着要发布的产物本身跑
```

daemon 除 `GET /status` 外全部要 Bearer token，token 每次启动轮换、原子写到
`~/orpheus-aviary-nest/lark/daemon-token`（0600），客户端每次现读：

```bash
TOKEN=$(cat ~/orpheus-aviary-nest/lark/daemon-token)
curl -H "Authorization: Bearer $TOKEN" 127.0.0.1:47100/api/capabilities   # 自描述端点清单
```

结构与规范见 `CLAUDE.md`，设计见 `docs/DESIGN.md`，进度见 `PROCESS.md`。

## License

MIT，见 [LICENSE](LICENSE)。

`bundled` 安装包另带一份**自建的 FFmpeg**（LGPL 2.1+，无任何外部库，不含 GPL 或 nonfree 组件）：
版本、完整 configure、源码地址与校验和锁在 `vendor/ffmpeg.lock.json`，构建脚本
`scripts/vendor-ffmpeg.mjs` 一并公开，足以复现同一份二进制。应用内「设置 → 关于」可读到随包
分发的许可证与第三方软件声明全文。
