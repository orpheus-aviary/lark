# Phase B · N4d 添加页 v1 + 任务列表 + 分享 intent（`apps/mobile`）

- **日期**：2026-08-21（v1）／**2026-08-23 决策 a–j 全部关闭，§5 是定案**，开工。
- **这是 N4 子计划里 N4d 那一行的展开**，不替代它：`docs/plans/2026-08-20-phase-b-mobile-n4.md` 的 §1.8（分享 intent 四条事实）· §2.1（文件布局）· §2.5（**添加页状态机**）· 决策 **i**（提交语义）/ **j**（任务列表放添加 tab 内）/ **k**（`local_metadata.naming_mode`）/ **p**（分享在根层消费）· 判据 **20–25**（**22 是 gate**）全部原样继承。这份只写「怎么落地、分几批、怎么验」。
- **前置**：**N4c 已完成**（head `760419c`，判据 15–19 + 41–43 全关）。手机上已经有：引擎 + 进程级 hub（`downloads/hub.ts`）· 落盘协议 · 启动清扫 · dataSync 前台服务与它的状态机（`downloads/foreground.ts` 的 `arm()` / `settle()` / `handleTimeout()`）。
- **基线**：2026-08-21 实测 `just check` exit 0、`just test` exit 0 / **2764 passed**（shared 129 · core 1226 · mobile 86 · cli 428+9 skipped · daemon 468 · gui 427）。
- **冻结设备**：vivo V2408A（Android 15 / API 35），行为判据一律 **release 构建**。

---

## §0 范围

**做**：`ui/add-tab.tsx`（粘贴 → 解析 → 命名模式 → 目标 → 提交）· 任务列表（进度 / 取消 / 全部取消 / 降级态）· `useDownloads` hook（hub 的第一个消费者）· **根层分享 intent 消费**（决策 p）· `local_metadata.naming_mode`（决策 k）· **`arm()` / `settle()` 接到提交按钮**（N4c 决策 f 留下的唯一接线）· 判据 20–25。

**不做（本批）**：收藏夹 / 合集展开与勾选（N4f）· LLM 设置页与它带来的四条能力（N4e——**所以本批的关键词 / clean / 多 P 一律是「说清楚为什么不行」**）· ensure-file（N4g）· 通知上的取消按钮（N4c §0 已明确留给「有了任务列表再说」，**本批仍不做**，理由见 §7）· 失败任务的重试入口 · 每首一条通知。

**一句话的边界**：N4c 之后手机能在后台把一首歌下完，**前提是这首歌是我用验收面板塞进去的**；N4d 之后，一个人可以自己粘一条链接。

---

## §1 开工前必须知道的

### 1.1 没有 LLM 的世界里，四条入口有三条只能拒绝

`preflightSingle`（`portable/download/preflight.ts:68`）的三道门在没有模型时全部关着：**关键词**、**clean 命名**、**多 P 且链接不带 `?p=`**。移动端的 `getLlmConfig` 今天固定返回空配置（`downloads/engine.ts` 的 `NO_LLM_CONFIG`），N4e 才有设置页。

这不是缺陷，是顺序——**但它决定了 v1 添加页的形状**：三条拒绝必须是**页面上说得清楚的一句话**，而不是提交之后从任务列表里冒出来的一条红字。portable 已经把话写好了（「关键词搜索需要配置 LLM；或者直接粘贴 B 站视频链接」「这个视频有 N 个分P：在链接后加 ?p=<编号>，或配置 LLM 让它自动选集」），**移动端不重写这些句子**，只决定它们出现在哪一屏。

### 1.2 分享进来的只有短链（N0b-4c 实测，四条原样继承）

