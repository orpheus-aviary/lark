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

### N6c — 撤销设备 + 知情与退路

**2026-08-25 用户加进本批的四条**（讨论「多工作区」时定的暂行方案，见 §6）：登录前的三段文案 · 重复条数一行 · 绑定不匹配文案手机化 · **导出整个曲库**。前三条是文字与显示，不新增判据；第四条是新入口，判据 **102**。

| # | 判据 | 归属 |
|---|---|---|
| **93** | 撤销要过一次明确确认；**撤销当前这台**时文案不同（说明会把这台手机踢下线）（单测 + 真机各一次） | 电脑 + 真机 |
| **94** | 撤销后列表刷新，被撤销的那台带 `revoked_at`；**撤销自己之后**这台手机的同步落到「需要重新登录」而不是静默失败（真机） | 真机 |
| **102** | **导出整个曲库**：歌单页「导出曲库」→ 分享出来 → 在桌面导回，**首数与手机曲库一致**（真机 + 桌面对照） | 真机 |

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

### 5.2 N6b（2026-08-25 完成）

**① 判据 88–91 的归属改过，这是本批唯一的计划偏离，如实记下来。** 写判据时假设这四条都落在移动端单测里，实际做的时候发现前提不成立：**手机 vitest 里造不出 `PortableDb`**（要 expo-sqlite），而这四条问的全是 **core 的语义**。所以：

- **判据 88（预览零写入）→ 落在 core**：`portable/library/transfer.test.ts` 新增一条，断言 `songs / playlists / playlist_songs / sync_changes` 四张表的计数在 `previewImport` 前后**逐个相等**。今天这条路上一个 INSERT 都没有、连事务都不开——**测它就是为了把「今天恰好如此」变成一句承诺**。这是本批对桌面目录的唯一改动，**纯测试，零生产代码**。
- **判据 90 / 91（reuse 语义 · 三个目标）→ 已经在 core 有测**（`importPlaylist` 那一组：按 caller 的选择合并 · 无 target 时只进曲库 · 已在目标歌单里的跳过 · 任何一处失败整批回滚）。**手机这一层不重复测 core** —— 那样测的是同一份代码两遍，而它在两个宿主上本来就是同一份。
- **判据 89（`IMPORT_SOURCE_CHANGED`）→ 劈成两半**：错误那半有单测；**「屏幕退回预览」那半是 UI，留给真机**（并进判据 92 的会话）。

**② 手机这一层自己的判定是「第二次读取」，测的是它。** 三条：第二次读真的发生 · digest 决定成败 · **交出去的 entries 是第二次读的**。最后一条的断言是 **identity 而不是 equality** —— 文件没变时两次解析出来的 entries **逐值相等**，`toEqual` 分不出来源，只有「不是同一个数组对象」能。**反测已跑**：把 `current.entries` 改回 `preview.entries`，`toEqual` 照样绿、identity 那条当场红。

**③ 比桌面好一处：`ImportSourceChangedError` 带着新解析出来的文件。** 桌面收到 `IMPORT_SOURCE_CHANGED` 之后再发一次预览请求（`ImportPlaylistDialog.tsx:148`），那是**同一个文件的第三次读取**，而且两次读之间还有一个窗口能再变一次。手机的提交手里已经有新的解析，直接 `accept(source, err.current)` 退回预览 —— 少一次读，少一个窗口。

**④ suspects 按决策 d 做成「点行展开、单选」**：行上永远写着当前的选择（`导入为新条目` / `复用：<歌名>`），展开后第一项就是「导入为新条目」。**默认永远是新建**（R12），改成复用是一次点击，只是不是「什么都不做」的那一次。

**⑤ 入口在歌单 tab 顶部「新建歌单」旁**（决策 a）。**不进添加 tab**：那个 tab 是「按链接取新歌」，这是「接过别人的一份单子」，不是一回事。

**落点**：`ui/import-playlist.tsx`（全屏 Modal，与冲突页同一套框架——suspects 可能很长、目标列表是全部歌单，两处滚动的 sheet 没法用）· `library/import.ts` 加 `commitImportFile` + `ImportSourceChangedError`。

**验证**：`just check` exit 0（bundle smoke 115 模块 / **3.2MB**）· `just mobile-typecheck` 通过 · `just test` **3100 passed**（mobile 263 → 266，core 1337 → 1338）。**判据 92 待真机**（与 N6c/N6d 攒成一次会话）。

### 5.3 N6c（2026-08-25 完成）

