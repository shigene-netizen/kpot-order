/* Read the payment badges off the kitchen board's order cards. */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(3000);
  const cards = Array.from(document.querySelectorAll('.order')).map((c) => ({
    id: ((c.querySelector('.o-no') || {}).textContent || '').trim(),
    badges: Array.from(c.querySelectorAll('.o-head .pill')).map((p) => ({
      cls: p.className,
      text: p.textContent.trim()
    }))
  }));
  return {
    shown: cards.length,
    cards: cards.filter((c) => /KP-BADGE/.test(c.id))
  };
})()
