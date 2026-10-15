#!/usr/bin/env node
/* Can the print agent survive the app being re-published on a new address?

   THE PROBLEM
   -----------
   The ordering app gets a brand-new domain every time it is re-published. The
   print agent runs on a PC in the restaurant and used to have that address
   written into config.json — so after every deploy someone had to walk over to
   the shop PC and edit a file. Forget once and printing stops SILENTLY: the
   board just says "no print agent has connected".

   THE FIX
   -------
   The agent DISCOVERS the address instead. The shop's QR codes already point at
   a stable GitHub Pages page that forwards to the app, and that page carries the
   current address in `target.js`. The agent reads it, and re-reads it
   periodically — and immediately whenever the address it has stops working.

   WHAT THIS PROVES
   ----------------
     1. the parser reads the address out of target.js (both quote styles,
        trailing slash, and the failure cases that must return nothing);
     2. an agent whose address has gone stale FOLLOWS the move and prints;
     3. it follows a move that happens while it is running (periodic re-check);
     4. a discovery failure does NOT throw away a working address;
     5. a pinned serverUrl (discovery switched off) is still honoured — this is
        what keeps every other test in the suite hermetic.

   No network: the "app" and the discovery page are both local stubs.

   Usage:  node _dev/test_agent_discovery.js
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { createFakePrinter } = require('./fake_printer.js');

const ROOT = path.dirname(__dirname);
const AGENT = path.join(ROOT, 'print-agent', 'agent.js');

/* Ports kept clear of the other suites' ranges. */
const APP_A = 8961;
const APP_B = 8962;
const DISCO = 8963;
const PRINTER = 8964;
const REDIRECT = 8965;
const PRINT_KEY = 'discovery-test-key';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(desc, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? '  ok  ' : '  FAIL') + '  ' + desc + (detail ? '\n         ' + detail : ''));
}
function section(t) { console.log('\n' + t); }

/* -------------------------------------------------------------------------- */
/* 1. The parser                                                              */
/* -------------------------------------------------------------------------- */
/* Unit-tested directly because it is the one piece that reads a foreign file
   format. A regex that silently matches nothing would look exactly like "the
   app is unreachable", which is the most confusing possible failure.

   NOTE: requiring agent.js runs its loadConfig() at module load, and that calls
   process.exit(1) when the printer address is missing — so the environment has
   to be valid BEFORE the require, or the whole suite dies on the first line. */
process.env.KPOT_PRINTER_HOST = process.env.KPOT_PRINTER_HOST || '127.0.0.1';
process.env.KPOT_DISCOVERY_URL = process.env.KPOT_DISCOVERY_URL || '';
/* ...and a placeholder address, because blanking discovery leaves the agent with
   no way at all to learn one — which is itself a configuration error it refuses
   to start on. */
process.env.KPOT_SERVER_URL = process.env.KPOT_SERVER_URL || 'http://127.0.0.1:1';

section('reading the address out of target.js');
const { parseTargetJs, request: agentRequest } = require(AGENT);

check('single quotes (the format the file actually uses)',
  parseTargetJs("window.KPOT_TARGET = { baseUrl: 'https://a.example', delayMs: 350 };") === 'https://a.example');
check('double quotes (a hand-edit must not break it)',
  parseTargetJs('window.KPOT_TARGET = { baseUrl: "https://b.example" };') === 'https://b.example');
check('a trailing slash is stripped, so paths join cleanly',
  parseTargetJs("baseUrl: 'https://c.example/'") === 'https://c.example');
check('extra whitespace and newlines are tolerated',
  parseTargetJs("window.KPOT_TARGET = {\n  baseUrl :\n    'https://d.example' ,\n  delayMs: 350\n};") === 'https://d.example');
check('an unrelated "baseUrl" elsewhere does not confuse it',
  parseTargetJs("/* baseUrl: 'https://decoy' */\nbaseUrl: 'https://e.example'") === 'https://e.example');
check('no baseUrl at all returns empty (so the caller falls back)',
  parseTargetJs('window.KPOT_TARGET = { storeName: "x" };') === '');
check('an HTML error page returns empty, not a bogus URL',
  parseTargetJs('<!DOCTYPE html><html>404</html>') === '');
check('empty input returns empty', parseTargetJs('') === '');

/* -------------------------------------------------------------------------- */
/* 2. The live discovery file, if reachable                                   */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Stubs                                                                      */
/* -------------------------------------------------------------------------- */

/* A stand-in for the ordering app. `mode` lets a test simulate the old domain
   after a re-publish, which answers 400 rather than 404. */
