/* Site credits and owner contact strip */
(function () {
  'use strict';
  if (window.__mvnDevCredit) return;
  window.__mvnDevCredit = true;
  var OWNER_WHATSAPP = '#';
  function mount() {
    if (document.querySelector('.mvn-devbar')) return;
    var bar = document.createElement('div');
    bar.className = 'mvn-devbar';
    bar.innerHTML =
      '<div class="mvn-devbar-inner">' +
        '<div class="mvn-devbar-main">' +
          '<span class="mvn-devbar-dot" aria-hidden="true"></span>' +
          '<span class="mvn-devbar-txt">Designed and engineered by developer <strong>Marvel</strong></span>' +
        '</div>' +
        '<div class="mvn-devbar-buy">' +
          'Want to buy this website? <a href="' + OWNER_WHATSAPP + '" target="_blank" rel="noopener noreferrer" class="mvn-devbar-cta">Contact the admin / owner on WhatsApp: +234 812 835 8120</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