1. **分享文本里没有 bvid，只有 `b23.tv` 短链**，`EXTRA_TITLE` 为空 → 展开之前识别不出任何东西，**「正在解析」必须是一个看得见的状态**（判据 21 就是它）。
2. **收藏夹分享不到系统面板**（进的是 bilibili 自己的发动态发布器）→ 收藏夹/合集只能靠粘贴框，这也是 N4f 的事。
3. **payload 是易失的**（`resetOnBackground` 默认开）→ **挂载即消费**。
4. **消费点不能在添加页上**：`ui/shell.tsx:60` 是 `{tab === '添加' && <AddTab />}`，而 `ui/shell.tsx:43` 的默认 tab 是「歌曲」——冷启动分享会因为添加页根本没挂载而永远收不到（决策 p）。

### 1.3 取消有三种结果，UI 必须分别作答

`engine.cancel`（`portable/download/engine.ts:437`）的注释就是判据 23 的规格：**queued 或早期 running → cancelled**；**过了提交点（`saving`）→ 抛 `TaskNotCancellableError`**；**终态 → no-op，可安全重试**。「全部取消」因此不是一个结果，是 N 个结果——**过了提交点的那条要如实说不能取消**，不能整批报成功，也不能因为它一条就把别的取消掉的说成失败。

### 1.4 hub 的 hook 是本批的活

`downloads/hub.ts:83` 的 `getState()` 交回**缓存对象**，只在引擎说有变化时重建——这正是 `useSyncExternalStore` 要的（它用 `Object.is` 比较，每次新建对象会无限重渲染）。hub 的头注释原文：「**The hook itself arrives with its first component; there is nothing to hang it on yet**」——那个 component 就是本批的任务列表。

### 1.5 `arm()` / `settle()` 的合同（N4c §8-1，本批是它的第一个真实调用方）

```ts
await foreground.arm();            // 手势那一刻，网络之前
try {
  const item = await resolveOne(...);      // 短链一跳
  const target = await preflightSingle(...);
  engine.enqueueDownload({ target, playlistIds });
} finally {
  foreground.settle();             // 预检抛了也得撤
}
```

**两条都不能省**：`arm()` 晚一步（放到入队时刻）就撞上 N4c-3 实测的那件事——**后台的 `startForegroundService()` 在这台机器上既不抛也不起，被延后到应用回前台**，等于整个下载期间毫无保护；`settle()` 漏了，「预检后什么也没入队」这条边就没有触发源，服务会一直举着这个进程。

### 1.6 🔴 一个还没量过、可能改形状的：`singleTask`

`expo-share-intent` 的 config plugin 会把 `MainActivity` 的 `launchMode` 改成 `singleTask`（N4 §6 风险表已列）。而这个应用有一条**冻结的启动序列**和 `bootOnce`——N2 的 [expo-sqlite Activity 重启陷阱](../LESSONS.md) 就是「Activity 被销毁重建后再打开同一个库直接崩」。`bootOnce` 已经挡住第二次 boot，但 `singleTask` 改的是**任务栈与 `onNewIntent` 的语义**，不是 `onCreate` 的次数。

**开工第一件事就是把依赖装上、prebuild、装机，然后做三件事**：冷启动 → 按 BACK 退出 → 再打开；以及从别的应用回来。**答错了整批的形状要改**（草稿要落库、或者放弃 `expo-share-intent` 自己写 intent 消费），所以它排在 N4d-1 而不是最后（N4c-1 排 §1.6 的同一个道理）。

> 🟢 **2026-08-23 实测，主机上就答完了：这条风险不成立。** 做法是两次 prebuild 对拍——先把插件整块从 `app.config.ts` 摘掉 prebuild 一次，再装回去 prebuild 一次，diff 两份生成的 `AndroidManifest.xml`。
>
> **插件对 manifest 的全部改动是一个 `<intent-filter>`（ACTION_SEND + `text/*` + DEFAULT），别的一个字都没动。** `android:launchMode="singleTask"` **在没有这个插件时就已经是 `singleTask`**——它是 Expo SDK 57 模板自己的默认值，插件的 `withAndroidMainActivityAttributes.js:32` 只是把同一个值又写了一遍。
>
> **所以任务栈语义从 N2 起就没变过**：`bootOnce`、N2f 的 Activity 重建、N3 的所有真机 session，全都已经在 `singleTask` 下跑过了。插件新增的只是**一条到达路径**，而它的投递（`onNewIntent`）只在真有分享进来时才发生——那是 N4d-3。
>
> 判据 44 因此**收窄成「新依赖没把构建和启动搞坏」**，仍然要在设备上走一遍，但它不再是会改批次形状的那种问题。§6 风险表的第一行同步降级。

