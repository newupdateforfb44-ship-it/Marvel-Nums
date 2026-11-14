// Admin → "Airtime & Data (VTU)" tab. Loaded by admin.html; talks to /api/admin/vtu/*.
(function () {
  var root, state = { kind: 'data', services: [], plans: [] };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var naira = function (n) { return '₦' + Number(n || 0).toLocaleString('en-NG'); };
  function hdr() {
    var h = { 'Content-Type': 'application/json' };
    try { if (typeof currentRole !== 'undefined' && currentRole === 'staff') h.Authorization = 'Bearer ' + staffToken; else h['x-admin-passcode'] = adminPass; } catch (e) {}
    return h;
  }
  async function call(url, body) {
    var r = await fetch(url, { method: body ? 'POST' : 'GET', headers: hdr(), body: body ? JSON.stringify(body) : undefined });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')'));
    return j;
  }
  function say(msg, bad) { var f = document.getElementById('vtuMsg'); if (!f) return; f.style.color = bad ? '#ff9ea6' : '#7be0a4'; f.textContent = msg; }

  window.vtuAdmLoad = async function () {
    root = document.getElementById('vtuAdmRoot'); if (!root) return;
    root.innerHTML = 'Loading…';
    try {
      var d = await call('/api/admin/vtu/config'); var c = d.config;
      root.innerHTML =
        '<div class="info-box" style="margin:8px 0">' +
        '<b>VTUGATE wallet balance:</b> ' + (d.balance != null ? naira(d.balance) : '<span style="color:#ff9ea6">' + esc(d.balanceError || 'unknown') + '</span>') +
        ' &nbsp;|&nbsp; <b>API key:</b> ' + (d.keySet ? 'set ✔' : '<span style="color:#ff9ea6">NOT set (add VTUGATE_API_KEY in Render)</span>') +
        '<br>Customers are charged from their wallet; your VTUGATE wallet must have enough money to fulfil orders.</div>' +

        '<div class="sec"><div class="sec-title">Service switch</div>' +
        '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="vtuEnabled" ' + (c.enabled ? 'checked' : '') + '> Airtime &amp; Data is ON (untick to show maintenance)</label>' +
        '<div class="fg" style="margin-top:8px"><label>Maintenance message</label><input class="inp" id="vtuMaint" value="' + esc(c.maintenanceMessage) + '"></div></div>' +

        '<div class="sec"><div class="sec-title">Markup (your profit)</div>' +
        '<div class="info-box">Percentage added on top of what VTUGATE charges you. Example: 3 = you earn 3%. Use <b>0</b> to sell at cost. A fixed price you set for a plan below always overrides this.</div>' +
        '<div class="form-row">' +
        '<div class="fg"><label>Data markup %</label><input class="inp" id="vtuData" type="number" min="0" step="0.1" value="' + c.dataPct + '"></div>' +
        '<div class="fg"><label>Cable TV markup %</label><input class="inp" id="vtuCable" type="number" min="0" step="0.1" value="' + c.cablePct + '"></div>' +
        '<div class="fg"><label>Airtime markup %</label><input class="inp" id="vtuAir" type="number" min="0" step="0.1" value="' + c.airtimePct + '"></div></div>' +
        '<div class="form-row">' +
        '<div class="fg"><label>Min airtime (₦)</label><input class="inp" id="vtuMin" type="number" min="50" value="' + c.airtimeMin + '"></div>' +
        '<div class="fg"><label>Max airtime (₦, up to 5,000)</label><input class="inp" id="vtuMax" type="number" max="5000" value="' + c.airtimeMax + '"></div></div>' +
        '<button class="btn-primary" onclick="vtuSave()">Save settings</button> <span id="vtuMsg" style="margin-left:8px"></span></div>' +

        '<div class="sec"><div class="sec-title">Set a specific price for a plan</div>' +
        '<div class="form-row"><div class="fg"><label>Type</label><select class="inp" id="vtuKind" onchange="vtuKindChange()"><option value="data">Data</option><option value="cable">Cable TV</option></select></div>' +
        '<div class="fg"><label>Network / Provider</label><select class="inp" id="vtuSvc" onchange="vtuPlans()"></select></div></div>' +
        '<div class="tbl-wrap"><table><thead><tr><th>Plan</th><th>Your cost</th><th>Markup price</th><th>Fixed price</th><th>Customer pays</th><th></th></tr></thead><tbody id="vtuPlanRows"><tr><td colspan="6">Choose a provider…</td></tr></tbody></table></div>' +
        '<div class="muted" style="margin-top:6px">A fixed price below your cost is ignored and the markup price is used instead (you are never sold at a loss).</div></div>' +

        '<div class="sec"><div class="sec-title">Orders</div>' +
        '<div style="margin-bottom:8px"><button class="btn-secondary btn-sm" onclick="vtuOrders(\'review\')">Needs review</button> <button class="btn-secondary btn-sm" onclick="vtuOrders(\'all\')">Recent orders</button></div>' +
        '<div id="vtuOrders" class="muted">…</div></div>';
      vtuKindChange(); vtuOrders('review');
    } catch (e) { root.innerHTML = '<div class="info-box" style="color:#ff9ea6">' + esc(e.message) + '</div>'; }
  };

  window.vtuSave = async function () {
    try {
      await call('/api/admin/vtu/config', {
        enabled: document.getElementById('vtuEnabled').checked,
        maintenanceMessage: document.getElementById('vtuMaint').value,
        dataPct: document.getElementById('vtuData').value, cablePct: document.getElementById('vtuCable').value, airtimePct: document.getElementById('vtuAir').value,
        airtimeMin: document.getElementById('vtuMin').value, airtimeMax: document.getElementById('vtuMax').value
      });
      say('Saved ✔'); vtuPlans();
    } catch (e) { say(e.message, true); }
  };

  window.vtuKindChange = async function () {
    var kind = document.getElementById('vtuKind').value; state.kind = kind;
    var sel = document.getElementById('vtuSvc'); sel.innerHTML = '<option>Loading…</option>';
    try {
      var d = await call('/api/admin/vtu/services?type=' + (kind === 'cable' ? 'tv' : 'data'));
      sel.innerHTML = d.services.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('');
      vtuPlans();
    } catch (e) { sel.innerHTML = ''; document.getElementById('vtuPlanRows').innerHTML = '<tr><td colspan="6" style="color:#ff9ea6">' + esc(e.message) + '</td></tr>'; }
  };

  window.vtuPlans = async function () {
    var sid = document.getElementById('vtuSvc').value, body = document.getElementById('vtuPlanRows'); if (!sid) return;
    body.innerHTML = '<tr><td colspan="6">Loading…</td></tr>';
    try {
      var d = await call('/api/admin/vtu/plans?kind=' + state.kind + '&service_id=' + encodeURIComponent(sid));
      state.plans = d.plans;
      body.innerHTML = d.plans.map(function (p, i) {
        return '<tr><td>' + esc(p.name) + '</td><td>' + naira(p.cost) + '</td><td>' + naira(p.markupPrice) + '</td>' +
          '<td><input class="inp" style="width:110px" type="number" min="0" id="vtuFix' + i + '" value="' + (p.fixed || '') + '" placeholder="—"></td>' +
          '<td style="font-weight:700;color:var(--gold)">' + naira(p.price) + '</td>' +
          '<td><button class="btn-gold btn-sm" onclick="vtuFix(' + i + ')">Save</button> <button class="btn-secondary btn-sm" onclick="vtuFix(' + i + ',true)">Clear</button></td></tr>';
      }).join('') || '<tr><td colspan="6">No plans returned.</td></tr>';
    } catch (e) { body.innerHTML = '<tr><td colspan="6" style="color:#ff9ea6">' + esc(e.message) + '</td></tr>'; }
  };

  window.vtuFix = async function (i, clear) {
    var p = state.plans[i], v = clear ? 0 : Number(document.getElementById('vtuFix' + i).value);
    try { await call('/api/admin/vtu/override', { kind: state.kind, service_id: p.service_id, code: p.code, price: v }); vtuPlans(); } catch (e) { alert(e.message); }
  };

  window.vtuOrders = async function (mode) {
    var box = document.getElementById('vtuOrders'); box.textContent = 'Loading…';
    try {
      var rows = await call('/api/admin/vtu/orders?status=' + mode);
      box.innerHTML = rows.length ? '<div class="tbl-wrap"><table><thead><tr><th>When</th><th>User</th><th>Order</th><th>Charged</th><th>Status</th><th></th></tr></thead><tbody>' +
        rows.map(function (o) {
          return '<tr><td>' + esc(new Date(o.createdAt).toLocaleString()) + '</td><td>' + esc(o.user) + '</td><td>' + esc(o.label) + '</td><td>' + naira(o.charged) + '</td><td>' + esc(o.status) + '</td><td>' +
            (o.status === 'review' ? '<button class="btn-gold btn-sm" onclick="vtuResolve(\'' + o.id + '\',\'success\')">Mark delivered</button> <button class="btn-del btn-sm" onclick="vtuResolve(\'' + o.id + '\',\'refund\')">Refund</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>' : 'Nothing here.';
    } catch (e) { box.textContent = e.message; }
  };

  window.vtuResolve = async function (id, action) {
    if (!confirm(action === 'refund' ? 'Refund this customer? Only do this after checking on VTUGATE that it was NOT delivered.' : 'Mark as delivered (no refund)?')) return;
    try { await call('/api/admin/vtu/orders/' + id + '/resolve', { action: action }); vtuOrders('review'); } catch (e) { alert(e.message); }
  };
})();