**① 撤销设备接上了，语义与 daemon 逐条对齐。** 按钮在每一行上，**已撤销的行没有按钮**（不是禁用的按钮——行上已经写着「已撤销」，再放一个只会拒绝的控件就要额外解释）。**撤销本机是允许的**（`daemon/src/routes/sync.ts:152` 故意允许：凭据泄露时不让人撤销当前设备才是错的保护）。🔴 **撤销本机之后不做任何本地清理**，与 daemon 一模一样：token 留着，直到服务器不再认它，然后走平常那条鉴权路径（下一轮 `noteAuthRequired`）。在这里手写一次登出等于发明第二种结束会话的方式，而确认框已经把会发生什么说清楚了。

**② 确认文案落在 `sync/devices.ts`（纯函数 + 单测），不在屏幕里。** 理由与 D16 决策表同一条：**一台设备只会显示两条文案里的一条**——你点的那一行——所以「另一条不一样」在设备上根本问不出来，除非真去撤销点什么。两条文案的区别就是**对这台手机的承诺**：撤销别人「这台手机不受影响」，撤销自己「下一轮停下并要求重新登录」。两条都不提歌，因为撤销一首歌都不动。

**③ 用户 2026-08-25 加进本批的四条**（讨论多工作区时定的暂行方案，§6 是那次讨论的结论）：

- **登录表单顶部三段文案** —— 第一次登录是**合并不是覆盖** · 同步的是曲目信息、**音频不同步** · **可能留下两条重复** · 一个曲库只能绑一个账号 · 不登录也能用但曲库只在这台手机上、退路是导出。**措辞上有三处是刻意的**：说「合并」不说「双向同步」（后者容易被读成以云端为准覆盖本地）· 明说音频不同步（否则会以为登录完歌就在手机里）· 不承诺「不会重复」（D8 允许重复落地）。
- **重复条数一行** —— `status.duplicate_source_keys` 在手机上**早就算出来了**（`coordinator/status.ts:66`，两端同一份代码），只是从来没渲染过。**行标记按用户决定不做**：有了条数就知道该去桌面清。
- **绑定不匹配文案手机化** —— `@lark/shared` 的 `loginErrorMessage` 那句结尾是 `run \`lark sync unbind\``，**手机上没有 CLI 可以跑它**。移动端在委托给共享表之前先拦这一个 code，换成「要换账号只能清除应用数据重新开始——本机尚未同步的改动会一并丢失」。**桌面文案一个字没动**。
- 🔴 **导出整个曲库（判据 102）—— 补的是一个真的洞。** 桌面自 M5 就能导出虚拟 `all`（`TopBar.tsx:200` 的注释：*Export works on `all` too — it is the whole library*），而**手机只能从歌单详情页导出**，歌单 tab 又在 2026-08-24 把 `all` 丢掉了 ⇒ **不在任何歌单里的歌，在手机上没有任何退路**。而设置页那段新文案恰恰在承诺「导出是你的备份」。`name` 传 `VIRTUAL_ALL_PLAYLIST_ID`（字面量 `all`），与 daemon 逐字节一致 ⇒ 文件是 `all.lark-playlist.json`，导回来时预览页的名称框可以改。

**落点**：`sync/devices.ts`（新，纯逻辑 + 单测）· `ui/sync-devices.tsx`（撤销按钮 + `Alert`）· `ui/sync-section.tsx`（三段文案 + 重复行 + 错误分支）· `services/playlist-export.ts`（`shareLibraryExport`，与歌单导出共用落盘与分享那一段）· `ui/playlists-tab.tsx`（「导出曲库」）。

**验证**：`just check` exit 0 · `just mobile-typecheck` 通过 · `just test` **3104 passed**（mobile 266 → 270）。**判据 93 的设备半边 · 94 · 102 待真机**（与 92 攒成一次会话）。

### 5.4 N6d 的电脑半边（2026-08-25 完成；**判据 95 · 97 关，96 待真机**）

**① 签名接上了，落点是 config plugin。** `plugins/with-release-signing.js` 改生成的 `app/build.gradle` 两处：`signingConfigs` 里插一个 `release`，`buildTypes.release` 的 `signingConfig` 从 `signingConfigs.debug` 换成条件式。**两处都锚在结构上而不是模板的注释文字上，锚不到就抛** —— Expo 升级把这个文件改了形，应该让构建停下来，而不是悄悄留成 debug 签名。

