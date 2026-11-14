/* Marvel Nums smooth-motion helpers: page-leave fade, scroll reveal, tap ripple. No dependencies. */
(function () {
  if (window.__mvSmooth) return; window.__mvSmooth = true;
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 1. fade out before navigating to another page on this site */
  document.addEventListener('click', function (e) {
    if (reduce || e.defaultPrevented || e.button || e.metaKey || e.ctrlKey || e.shiftKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var u; try { u = new URL(a.href, location.href); } catch (x) { return; }
    if (u.origin !== location.origin || (u.pathname === location.pathname && u.search === location.search) || /^\/api\//.test(u.pathname)) return;
    /* no leave fade: next page paints instantly */ return;
    setTimeout(function () { document.documentElement.classList.remove('mv-leaving'); }, 1500); /* safety if navigation is cancelled */
  }, true);
  window.addEventListener('pageshow', function () { document.documentElement.classList.remove('mv-leaving'); });

  /* 2. scroll reveal with a gentle stagger for cards, tiles and rows */
  var SEL = '.card,.panel,.choice,.dsh-card,.dsh-svc-item,.tool-card,.prod-card,.product-card,.market-card,.service-card,.order-card,.mkt-card,.stat-card,.wal-card,details.panel';
  var io = ('IntersectionObserver' in window && !reduce) ? new IntersectionObserver(function (es) {
    es.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('mv-in'); io.unobserve(en.target); } });
  }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 }) : null;
  function reveal(root) {
    if (!io) return;
    var n = 0;
    (root || document).querySelectorAll(SEL).forEach(function (el) {
      if (el.__mv || el.closest('.mvn-drawer,#mvnBackBar,[role=dialog],.sheet,.modal')) return;
      el.__mv = 1; el.classList.add('mv-reveal'); el.style.setProperty('--mv-d', Math.min(n++ % 8, 7) * 55 + 'ms'); io.observe(el);
    });
  }
  function boot() {
    /* reveal disabled: content is visible immediately */
    return;
    reveal();
    /* cards that load later (orders, lists, products) also glide in */
    if (window.MutationObserver && io) {
      var t; new MutationObserver(function () { clearTimeout(t); t = setTimeout(reveal, 80); }).observe(document.body, { childList: true, subtree: true });
    }
    /* "Loading…" placeholders get a soft shimmer */
    document.querySelectorAll('#orders,#list,.muted').forEach(function (el) {
      if (/^\s*Loading/i.test(el.textContent) && el.children.length === 0) el.classList.add('mv-skel');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  /* 3. tap ripple on main buttons */
  document.addEventListener('pointerdown', function (e) {
    if (reduce) return;
    var b = e.target.closest && e.target.closest('button.btn,.btn,.kw-primary,.yes,#buy,#go,button[type=submit]');
    if (!b || b.disabled) return;
    var r = b.getBoundingClientRect(), d = Math.max(r.width, r.height) * 1.6, s = document.createElement('span');
    s.className = 'mv-ripple'; s.style.cssText = 'width:' + d + 'px;height:' + d + 'px;left:' + (e.clientX - r.left - d / 2) + 'px;top:' + (e.clientY - r.top - d / 2) + 'px';
    var cs = getComputedStyle(b); if (cs.position === 'static') b.style.position = 'relative'; b.style.overflow = 'hidden';
    b.appendChild(s); setTimeout(function () { s.remove(); }, 650);
  }, { passive: true });
})();
