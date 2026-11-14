// Price Adjustments — one admin control that raises or lowers EVERY customer price of a provider.
//
//   bn1     Buy Number 1  (Grizzly)        flat ₦ per number
//   bn2     Buy Number 2  (SMS-COOL)       flat ₦ per number
//   email   Temp Email    (SMS-COOL)       flat ₦ per email
//   rental  Rentals       (SMS-COOL)       ₦ per rental (use % for long rentals)
//   bn3     Buy Number 3  (Nova)           flat ₦ per number
//   boost1  Boosting 1    (Really Simple)  ₦ per 1,000 units ordered (so a 100-unit order moves by 1/10th)
//   boost2  Boosting 2    (Nova)           ₦ per 1,000 units ordered
//   m2/m3/m4 Marketplace 2 / 3 / 4         flat ₦ per item
//
// Each provider holds ONE signed adjustment: amountNgn (can be negative) and/or percent (can be negative).
// The adjustment is applied on top of the price the site already works out, in the same function that
// both DISPLAYS and CHARGES the price, so what the customer sees is exactly what is taken from the wallet.
// "Restore default" simply sets both back to 0 (the original pricing is never overwritten).
//
// apply() is synchronous (reads an in-memory copy that is refreshed from MongoDB every 15 s and right after
// every admin change) so it can be dropped into existing synchronous price functions.

const PROVIDERS = [
  { key: 'bn1',    label: 'Buy Number 1 (Grizzly SMS)',        unit: 'per number' },
  { key: 'bn2',    label: 'Buy Number 2 (SMS-COOL)',           unit: 'per number' },
  { key: 'email',  label: 'Temp Email (SMS-COOL)',             unit: 'per email' },
  { key: 'rental', label: 'Rentals (SMS-COOL)',                unit: 'per rental' },
  { key: 'bn3',    label: 'Buy Number 3 (NovaSolution)',       unit: 'per number' },
  { key: 'boost1', label: 'Boosting 1 (Really Simple Social)', unit: 'per 1,000 units' },
  { key: 'boost2', label: 'Boosting 2 (NovaSolution)',         unit: 'per 1,000 units' },
  { key: 'm2',     label: 'Marketplace 2 (RakibSocials)',      unit: 'per item' },
  { key: 'm3',     label: 'Marketplace 3 (Sujan Department)',  unit: 'per item' },
  { key: 'm4',     label: 'Marketplace 4',                     unit: 'per item' },
];
const KEYS = new Set(PROVIDERS.map(p => p.key));
const MAX_AMOUNT = 1000000;   // ₦1,000,000 either way
const MIN_PCT = -90, MAX_PCT = 500;

const store = { map: {}, listeners: [], Model: null, LogModel: null, loadedAt: 0 };

/** Current adjustment for a provider: { amountNgn, percent } (zeros when none). */
function get(key) {
  const a = store.map[key];
  return { amountNgn: Number(a && a.amountNgn) || 0, percent: Number(a && a.percent) || 0 };
}

/**
 * Apply the provider's adjustment to a customer price.
 *  opts.perUnits  multiplier for the ₦ amount (boosting: quantity / 1000). Default 1.
 *  opts.decimals  keep 2 decimals instead of rounding up to a whole naira (per-unit prices).
 *  opts.floor     supplier cost: a SUBTRACTION never takes the price below this (it can still not
 *                 push an already-cheaper price up). Protects against selling at a loss by accident.
 * A price that is not a positive number is returned untouched (never turns "hidden/0" into a live price).
 * The result never drops below ₦1 (or ₦0.01 with decimals) so a big subtraction cannot make a product free.
 */
function apply(key, price, opts) {
  const base = Number(price);
  if (!Number.isFinite(base) || base <= 0) return price;
  const a = get(key);
  if (!a.amountNgn && !a.percent) return price;
  const o = opts || {};
  const scale = Number.isFinite(Number(o.perUnits)) && Number(o.perUnits) >= 0 ? Number(o.perUnits) : 1;
  let p = base * (1 + a.percent / 100) + a.amountNgn * scale;
  if (!Number.isFinite(p)) return price;
  p = Math.round(p * 100) / 100;
  if (o.floor !== undefined && o.floor !== null && Number.isFinite(Number(o.floor))) p = Math.max(p, Math.min(Number(o.floor), base));
  if (o.decimals) return Math.max(0.01, p);
  return Math.max(1, Math.ceil(p));
}

function onChange(fn) { if (typeof fn === 'function') store.listeners.push(fn); }
function fire() { for (const fn of store.listeners) { try { fn(); } catch { /* never block a save */ } } }

async function reload() {
  if (!store.Model) return;
  const rows = await store.Model.find({}).lean();
  const next = {};
  for (const r of rows) if (KEYS.has(r.key)) next[r.key] = { amountNgn: Number(r.amountNgn) || 0, percent: Number(r.percent) || 0, updatedAt: r.updatedAt };
  const changed = JSON.stringify(Object.fromEntries(Object.entries(next).map(([k, v]) => [k, [v.amountNgn, v.percent]])))
    !== JSON.stringify(Object.fromEntries(Object.entries(store.map).map(([k, v]) => [k, [v.amountNgn, v.percent]])));
  store.map = next;
  store.loadedAt = Date.now();
  if (changed) fire();
}

