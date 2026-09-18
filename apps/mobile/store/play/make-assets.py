#!/usr/bin/env python3
"""Google Play assets for TheStoro, from what already exists. python3 + Pillow only."""
import os, sys
from PIL import Image, ImageDraw, ImageFilter

ROOT = "/Users/ahmed/Matgary"
MARK = f"{ROOT}/apps/web/public/logothestoro.png"          # the S mark, RGBA 1080²
ICON_REF = f"{ROOT}/apps/mobile/assets/images/icon.png"    # 1024² app icon: S mark on white
WORDMARK = f"{ROOT}/apps/mobile/assets/images/logo-ar.png" # Arabic wordmark, RGBA 1080²
SHOTS = f"{ROOT}/apps/mobile/store/screenshots"            # {ar,en}/NN-*.png, 1320×2868
OUT = f"{ROOT}/apps/mobile/store/play"
WHITE = (255, 255, 255)

def content_bbox(im, thresh=10):
    """bbox of pixels that are not (near-)white once flattened on white."""
    rgba = im.convert("RGBA")
    flat = Image.alpha_composite(Image.new("RGBA", rgba.size, WHITE + (255,)), rgba).convert("L")
    return flat.point(lambda v: 255 if v < 255 - thresh else 0).getbbox()

def rounded_mask(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, size[0] - 1, size[1] - 1), radius=radius, fill=255)
    return m

# ---------------------------------------------------------------- 1. 512² icon
def make_icon():
    ref = Image.open(ICON_REF)
    rb = content_bbox(ref)                       # where the mark sits inside the 1024² icon
    frac_h = (rb[3] - rb[1]) / ref.height        # mark height as a fraction of the side
    cx, cy = (rb[0] + rb[2]) / 2 / ref.width, (rb[1] + rb[3]) / 2 / ref.height

    mark = Image.open(MARK).convert("RGBA")
    mb = content_bbox(mark)
    mark = mark.crop(mb)
    side = 512
    th = round(frac_h * side)
    tw = round(mark.width * th / mark.height)
    mark = mark.resize((tw, th), Image.LANCZOS)

    icon = Image.new("RGBA", (side, side), WHITE + (255,))
    x = round(cx * side - tw / 2); y = round(cy * side - th / 2)
    icon.alpha_composite(mark, (x, y))
    path = f"{OUT}/icon-512.png"
    icon.convert("RGB").save(path, optimize=True)
    print(f"icon: ref mark bbox {rb} → {frac_h:.3f} of side; mark {tw}×{th} at ({x},{y}) on 512² → {path}")

# ------------------------------------------------------- 2. 1024×500 feature graphic
def make_feature():
    W, H = 1024, 500
    canvas = Image.new("RGBA", (W, H), WHITE + (255,))

    # phone on the right: dark bezel, rounded corners, runs off the bottom edge
    PW, BEZ, R_OUT = 316, 12, 46
    SW = PW - 2 * BEZ
    shot = Image.open(f"{SHOTS}/ar/01-dashboard.png").convert("RGB")
    scale = SW / shot.width
    SH = round(shot.height * scale)
    shot = shot.resize((SW, SH), Image.LANCZOS)
    PH = SH + 2 * BEZ
    px, py = W - 92 - PW, 62                     # phone top-left
    # soft shadow
    sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(sh).rounded_rectangle((px, py + 16, px + PW, py + PH), radius=R_OUT, fill=(0, 0, 0, 70))
    sh = sh.filter(ImageFilter.GaussianBlur(26))
    canvas.alpha_composite(sh)
    # bezel
    body = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(body).rounded_rectangle((px, py, px + PW, py + PH), radius=R_OUT, fill=(17, 17, 21, 255))
    canvas.alpha_composite(body)
    # screen (rounded)
    screen = Image.new("RGBA", (SW, SH), (0, 0, 0, 0))
    screen.paste(shot, (0, 0), rounded_mask((SW, SH), R_OUT - BEZ))
    canvas.alpha_composite(screen, (px + BEZ, py + BEZ))

    # Arabic wordmark on the left, centred in the free area
    wm = Image.open(WORDMARK).convert("RGBA")
    wb = content_bbox(wm); wm = wm.crop(wb)
    free_w = px - 40                              # left edge .. phone (minus breathing room)
    tw = 430; th = round(wm.height * tw / wm.width)
    wm = wm.resize((tw, th), Image.LANCZOS)
    wx = round(free_w / 2 - tw / 2) + 12; wy = round(H / 2 - th / 2)
    canvas.alpha_composite(wm, (wx, wy))

    path = f"{OUT}/feature-graphic-1024x500.png"
    canvas.convert("RGB").save(path, optimize=True)
    print(f"feature: phone {PW}×{PH} at ({px},{py}) screen scale {scale:.3f}; wordmark {tw}×{th} at ({wx},{wy}) → {path}")

# --------------------------------------------------- 3. phone screenshots 1080×2400
def make_screenshots():
    TW, TH = 1080, 2400
    n = 0
    for loc in ("ar", "en"):
        os.makedirs(f"{OUT}/screenshots/{loc}", exist_ok=True)
        for name in sorted(os.listdir(f"{SHOTS}/{loc}")):
            if not name.endswith(".png"): continue
            im = Image.open(f"{SHOTS}/{loc}/{name}").convert("RGB")
            # width-first (1080 wide) lands at 2347 tall < 2400, so fit the HEIGHT to 2400
            # and centre-crop the ~12 px of side margin instead — no distortion, no padding.
            s = TH / im.height
            w = round(im.width * s)
            im = im.resize((w, TH), Image.LANCZOS)
            left = (w - TW) // 2
            im = im.crop((left, 0, left + TW, TH))
            assert im.size == (TW, TH), im.size
            im.save(f"{OUT}/screenshots/{loc}/{name}", optimize=True)
            n += 1
            print(f"shot {loc}/{name}: scaled to {w}×{TH}, cropped {left}px each side → {TW}×{TH}")
    print(f"{n} screenshots")

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    make_icon(); make_feature(); make_screenshots()
