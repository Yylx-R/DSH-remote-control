from PIL import Image, ImageDraw, ImageFont
import os

SHOTS = r"E:\Android\DshRemote\shots"
OUT = SHOTS

def font(size):
    return ImageFont.truetype(r"C:\Windows\Fonts\msyh.ttc", size)

def sheet(name, tiles, bg, fg, label_size=46, tile_w=540, pad=36, cols=3):
    """tiles: list of (label, filename)"""
    label_h = label_size + 24
    rows = (len(tiles) + cols - 1) // cols
    # load first to get aspect
    first = Image.open(os.path.join(SHOTS, tiles[0][1]))
    ratio = first.height / first.width
    tile_h = int(tile_w * ratio)
    cell_w = tile_w + pad * 2
    cell_h = label_h + tile_h + pad
    W = cell_w * cols
    H = cell_h * rows + pad
    img = Image.new("RGB", (W, H), bg)
    d = ImageDraw.Draw(img)
    f = font(label_size)
    for i, (label, fn) in enumerate(tiles):
        r, c = divmod(i, cols)
        x = c * cell_w + pad
        y = r * cell_h + pad
        d.text((x, y), label, font=f, fill=fg)
        pic = Image.open(os.path.join(SHOTS, fn)).convert("RGB")
        pic = pic.resize((tile_w, tile_h), Image.LANCZOS)
        img.paste(pic, (x, y + label_h))
        d.rectangle([x - 2, y + label_h - 2, x + tile_w + 1, y + label_h + tile_h + 1], outline=(60, 60, 60))
    img.save(os.path.join(OUT, name))
    print(name, img.size)

dark = [
    ("登录", "20_login_dark.png"),
    ("设备列表", "10_devices_dark.png"),
    ("会话列表", "11_sessions_dark.png"),
    ("聊天", "12_chat_dark.png"),
    ("输入中（微信式键盘）", "13_chat_typing_dark.png"),
    ("更多面板", "14_panel_dark.png"),
]
sheet("preview_dark.png", dark, (15, 17, 21), (242, 243, 245))

light = [
    ("登录（浅色）", "19_login_light.png"),
    ("设备列表（浅色）", "15_devices_light.png"),
    ("聊天（浅色）", "17_chat_light.png"),
]
sheet("preview_light.png", light, (247, 248, 250), (20, 23, 26))
