// ── Buy Number advice banner (WhatsApp login help) ──────────────────────────
// One settings document edited from Admin → Number notice.
//   GET  /api/number-notice        public  - what customers see
//   GET  /api/admin/number-notice  admin   - full settings
//   PUT  /api/admin/number-notice  admin   - validate + save
const DEFAULTS = Object.freeze({
  enabled: true,
  title: 'Before you buy a number — read this',
  message: [
    'Having trouble logging in to WhatsApp ("login unavailable", "try again later")? Do this first:',
    '1. Download and turn on Octohide VPN (or any good VPN) and connect to the same country as your number.',
    '2. Uninstall WhatsApp completely, then install a fresh copy from the Play Store / App Store.',
    '3. Make sure your phone date and time are set to automatic.',
    '4. Enter the number, request the code, and paste the code here once it arrives.',
    'Do not request the code many times in a row. Wait a few minutes between tries.'
  ].join('\n'),
  buttonText: 'I understand, continue'
});
const LIMITS = { title: 120, message: 2500, buttonText: 60 };

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}
function validate(b) {
  b = b || {};
  if (typeof b.enabled !== 'boolean') return { ok: false, error: 'Status must be on or off.' };
  const out = { enabled: b.enabled };
  for (const k of ['title', 'message', 'buttonText']) {
    const raw = String(b[k] == null ? '' : b[k]);
    if (raw.length > LIMITS[k] * 3) return { ok: false, error: `${k} is far too long (max ${LIMITS[k]} characters).` };
    const v = cleanText(raw, LIMITS[k] + 1);
    if (v.length > LIMITS[k]) return { ok: false, error: `${k} is too long (max ${LIMITS[k]} characters).` };
    out[k] = v;
  }
  if (!out.title) return { ok: false, error: 'The title cannot be empty.' };
  if (!out.message) return { ok: false, error: 'The message cannot be empty.' };
  if (!out.buttonText) return { ok: false, error: 'The button text cannot be empty.' };
  return { ok: true, value: out };
}

function register(app, deps) {
  const { mongoose, adminAuth } = deps;
  const schema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    enabled: { type: Boolean, default: DEFAULTS.enabled },
    title: { type: String, default: DEFAULTS.title },
    message: { type: String, default: DEFAULTS.message },
    buttonText: { type: String, default: DEFAULTS.buttonText },
    updatedAt: { type: Date, default: null }
  });
  const NumberNotice = mongoose.models.NumberNotice || mongoose.model('NumberNotice', schema);
  const pick = (d) => ({
    enabled: d && typeof d.enabled === 'boolean' ? d.enabled : DEFAULTS.enabled,
    title: (d && d.title) || DEFAULTS.title,
    message: (d && d.message) || DEFAULTS.message,
    buttonText: (d && d.buttonText) || DEFAULTS.buttonText
  });
  const load = async () => { try { return pick(await NumberNotice.findOne({ key: 'main' }).lean()); } catch (e) { return pick(null); } };

  app.get('/api/number-notice', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const s = await load();
    const d = await NumberNotice.findOne({ key: 'main' }).select('updatedAt').lean().catch(() => null);
    res.json({ ...s, version: d && d.updatedAt ? new Date(d.updatedAt).getTime() : 0 });
  });
  app.get('/api/admin/number-notice', adminAuth, async (req, res) => {
    try {
      const doc = await NumberNotice.findOne({ key: 'main' }).lean();
      res.json({ settings: pick(doc), updatedAt: doc?.updatedAt || null, defaults: DEFAULTS, limits: LIMITS });
    } catch (e) { res.status(500).json({ error: 'Could not load the notice settings.' }); }
  });
  app.put('/api/admin/number-notice', adminAuth, async (req, res) => {
    const v = validate(req.body);
    if (!v.ok) return res.status(400).json({ error: v.error });
    try {
      await NumberNotice.updateOne({ key: 'main' }, { $set: { ...v.value, updatedAt: new Date() }, $setOnInsert: { key: 'main' } }, { upsert: true });
      const doc = await NumberNotice.findOne({ key: 'main' }).lean();
      res.json({ ok: true, settings: pick(doc), updatedAt: doc.updatedAt });
    } catch (e) { res.status(500).json({ error: 'Could not save. Please try again.' }); }
  });
}
module.exports = { register, validate, DEFAULTS };
