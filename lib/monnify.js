/**
 * lib/monnify.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Monnify as a third payment-link gateway (next to Flutterwave and Paystack).
 *
 * What it does
 *   • creates a Monnify checkout for a wallet deposit
 *   • receives Monnify's webhook   → POST /api/webhooks/monnify
 *   • handles the browser return   → GET  /api/deposit/monnify/callback
 *   • re-checks pending deposits   → used by the 30-second reconciler + status route
 *
 * Safety rules (same as the Paystack code already in server.js)
 *   • A webhook body is NEVER trusted on its own: its signature is checked AND the
 *     payment is re-confirmed with Monnify's API before a wallet is credited.
 *   • Crediting goes through the site's existing creditPaymentLinkDeposit(), which
 *     is atomic, so a payment can never be credited twice.
 *
 * Environment variables (all server-side, never in the browser):
 *   MONNIFY_API_KEY, MONNIFY_SECRET_KEY, MONNIFY_CONTRACT_CODE
 *   MONNIFY_ENV=sandbox|live          (default sandbox)
 *   MONNIFY_ALLOW_USD=true            (optional, only if your contract supports USD)
 */
module.exports = function mountMonnify(ctx) {
  const { app, axios, crypto, PaymentLinkDeposit, creditPaymentLinkDeposit, getPlatform } = ctx;

  const IS_LIVE = () => String(process.env.MONNIFY_ENV || '').toLowerCase() === 'live';
  const BASE = () => process.env.MONNIFY_BASE_URL || (IS_LIVE() ? 'https://api.monnify.com' : 'https://sandbox.monnify.com');

  function configured() {
    return !!(process.env.MONNIFY_API_KEY && process.env.MONNIFY_SECRET_KEY && process.env.MONNIFY_CONTRACT_CODE);
  }

  // Monnify settles naira. USD only works if your Monnify contract has it switched on.
  function supportsCurrency(cur) {
    const c = String(cur || '').toUpperCase();
    return c === 'NGN' || (c === 'USD' && String(process.env.MONNIFY_ALLOW_USD || '').toLowerCase() === 'true');
  }

  // ── OAuth token (cached until shortly before it expires) ────────────────────
  let tokenCache = { token: null, expiresAt: 0 };
  async function getToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 30000) return tokenCache.token;
    const basic = Buffer.from(`${process.env.MONNIFY_API_KEY}:${process.env.MONNIFY_SECRET_KEY}`).toString('base64');
    const r = await axios.post(`${BASE()}/api/v1/auth/login`, {}, {
      headers: { Authorization: `Basic ${basic}` }, timeout: 15000
    });
    const body = r.data && r.data.responseBody;
    if (!r.data || !r.data.requestSuccessful || !body || !body.accessToken) {
      throw new Error((r.data && r.data.responseMessage) || 'Monnify login failed');
    }
    tokenCache = { token: body.accessToken, expiresAt: Date.now() + (Number(body.expiresIn) || 3000) * 1000 };
    return tokenCache.token;
  }
  async function api(method, path, options = {}) {
    const token = await getToken();
    try {
      return await axios({ method, url: `${BASE()}${path}`, timeout: 15000, ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
    } catch (e) {
      if (e.response && e.response.status === 401) tokenCache = { token: null, expiresAt: 0 }; // force fresh login next time
      throw e;
    }
  }

  // ── Create a checkout. Returns { link, transactionReference } ───────────────
  async function createCheckout({ amount, currency, reference, customerName, customerEmail, description, redirectUrl }) {
    const r = await api('post', '/api/v1/merchant/transactions/init-transaction', {
      headers: { 'Content-Type': 'application/json' },
      data: {
        amount: Math.round(Number(amount) * 100) / 100, // Monnify takes the amount in naira, NOT kobo
        customerName: customerName || 'Customer',
        customerEmail,
        paymentReference: reference,
        paymentDescription: description || 'Wallet deposit',
        currencyCode: String(currency || 'NGN').toUpperCase(),
        contractCode: process.env.MONNIFY_CONTRACT_CODE,
        redirectUrl
      }
    });
    const body = r.data && r.data.responseBody;
    if (!r.data || !r.data.requestSuccessful || !body || !body.checkoutUrl) {
      throw new Error((r.data && r.data.responseMessage) || 'Monnify did not return a checkout link');
    }
    return { link: body.checkoutUrl, transactionReference: body.transactionReference };
  }

  // ── Ask Monnify what happened to a payment. null = Monnify has no record yet ─
  async function verify(paymentReference) {
    try {
      const r = await api('get', '/api/v2/merchant/transactions/query', { params: { paymentReference } });
      if (!r.data || !r.data.requestSuccessful) return null;
      return r.data.responseBody || null;
    } catch (e) {
      const st = e.response && e.response.status;
      const msg = String((e.response && e.response.data && e.response.data.responseMessage) || '');
      if (st === 404 || /not found|no transaction/i.test(msg)) return null;
      throw e; // network/auth problem → caller treats it as "still pending" and retries later
    }
  }

  // Is this a genuine, fully-paid transaction for THIS deposit? (reference + currency + amount)
  function txOk(tx, deposit) {
    if (!tx) return false;
    const status = String(tx.paymentStatus || '').toUpperCase();
    if (status !== 'PAID' && status !== 'OVERPAID') return false;
    if (String(tx.paymentReference || '') !== String(deposit.txRef)) return false;
    const cur = String(tx.currencyCode || tx.currency || deposit.currency || 'NGN').toUpperCase();
    if (cur !== String(deposit.currency || 'NGN').toUpperCase()) return false;
    return Number(tx.amountPaid) >= Number(deposit.amount) - 0.01;
  }

  // Shape a Monnify transaction like the other gateways so creditPaymentLinkDeposit() can read it.
  function normalise(tx) {
    return { ...tx, id: tx.transactionReference || '', channel: tx.paymentMethod || '' };
  }

  /**
   * Check one pending deposit with Monnify and credit / fail it.
   * Returns 'success' | 'failed' | 'pending'. Safe to call any number of times.
   */
  async function checkAndCredit(deposit) {
    if (deposit.status === 'success') return 'success';
    const tx = await verify(deposit.txRef);
    if (txOk(tx, deposit)) {
      await creditPaymentLinkDeposit(deposit, normalise(tx));
      return 'success';
    }
    const st = String((tx && tx.paymentStatus) || '').toUpperCase();
    if (['FAILED', 'EXPIRED', 'CANCELLED', 'REVERSED'].includes(st)) {
      await PaymentLinkDeposit.updateOne({ _id: deposit._id, status: 'pending' }, { $set: { status: 'failed', rawPayload: tx } });
      return 'failed';
    }
    return 'pending';
  }

  // ── Browser comes back here after paying ────────────────────────────────────
  app.get('/api/deposit/monnify/callback', async (req, res) => {
    const siteUrl = process.env.SITE_URL || '';
    const fail = `${siteUrl}/deposit?deposit=failed`;
    try {
      const reference = String(req.query.paymentReference || req.query.reference || '');
      if (!reference) return res.redirect(fail);
      const deposit = await PaymentLinkDeposit.findOne({ txRef: reference, gateway: 'monnify' });
      if (!deposit) return res.redirect(fail);
      if (deposit.status === 'success') return res.redirect(`${siteUrl}/deposit?deposit=success`);
      if (!configured()) return res.redirect(fail);
      try {
        const result = await checkAndCredit(deposit);
        if (result === 'success') return res.redirect(`${siteUrl}/deposit?deposit=success`);
        if (result === 'failed') return res.redirect(fail);
      } catch (e) { console.error('Monnify callback verify error:', e.response?.data || e.message); }
      return res.redirect(`${siteUrl}/deposit?deposit=pending&txRef=${encodeURIComponent(reference)}`);
    } catch (e) {
      console.error('Monnify callback error:', e.message);
      res.redirect(fail);
    }
  });

  // ── Webhook: set  https://YOUR-SITE/api/webhooks/monnify  in the Monnify dashboard ──
  // Always processed, even when the Monnify switch is OFF — the customer has already paid.
  app.post('/api/webhooks/monnify', async (req, res) => {
    const secret = process.env.MONNIFY_SECRET_KEY || '';
    const received = String(req.headers['monnify-signature'] || '');
    const event = req.body || {};
    const data = event.eventData || {};
    const reference = String(data.paymentReference || '');
    const log = async (status, message) => {
      try {
        const p = getPlatform && getPlatform();
        if (p) await p.logWebhook({
          provider: 'monnify', channel: 'paymentlink', event: event.eventType || 'unknown', reference,
          txId: data.transactionReference, amount: Number(data.amountPaid || 0), currency: data.currency, status, message, payload: event
        });
      } catch { /* logging never breaks a credit */ }
    };

    if (!secret || !req.rawBody) {
      await log('signature_rejected', !secret ? 'MONNIFY_SECRET_KEY is not set' : 'raw body unavailable');
      return res.status(401).json({ error: 'Webhook not configured' });
    }
    const expected = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
    let valid = false;
    try {
      const a = Buffer.from(expected, 'utf8'), b = Buffer.from(received, 'utf8');
      valid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch { valid = false; }
    if (!valid) {
      console.error('Monnify webhook REJECTED: bad monnify-signature');
      await log('signature_rejected', 'monnify-signature mismatch');
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    try {
      if (event.eventType !== 'SUCCESSFUL_TRANSACTION') {
        await log('ignored', `event ${event.eventType || 'unknown'} is not handled`);
        return res.json({ received: true });
      }
      const deposit = reference ? await PaymentLinkDeposit.findOne({ txRef: reference, gateway: 'monnify' }) : null;
      if (!deposit) { await log('ignored', 'no wallet deposit matches this reference'); return res.json({ received: true }); }
      if (deposit.status === 'success') { await log('ignored', 'already credited'); return res.json({ received: true }); }
      // Never trust the webhook body alone — confirm with Monnify's API before crediting.
      const tx = await verify(reference);
      if (!txOk(tx, deposit)) {
        await log('failed', `verification failed: status=${tx && tx.paymentStatus} paid=${tx && tx.amountPaid}`);
        return res.json({ received: true });
      }
      await creditPaymentLinkDeposit(deposit, normalise(tx));
      await log('processed', `credited ₦${deposit.creditAmount} for ${reference}`);
      return res.json({ received: true });
    } catch (e) {
      console.error('Monnify webhook error:', e.response?.data || e.message);
      await log('failed', e.message);
      return res.status(500).json({ error: 'Processing error' }); // non-2xx → Monnify retries
    }
  });

  // ── Safety net for a missed webhook (called every 30s by checkAllPendingDeposits) ──
  let running = false;
  async function reconcilePending() {
    if (running || !configured()) return;
    running = true;
    try {
      const since48h = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const pending = await PaymentLinkDeposit.find({ status: 'pending', gateway: 'monnify', createdAt: { $gte: since48h } }).limit(60);
      for (const dep of pending) {
        try {
          const result = await checkAndCredit(dep);
          if (result === 'success') console.log(`[Auto-Reconcile] Pending Monnify deposit ${dep.txRef} succeeded — credited.`);
          else if (result === 'pending' && Date.now() - new Date(dep.createdAt).getTime() > 24 * 60 * 60 * 1000) {
            await PaymentLinkDeposit.updateOne({ _id: dep._id, status: 'pending' }, { $set: { status: 'failed' } }); // never paid
          }
        } catch (err) {
          console.warn(`[Auto-Reconcile] Monnify check failed for ${dep.txRef}:`, err.response?.data?.responseMessage || err.message);
        }
      }
    } catch (e) {
      console.error('[Auto-Reconcile] reconcilePending (Monnify) error:', e.message);
    } finally { running = false; }
  }

  return { configured, supportsCurrency, createCheckout, verify, txOk, normalise, checkAndCredit, reconcilePending };
};
