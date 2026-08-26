# N7 每账号独立工作区（两端）

- **日期**：2026-08-26（**v2**，按用户当天的四条决定重写；v1 的 §3 决策 a–g 已全部关闭，d 被 owl 的做法取代）
- **执行顺序**：N6a–N6d ✅（含真机会话）→ **N7（本批）** → N6e 文档大整理 → 发版
- **来历**：用户 2026-08-25 提出 → 当天定为 v1.1 → **2026-08-26 提前到发版之前**，并在看过 owl 的实现后定下形状
- **前置**：N6 真机会话完成——手机是一个全新安装、签名正确、D16 走过一遍的干净状态
- **基线**：`just check` exit 0 · `just test` **3107 passed**（2026-08-26）
- **冻结设备**：vivo V2408A，行为判据一律 release 构建
- **判据编号**：**103 起**（N6 用到 102）

**一句话的边界**：今天「一台设备 = 一个曲库 = 一个账号」，绑定之后不可改绑。**N7 把三者解开**：一台设备可以有多个曲库，每个各自绑一个账号（或谁都不绑），互不可见、互不合并。**两端都做。**

---

## §0 用户已定的四条（2026-08-26）

1. **桌面也一起做** —— 多工作区不是手机专属；桌面的设备列表过滤也一并改。
2. **手机不做迁移**（读法 B）：旧数据不管，反正能重装重拉（N6 会话刚证明过，五分钟）。**只有桌面做一次简单迁移**——它那个 nest 是真实曲库。
3. **切换要确认框**：「切换账号需要重启应用，同意 / 取消」。
4. **统一缓存上限口径**：设置页显示**当前工作区 + 其他工作区**各自占用；清理**优先删其他工作区里没固定的**，再动当前工作区。

> 🔴 **第五条，用户同一条消息里提醒的**：**设置页的中文说明要跟着改**。N6c 写的那三段里有一句现在会变成假话——「一个曲库只能绑一个账号，绑定之后不能改绑；要换账号只能清除应用数据重来」。绑定不匹配的报错文案（N6c 改过的那句「只能清除应用数据重新开始」）同理。**文案是本批的交付物之一，不是收尾**（判据 118）。

---

## §1 owl 已经把这件事做过一遍——照抄它的形状

`../owl/packages/core/src/profile/` 与 `skybridge/switch-lock.ts`。六条事实，逐条带出处：

**① profile id = `sha256(serverId + "\n" + userId)` 取前 32 hex**（`profile/id.ts:66`）。确定性哈希而不是随机 id ⇒ **同一个账号永远落回同一份本地拷贝**，登出再登录不会长出第二个。

**② 锚是 `server_id`，不是 URL**（`id.ts` 抬头 D11）：*"The server's url is not part of the id, so moving the deployment / changing the url keeps the same profile."* —— 与 lark 的 TLS 那笔账记的「换 URL 不打断绑定」同一条。**32 hex 的宽度一旦有 profile 落盘就冻结**（改它会把已有目录变孤儿）。

**③ 保留 id `local`** —— 从没登录过 / 离线的那个工作区（`profile/resolver.ts:23`）。

**④ 零迁移是明写的设计**（`config/paths.ts:53`）：*"Local profile database = `owl/owl.db` in place … so pure-local users need zero migration. Account sync never writes here."* 账号库在 `profiles/<32hex>/owl.db`，老库**原地不动**当 `local`——连已经绑过账号的老库也是（`local-inspect.ts` 的 `hasSyncTraces` 正是为这种库准备的警告）。

**⑤ 并入 = 整库 COPY，绝不 move**（`local-inspect.ts:8`）：*"a whole-db claim, never a move — account sync must never write the local db."*

**⑥ 桌面多一整块：切换锁**（`skybridge/switch-lock.ts`）。GUI main 在切换临界区持有锁文件，CLI direct 开库前读它、发现切换在飞就拒绝。三条性质：**原子写**（temp+rename，读者永不见撕裂）· **owner nonce**（只能释放自己写的那把）· **pid 存活 + 30s TTL**（崩溃的持有者 pid 立刻消失，pid 复用被 TTL 兜住）。**这是多进程才需要的，手机单进程不需要。**