function createAppStub() {
  const state = { mode: 'ok', polls: 0, acked: [] };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://stub');
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
      res.end(body);
    };

    if (state.mode === 'gone') return send(400, { error: 'no such host' });

    if (req.headers['x-print-key'] !== PRINT_KEY) return send(401, { error: 'unauthorized' });

    if (u.pathname === '/api/print/status') {
      return send(200, { enabled: true, counts: { pending: state.polls ? 0 : 0, failed: 0 }, lastAgentPoll: new Date().toISOString() });
    }
    if (u.pathname === '/api/print/jobs') {
      state.polls++;
      if (state.jobs && state.jobs.length) return send(200, { jobs: state.jobs });
      return send(200, { jobs: [] });
    }
    const ack = u.pathname.match(/^\/api\/print\/jobs\/([^/]+)\/ack$/);
    if (ack) {
      state.acked.push(decodeURIComponent(ack[1]));
      return send(200, { ok: true });
    }
    return send(404, { error: 'not_found' });
  });
  return {
    state, server,
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    close: () => new Promise((r) => {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) {}
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      try { server.close(fin); } catch (e) { fin(); }
      setTimeout(fin, 800);
    })
  };
}

/* The discovery page. `setUrl` is the "someone re-deployed" action. */
function createDiscoveryStub() {
  let baseUrl = '';
  let serve = true;
  const server = http.createServer((req, res) => {
    if (!serve) { res.writeHead(500); return res.end('boom'); }
    const body = "window.KPOT_TARGET = {\n  baseUrl: '" + baseUrl + "',\n  storeName: 'KPOT To Go',\n  delayMs: 350\n};\n";
    res.writeHead(200, { 'Content-Type': 'application/javascript' });
    res.end(body);
  });
  return {
    setUrl(u) { baseUrl = u; },
    setServe(v) { serve = v; },
    listen: (port) => new Promise((r) => server.listen(port, '127.0.0.1', r)),
    close: () => new Promise((r) => {
      try { if (server.closeAllConnections) server.closeAllConnections(); } catch (e) {}
      let done = false;
      const fin = () => { if (!done) { done = true; r(); } };
      try { server.close(fin); } catch (e) { fin(); }
      setTimeout(fin, 800);
    })
  };
}

/* Poll a condition instead of sleeping a guessed amount. Returns whether it
   became true, so an assertion can never pass because a proxy condition did. */
async function waitFor(fn, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (fn()) return true; await sleep(150); }
  return !!fn();
}

function startAgent(env) {
  const a = spawn(process.execPath, [AGENT], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      KPOT_PRINT_KEY: PRINT_KEY,
      KPOT_PRINTER_HOST: '127.0.0.1',
      KPOT_PRINTER_PORT: String(PRINTER),
      KPOT_POLL_MS: '300',
      /* Every other suite relies on this: an explicit address must win over
         discovery, or the tests would reach out to the internet. */
      KPOT_SERVER_URL: '',
      KPOT_DISCOVERY_URL: '',
      KPOT_DISCOVERY_MS: '1200'
    }, env || {}),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  a.log = '';
  a.stdout.on('data', (d) => { a.log += d.toString(); });
  a.stderr.on('data', (d) => { a.log += d.toString(); });
  return a;
}

/* -------------------------------------------------------------------------- */
/* 3. End to end                                                              */
/* -------------------------------------------------------------------------- */

