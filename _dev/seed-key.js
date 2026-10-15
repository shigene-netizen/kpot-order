/* Seed the admin key into sessionStorage so the board's /api/orders call
   succeeds without a 401. The page reads sessionStorage on boot — localStorage
   is used for the notification toggle only. */
(function () {
  try { sessionStorage.setItem('kpotAdminKey', 'DeL93JJudHjA'); } catch (e) {}
})();