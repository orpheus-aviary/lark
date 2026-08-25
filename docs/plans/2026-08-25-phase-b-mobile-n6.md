# Phase B · N6 歌单导入 + 收尾发布（`apps/mobile`）

- **日期**：2026-08-25（v1，待评审）
- **执行顺序**：N5 ✅ →（本批）**N6** → Phase B 收官发版
- **前置**：N5 全期完成（判据 65–84 全关）。开工基线复跑于 2026-08-25：`just check` **exit 0** · `just test` **3092 passed**（shared 170 / core 1337 / daemon 471 / gui 427 / cli 428+9 skipped / mobile 259）
- **冻结设备**：vivo V2408A（Android 15 / API 35），行为判据一律 release 构建
- **测试规模**：沿用 N5 —— **默认落单测且优先在电脑上跑**；设备判据攒成**一次打包、一次会话**，由用户自己跑；我只负责 `just mobile-android-release` + 把「看什么」讲清楚
- **判据编号**：**85 起**（N5 用到 84）

**一句话的边界**：N5 把手机接进了 workspace，N6 把它**交出去**——补上最后一个跨账号/离线的入口（歌单导入）、补上设置页最后一个缺口（撤销设备），然后给这台 app 一个自己的签名和一次真正的发布。

---

## §0 范围（用户 2026-08-25 定）

**做**：

1. **歌单导入**——读桌面导出的 `*.lark-playlist.json`，预览 → 提交。**功能与桌面一致即可，不加内容**（用户原话）。
2. **撤销设备**——设置页同步区的设备列表补上这一个动作（N5 决策 f 明确 defer 到本批）。
3. **签名 APK**——**从简**：接上已有的 `lark-release.jks`，仅此而已。
4. **发布形态**——**只在 GitHub Release 里发包，不考虑进商店**（因此 developer verification 的 go/no-go 有了确定答案，见 §1.7）。
5. **发版前的文档大整理**——**到那一步再细说**（用户原话）；本文只占位，不预先规定内容。
6. **发版**——桌面 dmg + `@orpheus-aviary/lark-cli` + APK。⚠️ **桌面版打包记得用图标**（用户专门提醒，判据 99）。

**不做（本批）**：判据 **76 / 80 / 81**（今日定案「先不做，只记录」）· 后台同步（N5 决策 b，留在账上）· 锁屏暂停键接进 JS（N4g 决策 j）· 歌词管理面（N4i 决策 f）· 本地**音频**文件导入（D12）· TLS（后续，负责人=用户）· 拖柄重排（N2 已定不做）。

---

## §1 开工前必须知道的

### 1.1 core 侧全部就位 —— **N6 大概率不动桌面**

导入的业务逻辑早在 N1 就进了 portable，服务层也已经把它露出来了：

- `packages/core/src/portable/library/transfer.ts` —— `parseAndValidate` / `previewImport` / `importPlaylistInTx` / `importPlaylist` 全在 portable，`transfer.test.ts` 在同目录
- `packages/core/src/portable/services/library.ts:158-161` —— `LibraryContract` 的 transfer 段已经有 `parseImportFile` / `previewImport` / `importPlaylist` 三个动词

**这与 N4/N5 都不同**：那两批各自都得先做一个「纯桌面提取批」。N6 没有提取批，桌面代码理论上一行不动。**这条要在 N6a 结束时用事实确认**（判据 85），因为它直接决定发版门禁能不能与 APK 一起走。

### 1.2 🔴 `sha256BytesAsync` 在手机上**一个都没装** —— 这就是「N6's gate」

`packages/core/src/portable/runtime/digest.ts` 按输入大小把哈希劈成三份，第三份（整文件 sha256，上限 20MB）**故意没有默认实现**：

> *"NO default. An async signature is not the same thing as a non-blocking one — a Promise wrapped around the synchronous `sha256` above would still hash 20MB on the JS thread, and the caller could not tell."*

桌面在 `packages/core/src/node-runtime.ts:23` 装了 `node:crypto` 那一份；**手机上全仓没有第二处 `installSha256BytesAsync`**。所以今天在手机上调 `parseImportFile` 会当场抛。`transfer.ts:196` 的注释写的就是这件事：*"the desktop `node:crypto`, the phone whatever it has (**N6's gate**)"*。

