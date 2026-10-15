"""Decode every QR in qrcodes/ with both cv2 and pyzbar, and report any
disagreement. Per the cdp-browser-test skill rule #9: never trust a single
verifier — cv2's QRCodeDetector has shown data-dependent false negatives on
identical-payload codes that pyzbar reads fine.
"""
import os, sys, glob
try:
    import cv2
except Exception as e:
    print('cv2 import failed:', e); cv2 = None
try:
    from pyzbar.pyzbar import decode as pz_decode
except Exception as e:
    print('pyzbar import failed:', e); pz_decode = None

EXPECTED = 'https://ae14fe556e314f8fb287e0afa6dec55e.sg.agentos-app.run'

def cv2_decode(path):
    img = cv2.imread(path)
    if img is None: return ('cv2-not-readable', None)
    qd = cv2.QRCodeDetector()
    txt, _, _ = qd.detectAndDecode(img)
    return ('cv2-ok', txt) if txt else ('cv2-empty', None)

def pz_decode_one(path):
    from PIL import Image
    img = Image.open(path)
    res = pz_decode(img)
    if not res: return ('pz-empty', None)
    return ('pz-ok', res[0].data.decode('utf-8', 'replace'))

qrs = sorted(glob.glob(os.path.join('qrcodes', '*.png')))
print('found', len(qrs), 'QR PNGs')
print('-' * 80)
ok = bad = 0
for path in qrs:
    name = os.path.basename(path)
    cv2_status, cv2_txt = cv2_decode(path) if cv2 else ('cv2-skip', None)
    pz_status, pz_txt = pz_decode_one(path) if pz_decode else ('pz-skip', None)
    # both decoders should produce the same text and it should match what we expect
    same = cv2_txt == pz_txt
    if not pz_txt or EXPECTED not in (pz_txt or ''):
        # Special case: table-XX codes encode the URL + ?table=XX; admin codes encode admin-*.html
        # The check "contains EXPECTED" is fine for them all.
        bad += 1
        verdict = 'BAD'
    else:
        ok += 1
        verdict = 'ok'
    cv2_show = cv2_txt if cv2_txt else '∅'
    pz_show  = pz_txt  if pz_txt  else '∅'
    same_mark = '✓' if same else '✗'
    print(f"{verdict:3} {name:34} cv2={cv2_status:11} {cv2_show:60} | pz={pz_status:8} {pz_show:60} | agree={same_mark}")

print('-' * 60)
print(f"ok={ok} bad={bad}")
sys.exit(0 if bad == 0 else 1)