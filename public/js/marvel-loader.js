/* Marvel Nums: the ONE page loader.
   Runs from <head>, so it is on screen from the very first paint, stays up (never restarts)
   until the page is ready, then fades out once. Other scripts can hold it with MVNLoader.show('key'). */
(function () {
  'use strict';
  if (window.MVNLoader) return;
  var holds = {}, el = null, t0 = Date.now(), MIN_MS = 450, MAX_MS = 15000, hideTimer = null, forceTimer = null;

  var css =
    '.dbfl-overlay,#dbfl-overlay,#mvn-page-transition{display:none!important}' +
    '#mvn-loader{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;' +
    'background:radial-gradient(ellipse at 50% 36%,rgba(26,109,255,.30),rgba(255,26,69,.07) 46%,#040a24 74%),#040a24;' +
    'opacity:1;visibility:visible;transition:opacity .28s ease,visibility .28s ease}' +
    '#mvn-loader.mvn-hide{opacity:0;visibility:hidden;pointer-events:none}' +
    '#mvn-loader .mvn-logo{position:relative;width:96px;height:96px;border-radius:24px;background:#040a24 url(/img/marvel-icon-192.png) center/cover no-repeat;' +
    'box-shadow:0 0 44px rgba(26,109,255,.55),0 0 90px rgba(255,26,69,.16)}' +
    '#mvn-loader .mvn-logo:after{content:"";position:absolute;inset:-11px;border-radius:33px;border:3px solid rgba(26,109,255,.16);' +
    'border-top-color:#00b4ff;border-right-color:#ff1a45;animation:mvnspin 1s linear infinite}' +
    '#mvn-loader .mvn-name{font:800 14px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;letter-spacing:.26em;text-transform:uppercase;color:#eaf3ff}' +
    '#mvn-loader .mvn-name b{color:#ff1a45;font-weight:800}' +
    '#mvn-loader .mvn-sub{font:600 11px/1 system-ui,-apple-system,sans-serif;letter-spacing:.18em;text-transform:uppercase;color:#6f8fd8;margin-top:-8px}' +
    '@keyframes mvnspin{to{transform:rotate(360deg)}}' +
    '@media (prefers-reduced-motion:reduce){#mvn-loader .mvn-logo:after{animation-duration:2.4s}}';

  function build() {
    if (el) return el;
    var st = document.createElement('style'); st.id = 'mvn-loader-css'; st.textContent = css;
    (document.head || document.documentElement).appendChild(st);
    el = document.createElement('div');
    el.id = 'mvn-loader'; el.setAttribute('role', 'status'); el.setAttribute('aria-label', 'Loading');
    el.innerHTML = '<div class="mvn-logo"></div><div class="mvn-name">Marvel <b>Nums</b></div><div class="mvn-sub">Your digital growth hub</div>';
    document.documentElement.appendChild(el);
    return el;
  }
  function count() { var n = 0; for (var k in holds) if (holds[k]) n++; return n; }
  function display() {
    var e = build(); clearTimeout(hideTimer);
    e.classList.remove('mvn-hide');
    clearTimeout(forceTimer);
    forceTimer = setTimeout(function () { holds = {}; fade(); }, MAX_MS);   // never trap the visitor
  }
  function fade() {
    var e = build();
    var wait = Math.max(0, MIN_MS - (Date.now() - t0));
    clearTimeout(hideTimer);
    hideTimer = setTimeout(function () { if (count() === 0) e.classList.add('mvn-hide'); }, wait);
  }
  function show(key) { holds[key || 'x'] = 1; display(); }
  function hide(key) { delete holds[key || 'x']; if (count() === 0) fade(); }
  function reset() { holds = {}; fade(); }

  holds.page = 1; display();                                       // up immediately for every new page
  var domReady = function () { setTimeout(function () { hide('page'); }, 3500); };   // slow images can't hold it
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', domReady); else domReady();
  if (document.readyState === 'complete') hide('page'); else window.addEventListener('load', function () { hide('page'); });
  window.addEventListener('pageshow', function (ev) { if (ev.persisted) reset(); });

  // Leaving the page: keep the same loader up so there is no second, different animation.
  function leaving() { show('nav'); setTimeout(function () { hide('nav'); }, 6000); }
  window.addEventListener('beforeunload', leaving);
  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
    if ((a.target && a.target.toLowerCase() === '_blank') || a.hasAttribute('download')) return;
    var h = a.getAttribute('href');
    if (!h || h.charAt(0) === '#' || /^(mailto:|tel:|sms:|javascript:|blob:|data:)/i.test(h)) return;
    try {
      var u = new URL(a.href, location.href);
      if (u.origin === location.origin && (u.pathname !== location.pathname || u.search !== location.search)) leaving();
    } catch (e) {}
  }, true);

  window.MVNLoader = { show: show, hide: hide, reset: reset };
})();
