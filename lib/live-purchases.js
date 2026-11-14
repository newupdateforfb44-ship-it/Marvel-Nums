'use strict';
// Live purchases feed for the customer dashboard.
//
//   GET /api/live-purchases   (logged-in users) — the most recent successful purchases,
//                             with the buyer's name MASKED ("Kel***"), what was bought,
//                             the amount and the time. No emails, ids of users or balances
//                             are ever returned.
//
// Read-only: it never writes to the database (apart from one best-effort index so the
// "latest purchases" query stays fast on a big transactions collection).

module.exports.register = function register(app, deps) {
  const { User, Transaction, auth } = deps;

  const LIMIT = 15;          // rows sent to the browser
  const CACHE_MS = 8000;     // many dashboards polling at once share one DB query
  let cache = { at: 0, rows: [] };

  // Best-effort index (ignored if it already exists or the DB refuses).
  try {
    Transaction.collection
      .createIndex({ type: 1, status: 1, createdAt: -1 }, { background: true })
      .catch(() => {});
  } catch (_) { /* never block startup */ }

  // "Kelvin Obi" -> "Kel***". Only the first name is used, never the whole name.
  function maskName(name) {
    const first = String(name || '').trim().split(/\s+/)[0] || '';
    const chars = Array.from(first); // safe for emoji / non-latin names
    if (!chars.length) return 'User***';
    return chars.slice(0, Math.min(3, Math.max(1, chars.length - 1))).join('') + '***';
  }

  // Turn the internal ledger description into a clean "what was bought" label.
  function cleanItem(desc) {
    let s = String(desc || '').trim();
    s = s.replace(/^Purchased(?: via API)?:\s*/i, '')
         .replace(/^Purchased\s+\d+\s+accounts?\s+(?:via API:\s*|from\s+)/i, '')
         .replace(/^Bought\s+/i, '')
         .replace(/\s+[-–—]\s+Marketplace\s*\d+\s*$/i, '')
         .replace(/^Boost\s*2\s*[—-]\s*/i, 'Boost: ')
         .replace(/^Buy Number\s*\d\s*[—-]\s*/i, 'Number: ')
         .replace(/^Rented\s+(.+?)\s+number\s*(\([^)]*\))?.*$/i, (m, svc, c) => `Number: ${svc}${c ? ' ' + c : ''}`)
         .replace(/\s+/g, ' ')
         .trim();
    if (s.length > 90) s = s.slice(0, 87).trimEnd() + '…';
    return s || 'a product';
  }

  async function loadRows() {
    const txs = await Transaction
      .find({ type: 'purchase', status: 'success', reversed: { $ne: true } })
      .sort({ createdAt: -1 })
      .limit(LIMIT)
      .select('userId amount description createdAt')
      .lean();
    const ids = [...new Set(txs.map(t => String(t.userId)))];
    const users = ids.length ? await User.find({ _id: { $in: ids } }).select('name').lean() : [];
    const names = new Map(users.map(u => [String(u._id), u.name]));
    return txs.map(t => ({
      id: String(t._id),
      name: maskName(names.get(String(t.userId))),
      item: cleanItem(t.description),
      amount: Math.round(Number(t.amount) || 0),
      at: t.createdAt,
    }));
  }

  app.get('/api/live-purchases', auth, async (req, res) => {
    try {
      if (Date.now() - cache.at > CACHE_MS) {
        cache = { at: Date.now(), rows: await loadRows() };
      }
      res.set('Cache-Control', 'no-store');
      res.json({ now: new Date().toISOString(), items: cache.rows });
    } catch (e) {
      res.status(500).json({ error: 'Could not load live purchases' });
    }
  });
};
