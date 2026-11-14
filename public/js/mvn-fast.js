/* Marvel Nums FAST layer (loads first on every page).
   1. Catalog data (products, services, countries, servers, notices...) is shown instantly from the
      last copy saved on this device, then refreshed quietly for the NEXT visit. The screen is never
      re-drawn a second time, so nothing jumps while the customer is looking at it.
   2. Pages the customer is about to open are pre-loaded on touch / hover.
   3. After login the main catalogs are warmed in the background so Marketplace, Boost and Buy Number
      open already filled.
   Only public catalog GET requests are cached. Wallet, orders, purchases and every POST always go live. */
(function () {
  'use strict';
  if (window.__mvnFast) return; window.__mvnFast = true;
  var realFetch = window.fetch ? window.fetch.bind(window) : null;
  if (!realFetch) return;

  var PREFIX = 'mvnf1:';
  var MAX_AGE = 30 * 60 * 1000;       // a saved copy older than this is ignored
  var MAX_BYTES = 600 * 1024;          // never store huge payloads
  /* exact catalog endpoints (query string allowed). Anything else is never cached. */
  var CATALOG = [
    '/api/categories', '/api/logs', '/api/countries', '/api/boost/services',
    '/api/numbers/live-countries', '/api/numbers/live-services', '/api/numbers/n3-servers',
    '/api/numbers/n2/countries', '/api/numbers/n2/services', '/api/numbers/n2/servers',
    '/api/market2/products', '/api/market3/products', '/api/market4/products', '/api/websites', '/api/brand-logos',
    '/api/number-notice', '/api/public/site-links', '/api/site-links', '/api/tutorials',
    '/api/deposit-tutorials', '/api/market/status', '/api/n3/status', '/api/public/stats',
    '/api/intl/rates', '/api/welcome-popup', '/api/rentals/countries', '/api/temp-email/options'
  ];
  var WARM = ['/api/categories', '/api/logs?type=log', '/api/boost/services', '/api/numbers/live-countries',
              '/api/public/site-links', '/api/number-notice', '/api/market/status',
              '/api/numbers/n2/servers', '/api/rentals/countries', '/api/temp-email/options'];

  function pathOf(u) { try { return new URL(u, location.href).pathname; } catch (e) { return ''; } }
  function isCatalog(u) { var p = pathOf(u); for (var i = 0; i < CATALOG.length; i++) if (CATALOG[i] === p) return true; return false; }
  function authOf(init, req) {
    var h = (init && init.headers) || (req && req.headers) || null, v = '';
    try { if (h) { v = typeof h.get === 'function' ? (h.get('Authorization') || '') : (h.Authorization || h.authorization || ''); } } catch (e) {}
    return v ? 'a' + String(v).slice(-8) : 'n';
  }
  function keyOf(u, init, req) { var x = new URL(u, location.href); return PREFIX + x.pathname + x.search + '|' + authOf(init, req); }
  function read(k) {
    try { var o = JSON.parse(localStorage.getItem(k) || 'null'); if (o && Date.now() - o.t < MAX_AGE) return o; } catch (e) {}
    return null;
  }
  function write(k, body, type) {
    try { if (body.length > MAX_BYTES) return; localStorage.setItem(k, JSON.stringify({ t: Date.now(), b: body, c: type })); }
    catch (e) { prune(); }
  }
  function prune() {
    try { var ks = []; for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (k && k.indexOf(PREFIX) === 0) ks.push(k); } ks.forEach(function (k) { localStorage.removeItem(k); }); } catch (e) {}
  }
  var inflight = {};
  function refresh(k, u, init) {
    if (inflight[k]) return inflight[k];
    var p = realFetch(u, init).then(function (r) {
      if (!r.ok) return r;
      var type = r.headers.get('content-type') || 'application/json';
      if (type.indexOf('json') < 0) return r;
      return r.clone().text().then(function (t) { write(k, t, type); return r; });
    }).catch(function () {}).then(function (r) { delete inflight[k]; return r; });
    inflight[k] = p; return p;
  }

  window.fetch = function (input, init) {
    try {
      var isReq = typeof Request !== 'undefined' && input instanceof Request;
      var url = isReq ? input.url : String(input);
      var method = ((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
      if (method === 'GET' && isCatalog(url) && !(init && init.__live)) {
        var key = keyOf(url, init, isReq ? input : null);
        var hit = read(key);
        var clean = init ? Object.assign({}, init) : {};
        if (hit) {
          refresh(key, url, clean);   // quiet refresh: only updates the saved copy for next time
          return Promise.resolve(new Response(hit.b, { status: 200, headers: { 'Content-Type': hit.c, 'X-Mvn-Cache': 'hit' } }));
        }
        return refresh(key, url, clean).then(function (r) { return r && r.clone ? r.clone() : realFetch(input, init); });
      }
      if (method !== 'GET' && /\/(buy|order|orders|purchase|cancel|deposit)/i.test(pathOf(url))) {
        return realFetch(input, init).then(function (r) { try { if (r && r.ok) prune(); } catch (e) {} return r; });
      }
    } catch (e) {}
    return realFetch(input, init);
  };


  /* start THIS page's main data request immediately (before the page scripts even finish loading) */
  var PRELOAD = [
    [/^\/(marketplace|logs)(\/|$)/i, ['/api/market/status', '/api/logs?type=log', '/api/categories']],
    [/^\/marketplace2/i, ['/api/market2/products']],
    [/^\/marketplace3/i, ['/api/market3/products']],
    [/^\/marketplace4/i, ['/api/market4/products']],
    [/^\/(boost|boost1|boost2|boost-services)(\.html)?$/i, ['/api/boost/services']],
    [/^\/buy-number-?(2|otp)/i, ['/api/numbers/n2/servers', '/api/number-notice']],
    [/^\/rental/i, ['/api/rentals/countries']],
    [/^\/temp-email/i, ['/api/temp-email/options']],
    [/^\/buy-number/i, ['/api/numbers/live-countries', '/api/number-notice']],
    [/^\/websites/i, ['/api/websites']]
  ];
  function preloadPage() {
    try {
      var tok = localStorage.getItem('mvn_token'); if (!tok) return;
      var path = location.pathname.replace(/\.html$/i, '');
      for (var i = 0; i < PRELOAD.length; i++) {
        if (!PRELOAD[i][0].test(path) && !PRELOAD[i][0].test(location.pathname)) continue;
        PRELOAD[i][1].forEach(function (u) {
          var init = { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok } };
          var k = keyOf(u, init, null); if (!read(k)) refresh(k, u, init); else refresh(k, u, init);
        });
        break;
      }
    } catch (e) {}
  }
  preloadPage();

  /* never keep one person's cached data after logout / login switch */
  window.addEventListener('storage', function (e) { if (e.key === 'mvn_token') prune(); });
  window.MVNFast = { clear: prune };

  /* warm the catalogs after the first paint (logged-in only) */
  function warm() {
    try {
      if (!localStorage.getItem('mvn_token')) return;
      var tok = localStorage.getItem('mvn_token');
      WARM.forEach(function (u, i) {
        setTimeout(function () {
          var init = { headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok } };
          var k = keyOf(u, init, null); var hit = read(k);
          if (!hit || Date.now() - hit.t > 60 * 1000) refresh(k, u, init);
        }, 400 + i * 250);
      });
    } catch (e) {}
  }
  function idle(f) { (window.requestIdleCallback || function (g) { setTimeout(g, 1200); })(f); }
  if (document.readyState === 'complete') idle(warm); else window.addEventListener('load', function () { idle(warm); });

  /* pre-load internal pages on hover / touch so the next page opens instantly */
  var seen = {};
  function prefetch(a) {
    try {
      if (!a || !a.href) return;
      var u = new URL(a.href, location.href);
      if (u.origin !== location.origin || /^\/(api|admin)/i.test(u.pathname) || seen[u.pathname] || u.pathname === location.pathname) return;
      var c = navigator.connection; if (c && (c.saveData || /2g/.test(c.effectiveType || ''))) return;
      seen[u.pathname] = 1;
      var l = document.createElement('link'); l.rel = 'prefetch'; l.href = u.pathname + u.search; l.as = 'document';
      document.head.appendChild(l);
    } catch (e) {}
  }
  function onHint(e) { var a = e.target && e.target.closest ? e.target.closest('a[href]') : null; if (a) prefetch(a); }
  document.addEventListener('touchstart', onHint, { passive: true, capture: true });
  document.addEventListener('mouseover', onHint, { passive: true, capture: true });
})();
