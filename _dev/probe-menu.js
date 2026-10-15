/* Probe admin-menu.html: install button + manifest only. */
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(400);

  const installHost = document.getElementById('installHost');
  const installBtns = installHost ? installHost.querySelectorAll('.install-btn') : [];
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
    staffPWA: typeof window.StaffPWA,
    swState,
    hasSave: !!document.getElementById('save')
  };
})()