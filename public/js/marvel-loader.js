/* Marvel Nums: page loader (fast version).
   The page now paints immediately. The branded loader appears ONLY if something is still loading after
   SHOW_AFTER ms (slow network), and disappears the moment the page is ready. No forced minimum time.
   Other scripts can still hold it with MVNLoader.show('key') / hide('key'). */
(function () {
  'use strict';
  if (window.MVNLoader) return;
  var holds = {}, el = null, showTimer = null, SHOW_AFTER = 650, MAX_MS = 6000, forceTimer = null;

  var css =
    '.dbfl-overlay,#dbfl-overlay,#mvn-page-transition{display:none!important}' +
    '#mvn-loader{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;' +
    'background:radial-gradient(ellipse at 50% 36%,rgba(26,109,255,.30),#040a24 72%),#040a24;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .16s ease,visibility .16s ease}' +
    '#mvn-loader.mvn-on{opacity:1;visibility:visible;pointer-events:auto}' +
    '#mvn-loader .mvn-logo{position:relative;width:84px;height:84px;border-radius:22px;background:#040a24 url(/img/marvel-icon-192.png) center/cover no-repeat;box-shadow:0 0 40px rgba(26,109,255,.5)}' +
    '#mvn-loader .mvn-logo:after{content:"";position:absolute;inset:-10px;border-radius:30px;border:3px solid rgba(26,109,255,.16);border-top-color:#00b4ff;border-right-color:#ff1a45;animation:mvnspin 1s linear infinite}' +
    '#mvn-loader .mvn-name{font:800 13px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#eaf3ff}' +
    '#mvn-loader .mvn-name b{color:#ff1a45;font-weight:800}' +
    '@keyframes mvnspin{to{transform:rotate(360deg)}}';

  function build() {
    if (el) return el;
    var st = document.createElement('style'); st.id = 'mvn-loader-css'; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
    el = document.createElement('div');
    el.id = 'mvn-loader'; el.setAttribute('role', 'status'); el.setAttribute('aria-label', 'Loading');
    el.innerHTML = '<div class="mvn-logo"></div><div class="mvn-name">Marvel <b>Nums</b></div>';
    document.documentElement.appendChild(el);
    return el;
  }
  function count() { var n = 0; for (var k in holds) if (holds[k]) n++; return n; }
  function on() { var e = build(); e.classList.add('mvn-on'); clearTimeout(forceTimer); forceTimer = setTimeout(reset, MAX_MS); }
  function off() { clearTimeout(showTimer); showTimer = null; clearTimeout(forceTimer); if (el) el.classList.remove('mvn-on'); }
  function arm() { if (showTimer || (el && el.classList.contains('mvn-on'))) return; showTimer = setTimeout(function () { showTimer = null; if (count() > 0) on(); }, SHOW_AFTER); }
  function show(key) { holds[key || 'x'] = 1; arm(); }
  function hide(key) { delete holds[key || 'x']; if (count() === 0) off(); }
  function reset() { holds = {}; off(); }

  /* page itself: only a hold until the document is interactive */
  holds.page = 1; arm();
  function ready() { hide('page'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready); else ready();
  window.addEventListener('load', ready);
  window.addEventListener('pageshow', reset);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) reset(); });
  window.addEventListener('error', function () { setTimeout(reset, 800); });
  window.addEventListener('unhandledrejection', function () { setTimeout(reset, 800); });

  window.MVNLoader = { show: show, hide: hide, reset: reset };
})();
