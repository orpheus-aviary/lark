# 离开一个账号之后，本地曲库会怎么样

> 2026-08-27 写下。起因是排查 owl 那边「设备被撤销之后会发生什么」时，同样的问题落到
> lark 身上：**退出账号 / 被撤销 / unbind 之后，那个账号的本地曲库副本会不会没**。
>
> 答案本来散在 `coordinator/logout.ts`、`sync/unbind.ts`、`sync/file-ops.ts` 三处的注释里，
> 各自都只说了自己那一段。这里合成一处，每条都带锚点，改了代码请回来改这里。
>
> 约束速查在 `INVARIANTS.md` §4（同步）与 §5（每账号独立工作区）。

## 一句话

**三种「离开」，没有一种会删你的歌。** 真正会动到音频文件的只有一件事 —— **别的设备删了这首歌**，
而且那时 lark 也只删「能重新下回来」的那些。

---

## 三种离开，分别发生什么

### 1. 这台设备在别处被撤销

服务端（skybridge `routes/devices.ts`）在一个事务里做两件事：把 `devices.revoked_at` 打上，
并撤销**绑到这台设备**的 access + refresh token。同账号的其他设备不受影响。

本地这边：

- **`libraries/<32hex>/` 一个字节不动** —— 撤销是服务端动作，不会回头删任何本地文件。
- 同步开始吃 401 停摆。⚠️ **已经开着的 SSE 不会被踢**：鉴权只发生在建连时的 preHandler，
  撤销不主动关闭已建立的流。它还会继续收到「有变化」的事件，但拉不动数据（pull 401），
  所以只是空响。
- **下次登录自动恢复**：`portable/coordinator/login.ts` 的 `resolveDevice` 会先列一次设备，
  发现存的那台「已撤销」或「服务器根本不认识」，就**注册新的一台**继续跑。
  workspace / binding / cursor 都存在库里、**不随设备走**，所以是接着同步，不是从零重拉。

代价两条，都是有意接受的：账号里多一行 device（**永远删不掉** —— `changes.device_id` 是
`ON DELETE RESTRICT`），以及 LWW 三元组的第三元素换了个值（只影响「同毫秒 + 同 counter」
的极端 tie-break，旧行保留旧 id，不影响正确性）。

> 复用旧 id 才是错的：撤销是用户刚关上的一扇门，登录时把同一个 id 递回去等于替他重新打开。

### 2. 退出登录（logout）

`portable/coordinator/logout.ts` 的顺序就是它的全部内容：停触发器 → 中止在飞的轮次 →
丢 session 和 `[auth]` → 最后才 best-effort 通知服务端（**唯一允许失败的一步**：用户要的是
本机这份凭证消失，服务器连不上不该让他还留在登录态）。

**故意保留的东西**：device registration、workspace、binding、cursor。所以重新登录是「接着上次」，
而不是「注册第二台设备 + 从零重拉整个工作区」。

曲库文件全在。

### 3. `lark sync unbind` —— 唯一「真正离开这个账号」的操作

`portable/sync/unbind.ts` 在一个事务里清掉：`sync_changes`、`sync_tombstones`、
`sync_dead_letters`、`sync_cursor`、binding，以及 `local_metadata` 里所有 `skybridge_*` 键；
凭证文件先移到一边，数据库那步成功后才真删（失败能原样放回）。

**它不碰 `songs` 表，也不删任何文件。** 歌、音频、歌词都在。

真正的代价是另一件事，而且容易低估：**它扔掉的是 outbox 和 tombstone**。还存在的东西下次登录
都能被全量 backfill 重新发布，但**以「缺席」表达的东西不能** —— 一条没推出去的删除、一次
membership 移除、一次 `clear_lyrics`。重新绑回同一个 workspace 时，服务端变更日志里那条旧的
`create` 还在，会把它们**复活**。

所以有未推送变更时它**默认拒绝执行**（`SyncPendingChangesError`），要 `--force` 才继续；
文件操作 journal 里还有卡住的活也会拒绝（`FileOpBusyError`）。

---

## 三条比「会不会删」更要紧的事实

### ① 账号曲库和本地曲库是两份独立的库

```
lark/
├── songs.db · songs/ · …          ← `local` 工作区，原地不动
└── libraries/<32hex>/             ← 每个账号一份，各有自己的 songs.db 和 songs/
    └── songs.db · songs/ · skybridge.toml · …
```

所以退出账号完全不影响 `local` 那份；反过来，**账号库的音频也不会因为退出而合并回 local**。
两边同一首歌各存一份是正常的（各自下载过），这是真实的磁盘成本。

### ② 音频根本不走同步

同步的只有元数据和内联歌词 —— `portable/sync/engine.ts` 里 `attachmentRefs` 恒为 `null`，
skybridge 的 attachment 通道还是 501。各设备凭 `source_key`（bilibili = `bvid:cid`）**按需自己下**。

推论：一个账号库在**新设备**上拉到的是「有这首歌」的记录，音频得本机下；
`file_origin='imported'` 的歌**在新设备上永远拿不到音频**，因为它从来只存在于导入它的那台机器上。

### ③ 唯一会动音频文件的是「别的设备删了这首歌」

`portable/sync/file-ops.ts` 的 `DeleteRemoteArg` 按 `audio_origin` 分三路：

| `audio_origin` | 处置 |
|---|---|
| `downloaded` | 删掉 —— 能从 `source_key` 重新下回来 |
| `imported` | **移到 `<工作区>/recovered-songs/` 隔离**，不删 |
| `null`（Go 版迁移来、没有来源） | 同上，按不可替代处理 —— 保守读法是唯一安全的读法 |

歌词的去留在**入队那次事务**里就决定好了（`lyrics_disposition`），不由执行器现场判断：
本机改过但还没推的歌词只存在于一个地方，执行器看文件大小和时间戳是分辨不出来的。

`recovered-songs/` 里堆了多少，`/sync/status` 一直数着 —— 免得它在备份时才变成一个惊喜。

---

## 备份怎么覆盖这些

`just backup-nest <目录>` 会把**每个**工作区都带上：活动的那个走 SQLite 在线备份（它是唯一可能
正有写者的），其余的连 WAL sidecar 一起按文件拷。

但 **skybridge 凭证在每一层都被排除** —— 它属于「做出这份凭证的那次安装」，不属于曲库。
所以从备份恢复出来的账号库是「有歌、没身份」的：按 `backup-nest.ts` 的说法，恢复之后要
`lark sync unbind` 再登录一次，会重新注册一台设备。
