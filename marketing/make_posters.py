"""
KPOT To Go — marketing poster generator
------------------------------------------------------------------
Generates print-ready HTML posters, each with its OWN ?src= QR code, so the
owner can tell in the order export which poster produced which order.

Usage:
    python marketing/make_posters.py
    python marketing/make_posters.py https://order.kpotexpress.com/

Outputs into ./marketing/out :
    poster-window.html     door / window poster   (letter, portrait)
    poster-counter.html    counter card           (half letter)
    poster-table.html      table tent             (4x6)
    flyer-door.html        door hanger / flyer    (letter, portrait)
    card-review.html       "how did we do?" card  (4x6)

Every file is self-contained (the QR is inlined as a data URI) — it can be
opened, printed or emailed as-is, with no image files to lose.

The QR is built the same way make_qr.py does it: fit the version, read
modules_count, then render at a whole number of pixels per module. Never
build a QR and resize it — a 37-module code stretched to 420px is 11.35px
per module, and scanners get unreliable in a way that only shows up at the
counter.
"""

import base64
import io
import os
import sys

import qrcode

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- brand
RED = "#D7263D"
BLACK = "#111014"
CREAM = "#F7F1E6"
GOLD = "#E2B44A"
WHITE = "#FFFFFF"

BASE = (sys.argv[1].strip() if len(sys.argv) > 1 else "https://order.kpotexpress.com/").rstrip("/")
STORE = "KPOT TO GO"
SUB = "Hot Pot To Go  ·  BBQ To Go  ·  Boba"
PHONE = "(678) 335-5388"
ADDRESS = "2955 Cobb Pkwy SE, Suite 830, Atlanta, GA 30339"
HOURS = "Sun–Thu 12:00–9:30  ·  Fri–Sat 12:00–10:30"

CSS = """
* { box-sizing: border-box; }
body { margin: 0; background: #555; font-family: "Helvetica Neue", Arial, sans-serif;
       -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { background: %(WHITE)s; margin: 16px auto; box-shadow: 0 6px 24px rgba(0,0,0,.35);
         position: relative; overflow: hidden; }
.bar { background: %(RED)s; color: %(WHITE)s; font-weight: 800; letter-spacing: .14em; }
.h1 { font-weight: 900; line-height: .95; margin: 0; }
.h2 { font-weight: 800; margin: 0; }
.mut { color: #6b6560; }
.gold { color: %(GOLD)s; }
.red { color: %(RED)s; }
.rule { height: 6px; background: %(RED)s; }
.qr { background: %(WHITE)s; padding: 14px; border-radius: 18px; display: inline-block; }
.qr img { display: block; width: 100%%; height: auto; image-rendering: pixelated; }
.pill { display: inline-block; background: %(RED)s; color: %(WHITE)s; font-weight: 800;
        padding: .35em .9em; border-radius: 999px; letter-spacing: .06em; }
.foot { background: %(BLACK)s; color: %(CREAM)s; }
.note { color: #ddd; font: 12px/1.5 monospace; text-align: center; padding: 6px; }
@media print {
  body { background: #fff; }
  .sheet { margin: 0; box-shadow: none; }
  .note { display: none; }
  @page { margin: 0; }
}
""" % {"RED": RED, "BLACK": BLACK, "CREAM": CREAM, "GOLD": GOLD, "WHITE": WHITE}


def qr_data_uri(data, target=760):
    """A QR as a base64 PNG data URI, rendered at a whole pixels-per-module."""
    q = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=2)
    q.add_data(data)
    q.make(fit=True)
    unit = max(4, round(target / (q.modules_count + 4)))
    q.box_size = unit
    img = q.make_image(fill_color=BLACK, back_color=WHITE).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def page(name, width, height, body, title):
    html = """<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%(title)s</title>
<style>%(css)s
.sheet { width: %(w)sin; min-height: %(h)sin; }
</style></head>
<body>
<div class="sheet">
%(body)s
</div>
<div class="note">print this page · the QR already points at %(base)s with its own ?src=</div>
</body></html>""" % {"title": title, "css": CSS, "w": width, "h": height,
                     "body": body, "base": BASE}
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        f.write(html)
    print("  -> " + name)


def head_bar(tag, title, sub, size):
    return """
<div class="bar" style="padding:%(pad)sin 0;text-align:center;font-size:%(size)sin">
  %(tag)s
</div>
<div style="text-align:center;padding:%(pad2)sin 0 0">
  <div class="h1 red" style="font-size:%(t)sin">%(title)s</div>
  <div class="mut" style="font-size:%(s)sin;letter-spacing:.18em;margin-top:.12in">%(sub)s</div>
</div>""" % {"tag": tag, "title": title, "sub": sub, "size": size,
             "pad": 0.22, "pad2": 0.3, "t": size * 2.4, "s": size * 1.05}


def foot(text):
    return '<div class="foot" style="position:absolute;left:0;right:0;bottom:0;padding:.18in 0;text-align:center;font-weight:700;letter-spacing:.08em">%s</div>' % text


