/* Directly exercise StaffPWA.notify() and report the options it built. */
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(1200);
  if (!window.StaffPWA) return { error: 'StaffPWA missing' };
  window.StaffPWA.notify('test', { body: 'b', tag: 'probe' });
  await sleep(200);
  return {
    captured: (window.__notifs || []).map(n => ({
      title: n.title, via: n.via || 'ctor', icon: n.opts.icon, badge: n.opts.badge
    })),
    perm: window.StaffPWA.notifyPermission(),
    swActive: navigator.serviceWorker ? !!(await navigator.serviceWorker.getRegistration()) : false
  };
})()