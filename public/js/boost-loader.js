/* Boost pages: keep the ONE Marvel Nums loader up until the page calls MvnBoostLoader.hide(). */
(function () {
  if (window.MvnBoostLoader) return;
  window.MvnBoostLoader = {
    show: function () { try { window.MVNLoader && window.MVNLoader.show('boost'); } catch (e) {} },
    hide: function () { try { window.MVNLoader && window.MVNLoader.hide('boost'); } catch (e) {} }
  };
  window.MvnBoostLoader.show();
})();
