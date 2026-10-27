import os
from PIL import Image, ImageDraw, ImageFilter

SRC = r"C:\Users\Administrator\.dsh\attachments\v1\objects\89\89db9b523a1154d60e1ad4cf77bff59e37a1a8d80a0ebb5852197c31bcec81a0"
RES = r"E:\插件设计\android\app\src\main\res"
PUB = r"E:\插件设计\relay\public"

img = Image.open(SRC).convert("RGBA")
W, H = img.size
px = img.load()


def gradient(size, c1, c2):
    g = Image.new("RGB", (size, size))
    d = ImageDraw.Draw(g)
    for i in range(size):
        t = i / (size - 1)
        d.line([(0, i), (size, i)], fill=tuple(int(c1[j] + (c2[j] - c1[j]) * t) for j in range(3)))
    return g


def rounded_mask(size, radius, inset=0):
    s = size * 4
    i = inset * 4
    m = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([i, i, s - 1 - i, s - 1 - i], radius=max(1, radius * 4 - i), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def circle_mask(size):
    m = Image.new("L", (size * 4, size * 4), 0)
    d = ImageDraw.Draw(m)
    d.ellipse([0, 0, size * 4 - 1, size * 4 - 1], fill=255)
    return m.resize((size, size), Image.LANCZOS)


def place(fg_img, canvas, ratio):
    target = int(canvas * ratio)
    scale = target / max(fg_img.size)
    w, h = max(1, int(fg_img.width * scale)), max(1, int(fg_img.height * scale))
    f = fg_img.resize((w, h), Image.LANCZOS)
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    out.alpha_composite(f, ((canvas - w) // 2, (canvas - h) // 2))
    return out


# 1. 找蓝色圆角方块边界
x0, y0, x1, y1 = W, H, -1, -1
for y in range(H):
    for x in range(W):
        r, g, b, _ = px[x, y]
        if b > 150 and b > r + 40 and b > g + 40:
            x0, y0 = min(x0, x), min(y0, y)
            x1, y1 = max(x1, x), max(y1, y)
sq = max(x1 - x0 + 1, y1 - y0 + 1)
print("blue square", (x0, y0, x1, y1), "size", sq)

bg1 = img.getpixel((x0 + sq // 6, y0 + sq // 6))[:3]
bg2 = img.getpixel((x1 - sq // 6, y1 - sq // 6))[:3]
print("bg", bg1, bg2)

# 2. 内缩的圆角矩形遮罩，避开抗锯齿边缘
inner = Image.new("L", (W, H), 0)
mask = rounded_mask(sq, int(sq * 0.225), int(sq * 0.03))
inner.paste(mask, (x0, y0))
ip = inner.load()

# 3. 提取前景：低饱和度=图形，高饱和度=蓝底
fg = Image.new("RGBA", (W, H), (0, 0, 0, 0))
fp = fg.load()
fx0, fy0, fx1, fy1 = W, H, -1, -1
for y in range(y0, y1 + 1):
    for x in range(x0, x1 + 1):
        if ip[x, y] < 200:
            continue
        r, g, b, _ = px[x, y]
        mx = max(r, g, b, 1)
        sat = (mx - min(r, g, b)) / mx
        alpha = (0.45 - sat) / 0.22
        if alpha <= 0.02:
            continue
        alpha = min(1.0, alpha)
        k = 255.0 / mx
        fp[x, y] = (min(255, int(r * k)), min(255, int(g * k)), min(255, int(b * k)), int(alpha * 255))
        if alpha >= 0.35:
            fx0, fy0 = min(fx0, x), min(fy0, y)
            fx1, fy1 = max(fx1, x), max(fy1, y)

print("content bbox", (fx0, fy0, fx1, fy1), "size", fx1 - fx0 + 1, fy1 - fy0 + 1)

# 3b. 去掉边框残留等小连通块（只保留面积大的主体）
import numpy as np
arr = np.array(fg)
alpha = arr[:, :, 3]
binary = alpha > 40
h, w = binary.shape
seen = np.zeros_like(binary)
keep = np.zeros_like(binary)
from collections import deque

for sy in range(h):
    for sx in range(w):
        if not binary[sy, sx] or seen[sy, sx]:
            continue
        q = deque([(sy, sx)])
        seen[sy, sx] = True
        comp = []
        while q:
            y, x = q.popleft()
            comp.append((y, x))
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and binary[ny, nx] and not seen[ny, nx]:
                    seen[ny, nx] = True
                    q.append((ny, nx))
        if len(comp) >= 1500:
            for y, x in comp:
                keep[y, x] = True

arr[:, :, 3] = np.where(keep, alpha, 0)
fg = Image.fromarray(arr, "RGBA")
ys, xs = np.where(keep)
fg = fg.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))
print("cleaned", fg.size)

# 4. 自适应图标层
ADAPT = 432
fg_layer = place(fg, ADAPT, 66 / 108)
bg_layer = gradient(ADAPT, bg1, bg2).convert("RGBA")
os.makedirs(os.path.join(RES, "drawable-nodpi"), exist_ok=True)
fg_layer.save(os.path.join(RES, "drawable-nodpi", "ic_launcher_foreground.png"))
mono = Image.new("RGBA", fg_layer.size, (255, 255, 255, 0))
mono.putalpha(fg_layer.getchannel("A"))
mono.save(os.path.join(RES, "drawable-nodpi", "ic_launcher_monochrome.png"))
bg_layer.save(os.path.join(RES, "drawable-nodpi", "ic_launcher_background.png"))


# 5. 传统 mipmap + PWA
def compose(size, ratio, mask):
    base = gradient(size, bg1, bg2).convert("RGBA")
    front = place(fg, size, ratio)
    comp = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    comp.alpha_composite(base)
    comp.alpha_composite(front)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(comp, (0, 0), mask)
    return out


DENS = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for name, size in DENS.items():
    d = os.path.join(RES, f"mipmap-{name}")
    os.makedirs(d, exist_ok=True)
    compose(size, 0.72, rounded_mask(size, int(size * 0.225))).save(os.path.join(d, "ic_launcher.png"))
    compose(size, 0.72, circle_mask(size)).save(os.path.join(d, "ic_launcher_round.png"))

for size in (192, 512):
    compose(size, 0.72, rounded_mask(size, int(size * 0.225))).save(os.path.join(PUB, f"icon-{size}.png"))

preview = Image.new("RGBA", (ADAPT, ADAPT), (255, 255, 255, 255))
preview.alpha_composite(bg_layer)
preview.alpha_composite(fg_layer)
preview.save(r"E:\插件设计\shots\icon-source-preview.png")
print("done")



