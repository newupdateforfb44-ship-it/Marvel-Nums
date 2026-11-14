// Buy Number advice banner: shows the admin-written message when a customer enters
// any Buy Number page. They tap "I understand, continue" and it goes away for this session
// (it shows again if the admin edits the message).
(function () {
  if (window.__mvnNumNotice) return; window.__mvnNumNotice = true;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function run() {
    fetch('/api/number-notice', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (n) {
      if (!n || !n.enabled) return;
      var key = 'mvn_numnotice_ok_' + (n.version || 0);
      try { if (sessionStorage.getItem(key)) return; } catch (e) {}
      var css = document.createElement('style');
      css.textContent = '.kn-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px}' +
        '.kn-box{width:100%;max-width:480px;max-height:88vh;max-height:88dvh;overflow-y:auto;background:var(--card,#141414);color:var(--t1,#fff);border:1px solid var(--border2,#333);border-radius:18px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}' +
        '.kn-box h3{margin:0 0 10px;font-size:18px;line-height:1.3}.kn-msg{white-space:pre-line;font-size:14px;line-height:1.6;color:var(--t2,#cbd5e1);margin:0 0 16px}' +
        '.kn-btn{width:100%;min-height:48px;border:0;border-radius:12px;background:#16a34a;color:#fff;font-weight:800;font-size:15px;cursor:pointer}';
      document.head.appendChild(css);
      var ov = document.createElement('div'); ov.className = 'kn-ov';
      ov.innerHTML = '<div class="kn-box" role="dialog" aria-modal="true"><h3>⚠️ ' + esc(n.title) + '</h3><p class="kn-msg">' + esc(n.message) + '</p><button type="button" class="kn-btn">' + esc(n.buttonText) + '</button></div>';
      document.body.appendChild(ov);
      document.body.style.overflow = 'hidden';
      ov.querySelector('.kn-btn').onclick = function () {
        try { sessionStorage.setItem(key, '1'); } catch (e) {}
        document.body.style.overflow = ''; ov.remove();
      };
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
