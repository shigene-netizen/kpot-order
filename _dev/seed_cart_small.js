/* Seed a cart that is UNDER the $30 counter ceiling (1 bowl, $15.99). */
try {
  localStorage.setItem('kpot.cart.v1', JSON.stringify([
    { uid: 'seed-1', qty: 1, name: 'Hot Pot To Go', unit: 15.99, kind: 'hotpot', mods: [], addons: [], note: '', sig: '["Hot Pot To Go",[],[]]' }
  ]));
  localStorage.removeItem('kpot.last.v1');
  localStorage.removeItem('kpot.history.v1');
} catch (e) {}
