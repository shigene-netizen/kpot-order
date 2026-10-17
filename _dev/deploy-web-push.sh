#!/usr/bin/env bash
# ============================================================================
# KPOT To Go — one-shot Web Push deploy (run ON the server, as root)
# ----------------------------------------------------------------------------
# Enables real server-side Web Push for new-order alerts:
#   1. pull the new code
#   2. install the `web-push` npm package
#   3. generate VAPID keys (once) and merge them into secrets.local.json
#   4. restart the kpot service
#   5. verify
#
# Usage on the VM:
#   curl -fsSL https://raw.githubusercontent.com/shigene-netizen/kpot-order/main/_dev/deploy-web-push.sh | sudo bash
# ============================================================================
set -euo pipefail

APP_DIR=/opt/kpot
SECRETS=/var/lib/kpot/secrets.local.json

echo "[1/5] Pulling latest code..."
git -C "$APP_DIR" pull --ff-only

echo "[2/5] Installing web-push dependency..."
cd "$APP_DIR"
npm install --no-audit --no-fund

echo "[3/5] Generating VAPID keys (only if missing)..."
SECRETS="$SECRETS" node -e '
  const fs = require("fs");
  const wp = require("web-push");
  const f = process.env.SECRETS;
  const s = JSON.parse(fs.readFileSync(f, "utf8"));
  if (!s.vapidPrivateKey || !s.vapidPublicKey) {
    const k = wp.generateVAPIDKeys();
    s.vapidPublicKey = k.publicKey;
    s.vapidPrivateKey = k.privateKey;
    if (!s.vapidSubject) s.vapidSubject = "mailto:" + (s.mailFrom || "ops@kpotexpress.com");
    fs.writeFileSync(f + ".tmp", JSON.stringify(s, null, 2));
    fs.renameSync(f + ".tmp", f);
    fs.chmodSync(f, 0o600);
    console.log("VAPID keys written to " + f);
  } else {
    console.log("VAPID keys already present — left unchanged");
  }
'

echo "[4/5] Restarting kpot..."
systemctl restart kpot
sleep 2

echo "[5/5] Verifying..."
journalctl -u kpot -n 30 --no-pager | grep -i "web push" || echo "(no Web Push line — check: systemctl status kpot)"
echo
echo "Public key endpoint (should be non-null):"
curl -s localhost:3000/api/push/vapid-public-key || echo "(could not reach localhost:3000)"
echo
echo "DONE. Now open the kitchen board on your phone, log in with the admin key,"
echo "and tap 'Enable new-order alerts'. New orders will push to your phone even"
echo "when the board is closed or the screen is locked."
