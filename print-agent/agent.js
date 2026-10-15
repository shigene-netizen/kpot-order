#!/usr/bin/env node
/* ==========================================================================
   KPOT To Go — kitchen print agent
   --------------------------------------------------------------------------
   Runs on the always-on PC in the restaurant. It does one thing:

     ask the cloud for queued kitchen tickets -> send them to the printer

   Why this exists: the order server runs in the cloud and the printer is on
   your shop's network. Nothing on the internet can reach the printer, so
   something inside the shop has to fetch the tickets and hand them over.
   That is this program.

   It is deliberately dumb. It does not know what a ticket looks like, it does
   not read the menu, it does not decide anything — it moves bytes. All the
   formatting happens on the server, so the ticket can be redesigned without
   ever touching this machine.

   ---------------------------------------------------------------------------
   SETUP (once)
     1. Install Node.js (https://nodejs.org) — the LTS button.
     2. Copy config.example.json to config.json and fill in the PRINTER address.
     3. Double-click start.bat.
   Leave the window open. That is the whole job.

   You do NOT need to know the website's address, and you never have to update
   it: the app is re-published on a new domain each time, and this finds the
   current one by itself (see "where is the app right now?" below).

   Uses only Node's built-in modules, so there is nothing to `npm install`.
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/* ------------------------------------------------------------------ config */

/* Where the app's CURRENT address is published.

   The ordering app gets a brand-new domain every time it is re-published, so an
   address written into a file on this machine goes stale — and a stale address
   fails silently (the tickets simply stop coming out).

   The shop's QR codes already point at a stable GitHub Pages page that forwards
   visitors to the app. That same page carries the current address in `target.js`,
   so this reads it from there. One place to change on each deploy, and every
   agent in the shop follows on its own. */
const DEFAULT_DISCOVERY_URL = 'https://shigene-netizen.github.io/kpot/target.js';

/* Read the address out of the redirect config.

   `target.js` is a single object literal we control:
     window.KPOT_TARGET = { baseUrl: 'https://…', storeName: '…', delayMs: 350 };
   Both quote styles are accepted so a hand-edit cannot silently break this.

   COMMENTS ARE STRIPPED FIRST, and that matters more than it looks. Someone
   commenting out the old line while pasting the new one —
     // baseUrl: 'https://old-address',
     baseUrl: 'https://new-address',
   is a completely natural edit. Matching the first occurrence would then
   silently follow the OLD address: printing stops, and the only symptom is
   "no tickets came out". Strip comments, then take the first live match.

   Note the line-comment rule is anchored to the start of a line, so the `//`
   inside `https://` cannot be mistaken for a comment. */