---

## §2 lark 的落法

### 2.1 布局

```
~/orpheus-aviary-nest/lark/              桌面
├── lark_config.toml                     设备级（已有）
├── workspaces.toml                      ← 新：active + 索引（非机密）
├── songs.db / songs/                    ← `local`：原地，零迁移
└── libraries/<32hex>/                   ← 账号工作区
    ├── songs.db
    ├── songs/<song id>/{song.m4a, lyrics.lrc}
    └── skybridge.toml                   ← 凭证跟着工作区走（0600）

<Paths.document>/lark/                   手机
├── device.json                          ← 新：设备级设置（N7a）
├── workspaces.json                      ← 新：active + 索引
├── songs.db / songs/                    ← `local`：原地
└── libraries/<32hex>/{songs.db, songs/}
```

**schema 不动**：每个库仍是 schema v3，**没有 v4，没有迁移链改动**。工作区是**库外面**的一层，这是本批最大的去风险点。

**凭证**：桌面从 nest 根的 `skybridge.toml` 变成**每个工作区一份**；手机在 SecureStore 里**按 profile id 加前缀**（`CredentialStore` 端口内部的事，接口不变）。

### 2.2 身份与解析（两端共用）

- `computeWorkspaceId(serverId, userId)` —— 照抄 owl 的定义，进 `@lark/shared`（两端 + 将来 CLI 都要用，且它是纯函数）。
- `WORKSPACE_LOCAL = 'local'` 保留字。
- **单一收口**：`resolveActiveWorkspace()` 决定「这个进程打开哪个库」，daemon boot / GUI 启动预检 / CLI direct / 手机 boot 全部走它，**没有任何入口能绕回旧路径**（owl 的 `resolver.ts` 抬头写的就是这条）。

### 2.3 桌面的「简单迁移」（用户决定的唯一一次迁移）

桌面那个 nest 的库**已经绑定**了账号。首次启动新版本时：

1. 读 `sync_binding`（`server_id` / `user_id` 都在里面）→ 算出 id；
2. 把 `songs.db` + `songs/` + `skybridge.toml` **移进** `libraries/<id>/`；
3. 写 `workspaces.toml`：`active = <id>`，索引里一条。

**没有绑定的库不动**——它就是 `local`。**移动是同一文件系统内的 rename**，加一个「搬到一半」的恢复点（判据 108）。

### 2.4 手机：不迁移

用户决定：**旧数据不管**。升级后打开的是 `local`（原地那个库），**如果它是绑定过的，就带着绑定继续用**——与 owl 的「带同步痕迹的 local」同形，**并入别的账号时给同一条警告**（判据 116）。不写任何搬家代码。

### 2.5 切换 = 重启，且要一次确认

写下 active 之后**不热切**（§3 难点①）。桌面与手机同一句话：**「切换账号需要重启应用。同意 / 取消」**，同意才写。桌面同意后由 GUI 自己重启（daemon 随之换库，临界区由 switch-lock 守）；手机提示用户重开应用。

### 2.6 缓存：一个上限，跨工作区清理

- 上限仍是**设备级**一个数（桌面 `config.storage.cache_limit_mb`，手机 `device.json`）。
- 设置页显示两行：**当前工作区占用** / **其他工作区占用**。
- 清理顺序：**其他工作区里没固定的 → 当前工作区里没固定的**，各自内部仍按 `last_accessed_at`。
- 🔴 **可行性已核过**：清理**只删文件、不写库**（`has_file` 是探盘得来的），所以别的工作区**只读打开**列行就够——owl 的 `local-inspect` 就是这个模式（raw read-only 连接，不触发迁移副作用）。**探活 fail-closed 与 imported 永不清理两条不变量原样适用于每一个工作区**（R1/R26）。

---

## §3 三个难点（v1 §1 的原文，仍然成立）

**① 切换 = 进程内换一个已打开的数据库。** 启动序列（N2 §2.2）冻结且**每进程只跑一次**（`bootOnce`）；`downloadRuntimeOnce` / `syncContextOnce` / 播放器会话 / 引擎 claim registry 全是一次性闸；expo-sqlite 的 Activity 重建坑正好长在这里。**⇒ 切换即重启，本批不碰热切。**

