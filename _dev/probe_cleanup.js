/* ==========================================================================
   Shared teardown for the browser probes.

   Two things the naive `child.kill(); fs.rmSync(dir, {recursive:true})` gets
   wrong on Windows, both of which we hit for real:

     1. `child.kill()` only signals the process you spawned. Chrome is a tree
        (browser + gpu + network + renderers), so the children can outlive it.

     2. Deleting the --user-data-dir immediately afterwards RACES the tree's
        shutdown. Chrome still holds handles in there for a moment, rmSync
        throws EBUSY, and because every caller wraps it in try/catch the failure
        is silent — so each run leaves a 10–95 MB profile directory behind and
        nobody notices. (Measured: 22 MB and 12 MB left by two runs of one
        probe, plus 94 MB each from older suites.) Nothing here can fix dirs
        already on disk, but it stops adding more.

   So: kill the whole tree, WAIT for it to actually die, then delete with
   retries. Cleanup must also never throw and never hang — a teardown that
   hangs is worse than one that leaves a temp dir.
   ========================================================================== */

'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Kill the process AND its children. */
function killTree(child) {
  if (!child || child.pid == null) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { child.kill('SIGKILL'); }
    }
  } catch (e) { /* already gone */ }
}

/* Delete a directory, retrying while the OS releases handles.
   Returns true if it is gone. Never throws. */
async function removeDir(dir, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
      return true;
    } catch (e) {
      await sleep(300);
    }
  }
  return !fs.existsSync(dir);
}

/* Tear everything down and report what could not be removed, so a leak shows
   up as a line of output instead of as silence. */
async function teardown(children, dirs) {
  for (const c of children) killTree(c);
  await sleep(600);                       // let the trees actually exit
  const stuck = [];
  for (const d of dirs) {
    if (!d) continue;
    if (!(await removeDir(d))) stuck.push(d);
  }
  if (stuck.length) {
    console.log('\n(cleanup note: could not remove ' + stuck.join(', ') +
      ' — harmless, but it will linger in %TEMP%)');
  }
}

module.exports = { killTree, removeDir, teardown, sleep };