### 1.7 标签表已经有两份，本批会是第三份

`packages/gui/src/renderer/src/lib/download-labels.ts`（`STAGE_LABELS` / `KIND_LABELS` / `STATE_LABELS` / `inputLabel`）与 `apps/cli/src/lib/wait.ts:42` 各有一份中文表，而**移动端不许 import GUI**（守卫）。第三份拷贝就是三份会漂的枚举文案 → 决策 a。

### 1.8 桌面的默认命名模式是 `clean`，而手机上 `clean` 现在必然被拒

`packages/gui/src/renderer/src/lib/naming-mode.ts` 的 `DEFAULT_NAMING_MODE = 'clean'`（理由写在那里：B 站标题通常不是歌名）。**照搬到手机上，v1 的每一次首提交都会撞 LLM 门。** → 决策 f。

---

## §2 目标结构

### 2.1 文件布局

```
packages/core/src/portable/
└── naming-mode.ts            ← 新（N4d-1）：local_metadata.naming_mode，照 play-mode.ts 的形状
packages/shared/src/
└── download-labels.ts        ← 新（N4d-1，决策 a）：三张枚举表 + inputLabel

apps/mobile/src/
├── downloads/
│   ├── preflight.ts          ← 新（N4d-2）：portable preflight 的移动薄壳（LLM 快照 + 分类结果）
│   └── use-downloads.ts      ← 新（N4d-1）：hub 的 useSyncExternalStore hook
├── share/
│   └── intent.ts             ← 新（N4d-3）：根层消费 + 草稿单例（决策 e）
├── ui/
│   ├── add-tab.tsx           ← 新（N4d-2）：§2.2 的状态机
│   ├── task-list.tsx         ← 新（N4d-1）：hub 的第一个消费者
│   └── shell.tsx             ← 改（N4d-2/3）：AddTab 换掉；根层分享 → 切 tab
└── app.config.ts             ← 改（N4d-1）：expo-share-intent 插件（`scheme: 'lark'` 第 18 行已经在）
```

### 2.2 添加页状态机（把 N4 §2.5 补齐边）

```
        idle ─── 粘贴/输入 ───▶ typing
                                  │ 离线 parse（parseSongInput，零网络）
        ┌─────────────────────────┼──────────────┬───────────────┐
        ▼                         ▼              ▼               ▼
     video                     keyword      favorites/collection  说不出
   （可提交）              （本批只能拒绝）    （本批只能拒绝）    （明确拒绝）
        │
        │  短链 → [正在解析] ──一次网络跳──▶ 上面四选一（判据 21）
        ▼
   命名模式（记忆，决策 f）+ 目标歌单（默认「仅曲库」）
        ▼
   提交 = arm() → preflight → enqueue → settle()
        ▼
   任务列表（§2.3）
```

**每条边的理由，一句一条**：

- **离线 parse 走在网络之前**：`parseSongInput`（`portable/download/link.ts:71`）是纯函数，一条 bvid、一条视频链接、一段乱码它当场就分得清。**只有短链需要网络**，所以「正在解析」这一态只在短链上出现，而不是每次输入都转圈。
- **`keyword` 在 v1 是一条拒绝而不是一个入口**：没有模型（§1.1）。文案用 portable 的原话。**不静默当关键词丢给 LLM**是判据 25 的原文。
- **命名模式在提交之前选，不是提交之后问**：桌面开的是对话框（`NamingModeDialog.tsx`），手机上没有对话框的余地——一屏里两个 chip（原标题 / 清洗命名），**清洗命名在没有模型时是 disabled 且写明原因**。
- **目标默认「仅曲库」**：N4 §2.5 原文。歌单是可选的第二步。
- **提交之后立刻回到任务列表**：粘贴框清空，因为下一件事是看它下没下下来。

