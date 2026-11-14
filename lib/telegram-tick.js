'use strict';
// Telegram Tick (Telegram verification) service.
//
// How it works
//   1. Admin adds packages (e.g. 3 months = ₦X, 6 months = ₦Y) in the admin panel.
//   2. Customer opens /telegram-tick, types their Telegram username, picks a package and
//      taps "Place order". The wallet must hold the full amount, otherwise the order is
//      refused and nothing is charged.
//   3. The wallet is debited atomically, the order is saved as "processing" and the admin is
//      alerted straight away (WhatsApp via UltraMsg if configured + email via Resend).
//   4. Admin does the verification, then sets the order to "completed" in the admin panel.
//      The customer gets a notification (bell + email). If the admin cancels instead, the
//      customer is refunded automatically, exactly once.
//
// Customer routes
//   GET  /api/telegram-tick/packages   (login)  switch + packages + balance
//   POST /api/telegram-tick/order      (login)  { username, packageId }
//   GET  /api/telegram-tick/orders     (login)  this customer's orders
// Admin routes
//   GET/PUT          /api/admin/telegram-tick/settings   ON/OFF switch + notice
//   GET/POST         /api/admin/telegram-tick/packages
//   PUT/DELETE       /api/admin/telegram-tick/packages/:id
//   GET              /api/admin/telegram-tick/orders?status=processing|completed|cancelled
//   PUT              /api/admin/telegram-tick/orders/:id   { status: 'completed'|'cancelled', note }

const axios = require('axios');
const crypto = require('crypto');

