// ── VTU (Airtime / Data / Cable TV) via VTUGATE ─────────────────────────────
// Env:
//   VTUGATE_API_KEY      (required)  your VTUGATE live API key — server-side only
//   VTUGATE_BASE_URL     (optional)  default https://api.vtugate.com
//   VTU_MARKUP_PERCENT / VTU_AIRTIME_MARKUP_PERCENT (optional) — only the
//        FIRST-RUN defaults. Once you save settings in Admin → Airtime & Data
//        (VTU), the admin values win.
//
// SAFETY MODEL
//  • Prices always come from the VTUGATE catalogue on the server; the browser
//    can only pick a plan, never set a price.
//  • The wallet is debited atomically BEFORE the provider is called.
//  • Definite provider failure  -> automatic refund.
//  • Unknown outcome (timeout)  -> order stays "pending", NO refund, admin can
//    check it. Re-sending uses the same client_reference so VTUGATE will not
//    buy twice.
const axios = require('axios');
const crypto = require('crypto');

const BASE = () => String(process.env.VTUGATE_BASE_URL || 'https://api.vtugate.com').replace(/\/+$/, '');
const KEY = () => String(process.env.VTUGATE_API_KEY || '').trim();
const ENV_PCT = () => { const n = Number(process.env.VTU_MARKUP_PERCENT); return Number.isFinite(n) && n >= 0 ? n : 3; };
const ENV_AIR_PCT = () => { const n = Number(process.env.VTU_AIRTIME_MARKUP_PERCENT); return Number.isFinite(n) && n >= 0 ? n : 0; };
// integer maths first so float noise (1500 * 1.1 = 1650.0000000000002) never adds a naira
const withMarkup = (base, pct) => Math.ceil(Math.round(Number(base) * (100 + Number(pct))) / 100);

// Endpoint paths confirmed against the VTUGATE docs.
const P = {
  services: () => process.env.VTU_FETCH_SERVICES_PATH || '/api/v1/fetchservices',
  dataPlans: () => process.env.VTU_FETCH_DATA_PLANS_PATH || '/api/v1/fetchdataplans',
  cablePlans: '/api/v1/fetchcableplans',
  verifyCable: '/api/v1/verifycabletv',
  airtime: '/api/v1/buyairtime',
  data: '/api/v1/buydata',
  cable: '/api/v1/buycabletv'
};

async function vtugate(path, fields, timeout = 30000) {
  const body = new URLSearchParams();
  Object.entries(fields || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') body.append(k, String(v)); });
  try {
    const r = await axios.post(BASE() + path, body.toString(), {
      timeout,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: 'Bearer ' + KEY() },
      validateStatus: () => true
    });
    return { http: r.status, body: r.data || {}, unknown: r.status >= 500 || r.status === 409 };
  } catch (e) {
    // timeout / network drop: we cannot know whether the provider processed it
    return { http: 0, body: {}, unknown: true, error: e.message };
  }
}

const arr = (d) => {
  if (Array.isArray(d)) return d;
  if (!d || typeof d !== 'object') return [];
  for (const k of ['cable_plans', 'data_plans', 'plans', 'services', 'data']) if (Array.isArray(d[k])) return d[k];
  for (const k of Object.keys(d)) if (Array.isArray(d[k])) return d[k];
  return [];
};

