# @orpheus-aviary/lark-cli

lark（百灵音乐）的命令行客户端。管理曲库与歌单、下载歌曲与歌词、控制播放，也可以拉起桌面端。

```sh
npm i -g @orpheus-aviary/lark-cli
```

仅 macOS arm64，需要 Node 24 以上。

## 它怎么工作

`lark` 说话的对象是本机的 lark daemon（`127.0.0.1:47100`）。daemon 在跑就走 HTTP；没在跑时，只读命令可以加 `--direct` 直接打开曲库（daemon 在跑时**一律禁止** `--direct` 写，两个写入者会互相破坏）。

数据都在 `~/orpheus-aviary-nest/lark/`。

```sh
lark status                 # daemon 在不在，曲库在哪
lark daemon                 # 起一个 daemon
lark songs list             # 曲库
lark download <链接或关键词> # 下载
lark play <歌名>            # 播放（必要时拉起桌面端）
lark sync status            # 同步状态
lark skill export           # 导出给 agent 用的技能说明
```

`lark --help` 是完整列表；每条命令都支持 `--json`（`--json` 下 exit 0 等价于 stdout 恰好一条成功信封）。

## 多设备同步（0.2 起）

歌曲与歌单的元数据、歌词可以经 [skybridge](https://github.com/orpheus-aviary) 在多台设备之间同步；
mp3 本体不同步，每台设备凭来源信息按需下载。

```sh
lark sync config-show       # 连的是哪台服务器、绑没绑（不需要 daemon，也不需要曲库）
lark sync login --server https://… --email you@example.com
lark sync run               # 立刻跑一轮（平时由 daemon 自己定时跑）
lark sync status            # 待推送、冲突、卡住的文件操作、重复的曲目
lark sync file-ops          # 卡住的文件操作：重试或放弃
lark sync unbind            # 解绑本机（要先 stop-daemon；会说明丢弃多少未推送变更）
```

密码只从静音输入或 `--password-stdin` 读，没有 `--password` 参数。服务器必须是 HTTPS；
明文 HTTP 要同时给 `--allow-insecure-http` 和全局 `--yes`。

> ⚠️ **0.2 会把曲库升到 schema v2，且不可逆**：升级后 0.1.x 将拒绝打开它。迁移只发生在 daemon
> 启动时，所以 v1 曲库在 0.2 下即使只读 `--direct` 也会先报 `MIGRATION_PENDING`——起一次
> `lark daemon` 即可。想留退路请先备份 `~/orpheus-aviary-nest/lark/`。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 操作失败 |
| 2 | 命令写错了 |
| 3 | 环境不满足（没配 LLM、缺 ffmpeg、原生模块 ABI 不匹配……） |
| 4 | 没人在听（daemon 没跑、GUI 不在线） |
| 5 | 有东西在，但拒绝（曲库被占用、名字有歧义、需要迁移……） |
| 130 | 被中断 |

## 转码需要 ffmpeg

下载与导入都要 ffmpeg / ffprobe。桌面端的 `bundled` 安装包自带一份；单装 CLI 的话用 `brew install ffmpeg`。缺了会明确报 `MEDIA_TOOLS_UNAVAILABLE`（exit 3），不会把它说成某一首歌的问题。

## 许可

MIT。仓库：https://github.com/orpheus-aviary/lark
