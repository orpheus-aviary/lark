# lark 开发规范

## 项目概述

lark 是百灵音乐播放器的 TypeScript 重写版（桌面 macOS + Android）。可参考 `../lark-go/` 作为功能映射基线，但不复制架构。技术栈与 owl 对齐。

## 技术栈

- **语言**：TypeScript (ESM)
- **桌面**：Electron + electron-vite ／ **daemon**：Fastify + better-sqlite3 + drizzle-orm
- **前端**：React + shadcn/ui + Tailwind v4 + zustand
- **移动**：Expo SDK 57 + CNG（Android only）；UI 是 RN 原生控件 + `lucide-react-native`，**没有 zustand、没有 router、没有手势栈**
- **CLI**：commander ／ **包管理**：pnpm ／ **Lint**：Biome ／ **测试**：vitest

## 仓库结构

```
packages/shared/   # @lark/shared — Node-free 线协议 + 两端共用的纯判定
packages/core/     # @lark/core — 业务逻辑（桌面专有的那半）
  └── src/portable/  # @lark/core/portable — 一台手机能解析的整个业务图（移动端只链这一块）
packages/daemon/   # @lark/daemon — Fastify server + `lark daemon`
packages/gui/      # @lark/gui — Electron main/preload/renderer
apps/cli/          # @lark/cli — 对外 CLI（发布为 @orpheus-aviary/lark-cli）
apps/mobile/       # @lark/mobile — Android（boot / ports / player / downloads / sync / ui / modules）
spikes/            # 已答问题的验证工程 + 真机驱动设施
scripts/           # 验收套件、依赖方向守卫、设备驱动
```

**依赖方向**：`shared ← core ← daemon ← gui`；`cli → shared + core`；`mobile → portable + shared + skybridge SDK`。
**十条守卫进 `just check`**（分层 · portable 零宿主 · 移动端 import · Metro bundle smoke · 原生模块接线 · 工作区收口 · 日志卫生），逐条见 `docs/INVARIANTS.md` §2。

## 开发命令

```bash
just check          # lint + typecheck + 十条守卫 + bundle smoke
just test           # 全部测试
just dev-daemon     # 起 dev daemon
just cli <args>     # = 对外的 lark
just backup-nest <目录>          # 复制曲库（开发期一律用副本）
just mobile-android-release     # 构建 release APK 并 adb 装到冻结设备
tokei               # 业务代码行数（口径见 .tokeignore）
```

验收套件（发版门禁）：`accept-gui` 15 · `accept-cli` 27 · `accept-m5` 22 · `accept-sync` 36 · `accept-pack` 28。

## 注意事项

- 🚨 **动曲库前先读 `docs/INVARIANTS.md` §1。** 一句话版本：**开发版碰到旧库就会单向升级**（v2 → v3 还会当场把 mp3 转成 m4a，旧版本从此拒绝打开），所以**开发期一律 `just backup-nest` 的副本 + `LARK_NEST_DIR`**；**验收夹具自造，不借用户的库**。
- **daemon 是统一入口**（默认端口 **47100**，`471xx` 归 lark）；daemon 存活时 CLI 一律禁止 `--direct` 写。
- **数据目录** `~/orpheus-aviary-nest/lark/`；**统一响应** `{"success", "data", "message"}`（例外只有 `/audio` / `/lyrics` / `/events`）。
- **canonical 音频** = `songs/<id>/song.m4a`；**schema v3**；协议 `LOCAL_API_VERSION = 7`（**以 `packages/shared/src/api-paths.ts` 为准**）。
- **同步身份两域不混用**：实体 `device_id` 只存 skybridge 注册 ID，本地身份在 `local_metadata.device_uuid`；凭证在独立文件 `skybridge.toml`（0600，不进 `/config`，backup 每层排除）。
- **歌曲本体不同步**；**缓存清理只动 `downloaded` 且探活确认可重下的文件**，imported 是用户资产、永不自动清理。
- **每账号独立工作区**：`local` 原地不动，账号库在 `libraries/<32hex>/`。**切换只写一行、要重启才生效**——`serving` ≠ `active`。
- **移动端启动序列是冻结的，每进程只跑一次**（`bootOnce`）；**文件写一律原子替换**；五个自建原生模块的接线有守卫。
- **文件超过 500 行建议拆分，800+ 行强制拆分。**

**其余仍然生效的约束（分层守卫、同步、工作区、移动端产品形状、测试口径）全部在 `docs/INVARIANTS.md`——改对应模块前读它。**

## 测试规范

- **默认落单测。** 只有设备才能回答的才上机：原生模块 · Android 策略 · 真网络 · 真机数值。**反测也落单测。**
- **不要过度设计测试。** 一条判据要能说出「它怎么变红」；说不出就别加。**绿不是证据，破了会红才是。** 不写预测性探针，不为「以后可能有用」铺测试基建。
- **上机测试尽可能由用户操作，且集中安排**：一个里程碑最多一次真机会话，AI 只负责 `just mobile-android-release` 装包 + **把「看什么」按顺序讲清楚**。AI 自己驱动手机只在两种情况——需要抓内容（logcat / dumpsys / 截屏比对），或判据要求一段精确流程；且开跑前说一声、跑完说一声。
- **判据别把环境当契约**；**「快」是可疑信号**除非同时断言干了活；**判据验过 ≠ 用户点得到**（只在验收构建里有入口的能力，验收永远绿）。
- 提交前跑 `just check` + `just test`；优先跑受影响的单个包。

## 工作方式

- **每个里程碑先出子计划**（`docs/plans/<日期>-<里程碑>.md`）经用户过目再动手；实现按批推进，**每批提交前把 commit 信息给用户看**。
- **一批做完 → 记进 `PROCESS.md`**；发现仍然约束新代码的规则 → 进 `docs/INVARIANTS.md`；踩到坑 → 进 `docs/LESSONS.md`；决定先不做 → 进 backlog 的 E 节。
- **已定的「不做」不是待办**，别在下一轮又捡起来问。

## Commit 规范

遵循上级 `orpheus-aviary/.claude/CLAUDE.md` 的 Conventional Commits。

Scope：`shared` / `core` / `daemon` / `gui` / `cli` / `mobile` / `player` / `download` / `lyrics` / `search` / `library` / `settings` / `cache` / `link` / `skybridge` / `db` / `config` / `repo` / `plan`

## 当前进度

**桌面 v0.3.0 已发布**（2026-08-17，tag `9cf9d97`）；**Android Phase B N0–N7 全部完成、尚未发版**。测试 3308，`just check` 绿，桌面 accept 五套 128/128（2026-08-26）。

**当前状态 + 下一步以 `PROCESS.md` 为准。** 其余入口：

| | |
|---|---|
| **改代码前必读的约束** | **`docs/INVARIANTS.md`** |
| 实测踩坑（按时间分段） | `docs/LESSONS.md` |
| **发版前要做什么、之后规划做什么** | **`docs/plans/2026-08-26-backlog-before-android-v1.md`** |
| 历史（v0.1 / v0.2 / v0.3 / Phase B / 决策流水） | `docs/history/`，索引在 `PROCESS.md` |
| 各批判据与评审 | `docs/plans/`，路由在 `docs/plans/README.md` |
| 本仓设计 ／ 跨仓 | `docs/DESIGN.md` ／ `../aviary/docs/{DESIGN,ROADMAP,SKYBRIDGE_ARCH}.md` |
| Go 版（功能参照） | `../lark-go/` |
