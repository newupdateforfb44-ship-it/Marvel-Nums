/* Marvel Nums: the spinning Marvel loader has been removed.
   Pages now show instantly; the browser's own page load is the only "loading" state.
   This file keeps the MVNLoader API as no-ops so existing calls on other pages keep working. */
(function () {
  'use strict';
  if (window.MVNLoader) return;
  var noop = function () {};
  window.MVNLoader = { show: noop, hide: noop, reset: noop };
})();