**② 密码一份都没有被复制。** `android-keystore/README.md`（决策 g）写死了：不进仓库、不进 `gradle.properties`、不进环境文件、不进 CI。所以**穿过环境的是目录**（`ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR`，Gradle 自己会把它变成 project property，不用把 `-P` 穿过 Expo 的 CLI），**密码由 Gradle 在签名时自己读那个 0600 文件** —— 这正是那份 README 早就描述的形状。

**③ 🔴 降级是真实存在的，靠读产物的守卫兜住。** 没有那个 property 时 release 仍用 debug 配置——不能在配置期拒绝，否则每个 debug 构建、每次全新 clone 都会炸。留下的失败模式就是「release APK 被 debug key 签了，而且没人知道」，答案不在插件里：`just mobile-android-release` 设好 property，**构建完当场跑 `just mobile-verify-apk`** 比对证书 SHA-256。**读产物的守卫骗不过一个没跑起来的插件。**

**④ 判据 95 已绿，且反测跑过。** `expo prebuild --clean` 重建 → `assembleRelease` → `apksigner verify --print-certs` 回 `38544c9f…f63d`，与 N0 子计划 §9 记的指纹**逐字符相同**。**反测**：去掉 property 重新 `assembleRelease`，**BUILD SUCCESSFUL**（这就是它危险的地方），产物却是 debug key `fac61745…`，`mobile-verify-apk` 当场红并指出「检查 ORG_GRADLE_PROJECT_LARK_KEYSTORE_DIR 有没有到 Gradle」。校验会把**所有签名者去重后**比对，一个 apk 被两把钥匙签也蒙不过去。

**⑤ 判据 97（developer verification go/no-go）落定：不注册。** 依据写进主计划 D14 那一行：发布形态是**只在 GitHub Release 挂 APK、不进任何商店**，而政策快照里相关的两条都不触发——**adb / 直接侧载明确豁免**，2026-09-30 只覆盖巴西/印尼/新加坡/泰国的**参与商店**（测量设备 SIM 国家 `cn`）。真正相关的日期仍是 **2027 全球扩大**，到时形态没变再复查；注册要交的东西已经齐了（包名 + 证书 SHA-256），所以不是需要提前做的事。

**⑥ 判据 96（卸载重装演练）待真机，且有一条硬前提要先说。** 现在装在手机上的是 **debug key 签的**，新 APK 换了签名 ⇒ **装不上，必须先卸载**，而卸载会连私有目录带 SecureStore 的 install_id / binding 一起清空。所以顺序是死的：**先在手机上「立即同步」到待推送 0 → 再卸载 → 装签名版 → 重新登录 → 看全量 backfill 收敛**。⚠️ **`expo run:android` 遇到签名不一致可能会自己提出卸载重装**——那一步会不声不响地清掉曲库，所以这次装包**用 `adb install` 手动来**，不走 `expo run:android` 的安装。

**验证**：`just check` exit 0 · `just test` **3104 passed**（本批不改产品代码，数字不动）· `just mobile-verify-apk` ✓。

### 5.5 真机会话（2026-08-26，一次会话关掉六条判据）

**由 AI 驱动**（用户连 USB 后明确要求），冻结设备 vivo V2408A，两个 release 构建都用 lark 自己的钥匙签。**判据 86 · 87 · 92 · 93 · 94 · 96 · 102 全绿。**

**取证先行**：从机上 pull 下来的旧 APK 证书是 **`fac61745…`**，与「去掉 property 重建」那次反测的指纹逐字符相同 ⇒ **旧安装确实是 Android debug key 签的**，「换签名必须先卸载」是实测不是推断。卸载前先确认**待推送 0 条**（已推 = 已拉 = 1729），所以曲库该发的都在 workspace 里。

**判据 86（`sha256BytesAsync` 耗时）——`出口 B` 的问题彻底不存在了**：2MB（10,000 首上限）**p95 2ms**（1/1/2/1/1）· 20MB（路由上限）**p95 13ms**（13/10/12/10/9）。N0b-3 按**纯 JS** 估的是 ~3MB/s（2MB 要 660ms，预览+提交一来一回 1.3s）；原生调用是 **~1.5GB/s，快约 500 倍**。这条从「要不要把哈希挪出 JS 线程」变成「根本不用想」。

**判据 87** ✓：`expo-crypto` 在机上算出 `488d8fc7…d669d`，与 `shasum` 定的常量、单测里的 `@noble/hashes` **三方一致**。

