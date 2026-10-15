/* Probe admin-orders.html: install button + notify button + manifest.
   Returns the count of install buttons inside #installHost, the visibility of
   the notify button, the manifest href, and whether the SW registered. */
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(400);

  const installHost = document.getElementById('installHost');
  const installBtns = installHost ? installHost.querySelectorAll('.install-btn') : [];
  const notifyBtn = document.getElementById('notifyBtn');

  /* The SW registration is async; give it a beat to settle. */
  let swState = 'absent';
  if (navigator.serviceWorker) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      swState = reg ? (reg.active ? 'active' : 'installing') : 'absent';
    } catch (e) { swState = 'error:' + e.message; }
  }

  return {
    title: document.title,
    manifestHref: (document.querySelector('link[rel="manifest"]') || {}).href || null,
    installBtnCount: installBtns.length,
    installBtnText: installBtns[0] ? installBtns[0].textContent.trim() : null,
    notifyBtnHidden: notifyBtn ? notifyBtn.hidden : null,
    notifyBtnText: notifyBtn ? notifyBtn.textContent.trim() : null,
    staffPWA: typeof window.StaffPWA,
    swState,
    staffPWAInitCallable: !!(window.StaffPWA && window.StaffPWA.init)
  };
})()