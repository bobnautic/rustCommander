// Apply the last used theme before the bundle loads to avoid a flash.
// Kept as a file (not inline) so a strict Content-Security-Policy allows it.
(function () {
  try {
    var t = localStorage.getItem('rc.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
