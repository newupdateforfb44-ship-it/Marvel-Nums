/* Marvel Nums standard shell (Part 1).
   Builds the same header, back row, bottom bar, menu sheet and page-switch
   loader on every page that loads it. Does not touch page content or API code. */
(function () {
  'use strict';
  if (window.__mvnStd) return;
  window.__mvnStd = true;

  var HOME = '/dashboard';
  function cleanPath(p) {
    return (p.replace(/\.html$/, '').replace(/\/+$/, '') || '/');
  }
  var path = cleanPath(location.pathname);
  var isHome = path === HOME || path === '/';

  var MENU = [
    ['Home', '/dashboard'], ['Marketplace', '/marketplace'], ['Buy Numbers', '/buy-number'],
    ['Boost', '/boost'], ['Rentals', '/rental'], ['Tools', '/tools'], ['Tutorials', '/tutorials'],
    ['Transactions', '/transactions'], ['Wallet', '/deposit'], ['Referrals', '/referrals'],
    ['Support', '/support'], ['Settings', '/settings']
  ];

  function el(tag, attrs, html) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (html != null) n.innerHTML = html;
    return n;
  }

  function samePath(href) {
    return cleanPath(href) === path;
  }

  /* ── Page-switch loader ── */
  var navigating = false;
  function go(url) {
    if (navigating) return;
    navigating = true;
    document.body.classList.add('mvn-navigating');
    // safety net: if the browser never leaves (error, blocked), re-enable taps
    setTimeout(function () { navigating = false; document.body.classList.remove('mvn-navigating'); }, 15000);
    location.href = url;
  }

  function goBack() {
    if (navigating) return;
    if (window.history.length > 1 && document.referrer && new URL(document.referrer).origin === location.origin) {
      navigating = true;
      document.body.classList.add('mvn-navigating');
      window.history.back();
      setTimeout(function () { navigating = false; document.body.classList.remove('mvn-navigating'); }, 15000);
    } else {
      go(HOME);
    }
  }

  /* ── Header ── */
  function buildHeader() {
    var header = el('header', { id: 'mvnStdHeader' });
    var brand = el('a', { class: 'mvs-brand', href: HOME }, '<img src="/marvel-logo.png" alt="Marvel Nums" onerror="this.style.display=\'none\'"><span>Marvel Nums</span>');
    brand.addEventListener('click', function (e) { e.preventDefault(); go(HOME); });
    var menuBtn = el('button', { class: 'mvs-menu-btn', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false' }, '<i></i><i></i><i></i>');
    menuBtn.addEventListener('click', openSheet);
    header.appendChild(brand);
    header.appendChild(menuBtn);
    document.body.insertBefore(header, document.body.firstChild);
  }

  /* ── Back row (inner pages only; same place on every page) ── */
  function buildBackRow() {
    if (isHome) return;
    document.body.classList.add('mvn-has-back');
    var row = el('div', { id: 'mvnStdBackRow' }, '<button type="button" aria-label="Go back">&larr; Back</button>');
    row.querySelector('button').addEventListener('click', goBack);
    document.getElementById('mvnStdHeader').insertAdjacentElement('afterend', row);
  }

  /* ── Menu sheet ── */
  var sheet;
  function buildSheet() {
    sheet = el('div', { id: 'mvnStdSheet', role: 'dialog', 'aria-modal': 'true' });
    var panel = el('div', { class: 'mvs-panel' });
    var head = el('div', { class: 'mvs-panel-head' }, '<span>Menu</span>');
    var close = el('button', { class: 'mvs-close', type: 'button', 'aria-label': 'Close menu' }, '&times;');
    close.addEventListener('click', closeSheet);
    head.appendChild(close);
    panel.appendChild(head);
    MENU.forEach(function (m) {
      var a = el('a', { href: m[1] }, m[0]);
      a.addEventListener('click', function (e) {
        e.preventDefault();
        closeSheet();
        go(m[1]);
      });
      panel.appendChild(a);
    });
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
  }
  function openSheet() {
    sheet.classList.add('open');
    document.getElementById('mvnStdHeader').querySelector('.mvs-menu-btn').setAttribute('aria-expanded', 'true');
  }
  function closeSheet() {
    sheet.classList.remove('open');
    document.getElementById('mvnStdHeader').querySelector('.mvs-menu-btn').setAttribute('aria-expanded', 'false');
  }

  /* ── Floating buttons: one tidy stack on the right, clear of the content ── */
  function stackFloatingButtons() {
    var place = function () {
      var support = document.querySelector('#dshSupportFab, #supportFab');
      if (support) { support.style.setProperty('bottom', '16px', 'important'); support.style.setProperty('right', '16px', 'important'); support.style.setProperty('left', 'auto', 'important'); support.style.setProperty('top', 'auto', 'important'); }
      var mini = document.querySelectorAll('.mx-fab');
      for (var i = 0; i < mini.length; i++) {
        var st = mini[i].style;
        st.setProperty('position', 'fixed', 'important');
        st.setProperty('right', '18px', 'important');
        st.setProperty('left', 'auto', 'important');
        st.setProperty('top', 'auto', 'important');
        st.setProperty('bottom', (84 + i * 52) + 'px', 'important');
      }
    };
    place();
    window.addEventListener('load', place);
    setTimeout(place, 1500);
  }

  /* ── Loader overlay ── */
  function buildLoader() {
    document.body.appendChild(el('div', { id: 'mvnStdLoader', 'aria-hidden': 'true' }, '<div class="mvs-spin"></div>'));
  }

  function init() {
    document.body.classList.add('mvn-std');
    buildHeader();
    buildBackRow();
    stackFloatingButtons();
    buildSheet();
    buildLoader();
    // re-enable taps when returning via the back/forward cache
    window.addEventListener('pageshow', function () {
      navigating = false;
      document.body.classList.remove('mvn-navigating');
      closeSheet();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeSheet(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