**判据 96**：卸载 → 装签名验收包 → 卸载 → 装签名产品包 ⇒ **0 首「曲库是空的」**（私有目录确实被清空）；登录后收敛回 **18 首 · 2 个歌单（4/4）**，与卸载前和桌面副本逐项相同，**音频 7 个 → 0 个**（全部「需要下载」）。**本机设备 ID 换了**（`be1c9b2b…` → `f7102c1a…`）——旧的成了 workspace 上的僵尸条目，正好给 93/94 当靶子。已推 0 是对的：新库是空的，backfill 没有东西可发。

**判据 92**：桌面用真 CLI 从副本库导出的「测试收藏夹」(4 首) → 手机导入 → **共 4 首、复用 4 首、新建 0**（按 `(bilibili, bvid:cid)` 全命中，suspects 区不出现——key 命中优先级最高，不是 suspect）→ 歌单列表出现第三个「测试收藏夹」（**导入永远新建，同名不合并**）→ 点第一首 **同道殊途**（无文件）→ ensure-file 取回 → **0:05/7:50 正在播放，歌词也下来了**。顺带复现已知陷阱：**播放中 `uiautomator dump` 会失败**，只能截图。

**判据 102 + 一条新发现**：「导出曲库」产出 **`all.lark-playlist.json`**（与 daemon 逐字节一致的命名），与桌面同一时刻导出的 `all` **18 首逐字段比对**——`format` / `version` / `playlist.name` / 每首的 name·artist·source_url·source_provider·source_key·lyrics_offset **全部相同**，**只有一首的 `duration` 不同**：`470.742` vs `470.741338`，而那正是**本次会话里手机唯一下载过的那首**。
> 🔴 **手机下载完一首歌会用 MMR 测得的时长覆盖 `duration`**（毫秒粒度），与桌面 ffprobe 的值差 **0.00066s**。N0b 早量过「MMR 与 ffprobe 逐毫秒一致」，但**没人记过这个差会变成一条同步更新**——每重下一首歌，就把那首的 duration 推给 workspace，桌面跟着变。**无害**（<1ms，不进任何判断），**按现状接受，只记录**。

**判据 93**：两条确认文案在设备上**确实不同**——撤销别人是「撤销「vivo V2408A」？／那台设备会停止同步…**这台手机不受影响**／按钮「撤销」」，撤销自己是「**撤销这台手机？**／这台手机会被踢下线：同步停在下一轮，然后要求重新登录。**曲库和已经下载的文件都不会动**／按钮「**撤销本机**」」。

**判据 94**：撤销旧手机设备后列表自动刷新，那一行变成 `… · 已撤销`，**并且它的撤销按钮消失了**（5 台设备只剩 4 个按钮 ⇒ `canRevoke` 在真数据上成立）。撤销本机之后：
- 紧跟着的列表刷新**被服务器拒绝**，屏幕上如实写着 **`device list was refused: token is invalid or revoked`**（所以本机那一行没来得及变成「已撤销」——那次刷新正是被拒的那一次；**如实显示而不是吞掉**）；
- 点「立即同步」跑一轮 ⇒ 徽章 **需要登录** + **「登录已失效（服务器拒绝了保存的凭证），需要重新登录。」** —— 与普通登出的 `missing_session` 文案不同，**不是静默失败**，正是判据要的形状。

**会话收尾**：设备上的临时 dump 已删、Gradle daemon 已停、无 `adb reverse` 残留。⚠️ **手机现在是登出状态**（判据 94 的代价），要用需重新登录；**LLM 的 API Key 也随卸载没了**，需要用户补填。

**N6 至此只剩 N6e**（文档大整理 + 发版）——但按 2026-08-26 的范围修订，中间还插一个 **N7 分账号曲库**。

---

## §6 每账号独立工作区

> 🔑 **2026-08-26 用户改主意：不延后了，插在「本批真机会话之后、发版之前」。** 本节其余内容是 2026-08-25 那次讨论的结论，原样保留——**四个难点与那条起点建议一个字都没变，只是时间轴换了**。
>
> **这个顺序比原来担心的「风险叠加」好**：我当时反对的是「换库代码与卸载重装挤进同一个没验过的版本」。用户的排法把两件事分开了——**先用一次真机会话证明 D16 与全新安装那条路是通的**（判据 96），拿到一个已知良好的干净安装，**再**动多工作区，它自己另有一次验证。仍然成立的代价只有一条：**第一个签名 APK 会带着一批刚写完的换库代码**，所以那一批的验证不能省。
>
> **起点不变**：先做 **`local_metadata` 分层**（设备级 / 曲库级）。它自己就是一批，对现在的单库版本零影响，而且不做它的话，切个账号会把缓存上限、蓝牙歌词开关、明文开关和模型一起切掉——LLM 更是会被劈成两半（key 在 SecureStore 属设备，url/model 在库里属曲库）。
>
> **批次编号**：这一批排在 N6d 与 N6e 之间，记作 **N7**（它不是 N6 的收尾，是一个自己的里程碑），开工前照规矩单出子计划。

