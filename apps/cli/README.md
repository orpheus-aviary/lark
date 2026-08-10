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
lark skill export           # 导出给 agent 用的技能说明
```

`lark --help` 是完整列表；每条命令都支持 `--json`（`--json` 下 exit 0 等价于 stdout 恰好一条成功信封）。

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
