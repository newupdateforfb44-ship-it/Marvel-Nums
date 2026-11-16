# Marvel Nums

Your Digital Growth Hub: social media boosting, virtual numbers and social accounts.

- Start: `npm install && npm start`
- Site name, colours, WhatsApp and domain are in `site.config.js` (or the BRAND_* environment variables).
- Payment/transaction prefix: `MVN`.

## Business tools (admin) and customer extras
- Admin Panel -> **Business tools**: money dashboard, provider balances + low-balance email alerts, loss alerts,
  stuck/failed orders with one-click refund, customer lookup (credit/debit/restrict), activity + price-change history, CSV export.
- Admin Panel -> **Price manager**: "Add money / Minus money" for Buy Number 1, 2, 3 and Boost 2.
- Email alerts need `RESEND_API_KEY` and `ADMIN_ALERT_EMAIL` (or the alert email set in Business tools).
- Customers get a notification bell, a search/favourites/recent panel, low-balance and price-changed pop-ups, and "Buy again" in Boost history.

## Boost 2 = Vina SMM
- Boost 2 now runs on Vina SMM (https://vinasmm.com/api/v2). Buy Number 3 and Marketplace 4 still use NovaSolution (`NOVA_API_KEY`).
- Set `VINASMM_API_KEY` in Render -> Environment (or paste the key in Admin -> Boost 2 -> Vina API key; it is stored encrypted).
- Admin -> **Boost 2 services**: Boost 2 ON/OFF switch, dollar rate, default markup %, add/minus per 1,000, and per service:
  Specific price or Provider + markup, plus an Enabled switch. Tap **Sync from provider** after saving the key.
- Vina services that need extra fields (Custom Comments, Mentions, Packages...) are shown to the admin but are not sold on the site.
- Open orders are checked with Vina every 3 minutes: Completed, Canceled (full refund) and Partial (refund for the undelivered part).