module.exports.register = function register(app, deps) {
  const { mongoose, User, Transaction, auth, anyAdminAuth, sendAdminEmail } = deps;

  // ── Models ────────────────────────────────────────────────────────────────
  const pkgSchema = new mongoose.Schema({
    months:    { type: Number, required: true, min: 1, max: 120 },
    label:     { type: String, default: '', maxlength: 60 },       // optional, e.g. "Best value"
    price:     { type: Number, required: true, min: 1 },
    active:    { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  });
  const Pkg = mongoose.models.TelegramTickPackage || mongoose.model('TelegramTickPackage', pkgSchema);

  const orderSchema = new mongoose.Schema({
    ref:         { type: String, unique: true, index: true },
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userName:    { type: String, default: '' },
    userEmail:   { type: String, default: '' },
    username:    { type: String, required: true },                 // Telegram username, no @
    packageId:   { type: mongoose.Schema.Types.ObjectId },
    months:      { type: Number, required: true },
    price:       { type: Number, required: true },
    status:      { type: String, enum: ['processing', 'completed', 'cancelled'], default: 'processing', index: true },
    adminNote:   { type: String, default: '', maxlength: 500 },
    refunded:    { type: Boolean, default: false },
    completedAt: { type: Date, default: null },
    createdAt:   { type: Date, default: Date.now, index: true },
    updatedAt:   { type: Date, default: Date.now },
  });
  const Order = mongoose.models.TelegramTickOrder || mongoose.model('TelegramTickOrder', orderSchema);

  const settingSchema = new mongoose.Schema({
    key:     { type: String, unique: true },
    enabled: { type: Boolean, default: true },
    notice:  { type: String, default: '', maxlength: 600 },        // shown to customers on the page
  });
  const Setting = mongoose.models.TelegramTickSetting || mongoose.model('TelegramTickSetting', settingSchema);
  async function getSettings() {
    let s = await Setting.findOne({ key: 'main' }).lean();
    if (!s) { try { s = (await Setting.create({ key: 'main' })).toObject(); } catch (_) { s = await Setting.findOne({ key: 'main' }).lean(); } }
    return s || { enabled: true, notice: '' };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  const naira = (n) => '₦' + Number(n || 0).toLocaleString('en-NG');
  const round2 = (n) => Math.round(Number(n) * 100) / 100;
  const monthsText = (m) => `${m} month${m === 1 ? '' : 's'}`;
  const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on';

  // Telegram usernames: 5–32 characters, letters, digits and underscore, starting with a letter.
  function cleanUsername(raw) {
    let u = String(raw || '').trim();
    u = u.replace(/^https?:\/\/(t\.me|telegram\.me)\//i, '').replace(/^@+/, '').split(/[/?#\s]/)[0];
    return /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(u) ? u : '';
  }

  const shapeOrder = (o) => ({
    id: String(o._id), ref: o.ref, username: o.username, months: o.months, price: o.price,
    status: o.status, adminNote: o.adminNote || '', createdAt: o.createdAt, completedAt: o.completedAt || null,
  });
  const shapeAdminOrder = (o) => ({ ...shapeOrder(o), userName: o.userName, userEmail: o.userEmail, refunded: !!o.refunded });
  const shapePkg = (p) => ({
    id: String(p._id), months: p.months, label: p.label || '', price: p.price,
    active: p.active !== false, sortOrder: p.sortOrder || 0,
  });

  // Tell the admin a new order arrived. Never throws; the order is already saved.
  async function notifyAdmin(order) {
    const siteUrl = process.env.SITE_URL || '';
    const adminPath = process.env.ADMIN_SECRET_PATH || '';
    const text =
      `NEW TELEGRAM TICK ORDER\n\n` +
      `Telegram username: @${order.username}\n` +
      `Package: ${monthsText(order.months)} - ${naira(order.price)}\n` +
      `Customer: ${order.userName || '-'} (${order.userEmail || '-'})\n` +
      `Order: ${order.ref}\n` +
      `Time: ${new Date().toLocaleString('en-NG')}\n\n` +
      `Status: PROCESSING. Open the admin panel > Telegram Tick, do the verification, then mark it Completed.` +
      (siteUrl && adminPath ? `\n${siteUrl}/${adminPath}` : '');
    try {
      const instance = process.env.ULTRAMSG_INSTANCE, token = process.env.ULTRAMSG_TOKEN, phone = process.env.ADMIN_WHATSAPP;
      if (instance && token && phone) {
        await axios.post(`https://api.ultramsg.com/${instance}/messages/chat`, { token, to: phone, body: text }, { timeout: 10000 });
      }
    } catch (e) { console.error('[telegram-tick] whatsapp alert failed:', e.message); }
    try { await sendAdminEmail(undefined, `New Telegram Tick order - @${order.username} (${monthsText(order.months)})`, text); }
    catch (e) { console.error('[telegram-tick] email alert failed:', e.message); }
  }

  // ── Customer routes ───────────────────────────────────────────────────────
  app.get('/api/telegram-tick/packages', auth, async (req, res) => {
    try {
      const [s, docs, me] = await Promise.all([
        getSettings(),
        Pkg.find({ active: true }).sort({ sortOrder: 1, months: 1 }).lean(),
        User.findById(req.user._id).select('balance').lean(),
      ]);
      res.set('Cache-Control', 'no-store');
      res.json({ enabled: s.enabled !== false, notice: s.notice || '', balance: me ? me.balance || 0 : 0, packages: docs.map(shapePkg) });
    } catch (e) { res.status(500).json({ error: 'Failed to load packages' }); }
  });

  app.post('/api/telegram-tick/order', auth, async (req, res) => {
    try {
      const s = await getSettings();
      if (s.enabled === false) return res.status(403).json({ error: 'Telegram Tick is not available right now. Please check back later.' });

      const username = cleanUsername(req.body.username);
      if (!username) return res.status(400).json({ error: 'Enter a valid Telegram username (5-32 letters, numbers or underscore).' });

      let pkg = null;
      try { pkg = await Pkg.findOne({ _id: String(req.body.packageId || ''), active: true }).lean(); } catch (_) {}
      if (!pkg) return res.status(400).json({ error: 'Please select a package.' });

      // Same customer, same username, same package within 15 seconds = a double tap.
      const dup = await Order.findOne({
        userId: req.user._id, username, months: pkg.months, createdAt: { $gt: new Date(Date.now() - 15000) },
      }).lean();
      if (dup) return res.json({ ok: true, repeated: true, order: shapeOrder(dup) });

      // Balance check + debit in ONE atomic step: it can never go negative or be spent twice.
      const price = round2(pkg.price);
      const user = await User.findOneAndUpdate(
        { _id: req.user._id, balance: { $gte: price } }, { $inc: { balance: -price } }, { new: true });
      if (!user) {
        const me = await User.findById(req.user._id).select('balance').lean();
        const bal = me ? me.balance || 0 : 0;
        return res.status(400).json({
          error: `Insufficient balance. This package costs ${naira(price)} and your balance is ${naira(bal)}. Please deposit ${naira(price - bal)} or more.`,
          insufficient: true, needed: price, balance: bal,
        });
      }

      const ref = 'TT-' + crypto.randomBytes(4).toString('hex').toUpperCase();
      let order;
      try {
        order = await Order.create({
          ref, userId: user._id, userName: user.name || '', userEmail: user.email || '', username,
          packageId: pkg._id, months: pkg.months, price, status: 'processing',
        });
      } catch (e) {
        // Could not save the order: give the money straight back.
        await User.updateOne({ _id: user._id }, { $inc: { balance: price } }).catch(() => {});
        console.error('[telegram-tick] order save failed:', e.message);
        return res.status(500).json({ error: 'Could not place your order. You were not charged. Please try again.' });
      }
      try {
        await Transaction.create({
          userId: user._id, type: 'debit', amount: price, status: 'success', txRef: 'tick:' + ref,
          description: `Telegram Tick (${monthsText(pkg.months)}) for @${username}`,
        });
      } catch (_) { /* ledger entry is best-effort */ }

      notifyAdmin(order).catch(() => {});
      res.json({ ok: true, order: shapeOrder(order), balance: user.balance });
    } catch (e) {
      console.error('[telegram-tick] order error:', e.message);
      res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
  });

  app.get('/api/telegram-tick/orders', auth, async (req, res) => {
    try {
      const docs = await Order.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(50).lean();
      res.set('Cache-Control', 'no-store');
      res.json(docs.map(shapeOrder));
    } catch (e) { res.status(500).json({ error: 'Failed to load orders' }); }
  });

  // ── Admin routes ──────────────────────────────────────────────────────────
  app.get('/api/admin/telegram-tick/settings', anyAdminAuth, async (req, res) => {
    try {
      const s = await getSettings();
      const waiting = await Order.countDocuments({ status: 'processing' });
      res.json({ enabled: s.enabled !== false, notice: s.notice || '', processing: waiting });
    } catch (e) { res.status(500).json({ error: 'Failed to load settings' }); }
  });

  app.put('/api/admin/telegram-tick/settings', anyAdminAuth, async (req, res) => {
    try {
      const set = {};
      if (req.body.enabled !== undefined) set.enabled = bool(req.body.enabled);
      if (req.body.notice !== undefined) set.notice = String(req.body.notice).trim().slice(0, 600);
      await getSettings();
      await Setting.updateOne({ key: 'main' }, { $set: set });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to save settings' }); }
  });

  app.get('/api/admin/telegram-tick/packages', anyAdminAuth, async (req, res) => {
    try {
      const docs = await Pkg.find({}).sort({ sortOrder: 1, months: 1 }).lean();
      res.json(docs.map(shapePkg));
    } catch (e) { res.status(500).json({ error: 'Failed to load packages' }); }
  });

  function readPkg(b) {
    const out = {};
    if (b.months !== undefined) {
      const m = Math.round(Number(b.months));
      if (!isFinite(m) || m < 1 || m > 120) return { error: 'Enter the number of months (1 or more).' };
      out.months = m;
    }
    if (b.price !== undefined) {
      const p = Number(String(b.price).replace(/,/g, ''));
      if (!isFinite(p) || p < 1) return { error: 'Enter a valid amount.' };
      out.price = round2(p);
    }
    if (b.label !== undefined) out.label = String(b.label).trim().slice(0, 60);
    if (b.active !== undefined) out.active = bool(b.active);
    if (b.sortOrder !== undefined && b.sortOrder !== '') out.sortOrder = Number(b.sortOrder) || 0;
    return { data: out };
  }

  app.post('/api/admin/telegram-tick/packages', anyAdminAuth, async (req, res) => {
    try {
      const r = readPkg(req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      if (r.data.months === undefined || r.data.price === undefined) return res.status(400).json({ error: 'Months and amount are required.' });
      const doc = await Pkg.create(r.data);
      res.json(shapePkg(doc));
    } catch (e) { res.status(500).json({ error: 'Failed to add package' }); }
  });

  app.put('/api/admin/telegram-tick/packages/:id', anyAdminAuth, async (req, res) => {
    try {
      const r = readPkg(req.body);
      if (r.error) return res.status(400).json({ error: r.error });
      const doc = await Pkg.findByIdAndUpdate(req.params.id, { $set: r.data }, { new: true });
      if (!doc) return res.status(404).json({ error: 'Package not found' });
      res.json(shapePkg(doc));
    } catch (e) { res.status(500).json({ error: 'Failed to update package' }); }
  });

  app.delete('/api/admin/telegram-tick/packages/:id', anyAdminAuth, async (req, res) => {
    try { await Pkg.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: 'Failed to delete package' }); }
  });

  app.get('/api/admin/telegram-tick/orders', anyAdminAuth, async (req, res) => {
    try {
      const q = {};
      if (['processing', 'completed', 'cancelled'].includes(req.query.status)) q.status = req.query.status;
      const docs = await Order.find(q).sort({ createdAt: -1 }).limit(200).lean();
      res.json(docs.map(shapeAdminOrder));
    } catch (e) { res.status(500).json({ error: 'Failed to load orders' }); }
  });

  // Change an order's status. Only a "processing" order can move, and only once, so a
  // double click can never complete twice or refund twice.
  app.put('/api/admin/telegram-tick/orders/:id', anyAdminAuth, async (req, res) => {
    try {
      const status = String(req.body.status || '');
      if (!['completed', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Status must be completed or cancelled.' });
      const note = String(req.body.note || '').trim().slice(0, 500);
      const now = new Date();
      const set = { status, adminNote: note, updatedAt: now };
      if (status === 'completed') set.completedAt = now;

      const order = await Order.findOneAndUpdate({ _id: req.params.id, status: 'processing' }, { $set: set }, { new: true });
      if (!order) return res.status(409).json({ error: 'This order is no longer processing, so it cannot be changed.' });

      if (status === 'cancelled') {
        // Refund exactly once (the claim below is atomic).
        const claimed = await Order.findOneAndUpdate({ _id: order._id, refunded: false }, { $set: { refunded: true } }, { new: true });
        if (claimed) {
          await User.updateOne({ _id: order.userId }, { $inc: { balance: order.price } });
          try {
            await Transaction.create({
              userId: order.userId, type: 'refund', amount: order.price, status: 'success', txRef: 'tick-refund:' + order.ref,
              description: `Refund - Telegram Tick (${monthsText(order.months)}) for @${order.username}`,
            });
          } catch (_) {}
        }
      }

      // Email the customer (best effort). The bell notification is built from the order itself.
      if (order.userEmail) {
        const body = status === 'completed'
          ? `Good news! Your Telegram account @${order.username} has been verified (Telegram Tick, ${monthsText(order.months)}).\n\nAmount paid: ${naira(order.price)}\nOrder: ${order.ref}` + (note ? `\n\nNote: ${note}` : '') + `\n\nThank you for choosing us.`
          : `Your Telegram Tick order for @${order.username} (${monthsText(order.months)}) could not be completed and ${naira(order.price)} has been returned to your wallet.\nOrder: ${order.ref}` + (note ? `\n\nReason: ${note}` : '');
        sendAdminEmail(order.userEmail,
          status === 'completed' ? `Your Telegram Tick is ready - @${order.username}` : `Telegram Tick order cancelled - ${naira(order.price)} refunded`,
          body).catch(() => {});
      }
      res.json({ ok: true, order: shapeAdminOrder(order) });
    } catch (e) {
      console.error('[telegram-tick] status change failed:', e.message);
      res.status(500).json({ error: 'Failed to update the order' });
    }
  });
};
