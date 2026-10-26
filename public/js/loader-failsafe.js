/* Marvel Nums loader failsafe: no loading screen may stay on screen forever. */
(function () {
  window.addEventListener('pageshow', function () { try { window.MVNLoader && window.MVNLoader.reset(); } catch (e) {} });
})();