### 6.1 原讨论（2026-08-25）

用户提出把 lark 做成 owl 的模型——**每个账号一个独立工作区**，登录时可选是否合并本地，缓存吃紧时优先清非当前账号的文件。**讨论结论：值得做，但延后到 v1.1，不进 v1。**

**拆成三块，难度差很多**：

1. **多工作区隔离** —— 中等。每工作区一个 DB 文件（owl 的形状，查询一行不用改）；或单库加 `workspace_id` 列（**漏一个 filter = 两个账号的数据静默互串**）。
2. **共享曲库** —— 🔴 贵的那一半，**而且 owl 没有它**（笔记之间不共享媒体）。根因是两条已冻结的东西：实体 id 是本地 UUID，音频在 `songs/<id>/`（`portable/ports/paths.ts:54`）。同一个视频在两个工作区里是两个 id ⇒ 两个目录 ⇒ 下两遍。要共享就得改成按 `(provider, key)` 存 + 引用计数，牵动落盘协议 / manifest 与 orphan 恢复 / file-op 执行器与 journal / boot sweep / 缓存清理 / **schema v4 单向迁移**；`imported`（没有 source_key）还得另一套存储。**另有一条约束决定了 1 只能选哪条路**：今天「DB 变更与 file-op journal 同事务提交」是承重的，媒体库若落在两个 DB 之外就失去这个保证 ⇒ 要保住它只能走「单库 + workspace_id」，也就是风险更高的那条。
3. **缓存优先清非当前账号** —— 本身简单（`EvictionOptions` 多一个排序维度），但**完全依赖 1 与 2**。

**用户随后把范围收窄成「只隔离、不共享」**（重复下载可接受：没有文件的歌显示「需要下载」，不会静默下载，空间有上限兜着）。**那样便宜得多，但仍有四个难点**：

- 🔴 **切换账号 = 在同一进程里换一个已打开的数据库**。启动序列（N2 §2.2）是冻结的且**每进程只跑一次**（`bootOnce`），下游 `downloadRuntimeOnce` / `syncContextOnce` / 播放器会话 / 引擎 claim registry 全是一次性闸；而 expo-sqlite 的 Activity 重建坑正好长在这里。**建议 v1.1 直接用「切换后请重新打开应用」**。
- 🔴 **`local_metadata` 会跟着账号走**：`cache_limit_mb` · `llm_url/model/api_format` · `now_playing_mode` · `play_mode` · `naming_mode` · `sync_allow_insecure` · `last_playback` 全在库里。分库之后切个账号，缓存上限、蓝牙歌词开关、明文开关、模型全变了。LLM 更怪：**key 在 SecureStore（设备级，`settings/llm.ts:35`），url/model 在库里（库级）**，一份配置被劈成两半。**所以必须先把 `local_metadata` 分成设备级/曲库级两摊**——那是 7–8 个模块的改动，**而且它对现在的单库版本零影响，是最合适的起点**。
- 🔴 **缓存上限的口径要重定义**：`runEviction` 只看一个库，分库后「上限 2GB」变成每账号 2GB，手机总占用 N 倍。
- **D16 身份门是 per-library 的**，N 个库要 N 份——而这是全仓「写错会让曲库消失」的那段代码。

**延后的理由不是成本，是风险叠加**：它动的是 D16 与启动序列，而 N6d 本身已经是一次全量卸载重装；两件动库的事放进同一个版本，出问题分不清是哪一件。以后做要多一次迁移（`songs.db` + `songs/` 挪进 `libraries/<key>/`），代价很小。

**「登录时选是否合并」也一并延后**：到了 1.1，「不合并」自然就是「给这个账号新建一个空工作区」；现在用行级 `local_only` 标记做半成品，1.1 会把它整个删掉，而且它自己带渗漏（local-only 的歌加进已同步歌单，成员 op 指向别人没有的歌）。

**v1 的暂行方案 = 上面 §5.3③ 那四条**：把强制变成知情，把退路补全。

---