### 2.3 任务列表：读什么、说什么

- **读 hub**，通过 `useDownloads`（§1.4）。不自己轮询引擎。
- **一行一个任务**：`title ?? inputLabel(input)`（`title` 在命名之前是 null，`DownloadTaskData.title` 的合同原文是「**回落到输入，不要编造**」）· 状态/阶段标签（决策 a 的表）· 进度（`received_bytes` / `total_bytes`，两者都只在 `downloading` 有意义）· 失败时 `error_message`。
- **取消**：单条取消按 §1.3 的三种结果分别作答；「全部取消」逐条作答（决策 d）。
- **降级态**：hub 的 `foreground.phase === 'degraded'` → 列表顶上一行「**没有前台服务，切走可能会中断**」（N4c 决策 e 说的「N4d 渲染它」就是这里）。`paused-by-system` → 「系统收回了后台下载配额」。
- **不做**：全局下载条（N4 决策 j：手机四个 tab 已满，minibar 归播放，进行中的下载靠通知在别的 tab 也看得见）。

### 2.4 分享 intent 的消费点与草稿（决策 p / e）

```
App/Shell 挂载 ──▶ useShareIntent（根层，永远挂着）
                        │ 收到 text
                        ▼
                  草稿单例（内存，消费即清）
                        │
                        ├─▶ setTab('添加')
                        ▼
                  AddTab 挂载时读走草稿 → 进 §2.2 的 typing/正在解析
```

- **草稿是内存单例不是库**（决策 e）：payload 本来就是易失的，落库会让「上次分享的东西」在下次冷启动时诈尸。
- **切 tab 是消费的一部分**，不是副作用：收到分享而停在歌曲 tab，用户会以为没收到。
- **判据 22 的反测**：把消费点搬回 `AddTab` → 冷启动那次必须收不到。

### 2.5 命名模式记忆（决策 k）

`portable/naming-mode.ts`，照 `portable/play-mode.ts` 的形状一比一：一个 `local_metadata` 键、**读路径永不写库**、值域外的值读成默认并 `logger.warn`。桌面继续用 localStorage（play-mode 同款分叉，理由是 N2f 的决策 n）。

---

## §3 批次划分

| 批 | 内容 | 需要设备 | 判据 |
|---|---|---|---|
| **N4d-1** | **依赖与地基**：`expo-share-intent@8.0.1` + `expo-linking@57.0.6` 进 `apps/mobile` + 插件（`{ androidIntentFilters: ['text/*'], disableIOS: true }`，照 spike）+ **§1.6 的 `singleTask` 实测** · `portable/naming-mode.ts` · `shared/download-labels.ts`（决策 a）+ GUI/CLI 改成消费它 · `useDownloads` hook · `ui/task-list.tsx` | **是**（只为 §1.6 那一次启动 + BACK） | 44（新增）· 23 的逻辑半边 |
| **N4d-2** | **添加页 v1**：`downloads/preflight.ts` · `ui/add-tab.tsx`（§2.2）· arm/settle 接线 · shell 换掉 AddTab | 是 | **20 · 21 · 23 · 24 · 25** |
| **N4d-3** | **分享 intent**：根层消费 + 草稿 + 切 tab | 是 | **22（gate）· 45（新增）** |

**顺序理由**：§1.6 的 `singleTask` 是**一次装机就能答**、答错要改形状的那种问题，所以依赖与它的实测排最前（N4c-1 同一个道理）；标签表与 hook 是任务列表的前置，而任务列表是添加页提交之后唯一能看的地方，所以它先于添加页；分享 intent 最后，因为它是**往一个已经能用的添加页里塞输入**，添加页不成立时它没有可验的落点。