async function main() {
  console.log('\nprint agent — following the app when it moves');
  console.log('='.repeat(74));

  const printer = createFakePrinter();
  const appA = createAppStub();
  const appB = createAppStub();
  const disco = createDiscoveryStub();
  let agent = null;

  const cleanup = async () => {
    try { if (agent) agent.kill(); } catch (e) {}
    try { await printer.close(); } catch (e) {}
    try { await appA.close(); } catch (e) {}
    try { await appB.close(); } catch (e) {}
    try { await disco.close(); } catch (e) {}
  };

  try {
    await printer.listen(PRINTER, '127.0.0.1');
    await appA.listen(APP_A);
    await appB.listen(APP_B);
    await disco.listen(DISCO);

    const URL_A = 'http://127.0.0.1:' + APP_A;
    const URL_B = 'http://127.0.0.1:' + APP_B;

    /* ---- the discovery page moving behind a custom domain --------------- */
    /* This is exactly what happened when the shop put www.kpotexpress.com in
       front of the redirect layer: github.io/kpot/target.js started answering
       301. An agent that does not follow it learns no address and silently
       stops printing, which from the kitchen looks like "the printer broke". */
    section('a moved discovery page (301) is followed');
    const moved = http.createServer((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(301, { Location: '/target.js' });
        return res.end('moved');
      }
      if (req.url === '/loop') {
        res.writeHead(301, { Location: '/loop' });
        return res.end('loop');
      }
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      res.end("window.KPOT_TARGET = { baseUrl: 'http://127.0.0.1:" + APP_A + "' };");
    });
    await new Promise((r) => moved.listen(REDIRECT, '127.0.0.1', r));
    try {
      const followed = await agentRequest('GET', 'http://127.0.0.1:' + REDIRECT + '/moved', {});
      check('a 301 is followed, so the agent still learns the address',
        followed.status === 200 && parseTargetJs(followed.text) === 'http://127.0.0.1:' + APP_A,
        'status=' + followed.status + ' text=' + JSON.stringify(followed.text).slice(0, 60));
      const looped = await agentRequest('GET', 'http://127.0.0.1:' + REDIRECT + '/loop', {});
      check('a redirect loop terminates instead of hanging the agent',
        looped.status === 301, 'status=' + looped.status);
    } finally {
      /* Must not hang: keep-alive sockets keep a server close waiting. */
      try { moved.close(); if (moved.closeAllConnections) moved.closeAllConnections(); } catch (e) {}
    }

    /* ---- the "we switched discovery off" case --------------------------- */
    section('a pinned address still works (this is what keeps tests hermetic)');
    appA.state.jobs = [{ id: 'J1', orderId: 'KP-DISC-1', bytes: Buffer.from('TICKET').toString('base64') }];
    const pinned = startAgent({ KPOT_SERVER_URL: URL_A, KPOT_DISCOVERY_URL: '' });
    const printed1 = await waitFor(() => printer.received.length >= 1, 12000);
    check('with discovery off, the agent uses serverUrl verbatim',
      printed1, 'tickets=' + printer.received.length);
    check('and it never touches the discovery page',
      appA.state.polls >= 1 && !/looked up automatically/.test(pinned.log),
      'polls=' + appA.state.polls);
    pinned.kill();
    await sleep(400);

    /* ---- the case this whole feature exists for ------------------------- */
    section('the app is re-published while the agent is running');
    /* This is the deploy we are trying to make painless. Nobody edits anything
       on the shop PC; the agent is already pointed at the OLD address.

       Short discovery interval here, so the PERIODIC re-check is what has to
       notice. The 400 path gets its own phase below with a long interval, so
       neither mechanism can be credited with the other's work. */
    const DISCO_URL = 'http://127.0.0.1:' + DISCO + '/target.js';
    disco.setUrl(URL_A);
    printer.received.length = 0;
    appA.state.polls = 0;
    appB.state.polls = 0;
    appA.state.acked = [];
    appB.state.acked = [];
    appA.state.jobs = [];
    appB.state.jobs = [];

    agent = startAgent({ KPOT_DISCOVERY_URL: DISCO_URL, KPOT_DISCOVERY_MS: '1200' });

    const foundA = await waitFor(() => appA.state.polls >= 1, 15000);
    check('the agent found the address from the discovery page',
      foundA && appB.state.polls === 0,
      'polls A=' + appA.state.polls + ' B=' + appB.state.polls);
    check('and it says so in its log', /looked up automatically/.test(agent.log));

    /* Now move it: exactly what a re-publish does. Nothing is edited anywhere. */
    disco.setUrl(URL_B);

    const movedToB = await waitFor(() => appB.state.polls >= 1, 20000);
    check('it moved to the new address on its own, with nothing edited',
      movedToB, 'polls A=' + appA.state.polls + ' B=' + appB.state.polls);
    check('and it announced the move',
      /has moved to http:\/\/127\.0\.0\.1:8962/.test(agent.log),
      agent.log.split('\n').filter((l) => /moved/.test(l)).join(' | ') || '(no move line)');

    /* And it must actually WORK at the new address, not merely poll it. */
    appB.state.jobs = [{ id: 'J2', orderId: 'KP-DISC-2', bytes: Buffer.from('TICKET-2').toString('base64') }];
    const printed2 = await waitFor(() => printer.received.length >= 1, 15000);
    check('a ticket queued at the NEW address gets printed',
      printed2, 'tickets=' + printer.received.length);
    check('and the result is reported back to the new address',
      appB.state.acked.includes('J2'), 'acked B=' + JSON.stringify(appB.state.acked));
    check('and NOT to the address it moved away from',
      !appA.state.acked.includes('J2'), 'acked A=' + JSON.stringify(appA.state.acked));

    agent.kill();
    await sleep(400);

    /* ---- the old domain answering 400 (what the platform actually does) -- */
    section('the old address answers 400, and the re-check is not due yet');
    /* A LONG discovery interval on purpose: if the agent reaches B, it can only
       be because the 400 triggered a re-resolve, not because the clock ran out.
       Without this, a "it recovered" assertion passes on the periodic path and
       proves nothing about the 400 path. */
    disco.setUrl(URL_A);
    disco.setServe(true);
    appA.state.mode = 'ok';
    appA.state.polls = 0;
    appB.state.polls = 0;
    appA.state.jobs = [];
    appB.state.jobs = [];

    agent = startAgent({ KPOT_DISCOVERY_URL: DISCO_URL, KPOT_DISCOVERY_MS: '600000' });
    const atA = await waitFor(() => appA.state.polls >= 1, 15000);
    check('the agent is at the old address', atA, 'polls A=' + appA.state.polls);

    /* The re-publish: the old domain starts answering 400, discovery points
       at the new one. The next discovery interval is 10 minutes away. */
    appA.state.mode = 'gone';
    disco.setUrl(URL_B);

    const recovered = await waitFor(() => appB.state.polls >= 1, 20000);
    check('a 400 makes it re-resolve immediately instead of waiting 10 minutes',
      recovered, 'polls A=' + appA.state.polls + ' B=' + appB.state.polls);
    check('and it says why', /answered 400/.test(agent.log),
      agent.log.split('\n').filter((l) => /400/.test(l)).join(' | ') || '(no 400 line)');

    /* ---- discovery breaking must not lose a working address ------------- */
    section('the discovery page has a bad moment');
    /* Give it a short interval again so the failure is actually attempted, and
       wait for the warning itself rather than for a proxy like "a ticket came
       out" — the ticket prints in 300ms, well before the first lookup retry. */
    agent.kill();
    await sleep(400);
    disco.setServe(true);
    appB.state.polls = 0;
    agent = startAgent({ KPOT_DISCOVERY_URL: DISCO_URL, KPOT_DISCOVERY_MS: '800' });
    await waitFor(() => appB.state.polls >= 1, 15000);

    /* Two DIFFERENT ways discovery can fail, and they take different branches:
       the page answering an error, and the page being unreachable at all. The
       second one used to go untested, and a falsification proved the assertion
       was not covering it. Test both. */
    disco.setServe(false);
    const warned500 = await waitFor(() => /address lookup returned HTTP 500/.test(agent.log), 12000);
    check('a discovery page that answers 500 is reported',
      warned500,
      agent.log.split('\n').filter((l) => /lookup/.test(l)).slice(-1)[0] || '(no lookup warning)');

    appB.state.jobs = [{ id: 'J3', orderId: 'KP-DISC-3', bytes: Buffer.from('TICKET-3').toString('base64') }];
    printer.received.length = 0;
    const printed3 = await waitFor(() => printer.received.length >= 1, 15000);
    check('and it keeps printing at the address it already has',
      printed3, 'tickets=' + printer.received.length);

    /* Now make the discovery page unreachable entirely (nothing listening). */
    agent.kill();
    await sleep(400);
    const DEAD_DISCO = 'http://127.0.0.1:' + (DISCO + 50) + '/target.js';
    appB.state.polls = 0;
    agent = startAgent({ KPOT_DISCOVERY_URL: DEAD_DISCO, KPOT_SERVER_URL: URL_B, KPOT_DISCOVERY_MS: '800' });
    const warnedDead = await waitFor(() => /address lookup failed/.test(agent.log), 12000);
    check('a discovery page that cannot be reached is reported too',
      warnedDead,
      agent.log.split('\n').filter((l) => /lookup/.test(l)).slice(-1)[0] || '(no lookup warning)');

    appB.state.jobs = [{ id: 'J4', orderId: 'KP-DISC-4', bytes: Buffer.from('TICKET-4').toString('base64') }];
    printer.received.length = 0;
    const printed4 = await waitFor(() => printer.received.length >= 1, 15000);
    check('and the fallback address still prints',
      printed4, 'tickets=' + printer.received.length);

    const errs = (agent.log.match(/unexpected error/g) || []).length;
    check('the agent logged no unexpected errors', errs === 0, 'count=' + errs);
  } catch (e) {
    check('suite ran to completion', false, e.stack || e.message);
    if (agent) console.log('\n--- agent log ---\n' + agent.log);
  } finally {
    await cleanup();
    await sleep(200);
    console.log('\n' + pass + ' passed, ' + fail + ' failed');
    process.exit(fail ? 1 : 0);
  }
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
