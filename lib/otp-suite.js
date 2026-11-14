// Buy Number 2 + Temp Email + Rentals — all powered by the SMS-COOL API (https://sms-cool.com/api/v1).
// File name kept as lib/otp-suite.js so server.js (which already loads it) needs NO change.
// The API key is server-side only: set SMS_COOL_API_KEY in Render, or paste it in Admin > Buy Number 2 settings.
// Customer prices are charged from the NGN wallet: provider USD price -> NGN (live rate) + markup, then Admin "Price Adjustments".
const axios = require('axios');
const crypto = require('crypto');
const path = require('path');
const PA = require('./price-adjust');
const fx = require('./fx');

const DEFAULT_SERVERS = [1, 2, 3, 4, 6];
const NUM_STATUS = { pending: 'waiting', completed: 'received', cancelled: 'cancelled' };
const PRESET_HOURS = { oneWeek: 168, oneMonth: 720, sixMonths: 4320, twelveMonths: 8640 };
const PRESET_LABEL = { oneWeek: '1 week', oneMonth: '1 month', sixMonths: '6 months', twelveMonths: '12 months' };
const CANCEL_WINDOW_MS = { 1: 20 * 60 * 1000, 2: 2 * 60 * 60 * 1000 };
const HOST_RE = /^[a-z0-9]([a-z0-9.-]{1,58})[a-z0-9]$/i;

