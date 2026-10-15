"""
KPOT To Go — QR code generator
------------------------------------------------------------------
Generates print-ready QR codes for the ordering page.

Usage:
    python make_qr.py                          # uses the URL in url.txt
    python make_qr.py https://your-site.com/   # or pass it inline

Outputs into ./qrcodes :
    kpot-order-qr.png    1024px, for print / posters
    kpot-order-qr.svg    vector, infinitely scalable
    kpot-order-qr-card.png   branded card with the QR + call to action
    table-XX-qr.png      one per table (1..TABLES)
"""

import os
import sys
import qrcode
from qrcode.image.svg import SvgPathImage
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "qrcodes")
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- config
RED = (215, 38, 61)
BLACK = (17, 16, 20)
CREAM = (247, 241, 230)
GOLD = (232, 180, 74)
WHITE = (255, 255, 255)

TABLES = range(1, 13)          # table QR codes to generate
BRAND = "KPOT TO GO"
CTA = "SCAN TO ORDER & PAY"
SUB = "Korean BBQ · Hot Pot · Boba"


def font(size, bold=False):
    """Best-effort font lookup across Windows / macOS / Linux."""
    names = (
        ["arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf", "Helvetica.ttc"]
        if bold else
        ["arial.ttf", "Arial.ttf", "DejaVuSans.ttf", "Helvetica.ttc"]
    )
    roots = [
        r"C:\Windows\Fonts",
        "/usr/share/fonts/truetype/dejavu",
        "/System/Library/Fonts/Supplemental",
        "/Library/Fonts",
    ]
    for r in roots:
        for n in names:
            p = os.path.join(r, n)
            if os.path.exists(p):
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    pass
    return ImageFont.load_default()


def centered(draw, y, text, f, fill, width):
    w = draw.textlength(text, font=f)
    draw.text(((width - w) / 2, y), text, font=f, fill=fill)
    return w


# ---------------------------------------------------------------- core
def qr_image(data, box=12, border=2):
    q = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=box,
        border=border,
    )
    q.add_data(data)
    q.make(fit=True)
    return q.make_image(fill_color=BLACK, back_color=WHITE).convert("RGB")


def qr_fit(data, target=512, border=2):
    """Render a QR at a WHOLE number of pixels per module.

    Do not build a QR and then Image.NEAREST.resize() it to an arbitrary size.
    A 37-module code stretched to 420px is 11.35px per module, so most modules
    land on 11px and a few on 12px. It looks fine on screen, but scanners get
    unreliable — this actually bit us: table-10 and table-11 decoded 0/5 after a
    URL change altered the module count. A QR that some phones read and others
    don't is worse than one that fails outright, because you find out at the
    counter. So: fit the version, read modules_count, then set box_size to an
    integer and render once.
    """
    q = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=border,
    )
    q.add_data(data)
    q.make(fit=True)
    unit = max(4, round(target / (q.modules_count + 2 * border)))
    q.box_size = unit
    return q.make_image(fill_color=BLACK, back_color=WHITE).convert("RGB")


def exact(img, size):
    """Centre a crisp QR on a white square of an exact pixel size, so callers
    that promise '1024x1024' keep their promise without resampling the code."""
    if img.width == size and img.height == size:
        return img
    canvas = Image.new("RGB", (size, size), WHITE)
    canvas.paste(img, ((size - img.width) // 2, (size - img.height) // 2))
    return canvas


def main():
    url = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    if not url:
        uf = os.path.join(HERE, "url.txt")
        if os.path.exists(uf):
            url = open(uf, encoding="utf-8").read().strip()
    if not url:
        url = "http://127.0.0.1:8899/index.html"
    if not url.endswith("/") and "?" not in url:
        url += "/"

    print("Encoding:", url)

    # ---------- 1. plain high-res PNG ----------
    img = exact(qr_fit(url, target=1010, border=3), 1024)
    img.save(os.path.join(OUT, "kpot-order-qr.png"), optimize=True)
    print("  -> kpot-order-qr.png (1024x1024)")

    # ---------- 2. vector SVG ----------
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=12, border=2)
    q.add_data(url)
    q.make(fit=True)
    q.make_image(image_factory=SvgPathImage).save(os.path.join(OUT, "kpot-order-qr.svg"))
    print("  -> kpot-order-qr.svg (vector)")

    # ---------- 3. branded poster card ----------
    W, H = 1400, 1900
    card = Image.new("RGB", (W, H), BLACK)
    d = ImageDraw.Draw(card)

    # red header band
    d.rectangle([0, 0, W, 330], fill=RED)
    # logo roundel
    d.ellipse([70, 70, 190, 190], fill=WHITE)
    kf = font(84, True)
    kw = d.textlength("K", font=kf)
    d.text((130 - kw / 2, 84), "K", font=kf, fill=RED)

    centered(d, 88, BRAND, font(72, True), WHITE, W)
    centered(d, 185, SUB, font(38), CREAM, W)
    centered(d, 245, "READY IN ~20 MIN", font(30, True), CREAM, W)

    # QR white plate
    qr = exact(qr_fit(url, target=890, border=2), 900)
    side = qr.width
    plate = 1000
    px, py = (W - plate) // 2, 430
    d.rounded_rectangle([px, py, px + plate, py + plate], radius=40, fill=WHITE)
    card.paste(qr, (px + (plate - side) // 2, py + (plate - side) // 2))

    centered(d, 1500, CTA, font(70, True), GOLD, W)
    centered(d, 1600, "Point your camera at the code", font(38), CREAM, W)

    # footer bar
    d.rectangle([0, H - 130, W, H], fill=RED)
    centered(d, H - 100, "Order online  ·  Pay on your phone  ·  Skip the line", font(32, True), WHITE, W)

    card.save(os.path.join(OUT, "kpot-order-qr-card.png"), optimize=True)
    print("  -> kpot-order-qr-card.png (poster, 1400x1900)")

    # ---------- 4. per-table QRs ----------
    base = url.split("?")[0].rstrip("/")
    made = 0
    for n in TABLES:
        turl = f"{base}/?table={n}"
        tq = qr_fit(turl, target=410, border=2)

        CW, CH = 700, 900
        c = Image.new("RGB", (CW, CH), WHITE)
        dd = ImageDraw.Draw(c)
        dd.rectangle([0, 0, CW, 96], fill=RED)
        centered(dd, 22, BRAND, font(40, True), WHITE, CW)

        # big table number
        centered(dd, 130, "TABLE", font(30, True), (130, 125, 120), CW)
        nf = font(150, True)
        nw = dd.textlength(str(n), font=nf)
        dd.text(((CW - nw) / 2, 165), str(n), font=nf, fill=RED)

        qs = 420
        tq2 = exact(tq, qs)
        c.paste(tq2, ((CW - qs) // 2, 360))

        centered(dd, 800, CTA, font(30, True), BLACK, CW)
        centered(dd, 842, SUB, font(22), (120, 115, 110), CW)
        c.save(os.path.join(OUT, f"table-{n:02d}-qr.png"), optimize=True)
        made += 1
    print(f"  -> table-01..{made:02d}-qr.png")

    # write url.txt so re-runs are one command
    with open(os.path.join(HERE, "url.txt"), "w", encoding="utf-8") as f:
        f.write(url)
    print("Done. Files in", OUT)


if __name__ == "__main__":
    main()