**答案已经在依赖里**：`expo-crypto@57.0.1` 已是 `apps/mobile` 的依赖（现在只用了 `getRandomValues` / `randomUUID`，`boot/runtime.ts:28`），而它带 `digest(algorithm, data: BufferSource): Promise<ArrayBuffer>` —— 原生异步调用，正是这个端口要的形状。**N0b-3 留下的「出口 B」到这里结账**：装上之后在冻结设备上量一次 2MB（10,000 首上限）的实际耗时（判据 86）。

### 1.3 桌面的两阶段语义 —— 要照抄的是这个，不是像素

`packages/gui/src/renderer/src/components/ImportPlaylistDialog.tsx` 的开头四行注释就是规格：

- **两次请求，中间那道缝才是设计**：预览读一次文件说「会发生什么」，提交**再读一次**，一个字节不同就拒绝（`IMPORT_SOURCE_CHANGED`）——因为 `reuse[].index` 指的是**用户当时看着的那个文件**。所以对话框持有的是 **digest**，不是文件的解析副本。
- **suspects 默认「导入为新条目」**（R12）：同名同歌手但 key 不同，是现场版/翻唱的概率不低于是重复，而**错误的合并不可撤销**。
- 提交后 `IMPORT_SOURCE_CHANGED` 的处理是**自动退回预览**，不让用户盲重试。
- 目标三选一：**新建歌单…** / **仅加入曲库**（虚拟 all）/ **某个已有歌单**。
- 服务端二次校验在 `packages/daemon/src/routes/playlists.ts:217-262`；CLI 的同一套在 `apps/cli/src/commands/transfer.ts`（`--to` / `--new` 互斥）。

### 1.4 手机上的文件从哪来 —— ~~唯一的新依赖~~（**已作废，见 §5.1①**：`expo-file-system@57` 自带 picker，零新依赖）

桌面传的是 `file_path`，daemon 自己去读磁盘；手机没有 daemon，也没有可以自由读的路径，**必须由 app 把字节读进来**再喂 `parseImportFile(bytes)`。

- 新依赖：**`expo-document-picker`**（`apps/mobile` 目前没有）。⚠️ 一旦 `pnpm install` 变动，**必须复跑桌面 `just check` + `just test`**（N0b 起的常驻义务）。
- 取字节：`copyToCacheDirectory: true` 拿到 app 自己 cache 里的副本，再用 `expo-file-system` 读 bytes。**不碰 SAF**——与 N4g 导出那一侧同一条口径（`services/playlist-export.ts` 的抬头注释）。
- **二次读取照做**（决策 b）：cache 副本理论上不会被别人改，但 Android **随时可以清空 cache 目录**。照桌面读第二次、比 digest，比「反正不会变」诚实，代价是一次文件读。

### 1.5 导入进来的行是 `downloaded` 且没有文件 —— 在手机上这是好事

`importPlaylistInTx` 走 `createSongInTx`，而它硬编码 `fileOrigin: 'downloaded'`（`library/songs.ts:140`）。所以：

- **不产生 `imported` 行** —— N5 留下的那笔账（`imported` 可能没有 `source_key`、ensure-file 无处可下）**不会被本批加剧**，导入进来的每一行都带 `source_key`、都可重下、都在缓存清理的可回收面里。
- **N4g 之后「没有文件」不再是墙**：导入完直接点一首，就是一次播放意图 → 去拿文件 → 从头播。桌面同理（`decideNext` 已跟着改）。所以手机上的导入**不像 2026-08-17 主计划担心的那样是「一库点不响的行」**——那句话写在 N4 还没做的时候。

### 1.6 撤销设备：后端全有，缺的只是手机上的一个按钮和一次确认

- 路由 `packages/daemon/src/routes/sync.ts:152-166`，SDK 是 `client.revokeDevice(deviceId)`；注释里写明**故意允许撤销自己所在的这台**（凭据泄露时不让人撤销当前设备才是错的保护）。
- 手机侧 `apps/mobile/src/ui/sync-devices.tsx`（116 行）现在是**只读 + 按需加载**（N5 决策 f）。本批把动作补上，**并且要有单独的确认流**——它是危险动作，且撤销自己 = 把这台手机踢下线。

### 1.7 🔴 签名的现状：**今天的 release APK 是 debug key 签的**

