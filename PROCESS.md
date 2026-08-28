# lark 开发进度

> **这个文件只写「现在」。** 逐批的历史记录已经归档到 `docs/history/`，索引在下面。
> 对话以本文件为基准；旧的东西查得到就行，不必读进上下文。

## 当前阶段：**桌面 0.5.0 + Android 0.2.0（均已发布，2026-08-28）**

| | |
|---|---|
| **桌面** | **v0.5.0 已发布**（2026-08-28，tag `v0.5.0` → `9b359c0`）—— [`Lark-0.5.0-arm64.dmg`](https://github.com/orpheus-aviary/lark/releases/tag/v0.5.0) + [`@orpheus-aviary/lark-cli@0.5.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli)。**桌面歌词**（第二个 renderer 窗口）· 下载记录持久化 + 来源 · 输入法组字不再误提交 · 放弃的解析回到来处 · 清洗命名认识多个歌手。协议 `LOCAL_API_VERSION` 8 → **9**，**曲库不迁移**（schema 仍 v3）。 |
| **移动** | **Android 0.2.0 已发布**（2026-08-28，tag `android-v0.2.0` → 同一个 commit）—— `lark-0.2.0.apk`，versionCode 3，minSdk 26，**覆盖安装 0.1.1、曲库不动**（签名相同）。歌词中线跳转 + 最后一行能居中 · 加歌页草稿 · 下载来源 · 排序本地持久化 · 歌单显示「需要下载」。只在 GitHub Release 发，不进商店，无自动更新。 |
| **测试** | **3547**（`just test`）。`just check` 绿（**守卫十四条**——0.5.0 加了「渲染进程 Enter 先问输入法」和「桌面歌词窗禁拖拽区」）。五套 accept 对**发出去的那份产物** **129/129**（`accept-pack` 28 → 29：桌面歌词是第二个 renderer 入口，一个只打包了 `index.html` 的产物在源码上完全正常、装上去打开歌词窗是白窗）。 |
| **业务代码** | 524 文件 / 52,060 行（`tokei`，口径见 `.tokeignore`；0.4.2 是 508 / 50,193）。 |
| **设备** | 冻结设备 vivo V2408A / Android 15。数值判据一律 release 构建。 |

**产物绑定**：dmg sha256 `705f737e40a7ad65…0f1ba7c0`（148,331,234 字节，**验收前后一致，且从 Release 下载回来复校同哈希**）；tgz sha256 `119f8238036407158…b1c4435a`，**registry 回读的 `dist.shasum` = 本地 `npm pack` 的 `3a97be7b…`**；apk sha256 `cb08ea5003f6a7c1…8589bfdf`（88,596,236 字节，**下载回来 = 真机上验过的那一份**）。九步照 M7 §3.5 走完。

**这一版是第二份「长期使用复盘」的收成**：用户按实际使用列回来八条，其中两条是 bug（输入法组字时回车直接提交 · 手机歌词播到最后不再滚动），其余是产品形状。人工验收又长出三批修订（见下），其中判据 19 是**没有任何测试看得见**的那一类。分批、判据与逐条决策 → **`docs/plans/2026-08-28-desktop-0.5.0-android-0.2.0.md`**；人工清单与结果 → `docs/plans/2026-08-28-manual-check.md`。

### 上一站：Android 0.1.1 + 桌面 0.4.2（2026-08-27）

**P1–P8 全部完成，0.1.1 已发布（2026-08-27）。** 真机会话两轮：先是十条一次全过，加了 ⑬ 之后又对**要发出去的那份产物**复验 7（熄屏续播）与新增的 11–13（车机/耳机/通知栏切歌），也全过。清单在子计划 §7.2。
**这一版是 D2「长期使用复盘」的第一份收成**：用户用了一天，列回来十一条，其中**只有一条是 bug**（锁屏播完不续播），其余是产品形状。子计划与分批 → **`docs/plans/2026-08-26-android-0.1.1.md`**；更早的待办与已决定不做的 → `docs/plans/2026-08-26-backlog-before-android-v1.md`。

### 下一步

**没有在做的批次。** 下一版的入口：

- **待办与已决定不做的** → `docs/plans/2026-08-26-backlog-before-android-v1.md`（A 发版门 / B 延后 / C 技术债 / D 首发之后 / **E 防止重复捡起**）。C11 / C12（移动端两处选择态脚手架、三份 StyleSheet 与两份 row markup 的重复）在这一版又付了一次代价：歌单里少了「需要下载」正是两份 row 走散的结果。
- **D2「长期使用复盘」**：0.1.1 与 0.5.0 都是这么来的——用一阵子，列回来，再分批。

### 本阶段记录

- **桌面 0.5.0 + Android 0.2.0 发版（2026-08-28）** —— [Release v0.5.0](https://github.com/orpheus-aviary/lark/releases/tag/v0.5.0)（bundled）+ [`@orpheus-aviary/lark-cli@0.5.0`](https://www.npmjs.com/package/@orpheus-aviary/lark-cli) + [Release android-v0.2.0](https://github.com/orpheus-aviary/lark/releases/tag/android-v0.2.0)。两个 tag 指同一个 commit `9b359c0`，产物哈希与绑定见上。九步照 M7 §3.5 走完，**每步用户确认**。
  🔴 **门禁抓到一条判据自己的病**（第三次了）：`accept-m5` 的 `status counts every file and reports the limit it was given` 断言 `limit_mb === 0`，而那个 0 是**从被复制的用户配置里读来的**——机器主人当天设了 5 GiB 上限，判据当场变红，而 daemon 报的正是它被给的那个数。改成**判据先给出它要断言的值**（`PATCH /config` 再读 `/cache/status`），和 0.4.1 那次 accept-gui 判据 6 同形。**「判据别把环境当契约」在这一版又验了一次。**
  `accept-pack` 28 → **29**：新增 `§3a2 · both renderer entries ship`。桌面歌词是第二个 renderer 入口（`lyrics.html`），少打包它的产物在源码上完全正常、装上去开歌词窗是白窗——这是「只有产物看得见」的那一类。

- **P1–P11（2026-08-28）** —— 八条用户反馈落地：输入法组字不提交（五处输入框全中过同一个招）· 放弃的解析回到来处 · 加歌页草稿 · 下载来源 + 桌面记录持久化 · **桌面歌词** · 手机歌词中线跳转 · 清洗命名认识多个歌手 · 手机歌词最后一行居中。协议 8 → 9，schema 不动。

- **人工验收长出的三批修订（2026-08-28，全部在子计划 §7）**：
  🔴 **修订 1 · 判据 19 红** —— 桌面歌词窗整窗是 `-webkit-app-region: drag`，而**拖拽区吞掉它自己那条控制条赖以出现的 hover**：五颗按钮和把手一次都没出现过，右键弹出的 macOS 窗口菜单是同一件事的另一面。改成 pointer 手动拖（main 读 `screen.getCursorScreenPoint()`，按按下那一刻的锚点 `setBounds`——`setBounds` 是请求不是赋值，拿返回值重锚会把一次拒绝折进后面每一步）+ 把手自己 resize（Electron 文档：透明窗口不可 resize，那个把手本来是句空承诺）+ 悬停画出窗口范围。**没有任何测试看得见这件事**：jsdom 不认识 `-webkit-app-region`，vitest 又把 CSS import 桩成空串（写出来的会是一条空判据，验破法时才发现），所以落成第十四条守卫。
  **修订 2 · 桌面歌词实时预览**（用户提）—— 行数/字号/配色不看见就选不出来。预览 = **把草稿 publish 给那个窗口**，一个字节都不写盘，所以「不保存关掉就变回去」不需要撤销这一步；`locked` 与几何不可预览（锁上就点不到唯一的解锁开关，几何是窗口自己写的）。顺带修掉一个真 bug：`buildPatch` 拿草稿和**当下**配置做 diff 而草稿只在打开那一刻建一次 ⇒ 设置页开着时拖动歌词窗再保存，窗口会弹回去。改成**只发人碰过的字段**；没碰过的字段反过来**跟随配置**，所以控制条改的东西、拖出来的新位置，设置页里也跟着变。
  **修订 3 · 真机会话四条** —— 首页排序本地持久化（`portable/song-sort-pref.ts`）· 歌词待跳转行加粗 + 整行可点 · 🔴 **取消一个正在搜歌词的任务从来不会变成「已取消」**（`allSettled` 与「never throws」两个正确决定合起来把 abort 吃干净，按了取消的人被告知网络断了；平台若已答完则更糟——歌词照写、任务成功）· 歌单里看不出哪几首还要下载（两份 row markup 走散，C12 的旧账）。

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
