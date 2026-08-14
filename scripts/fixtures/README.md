# 音频夹具

`just fetch-ffmpeg` 与 `just accept-pack` 的闭环判据要的是**真容器**——被测的是我们即将分发的那两个二进制，所以输入不能是被测对象自己造的。这里的文件因此入库（tracked），二进制不入库。

单元测试**不用**这里的文件：最小 LGPL profile 没有 lavfi，测试用 `@lark/core/testing` 的 `toneWav()`（纯 Node 写 44 字节头 + 正弦）现造 WAV。

| 文件 | 内容 | sha256 |
|---|---|---|
| `tone-1s.m4a` | 1s 440Hz AAC-in-MP4，5107 字节 | `8526ac2c15207c50cdc0a43c4d36a49fda043d22e8ff2153f62a32034c35b83f` |
| `tone-1s.mp3` | 1s 440Hz MP3（192kbps / 44.1kHz / 单声道），25748 字节 | `25d43ca27b7bf7e0d31202497ca6a88b34bb21c86175205867c59e9a9e44170e` |

**入库的字节是权威**。下面的配方记的是来历，不是每次构建都要跑的一步。

## `tone-1s.mp3`（0.3.0 T0a 生成）

它代表「lark 0.2.x 写进 `songs/<id>/song.mp3` 的那种文件」，所以 ffmpeg 参数与当时的 `ensureMp3()` 逐字一致（192k / 44.1kHz / `-f mp3`）——迁移链的闭环判据拿它当输入。

```fish
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
const { toneWav } = await import('./packages/core/dist/testing/index.js');
writeFileSync('/tmp/tone-1s.wav', toneWav(1));
"
./vendor/ffmpeg/ffmpeg -nostdin -v error -i /tmp/tone-1s.wav \
  -vn -acodec libmp3lame -ab 192k -ar 44100 -f mp3 -y scripts/fixtures/tone-1s.mp3
```

同一份 vendored 构建跑两次字节相同（实测）。

⚠️ **配方已经跑不动了**：T1b 删掉了 `--enable-libmp3lame`，本仓再没有任何能产 mp3 的编码器——上面那条命令是**来历记录**，不是可复跑的步骤。这正是它必须在 T0a（删 LAME 之前）生成并入库的理由。

## `tone-1s.m4a`

随 `5d9dddc`（M7 T0 自建 ffmpeg）入库，当时的配方没有记录。T0a 给 vendored 构建加上 `--enable-encoder=aac` + `--enable-muxer=ipod` 之后，它重新变得可复现：

```fish
./vendor/ffmpeg/ffmpeg -nostdin -v error -i /tmp/tone-1s.wav \
  -vn -c:a aac -b:a 192k -f ipod -y /tmp/tone-1s.m4a
```

（字节未必与库里那份相同——编码器版本一变就变。**要比对就比对上表的 sha256**，别指望重生成。）
