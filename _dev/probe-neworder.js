/* End-to-end probe: confirm the kitchen board sees a new order arrive, rings
   the bell, and tags the card with .fresh. We POST the order from the page
   itself (so the secret never leaves the browser context), then wait for the
   4s tick + a small buffer. */
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const KEY = 'DeL93JJudHjA';
  /* Wait for the first load to seed `seen` without firing notifications. */
  await sleep(800);

  const beforeCount = document.querySelectorAll('#list .order').length;

  /* Send a fresh order straight to the API with the right header. The server
     recomputes prices, so the payload only needs the bare minimum. */
  const payload = {
    orderType: 'pickup',
    customer: { name: 'CDP Test', phone: '555-0100', when: 'ASAP', notes: '' },
    items: [{ name: 'Thai Milk Tea', qty: 2, unit: 4.99, mods: [], addons: [], note: '' }],
    payMethod: 'counter',
    /* Server recomputes from items + tax + tip; the client-supplied total has
       to agree within 2¢ or the order is rejected. 2 × $4.99 = $9.98 subtotal
       + 6% tax (CONFIG.taxRate) = $10.58, with $0 tip. */
    total: 10.58
  };
  const post = await fetch('/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Key': KEY },
    body: JSON.stringify(payload)
  });
  const postJson = await post.json().catch(() => null);
  const newId = postJson && postJson.id;

  /* Wait long enough for the board's 4s poll + render. */
  await sleep(5000);

  /* Re-query live each time — re-renders invalidate references. */
  const afterCount = document.querySelectorAll('#list .order').length;
  const freshCards = Array.from(document.querySelectorAll('#list .order.fresh'))
    .map(el => el.dataset.id);
  const matchedFresh = newId && freshCards.includes(newId);
  const ourCard = newId ? document.querySelector('#list .order[data-id="' + newId + '"]') : null;
  const ourCardText = ourCard ? ourCard.textContent.replace(/\s+/g, ' ').trim().slice(0, 140) : null;

  return {
    postedOk: post.ok,
    postedStatus: post.status,
    newId,
    beforeCount,
    afterCount,
    freshCards,
    matchedFresh,
    ourCardText,
    seenState: typeof seen !== 'undefined' ? seen.size : 'undefined'
  };
})()