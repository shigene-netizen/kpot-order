"""
KPOT To Go — STAFF / back-office QR codes
------------------------------------------------------------------
Generates QR cards for the owner console and the kitchen order board, so staff
can scan one to open the board on a phone or tablet instead of typing a URL.

Usage:
    python make_admin_qr.py                      # uses url.txt
    python make_admin_qr.py https://your-site    # or pass the live origin

Outputs into ./qrcodes :
    staff-board-qr.png      -> /admin-orders.html   (kitchen order board)
    staff-console-qr.png    -> /admin.html          (owner console / QR printer)
    staff-menu-qr.png       -> /admin-menu.html     (live menu editor)

NOTE: these codes encode the URL only — never the admin key. Staff still enter
the key once per device (it is kept in sessionStorage, not in the QR).
"""

import os
import sys
import qrcode
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "qrcodes")
os.makedirs(OUT, exist_ok=True)

RED = (215, 38, 61)
BLACK = (17, 16, 20)
CREAM = (247, 241, 230)
WHITE = (255, 255, 255)
GREY = (120, 115, 110)

BRAND = "KPOT TO GO"
SUB = "STAFF ONLY"


def font(size, bold=False):
    names = (
        ["arialbd.ttf", "Arial Bold.ttf", "DejaVuSans-Bold.ttf"]
        if bold else
        ["arial.ttf", "Arial.ttf", "DejaVuSans.ttf"]
    )
    roots = [r"C:\Windows\Fonts",
             "/usr/share/fonts/truetype/dejavu",
             "/System/Library/Fonts/Supplemental",
             "/Library/Fonts"]
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


def qr_image(data, target=500, border=2):
    """Render a QR at an EXACT integer module size and never resample it.

    Resizing a finished QR with NEAREST to an arbitrary pixel size is the bug
    this replaces: 37 modules upscaled to 500px is 13.5px per module, so half
    the modules land on 13px and half on 14px. The code still looks fine to the
    eye, but cv2.QRCodeDetector becomes unreliable on it — and a QR that some
    scanners read and others don't is worse than one that fails outright,
    because you find out at the counter, not at the printer.

    So: fit the version first, read modules_count, then set box_size to a whole
    number of pixels and render once.
    """
    q = qrcode.QRCode(version=None,
                      error_correction=qrcode.constants.ERROR_CORRECT_M,
                      box_size=10, border=border)
    q.add_data(data)
    q.make(fit=True)
    unit = max(4, round(target / (q.modules_count + 2 * border)))
    q.box_size = unit
    return q.make_image(fill_color=BLACK, back_color=WHITE).convert("RGB")


def card(title, subtitle, url, filename):
    W, H = 720, 1080
    c = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(c)

    # red header
    d.rectangle([0, 0, W, 110], fill=RED)
    centered(d, 26, BRAND, font(40, True), WHITE, W)
    centered(d, 76, SUB, font(24, True), CREAM, W)

    # title
    centered(d, 150, title, font(52, True), BLACK, W)
    centered(d, 218, subtitle, font(26), GREY, W)

    # QR on a white plate — qr_image already renders at whole-pixel module
    # size, so it is pasted as-is (no resize).
    qr = qr_image(url, target=420, border=2)
    side = qr.width
    px = (W - side) // 2
    py = 268
    pad = 24
    d.rounded_rectangle([px - pad, py - pad, px + side + pad, py + side + pad],
                        radius=28, fill=WHITE, outline=(225, 222, 215), width=3)
    c.paste(qr, (px, py))

    # footer BELOW the QR plate (which ends at py + side + pad = 268+420+24 = 712)
    footer_top = 720 + pad  # 744
    centered(d, footer_top + 12, "SCAN TO OPEN", font(34, True), RED, W)
    centered(d, footer_top + 64, "Admin key required — enter once per device", font(22), GREY, W)

    short = url.replace("https://", "")
    centered(d, footer_top + 104, short, font(20), GREY, W)

    d.rectangle([0, H - 90, W, H], fill=BLACK)
    centered(d, H - 62, "Not for customer use", font(26, True), CREAM, W)

    path = os.path.join(OUT, filename)
    c.save(path, optimize=True)
    print(f"  -> {filename}  ({url})")
    return path


def main():
    url = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    if not url:
        uf = os.path.join(HERE, "url.txt")
        if os.path.exists(uf):
            url = open(uf, encoding="utf-8").read().strip()
    url = url.rstrip("/")
    if not url.startswith("http"):
        print("No URL given and url.txt is empty — pass the live origin.")
        return

    print("Back-office base:", url)
    card("KITCHEN", "Live order board — mark orders ready",
         f"{url}/admin-orders.html", "staff-board-qr.png")
    card("OWNER", "Console, QR codes, table cards",
         f"{url}/admin.html", "staff-console-qr.png")
    card("MENU", "Edit prices & items live",
         f"{url}/admin-menu.html", "staff-menu-qr.png")
    print("Done. Files in", OUT)


if __name__ == "__main__":
    main()
