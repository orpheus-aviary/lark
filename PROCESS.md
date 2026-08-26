# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。

## 当前阶段：**Phase B 全部完成 → 文档整理 → Android 首次发版**

| | |
|---|---|
| **桌面** | **v0.3.0 已发布**（2026-08-17，tag `9cf9d97`）。之后被改了七轮，**全部过了 accept 全系列**（128/128，2026-08-26）——下次发版前若再动桌面，仍要复跑。 |
| **移动** | **N0–N7 全部完成**。一台 Android 手机现在是 workspace 里的一台设备：能播、能下载、能同步、能导入歌单、能按账号分曲库。**尚未发版。** |
| **测试** | **3308**（`just test`）。`just check` 绿。 |
| **业务代码** | 491 文件 / 49,026 行（`tokei`，口径见 `.tokeignore`）。 |
| **设备** | 冻结设备 vivo V2408A / Android 15。数值判据一律 release 构建。 |

**发版前要做什么、之后规划做什么 → `docs/plans/2026-08-26-backlog-before-android-v1.md`**（A 节是发版的门）。

⚠️ **手机当前状态**：处于**登出**，且 **LLM API Key 随卸载丢失**——要用户手动补（backlog A5）。

### 本阶段记录

- **文档大整理（2026-08-26，A1 的一半）** —— `PROCESS.md` 1145 行 → 归档成五份 + 本文件（52 行）；`CLAUDE.md` 40KB → 6.6KB，从逐批状态改成「常驻规范 + 全是指针的进度段」；新增 `docs/INVARIANTS.md`（**仍然生效的约束**，从 CLAUDE.md 的状态段里提炼）与 `docs/plans/2026-08-26-backlog-before-android-v1.md`（带字母编号的待办 + **E 节「防止重复捡起」**）；新增 `.tokeignore`（`tokei` 只数业务代码：830 文件 / 92k → **491 文件 / 49,026 行**）。**结构照 owl**（`docs/history/<阶段>-shipped.md` + PROCESS 里一张查找表 + backlog 用稳定字母 id）。CLAUDE.md 同时加了一条**测试规范**：不要过度设计测试，上机由用户操作且集中安排。**A1 剩下的一半是面向用户的 `README.md`。**
- **N7 每账号独立工作区完成（2026-08-26）** —— 判据 103–123 全关。判据 122 是桌面 accept 五套 **128/128**（顺带还清 N1 判据 22 欠了六轮的旧账），判据 123 是一次真机会话（八步里除「第二个账号新建空库」按用户决定不测外全过，**空库 / 要求重新登录 / converge 三种失败一次未现**）。逐批经过见 `docs/history/phase-b-shipped.md`。

## 历史归档

已走完的阶段的逐批实施记录——经过、判据结果、当时的判断与决策：

| 阶段 | 位置 |
|---|---|
| **v0.1.0 本地全功能**（M0–M7，2026-08-10 发布） | `docs/history/v0.1.0-shipped.md` |
| **v0.2.0 skybridge 同步**（T0–T6，2026-08-13 发布）+ v0.2.1 | `docs/history/v0.2.0-shipped.md` |
| **v0.3.0 m4a 统一 + 一次性迁移**（Phase A，2026-08-17 发布） | `docs/history/v0.3.0-shipped.md` |
| **Phase B Android**（N0 平台 spike → N7 每账号工作区） | `docs/history/phase-b-shipped.md` |
| **决策流水**（2026-07 至 2026-08，「当时为什么这么定」） | `docs/history/decisions.md` |
| 某一批的判据、决策、评审全文 | `docs/plans/<日期>-<里程碑>.md`（路由 `docs/plans/README.md`） |

## 关键参考

- **改代码前必读的约束** → `docs/INVARIANTS.md`
- **实测踩坑**（按时间分段） → `docs/LESSONS.md`
- **待办与已决定不做的** → `docs/plans/2026-08-26-backlog-before-android-v1.md`
- 本仓设计 → `docs/DESIGN.md`；跨仓 → `../aviary/docs/{DESIGN,ROADMAP,SKYBRIDGE_ARCH}.md`
- 常用命令 → `justfile`（`just --list`）

## 怎么往这里加东西

- **一批做完**：在「本阶段记录」追加一段——**经过 · 判据结果 · 当时的判断与决策**，写清「为什么」而不只是「做了什么」。
- **一个阶段做完**（发一次版，或一条大线收口）：整段移进 `docs/history/<阶段>-shipped.md`，在归档表加一行，本文件回到只剩「当前阶段」。**这是一次单独的提交**，照 owl 的 `docs: archive <阶段> + trim PROCESS/CLAUDE post-<版本>`。
- **发现一条仍然约束新代码的规则** → `docs/INVARIANTS.md`，别只留在批次记录里。
- **踩到一个坑** → `docs/LESSONS.md`。
- **决定先不做某件事** → backlog 的对应字母节；**已定的「不做」进 E 节，不是待办**。
