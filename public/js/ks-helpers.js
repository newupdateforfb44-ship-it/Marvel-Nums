/* Marvel Nums helpers used by Buy Number 2, Temp Email and Rentals:
   kswr(url, api, onData, onError)  shows the last saved list instantly, then checks for fresh data
                                    and only redraws if something really changed.
   kset(select, html)               replaces a dropdown's options and keeps the chosen value if it still exists. */
(function () {
  'use strict';
  if (window.kswr) return;
  var P = 'kswr1:';
  window.kset = function (sel, html) {
    if (!sel) return;
    var v = sel.value;
    if (sel.innerHTML !== html) sel.innerHTML = html;
    try { if (v && Array.prototype.some.call(sel.options, function (o) { return o.value === v; })) sel.value = v; } catch (e) {}
  };
  window.kswr = async function (url, apiFn, onData, onError) {
    var key = P + url, cached = null, last = null;
    try { cached = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch (e) {}
    if (cached !== null) { last = JSON.stringify(cached); try { onData && onData(cached); } catch (e) {} }
    try {
      var fresh = await apiFn(url), s = JSON.stringify(fresh);
      try { sessionStorage.setItem(key, s); } catch (e) {}
      if (s !== last) { try { onData && onData(fresh); } catch (e) {} }
      return fresh;
    } catch (e) {
      if (cached === null) { if (onError) { try { onError(e); } catch (x) {} return null; } throw e; }
      return cached;
    }
  };
})();
