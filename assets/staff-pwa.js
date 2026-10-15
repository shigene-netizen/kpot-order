/* Staff PWA helpers — "Add to Home Screen" + notifications for the back office.
   --------------------------------------------------------------------------
   Shared by admin-orders.html (kitchen board), admin.html and admin-menu.html.

   The awkward part is that `beforeinstallprompt` is NOT guaranteed to fire:
     - Chrome only fires it once its engagement heuristics are satisfied, so a
       page can be installable via the browser menu and still never get the
       event. (It also still requires a service worker with a fetch handler —
       see sw.js — even though menu install dropped that requirement in 112.)
     - iOS Safari never fires it at all; everything installs from the Share menu.
   So the install button is always shown, and clicking it either runs the real
   prompt or falls back to instructions for whichever browser we're on. A button
   that silently does nothing would be worse than no button. */
(function () {
  'use strict';

  var deferred = null;          // captured beforeinstallprompt event
  var swReg = null;             // service worker registration

  function $(s) { return document.querySelector(s); }

  /* ---------------------------------------------------------------- install */

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
           window.navigator.standalone === true;
  }

  function platform() {
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
    if (/Android/.test(ua)) return 'android';
    if (/Mac/.test(ua)) return 'mac';
    return 'desktop';
  }

  function howToText() {
    var p = platform();
    if (p === 'ios') {
      return 'On iPhone/iPad: tap the Share button (the square with an arrow), ' +
             'then choose "Add to Home Screen".';
    }
    if (p === 'android') {
      return 'In Chrome: tap the ⋮ menu in the top right, then "Install app" ' +
             '(or "Add to Home screen").';
    }
    if (p === 'mac') {
      return 'In Chrome: click the install icon on the right of the address bar, ' +
             'or use Menu → "Install KPOT…". In Safari: File → "Add to Dock".';
    }
    return 'In Chrome or Edge: click the install icon on the right of the ' +
           'address bar, or open the browser menu and choose "Install".';
  }

  /* Render the install button into `host`, or hide it when already installed. */
  function mountInstall(host) {
    if (!host) return;
    var btn = document.createElement('button');
    btn.className = 'btn install-btn';
    btn.type = 'button';
    btn.innerHTML = '📲 Add to Home Screen';
    host.appendChild(btn);

    var note = document.createElement('div');
    note.className = 'install-note';
    note.hidden = true;
    host.appendChild(note);

    function showNote(msg) {
      note.textContent = msg;
      note.hidden = false;
    }

    btn.onclick = function () {
      note.hidden = true;
      if (deferred) {
        deferred.prompt();
        deferred.userChoice.then(function (choice) {
          if (choice && choice.outcome === 'accepted') showNote('Installing…');
          deferred = null;
        });
        return;
      }
      /* No event: either already installed, or this browser installs from a
         menu. Tell the user where to look instead of doing nothing. */
      showNote(isStandalone()
        ? 'This is already running as an installed app.'
        : howToText());
    };

    /* Hide the button once it's genuinely installed. */
    window.addEventListener('appinstalled', function () {
      deferred = null;
      btn.hidden = true;
      showNote('Installed. Open it from your home screen.');
    });

    if (isStandalone()) btn.hidden = true;
  }

  /* ---------------------------------------------------------- notifications */

  function notifySupported() {
    return typeof Notification !== 'undefined';
  }

  function notifyPermission() {
    return notifySupported() ? Notification.permission : 'unsupported';
  }

  /* Ask for permission. MUST be called from a real user gesture — browsers
     ignore (or auto-deny) a request that isn't. */
  function requestNotify() {
    if (!notifySupported()) return Promise.resolve('unsupported');
    return Notification.requestPermission().then(function (p) { return p; });
  }

  /* Prefer the service-worker route: those notifications survive the tab being
     backgrounded and pick up the manifest icon. Fall back to the plain
     constructor when there's no registration yet.

     Two different assets on purpose:
       - `icon` is the large thumbnail shown in the notification body. A red
         disc on a TRANSPARENT square, so a rounded/circular notification
         thumbnail doesn't clip a red square into a broken shape.
       - `badge` is the tiny status-bar mark. Android/Linux draw it as an ALPHA
         MASK — the colour is thrown away and only the shape survives — so it
         must be a transparent PNG with the glyph in opaque pixels. Handing it
         the full-colour app tile is what produced the small white box the
         owner saw: an opaque tile masks to a solid blob. */
  function notify(title, opts) {
    opts = opts || {};
    var o = {
      body: opts.body || '',
      tag: opts.tag || 'kpot-staff',
      icon: 'assets/icon-notify-192.png',
      badge: 'assets/icon-notify-badge.png',
      requireInteraction: opts.requireInteraction !== false,
      data: { url: opts.url || './' }
    };
    if (swReg && swReg.showNotification) {
      try { swReg.showNotification(title, o); return true; } catch (e) { /* fall through */ }
    }
    if (!notifySupported() || Notification.permission !== 'granted') return false;
    try { new Notification(title, o); return true; } catch (e) { return false; }
  }

  /* A short two-tone chime synthesised on the fly, so we don't have to ship an
     audio file. Audio needs a prior user gesture on most browsers, which is why
     the enable button exists — clicking it unlocks playback. */
  var actx = null;
  function chime() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended') actx.resume();
      [880, 1320].forEach(function (f, i) {
        var osc = actx.createOscillator();
        var g = actx.createGain();
        osc.type = 'sine';
        osc.frequency.value = f;
        var t = actx.currentTime + i * 0.16;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
        osc.connect(g); g.connect(actx.destination);
        osc.start(t); osc.stop(t + 0.36);
      });
    } catch (e) { /* audio is a nicety, never block on it */ }
  }

  /* -------------------------------------------------------------------- boot */

  function init(opts) {
    opts = opts || {};
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(function (r) { swReg = r; })
        .catch(function () { /* offline support is optional */ });
    }
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
    });
    mountInstall(opts.installHost || document.getElementById('installHost'));
  }

  window.StaffPWA = {
    init: init,
    notify: notify,
    chime: chime,
    requestNotify: requestNotify,
    notifyPermission: notifyPermission,
    notifySupported: notifySupported,
    isStandalone: isStandalone
  };
})();
