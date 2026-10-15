/* Seed a cart that is OVER the $30 counter ceiling (3 bowls, $47.97 + tax). */
try {
  localStorage.setItem('kpot.cart.v1', JSON.stringify([
    { uid: 'seed-3', qty: 3, name: 'Hot Pot To Go', unit: 15.99, kind: 'hotpot', mods: [], addons: [], note: '', sig: '["Hot Pot To Go",[],[]]' }
  ]));
  localStorage.removeItem('kpot.last.v1');
  localStorage.removeItem('kpot.history.v1');
} catch (e) {}
