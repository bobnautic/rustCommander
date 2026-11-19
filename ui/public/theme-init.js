// Apply the last used theme and skin before the bundle loads to avoid a flash.
// Kept as a file (not inline) so a strict Content-Security-Policy allows it.
// `rc.look` is written by src/lib/skins/apply.ts: the resolved skin for a light and a dark
// system setting (CSS custom properties + root classes).
(function () {
  var root = document.documentElement;
  try {
    var t = localStorage.getItem('rc.theme') || 'system';
    var dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    var look = JSON.parse(localStorage.getItem('rc.look') || 'null');
    var v = look && look[dark ? 'dark' : 'light'];
    if (v && v.vars) {
      for (var k in v.vars) {
        if (k.indexOf('--') === 0 && typeof v.vars[k] === 'string') root.style.setProperty(k, v.vars[k]);
      }
      for (var i = 0; v.classes && i < v.classes.length; i++) root.classList.add(String(v.classes[i]));
      dark = v.scheme === 'dark';
    }
    root.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    root.dataset.theme = 'light';
  }
})();