---

## §4 判据

**继承 N4 子计划的 20–25，逐条给出「怎么跑」**：

20. **粘一条视频链接走通全程**：预览认出它 → 选命名模式 → 选目标（默认「仅曲库」）→ 提交 → 任务列表出现进度 → 完成后**歌曲 tab 里就有它**。跑在 Wi-Fi 上，用夹具那条短曲（`short`，2:17）。
21. **短链有「正在解析」这一态**：粘一条 `b23.tv`，**展开期间 UI 明确在等**，展开后显示真实 bvid。**反测**：把短链的展开挪到提交时刻 → 这一态必须消失（这条是**代码改动反测**，跑在笔记本上用假 client 也成立）。
22. **【gate】分享 intent 三条路径 + 根层消费**：从**真 bilibili app 的视频详情页**分享，冷启动 / 后台存活 / 前台各一次；**冷启动那次的默认 tab 是「歌曲」，仍然必须收到**并自动切到添加页。**反测**：把消费点放回 `AddTab` → 冷启动那次必须收不到。
23. **取消的三种结果**：running 的任务点取消 → 最终 `cancelled` 且**目录不留残骸**（`songs/<id>/` 不存在，或存在但没有 `song.m4a`——按落盘协议它在 ⑥ 之前不写 canonical）；「全部取消」**按每条任务分别作答**，过了提交点的那条如实说不能取消。**单测覆盖逻辑半边**（三种结果的文案与聚合），设备覆盖「目录不留残骸」。
24. **命名模式记忆**：选过一次之后**下次默认是它**（`local_metadata.naming_mode`）。跨一次冷启动仍然记得。**反测**：把写入去掉 → 必须回到默认。
25. **说不出的输入不装懂**：非 bilibili 链接（如 `https://youtube.com/watch?v=x`）/ 一段乱码 → **明确拒绝并说支持什么**，不静默当关键词丢给 LLM。用 portable 的原话。

**本批新增两条**（编号接 N4c 的 41–43）：

44. **依赖进来了，应用还起得来**（§1.6）：`expo-share-intent` 装上、prebuild、release 装机之后 —— **冷启动正常** · **按 BACK 退出再打开正常**（`bootOnce` 仍然只 boot 一次，设置页的「启动判定」不变）· **从别的应用切回来正常**。`just check`（含 bundle smoke 与两条 mobile 守卫）与桌面 `just test` 全绿（**依赖变动后的常驻规矩**）。
45. **分享草稿不诈尸**：分享一次并**消费掉**之后，杀掉应用重开 → 添加页是**空**的，不带上次分享的内容（决策 e 的直接判据）。**反测**：把草稿落进 `local_metadata` → 必须诈尸。

---

## §5 决策（a–j，**2026-08-23 全部关闭**，下表即定案）

