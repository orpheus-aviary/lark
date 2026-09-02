# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。
## 当前阶段：**手机端一批进行中**（输入框 · 列表 · 下载页三段）

**计划**：`docs/plans/2026-09-02-mobile-input-list-downloads.md`（2026-09-02 定稿）。来源是用户报的四个现象，四批 + **集中一次真机会话**（计划 §6）；**不加任何新依赖**。

| 批 | 状态 |
|---|---|
| **P1 · 输入框** —— KAV 包设置页/添加页（edge-to-edge 之后 `adjustResize` 被停用）· `Prompt` 改非受控 + 一次性 `setSelection` | ✅ 代码已落地，`just check` / `just test` 绿。**待真机**（§6 第 1–4 条），临时的 `KeyboardProbe` 验完就删 |
| P2 · 列表 —— `getItemLayout` + 搜索节流 + 行 memo | 未开工 |
| P3 · 四个 tab 保持挂载 + `visible` 语义（四条 gate） | 未开工 |
| P4 · 下载页三段（对齐桌面） | 未开工 |

**2026-08-31 发布**：[Release v0.5.1](https://github.com/orpheus-aviary/lark/releases/tag/v0.5.1)（tag → `b152fb7`）+ [`@orpheus-aviary/lark-cli@0.5.1`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli) + [Release android-v0.2.1](https://github.com/orpheus-aviary/lark/releases/tag/android-v0.2.1)（同一个 commit）。这一站是什么、门禁与逐批记录 → **`docs/history/0.5.1-android-0.2.1-shipped.md`**。

| | |
|---|---|
| **线上是哪一版** | 桌面 `0.5.1` · CLI `0.5.1`（npm latest）· Android `0.2.1`（versionCode 4） |
| **协议 / schema** | `LOCAL_API_VERSION` **10** · **schema v3**（0.3.0 之后没再动过） |
| **测试 / 验收** | 3629 · 五套 **134/134**（gui 20 · cli 27 · m5 22 · sync 36 · pack 29） |
| **产物哈希** | dmg `4f4fd3ae…5c118ed5` · tgz `6fc34c34…98e7bd5e` · apk `ef4f9c58…b8d9b29c`。**发出去之后回读校验过**：从 Release 下回来的两份与本地产物逐字节同哈希 |

### 下一步

**下一批是 P2**（见上表）。四批走完再集中一次真机会话。这一批之后的候选，按现在看得见的顺序：

1. **两端对齐剩下的四条** —— 发版前那次普查查出来、当时明确不做的：`[重复]` 标记搬到手机（**C14**）· 手机歌曲页多选加「下载」（**C15**）· 歌单详情那份重复的 row（**C16**，C11/C12 的第三次代价）· 桌面记「上次听到哪」（**D5**，`portable/last-playback.ts` 是两端共用层而桌面一行没接）。前三条都小。
2. **D2「长期使用复盘」** —— 0.1.1、0.5.0、0.5.1 都是这么来的：用一阵子，把别扭的地方列回来，再分批。
3. **分P 能不能选「存到」** —— 用户 2026-08-31 问过，当场决定**先这样**。真要做是一次产品决定（「组 = 一个歌单」这条要不要撤），不是一个补丁。**没有人再提之前，它不是待办。**

入口：**待办与已决定不做的** → `docs/plans/2026-08-26-backlog-before-android-v1.md`（A 发版门 / B 延后 / C 技术债 / D 首发之后 / **E 防止重复捡起**）。

## 历史归档

已走完的阶段的逐批实施记录——经过、判据结果、当时的判断与决策：

| 阶段 | 位置 |
|---|---|
| **v0.1.0 本地全功能**（M0–M7，2026-08-10 发布） | `docs/history/v0.1.0-shipped.md` |
| **v0.2.0 skybridge 同步**（T0–T6，2026-08-13 发布）+ v0.2.1 | `docs/history/v0.2.0-shipped.md` |
| **v0.3.0 m4a 统一 + 一次性迁移**（Phase A，2026-08-17 发布） | `docs/history/v0.3.0-shipped.md` |
| **Phase B Android**（N0 平台 spike → N7 每账号工作区） | `docs/history/phase-b-shipped.md` |
| **0.4.0 + Android 0.1.0 发版**（2026-08-26，含文档大整理与 N7 收口） | `docs/history/0.4.0-android-0.1.0-shipped.md` |
| **0.4.1 / 0.4.2 + Android 0.1.1**（2026-08-27，第一份「长期使用复盘」） | `docs/history/0.4.x-android-0.1.1-shipped.md` |
| **0.5.0 + Android 0.2.0**（2026-08-28，第二份复盘 + 桌面歌词） | `docs/history/0.5.0-android-0.2.0-shipped.md` |
| **0.5.1 + Android 0.2.1**（2026-08-31，程序坞热修 + 多 P 选集 + 两端对齐普查） | `docs/history/0.5.1-android-0.2.1-shipped.md` |
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
