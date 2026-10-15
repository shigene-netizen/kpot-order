/* On the customer storefront: verify the ready-notification options use the
   notification-specific assets (not the app tile) and that both files exist. */
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  await sleep(1500);
  const out = { notifs: (window.__notifs || []).map(n => ({
    title: n.title,
    via: n.via || 'ctor',
    icon: n.opts.icon,
    badge: n.opts.badge,
    tag: n.opts.tag
  })) };
  /* Also HEAD-probe the two files the app will ask the OS to fetch. */
  for (const p of ['assets/icon-notify-192.png', 'assets/icon-notify-badge.png']) {
    const r = await fetch(p, { method: 'HEAD' });
    out[p] = r.status;
  }
  return out;
})()