- CNG 生成的 `apps/mobile/android/app/build.gradle:115` 原样是 `signingConfig signingConfigs.debug`（Expo 模板默认），而 `android/` **不入库**，仓里没有任何东西把 `../android-keystore/lark-release.jks`（已生成，密码同目录，N0b-5b）接进构建。
- ⇒ 必须写一个 **config plugin**（`withAppBuildGradle`），不能手改生成物——改了下一次 `expo prebuild` 就没了。
- 🔴 **换签名 = 设备上必须卸载重装**（签名不一致装不上）⇒ 私有目录连同 SecureStore 的 install_id / binding 一起清空。**用户已同意卸载重装**。N5 之后曲库元数据能从 server 拉回来，**音频要全部重下**（现在机上 8 个 `song.m4a`）。这一步顺带就是 **D16 的一次真实演练**。
- **不进商店** ⇒ **developer verification 的 go/no-go 有了答案：不注册**。D14 的政策快照本来就说 adb 侧载明确豁免，2026-09-30 只覆盖四国参与商店；2027 全球扩大时若要注册，形态是 limited distribution account（免费、上限 20 台、注册对象 = 包名 + 证书 SHA-256）。**本批只把这个结论记进文档，不做任何注册动作**（判据 97）。

---

## §2 分批与判据

### N6a — 端口打通（sha256 host + 取字节）

1. `installSha256BytesAsync` 的移动实现（`expo-crypto.digest`），装配点在 `boot/runtime.ts` 旁边现有的 random 安装处；**幂等规则照 random**（同一个函数重装是 no-op，换一个是拒绝）。
2. `expo-document-picker` 进依赖 + `services/playlist-import.ts`：选文件 → 读 bytes → `library.parseImportFile(bytes)`。**判定留在能测的文件里，wiring 归装配根**（N5d/N5e 那一课上了两次，不上第三次）。

| # | 判据 | 归属 |
|---|---|---|
| **85** | 本批结束时 `git diff` 对 `packages/{gui,daemon,cli}` **零改动**（若不成立，立刻记下是什么把桌面拖进来了） | 电脑 |
| **86** | 冻结设备上量 2MB 与 20MB 两个输入的 `sha256BytesAsync` 耗时（release 构建，nearest-rank p95），与 N0b-3 的 ~3MB/s 预估对照；**只记录，不设阈值**——上限文件是 2MB，1.3s 一来一回本就是可接受面 | 真机 |
| **87** | 桌面导出的文件在手机上 `parseImportFile` 出的 `digest` 与桌面对同一份字节算出的**完全相同**（夹具比对，单测） | 电脑 |

### N6b — 导入 UI（与桌面同语义）

落点 `apps/mobile/src/ui/import-playlist.tsx`（新文件——`playlists-tab.tsx` 已 552 行，塞进去必破 800 硬线）；入口放歌单 tab 顶部「新建歌单」旁（`playlists-tab.tsx:66-75`）。

界面四块，逐块对桌面：选择文件 → 汇总一行（共 N 首 / 新建 x / 复用 y）→ suspects 列表（默认新建，取消勾选=复用；候选 >1 时可切换复用哪一首）→ 目标三选一（新建歌单… / 仅加入曲库 / 已有歌单）。

| # | 判据 | 归属 |
|---|---|---|
| **88** | 预览**零写入**：预览后立刻查库，行数与 `sync_changes` 计数不变（单测） | 电脑 |
| **89** | 提交前文件被换掉 ⇒ 报 `IMPORT_SOURCE_CHANGED` 且**自动退回预览**，不允许盲重试（单测，照 `ImportPlaylistDialog.tsx:148` 的语义） | 电脑 |
| **90** | suspects 默认全部「新建」；取消勾选后提交，结果里 `reused` 加一、`created` 减一（单测） | 电脑 |
| **91** | 三个目标各跑一次：新建歌单（歌单出现且入单 N 首）· 仅加入曲库（`playlist_id` 为 null、`added` 为 0）· 已有歌单（追加而非替换）（单测） | 电脑 |
| **92** | 真机：从系统文件管理器选一个桌面导出的文件 → 预览数字与桌面一致 → 提交 → 歌单出现在列表里 → **点第一首能播**（走 N4g 的 ensure-file，验证 1.5 那条） | 真机 |

### N6c — 撤销设备

| # | 判据 | 归属 |
|---|---|---|
| **93** | 撤销要过一次明确确认；**撤销当前这台**时文案不同（说明会把这台手机踢下线）（单测 + 真机各一次） | 电脑 + 真机 |
| **94** | 撤销后列表刷新，被撤销的那台带 `revoked_at`；**撤销自己之后**这台手机的同步落到「需要重新登录」而不是静默失败（真机） | 真机 |

