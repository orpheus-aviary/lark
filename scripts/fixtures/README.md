# 音频夹具

`just fetch-ffmpeg` 与 `just accept-pack` 的闭环判据要的是**真容器**——被测的是我们即将分发的那两个二进制，所以输入不能是被测对象自己造的。这里的文件因此入库（tracked），二进制不入库。

单元测试原则上**不用**这里的文件：最小 LGPL profile 没有 lavfi，测试用 `@lark/core/testing` 的 `toneWav()`（纯 Node 写 44 字节头 + 正弦）现造 WAV，连 PCM 形态（`pcm_u8` / `pcm_s16le` / `pcm_s24le` / `pcm_s32le` / `pcm_f32le` / **`pcm_f64le`——profile 解不了，用来当被拒样本**）都是现造的。

**例外只有一种：输入必须是真容器，而本仓造不出来。** 两处：

- **0.3.0 的音频迁移**（`core/src/migration/`）——它的输入就是 mp3，而 T1b 删掉 LAME 之后本仓再没有任何东西能造一个。`@lark/core/testing` 的 `readToneMp3()` / `damageMp3()` 读下面的 `tone-1s.mp3` 并派生五种损坏形态（`unreadable` / `truncated` / `scrambled` / `junk` / `empty`）——损坏配方写在代码里，字节偏移量是绝对值，因为夹具本身按 sha256 冻结。
- **0.3.0 T4 的导入矩阵**（`core/src/download/import.ts`）——矩阵要覆盖 ALAC / ADTS / FLAC / Vorbis / Opus / 封面 / 多音轨 / 真视频，vendored profile 这六种**解得开、一个也编不出**。取用走 `@lark/core/testing` 的 `fixturePath(name)` / `readFixture(name)`，名字是联合类型，拼错是类型错误而不是几层之后的一句 ffprobe 抱怨。

| 文件 | 内容 | sha256 |
|---|---|---|
| `tone-1s.m4a` | 1s 440Hz AAC-in-MP4，5107 字节 | `8526ac2c15207c50cdc0a43c4d36a49fda043d22e8ff2153f62a32034c35b83f` |
| `tone-1s.mp3` | 1s 440Hz MP3（192kbps / 44.1kHz / 单声道），25748 字节 | `25d43ca27b7bf7e0d31202497ca6a88b34bb21c86175205867c59e9a9e44170e` |
| `tone-1s-alac.m4a` | 1s ALAC-in-MP4（MP4 族但无损 → 必须转码） | `2db7f8740335bbe9220747c54dba359e9b7cf4eabf8b9dc9633416b9b1097a53` |
| `tone-1s.aac` | 1s AAC 裸 ADTS 流（→ copy + `aac_adtstoasc`） | `312af03b88f6b648e9ffdbf890c2478a454126159fb162b493d84449f82ec03f` |
| `tone-1s.flac` | 1s FLAC | `983034766cc7bd7dd1c35fcd20f6c5c9ed45cef43642071c36291f8b97971a72` |
| `tone-1s.ogg` | 1s Vorbis-in-Ogg，**双声道**（原生 vorbis 编码器只支持 2 声道） | `7a96fa2473f26ddaa0ce123b3e1c7a99a6cee37c9c57a4ae6ca46a78fea7591f` |
| `tone-1s.opus` | 1s Opus-in-Ogg，48kHz（Opus 没有别的采样率） | `26193e6b3601cd95d38a8e97b37179393d010f9ab32353d3492f191852b67d21` |
| `tone-1s-cover.m4a` | 1s AAC + 封面图（`attached_pic`）——封面不是视频 | `ed27adfa458585ac685c59b7b5b892322a8e2af6b8c14c3a5d54464b1113f74a` |
| `tone-two-tracks.m4a` | 两条 AAC 音轨：第 0 条 1s、第 1 条 **2s**（长短不同才分得出取了哪条） | `09251f38d1d4f3d8dc24ea928147bbcc109465af2524eecbcd875cd9b70dee8a` |
| `tone-1s-video.mp4` | H.264 + AAC，**音频在 stream 1**（判据 60 的真文件证据） | `8df21fdb1b004378e2c22a0e615b4a3cde3a3e62168017ff9a437ac18c716847` |
| `cover-only.m4a` | 只有封面、没有音频流的 MP4，383 字节 | `e18c326a937d30207192c57f8b16fa72e13151f1e1afa9d6dcddd93dd00ede90` |

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

## 导入矩阵的九个（0.3.0 T4 生成）

**用的是系统 ffmpeg（Homebrew 8.1），不是 vendored 那份**——vendored profile 一个外部编码器都没有，这九个它全都只会读。同一台机器上重跑得到的字节未必相同（编码器版本一变就变），比对认上表的 sha256。

```fish
set FF /opt/homebrew/bin/ffmpeg
# /tmp/tone-1s.wav 与 /tmp/tone-2s.wav 由 toneWav(1) / toneWav(2) 写出（见上）
$FF -nostdin -v error -i /tmp/tone-1s.wav -c:a alac -f ipod -y tone-1s-alac.m4a
$FF -nostdin -v error -i /tmp/tone-1s.wav -c:a aac -b:a 192k -f adts -y tone-1s.aac
$FF -nostdin -v error -i /tmp/tone-1s.wav -c:a flac -y tone-1s.flac
$FF -nostdin -v error -i /tmp/tone-1s.wav -c:a vorbis -strict -2 -ac 2 -y tone-1s.ogg
$FF -nostdin -v error -i /tmp/tone-1s.wav -c:a libopus -y tone-1s.opus

$FF -nostdin -v error -f lavfi -i color=c=red:s=16x16:d=1 -frames:v 1 -y /tmp/cover.png
$FF -nostdin -v error -i /tmp/cover.png -i /tmp/tone-1s.wav -map 0:v -map 1:a \
  -c:v copy -disposition:v attached_pic -c:a aac -b:a 192k -f ipod -y tone-1s-cover.m4a
$FF -nostdin -v error -i /tmp/cover.png -map 0:v -c:v copy \
  -disposition:v attached_pic -f mp4 -y cover-only.m4a

$FF -nostdin -v error -i /tmp/tone-1s.wav -i /tmp/tone-2s.wav -map 0:a -map 1:a \
  -c:a aac -b:a 192k -f mp4 -y tone-two-tracks.m4a
$FF -nostdin -v error -f lavfi -i "testsrc=s=64x64:d=1:r=10" -i /tmp/tone-1s.wav \
  -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a aac -b:a 192k -f mp4 -y tone-1s-video.mp4
```

两条**没写成想当然那样**的：

- **`tone-1s-cover.m4a` 里封面排在音频后面**，即使 `-map` 先给的是封面——ipod muxer 自己会把音频挪到 stream 0。想要「音频不在 0 号」的真文件，只有 `tone-1s-video.mp4`（h264 在 0、AAC 在 1），它同时是判据 60 的证据：按序数 `-map 0:a:0` 与按全局 index `-map 0:1` 在这个文件上会选出不同的流。
- **`tone-two-tracks.m4a` 的容器时长是 2.0 秒**（最长那条轨），而被选中的第 0 条只有 1.0 秒。导入按选中轨的时长记 `duration`，这个夹具就是那条规则的样本。
