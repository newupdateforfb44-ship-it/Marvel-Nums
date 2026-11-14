/* Marvel Nums pro helpers: hide floating buttons while scrolling, close sheets with Escape / back swipe. */
(function () {
  'use strict'; if (window.__mvPro) return; window.__mvPro = true;
  var t = null, root = document.documentElement;
  window.addEventListener('scroll', function () {
    root.classList.add('mv-scrolling'); clearTimeout(t);
    t = setTimeout(function () { root.classList.remove('mv-scrolling'); }, 650);
  }, { passive: true });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var o = document.querySelector('.modal-overlay.open'); if (o) o.classList.remove('open');
  });
  document.addEventListener('click', function (e) {
    var o = e.target; if (o && o.classList && o.classList.contains('modal-overlay') && o.classList.contains('open')) o.classList.remove('open');
  });
  /* stack the bell + search buttons neatly above the support button (no overlaps) */
  function stack() {
    try {
      var fabs = [].slice.call(document.querySelectorAll('.mx-fab'));
      var base = 18 + 52 + 12, gap = 10;
      fabs.forEach(function (f, i) {
        f.style.setProperty('top', 'auto', 'important');
        f.style.setProperty('bottom', 'calc(var(--mp-nav-h,0px) + ' + (base + i * (40 + gap)) + 'px + env(safe-area-inset-bottom,0px))', 'important');
      });
    } catch (e) {}
  }
  var n = 0, iv = setInterval(function () { stack(); if (++n > 12) clearInterval(iv); }, 400);
  document.addEventListener('DOMContentLoaded', stack);
})();