**② `local_metadata` 里混着设备级的东西**（手机独有的问题）。桌面早就是分层的（`portable/cache-limit.ts:10` 白纸黑字：桌面把 `storage.cache_limit_mb` 放在 `lark_config.toml`——「一个手机没有的文件」）；手机把设备级也塞进了库里，**因为那是当时唯一能写的地方**。归属表见 §4。

**③ D16 身份门是 per-library 的**，N 个库要 N 份，而**这是全仓「写错会让用户曲库消失」的那段代码**。

---

## §4 归属表：哪些跟着设备，哪些跟着工作区

| key | 归属 | 桌面今天在哪 |
|---|---|---|
| `cache_limit_mb` | **设备** | `config.storage.cache_limit_mb` ✅已分层 |
| `llm_url` / `llm_model` / `llm_api_format` | **设备** | `config.llm` ✅（key 在 SecureStore / config，本就设备级）|
| `now_playing_mode`（蓝牙歌词）| **设备** | 无（桌面不做）|
| `play_mode` | **设备** | GUI 视图态 |
| `naming_mode` | **设备** | GUI 弹框记忆 |
| `sync_allow_insecure` | **设备** | 无（桌面无此开关）|
| `device_uuid` | **工作区** | 同 |
| `skybridge_device_id` / `skybridge_token` | **工作区** | 同 |
| `sync_backfill_done/target_generation` | **工作区** | 同 |
| `audio_migration_pending` | **工作区** | 同 |
| `last_playback` | **工作区** | 无 |

✅ **已核实（2026-08-26）**：`readCacheLimitMb` / `readLlmConfig` / `readPlayMode` / `readNamingMode` / `readNowPlayingMode` / `readSyncAllowInsecure` / `readLastPlayback` 在 `packages/daemon`、`packages/gui`、`apps/cli` 里的调用处**各为 0** —— 它们住在 portable，**只有手机在读**。⇒ **N7a 改它们对桌面零影响。**

---

## §5 分批与判据

### N7a — 手机的设备级设置层（桌面零影响）

`<Paths.document>/lark/device.json`，原子替换写入（N2 决策 a 那条路）。§4 表里六个设备级 key 从 `local_metadata` 搬过去，读取器入参从 `SqliteLike` 换成 `DeviceSettingsPort`。

| # | 判据 | 归属 |
|---|---|---|
| **103** | `git diff` 对 `packages/{gui,daemon,cli}` 零改动；`packages/core` 只有那六个模块的签名变化 | 电脑 |
| **104** | 已有的六个 key 被搬进 `device.json` 并从 `local_metadata` 删掉，值一个不差；再次启动不重复搬 | 电脑 |
| **105** | `device.json` 缺失 / 空 / 坏 JSON ⇒ 回默认值且不抛，与今天缺行时逐条相同 | 电脑 |

### N7b — 身份与布局（两端共用的纯函数）

`computeWorkspaceId` + `WORKSPACE_LOCAL` 进 `@lark/shared`；两端 paths 长出 `libraries/<id>/`；索引文件的读写（原子）。

| # | 判据 | 归属 |
|---|---|---|
| **106** | `computeWorkspaceId` 与 owl 的定义**逐字节同结果**（同一对 (serverId,userId) 在两个仓算出同一个 32 hex，夹具比对）；非法输入拒绝 | 电脑 |
| **107** | 索引文件缺失 / 坏 ⇒ 回落到「只有 local，active=local」，**绝不新建或删除任何库** | 电脑 |

### N7c — 桌面接线

resolver 单一收口（daemon boot / GUI 预检 / CLI direct 三方）+ **switch-lock**（照 owl 的三条性质）+ §2.3 的简单迁移 + 设备列表过滤。

| # | 判据 | 归属 |
|---|---|---|
| **108** | **迁移崩溃安全**：已绑定的 nest 库 → `libraries/<id>/`，在每个断点 kill，重启都收敛到「搬完」或「没开始」，**永不半途**；没绑定的库不动 | 电脑 |
| **109** | 三个入口**没有一个**能绕过 resolver 打开旧路径（rg 守卫 + 单测） | 电脑 |
| **110** | switch-lock：切换在飞时 CLI direct **拒绝**并说明；持有者被 kill 后锁在 TTL 内失效；nonce 不对的释放请求无效 | 电脑 |
| **111** | 桌面设备列表**只显示 lark**，被滤掉的计数并说明（与手机同一份判定函数） | 电脑 |