### N6d — 签名 + 卸载重装

| # | 判据 | 归属 |
|---|---|---|
| **95** | `apksigner verify -v` 对新构建的 release APK 报**证书 SHA-256 = keystore 里那一个**（不是 Android debug key）；`expo prebuild --clean` 之后复跑仍成立（config plugin 生效，不是手改） | 电脑 |
| **96** | 卸载重装演练：先在手机上跑一次同步至干净 → 卸载 → 装签名版 → 重新登录 → **全量 backfill 收敛到与桌面同样的曲目数** → 音频按需重下。全程记录 D16 走了哪条分支 | 真机 |
| **97** | 文档里写下「不进商店 ⇒ 不注册 developer verification」这一结论及其依据（D14 政策快照），并把 §1.7 的证据链带上 | 电脑 |

### N6e — 文档大整理 + 发版

**文档大整理到这一步再与用户细说**（用户原话），本文只登记它在流程里的位置：**在发版之前**。

发版门禁（与桌面发版绑死，不是 N6 的功能）：

| # | 判据 | 归属 |
|---|---|---|
| **98** | 桌面 **accept 全系列复跑**：`accept-gui`(15) + `accept-m5`(22，真 bilibili) + `accept-cli`(27) + `accept-sync`(34，真 server 两台 daemon) + `accept-pack`(28，对新 dmg/tgz) = **126 条**。自 v0.3.0 一条没跑过，而桌面被改了四轮（N1 重构 · N4a 提取 · N4g `decideNext` + N4i-1 URL 归一化 · **N5d-2 流控制器，有意改了桌面行为**）——这是 N1 判据 22 的兑现 | 电脑（我跑） |
| **99** | 🔴 **桌面 dmg 带图标**：打包产物在 Finder / Dock / `NSWorkspace` 渲染下**无灰边**（`lark-icon-halo` 那三层原因都已修过，但每次发版都要看一眼；做图标实验必须改 bundle id） | 电脑 + 人眼 |
| **100** | 三件发布物齐活：桌面 dmg（`just package bundled`）· `@orpheus-aviary/lark-cli`（`just pack-cli` + npm）· **签名 APK 挂在同一个 GitHub Release 上** | 电脑 |
| **101** | 跨仓文档跟进：`aviary/docs/ROADMAP.md` 与 `DESIGN.md`、`.github/profile/README.md` 补上 Android 这条线（现停在 0.3.0） | 电脑 |

---

## §3 待关闭的决策

| # | 问题 | 建议 | 理由 |
|---|---|---|---|
| **a** | 导入入口放哪 | 歌单 tab 顶部，「新建歌单」按钮旁 | 桌面也在歌单菜单里（`TopBar.tsx:263`）；添加 tab 是「从链接拿新歌」，导入是「拿一份别人的单子」，不是一回事 |
| **b** | 提交时是否**再读一次文件** | **读**（§1.4） | Android 随时清 cache；照桌面读第二次比假设「不会变」诚实，代价一次文件读 |
| **c** | 目标三选一是否照搬 | **照搬**（新建 / 仅加入曲库 / 已有歌单） | 手机已经有「仅曲库」这个概念（添加页），不用发明新词 |
| **d** | suspects 候选 >1 时怎么选 | 点一行展开候选、单选；**不做下拉** | RN 没有 shadcn 的 Select，自造一个下拉只为这一处不划算 |
| **e** | 导入文件的大小上限 | 沿用 20MB（桌面同值） | 同一份文件应该在两端得到同一个答案 |
| **f** | 撤销自己所在的这台，允不允许 | **允许**，但文案单独一版 | 后端已按「凭据泄露时必须能撤」设计（`sync.ts:152`）；界面不该比后端更保守 |
| **g** | keystore 密码怎么进构建 | 从**仓外**读（环境变量 / `~/.gradle`），config plugin 只写引用 | 密码在 `../android-keystore/`，进仓即泄露 |
| **h** | APK 版本号 | 保持 **0.1.0 / versionCode 1** | 这是它的第一次发布；桌面 0.x 与它无关（`app.config.ts:14` 的注释已经写死这条） |
| **i** | 桌面版本号 | **0.4.0**（minor） | 自 v0.3.0 有两处**有意的行为变化**（N4g 的 `decideNext`、N5d-2 的流控制器），不是 patch |
| **j** | N6e 的文档大整理范围 | **到那一步再定** | 用户明确要求 |