def qr_block(url, caption, size=2.6):
    return """
<div style="text-align:center;margin-top:.3in">
  <div class="qr" style="width:%(w)sin"><img src="%(src)s" alt="QR code"></div>
  <div class="h2" style="font-size:.34in;margin-top:.18in;letter-spacing:.04em">%(cap)s</div>
  <div class="mut" style="font-size:.2in;margin-top:.06in">point your camera at the code</div>
</div>""" % {"src": qr_data_uri(url), "cap": caption, "w": size}


# ---------------------------------------------------------------- posters
def poster_window():
    """The one on the door / window. Big, readable from a car."""
    url = BASE + "/?src=window-poster"
    body = """
<div class="bar" style="padding:.3in 0;text-align:center;font-size:.3in">SCAN · ORDER · PAY</div>
<div style="text-align:center;padding:.5in 0 0">
  <div class="h1" style="font-size:1.05in;color:%(RED)s">KPOT TO GO</div>
  <div class="h2" style="font-size:.34in;margin-top:.14in;letter-spacing:.16em">%(SUB)s</div>
</div>
<div style="text-align:center;margin-top:.4in">
  <span class="pill" style="font-size:.3in">BUILD YOUR OWN BOWL &nbsp;$15.99</span>
</div>
<div style="display:flex;justify-content:center;gap:.3in;margin-top:.35in;text-align:center">
  <div><div class="h2" style="font-size:.3in">FREE DELIVERY</div><div class="mut" style="font-size:.19in">within 2 miles</div></div>
  <div><div class="h2" style="font-size:.3in">READY IN ~20 MIN</div><div class="mut" style="font-size:.19in">order ahead, skip the line</div></div>
</div>
%(qr)s
<div style="text-align:center;margin-top:.4in">
  <div class="h2" style="font-size:.26in">%(PHONE)s</div>
  <div class="mut" style="font-size:.19in;margin-top:.06in">%(ADDRESS)s</div>
  <div class="mut" style="font-size:.19in">%(HOURS)s</div>
</div>
%(foot)s
""" % {"SUB": SUB, "PHONE": PHONE, "ADDRESS": ADDRESS, "HOURS": HOURS,
       "RED": RED,
       "qr": qr_block(url, "SCAN TO ORDER & PAY", 2.9),
       "foot": foot("ORDER ONLINE  ·  PAY ON YOUR PHONE  ·  SKIP THE LINE")}
    page("poster-window.html", 8.5, 11, body, "KPOT To Go — window poster")


def poster_counter():
    """Half-letter counter card, for the register and the pickup shelf."""
    url = BASE + "/?src=counter-card"
    body = """
<div style="display:flex;min-height:8.5in">
  <div style="flex:1.15;padding:.45in .4in">
    <div class="h1" style="font-size:.72in;color:%(RED)s">KPOT<br>TO GO</div>
    <div class="rule" style="width:1.6in;margin:.22in 0"></div>
    <div class="h2" style="font-size:.3in;line-height:1.15">SKIP THE LINE</div>
    <div style="font-size:.21in;margin-top:.14in;line-height:1.5">
      Order and pay on your phone while you wait.<br>
      We will call your name.
    </div>
    <div style="margin-top:.3in">
      <span class="pill" style="font-size:.22in">FIRST ORDER 10%% OFF</span>
    </div>
    <div style="margin-top:.18in;font-size:.2in" class="mut">
      Use code <b style="color:%(RED)s">KPOTEXJ01</b> at checkout
    </div>
    <div style="position:absolute;bottom:.4in;left:.4in;font-size:.19in" class="mut">
      %(PHONE)s<br>%(HOURS)s
    </div>
  </div>
  <div style="flex:.85;background:%(RED)s;color:%(WHITE)s;padding:.45in .3in;text-align:center">
    <div style="font-weight:800;letter-spacing:.14em;font-size:.2in">SCAN TO<br>ORDER &amp; PAY</div>
    <div class="qr" style="width:2.3in;margin:.3in auto 0"><img src="%(src)s" alt="QR code"></div>
    <div style="font-size:.18in;margin-top:.25in;opacity:.9">point your camera<br>at the code</div>
  </div>
</div>
""" % {"RED": RED, "WHITE": WHITE, "PHONE": PHONE, "HOURS": HOURS, "src": qr_data_uri(url)}
    page("poster-counter.html", 8.5, 8.5, body, "KPOT To Go — counter card")


def poster_table():
    """Table tent for the 12 tables — dine-in guests pay at the table."""
    url = BASE + "/?src=table-tent"
    body = """
<div style="text-align:center;padding:.55in 0 0">
  <div class="h1" style="font-size:.78in;color:%(RED)s">KPOT TO GO</div>
  <div class="h2" style="font-size:.24in;letter-spacing:.16em;margin-top:.1in">AT YOUR TABLE</div>
</div>
<div style="text-align:center;margin-top:.35in">
  <span class="pill" style="font-size:.24in">ORDER &amp; PAY FROM YOUR SEAT</span>
</div>
%(qr)s
<div style="text-align:center;margin-top:.35in;font-size:.21in;line-height:1.6">
  Scan, build your bowl, and pay when you are done.<br>
  <span class="mut">Cash or card · no app, no waiting</span>
</div>
<div style="text-align:center;margin-top:.3in;font-size:.2in" class="mut">
  Need a hand? Wave us down or call %(PHONE)s
</div>
%(foot)s
""" % {"RED": RED, "PHONE": PHONE,
       "qr": qr_block(url, "SCAN TO ORDER", 2.3),
       "foot": foot("THANK YOU FOR DINING WITH US")}
    page("poster-table.html", 4, 6, body, "KPOT To Go — table tent")