### N7d — 手机接线

多库打开（不迁移）+ D16 per-library。

| # | 判据 | 归属 |
|---|---|---|
| **112** | N2 判据 16a 四组**逐库复跑**：合规恢复四类均未恢复 · 强制半恢复 fail-closed · install_id 不同 fail-closed · 收敛崩溃点；**每库一份 intent，清理只清那一个库** | 电脑 + 真机一次 |
| **113** | 一个库被 fail-closed 清掉时，**另一个库毫发无伤** | 电脑 |
| **114** | 两个工作区并存时，A 的曲目/歌单/下载/`sync_changes` 在 B 里**一条都看不见** | 电脑 |

### N7e — 切换、登录二选一、**文案**

切换 UI（两端）+ 确认框 + 登录时「并入当前曲库 / 给这个账号新建工作区」+ **§0 第五条的文案更新**。

| # | 判据 | 归属 |
|---|---|---|
| **115** | 切换：确认框说明要重启；同意才写 active；**不重启则当前库继续正常工作**（不半切）；写的是索引里的一行，写完即使立刻 kill 也算切换成功 | 电脑 + 真机 |
| **116** | 「新建工作区」：原工作区曲目**一条都没被推上去**（`sync_changes` 计数不变）；「并入」：与今天逐字节相同（全量 backfill + rebase）。**并入一个带同步痕迹的库时给出 owl 那条警告** | 电脑 + 真机 |
| **117** | 并入是**整库 COPY 不是 move**：并入之后原工作区仍然完整可用 | 电脑 |
| **118** | 🔴 **文案已更新且不再说假话**：登录表单三段、绑定不匹配的报错、切换确认框——全仓 grep 不到「只能清除应用数据重来 / 重新开始」这类现在为假的话 | 电脑 + 人眼 |

### N7f — 缓存统一口径

| # | 判据 | 归属 |
|---|---|---|
| **119** | 设置页分别显示**当前工作区 / 其他工作区**占用，两者之和 = 磁盘上 lark 音频总占用 | 电脑 + 真机 |
| **120** | 超限时**先清其他工作区里没固定的**，再清当前工作区；**固定的、imported 的、探活不通的一律不动**（R1/R26 逐工作区成立） | 电脑 |
| **121** | 跨工作区清理**只删文件、不写别的库**（断言：清理前后别的库的 `songs.db` 字节不变） | 电脑 |

### N7g — 验收与会话

| # | 判据 | 归属 |
|---|---|---|
| **122** | 🔴 **桌面 accept 全系列**：`accept-gui`(15) · `accept-m5`(22) · `accept-cli`(27) · `accept-sync`(34) · `accept-pack`(28)。本批大改桌面，这一跑**不可省**（也顺带兑现 N1 判据 22 的旧账）| 电脑 |
| **123** | 真机一次会话：装新版 → 现有库当 local → 新建一个绑另一个账号的工作区 → 切换（重启）→ 互不可见 → **设置项不跟着账号跑**（缓存上限 / 模型 / 蓝牙歌词开关切换后不变）| 真机 |

---

## §6 不做（本批）

- 🔴 **共享曲库**（同一首歌两个工作区各下一份）—— 贵的那一半，代价几乎全在它身上。**重复下载可接受**：没有文件的歌显示「需要下载」、不会静默下载，空间有统一上限兜着（用户 2026-08-26 定）。
- **热切换**（不重启换库）—— §3①。
- **删除一个工作区** —— 危险动作，值得自己的确认流；「清除应用数据」那条路一直在。
- **手机的任何迁移** —— 用户决定（§2.4）。
- schema 变更 —— 本批不碰（§2.1）。

## §7 参考