module.exports = function registerVtu({ app, mongoose, User, Transaction, auth, anyAdminAuth }) {
  const orderSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    kind: String,                  // airtime | data | cable
    target: String,                // phone or smartcard
    label: String,
    charged: Number,
    cost: Number,                  // what VTUGATE charges us (face/catalogue)
    status: { type: String, default: 'pending' }, // pending | success | failed | review
    ref: { type: String, unique: true, index: true },
    providerRef: String,
    providerMessage: String,
    createdAt: { type: Date, default: Date.now }
  });
  const VtuOrder = mongoose.models.VtuOrder || mongoose.model('VtuOrder', orderSchema);

  // ── Admin-controlled settings ─────────────────────────────────────────────
  const cfgSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: true },
    maintenanceMessage: { type: String, default: 'Airtime & Data is under maintenance. Please check back shortly.' },
    dataPct: { type: Number, default: null },     // null = use env/default
    cablePct: { type: Number, default: null },
    airtimePct: { type: Number, default: null },
    airtimeMin: { type: Number, default: 50 },
    airtimeMax: { type: Number, default: 5000 },
    overrides: [{ kind: String, serviceId: String, code: String, price: Number, _id: false }]
  });
  const VtuConfig = mongoose.models.VtuConfig || mongoose.model('VtuConfig', cfgSchema);
  let cfgCache = null, cfgAt = 0;
  async function getCfg(force) {
    if (!force && cfgCache && Date.now() - cfgAt < 10000) return cfgCache;
    let c = await VtuConfig.findOne({ key: 'main' }).lean();
    if (!c) c = { enabled: true, overrides: [] };
    cfgCache = {
      enabled: c.enabled !== false,
      maintenanceMessage: c.maintenanceMessage || 'Airtime & Data is under maintenance. Please check back shortly.',
      dataPct: c.dataPct != null ? c.dataPct : ENV_PCT(),
      cablePct: c.cablePct != null ? c.cablePct : ENV_PCT(),
      airtimePct: c.airtimePct != null ? c.airtimePct : ENV_AIR_PCT(),
      airtimeMin: c.airtimeMin || 50,
      airtimeMax: Math.min(c.airtimeMax || 5000, 5000),
      overrides: c.overrides || []
    };
    cfgAt = Date.now();
    return cfgCache;
  }
  // Final price = admin fixed price (never below our cost) else cost + markup %
  function priceFor(cfg, kind, base, serviceId, code) {
    const pct = kind === 'cable' ? cfg.cablePct : cfg.dataPct;
    const o = cfg.overrides.find(x => x.kind === kind && String(x.serviceId) === String(serviceId) && String(x.code) === String(code));
    if (o && Number(o.price) >= Math.ceil(base)) return Math.ceil(Number(o.price)); // below cost is ignored -> markup used
    return withMarkup(base, pct);
  }

  const ready = async (req, res, next) => {
    if (!KEY()) return res.status(503).json({ error: 'Airtime & Data is not available right now.' });
    try { const c = await getCfg(); if (!c.enabled) return res.status(503).json({ error: c.maintenanceMessage }); } catch (e) { /* fall through */ }
    next();
  };

  app.get('/api/vtu/status', auth, async (req, res) => { const c = await getCfg(); res.json({ enabled: !!KEY() && c.enabled, airtimePct: c.airtimePct }); });

  // Networks / cable providers
  app.get('/api/vtu/services', auth, ready, async (req, res) => {
    const type = ({ airtime: 'airtime', data: 'data', tv: 'tv' })[String(req.query.type || '')];
    if (!type) return res.status(400).json({ error: 'Invalid type.' });
    const r = await vtugate(P.services(), { service_type: type });
    if (r.http !== 200 || r.body.status === false) return res.status(502).json({ error: 'Could not load providers. Try again shortly.' });
    res.json({ services: arr(r.body.data).map(s => ({
      id: s.service_id ?? s.id, name: s.name || s.service_name || s.network_name || s.title || String(s.service_id ?? s.id)
    })) });
  });

  async function loadDataPlans(serviceId) {
    const r = await vtugate(P.dataPlans(), { service_id: serviceId });
    if (r.http !== 200 || r.body.status === false) return null;
    return arr(r.body.data).map(p => ({
      code: String(p.code ?? p.plan_code ?? p.id),
      service_id: String(p.service_id ?? serviceId),
      name: p.name || p.plan_name || p.title || p.code,
      category: p.category || p.type || '',
      base: Number(p.price ?? p.amount),
      size: Number(p.size_mb) || 0
    })).filter(p => p.code && Number.isFinite(p.base) && p.base > 0)
      .sort((x, y) => (x.size - y.size) || (x.base - y.base));
  }

  app.get('/api/vtu/data-plans', auth, ready, async (req, res) => {
    const sid = String(req.query.service_id || '').replace(/[^\w-]/g, '');
    if (!sid) return res.status(400).json({ error: 'service_id required.' });
    const plans = await loadDataPlans(sid);
    if (!plans) return res.status(502).json({ error: 'Could not load plans. Try again shortly.' });
    const cfg = await getCfg();
    res.json({ plans: plans.map(p => ({ code: p.code, service_id: p.service_id, name: p.name, category: p.category, price: priceFor(cfg, 'data', p.base, p.service_id, p.code) })) });
  });

  async function loadCablePlans(serviceId) {
    const r = await vtugate(P.cablePlans, { service_id: serviceId });
    if (r.http !== 200 || r.body.status === false) return null;
    return arr(r.body.data).map(p => ({ code: String(p.code), name: p.name, base: Number(p.price) })).filter(p => p.code && p.base > 0);
  }

  app.get('/api/vtu/cable-plans', auth, ready, async (req, res) => {
    const sid = String(req.query.service_id || '').replace(/[^\w-]/g, '');
    if (!sid) return res.status(400).json({ error: 'service_id required.' });
    const plans = await loadCablePlans(sid);
    if (!plans) return res.status(502).json({ error: 'Could not load packages. Try again shortly.' });
    const cfg = await getCfg();
    res.json({ plans: plans.map(p => ({ code: p.code, name: p.name, price: priceFor(cfg, 'cable', p.base, sid, p.code) })) });
  });

  app.post('/api/vtu/verify-cable', auth, ready, async (req, res) => {
    const { service_id, smartcard_number, phone } = req.body || {};
    if (!service_id || !/^\d{6,20}$/.test(String(smartcard_number || ''))) return res.status(400).json({ error: 'Enter a valid smartcard number.' });
    const r = await vtugate(P.verifyCable, { service_id, phone: phone || '08000000000', smartcard_number });
    if (r.http !== 200 || r.body.status === false) return res.status(400).json({ error: (r.body && r.body.message) || 'Could not verify this smartcard.' });
    res.json({ name: r.body.data?.smartcard_name || '' });
  });

  // ── Shared purchase engine ────────────────────────────────────────────────
  async function purchase(req, res, { kind, target, label, cost, charge, path, fields }) {
    const ref = 'vtu_' + req.user._id + '_' + crypto.randomBytes(8).toString('hex');
    const order = await VtuOrder.create({ userId: req.user._id, kind, target, label, charged: charge, cost, ref });
    const user = await User.findOneAndUpdate({ _id: req.user._id, balance: { $gte: charge } }, { $inc: { balance: -charge } }, { new: true });
    if (!user) {
      await VtuOrder.updateOne({ _id: order._id }, { $set: { status: 'failed', providerMessage: 'Insufficient balance' } });
      return res.status(400).json({ error: 'Insufficient wallet balance. Please fund your wallet.' });
    }
    const txRef = 'vtu_p_' + order._id;
    await Transaction.create({ userId: user._id, type: 'purchase', amount: charge, description: label, status: 'pending', txRef });

    const r = await vtugate(path, { ...fields, client_reference: ref.slice(0, 64) });
    const ok = r.http === 200 && r.body.status === true;
    if (ok) {
      await VtuOrder.updateOne({ _id: order._id }, { $set: { status: 'success', providerRef: String(r.body.data?.external_reference || r.body.data?.transaction_id || ''), providerMessage: r.body.message || '' } });
      await Transaction.updateOne({ txRef }, { $set: { status: 'success' } });
      return res.json({ ok: true, message: r.body.message || 'Successful', balance: user.balance, orderId: String(order._id) });
    }
    if (r.unknown) {
      // Outcome unknown — hold the money, do NOT refund blindly.
      await VtuOrder.updateOne({ _id: order._id }, { $set: { status: 'review', providerMessage: r.error || ('HTTP ' + r.http) } });
      console.error('[vtu] unknown outcome, held for review:', String(order._id), r.error || r.http);
      return res.status(202).json({ ok: true, pending: true, message: 'Your order is being confirmed. Your balance is on hold — please do not order again. Check My Orders shortly.' });
    }
    // Definite failure -> refund once
    const claimed = await VtuOrder.findOneAndUpdate({ _id: order._id, status: 'pending' }, { $set: { status: 'failed', providerMessage: r.body.message || 'Rejected' } });
    if (claimed) {
      await User.updateOne({ _id: user._id }, { $inc: { balance: charge } });
      await Transaction.updateOne({ txRef }, { $set: { status: 'failed' } });
      await Transaction.create({ userId: user._id, type: 'refund', amount: charge, description: 'Refund — ' + label, status: 'success', txRef: 'vtu_r_' + order._id });
    }
    return res.status(400).json({ error: 'The purchase could not be completed and you were not charged.' });
  }

  app.post('/api/vtu/airtime', auth, ready, async (req, res) => {
    try {
      const { service_id, phone } = req.body || {};
      const amount = Math.floor(Number(req.body?.amount));
      if (!service_id || !/^0\d{10}$/.test(String(phone || ''))) return res.status(400).json({ error: 'Enter a valid 11-digit phone number.' });
      const cfg = await getCfg();
      if (!(amount >= cfg.airtimeMin && amount <= cfg.airtimeMax)) return res.status(400).json({ error: `Airtime must be between ₦${cfg.airtimeMin} and ₦${cfg.airtimeMax.toLocaleString()}.` });
      await purchase(req, res, {
        kind: 'airtime', target: phone, label: `Airtime ₦${amount} → ${phone}`, cost: amount,
        charge: withMarkup(amount, cfg.airtimePct), path: P.airtime,
        fields: { service_id, phone_number: phone, amount }
      });
    } catch (e) { console.error('[vtu] airtime', e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  app.post('/api/vtu/data', auth, ready, async (req, res) => {
    try {
      const { service_id, network_service_id, phone, plan_code } = req.body || {};
      if (!service_id || !plan_code || !/^0\d{10}$/.test(String(phone || ''))) return res.status(400).json({ error: 'Choose a plan and enter a valid phone number.' });
      // Plans must be re-fetched with the NETWORK service_id the customer searched with,
      // then matched on BOTH the plan code and that plan's own service_id (per VTUGATE docs).
      const plans = await loadDataPlans(String(network_service_id || service_id));
      const plan = plans && plans.find(p => p.code === String(plan_code) && p.service_id === String(service_id));
      if (!plan) return res.status(400).json({ error: 'That plan is no longer available. Refresh and pick again.' });
      const cfg = await getCfg();
      await purchase(req, res, {
        kind: 'data', target: phone, label: `${plan.name} → ${phone}`, cost: plan.base,
        charge: priceFor(cfg, 'data', plan.base, plan.service_id, plan.code), path: P.data,
        fields: { service_id: plan.service_id, phone_number: phone, amount: plan.base, plan_code: plan.code }
      });
    } catch (e) { console.error('[vtu] data', e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  app.post('/api/vtu/cable', auth, ready, async (req, res) => {
    try {
      const { service_id, phone, smartcard_number, plan_code } = req.body || {};
      if (!service_id || !plan_code || !/^\d{6,20}$/.test(String(smartcard_number || ''))) return res.status(400).json({ error: 'Choose a package and enter a valid smartcard number.' });
      const plans = await loadCablePlans(String(service_id));
      const plan = plans && plans.find(p => p.code === String(plan_code));
      if (!plan) return res.status(400).json({ error: 'That package is no longer available. Refresh and pick again.' });
      const cfg = await getCfg();
      await purchase(req, res, {
        kind: 'cable', target: smartcard_number, label: `${plan.name} → ${smartcard_number}`, cost: plan.base,
        charge: priceFor(cfg, 'cable', plan.base, service_id, plan.code), path: P.cable,
        fields: { service_id, phone: phone || '08000000000', smartcard_number, amount: plan.base, plan_code: plan.code, plan_name: plan.name }
      });
    } catch (e) { console.error('[vtu] cable', e.message); res.status(500).json({ error: 'Something went wrong. Please try again.' }); }
  });

  app.get('/api/vtu/orders', auth, async (req, res) => {
    const rows = await VtuOrder.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean();
    res.json(rows.map(o => ({ label: o.label, kind: o.kind, amount: o.charged, createdAt: o.createdAt, status: o.status === 'review' ? 'processing' : o.status })));
  });

  // ── Admin API (owner only) ────────────────────────────────────────────────
  const owner = (req, res, next) => req.adminRole === 'super' ? next() : res.status(403).json({ error: 'Owner access only.' });

  app.get('/api/admin/vtu/services', anyAdminAuth, owner, async (req, res) => {
    const type = ({ data: 'data', tv: 'tv' })[String(req.query.type || '')];
    if (!type) return res.status(400).json({ error: 'Invalid type.' });
    const r = await vtugate(P.services(), { service_type: type });
    if (r.http !== 200 || r.body.status === false) return res.status(502).json({ error: 'Could not load providers from VTUGATE.' });
    res.json({ services: arr(r.body.data).map(x => ({ id: x.service_id ?? x.id, name: x.network_name || x.name || x.service_name || String(x.service_id ?? x.id) })) });
  });

  app.get('/api/admin/vtu/config', anyAdminAuth, owner, async (req, res) => {
    const c = await getCfg(true);
    let balance = null, balanceError = '';
    if (KEY()) {
      const r = await vtugate('/api/v1/accountdetails', {}, 15000);
      if (r.http === 200 && r.body.status !== false) balance = r.body.data?.wallet_balance ?? null; else balanceError = (r.body && r.body.message) || 'Could not reach VTUGATE';
    } else balanceError = 'VTUGATE_API_KEY is not set in Render.';
    res.json({ config: c, keySet: !!KEY(), balance, balanceError });
  });

  app.post('/api/admin/vtu/config', anyAdminAuth, owner, async (req, res) => {
    const b = req.body || {};
    const pct = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 && n <= 200 ? n : undefined; };
    const set = {};
    if (b.enabled !== undefined) set.enabled = !!b.enabled;
    if (typeof b.maintenanceMessage === 'string') set.maintenanceMessage = b.maintenanceMessage.slice(0, 300);
    for (const k of ['dataPct', 'cablePct', 'airtimePct']) if (b[k] !== undefined) { const n = pct(b[k]); if (n === undefined) return res.status(400).json({ error: 'Percentages must be between 0 and 200.' }); set[k] = n; }
    if (b.airtimeMin !== undefined) { const n = Math.floor(Number(b.airtimeMin)); if (!(n >= 50)) return res.status(400).json({ error: 'Minimum airtime must be at least ₦50.' }); set.airtimeMin = n; }
    if (b.airtimeMax !== undefined) { const n = Math.floor(Number(b.airtimeMax)); if (!(n >= 50 && n <= 5000)) return res.status(400).json({ error: 'Maximum airtime must be between ₦50 and ₦5,000.' }); set.airtimeMax = n; }
    await VtuConfig.updateOne({ key: 'main' }, { $set: set, $setOnInsert: { key: 'main' } }, { upsert: true });
    res.json({ ok: true, config: await getCfg(true) });
  });

  // Plans with our cost, markup price and any fixed price, for the admin to edit
  app.get('/api/admin/vtu/plans', anyAdminAuth, owner, async (req, res) => {
    const kind = req.query.kind === 'cable' ? 'cable' : 'data';
    const sid = String(req.query.service_id || '').replace(/[^\w-]/g, '');
    if (!sid) return res.status(400).json({ error: 'service_id required.' });
    const plans = kind === 'data' ? await loadDataPlans(sid) : (await loadCablePlans(sid) || []).map(p => ({ ...p, service_id: sid }));
    if (!plans) return res.status(502).json({ error: 'Could not load plans from VTUGATE.' });
    const cfg = await getCfg(true);
    res.json({ plans: plans.map(p => {
      const o = cfg.overrides.find(x => x.kind === kind && String(x.serviceId) === String(p.service_id) && String(x.code) === String(p.code));
      return { code: p.code, service_id: p.service_id, name: p.name, cost: p.base, markupPrice: withMarkup(p.base, kind === 'cable' ? cfg.cablePct : cfg.dataPct), fixed: o ? o.price : null, price: priceFor(cfg, kind, p.base, p.service_id, p.code) };
    }) });
  });

  // Set (price > 0) or clear (price null/0) a fixed selling price for one plan
  app.post('/api/admin/vtu/override', anyAdminAuth, owner, async (req, res) => {
    const { kind, service_id, code } = req.body || {};
    if (!['data', 'cable'].includes(kind) || !service_id || !code) return res.status(400).json({ error: 'Invalid request.' });
    const price = Number(req.body.price);
    await VtuConfig.updateOne({ key: 'main' }, { $setOnInsert: { key: 'main' } }, { upsert: true });
    await VtuConfig.updateOne({ key: 'main' }, { $pull: { overrides: { kind, serviceId: String(service_id), code: String(code) } } });
    if (Number.isFinite(price) && price > 0) await VtuConfig.updateOne({ key: 'main' }, { $push: { overrides: { kind, serviceId: String(service_id), code: String(code), price: Math.ceil(price) } } });
    await getCfg(true);
    res.json({ ok: true });
  });

  app.get('/api/admin/vtu/orders', anyAdminAuth, owner, async (req, res) => {
    const q = req.query.status === 'review' ? { status: 'review' } : {};
    const rows = await VtuOrder.find(q).sort({ createdAt: -1 }).limit(100).lean();
    const users = await User.find({ _id: { $in: rows.map(r => r.userId) } }).select('email name').lean();
    const um = Object.fromEntries(users.map(u => [String(u._id), u.email || u.name || '']));
    res.json(rows.map(o => ({ id: String(o._id), user: um[String(o.userId)] || '', kind: o.kind, label: o.label, charged: o.charged, cost: o.cost, status: o.status, note: o.providerMessage, createdAt: o.createdAt })));
  });

  // Resolve an order held in "review" (provider outcome unknown)
  app.post('/api/admin/vtu/orders/:id/resolve', anyAdminAuth, owner, async (req, res) => {
    const action = req.body && req.body.action;
    if (!['success', 'refund'].includes(action)) return res.status(400).json({ error: 'Invalid action.' });
    const order = await VtuOrder.findOneAndUpdate({ _id: req.params.id, status: 'review' }, { $set: { status: action === 'success' ? 'success' : 'failed', providerMessage: 'Resolved by admin: ' + action } });
    if (!order) return res.status(409).json({ error: 'Order is not in review (already resolved?).' });
    const txRef = 'vtu_p_' + order._id;
    if (action === 'success') { await Transaction.updateOne({ txRef }, { $set: { status: 'success' } }); return res.json({ ok: true }); }
    await User.updateOne({ _id: order.userId }, { $inc: { balance: order.charged } });
    await Transaction.updateOne({ txRef }, { $set: { status: 'failed' } });
    try { await Transaction.create({ userId: order.userId, type: 'refund', amount: order.charged, description: 'Refund — ' + order.label, status: 'success', txRef: 'vtu_r_' + order._id }); } catch (e) { /* already exists */ }
    res.json({ ok: true });
  });
};