def flyer_door():
    """Door hanger / hand-out for the 2-mile delivery radius."""
    url = BASE + "/?src=door-flyer"
    body = """
<div class="bar" style="padding:.26in 0;text-align:center;font-size:.26in">NEW IN THE NEIGHBORHOOD</div>
<div style="text-align:center;padding:.4in 0 0">
  <div class="h1" style="font-size:.95in;color:%(RED)s">KPOT TO GO</div>
  <div class="h2" style="font-size:.26in;letter-spacing:.14em;margin-top:.12in">%(SUB)s</div>
</div>
<div style="display:flex;gap:.3in;padding:.35in .5in 0">
  <div style="flex:1;background:%(CREAM)s;border-radius:14px;padding:.24in;text-align:center">
    <div style="font-size:.4in">🍲</div>
    <div class="h2" style="font-size:.23in;margin-top:.08in">HOT POT TO GO</div>
    <div class="mut" style="font-size:.18in;margin-top:.06in">Build Your Own Bowl<br><b>$15.99</b></div>
  </div>
  <div style="flex:1;background:%(CREAM)s;border-radius:14px;padding:.24in;text-align:center">
    <div style="font-size:.4in">🥩</div>
    <div class="h2" style="font-size:.23in;margin-top:.08in">BBQ TO GO</div>
    <div class="mut" style="font-size:.18in;margin-top:.06in">Protein bowls<br><b>from $12.99</b></div>
  </div>
  <div style="flex:1;background:%(CREAM)s;border-radius:14px;padding:.24in;text-align:center">
    <div style="font-size:.4in">🧋</div>
    <div class="h2" style="font-size:.23in;margin-top:.08in">BOBA &amp; MORE</div>
    <div class="mut" style="font-size:.18in;margin-top:.06in">Milk teas, fruit teas<br><b>from $4.50</b></div>
  </div>
</div>
<div style="text-align:center;margin-top:.3in">
  <span class="pill" style="font-size:.24in">FREE DELIVERY WITHIN 2 MILES</span>
  &nbsp;
  <span class="pill" style="font-size:.24in;background:%(BLACK)s">10%% OFF YOUR FIRST ORDER</span>
</div>
%(qr)s
<div style="text-align:center;margin-top:.3in;font-size:.21in;line-height:1.6">
  <b>%(PHONE)s</b><br>
  <span class="mut">%(ADDRESS)s</span><br>
  <span class="mut">%(HOURS)s</span>
</div>
%(foot)s
""" % {"SUB": SUB, "PHONE": PHONE, "ADDRESS": ADDRESS, "HOURS": HOURS,
       "RED": RED, "CREAM": CREAM, "BLACK": BLACK,
       "qr": qr_block(url, "SCAN TO ORDER", 2.4),
       "foot": foot("ORDER ONLINE  ·  order.kpotexpress.com")}
    page("flyer-door.html", 8.5, 11, body, "KPOT To Go — door flyer")


def card_review():
    """Handed over with the food. The Google review link is a placeholder
    until the Business Profile is verified — swap it in and re-run."""
    review = "https://g.page/r/CUPOTREVIEW/edit"   # placeholder — replace
    body = """
<div style="text-align:center;padding:.6in 0 0">
  <div class="h1" style="font-size:.62in;color:%(RED)s">HOW DID WE DO?</div>
  <div style="font-size:.22in;margin-top:.16in;line-height:1.5">
    Your review is the single biggest thing<br>that helps a small shop like ours.
  </div>
</div>
<div style="text-align:center;margin-top:.35in">
  <div class="qr" style="width:2.5in"><img src="%(src)s" alt="QR code"></div>
  <div class="h2" style="font-size:.26in;margin-top:.16in">TAP TO LEAVE A REVIEW</div>
  <div class="mut" style="font-size:.18in;margin-top:.06in">it takes about 20 seconds</div>
</div>
<div style="text-align:center;margin-top:.4in">
  <span class="pill" style="font-size:.2in">EARN POINTS ON EVERY ORDER</span>
</div>
<div style="text-align:center;margin-top:.22in;font-size:.19in" class="mut">
  Scan the QR on your receipt too — points turn into free food.
</div>
%(foot)s
""" % {"RED": RED, "src": qr_data_uri(review),
       "foot": foot("KPOT TO GO  ·  " + PHONE)}
    page("card-review.html", 4, 6, body, "KPOT To Go — review card")


def main():
    print("Posters for", BASE)
    poster_window()
    poster_counter()
    poster_table()
    flyer_door()
    card_review()
    print("Done. Files in", OUT)


if __name__ == "__main__":
    main()