| # | 决策 | 定案 | 关键理由 |
|---|---|---|---|
| **a** | 三张中文标签表 | **提升进 `@lark/shared`**（新文件 `download-labels.ts`），GUI 与 CLI 改成消费它 | 已经两份（GUI renderer + `cli/lib/wait.ts:42`），移动端不许 import GUI，第三份就是三份会漂的枚举文案——**rule of three**。shared 已经装着 `nowPlayingTitle` 这种直接产出用户可见字符串的东西，不算越界。代价是动桌面两处，由桌面测试守着 |
| **b** | 目标歌单的形态 | **默认「仅曲库」+ 一个 sheet 选已存在的歌单；本批不做「新建歌单」** | `ui/sheet.tsx` 已经在；新建歌单是 N4f 批量提交要的（`BatchTargetInput` 的 `kind:'new'`），v1 少一个入口不少一件事 |
| **c** | 任务列表显示多少 | **直接渲染 hub 的 `tasks`（引擎自己的 ring），进行中在上、终态在下，终态只留最近 20 条** | 引擎已经在做窗口，前端再裁一次就是第二套口径；20 条是一屏多一点 |
| **d** | 「全部取消」的口径 | **全部非终态（queued + running，含 lyrics）**，与 `handleTimeout` 同一个函数 | N4c 的 `onTimeout` 已经写了这个口径且有单测；两处两套写法必漂。lyrics 也是网络工作（N4c 决策 h 的同一条理由） |
| **e** | 分享草稿存哪 | **内存单例，消费即清** | payload 本来就是易失的（N0b-4c）；落库会让上次分享在下次冷启动诈尸（判据 45） |
| **f** | 移动端的默认命名模式 | **记住的值优先；没有记录时：有模型 → `clean`，没模型 → `original`** | 桌面默认 `clean`（`gui/lib/naming-mode.ts`，理由是 B 站标题通常不是歌名），但手机上 v1 没有模型，照搬会让每一次首提交都撞 LLM 门。这条规则在 N4e 落地后**不需要迁移** |
| **g** | 解析时机 | **输入停止 400ms 后离线 parse；短链才发网络**，提交按钮在识别出 video 之前 disabled | 离线 parse 是纯函数、零成本；「正在解析」因此只在真的需要一跳时出现（判据 21 要的正是它） |
| **h** | 分享进来之后自动提交吗 | **不自动**：填进粘贴框、解析、停在「选命名模式」那一步 | 命名与目标是用户的选择；自动提交会把「分享」变成「下载到默认位置」，而下载是分钟级、要流量的 |
| **i** | 失败任务的重试 | **本批不做**，失败行显示 `error_message` | 重试的正确形态是「换个命名模式再来」或「配了模型再来」，两者都要 N4e |
| **j** | 通知上的取消按钮 | **仍然不做** | N4c §0 说「有了任务列表再说」——现在有了，但通知 action 要 `PendingIntent` 回到进程再落到引擎，是一条新的跨进程控制面；v1 的取消在页面上够用，见 §7 |

---

## §6 风险

| 风险 | 缓解 |
|---|---|
| ~~🔴 **`singleTask` 改任务栈语义**（§1.6）~~ → **🟢 已排除**（2026-08-23 两次 prebuild 对拍） | 插件只加了一个 intent filter；`singleTask` 本来就是 SDK 57 的默认值，任务栈语义从 N2 起没变过。判据 44 收窄成「新依赖没把构建和启动搞坏」，仍在设备上走三条路径 |
| **新依赖扰动桌面** | 常驻规矩：`pnpm install` 变动后复跑桌面 `just check` + `just test`；bundle smoke 每批跑（判据 44 明写） |
| **标签表提升动了 GUI 与 CLI** | 桌面 427 + 428 条测试守着；纯搬迁 + re-export，不改文案一个字 |
| **判据 20 依赖真实网络** | 与判据 5/6 同一条：跑在 Wi-Fi 上、用夹具那条短曲；失败先看是不是流地址过期（两小时） |
| **判据 22 要真 bilibili app 分享** | N0b-4c 已经走通过同样的路径（spike 包），本批换成产品包再走一次；**收藏夹分享不到系统面板**是已知的，不要在那里浪费时间 |
| **添加页的键盘遮挡** | RN 原生控件、无手势栈：`ScrollView` + `keyboardShouldPersistTaps="handled"`，提交按钮在输入框上方而不是屏幕底部 |

---

## §7 本批不会证明的事（先写在这里）

- **关键词 / clean 命名 / 多 P 选集能用**——本批只证明它们**被拒绝得清楚**（N4e）。
- **收藏夹 / 合集**：连入口都没有（N4f）。
- **通知上的取消**（决策 j）：取消只在添加页上。**代价是：切到别的 tab 或锁屏时，能看见进度但不能停它。**
- **ensure-file / 点没有文件的歌**（N4g）。
- **失败任务的重试**（决策 i）。
- **多条任务同时下载的表现**：引擎只有一个 worker（`engine.ts:688-690` 的 `#worker`，一次一个 running），本批不改，也不验并发。
