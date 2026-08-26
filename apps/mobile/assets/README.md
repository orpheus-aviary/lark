# apps/mobile/assets

两张图，都是**已提交的产物**而不是构建输出：`expo prebuild` 读它们生成 `android/app/src/main/res/` 下的 mipmap，而 `android/` 不进版本库。

| 文件 | 用途 |
|---|---|
| `icon.png` | 旧式方形图标（Android 8 以下的启动器、通知的基底） |
| `adaptive-icon.png` | 自适应图标的**前景**层；底色是 `app.config.ts` 里的 `#0b332f` |

**minSdk 是 26，所以真正显示的是自适应图标**——`icon.png` 只是回落。

## 它们是怎么来的

源图是桌面那份 `packages/gui/resources/lark-icon-source.png`（1024×1024，灰光晕已经切掉、只剩带透明边距的画面本体；那一步的配方在 `packages/gui/scripts/build-icons.mjs` 的抬头）。

两条规则决定了这里的做法：

1. **前景只占内侧的 72/108（66.7%）。** 这是 Android 自适应图标的安全区，外面那一圈随时可能被启动器的遮罩裁掉。画面正好铺满安全区 ⇒ 圆形、squircle、圆角方形三种遮罩都能看到完整的画（尤其是底部那个 `Lark` 字样不会被切）。
2. **底色取画面自己的深墨绿描边色 `#0b332f`**（对边框内 6px 一圈取平均得到）。这样遮罩在四角留下的部分看起来像画的一部分，而不是垫在后面的一块板子。

重跑（需要 Pillow）：

```python
from PIL import Image
SRC = 'packages/gui/resources/lark-icon-source.png'
CANVAS, SAFE = 1024, 72 / 108

src = Image.open(SRC).convert('RGBA')
tile = src.crop(src.split()[-1].getbbox())          # 只要不透明的那块
side = max(tile.size)
square = Image.new('RGBA', (side, side), (0, 0, 0, 0))
square.paste(tile, ((side - tile.width) // 2, (side - tile.height) // 2))

square.resize((CANVAS, CANVAS), Image.LANCZOS).save('apps/mobile/assets/icon.png')

inner = round(CANVAS * SAFE)
fg = Image.new('RGBA', (CANVAS, CANVAS), (0, 0, 0, 0))
scaled = square.resize((inner, inner), Image.LANCZOS)
fg.paste(scaled, ((CANVAS - inner) // 2,) * 2, scaled)
fg.save('apps/mobile/assets/adaptive-icon.png')
```

改完要 `just mobile-prebuild` 再构建——mipmap 是 prebuild 生成的，只改这里不重新 prebuild 的话 APK 里还是旧图标。

## 为什么 0.1.0 漏了

`app.config.ts` 里当时**没有 `icon` 也没有 `adaptiveIcon`**，而**缺失不是错误**：Expo 模板自带一张默认图，prebuild 一声不吭地用了它。类型检查、lint、bundle smoke、原生模块守卫全都照不到。0.1.1 补上之后加了守卫 `scripts/check-mobile-icon.sh`。