function parseTargetJs(text) {
  const stripped = String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')      // /* block comments */
    .replace(/^[ \t]*\/\/.*$/gm, '');      // // line comments
  const m = stripped.match(/baseUrl\s*:\s*(['"])([^'"]+)\1/);
  return m ? m[2].replace(/\/+$/, '') : '';
}

/* Distinguishes "the key is absent" from "the key is present but blank".

   `env.KPOT_DISCOVERY_URL || fallback` would treat '' as "not set" and quietly
   fall back to the default — so a test that means to switch discovery OFF
   would still reach out to the internet. Blank has to mean blank. */
function pick(envKey, fileValue, fallback) {
  if (Object.prototype.hasOwnProperty.call(process.env, envKey)) {
    return String(process.env[envKey] || '').trim();
  }
  if (fileValue !== undefined && fileValue !== null) return String(fileValue).trim();
  return fallback;
}

function loadConfig() {
  const file = path.join(__dirname, 'config.json');
  const haveFile = fs.existsSync(file);
  let cfg = {};
  if (haveFile) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      console.error('\n  config.json is not valid JSON: ' + e.message);
      console.error('  Fix the file (a stray comma is the usual cause) and start again.\n');
      process.exit(1);
    }
  }

  /* Environment wins, so the test harness can drive this without editing the
     real config file — and so a config-less run is possible when every value
     is supplied by the environment. */
  const merged = {
    /* Optional, and only a fallback: discovery below is what normally supplies
       this. Set it explicitly (or blank discoveryUrl) to pin an address. */
    serverUrl: pick('KPOT_SERVER_URL', cfg.serverUrl, '').replace(/\/+$/, ''),
    /* Blank this to switch discovery off and use serverUrl verbatim. */
    discoveryUrl: pick('KPOT_DISCOVERY_URL', cfg.discoveryUrl, DEFAULT_DISCOVERY_URL),
    /* KPOT_DISCOVERY_MS exists so a test can drive the re-check without waiting
       minutes for it — same idea as KPOT_POLL_MS below. */
    discoveryMs: parseInt(process.env.KPOT_DISCOVERY_MS || '', 10) ||
      Math.max(1, parseInt(process.env.KPOT_DISCOVERY_MINUTES || '', 10) || Number(cfg.discoveryMinutes) || 5) * 60000,
    printKey: pick('KPOT_PRINT_KEY', cfg.printKey, ''),
    printerHost: pick('KPOT_PRINTER_HOST', cfg.printerHost, ''),
    printerPort: parseInt(process.env.KPOT_PRINTER_PORT || cfg.printerPort || '9100', 10),
    pollSeconds: Math.max(1, parseInt(process.env.KPOT_POLL_MS || '', 10) / 1000 || Number(cfg.pollSeconds) || 2),
    printTimeoutMs: parseInt(process.env.KPOT_PRINT_TIMEOUT || cfg.printTimeoutMs || '10000', 10)
  };

  /* One of the two ways of learning the address must be available. */
  const missing = [];
  if (!merged.printerHost) missing.push('printerHost');
  if (!merged.serverUrl && !merged.discoveryUrl) {
    missing.push('serverUrl (or set discoveryUrl)');
  }
  if (missing.length) {
    if (!haveFile) {
      console.error('\n  No config.json found next to this script.');
      console.error('  Copy config.example.json to config.json and fill it in.\n');
    } else {
      console.error('\n  config.json is missing: ' + missing.join(', '));
      console.error('  Open config.json and fill those in.\n');
    }
    process.exit(1);
  }
  return merged;
}

const CFG = loadConfig();
const POLL_MS = CFG.pollSeconds * 1000;

/* ------------------------------------------------------------------- utils */

const stamp = () => new Date().toLocaleTimeString('en-US', { hour12: false });
const log = (...a) => console.log('[' + stamp() + ']', ...a);
const warn = (...a) => console.warn('[' + stamp() + ']', ...a);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* Minimal HTTP client on the core modules rather than global fetch, so this
   runs on any Node the owner happens to have installed — an old Node on a
   restaurant PC is a very likely way to fail, and fetch only exists from 18.

   Redirects ARE followed, and that is not a nicety: the app's address is
   discovered by fetching a redirect page (target.js), and that page now sits
   behind a custom domain — the old github.io address answers 301 and hands
   back the branded one. Without following it the agent sees a 301 instead of
   the file, learns no address, and quietly stops printing, which from the
   kitchen looks exactly like "the printer broke". */
function request(method, urlStr, headers, body, hops) {
  const tried = hops || 0;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad url: ' + urlStr)); }
    const mod = u.protocol === 'https:' ? https : http;
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;

    const req = mod.request({
      method,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      headers: Object.assign({ Accept: 'application/json' }, headers || {},
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      timeout: 20000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        const loc = res.headers && res.headers.location;
        /* Follow a bounded number of hops; a redirect loop must not hang the
           agent, and the un-followed result is still returned if we run out. */
        if (loc && res.statusCode >= 300 && res.statusCode < 400 && tried < 5) {
          let next;
          try { next = new URL(loc, urlStr).href; } catch (e) {
            return resolve({ status: res.statusCode, json: null, text });
          }
          request(method, next, headers, body, tried + 1).then(resolve, reject);
          return;
        }
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* non-JSON error page */ }
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/* ---------------------------------------------- where is the app right now? */

/* The address this agent is currently talking to, and where it came from.
   Resolved lazily and re-checked periodically, so a re-publish is picked up
   without anyone touching this machine. */
let activeUrl = '';
let lastResolveAt = 0;
let resolveWarned = '';        // suppress a repeating identical warning
const RESOLVE_MS = CFG.discoveryMs;

/* GitHub Pages is behind a CDN, so a plain re-fetch can serve the old copy.
   A changing query string makes it a different URL and forces a fresh read. */
function withCacheBuster(url) {
  return url + (url.indexOf('?') === -1 ? '?' : '&') + 't=' + Date.now();
}

/* Returns the base URL to use, resolving it if needed.

   `force` skips the interval — used when the address we have has just proved
   wrong (the old domain answers 400 once the app is re-published).

   A FAILED lookup never clears a working address: the current one may still be
   perfectly good, and the discovery page having a bad moment is not a reason to
   stop printing. */
async function ensureServerUrl(force) {
  const now = Date.now();
  if (!force && activeUrl && (now - lastResolveAt) < RESOLVE_MS) return activeUrl;

  if (CFG.discoveryUrl) {
    try {
      const res = await request('GET', withCacheBuster(CFG.discoveryUrl), {});
      if (res.status === 200) {
        const url = parseTargetJs(res.text);
        if (url) {
          if (url !== activeUrl) {
            if (activeUrl) log('the app has moved to ' + url + ' — following it');
            activeUrl = url;
            lastResolveAt = now;
            resolveWarned = '';
          } else {
            lastResolveAt = now;
          }
          return activeUrl;
        }
        const msg = 'could not read baseUrl from ' + CFG.discoveryUrl;
        if (resolveWarned !== msg) { warn(msg); resolveWarned = msg; }
      } else {
        const msg = 'address lookup returned HTTP ' + res.status + ' (' + CFG.discoveryUrl + ')';
        if (resolveWarned !== msg) { warn(msg); resolveWarned = msg; }
      }
    } catch (e) {
      const msg = 'address lookup failed (' + e.message + ')';
      if (resolveWarned !== msg) { warn(msg); resolveWarned = msg; }
    }
  }

  /* Discovery unavailable or broken — fall back to the configured address. */
  if (!activeUrl && CFG.serverUrl) {
    activeUrl = CFG.serverUrl;
    log('using the address from config.json: ' + activeUrl);
  }
  return activeUrl;
}

/* ------------------------------------------------------------- the printer */

/* Send the bytes and decide whether they actually made it.

   The subtlety: a raw 9100 printer gives you almost no feedback. It accepts
   the bytes and usually closes. There is no "job OK" reply. So:
     * a socket error before we finish writing  -> genuine failure, retry;
     * all bytes written, then silence or close -> success.
   Treating "wrote everything but got no confirmation" as a failure would make
   the server re-send, and the kitchen would get the same ticket twice — which
   is worse than occasionally missing a failure we could not have detected. */
/* The address we actually dial. EVERY printer-side failure carries it: on its
   own, "timed out after 0/965 bytes" tells the owner nothing. The usual cause
   is that the printer came back on a different IP, and that is only actionable
   if the message names the address that failed. */
function printerAddr() {
  return CFG.printerHost + ':' + CFG.printerPort;
}

function printBytes(buf) {
  return new Promise((resolve) => {
    let written = 0;
    let settled = false;
    /* Appended here, once, rather than at each call site — so a failure added
       later cannot forget it. */
    const fail = (msg) => msg + ' — tried ' + printerAddr();
    const done = (ok, err) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (e) {}
      resolve({ ok, error: ok ? '' : fail(err || 'the printer did not take the ticket'), written });
    };

    const sock = net.createConnection({ host: CFG.printerHost, port: CFG.printerPort });
    sock.setTimeout(CFG.printTimeoutMs);

    sock.on('connect', () => {
      sock.write(buf, () => { written = buf.length; });
      sock.end();                       // half-close: printer keeps what it got
    });
    sock.on('close', () => {
      if (written >= buf.length) done(true);
      else done(false, 'connection closed after only ' + written + '/' + buf.length + ' bytes');
    });
    sock.on('timeout', () => {
      if (written >= buf.length) {
        warn('printer did not close the connection, but all bytes were sent — assuming it printed');
        done(true);
      } else {
        done(false, 'timed out after ' + written + '/' + buf.length + ' bytes');
      }
    });
    sock.on('error', (e) => done(false, e.code === 'ECONNREFUSED'
      ? 'printer refused the connection (is it switched on?)'
      : e.message));
  });
}

/* ------------------------------------------------------------------- loop */

let stopping = false;

async function pollOnce() {
  const base = await ensureServerUrl(false);
  if (!base) throw new Error('no server address known yet');

  const res = await request('GET', base + '/api/print/jobs?limit=5',
    { 'X-Print-Key': CFG.printKey });

  if (res.status === 401) {
    warn('the server rejected our print key (401).');
    warn('The print key is SEPARATE from the admin/console key — do not reuse it.');
    warn('Set a printKey in the server\'s secrets.local.json (a DIFFERENT value');
    warn('from adminKey), then paste the SAME value into config.json here.');
    warn('If the server has no printKey AND no adminKey, leave this empty.');
    return;
  }
  /* A re-published app leaves the OLD domain answering 400 (the platform
     re-issues the subdomain). That is the "it moved" signal — ask where it is
     now, and the next tick will use the new address. */
  if (res.status === 400) {
    warn('the server answered 400 — the app has probably been re-published.');
    await ensureServerUrl(true);
    return;
  }
  if (res.status !== 200 || !res.json) {
    warn('server returned HTTP ' + res.status + ' — will try again');
    return;
  }
  if (res.json.printing === false) return;          // printing disabled server-side

  const jobs = res.json.jobs || [];
  for (const job of jobs) {
    if (!job.bytes) {
      await ack(job.id, false, 'server sent a job with no ticket data');
      continue;
    }
    const buf = Buffer.from(job.bytes, 'base64');
    const out = await printBytes(buf);
    if (out.ok) {
      log('printed ' + job.orderId + ' (' + buf.length + ' bytes)' + (job.reprint ? ' [reprint]' : ''));
      await ack(job.id, true);
    } else {
      warn('FAILED to print ' + job.orderId + ': ' + out.error);
      await ack(job.id, false, out.error);
    }
  }
}

async function ack(id, ok, error) {
  try {
    /* Same address as the poll that produced this job, so an ack can never be
       sent to a stale domain mid-move. */
    await request('POST', activeUrl + '/api/print/jobs/' + encodeURIComponent(id) + '/ack',
      { 'X-Print-Key': CFG.printKey }, { ok, error: error || '' });
  } catch (e) {
    /* If the ack does not land, the server's lease expires and re-queues the
       job — which means a possible duplicate. Say so plainly. */
    warn('could not report the result for ' + id + ' (' + e.message + ')');
    warn('the server will re-queue it; if the printer already printed it, expect a duplicate.');
  }
}

async function main() {
  console.log('');
  console.log('  KPOT To Go — kitchen print agent');
  console.log('  --------------------------------');
  console.log('  printer : ' + CFG.printerHost + ':' + CFG.printerPort);
  console.log('  poll    : every ' + CFG.pollSeconds + 's');
  console.log('  key     : ' + (CFG.printKey ? 'set (must match server secrets printKey)' : 'none — set a printKey in server secrets'));
  if (CFG.discoveryUrl) {
    console.log('  address : looked up automatically every ' + Math.round(CFG.discoveryMs / 60000) + ' min');
    console.log('            from ' + CFG.discoveryUrl);
  } else {
    console.log('  address : pinned to config.json (automatic lookup is off)');
  }
  console.log('');
  console.log('  Leave this window open. Tickets print automatically.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  /* Resolve the address once up front so it is on screen before the first poll,
     and so a wrong address is obvious immediately rather than looking like
     "no orders yet". */
  const base = await ensureServerUrl(true);
  if (base) {
    console.log('  -> ' + base);
    console.log('');
  } else {
    warn('could not work out the app\'s address yet — will keep trying.');
  }

  if (base) {
    try {
      const res = await request('GET', base + '/api/print/status', { 'X-Print-Key': CFG.printKey });
      if (res.status === 401) warn('the server rejected the print key — check config.json');
      else if (res.status === 200 && res.json && res.json.counts) {
        log('connected. ' + res.json.counts.pending + ' ticket(s) waiting.');
      } else warn('server answered HTTP ' + res.status + ' on startup check');
    } catch (e) {
      warn('cannot reach the server yet: ' + e.message);
      warn('it will keep retrying — check the internet connection.');
    }
  }

  let failures = 0;
  while (!stopping) {
    try {
      await pollOnce();
      failures = 0;
    } catch (e) {
      failures++;
      /* The network being down and the app having moved look the same from
         here, so re-resolve before backing off — it is one cheap request, and
         it is what lets a re-publish heal itself. */
      await ensureServerUrl(true);

      /* Back off when the network is down, but never give up: the shop's
         internet will come back and the tickets must still print. */
      const backoff = Math.min(30, failures * 2);
      if (failures === 1 || failures % 10 === 0) {
        warn('could not reach the server (' + e.message + ') — retrying, next in ' + backoff + 's');
      }
      await sleep(backoff * 1000);
      continue;
    }
    await sleep(POLL_MS);
  }
}

process.on('SIGINT', () => { console.log('\nStopping…'); stopping = true; process.exit(0); });
process.on('uncaughtException', (e) => { warn('unexpected error: ' + e.message); });

/* Exported so the address parser can be unit-tested without starting the agent.
   `require.main === module` keeps requiring this file from running the loop. */
/* `request` is exported too, so the redirect-following above can be tested
   without booting the whole agent. */
module.exports = { parseTargetJs, request };

if (require.main === module) main();