function register(app, deps) {
  const { mongoose, anyAdminAuth } = deps;
  const S = mongoose.Schema;
  store.Model = mongoose.models.PriceAdjust || mongoose.model('PriceAdjust', new S({
    key: { type: String, unique: true, index: true },
    amountNgn: { type: Number, default: 0 },
    percent: { type: Number, default: 0 },
    updatedAt: { type: Date, default: Date.now },
  }));
  store.LogModel = mongoose.models.PriceAdjustLog || mongoose.model('PriceAdjustLog', new S({
    key: String, label: String, action: String, type: String, value: Number,
    before: { amountNgn: Number, percent: Number }, after: { amountNgn: Number, percent: Number },
    at: { type: Date, default: Date.now },
  }));

  reload().catch(() => {});
  setInterval(() => reload().catch(() => {}), 15000).unref?.();

  // Only the owner (passcode login) may change prices — not support sub-admins.
  const ownerOnly = (req, res, next) => (req.adminRole === 'super' ? next() : res.status(403).json({ error: 'Only the owner can change price adjustments.' }));

  app.get('/api/admin/price-adjust', anyAdminAuth, ownerOnly, async (req, res) => {
    try {
      await reload();
      const log = await store.LogModel.find({}).sort({ at: -1 }).limit(25).lean();
      res.json({
        providers: PROVIDERS.map(p => ({ ...p, ...get(p.key), updatedAt: (store.map[p.key] || {}).updatedAt || null })),
        log: log.map(l => ({ label: l.label, action: l.action, type: l.type, value: l.value, before: l.before, after: l.after, at: l.at })),
        limits: { maxAmount: MAX_AMOUNT, minPercent: MIN_PCT, maxPercent: MAX_PCT },
      });
    } catch (e) { res.status(500).json({ error: 'Could not load price adjustments.' }); }
  });

  // body: { keys: ['bn1','m2',...], action: 'add'|'subtract'|'set'|'reset', type: 'amount'|'percent', value: number }
  app.post('/api/admin/price-adjust', anyAdminAuth, ownerOnly, async (req, res) => {
    try {
      const b = req.body || {};
      const keys = [...new Set((Array.isArray(b.keys) ? b.keys : [b.key]).map(String))].filter(k => KEYS.has(k));
      if (!keys.length) return res.status(400).json({ error: 'Select at least one provider.' });
      const action = String(b.action || '');
      if (!['add', 'subtract', 'set', 'reset'].includes(action)) return res.status(400).json({ error: 'Choose add, subtract, set or restore default.' });
      const type = b.type === 'percent' ? 'percent' : 'amount';
      let value = 0;
      if (action !== 'reset') {
        value = Number(b.value);
        if (!Number.isFinite(value)) return res.status(400).json({ error: 'Enter a number.' });
        if ((action === 'add' || action === 'subtract') && value <= 0) return res.status(400).json({ error: 'Enter an amount greater than 0 (use Subtract to lower prices).' });
        if (Math.abs(value) > (type === 'percent' ? MAX_PCT : MAX_AMOUNT)) return res.status(400).json({ error: 'That value is too large.' });
      }
      await reload();
      const results = [];
      for (const key of keys) {
        const before = get(key);
        const after = { ...before };
        const field = type === 'percent' ? 'percent' : 'amountNgn';
        if (action === 'reset') { after.amountNgn = 0; after.percent = 0; }
        else if (action === 'add') after[field] = before[field] + value;
        else if (action === 'subtract') after[field] = before[field] - value;
        else after[field] = value;
        after.amountNgn = Math.round(after.amountNgn * 100) / 100;
        after.percent = Math.round(after.percent * 100) / 100;
        if (Math.abs(after.amountNgn) > MAX_AMOUNT) return res.status(400).json({ error: 'The total adjustment would be too large.' });
        if (after.percent < MIN_PCT || after.percent > MAX_PCT) return res.status(400).json({ error: `Percent must stay between ${MIN_PCT}% and ${MAX_PCT}%.` });
        results.push({ key, before, after });
      }
      for (const r of results) {
        await store.Model.updateOne({ key: r.key }, { $set: { key: r.key, amountNgn: r.after.amountNgn, percent: r.after.percent, updatedAt: new Date() } }, { upsert: true });
        const label = (PROVIDERS.find(p => p.key === r.key) || {}).label || r.key;
        await store.LogModel.create({ key: r.key, label, action, type, value, before: r.before, after: r.after }).catch(() => {});
      }
      await reload();
      fire();
      res.json({ ok: true, providers: PROVIDERS.map(p => ({ ...p, ...get(p.key) })) });
    } catch (e) { console.error('[price-adjust]', e.message); res.status(500).json({ error: 'Could not save the price adjustment.' }); }
  });
}

module.exports = { register, apply, get, onChange, PROVIDERS, _store: store };