- owl：`../owl/packages/core/src/profile/{id,resolver,local-inspect}.ts` · `skybridge/switch-lock.ts` · `config/paths.ts`
- 上一批的完整讨论：`docs/plans/2026-08-25-phase-b-mobile-n6.md` §6
- 手机 nest 布局：`apps/mobile/src/ports/paths.ts`；冻结的启动序列：`apps/mobile/src/boot/sequence.ts`
- D16：`docs/plans/2026-08-19-phase-b-mobile-n2.md`
- 六个设备级读取器：`packages/core/src/portable/{cache-limit,llm-config,play-mode,naming-mode,now-playing-mode,sync-insecure}.ts`
- 桌面两层：`packages/core/src/config/index.ts`（设备级）· `portable/schema.ts` 的 `local_metadata`（工作区级）
- 要改的文案：`apps/mobile/src/ui/sync-section.tsx`（三段 + 绑定不匹配分支）

---

## §8 实施修订（N7a–N7f 完成后回填，2026-08-26）

七条与 v2 计划不同或计划没写的形状，按被发现的顺序。**逐批的经过在 `PROCESS.md` 的 N7 段。**

1. **`computeWorkspaceId` 落在 `@lark/core/portable`，不是 `@lark/shared`**（§2.2 写的是 shared）。两条理由：它不纯（要 sha256，而 sha256 在 `portable/runtime/digest.ts`），而且 **workspace id 从不上线**——server 完全不知道 workspace 这回事，`shared` 是线协议包。CLI 也不需要它。
2. **磁盘是「有哪些工作区」的事实，索引文件不是**。`libraries/<id>/songs.db` 存在 = 工作区存在；`workspaces.toml` / `workspaces.json` 只存唯一推不出来的那件事（`active`）加两项装饰。⇒ 一个坏掉的索引最多值一个名字和一个起点。**因此 lark 的门比 owl 少一道**（owl 查三样是因为它的 profile db 与凭证在两个文件里；lark 把凭证放进工作区内部）。
3. 🔴 **登录的安装必须跑在「目标工作区」上，不是当前库上**——判据 116（新建时原库一条 `sync_changes` 都不多）与判据 117（并入后原库仍完整可用）**共同逼出**的唯一顺序：远端登录 → 算 id → 备好工作区 → **在目标上** bind/backfill → 翻 active → 重启。seam 是 core 登录序列里新增的 `resolveTarget`，位置在远端登录之后、第一次本地写之前。
4. 🔴 **`switchWorkspace` 只写一行，绝不动 resolver 缓存**。缓存就是「这个进程打开了哪个库」，每条路径都挂在它上面；动它会让 daemon 一边服务旧库、一边把歌和凭证写进新库。**判据 115 的「不半切」是「只做一件事」的直接结果。** 由此长出 **`serving`（这个进程打开的） ≠ `active`（下次启动会打开的）**，两者从切换到重启为止都不一样。
5. 🔴 **门要求目标库的 `songs.db` 已在盘上**，否则回落 `local` ⇒ **「先备库、再翻 active」是唯一存在的顺序**（顺序反了会得到「看起来切成功了、然后是个空库」）。
6. 🔴 **两条手机独有的数据安全前提**：① SecureStore 的键按工作区分，**但 `local` 必须保持不加前缀**——否则升级上来的手机找不到自己的身份 → converge → 清掉没人碰过的库的 outbox；② **建工作区时必须先给它认领 D16 身份**（intent → 库 → commit，全部在 move 到位之前），否则第一次进去会被当成恢复的备份而 converge，把刚写的绑定和凭证一起清掉。
7. 🔴 **WAL sidecar 不能跟着搬**（桌面迁移）。`songs.db-wal` 没法和主文件一起原子重命名，而**任何只读连接都会新建一对且关闭时不删** ⇒「崩在半路 + 有人看了一眼」会让拒绝覆盖的 mover 永远收敛不了。修法是搬之前 `wal_checkpoint(TRUNCATE)`，什么都不剩。

**并入的范围（用户 2026-08-26 定）**：**数据库 + 音频一起复制**。§6 那句「重复下载可接受」本来指向更便宜的「只复制数据库」，但那样一并入本机所有歌都变成「需要下载」——一次账号操作换来整库重下。磁盘翻倍由 §2.6 的统一上限兜着。

