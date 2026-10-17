/* ==========================================================================
   KPOT To Go — Web Push
   --------------------------------------------------------------------------
   Server-side Web Push so the owner's phone gets a "new order" alert even when
   the kitchen board is closed or the screen is locked. Client-side polling
   (admin-orders.html) can only fire while the page is alive; a real push
   arrives straight from the browser's push service.

   The crypto (VAPID signing, the encrypted payload) is handled by the `web-push`
   package. The project otherwise has no dependencies on purpose, so the require
   is wrapped: if the package is missing the server still boots, it just reports
   push as "not configured" and the board falls back to polling.

   WHAT LIVES WHERE
     VAPID keys        → secrets.local.json (vapidPublicKey / vapidPrivateKey)
     subscriptions     → push-subscriptions.local.json (one row per device that
                         opted in; written atomically, same as the order board)
     the public key    → served from /api/push/vapid-public-key so the client
                         never has to hard-code it and the secret never leaves
                         the server.

   Best-effort by design: a send failure must never block or crash the order
   flow that triggered it. Dead subscriptions (404/410 from the push service)
   are pruned; transient failures are kept and retried next time.
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const SECRETS_FILE = process.env.KPOT_SECRETS_FILE || path.join(__dirname, 'secrets.local.json');
const PUSH_FILE = process.env.KPOT_PUSH_FILE || path.join(__dirname, 'push-subscriptions.local.json');

let webpush = null;
try { webpush = require('web-push'); } catch (e) { webpush = null; }

let vapidReady = false;

function loadSecrets() {
  try { return JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) || {}; }
  catch (e) { return {}; }
}

/* Read VAPID details out of secrets and hand them to web-push. Called once at
   boot; if the keys are absent we simply stay "not configured" and the rest of
   the server is unaffected. */
function init() {
  if (!webpush) {
    console.log('[kpot] Web Push disabled — `web-push` package not installed.');
    return false;
  }
  const s = loadSecrets();
  const pub = (s.vapidPublicKey || '').trim();
  const priv = (s.vapidPrivateKey || '').trim();
  if (!pub || !priv) {
    console.log('[kpot] Web Push disabled — no VAPID keys in secrets.local.json.');
    return false;
  }
  const subject = (s.vapidSubject || ('mailto:' + (s.mailFrom || 'ops@kpotexpress.com'))).trim();
  try {
    webpush.setVapidDetails(subject, pub, priv);
    vapidReady = true;
    console.log('[kpot] Web Push enabled (VAPID ready).');
    return true;
  } catch (e) {
    console.error('[kpot] VAPID setup failed:', (e && e.message) || e);
    vapidReady = false;
    return false;
  }
}

function configured() { return vapidReady && !!webpush; }
function publicKey() { return configured() ? (loadSecrets().vapidPublicKey || null) : null; }

/* ---- subscription store (atomic, like the order board) -------------------- */

function readSubs() {
  try {
    const arr = JSON.parse(fs.readFileSync(PUSH_FILE, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function writeSubsAtomic(arr) {
  const tmp = PUSH_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, PUSH_FILE);
}

/* Add a device's subscription. Dedupe by endpoint so re-subscribing from the
   same phone doesn't pile up rows. */
function subscribe(sub) {
  if (!sub || !sub.endpoint) return { ok: false, error: 'bad_subscription' };
  const subs = readSubs();
  if (subs.some((s) => s.endpoint === sub.endpoint)) return { ok: true };
  subs.push({
    endpoint: sub.endpoint,
    keys: sub.keys || null,
    createdAt: new Date().toISOString()
  });
  writeSubsAtomic(subs);
  return { ok: true };
}

/* Remove a device (the owner toggled alerts off, or uninstalled the app). */
function unsubscribe(endpoint) {
  if (!endpoint) return { ok: false, error: 'bad_endpoint' };
  const before = readSubs();
  const after = before.filter((s) => s.endpoint !== endpoint);
  if (after.length !== before.length) writeSubsAtomic(after);
  return { ok: true };
}

/* Push `payload` to every subscribed device. Fire-and-forget: we never await
   it in the order flow. Entries the push service rejects as gone (404/410) are
   pruned; anything else is kept for next time. */
function sendToAll(payload) {
  if (!configured()) return;
  const subs = readSubs();
  if (!subs.length) return;

  const data = JSON.stringify(payload);
  const dropped = new Set();

  Promise.all(subs.map((sub) =>
    webpush.sendNotification(sub, data)
      .then(() => { /* alive */ })
      .catch((err) => {
        const code = err && err.statusCode;
        if (code === 404 || code === 410) dropped.add(sub.endpoint);
        // any other error (410/timeout/5xx) → keep, retry next order
      })
  )).then(() => {
    if (!dropped.size) return;
    const current = readSubs();
    const kept = current.filter((s) => !dropped.has(s.endpoint));
    if (kept.length !== current.length) writeSubsAtomic(kept);
  }).catch((e) => {
    console.error('[kpot] push send error:', (e && e.message) || e);
  });
}

/* How many devices are currently subscribed. Used by the admin "test push"
   button so it can report how many phones are about to buzz. */
function count() { return configured() ? readSubs().length : 0; }

module.exports = { init, configured, publicKey, count, subscribe, unsubscribe, sendToAll };
