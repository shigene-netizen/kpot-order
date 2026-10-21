#!/usr/bin/env bash
# ===========================================================================
#  KPOT To Go — run every test.
#
#  Usage:
#    bash _dev/run_all.sh                 # offline suites only (no network)
#    STRIPE_TEST_KEY=sk_test_... bash _dev/run_all.sh
#                                         # also the two suites that call the
#                                         # REAL Stripe test API
#
#  Every suite is hermetic: each one points the server at its own scratch files
#  (KPOT_ORDERS_FILE / KPOT_PRINT_FILE / ORDERS_BACKUP_DIR / KPOT_SECRETS_FILE),
#  so running this never reads or writes the shop's real orders, print queue or
#  secrets. The script verifies that at the end.
#
#  No suite reaches the network unless STRIPE_TEST_KEY is set: the ones that
#  would otherwise talk to Stripe point KPOT_STRIPE_API_BASE at a local stub.
#
#  A suite passes only if it exits 0. Several print "PASS —" instead of a count;
#  the exit code is what is trusted here.
# ===========================================================================
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

pass=0; fail=0; failed_names=()

# `env` is resolved at runtime, not trusted. A shim earlier in PATH once
# answered to the name `env` while doing nothing but editing PATH and
# exiting 0 — so `env node suite.js` produced no output and no failure, and
# this runner reported 18 green suites while NONE of them had run (caught by
# deliberately breaking server.js and still seeing "18 passed"). Two
# defences: pick an env that can actually echo, and never count a suite that
# printed nothing as a pass.
ENV_BIN=env
if [ "$("$ENV_BIN" echo probe 2>/dev/null)" != "probe" ]; then
  for cand in /usr/bin/env /bin/env; do
    if [ -x "$cand" ] && [ "$("$cand" echo probe 2>/dev/null)" = "probe" ]; then
      ENV_BIN="$cand"; break
    fi
  done
fi
if [ "$("$ENV_BIN" echo probe 2>/dev/null)" != "probe" ]; then
  echo "FATAL: no working env on this machine — every suite would be a false pass."
  exit 1
fi

run() {                       # run <name> <path> [VAR=val...]
  local name="$1"; shift
  local script="$1"; shift
  printf '  %-26s ' "$name"
  local out
  if out=$("$ENV_BIN" "$@" node "$script" 2>&1) && [ -n "$out" ]; then
    # show the last non-empty line, which is each suite's own verdict
    printf '%s\n' "$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)"
    pass=$((pass + 1))
  else
    printf 'FAILED\n'
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | grep -E 'FAIL|Error|error' | head -6 | sed 's/^/        /'
    else
      printf '        (no output at all — the suite never ran, or env is broken)\n'
    fi
    fail=$((fail + 1)); failed_names+=("$name")
  fi
}

# Every file a suite must never write. Checking only orders.local.json was not
# enough: store.local.json (the owner's channel switches) and menu.local.json
# were hard-coded in server.js until 2026-10-07, so a suite that POSTed
# /api/store or PUT /api/menu overwrote the shop's real settings while this
# check happily reported ✓. All five are now overridable, and all five are
# watched.
#
# customers.local.json joined this list on 2026-10-14, when the loyalty ledger
# landed. The lesson was sharper than the others: 14 suites that spawn the
# server were writing their test awards into the shop's member list, and one of
# them ("Board UI", 125 points) had already done it. Every server-spawning suite
# now pins KPOT_CUSTOMERS_FILE, and this list is what proves it stays true.
SHOP_FILES=(orders.local.json store.local.json menu.local.json print.local.json secrets.local.json discounts.local.json customers.local.json giveaway.local.json giveaway-mail-outbox.jsonl)

fingerprint() {
  local f
  for f in "${SHOP_FILES[@]}"; do
    if [ -f "$f" ]; then
      printf '%s  %s\n' "$(md5sum "$f" | cut -d' ' -f1)" "$f"
    else
      printf '%s  %s\n' '(absent)' "$f"
    fi
  done
}

SHOP_BEFORE=$(fingerprint)

echo "KPOT To Go — full test run"
echo "=========================================================================="
echo
echo "--- pure logic (no server, no network) ---"
run test_counter_cap       _dev/test_counter_cap.js
run test_store_gate        _dev/test_store_gate.js
run test_hours             _dev/test_hours.js
run test_printer           _dev/test_printer.js
run test_discount          _dev/test_discount.js
run test_loyalty           _dev/test_loyalty.js
run test_member             _dev/test_member.js
run test_schedule           _dev/test_schedule.js
run test_delivery_geo       _dev/test_delivery_geo.js
run test_dispatch           _dev/test_dispatch.js
run test_delivery_min        _dev/test_delivery_min.js
run test_giveaway          _dev/test_giveaway.js