**新增的三条守卫**（都进 `just check`，都反测过）：`check-workspace-chokepoint.sh` 的三条规则 —— 只有 `paths.ts` 能拼 `'songs.db'` · 手机上只有 `ports/paths.ts` 能碰 `nestDirectory()` · 全仓禁「清除应用数据重来 / 不能改绑 / 只能绑一个账号」这类现在为假的措辞（判据 118）。

---

## §9 N7g 的两半

### 9.1 判据 122 —— 桌面 accept 全系列（AI 跑）

126 条，五套。**本批大改桌面，这一跑不可省**，同时兑现 N1 判据 22 的旧账（桌面自 v0.3.0 起已被改了六轮：N1 重构 · N4a 提取 · N4g `decideNext` · N4i-1 URL 归一化 · N5d-2 流控制器 · **N7 这一整批**）。

| 套件 | 条数 | 前置 |
|---|---|---|
| `just accept-gui` | 15 | 无（用 nest 副本 + CDP） |
| `just accept-cli` | 27 | 无（驱动真实二进制） |
| `just accept-m5` | 22 | **真 bilibili 网络** |
| `just accept-sync` | 34 | **真 skybridge server** + 两台 daemon + 真 GUI |
| `just accept-pack <mode> <dmg> <tgz>` | 28 | 先 `just package` + `just pack-cli` |

### 9.2 判据 123 + 112/115/116/119 的真机半边（用户手操，一次会话）

装包：`just mobile-android-release`（adb 直接装到冻结设备 vivo V2408A）。

**⚠️ 前置状态**：手机现在是**登出**的，且 **LLM API Key 随卸载丢失**（N6 会话之后）。这次会话要用两个 skybridge 账号——A（已有的）与 B（新建一个）。

**看什么，按顺序**：

1. **升级不动旧数据**（零迁移）：装上新版直接打开——曲目、歌单、设置全在，**没有任何「迁移中」的提示**。设置页「曲库」区应该只有一行「本机曲库（正在使用）」。
2. **判据 116/117 · 并入**：用账号 A 登录，选**并入当前曲库**。登录成功后应当明确告诉你「这个账号的曲库已经建好了——完全退出 lark 再打开一次才会切过去；在那之前不会开始同步」。**此时曲库还是原来那个**（歌一首没少、也没多）。
3. **判据 115 · 切换 = 重启**：完全退出 lark（从最近任务里划掉），再打开。现在应该在 A 的工作区里：曲目是刚才那份的**副本**，音频也在（能直接播，不是「需要下载」）。设置页「曲库」区两行，A 那行标「正在使用」。
4. **判据 114 · 互不可见**：在 A 里加一首歌（或建一个歌单）。然后设置页 → 曲库 → 切换到「本机曲库」→ 确认框应该说清「只是改一行记录，现在打开的曲库不会受影响」→ 同意 → 完全退出再打开。**本机曲库里看不到刚才在 A 里加的那首歌**，且本机曲库自己的内容一条不少。
5. **判据 116 · 新建**：在本机曲库里，用账号 **B** 登录，选**新建空曲库**。重启后进 B：**应该是空的**；再切回本机曲库，**它的曲目一条没少、也没有被推上去过**。
6. **判据 123 · 设置项不跟着账号跑**：在任意一个工作区里改三样——缓存上限、LLM 模型配置、蓝牙歌词开关——然后切换到另一个工作区并重启。**三样都应该原样保留**（它们在 `device.json` 里，不属于任何曲库）。
7. **判据 119 · 缓存两行**：设置页缓存区应该同时显示「当前曲库」与「其他曲库」两行占用，后者带「清理时先动这些」。粗看两者之和与手机上 lark 占用的量级相符即可（精确对账不做）。
8. **判据 112 的真机半边 · D16 逐库**：在 A 的工作区里 force-stop 再打开一次，**启动判定应当是 `normal`**（设置页最下面有「启动判定」一行）。切到本机曲库重启，同样应当是 `normal`——**两个库各有各的身份，谁都不该 converge**。

**任何一步出现「空库」「要求重新登录」「启动判定是 converge」都立刻停下来说一声**——那三个是这一批最贵的失败模式。
