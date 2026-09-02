# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。
## 当前阶段：**Android 0.2.2 待发版**（桌面不动）

**这一批做完了**：`docs/plans/2026-09-02-mobile-input-list-downloads.md`（含 §9 的三次上机记录）。来源是用户报的四个现象，做成四批 + 上机三次；**没有加任何新依赖**，**只动 `apps/mobile/`**——`packages/` 与 `apps/cli` 一行没碰，所以**协议仍 10、schema 仍 v3、桌面与 CLI 不发**。

| 做了什么 | |
|---|---|
| **输入法遮挡** | targetSdk 35+ 之后 edge-to-edge 强制生效、`adjustResize` 被停用，平台改成**只平移出焦点那一个 view**（输入框可用而它下面的按钮被盖住）。改成**在 app 根上垫 `根高 − screenY`**，一处；键盘弹起时迷你条与 tab 栏隐藏 |
| **sheet 不再是 `Modal`** | 第二个窗口是「顶过头」和「不自动弹键盘」的共同根因（平移量 JS 读不到 · `autoFocus` 撞 `FLAG_NOT_FOCUSABLE`）。改成 app 自己窗口里的浮层（`ui/overlay.tsx`），返回键归 `BACK.sheet` |
| **编辑变全选** | `selectTextOnFocus` 被 Fabric 的整包 props 重发反复重新武装 ⇒ 改命令式 `setSelection` + 非受控 |
| **列表** | `getItemLayout`（行高量一次、按字体缩放缓存）· 搜索节流 200ms（对齐桌面）· 行 memo |
| **四个 tab 保持挂载** | 「挂载」不再等于「在屏」：可见队列 / 返回键 / 派生值三条 gate 走 `visible`（`INVARIANTS` §7）。顺带修掉「设置页填一半按 BACK 草稿全没」 |
| **下载页三段** | 进行中 / 排队中 / 已结束，用词照桌面；空段照画 + 小字（**有意分叉**，进 backlog E）；两个按钮移到「下载」下面并置灰 |
| **新增** | 歌单页高亮**正在播放的那个歌单**（判据是队列自带的 source，从歌曲页起播不高亮任何歌单）· 歌曲页顶栏两行（✕ 清除 · 返回顶部 · 定位当前）· **C16 收掉**（歌单详情复用 `SongRow`，补回当前曲高亮/时长/固定标记） |

**门禁**：`just check` 绿（十五条守卫）· `just test` **3629** · 真机三次会话全部走完（清单与结果在计划 §6 / §9）。**桌面五套 accept 未跑，因为桌面一行没改。**

### 下一步

**发 Android 0.2.2**（`app.config.ts` 已 bump，versionCode 5）。桌面 `0.5.1` / CLI `0.5.1` 保持线上不动。

之后的候选，按现在看得见的顺序：

1. **两端对齐剩下的三条** —— `[重复]` 标记搬到手机（**C14**）· 手机歌曲页多选加「下载」（**C15**）· 桌面记「上次听到哪」（**D5**）。（**C16 已完成**。）
2. **D2「长期使用复盘」** —— 0.1.1、0.5.0、0.5.1 和这一批都是这么来的：用一阵子，把别扭的地方列回来，再分批。
3. **C17（下拉栏偶尔留一条空通知）** —— 只有代码层定位，没有真机取证。下次出现先 `dumpsys` 取证再决定修不修。

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
