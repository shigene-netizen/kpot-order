/* Capture the options object passed to the Notification constructor on the
   STAFF board. Installs a stub before page scripts run so we can inspect
   icon/badge without needing a real permission grant. */
(function () {
  window.__notifs = [];
  var Real = window.Notification;
  function Fake(title, opts) {
    window.__notifs.push({ title: title, opts: opts || {} });
    this.title = title; this.opts = opts || {};
    this.close = function () {};
    this.onclick = null;
  }
  Fake.permission = 'granted';
  Fake.requestPermission = function () { return Promise.resolve('granted'); };
  window.Notification = Fake;
  /* The board asks StaffPWA.notifyPermission() — that reads Notification.permission,
     so the stub above is enough. swReg may exist and take the SW path instead, so
     also stub showNotification if a registration appears. */
  if (navigator.serviceWorker) {
    navigator.serviceWorker.ready.then(function (reg) {
      if (reg) reg.showNotification = function (title, opts) {
        window.__notifs.push({ title: title, opts: opts || {}, via: 'sw' });
      };
    }).catch(function () {});
  }
})();