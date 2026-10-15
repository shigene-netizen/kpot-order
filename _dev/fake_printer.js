#!/usr/bin/env node
/* A fake thermal printer.
   --------------------------------------------------------------------------
   A real ESC/POS network printer is just a TCP server that accepts bytes on
   port 9100 and prints them. So a test can stand one up in-process, let the
   real print agent talk to it, and then assert on exactly what arrived — with
   no hardware, no driver, and no paper.

   Usable two ways:

     // in-process (what the probe does — lets it assert on what was received)
     const { createFakePrinter } = require('./fake_printer.js');
     const fp = createFakePrinter();
     await fp.listen(9100);
     ... later ...
     fp.received   // array of Buffers, one per connection

     # standalone, for poking at the agent by hand
     node _dev/fake_printer.js 9100

   Options for simulating a broken printer:
     fail: true        refuse the connection outright (printer switched off)
     dropAfter: N      accept, swallow N bytes, then destroy the socket
                       (paper jam / cable pulled mid-ticket)
*/
'use strict';

const net = require('net');

function createFakePrinter(opts) {
  const o = opts || {};
  const received = [];
  const log = [];

  const server = net.createServer((sock) => {
    if (o.fail) { log.push('refused a connection (simulated offline)'); sock.destroy(); return; }

    const chunks = [];
    let seen = 0;
    sock.on('data', (d) => {
      chunks.push(d);
      seen += d.length;
      if (o.dropAfter && seen >= o.dropAfter) {
        log.push('dropped the connection after ' + seen + ' bytes (simulated jam)');
        sock.destroy();
      }
    });
    sock.on('end', () => {
      const buf = Buffer.concat(chunks);
      received.push(buf);
      log.push('received ' + buf.length + ' bytes');
    });
    sock.on('error', () => { /* the agent may hang up early; that is fine */ });
  });

  return {
    server,
    received,
    log,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host || '127.0.0.1', () => resolve(server.address()));
      });
    },
    close() {
      return new Promise((resolve) => {
        try { server.close(() => resolve()); } catch (e) { resolve(); }
      });
    }
  };
}

module.exports = { createFakePrinter };

/* ---- standalone mode ---------------------------------------------------- */
if (require.main === module) {
  const port = parseInt(process.argv[2] || process.env.PRINTER_PORT || '9100', 10);
  const fp = createFakePrinter();
  fp.listen(port).then((addr) => {
    console.log('[fake-printer] listening on ' + addr.address + ':' + addr.port);
    console.log('[fake-printer] point print-agent/config.json at this address to test.');
    console.log('[fake-printer] received tickets will be dumped as text below.\n');
  }).catch((e) => { console.error('could not listen:', e.message); process.exit(1); });

  /* Re-dump every ticket as readable text so you can eyeball the layout. */
  let lastCount = 0;
  setInterval(() => {
    if (fp.received.length === lastCount) return;
    const buf = fp.received[fp.received.length - 1];
    lastCount = fp.received.length;
    console.log('===== ticket #' + lastCount + ' (' + buf.length + ' bytes) =====');
    console.log(buf.toString('latin1').replace(/\u001b[@aEt]\S?/g, '').replace(/\u001d.\S?/g, ''));
  }, 500);
}
