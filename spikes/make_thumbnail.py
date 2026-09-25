import json, math, sys
sys.path.insert(0, r"E:\Ion_Hackathon\spikes")
import must_have_test as m
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H = 1500, 1000
BG, BLUE, YEL, RED, ICE = (2, 6, 15), (46, 150, 245), (234, 254, 7), (228, 55, 0), (207, 228, 255)
cams = m.pull_cameras()
cross = m.pull_crossings()
hin = json.load(open(r"E:\Ion_Hackathon\spikes\hin2025_segments.json"))

# map area: right side
lat0, lat1, lng0, lng1 = 29.52, 30.10, -95.80, -95.05
MX0, MY0, MX1, MY1 = 820, 60, 1560, 940
k = math.cos(math.radians(29.8))
sx = (MX1 - MX0) / ((lng1 - lng0) * k); sy = (MY1 - MY0) / (lat1 - lat0); s = min(sx, sy)
cx, cy = (MX0 + MX1) / 2, (MY0 + MY1) / 2
def P(lat, lng):
    return (cx + (lng - (lng0 + lng1) / 2) * k * s, cy - (lat - (lat0 + lat1) / 2) * s)

img = Image.new("RGB", (W, H), BG)
glow = Image.new("RGB", (W, H), BG)
g = ImageDraw.Draw(glow)
g.ellipse((700, 100, 1500, 900), fill=(0, 40, 110))
img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(160)), 0.8)

layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
d = ImageDraw.Draw(layer)
for c in cams:
    x, y = P(c["lat"], c["lng"])
    if MX0 - 40 < x < W and 0 < y < H:
        d.ellipse((x - 2.2, y - 2.2, x + 2.2, y + 2.2), fill=BLUE + (150,))
for r in hin:
    x, y = P(r["lat"], r["lng"])
    t = min(1, r["Total_Crash_Count"] / 12)
    col = tuple(int(BLUE[i] * (1 - t) + RED[i] * t) for i in range(3))
    rad = 2 + 4 * t
    d.ellipse((x - rad, y - rad, x + rad, y + rad), fill=col + (int(120 + 120 * t),))
for c in cross:
    x, y = P(c["lat"], c["lng"])
    d.line((x - 7, y - 7, x + 7, y + 7), fill=YEL + (255,), width=3)
    d.line((x - 7, y + 7, x + 7, y - 7), fill=YEL + (255,), width=3)
glowl = layer.filter(ImageFilter.GaussianBlur(4))
img = Image.alpha_composite(img.convert("RGBA"), glowl)
img = Image.alpha_composite(img, layer)

# fade map under text
fade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
fd = ImageDraw.Draw(fade)
for x in range(0, 1000):
    a = int(255 * max(0, min(1, (1000 - x) / 220)))
    fd.line((x, 0, x, H), fill=BG + (a,))
img = Image.alpha_composite(img, fade)

d = ImageDraw.Draw(img)
F = r"C:\Windows\Fonts"
title = ImageFont.truetype(F + r"\seguibl.ttf", 150)
sub = ImageFont.truetype(F + r"\segoeuib.ttf", 40)
body = ImageFont.truetype(F + r"\segoeuisl.ttf", 34)
small = ImageFont.truetype(F + r"\segoeui.ttf", 26)
d.text((80, 300), "HOUSTON", font=sub, fill=YEL)
d.text((72, 340), "BLINDSPOT", font=title, fill=(255, 255, 255))
d.text((80, 540), "See what your map can't.", font=ImageFont.truetype(F + r"\segoeuib.ttf", 52), fill=(255, 255, 255))
d.text((80, 625), "Train crossings  ·  AI traffic cameras  ·  Crash data", font=body, fill=ICE)
# legend
ly = 850
for i, (label, col, kind) in enumerate([("Rail crossing", YEL, "x"), ("Traffic camera", BLUE, "o"), ("Crash hotspot", RED, "o")]):
    x = 80 + i * 300
    if kind == "x":
        d.line((x, ly - 9, x + 18, ly + 9), fill=col, width=4); d.line((x, ly + 9, x + 18, ly - 9), fill=col, width=4)
    else:
        d.ellipse((x, ly - 9, x + 18, ly + 9), fill=col)
    d.text((x + 30, ly - 18), label, font=small, fill=(255, 255, 255, 200))
img.convert("RGB").save(r"E:\Ion_Hackathon\houston-traffic-app\docs\assets\thumbnail.png", optimize=True)
print("saved", len(cams), "cams", len(cross), "crossings", len(hin), "hin")
