/* Open the cart, go to checkout, and report how the payment options render. */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const q = (s) => document.querySelector(s);
  const txt = (el) => (el ? el.textContent.trim() : null);

  const cartBtn = q('#cartBtn');
  if (!cartBtn) return { error: 'no #cartBtn' };
  cartBtn.click();
  await sleep(700);

  const go = q('#toCheckout');
  if (!go) return { error: 'no #toCheckout', body: txt(q('#sheetBody')) && txt(q('#sheetBody')).slice(0, 120) };
  go.click();
  await sleep(1000);

  const opts = Array.from(document.querySelectorAll('#sheetBody [data-pay]')).map((b) => ({
    pay: b.dataset.pay,
    on: b.classList.contains('on'),
    disabled: b.disabled === true,
    title: txt(b.querySelector('b')),
    sub: txt(b.querySelector('small'))
  }));

  return {
    total: txt(q('#sheetFoot .total b')),
    selected: (opts.filter((o) => o.on)[0] || {}).pay || null,
    opts: opts,
    hint: txt(q('#payHint')),
    stripeBoxShown: !!txt(q('#stripeBox'))
  };
})()