---

## §4 参考

- 桌面导入 UI：`packages/gui/src/renderer/src/components/ImportPlaylistDialog.tsx`（抬头四行是规格）
- 路由与二次校验：`packages/daemon/src/routes/playlists.ts:217-262`
- CLI 同一套：`apps/cli/src/commands/transfer.ts`
- 业务逻辑：`packages/core/src/portable/library/transfer.ts`；哈希三分法：`packages/core/src/portable/runtime/digest.ts`
- 手机侧的姊妹件（导出）：`apps/mobile/src/services/playlist-export.ts`
- 撤销设备：`packages/daemon/src/routes/sync.ts:152-166` · `apps/mobile/src/ui/sync-devices.tsx`
- 签名与政策：主计划 `docs/plans/2026-08-13-m4a-and-mobile-master-plan.md` D14 · N0 子计划 §9
- 发版链路九步：`docs/plans/2026-08-08-m7-packaging.md` §3.5

---

## §5 实施修订

### 5.1 N6a（2026-08-25 完成）

**① 不需要新依赖 —— §1.4 的「唯一的新依赖 `expo-document-picker`」作废。** `expo-file-system@57.0.4` 自己带 `File.pickFileAsync({ mimeTypes })`（单选/多选两个重载）与 `file.bytes(): Promise<Uint8Array>`，两个动作在同一个包里。收益不止省一个依赖：**`pnpm install` 没有变动 ⇒ 判据 13 那条「装完必须复跑桌面 check + test」这次不触发**，而且「URI 是什么意思」只有一个包在回答。

**② sha256 端口装上了，用 `expo-crypto.digest`。** `boot/runtime.ts` 从「装一件事」变成「装两件」，步骤 ① 的注释跟着改（缺它现在有两种炸法：id 铸不出来 · 读不了歌单文件）。**一处类型摩擦如实记着**：`digest` 要 `BufferSource`（= 覆盖普通 `ArrayBuffer` 的视图），而端口给的 `Uint8Array` 在 TS 5.9 里是 `Uint8Array<ArrayBufferLike>`，含 `SharedArrayBuffer`。**用 type guard 而不是 `as`，也不是无条件复制**：Hermes 没有 `SharedArrayBuffer`，所以真机永远走「原样递过去」那一支，复制那一支是留给「将来长出来了」的诚实答案（20MB 上无条件复制是白花的一次 memcpy）。

**③ 判据 87 的桌面半边已绿，且三方独立。** 常量 `488d8f…669d` 由 **`shasum -a 256`** 产出（既不是 node 也不是 expo），单测用 **`@noble/hashes`** 对同一段字节复算，设备探针用 **`expo-crypto`** 复算 —— 三个实现，一个常量，**没有任何一方给自己判卷**。夹具 `acceptance/import-fixture.ts` 被单测与探针**共用**：两处各写一份常量会各自漂移且双双变绿。夹具里的中文名是有用的（多字节 ⇒ `TextEncoder` 错了会改数字而不是蒙混过关）。

**④ 判据 86 的探针已就位**（`acceptance/playlist-import.ts`，面板上「Run import digest scenarios」）：2MB 与 20MB 各 5 次，nearest-rank p95（n=5 ⇒ 就是最慢那次）。**行的绿不代表快**——它绿是因为「真的出了一个 64 位 hex」，数字在 detail 里，这是判据里写明「只记录不设阈值」该有的样子。

**⑤ 判据 85 成立**：`git diff` 对 `packages/{gui,daemon,cli,core,shared}` **零改动**。§1.1 的推断得到事实确认 —— 发版门禁可以与 APK 一起走，也可以先走。

**落点**：`library/import.ts`（纯逻辑：两道尺寸闸 + 调用顺序，进 vitest 白名单）· `services/playlist-import.ts`（原生壳：picker + `bytes()`）· `boot/runtime.ts`（+sha256）· `acceptance/{import-fixture,playlist-import}.ts`。**`ImportFileSource` 是那条分界**：`read()` 是函数不是一份字节，因为两阶段要**各读一次**——URI 过期必须在第二阶段如实失败，而不是被这一层偷偷做的副本盖住。

**验证**：`just check` exit 0（bundle smoke：`apps/mobile` 115 个 portable 模块 / 3.1MB）· `just mobile-typecheck` 通过 · mobile 单测 259 → **263**。

---
