'use strict';
// Websites for sale — the admin lists ready-made websites (a price, a CUSTOMER panel
// demo link, and optionally an ADMIN panel demo link). Customers open the demo links
// from the "Website" page on the dashboard to see how each site looks before buying.
//
// Routes:
//   GET    /api/websites            public  — published websites (for the customer page)
//   GET    /api/admin/websites      admin   — all websites (incl. hidden)
//   POST   /api/admin/websites      admin   — create
//   PUT    /api/admin/websites/:id  admin   — edit
//   DELETE /api/admin/websites/:id  admin   — delete

module.exports.register = function register(app, deps) {
  const { mongoose, anyAdminAuth } = deps;

  const schema = new mongoose.Schema({
    title:            { type: String, required: true, trim: true, maxlength: 120 },
    description:      { type: String, default: '', maxlength: 2000 },
    price:            { type: Number, required: true, min: 0 },
    customerPanelUrl: { type: String, required: true },   // demo link anyone can open
    adminPanelUrl:    { type: String, default: '' },      // optional demo of the admin side
    demoNote:         { type: String, default: '', maxlength: 500 }, // e.g. demo login details
    imageUrl:         { type: String, default: '' },      // optional screenshot link
    sold:             { type: Boolean, default: false },
    published:        { type: Boolean, default: true },
    sortOrder:        { type: Number, default: 0 },
    createdAt:        { type: Date, default: Date.now },
    updatedAt:        { type: Date, default: Date.now },
  });
  const Website = mongoose.models.WebsiteListing || mongoose.model('WebsiteListing', schema);

  // Only real web links are accepted (no javascript:, data:, etc.).
  const safeLink = (u) => {
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString() : ''; } catch (_) { return ''; }
  };

  const shape = (w) => ({
    id: String(w._id), title: w.title, description: w.description, price: w.price,
    customerPanelUrl: w.customerPanelUrl, adminPanelUrl: w.adminPanelUrl || '',
    demoNote: w.demoNote || '', imageUrl: w.imageUrl || '',
    sold: !!w.sold, published: w.published !== false, sortOrder: w.sortOrder || 0,
    createdAt: w.createdAt, updatedAt: w.updatedAt,
  });

  app.get('/api/websites', async (req, res) => {
    try {
      const docs = await Website.find({ published: true }).sort({ sortOrder: 1, createdAt: -1 }).lean();
      res.set('Cache-Control', 'no-store');
      res.json(docs.map(shape));
    } catch (e) { res.status(500).json({ error: 'Failed to load websites' }); }
  });

  app.get('/api/admin/websites', anyAdminAuth, async (req, res) => {
    try {
      const docs = await Website.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
      res.json(docs.map(shape));
    } catch (e) { res.status(500).json({ error: 'Failed to load websites' }); }
  });

  const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on';

  // Returns { data } or { error } so create and edit share the same validation.
  function readBody(b, isCreate) {
    const out = {};
    if (b.title !== undefined) out.title = String(b.title).trim();
    if (b.description !== undefined) out.description = String(b.description).trim();
    if (b.price !== undefined && b.price !== '') {
      const p = Number(String(b.price).replace(/,/g, ''));
      if (!isFinite(p) || p < 0) return { error: 'Enter a valid price' };
      out.price = Math.round(p * 100) / 100;
    }
    if (b.customerPanelUrl !== undefined) {
      out.customerPanelUrl = safeLink(b.customerPanelUrl);
      if (!out.customerPanelUrl) return { error: 'Enter a valid customer panel link (https://…)' };
    }
    if (b.adminPanelUrl !== undefined) {
      const raw = String(b.adminPanelUrl).trim();
      out.adminPanelUrl = raw ? safeLink(raw) : '';
      if (raw && !out.adminPanelUrl) return { error: 'The admin panel link is not a valid link' };
    }
    if (b.imageUrl !== undefined) {
      const raw = String(b.imageUrl).trim();
      out.imageUrl = raw ? safeLink(raw) : '';
      if (raw && !out.imageUrl) return { error: 'The picture link is not a valid link' };
    }
    if (b.demoNote !== undefined) out.demoNote = String(b.demoNote).trim();
    if (b.sortOrder !== undefined && b.sortOrder !== '') out.sortOrder = Number(b.sortOrder) || 0;
    if (b.sold !== undefined) out.sold = bool(b.sold);
    if (b.published !== undefined) out.published = bool(b.published);
    if (isCreate) {
      if (!out.title) return { error: 'Please enter the website name' };
      if (out.price === undefined) return { error: 'Please enter the price' };
      if (!out.customerPanelUrl) return { error: 'Please enter the customer panel link' };
    } else if (out.title === '') return { error: 'The website name cannot be empty' };
    return { data: out };
  }

  app.post('/api/admin/websites', anyAdminAuth, async (req, res) => {
    try {
      const r = readBody(req.body || {}, true);
      if (r.error) return res.status(400).json({ error: r.error });
      const doc = await Website.create(r.data);
      res.json(shape(doc));
    } catch (e) { res.status(500).json({ error: 'Failed to save website: ' + e.message }); }
  });

  app.put('/api/admin/websites/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const r = readBody(req.body || {}, false);
      if (r.error) return res.status(400).json({ error: r.error });
      r.data.updatedAt = new Date();
      const doc = await Website.findByIdAndUpdate(req.params.id, r.data, { new: true });
      if (!doc) return res.status(404).json({ error: 'Website not found' });
      res.json(shape(doc));
    } catch (e) { res.status(500).json({ error: 'Failed to update website: ' + e.message }); }
  });

  app.delete('/api/admin/websites/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      await Website.findByIdAndDelete(req.params.id);
      res.json({ message: 'Website deleted' });
    } catch (e) { res.status(500).json({ error: 'Failed to delete website' }); }
  });
};
