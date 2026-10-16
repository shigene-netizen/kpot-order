#!/usr/bin/env bash
# ============================================================================
# KPOT To Go — one-shot installer for an Oracle Cloud "Always Free" VM
# ----------------------------------------------------------------------------
# Run this ON the cloud machine, as root, once:
#
#   curl -fsSL <raw url of this file> -o setup-kpot.sh
#   sudo bash setup-kpot.sh
#
# What it does, in order:
#   1. installs Node.js 20 and Caddy (Caddy gets the HTTPS certificate for you)
#   2. puts the app in /opt/kpot  (from git, so updates are one command)
#   3. puts the shop's DATA in /var/lib/kpot — on the machine's own disk, so
#      orders survive reboots and redeploys
#   4. creates a systemd service so it starts again after a reboot
#   5. opens ports 80 and 443
#
# It asks you for exactly one thing: your Stripe secret key.
# The two keys it needs but you do not have yet (admin + print) it generates
# itself and prints them at the end — you will need the print one for the
# kitchen PC.
#
# Safe to run twice: it updates an existing install without wiping your data.
# ============================================================================
set -euo pipefail

APP_DIR=/opt/kpot
DATA_DIR=/var/lib/kpot
ENV_FILE=/etc/kpot.env
SERVICE=kpot
REPO_URL="${REPO_URL:-https://github.com/shigene-netizen/kpot-order.git}"
DOMAIN="${DOMAIN:-order.kpotexpress.com}"
PORT=3000

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
die()  { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run this as root:  sudo bash setup-kpot.sh"

say "1/7  Installing Node.js and Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git >/dev/null

# ---------------------------------------------------------------------------
#  THE SHOP'S CLOCK. Do not skip this, and do not "optimise" it away.
#
#  Fresh cloud images boot on Etc/UTC. Every date this app computes is
#  LOCAL-time arithmetic — what "today" is, what "tomorrow" is, and the exact
#  moment the kitchen starts a scheduled delivery — so on a UTC box a
#  12:00 PM–1:00 PM Atlanta window is handed a kitchen-start timestamp of
#  11:30 UTC, which is 7:30 AM in Atlanta. The kitchen starts cooking a lunch
#  delivery four hours early, and between 8 PM and midnight the server thinks
#  it is already tomorrow.
#
#  Nothing else in the stack complains, which is exactly why this lives here:
#  the symptom looks nothing like the cause. server.js also warns at boot if
#  the host zone does not match store.timezone in config.js.
# ---------------------------------------------------------------------------
SHOP_TZ="${SHOP_TZ:-America/New_York}"
if command -v timedatectl >/dev/null 2>&1; then
  timedatectl set-timezone "$SHOP_TZ" 2>/dev/null || true
fi
info "timezone: $( (command -v timedatectl >/dev/null 2>&1 && timedatectl show -p Timezone --value) || date +%Z)  (shop is $SHOP_TZ)"

if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  info "adding the NodeSource repository (node 20)"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
info "node $(node -v)"

if ! command -v caddy >/dev/null 2>&1; then
  info "adding the Caddy repository"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
info "caddy $(caddy version | head -1)"

say "2/7  Getting the application code"
mkdir -p "$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  info "already installed — pulling the latest code"
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
[ -f "$APP_DIR/server.js" ] || die "server.js not found in $APP_DIR — is REPO_URL right?"

say "3/7  Preparing the data directory"
# This is the part that must NOT live inside the app folder: every redeploy
# replaces that folder, and the orders would go with it.
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"
info "data lives in $DATA_DIR (kept across redeploys)"

say "4/7  Setting the keys"
# Stripe: you must supply this one.
if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
  info "using STRIPE_SECRET_KEY from the environment"
else
  printf '   Paste your Stripe secret key (starts with sk_live_ or sk_test_): '
  read -rs STRIPE_SECRET_KEY
  echo
fi
[ -n "${STRIPE_SECRET_KEY:-}" ] || die "a Stripe secret key is required"

# Admin + print: keep whatever is already there, otherwise generate.
# The print key MUST differ from the admin key — that is what keeps a
# compromised kitchen PC away from the owner's console.
load_or_make() {
  local name=$1
  if [ -f "$ENV_FILE" ] && grep -q "^${name}=" "$ENV_FILE"; then
    grep "^${name}=" "$ENV_FILE" | cut -d= -f2- | tr -d '"'
  else
    openssl rand -hex 24
  fi
}
ADMIN_KEY="$(load_or_make ADMIN_KEY)"
PRINT_KEY="$(load_or_make PRINT_KEY)"
[ "$ADMIN_KEY" != "$PRINT_KEY" ] || PRINT_KEY="$(openssl rand -hex 24)"
info "admin key: kept/generated"
info "print key: kept/generated (different from the admin key)"

cat > "$ENV_FILE" <<EOF
# KPOT To Go — runtime configuration.  chmod 600, owned by root.
PORT=$PORT
STRIPE_SECRET_KEY=$STRIPE_SECRET_KEY
ADMIN_KEY=$ADMIN_KEY
PRINT_KEY=$PRINT_KEY

# Where the shop's data lives. Outside /opt/kpot on purpose.
KPOT_ORDERS_FILE=$DATA_DIR/orders.local.json
KPOT_CUSTOMERS_FILE=$DATA_DIR/customers.local.json
KPOT_PRINT_FILE=$DATA_DIR/print.local.json
KPOT_STORE_FILE=$DATA_DIR/store.local.json
KPOT_MENU_FILE=$DATA_DIR/menu.local.json
KPOT_DISCOUNTS_FILE=$DATA_DIR/discounts.local.json
KPOT_SECRETS_FILE=$DATA_DIR/secrets.local.json
EOF
chmod 600 "$ENV_FILE"

say "5/7  Installing the service"
cat > /etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=KPOT To Go ordering server
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

say "6/7  Setting up HTTPS for $DOMAIN"
cat > /etc/caddy/Caddyfile <<EOF
# Caddy renews the certificate on its own — there is nothing to renew by hand.
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
systemctl enable caddy >/dev/null
systemctl restart caddy

say "7/7  Opening ports and starting"
# Oracle's Ubuntu images ship with a tight iptables INPUT chain that ends in a
# catch-all REJECT, so both the console's Security List AND this firewall have
# to allow 80/443.
#
# The REJECT's position depends on the image release — it is 5 on Ubuntu 24.04
# but 6 on some others. Do NOT hardcode an index: inserting at a fixed number
# silently lands the rules *below* the REJECT, where they match nothing. The
# symptom is nasty because every local check looks healthy (the service is up,
# Caddy is listening, the rules are "there") while the site is unreachable from
# the internet. Find the REJECT and insert above it.
for p in 80 443; do
  while iptables -D INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null; do :; done
done
reject_at="$(iptables -L INPUT -n --line-numbers | awk '$2 == "REJECT" { print $1; exit }')"
[ -n "$reject_at" ] || reject_at=1
for p in 80 443; do
  iptables -I INPUT "$reject_at" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
done
info "opened 80/443 (inserted above the REJECT rule at position $reject_at)"

# Persist across reboots. netfilter-persistent replays this file at boot; the
# older images ship it, newer ones may not.
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
if ! command -v netfilter-persistent >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
fi
systemctl restart "$SERVICE"
sleep 2

say "Done — checking that it answers"
if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null; then
  info "the app is up on port $PORT"
else
  die "the app did not answer on /api/health — see: journalctl -u $SERVICE -n 50"
fi

say "================================================================"
printf '   Address      https://%s\n' "$DOMAIN"
printf '   Health       https://%s/api/health\n' "$DOMAIN"
printf '   Kitchen      https://%s/staff/board\n' "$DOMAIN"
printf '   Console      https://%s/staff/console\n' "$DOMAIN"
echo
printf '   \033[1mADMIN_KEY\033[0m  %s\n' "$ADMIN_KEY"
printf '   \033[1mPRINT_KEY\033[0m  %s\n' "$PRINT_KEY"
echo
echo "   Copy these somewhere safe. The PRINT_KEY goes into the kitchen PC's"
echo "   print-agent/config.json — it is the only one that machine gets."
echo
echo "   Next: point $DOMAIN at this machine's public IP in your DNS,"
echo "   then Caddy will fetch the certificate automatically."
echo "================================================================"
