# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。

## 当前阶段：**🎉 桌面 0.4.0 + Android 0.1.0 已发布（2026-08-26）**

| | |
|---|---|
| **桌面** | **v0.4.0 已发布**（2026-08-26，tag `v0.4.0`）—— `Lark-0.4.0-arm64.dmg` + [`@orpheus-aviary/lark-cli@0.4.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。协议 `LOCAL_API_VERSION` 6 → 7，**曲库不迁移**（schema 仍 v3）。 |
| **移动** | **Android 0.1.0 已发布**（2026-08-26，tag `android-v0.1.0`）—— `lark-0.1.0.apk`，versionCode 1，minSdk 26。只在 GitHub Release 发，不进商店，无自动更新。 |
| **测试** | **3317**（`just test`）。`just check` 绿。发版前五套 accept **128/128**，对的就是发出去的那份产物。 |
| **业务代码** | 491 文件 / 49,026 行（`tokei`，口径见 `.tokeignore`）。 |
| **设备** | 冻结设备 vivo V2408A / Android 15。数值判据一律 release 构建。 |

**下一站：跨仓文档跟进（backlog A2）→ 长期使用复盘。** 待办与已决定不做的 → `docs/plans/2026-08-26-backlog-before-android-v1.md`。

⚠️ **手机当前状态**：处于**登出**，且 **LLM API Key 随卸载丢失**——从 Release 装上之后要手动补一次（backlog A5）。

### 本阶段记录

- **发版（2026-08-26）** —— 桌面 **0.4.0** + Android **0.1.0**，两条版本线各自打 tag（`v0.4.0` / `android-v0.1.0`）。
  发版前对**这一份代码和产物**复跑五套 accept：`accept-gui` 15 · `accept-m5` 22 · `accept-cli` 27 · `accept-sync` 36 · `accept-pack` 28 = **128/128**；dmg 与 tgz 的 sha256 与 accept-pack 报的逐字节一致，npm registry 回读的 shasum 与本地 tarball 一致。
  🔴 **门禁抓到一条**：`DAEMON_VERSION` 在其余八处都到 0.4.0 之后还停在 0.3.0——只改源码不够，**dmg 里编译进去的是旧值**，所以重打了包再跑。`accept-pack` §9 读源码比字面量，正是为这个。
  **顺带补了 `just mobile-android-apk`**：`expo run:android` 没有设备就拒绝构建（它是 run 命令，只是顺带构建），而**发版不该依赖手机插没插在这台电脑上**。

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