echo
echo "--- page syntax (the inline scripts in the owner's own pages) ---"
# node --check cannot read HTML, and one typo in admin.html takes the entire
# owner console down with nothing in the server log to explain it. The checker
# existed for a while without ever being run; it is cheap, so it runs here.
for page in admin.html admin-orders.html admin-menu.html; do
  printf '  %-26s ' "$page"
  if out=$("$ENV_BIN" node _dev/check_html_syntax.js "$page" 2>&1) && [ -n "$out" ]; then
    printf '%s\n' "$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | tail -1)"
    pass=$((pass + 1))
  else
    printf 'FAILED\n'
    printf '%s\n' "$out" | grep -E 'FAIL|Error' | head -6 | sed 's/^/        /'
    fail=$((fail + 1)); failed_names+=("$page")
  fi
done

echo
echo "--- server integration ---"
run test_print_auth        _dev/test_print_auth.js
run test_recheck_payment   _dev/test_recheck_payment.js
run test_auto_prepare      _dev/test_auto_prepare.js
run test_backups           _dev/test_backups.js
run test_flush_survives_kill _dev/test_flush_survives_kill.js
run probe_counter_cap_http _dev/probe_counter_cap_http.js
run probe_discount_http    _dev/probe_discount_http.js
run probe_loyalty          _dev/probe_loyalty.js
run probe_throttle_isolate _dev/probe_throttle_isolate.js
run probe_member            _dev/probe_member.js
run probe_phone_rewards     _dev/probe_phone_rewards.js
run probe_schedule          _dev/probe_schedule.js
run probe_delivery_geo_http _dev/probe_delivery_geo_http.js
run probe_delivery_min_http _dev/probe_delivery_min_http.js
run probe_closed_orders_http _dev/probe_closed_orders_http.js
run probe_driver_http      _dev/probe_driver_http.js
run probe_print_flow       _dev/probe_print_flow.js
run test_agent_discovery   _dev/test_agent_discovery.js
run probe_giveaway_http    _dev/probe_giveaway_http.js

echo
echo "--- real browser (headless Chrome) ---"
run probe_guest_defaults   _dev/probe_guest_defaults.js
run probe_guest_discount   _dev/probe_guest_discount.js
run probe_delivery_pay     _dev/probe_delivery_pay.js
run probe_delivery_geo_ui  _dev/probe_delivery_geo_ui.js
run probe_loyalty_ui       _dev/probe_loyalty_ui.js
run probe_button_fx        _dev/probe_button_fx.js
run probe_board_print_ui   _dev/probe_board_print_ui.js
run probe_driver_ui        _dev/probe_driver_ui.js
run probe_giveaway_ui      _dev/probe_giveaway_ui.js

if [ -n "${STRIPE_TEST_KEY:-}" ]; then
  echo
  echo "--- REAL Stripe test API (money path) ---"
  run probe_cancel_settles _dev/probe_cancel_settles.js STRIPE_SECRET_KEY="$STRIPE_TEST_KEY"
  run e2e_real_stripe      _dev/e2e_real_stripe.js      STRIPE_SECRET_KEY="$STRIPE_TEST_KEY"
else
  echo
  echo "--- REAL Stripe test API ---"
  echo "  skipped (set STRIPE_TEST_KEY=sk_test_... to include these two)"
  echo "          probe_cancel_settles · e2e_real_stripe"
fi

echo
echo "=========================================================================="
SHOP_AFTER=$(fingerprint)
if [ "$SHOP_BEFORE" = "$SHOP_AFTER" ]; then
  echo "shop data: ${#SHOP_FILES[@]} files UNCHANGED ✓  (${SHOP_FILES[*]})"
else
  echo "shop data: CHANGED ✗  — a suite is not hermetic!"
  diff <(printf '%s\n' "$SHOP_BEFORE") <(printf '%s\n' "$SHOP_AFTER") | sed 's/^/        /'
  fail=$((fail + 1)); failed_names+=("hermeticity")
fi
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ] || { printf 'failed: %s\n' "${failed_names[*]}"; exit 1; }
