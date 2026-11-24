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
  var backControl = null;
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
    var menuBtn = el('button', { class: 'mvs-menu-btn', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false', 'aria-controls': 'mvnStdSheet' }, '<i></i><i></i><i></i>');
    menuButton = menuBtn;
    menuBtn.addEventListener('click', function () { sheet && sheet.classList.contains('open') ? closeSheet() : openSheet(); });
    header.appendChild(brand);
    header.appendChild(menuBtn);
    document.body.insertBefore(header, document.body.firstChild);
  }

  /* ── Single Back link, beside the logo in the standard header ── */
  function buildBackRow() {
    if (isHome) return;
    var header = document.getElementById('mvnStdHeader');
    backControl = el('a', { id: 'mvnStdBackLink', class: 'mvs-back-btn', href: HOME, 'aria-label': 'Go back' }, '<span aria-hidden="true">&larr;</span><span>Back</span>');
    backControl.addEventListener('click', function (e) {
      e.preventDefault();
      var destination = backControl.getAttribute('data-back-destination');
      if (destination) go(destination); else goBack();
    });
    header.insertBefore(backControl, header.querySelector('.mvs-menu-btn'));
  }

  /* ── Accessible navigation drawer ── */
  var sheet, menuButton, previousFocus = null, savedScrollY = 0;
  function buildSheet() {
    sheet = el('div', { id: 'mvnStdSheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Main navigation', 'aria-hidden': 'true' });
    var panel = el('nav', { class: 'mvs-panel', 'aria-label': 'Site navigation' });
    var head = el('div', { class: 'mvs-panel-head' }, '<div class="mvs-menu-brand"><img src="/marvel-logo.png" alt=""><span><b>Marvel Nums</b><small>Quick navigation</small></span></div>');
    var close = el('button', { class: 'mvs-close', type: 'button', 'aria-label': 'Close menu' }, '&times;');
    close.addEventListener('click', closeSheet);
    head.appendChild(close); panel.appendChild(head);

    var groups = [
      { label: 'Explore', links: [['Home','/dashboard'],['Marketplace 1','/marketplace'],['Marketplace 2','/marketplace2'],['Marketplace 3','/marketplace3'],['Marketplace 4','/marketplace4']] },
      { label: 'Numbers & Rentals', links: [['Buy Number 1','/buy-number-1'],['Buy Number 2','/buy-number-2'],['Buy Number 3','/buy-number-3'],['Temporary Email','/temp-email'],['Rentals','/rental'],['Number History','/number-history'],['Order Status','/order-status']] },
      { label: 'Digital Services', links: [['Boost Services','/boost-services'],['Boost 1','/boost1'],['Boost 2','/boost2'],['Airtime & Data','/vtu'],['Websites','/websites'],['Telegram Tick','/telegram-tick'],['Tools','/tools'],['Games','/games'],['Giveaways','/giveaways'],['Groups','/groups']] },
      { label: 'Your Account', links: [['My Orders','/purchases'],['Messages','/messages'],['Notifications','/notifications'],['Wallet / Add Money','/deposit'],['Transactions','/transactions'],['Referrals','/referrals'],['Settings','/settings']] },
      { label: 'Help & Information', links: [['Support','/support'],['Help Center','/help'],['About Marvel Nums','/about'],['Terms & Conditions','/terms']] }
    ];
    groups.forEach(function (group) {
      panel.appendChild(el('div', { class: 'mvs-section-label' }, group.label));
      group.links.forEach(function (item) {
        var a = el('a', { href: item[1] }, item[0]);
        if (samePath(item[1])) a.setAttribute('aria-current', 'page');
        a.addEventListener('click', function (e) {
          e.preventDefault(); closeSheet();
          if (!samePath(item[1])) go(item[1]);
        });
        panel.appendChild(a);
      });
    });
    var logout = el('button', { class: 'mvs-logout', type: 'button' }, 'Log out');
    logout.addEventListener('click', function () {
      closeSheet();
      var token = '';
      try { token = localStorage.getItem('mvn_token') || ''; } catch (e) {}
      try { if (token) fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, keepalive: true }).catch(function () {}); } catch (e) {}
      try { localStorage.removeItem('mvn_token'); localStorage.removeItem('mvn_user'); } catch (e) {}
      go('/login');
    });
    panel.appendChild(logout);
    sheet.appendChild(panel);
    sheet.addEventListener('click', function (e) { if (e.target === sheet) closeSheet(); });
    document.body.appendChild(sheet);
  }
  function openSheet() {
    if (!sheet || sheet.classList.contains('open')) return;
    previousFocus = document.activeElement;
    savedScrollY = window.pageYOffset || document.documentElement.scrollTop || 0;
    sheet.classList.add('open'); sheet.setAttribute('aria-hidden', 'false');
    document.body.classList.add('mvs-menu-open');
    document.body.style.position = 'fixed'; document.body.style.top = (-savedScrollY) + 'px'; document.body.style.left = '0'; document.body.style.right = '0'; document.body.style.width = '100%';
    menuButton.setAttribute('aria-expanded', 'true');
    menuButton.setAttribute('aria-label', 'Close menu');
    var close = sheet.querySelector('.mvs-close'); if (close) close.focus();
  }
  function closeSheet() {
    if (!sheet) return;
    sheet.classList.remove('open'); sheet.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('mvs-menu-open');
    document.body.style.position = ''; document.body.style.top = ''; document.body.style.left = ''; document.body.style.right = ''; document.body.style.width = '';
    try { window.scrollTo(0, savedScrollY); } catch (e) {}
    if (menuButton) { menuButton.setAttribute('aria-expanded', 'false'); menuButton.setAttribute('aria-label', 'Open menu'); }
    if (previousFocus && typeof previousFocus.focus === 'function') { try { previousFocus.focus({ preventScroll: true }); } catch (e) { previousFocus.focus(); } }
    previousFocus = null;
  }
  function handleMenuKeys(e) {
    if (!sheet || !sheet.classList.contains('open')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeSheet(); return; }
    if (e.key !== 'Tab') return;
    var focusable = sheet.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
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

  function cleanLegacyBackLinks() {
    // Replace actual page-level Back controls with the one beside the logo.
    // Do not remove ordinary links such as History, Dashboard, or form actions.
    var selector = 'a.back, a.hub-back, a.page-back, a.back-link';
    function removeBack(node) {
      if (node.closest('#mvnStdHeader, #mvnStdSheet, form')) return;
      var href = node.getAttribute('href');
      if (backControl && href && href.charAt(0) !== '#' && !/^javascript:/i.test(href) && !backControl.hasAttribute('data-back-destination')) {
        backControl.setAttribute('href', href);
        backControl.setAttribute('data-back-destination', href);
      }
      node.remove();
    }
    function clean(root) {
      var scope = root || document;
      if (scope.nodeType === 1 && scope.matches && scope.matches(selector)) removeBack(scope);
      scope.querySelectorAll(selector).forEach(removeBack);
    }
    clean(document);
    if (window.MutationObserver) {
      var observer = new MutationObserver(function (records) {
        records.forEach(function (record) { record.addedNodes.forEach(function (node) { if (node.nodeType === 1 && !node.closest('#mvnStdSheet')) clean(node); }); });
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(function () { observer.disconnect(); }, 10000);
    }
  }

  function init() {
    document.body.classList.add('mvn-std');
    buildHeader();
    buildBackRow();
    cleanLegacyBackLinks();
    stackFloatingButtons();
    buildSheet();
    buildLoader();
    // re-enable taps when returning via the back/forward cache
    window.addEventListener('pageshow', function () {
      navigating = false;
      document.body.classList.remove('mvn-navigating');
      closeSheet();
    });
    document.addEventListener('keydown', handleMenuKeys);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