module.exports = function registerSmsCool(app, deps) {
  const { mongoose, User, Transaction, auth, anyAdminAuth } = deps;
  const S = mongoose.Schema;
  let runtimeApiKey = '', runtimeBaseUrl = '';

  // ───────── secrets / config ─────────
  const encKey = () => crypto.createHash('sha256').update(String(process.env.JWT_SECRET || 'provider-config-key')).digest();
  function encryptSecret(v) { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv); const out = Buffer.concat([c.update(String(v), 'utf8'), c.final()]); return 'v1:' + iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + out.toString('hex'); }
  function decryptSecret(v) { try { const p = String(v || '').split(':'); if (p.length !== 4 || p[0] !== 'v1') return ''; const d = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(p[1], 'hex')); d.setAuthTag(Buffer.from(p[2], 'hex')); return Buffer.concat([d.update(Buffer.from(p[3], 'hex')), d.final()]).toString('utf8'); } catch (e) { return ''; } }
  const base = () => String(runtimeBaseUrl || process.env.SMS_COOL_BASE_URL || 'https://sms-cool.com/api/v1').replace(/\/+$/, '');
  const key = () => String(runtimeApiKey || process.env.SMS_COOL_API_KEY || '').trim();

  const Config = mongoose.models.SmsCoolConfig || mongoose.model('SmsCoolConfig', new S({
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: true }, emailEnabled: { type: Boolean, default: true }, rentalEnabled: { type: Boolean, default: true },
    markupNgn: { type: Number, default: Number(process.env.SMS_COOL_MARKUP_NGN || 300) }, markupPercent: { type: Number, default: 0 },
    emailMarkupNgn: { type: Number, default: Number(process.env.SMS_COOL_EMAIL_MARKUP_NGN || 40) }, emailMarkupPercent: { type: Number, default: 0 },
    rentalMarkupNgn: { type: Number, default: 0 }, rentalMarkupPercent: { type: Number, default: Number(process.env.SMS_COOL_RENTAL_MARKUP_PERCENT || 25) },
    overrides: { type: [{ kind: String, name: String, country: { type: String, default: '' }, price: Number }], default: [] },
    emailDomains1: { type: [String], default: ['gmail.com'] },
    emailSites: { type: [String], default: ['telegram.com', 'facebook.com', 'instagram.com', 'google.com', 'twitter.com', 'tiktok.com', 'whatsapp.com', 'discord.com'] },
    apiKeyCipher: { type: String, default: '' }, customBaseUrl: { type: String, default: '' }
  }));
  async function getCfg() {
    let c = await Config.findOne({ key: 'main' });
    if (!c) c = await Config.create({ key: 'main' });
    runtimeApiKey = c.apiKeyCipher ? decryptSecret(c.apiKeyCipher) : ''; runtimeBaseUrl = c.customBaseUrl || '';
    return c;
  }

  // ───────── models ─────────
  const common = { userId: { type: S.Types.ObjectId, ref: 'User', required: true, index: true }, ref: { type: String, unique: true, required: true }, price: Number, providerCost: Number, debited: { type: Boolean, default: false }, refunded: { type: Boolean, default: false }, lastError: String, createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now } };
  const NumOrder = mongoose.models.SmsCoolOrder || mongoose.model('SmsCoolOrder', new S({ ...common, supplierOrderId: { type: String, default: '' }, server: Number, resends: { type: Number, default: 0 }, countryCode: String, countryName: String, serviceId: String, serviceName: String, phoneNumber: String, sms: String, expiresAt: Date, status: { type: String, default: 'pending', index: true } }));
  const EmailOrder = mongoose.models.SmsCoolEmail || mongoose.model('SmsCoolEmail', new S({ ...common, server: Number, serviceId: String, serviceName: String, domain: String, site: String, emailId: { type: String, default: '' }, email: String, code: String, status: { type: String, default: 'pending', index: true } }));
  const RentalOrder = mongoose.models.SmsCoolRental || mongoose.model('SmsCoolRental', new S({ ...common, kind: { type: String, default: 'rental' }, provider: Number, countryCode: String, serviceCode: String, serviceName: String, durationHours: Number, durationPreset: String, supplierId: { type: String, default: '' }, phone: String, expiresAt: Date, smsCount: { type: Number, default: 0 }, renewals: { type: [{ price: Number, hours: Number, at: Date }], default: [] }, status: { type: String, default: 'pending', index: true } }));

  // ───────── provider call + helpers ─────────
  const mkErr = (m, status) => { const e = new Error(m); e.status = status; return e; };
  async function call(p, params, opts) {
    await getCfg();
    if (!key()) throw mkErr('This service is not available right now.', 503);
    let r;
    try { r = await axios.get(base() + p, { params, timeout: (opts && opts.timeout) || 20000, headers: { Authorization: 'Bearer ' + key(), Accept: 'application/json' } }); }
    catch (err) {
      const st = err.response?.status || 0; const m = err.response?.data?.message || err.response?.data?.error || '';
      const e = new Error(m || 'Service request failed'); e.status = st || 502; e.providerMessage = String(m || ''); e.ambiguous = !st || st >= 500 || err.code === 'ECONNABORTED'; throw e;
    }
    const b = r.data;
    if (b && typeof b === 'object' && (b.status === 'error' || b.status === 'failed' || (b.error && !b.order_id))) { const e = new Error(b.message || b.error || 'Service request failed'); e.status = 400; e.providerMessage = String(b.message || b.error || ''); throw e; }
    return b || {};
  }
  const cache = new Map();
  // Stale-while-revalidate: once something has been loaded, customers get it instantly (never waiting on the provider);
  // an out-of-date entry is refreshed in the background. Purchases still re-check live (see servicesFor(..., true)).
  const inflight = new Map(); const STALE_MAX = 30 * 60 * 1000;
  function refresh(k, fn) {
    if (inflight.has(k)) return inflight.get(k);
    const p = fn().then(v => { cache.set(k, { at: Date.now(), v }); return v; }).finally(() => inflight.delete(k));
    inflight.set(k, p); return p;
  }
  async function cached(k, ttl, fn) {
    const h = cache.get(k); const age = h ? Date.now() - h.at : Infinity;
    if (h && age < ttl) return h.v;
    if (h && age < STALE_MAX) { refresh(k, fn).catch(() => {}); return h.v; }
    try { return await refresh(k, fn); } catch (e) { if (h) return h.v; throw e; }
  }
  const usdToNgn = async (usd) => (await fx.convert(usd, 'USD', 'NGN')) * (1 + (fx.SPREAD || 0));
  // Price = provider cost (NGN) + percent + fixed markup, then Admin "Price Adjustments". An exact price set by admin (override) wins.
  const MK = { num: ['markupPercent', 'markupNgn', 'bn2'], email: ['emailMarkupPercent', 'emailMarkupNgn', 'email'], rental: ['rentalMarkupPercent', 'rentalMarkupNgn', 'rental'] };
  function findOverride(cfg, kind, meta) {
    const name = String(meta.name || '').toLowerCase(), country = String(meta.country || '').toLowerCase(); let best = null;
    for (const o of (cfg.overrides || [])) { if (o.kind !== kind || String(o.name).toLowerCase() !== name || !(o.price > 0)) continue; if (o.country) { if (String(o.country).toLowerCase() === country) return o; } else best = best || o; }
    return best;
  }
  async function sell(cfg, kind, usd, meta) {
    const cost = Math.ceil(await usdToNgn(usd)); const ov = findOverride(cfg, kind, meta || {});
    if (ov) return { cost, price: Math.ceil(ov.price), override: true };
    const [pf, ff, pk] = MK[kind]; const raw = Math.ceil(cost * (1 + (Number(cfg[pf]) || 0) / 100) + (Number(cfg[ff]) || 0));
    return { cost, price: PA.apply(pk, raw, { floor: cost }) };
  }
  function friendly(e) {
    const m = String((e && (e.providerMessage || e.message)) || '');
    if (/stock|no numbers|not available|unavailable|no .*available/i.test(m)) return 'None are available for that selection right now.';
    return 'We could not complete this purchase. Nothing was charged.';
  }
  const parseDate = (s) => { if (!s) return null; let t = String(s).trim(); if (!/[zZ]|[+-]\d\d:?\d\d$/.test(t)) t = t.replace(' ', 'T') + 'Z'; const d = new Date(t); return isNaN(d) ? null : d; };
  const cleanRef = (v) => String(v || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || crypto.randomUUID();
  const money2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  async function charge(uid, amt) { return User.findOneAndUpdate({ _id: uid, balance: { $gte: amt } }, { $inc: { balance: -amt } }, { new: true }); }
  async function claimRefund(Model, o, status, desc, errText) {
    const c = await Model.findOneAndUpdate({ _id: o._id, refunded: false }, { $set: { refunded: true, status, updatedAt: new Date(), ...(errText ? { lastError: errText } : {}) } }, { new: true });
    if (!c) return null;
    try { await User.updateOne({ _id: o.userId }, { $inc: { balance: o.price || 0 } }); await Transaction.create({ userId: o.userId, type: 'refund', amount: o.price || 0, description: desc, status: 'success' }).catch(() => {}); }
    catch (e) { await Model.updateOne({ _id: o._id }, { $set: { refunded: false, status: 'review', lastError: 'Automatic refund needs admin review: ' + e.message } }).catch(() => {}); throw e; }
    return c;
  }
  // Charge wallet first, then call the provider. Definite failure => auto refund. Unclear result => "review", never double-charge.
  async function chargeAndCall(res, req, Model, order, price, providerFn) {
    const user = await charge(req.user._id, price);
    if (!user) { await Model.updateOne({ _id: order._id }, { $set: { status: 'failed', lastError: 'Insufficient wallet balance' } }); res.status(400).json({ error: 'Insufficient wallet balance.' }); return null; }
    await Model.updateOne({ _id: order._id }, { $set: { debited: true } });
    try { return { d: await providerFn(), user }; }
    catch (e) {
      if (e.ambiguous) { await Model.updateOne({ _id: order._id }, { $set: { status: 'review', lastError: e.message, updatedAt: new Date() } }); res.status(202).json({ ok: true, pending: true, orderId: String(order._id), message: 'The provider response is unclear. Your order is being checked; please do not purchase again.' }); return null; }
      try { await claimRefund(Model, order, 'failed', 'Purchase refund', e.message); }
      catch (re) { res.status(202).json({ ok: true, pending: true, orderId: String(order._id), message: 'The purchase could not be completed and the refund needs review. Please contact support.' }); return null; }
      res.status(e.status === 409 ? 409 : 400).json({ error: friendly(e) }); return null;
    }
  }
  const tx = (userId, amount, description) => Transaction.create({ userId, type: 'purchase', amount, description, status: 'success' }).catch(() => {});
  const guard = (flag, name) => async (req, res, next) => { try { const c = await getCfg(); if (c.enabled === false && flag === 'enabled') return res.status(503).json({ error: 'Buy Number 2 is temporarily unavailable.' }); if (flag !== 'enabled' && c[flag] === false) return res.status(503).json({ error: name + ' is temporarily unavailable.' }); next(); } catch (e) { res.status(500).json({ error: 'Service error.' }); } };
  const page = (f) => (req, res) => { res.set('Cache-Control', 'no-store, must-revalidate'); res.sendFile(path.join(__dirname, '..', 'public', f)); };
  app.get('/temp-email', page('temp-email.html'));
  app.get('/rental', page('rental.html'));

  // ═════════ BUY NUMBER 2 (temp numbers): Server -> Country -> Service -> Rent, exactly like the API ═════════
  const serverList = () => cached('servers', 300000, async () => { try { const d = await call('/servers'); const l = (d.servers || []).map(x => ({ server_number: Number(x.server_number), name: String(x.name || 'Server ' + x.server_number) })).filter(x => x.server_number); return l.length ? l : DEFAULT_SERVERS.map(n => ({ server_number: n, name: 'Server ' + n })); } catch (e) { if (e.status === 503) throw e; return DEFAULT_SERVERS.map(n => ({ server_number: n, name: 'Server ' + n })); } });
  const okServer = async (v) => { const n = Number(v); return (await serverList()).some(x => x.server_number === n) ? n : 0; };
  const countriesFor = (server) => cached('c:' + server, 300000, async () => { const d = await call('/countries', { server }); return (d.countries || []).map(c => ({ id: String(c.id), name: String(c.name) })).sort((a, b) => a.name.localeCompare(b.name)); });
  async function servicesFor(server, country, fresh) {
    const k = 's:' + server + ':' + country; if (fresh) cache.delete(k);
    return cached(k, 45000, async () => { const d = await call('/services', { server, country_id: country }); return (d.services || []).map(x => ({ id: String(x.id), name: String(x.name), usd: Number(x.price) })).filter(x => x.usd > 0).sort((a, b) => a.name.localeCompare(b.name)); });
  }
  const safeNum = (o) => ({ id: String(o._id), orderId: o.supplierOrderId, server: o.server || null, country: o.countryName, countryCode: o.countryCode, service: o.serviceName, number: o.phoneNumber, price: o.price, status: o.status, sms: o.sms || null, createdAt: o.createdAt, expiresAt: o.expiresAt || null, canCancel: ['waiting', 'pending'].includes(o.status) && !o.sms && !!o.supplierOrderId, canResend: o.status === 'waiting' && !o.sms && !!o.supplierOrderId && (o.resends || 0) < 5 });

  async function syncNumber(o) {
    if (!o.supplierOrderId || o.sms || ['cancelled', 'received', 'refunded', 'failed', 'expired'].includes(o.status)) return o;
    const d = await call('/check/' + encodeURIComponent(o.supplierOrderId));
    const st = String(d.status || '');
    if (st === 'completed' && d.sms_code) { await NumOrder.updateOne({ _id: o._id }, { $set: { status: 'received', sms: String(d.sms_code), updatedAt: new Date() } }); call('/complete/' + encodeURIComponent(o.supplierOrderId)).catch(() => {}); }
    else if (st === 'cancelled') { await claimRefund(NumOrder, o, 'expired', 'Number order refund (no code received)'); }
    return NumOrder.findById(o._id).lean();
  }

  const ng = guard('enabled', 'Buy Number 2');
  app.get('/api/numbers/otp-suite/servers', auth, ng, async (req, res) => { try { res.json(await serverList()); } catch (e) { res.status(e.status || 502).json({ error: e.message }); } });
  app.get('/api/numbers/otp-suite/countries', auth, ng, async (req, res) => { try { const sv = await okServer(req.query.server); if (!sv) return res.status(400).json({ error: 'Choose a server first.' }); res.json((await countriesFor(sv)).map(c => ({ country_code: c.id, country_name: c.name }))); } catch (e) { res.status(e.status || 502).json({ error: e.message }); } });
  app.get('/api/numbers/otp-suite/services', auth, ng, async (req, res) => {
    const country = String(req.query.country || '').trim(); if (!/^\d{1,6}$/.test(country)) return res.status(400).json({ error: 'Choose a country first.' });
    try { const sv = await okServer(req.query.server); if (!sv) return res.status(400).json({ error: 'Choose a server first.' }); const cfg = await getCfg(); const out = []; for (const x of await servicesFor(sv, country)) { const p = await sell(cfg, 'num', x.usd, { name: x.name, country }); out.push({ id: x.id, name: x.name, cost: p.cost, sellPrice: p.price, basePrice: x.usd }); } res.json(out); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  // History shows only real outcomes: live (waiting) orders, received codes and expired ones. Failed / unpaid / cancelled attempts are hidden.
  app.get('/api/numbers/otp-suite/orders', auth, async (req, res) => { try { res.json((await NumOrder.find({ userId: req.user._id, supplierOrderId: { $ne: '' }, status: { $in: ['waiting', 'received', 'expired'] } }).sort({ createdAt: -1 }).limit(50).lean()).map(safeNum)); } catch (e) { res.status(500).json({ error: 'Could not load number history.' }); } });
  app.post('/api/numbers/otp-suite/buy', auth, ng, async (req, res) => {
    const country = String(req.body?.country || '').trim(), service = String(req.body?.service || '').trim();
    if (!/^\d{1,6}$/.test(country) || !/^\d{1,8}$/.test(service)) return res.status(400).json({ error: 'Choose a server, country and service.' });
    const ref = cleanRef(req.body?.clientRef);
    try {
      const sv = await okServer(req.body?.server); if (!sv) return res.status(400).json({ error: 'Choose a server first.' });
      const cfg = await getCfg();
      const existing = await NumOrder.findOne({ ref }); if (existing) { if (String(existing.userId) !== String(req.user._id)) return res.status(409).json({ error: 'Invalid purchase reference.' }); return res.json({ ok: true, repeated: true, order: safeNum(existing) }); }
      const unclear = await NumOrder.findOne({ userId: req.user._id, countryCode: country, serviceId: service, status: 'review', createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } });
      if (unclear) return res.status(202).json({ ok: true, pending: true, orderId: String(unclear._id), message: 'A recent purchase is still being verified. Please check Number History before trying again.' });
      const svc = (await servicesFor(sv, country, true)).find(x => x.id === service); if (!svc) return res.status(404).json({ error: 'That service is no longer available.' });
      const cName = ((await countriesFor(sv)).find(c => c.id === country) || {}).name || country;
      const p = await sell(cfg, 'num', svc.usd, { name: svc.name, country }); if (!(p.price > 0)) return res.status(400).json({ error: 'Invalid price.' });
      const order = await NumOrder.create({ userId: req.user._id, ref, server: sv, countryCode: country, countryName: cName, serviceId: service, serviceName: svc.name, price: p.price, providerCost: svc.usd, status: 'pending' });
      const r = await chargeAndCall(res, req, NumOrder, order, p.price, async () => { const d = await call('/rent', { service_id: service, country_id: country }, { timeout: 30000 }); if (String(d.status) !== 'success' || !d.order_id) throw mkErr(d.message || 'No numbers available', 409); return d; });
      if (!r) return;
      const d = r.d;
      await NumOrder.updateOne({ _id: order._id }, { $set: { supplierOrderId: String(d.order_id), phoneNumber: String(d.phone || ''), providerCost: Number(d.price) || svc.usd, expiresAt: parseDate(d.expires_at), status: 'waiting', updatedAt: new Date() } });
      await tx(req.user._id, p.price, 'Buy Number 2 — ' + svc.name);
      res.json({ ok: true, order: safeNum(await NumOrder.findById(order._id).lean()), balance: r.user.balance });
    } catch (e) { console.error('[SMS-COOL] number buy failed:', e.message); res.status(e.status || 500).json({ error: e.message || 'Could not purchase a number.' }); }
  });
  app.get('/api/numbers/otp-suite/sms/:id', auth, async (req, res) => {
    try { if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Order not found.' }); const o = await NumOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) return res.status(404).json({ error: 'Order not found.' }); res.json({ order: safeNum(await syncNumber(o)) }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.post('/api/numbers/otp-suite/resend/:id', auth, async (req, res) => {
    try {
      if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Order not found.' }); const o = await NumOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (!safeNum(o).canResend) return res.status(400).json({ error: 'A new code cannot be requested for this order.' });
      let d; try { d = await call('/resend/' + encodeURIComponent(o.supplierOrderId)); } catch (e) { return res.status(400).json({ error: 'A new code could not be requested right now.' }); }
      await NumOrder.updateOne({ _id: o._id }, { $inc: { resends: 1 }, $set: { updatedAt: new Date() } });
      res.json({ ok: true, message: d.message || 'Another SMS was requested. Your code will appear here.', order: safeNum(await NumOrder.findById(o._id).lean()) });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.post('/api/numbers/otp-suite/cancel/:id', auth, async (req, res) => {
    try {
      if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Order not found.' });
      const o = await NumOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (o.refunded || o.status === 'cancelled' || o.status === 'expired') return res.json({ ok: true, order: safeNum(o) });
      if (!o.supplierOrderId || o.sms || o.status === 'received') return res.status(400).json({ error: 'This order can no longer be cancelled.' });
      let d; try { d = await call('/cancel/' + encodeURIComponent(o.supplierOrderId)); } catch (e) { const f = await syncNumber(o).catch(() => null); if (f && (f.status === 'cancelled' || f.status === 'expired')) return res.json({ ok: true, order: safeNum(f) }); return res.status(400).json({ error: 'This order can no longer be cancelled.' }); }
      if (String(d.status) !== 'success') return res.status(400).json({ error: 'Provider has not confirmed cancellation.' });
      await claimRefund(NumOrder, o, 'cancelled', 'Number cancellation refund');
      res.json({ ok: true, order: safeNum(await NumOrder.findById(o._id).lean()) });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  // ═════════ TEMP EMAIL ═════════
  const eg = guard('emailEnabled', 'Temp Email');
  const safeEmail = (o) => ({ id: String(o._id), email: o.email || '', service: o.serviceName || o.domain || 'Email', domain: o.domain, site: o.site || '', price: o.price, status: o.status, code: o.code || null, createdAt: o.createdAt, canCancel: ['active', 'pending'].includes(o.status) && !o.code && !!o.emailId });
  async function emailList(server, domain, site, cfg) {
    if (server === 1) { const d = await call('/email/services', { server: 1, domain }); const out = []; for (const x of (d.services || [])) { const usd = Number(x.price); if (!(usd > 0)) continue; const p = await sell(cfg, 'email', usd, { name: String(x.name) }); out.push({ id: String(x.id), name: String(x.name), price: p.price, count: Number(x.count) || 0, usd }); } return out; }
    const d = await call('/email/services', { server: 2, site }); const out = []; for (const x of (d.domains || [])) { const usd = Number(x.price); if (!(usd > 0)) continue; const p = await sell(cfg, 'email', usd, { name: String(x.domain) }); out.push({ id: String(x.domain), name: String(x.name || x.domain), price: p.price, count: Number(x.count) || 0, usd }); } return out;
  }
  async function syncEmail(o) {
    if (!o.emailId || o.code || ['received', 'cancelled', 'refunded', 'failed'].includes(o.status)) return o;
    let d; try { d = await call('/email/code', { email_id: o.emailId }); } catch (e) { if (e.status === 404) return o; throw e; }
    const st = String(d.status);
    if (st === '200') { const m = (d.messages || []).find(x => x && x.code); if (m) await EmailOrder.updateOne({ _id: o._id }, { $set: { status: 'received', code: String(m.code), updatedAt: new Date() } }); }
    else if (st === '300') { await claimRefund(EmailOrder, o, 'cancelled', 'Temp email refund (no code received)'); }
    return EmailOrder.findById(o._id).lean();
  }
  app.get('/api/temp-email/options', auth, eg, async (req, res) => { const c = await getCfg(); res.json({ domains1: c.emailDomains1, sites: c.emailSites }); });
  app.get('/api/temp-email/services', auth, eg, async (req, res) => {
    const server = Number(req.query.server) === 2 ? 2 : 1; const domain = String(req.query.domain || '').toLowerCase(); const site = String(req.query.site || 'telegram.com').toLowerCase();
    if (server === 1 && !HOST_RE.test(domain)) return res.status(400).json({ error: 'Choose a mail domain.' }); if (server === 2 && !HOST_RE.test(site)) return res.status(400).json({ error: 'Enter a valid website.' });
    try { const cfg = await getCfg(); res.json((await emailList(server, domain, site, cfg)).map(({ usd, ...x }) => x)); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.get('/api/temp-email/orders', auth, async (req, res) => { try { res.json((await EmailOrder.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean()).map(safeEmail)); } catch (e) { res.status(500).json({ error: 'Could not load email history.' }); } });
  app.post('/api/temp-email/buy', auth, eg, async (req, res) => {
    const server = Number(req.body?.server) === 2 ? 2 : 1; const serviceId = String(req.body?.serviceId || '').trim().slice(0, 40); const domain = String(req.body?.domain || '').toLowerCase().trim(); const site = String(req.body?.site || 'telegram.com').toLowerCase().trim();
    if (server === 1 && (!/^[a-zA-Z0-9_-]{1,40}$/.test(serviceId) || !HOST_RE.test(domain))) return res.status(400).json({ error: 'Choose a domain and service.' });
    if (server === 2 && (!HOST_RE.test(domain) || !HOST_RE.test(site))) return res.status(400).json({ error: 'Choose a website and domain.' });
    const ref = cleanRef(req.body?.clientRef);
    try {
      const cfg = await getCfg();
      const existing = await EmailOrder.findOne({ ref }); if (existing) { if (String(existing.userId) !== String(req.user._id)) return res.status(409).json({ error: 'Invalid purchase reference.' }); return res.json({ ok: true, repeated: true, order: safeEmail(existing) }); }
      const unclear = await EmailOrder.findOne({ userId: req.user._id, status: 'review', createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } });
      if (unclear) return res.status(202).json({ ok: true, pending: true, orderId: String(unclear._id), message: 'A recent purchase is still being verified. Please check My Emails before trying again.' });
      const item = (await emailList(server, domain, site, cfg)).find(x => x.id === (server === 1 ? serviceId : domain));
      if (!item) return res.status(404).json({ error: 'That option is no longer available.' }); if (!(item.count > 0)) return res.status(409).json({ error: 'Out of stock right now. Try another one.' });
      const order = await EmailOrder.create({ userId: req.user._id, ref, server, serviceId: server === 1 ? serviceId : '', serviceName: server === 1 ? item.name : site, domain, site: server === 2 ? site : '', price: item.price, providerCost: item.usd, status: 'pending' });
      const r = await chargeAndCall(res, req, EmailOrder, order, item.price, async () => { const q = server === 1 ? { server: 1, service_id: serviceId, domain } : { server: 2, domain, site }; const d = await call('/email/buy', q, { timeout: 30000 }); if (String(d.status) !== '200' || !d.email_id) throw mkErr(d.message || 'No stock available', 409); return d; });
      if (!r) return;
      await EmailOrder.updateOne({ _id: order._id }, { $set: { emailId: String(r.d.email_id), email: String(r.d.email || ''), providerCost: Number(r.d.price) || item.usd, status: 'active', updatedAt: new Date() } });
      await tx(req.user._id, item.price, 'Temp Email — ' + (server === 1 ? item.name : domain));
      res.json({ ok: true, order: safeEmail(await EmailOrder.findById(order._id).lean()), balance: r.user.balance });
    } catch (e) { console.error('[SMS-COOL] email buy failed:', e.message); res.status(e.status || 500).json({ error: e.message || 'Could not buy an email.' }); }
  });
  app.get('/api/temp-email/code/:id', auth, async (req, res) => {
    try { if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Order not found.' }); const o = await EmailOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) return res.status(404).json({ error: 'Order not found.' }); res.json({ order: safeEmail(await syncEmail(o)) }); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.post('/api/temp-email/cancel/:id', auth, async (req, res) => {
    try {
      if (!/^[a-f0-9]{24}$/i.test(req.params.id)) return res.status(404).json({ error: 'Order not found.' });
      const o = await EmailOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) return res.status(404).json({ error: 'Order not found.' });
      if (o.refunded || o.status === 'cancelled') return res.json({ ok: true, order: safeEmail(o) });
      if (!o.emailId || o.code || o.status === 'received') return res.status(400).json({ error: 'This email can no longer be cancelled.' });
      let d; try { d = await call('/email/cancel', { email_id: o.emailId }); } catch (e) { return res.status(400).json({ error: 'This email can no longer be cancelled.' }); }
      if (String(d.status) !== '200') return res.status(400).json({ error: d.message || 'This email can no longer be cancelled.' });
      await claimRefund(EmailOrder, o, 'cancelled', 'Temp email cancellation refund');
      res.json({ ok: true, order: safeEmail(await EmailOrder.findById(o._id).lean()) });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  // ═════════ RENTALS (number rental + dedicated per-service rental) ═════════
  const rg = guard('rentalEnabled', 'Rental');
  const RENT_PROVIDERS = [1, 2];
  const rentalCountries = () => cached('rcountries', 600000, async () => {
    const map = new Map(); const rs = await Promise.allSettled(RENT_PROVIDERS.map(p => call('/rental/countries', { provider: p })));
    let ok = 0; for (const r of rs) { if (r.status !== 'fulfilled') continue; ok++; for (const c of (r.value.countries || [])) { const code = String(c.country_code || '').toLowerCase(); if (code && !map.has(code)) map.set(code, { code, name: String(c.country_name || code) }); } }
    if (!ok) throw rs[0].reason || mkErr('Rental service is not available right now.', 502);
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
  async function rentalPricing(country, cfg) {
    const rows = []; const rs = await Promise.allSettled(RENT_PROVIDERS.map(p => call('/rental/pricing', { provider: p, country_code: country }).then(d => ({ p, d }))));
    for (const r of rs) { if (r.status !== 'fulfilled') continue; for (const x of (r.value.d.pricing || [])) { const usd = Number(x.custom_price), hours = Number(x.duration_hours); if (!(usd > 0) || !(hours > 0)) continue; const pr = await sell(cfg, 'rental', usd, { name: String(hours), country }); rows.push({ provider: r.value.p, hours, price: pr.price, usd }); } }
    return rows.sort((a, b) => a.hours - b.hours || a.provider - b.provider);
  }
  async function psServices(country, cfg) {
    const d = await call('/per-service/services', { country_code: country.toUpperCase() }); const out = [];
    for (const x of (d.services || [])) { const usd = Number(x.custom_price); const preset = String(x.duration_preset || ''); if (!(usd > 0) || !PRESET_HOURS[preset]) continue; const pr = await sell(cfg, 'rental', usd, { name: String(x.service_name || x.service_code).toLowerCase() + '|' + preset, country }); out.push({ code: String(x.service_code), name: String(x.service_name || x.service_code), preset, label: PRESET_LABEL[preset], price: pr.price, usd }); }
    return out;
  }
  const rentalStatus = (o) => (o.status === 'active' && o.expiresAt && new Date(o.expiresAt) < new Date()) ? 'expired' : o.status;
  const safeRental = (o) => {
    const st = rentalStatus(o); const age = Date.now() - new Date(o.createdAt).getTime(); const win = CANCEL_WINDOW_MS[o.provider] || 0;
    return { id: String(o._id), kind: o.kind, service: o.kind === 'perservice' ? o.serviceName : 'Number rental', country: String(o.countryCode || '').toUpperCase(), number: o.phone || '', price: o.price, status: st, expiresAt: o.expiresAt || null, createdAt: o.createdAt, hours: o.durationHours, smsCount: o.smsCount || 0, canCancel: o.kind === 'rental' && o.status === 'active' && !o.refunded && !(o.smsCount > 0) && age < win, canRenew: ['active', 'expired'].includes(st) && !!o.supplierId };
  };
  const hoursLabel = (h) => h >= 720 && h % 720 === 0 ? (h / 720) + (h === 720 ? ' month' : ' months') : h >= 24 && h % 24 === 0 ? (h / 24) + (h === 24 ? ' day' : ' days') : h + ' hours';

  app.get('/api/rentals/countries', auth, rg, async (req, res) => { try { res.json(await rentalCountries()); } catch (e) { res.status(e.status || 502).json({ error: e.message }); } });
  app.get('/api/rentals/pricing', auth, rg, async (req, res) => {
    const c = String(req.query.country || '').toLowerCase(); if (!/^[a-z]{2,3}$/.test(c)) return res.status(400).json({ error: 'Choose a country.' });
    try { const cfg = await getCfg(); res.json((await rentalPricing(c, cfg)).map(r => ({ provider: r.provider, hours: r.hours, label: hoursLabel(r.hours), price: r.price, cancelNote: r.provider === 2 ? 'Cancel with refund within 2 hours if no SMS arrived' : 'Cancel with refund within 20 minutes if no SMS arrived' }))); }
    catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.get('/api/rentals/ps/services', auth, rg, async (req, res) => {
    const c = String(req.query.country || '').toLowerCase(); if (!/^[a-z]{2,3}$/.test(c)) return res.status(400).json({ error: 'Choose a country.' });
    try { const cfg = await getCfg(); res.json((await psServices(c, cfg)).map(({ usd, ...x }) => x)); } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.get('/api/rentals/orders', auth, async (req, res) => { try { res.json((await RentalOrder.find({ userId: req.user._id, status: { $in: ['active', 'expired', 'cancelled', 'review', 'refunded'] } }).sort({ createdAt: -1 }).limit(60).lean()).map(safeRental)); } catch (e) { res.status(500).json({ error: 'Could not load rentals.' }); } });

  async function buyRental(req, res, kind) {
    const b = req.body || {}; const country = String(b.country || '').toLowerCase();
    if (!/^[a-z]{2,3}$/.test(country)) return res.status(400).json({ error: 'Choose a country.' });
    const ref = cleanRef(b.clientRef);
    try {
      const cfg = await getCfg();
      const existing = await RentalOrder.findOne({ ref }); if (existing) { if (String(existing.userId) !== String(req.user._id)) return res.status(409).json({ error: 'Invalid purchase reference.' }); return res.json({ ok: true, repeated: true, order: safeRental(existing) }); }
      const unclear = await RentalOrder.findOne({ userId: req.user._id, status: 'review', createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } });
      if (unclear) return res.status(202).json({ ok: true, pending: true, orderId: String(unclear._id), message: 'A recent rental is still being verified. Please check My Rentals before trying again.' });
      let fields, q, path_;
      if (kind === 'rental') {
        const provider = Number(b.provider), hours = Number(b.hours); if (!RENT_PROVIDERS.includes(provider) || !(hours > 0)) return res.status(400).json({ error: 'Choose a rental period.' });
        const row = (await rentalPricing(country, cfg)).find(r => r.provider === provider && r.hours === hours); if (!row) return res.status(404).json({ error: 'That rental option is no longer available.' });
        fields = { kind, provider, countryCode: country, durationHours: hours, serviceName: 'Number rental', price: row.price, providerCost: row.usd }; q = { provider, country_code: country, duration_hours: hours }; path_ = '/rental/buy';
      } else {
        const code = String(b.serviceCode || ''), preset = String(b.preset || ''); if (!/^[a-zA-Z0-9_-]{1,30}$/.test(code) || !PRESET_HOURS[preset]) return res.status(400).json({ error: 'Choose a service and period.' });
        const row = (await psServices(country, cfg)).find(r => r.code === code && r.preset === preset); if (!row) return res.status(404).json({ error: 'That option is no longer available.' });
        fields = { kind, provider: 0, countryCode: country, serviceCode: code, serviceName: row.name, durationPreset: preset, durationHours: PRESET_HOURS[preset], price: row.price, providerCost: row.usd }; q = { service_code: code, country_code: country.toUpperCase(), duration_preset: preset }; path_ = '/per-service/buy';
      }
      const order = await RentalOrder.create({ userId: req.user._id, ref, status: 'pending', ...fields });
      const r = await chargeAndCall(res, req, RentalOrder, order, fields.price, async () => { const d = await call(path_, q, { timeout: 30000 }); const id = d.id ?? d.rental_id; if (String(d.status) !== '200' || id === undefined) throw mkErr(d.message || 'Not available', 409); return d; });
      if (!r) return; const d = r.d;
      await RentalOrder.updateOne({ _id: order._id }, { $set: { supplierId: String(d.id ?? d.rental_id), phone: String(d.phone_number || ''), providerCost: Number(d.price_paid) || fields.providerCost, expiresAt: parseDate(d.expiry_time), status: 'active', updatedAt: new Date() } });
      await tx(req.user._id, fields.price, 'Rental — ' + (kind === 'rental' ? hoursLabel(fields.durationHours) + ' number' : fields.serviceName));
      res.json({ ok: true, order: safeRental(await RentalOrder.findById(order._id).lean()), balance: r.user.balance });
    } catch (e) { console.error('[SMS-COOL] rental buy failed:', e.message); res.status(e.status || 500).json({ error: e.message || 'Could not complete the rental.' }); }
  }
  app.post('/api/rentals/buy', auth, rg, (req, res) => buyRental(req, res, 'rental'));
  app.post('/api/rentals/ps/buy', auth, rg, (req, res) => buyRental(req, res, 'perservice'));

  const ownRental = async (req, res) => { if (!/^[a-f0-9]{24}$/i.test(req.params.id)) { res.status(404).json({ error: 'Rental not found.' }); return null; } const o = await RentalOrder.findOne({ _id: req.params.id, userId: req.user._id }); if (!o) res.status(404).json({ error: 'Rental not found.' }); return o; };
  app.get('/api/rentals/sms/:id', auth, async (req, res) => {
    try {
      const o = await ownRental(req, res); if (!o) return; if (!o.supplierId) return res.json({ messages: [], order: safeRental(o) });
      const d = o.kind === 'rental' ? await call('/rental/sms', { order_id: o.supplierId }) : await call('/per-service/sms', { rental_id: o.supplierId });
      const msgs = (d.messages || []).map(m => ({ content: String(m.content || ''), sender: m.sender ? String(m.sender) : '', at: m.received_at || null }));
      if (msgs.length !== (o.smsCount || 0)) await RentalOrder.updateOne({ _id: o._id }, { $set: { smsCount: msgs.length, updatedAt: new Date() } });
      res.json({ messages: msgs, order: safeRental(await RentalOrder.findById(o._id).lean()) });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.get('/api/rentals/renew-options/:id', auth, rg, async (req, res) => {
    try {
      const o = await ownRental(req, res); if (!o) return; const cfg = await getCfg();
      if (o.kind === 'rental') return res.json((await rentalPricing(o.countryCode, cfg)).filter(r => r.provider === o.provider).map(r => ({ value: String(r.hours), label: hoursLabel(r.hours), price: r.price })));
      res.json((await psServices(o.countryCode, cfg)).filter(r => r.code === o.serviceCode).map(r => ({ value: r.preset, label: r.label, price: r.price })));
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.post('/api/rentals/renew/:id', auth, rg, async (req, res) => {
    try {
      const o = await ownRental(req, res); if (!o) return; if (!o.supplierId || !['active'].includes(o.status)) return res.status(400).json({ error: 'This rental cannot be renewed.' });
      const cfg = await getCfg(); const val = String(req.body?.value || '');
      let opt, q, p_;
      if (o.kind === 'rental') { opt = (await rentalPricing(o.countryCode, cfg)).find(r => r.provider === o.provider && String(r.hours) === val); q = { rental_id: o.supplierId, duration_hours: val }; p_ = '/rental/renew'; }
      else { opt = (await psServices(o.countryCode, cfg)).find(r => r.code === o.serviceCode && r.preset === val); q = { rental_id: o.supplierId, duration_preset: val }; p_ = '/per-service/renew'; }
      if (!opt) return res.status(404).json({ error: 'That renewal option is no longer available.' });
      const user = await charge(req.user._id, opt.price); if (!user) return res.status(400).json({ error: 'Insufficient wallet balance.' });
      let d; try { d = await call(p_, q, { timeout: 30000 }); if (String(d.status) !== '200') throw mkErr(d.message || 'Renewal failed', 400); }
      catch (e) {
        if (e.ambiguous) { await RentalOrder.updateOne({ _id: o._id }, { $set: { lastError: 'Renewal result unclear (' + opt.price + ' charged) — admin review', updatedAt: new Date() } }); return res.status(202).json({ ok: true, pending: true, message: 'The renewal result is unclear. Please check your rental expiry in a minute and contact support if it was not extended.' }); }
        await User.updateOne({ _id: req.user._id }, { $inc: { balance: opt.price } }); await Transaction.create({ userId: req.user._id, type: 'refund', amount: opt.price, description: 'Rental renewal refund', status: 'success' }).catch(() => {});
        return res.status(400).json({ error: 'We could not renew this rental. Nothing was charged.' });
      }
      await RentalOrder.updateOne({ _id: o._id }, { $set: { expiresAt: parseDate(d.new_expiry) || o.expiresAt, updatedAt: new Date() }, $push: { renewals: { price: opt.price, hours: Number(o.kind === 'rental' ? val : PRESET_HOURS[val]), at: new Date() } } });
      await tx(req.user._id, opt.price, 'Rental renewal — ' + (opt.label || hoursLabel(opt.hours)));
      res.json({ ok: true, order: safeRental(await RentalOrder.findById(o._id).lean()), balance: user.balance });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.post('/api/rentals/cancel/:id', auth, async (req, res) => {
    try {
      const o = await ownRental(req, res); if (!o) return; if (o.refunded || o.status === 'cancelled') return res.json({ ok: true, order: safeRental(o) });
      const s = safeRental(o); if (!s.canCancel) return res.status(400).json({ error: 'This rental can no longer be cancelled.' });
      let d; try { d = await call('/rental/cancel', { rental_id: o.supplierId }); } catch (e) { return res.status(400).json({ error: 'This rental can no longer be cancelled.' }); }
      if (String(d.status) !== '200') return res.status(400).json({ error: d.message || 'This rental can no longer be cancelled.' });
      await claimRefund(RentalOrder, o, 'cancelled', 'Rental cancellation refund');
      res.json({ ok: true, order: safeRental(await RentalOrder.findById(o._id).lean()) });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });

  // ═════════ background safety net: refund/finish orders even if the customer closes the page ═════════
  let sweeping = false;
  setInterval(async () => {
    if (sweeping || !key()) return; sweeping = true;
    try {
      const nOld = new Date(Date.now() - 22 * 60 * 1000), nNew = new Date(Date.now() - 6 * 60 * 60 * 1000);
      for (const o of await NumOrder.find({ status: { $in: ['waiting', 'pending'] }, supplierOrderId: { $ne: '' }, createdAt: { $lt: nOld, $gt: nNew } }).limit(30)) await syncNumber(o).catch(() => {});
      for (const o of await EmailOrder.find({ status: 'active', emailId: { $ne: '' }, createdAt: { $lt: new Date(Date.now() - 25 * 60 * 1000), $gt: nNew } }).limit(30)) await syncEmail(o).catch(() => {});
    } catch (e) { /* never crash the server */ } finally { sweeping = false; }
  }, 90 * 1000).unref?.();

  // ═════════ ADMIN (same paths the admin panel already uses) ═════════
  const adminRows = async () => {
    const [a, b, c] = await Promise.all([NumOrder.find({}).sort({ createdAt: -1 }).limit(60).lean(), EmailOrder.find({}).sort({ createdAt: -1 }).limit(40).lean(), RentalOrder.find({}).sort({ createdAt: -1 }).limit(40).lean()]);
    const row = (t, o, service, number) => ({ id: String(o._id), userId: String(o.userId), type: t, service, number, price: o.price, status: o.status, lastError: o.lastError || '', refunded: !!o.refunded, providerCost: o.providerCost || 0, createdAt: o.createdAt });
    return [...a.map(o => row('number', o, o.serviceName, o.phoneNumber)), ...b.map(o => row('email', o, 'Temp Email ' + (o.serviceName || ''), o.email)), ...c.map(o => row('rental', o, 'Rental ' + (o.serviceName || ''), o.phone))].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt)).slice(0, 100);
  };
  const cfgOut = (c) => ({ configured: !!key(), baseUrl: base(), enabled: c.enabled, emailEnabled: c.emailEnabled, rentalEnabled: c.rentalEnabled, markupNgn: c.markupNgn, markupPercent: c.markupPercent, emailMarkupNgn: c.emailMarkupNgn, emailMarkupPercent: c.emailMarkupPercent, rentalMarkupNgn: c.rentalMarkupNgn, rentalMarkupPercent: c.rentalMarkupPercent, overrides: (c.overrides || []).map(o => ({ kind: o.kind, name: o.name, country: o.country || '', price: o.price })), emailDomains1: c.emailDomains1, emailSites: c.emailSites });
  app.get('/api/admin/otp-suite/status', anyAdminAuth, async (req, res) => { res.json(cfgOut(await getCfg())); });
  app.get('/api/admin/otp-suite/orders', anyAdminAuth, async (req, res) => { try { res.json(await adminRows()); } catch (e) { res.status(500).json({ error: 'Could not load orders.' }); } });
  // Browse the provider catalog (servers -> countries -> services with cost and current selling price) to set exact prices.
  app.get('/api/admin/otp-suite/browse', anyAdminAuth, async (req, res) => {
    try {
      const sv = req.query.server ? await okServer(req.query.server) : 0; const country = String(req.query.country || '');
      if (!sv) return res.json({ servers: await serverList() });
      if (!/^\d{1,6}$/.test(country)) return res.json({ countries: (await countriesFor(sv)).map(c => ({ id: c.id, name: c.name })) });
      const cfg = await getCfg(); const out = [];
      for (const x of await servicesFor(sv, country, true)) { const p = await sell(cfg, 'num', x.usd, { name: x.name, country }); out.push({ id: x.id, name: x.name, usd: x.usd, costNgn: p.cost, sellPrice: p.price, override: !!p.override }); }
      res.json({ services: out });
    } catch (e) { res.status(e.status || 502).json({ error: e.message }); }
  });
  app.put('/api/admin/otp-suite/config', anyAdminAuth, async (req, res) => {
    const c = await getCfg(); const b = req.body || {};
    for (const f of ['enabled', 'emailEnabled', 'rentalEnabled']) if (typeof b[f] === 'boolean') c[f] = b[f];
    for (const [f, max] of [['markupNgn', 1e6], ['emailMarkupNgn', 1e6], ['rentalMarkupNgn', 1e6], ['markupPercent', 1000], ['emailMarkupPercent', 1000], ['rentalMarkupPercent', 1000]]) if (b[f] !== undefined && b[f] !== null && b[f] !== '') { const n = Number(b[f]); if (!Number.isFinite(n) || n < 0 || n > max) return res.status(400).json({ error: f + ' is out of range.' }); c[f] = n; }
    if (Array.isArray(b.overrides)) {
      const out = []; for (const o of b.overrides.slice(0, 500)) { const kind = String(o.kind || ''), name = String(o.name || '').trim().slice(0, 80), price = Number(o.price); if (!['num', 'email', 'rental'].includes(kind) || !name || !Number.isFinite(price) || price <= 0 || price > 1e7) return res.status(400).json({ error: 'Each fixed price needs a type, a name and a price above 0.' }); out.push({ kind, name, country: String(o.country || '').trim().slice(0, 10), price: Math.round(price * 100) / 100 }); }
      c.overrides = out;
    }
    if (Array.isArray(b.emailDomains1)) c.emailDomains1 = b.emailDomains1.map(x => String(x).toLowerCase().trim()).filter(x => HOST_RE.test(x)).slice(0, 30);
    if (Array.isArray(b.emailSites)) c.emailSites = b.emailSites.map(x => String(x).toLowerCase().trim()).filter(x => HOST_RE.test(x)).slice(0, 60);
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKeyCipher = encryptSecret(b.apiKey.trim());
    if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) { try { const u = new URL(b.baseUrl.trim()); if (u.protocol === 'https:' && u.hostname === 'sms-cool.com') c.customBaseUrl = b.baseUrl.trim().replace(/\/+$/, ''); } catch (e) { /* keep the official URL */ } }
    await c.save(); await getCfg(); cache.clear(); prewarm();
    res.json({ ok: true, ...cfgOut(c) });
  });
  app.post('/api/admin/otp-suite/orders/:id/refund', anyAdminAuth, async (req, res) => {
    try {
      let Model = null, o = null; for (const M of [NumOrder, EmailOrder, RentalOrder]) { o = await M.findById(req.params.id).catch(() => null); if (o) { Model = M; break; } }
      if (!o) return res.status(404).json({ error: 'Order not found.' }); if (!o.debited) return res.status(400).json({ error: 'This order was not charged.' }); if (o.refunded) return res.status(400).json({ error: 'This order has already been refunded.' });
      if (o.sms || o.code || o.status === 'received' || o.smsCount > 0) return res.status(400).json({ error: 'A code/message was delivered for this order, so it cannot be refunded here.' });
      const c = await claimRefund(Model, o, 'refunded', 'Manual refund by admin', 'Refunded manually by admin after provider review.'); if (!c) return res.status(409).json({ error: 'This order was already processed.' });
      res.json({ ok: true, refunded: o.price || 0 });
    } catch (e) { res.status(500).json({ error: 'Wallet refund failed; order was returned to review.' }); }
  });
  app.get('/api/admin/otp-suite/balance', anyAdminAuth, async (req, res) => { try { const d = await call('/balance'); const usd = Number(d.balance) || 0; res.json({ balance: Math.round(await usdToNgn(usd)), balanceUsd: usd }); } catch (e) { res.status(e.status || 502).json({ error: e.message }); } });

  // Keep the lists customers see first (servers, countries, rental countries, email options) warm so pages open instantly,
  // even right after a restart. Failures are ignored; the next customer request simply loads normally.
  async function prewarm() {
    try { const sv = await serverList(); await Promise.allSettled(sv.map(x => countriesFor(x.server_number))); } catch (e) {}
    try { await rentalCountries(); } catch (e) {}
  }
  setTimeout(() => { prewarm(); const t = setInterval(prewarm, 4 * 60 * 1000); if (t.unref) t.unref(); }, 3000);
};
