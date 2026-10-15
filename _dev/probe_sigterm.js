/* Does a Node child process actually receive SIGTERM on this platform?
   If not, the shutdown backup can never run and we need a different trigger. */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const child = path.join(require('os').tmpdir(), 'sig-child.js');
fs.writeFileSync(child, `
  process.on('SIGTERM', () => { console.log('GOT SIGTERM'); process.exit(0); });
  process.on('SIGINT',  () => { console.log('GOT SIGINT');  process.exit(0); });
  process.on('exit',    () => console.log('EXITING'));
  console.log('child pid', process.pid);
  setInterval(() => {}, 1000);
`);

const srv = spawn(process.execPath, [child], { stdio: ['ignore', 'pipe', 'pipe'] });
srv.stdout.on('data', (d) => process.stdout.write('[child] ' + d));
srv.stderr.on('data', (d) => process.stdout.write('[child-err] ' + d));
srv.on('exit', (c, s) => console.log('=> child exited code=' + c + ' signal=' + s));

setTimeout(() => { console.log('--- sending SIGTERM via srv.kill("SIGTERM")'); srv.kill('SIGTERM'); }, 1500);
setTimeout(() => {
  if (srv.exitCode === null && srv.signalCode === null) {
    console.log('!!! child STILL ALIVE after SIGTERM — it was NEVER delivered');
    srv.kill('SIGKILL');
  }
}, 3500);
setTimeout(() => process.exit(0), 5000);
