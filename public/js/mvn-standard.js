/* Marvel Nums standard clean behaviour: a tap on a card/link/button goes
   straight to the next page, with no focus box, flash or text selection. */
(function () {
  function isField(el) {
    return el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || (el && el.isContentEditable);
  }
  // Drop focus right after a mouse/touch click so no ring or box stays behind
  document.addEventListener('mouseup', function (e) {
    var t = e.target && e.target.closest && e.target.closest('a,button,[role="button"],.dsh-svc-item,.card,.tile');
    if (t && !isField(t) && t.blur) setTimeout(function () { t.blur(); }, 0);
  }, true);
  document.addEventListener('touchend', function (e) {
    var t = e.target && e.target.closest && e.target.closest('a,button,[role="button"],.dsh-svc-item,.card,.tile');
    if (t && !isField(t) && t.blur) setTimeout(function () { t.blur(); }, 0);
  }, { passive: true, capture: true });
  // No long-press menu / drag ghost on links, icons and images inside links
  document.addEventListener('dragstart', function (e) {
    if (e.target && e.target.closest && e.target.closest('a,button')) e.preventDefault();
  }, true);
  document.addEventListener('contextmenu', function (e) {
    var t = e.target && e.target.closest && e.target.closest('.dsh-svc-item,.kw-dock a,.dd-item');
    if (t && ('ontouchstart' in window)) e.preventDefault();
  }, true);
  // Clear any text selection a quick double tap may leave on a card
  document.addEventListener('selectstart', function (e) {
    var t = e.target && e.target.nodeType === 1 ? e.target : (e.target && e.target.parentElement);
    if (t && t.closest && t.closest('a,button,.dsh-svc-item,.kw-dock') && !isField(t)) e.preventDefault();
  }, true);
})();
