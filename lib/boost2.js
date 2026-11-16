// Boost 2 — Vina SMM provider (https://vinasmm.com/api/v2). Standard SMM "API v2" (form POST: key + action).
// The API key stays server-side: Render env VINASMM_API_KEY, or the key an admin saves in Admin → Boost 2 (stored encrypted).
// Vina prices are in USD per 1,000. They are converted to ₦ (admin rate, or live rate), then the admin's markup /
// specific price is applied. Customers are only ever shown ₦ prices.
const axios = require('axios');
const crypto = require('crypto');
const fx = require('./fx');
const { sealRef, openRef } = require('./opaque-ref');
module.exports = function registerVinaBoost2({ app, mongoose, User, Transaction, auth, anyAdminAuth }) {
  const base = () => String(process.env.VINASMM_API_URL || 'https://vinasmm.com/api/v2').replace(/\/+$/, '');
  const cleanKey = v => String(v || '').replace(/[\r\n\t]/g, '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^bearer\s+/i, '').trim();
  const round2 = n => Math.round(n * 100) / 100;
  const ownerOnly = (req, res, next) => (req.adminRole === 'super' ? next() : res.status(403).json({ error: 'Only the owner can change this.' }));

  // ── encrypted storage for a key saved from the admin panel ──
  const encKey = () => crypto.createHash('sha256').update('boost2-key:' + String(process.env.JWT_SECRET || '')).digest();
  const seal = txt => { const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', encKey(), iv); const enc = Buffer.concat([c.update(String(txt), 'utf8'), c.final()]); return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.'); };
  const unseal = s => { try { const [iv, tag, enc] = String(s || '').split('.').map(x => Buffer.from(x, 'base64')); const d = crypto.createDecipheriv('aes-256-gcm', encKey(), iv); d.setAuthTag(tag); return Buffer.concat([d.update(enc), d.final()]).toString('utf8'); } catch (e) { return ''; } };

  // ── settings (global on/off, USD→₦ rate, default markup, ₦ add/minus, saved key) ──
  const Cfg = mongoose.models.VinaBoost2Config || mongoose.model('VinaBoost2Config', new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    adjustNgn: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    usdRate: { type: Number, default: 0 },               // ₦ per $1. 0 = use the live rate
    defaultMarkupPercent: { type: Number, default: 30 }, // applied to services that have no specific price
    apiKeyCipher: { type: String, default: '' }
  }));
  let cfgMem = { adjustNgn: 0, enabled: true, usdRate: 0, defaultMarkupPercent: 30, apiKey: '' }; let cfgAt = 0;
  async function getCfg(force) {
    if (!force && Date.now() - cfgAt < 10000) return cfgMem;
    try {
      const c = await Cfg.findOne({ key: 'main' }).lean();
      cfgMem = {
        adjustNgn: Number(c && c.adjustNgn) || 0,
        enabled: !c || c.enabled !== false,
        usdRate: Number(c && c.usdRate) > 0 ? Number(c.usdRate) : 0,
        defaultMarkupPercent: c && Number.isFinite(Number(c.defaultMarkupPercent)) && c.defaultMarkupPercent !== null ? Number(c.defaultMarkupPercent) : 30,
        apiKey: c && c.apiKeyCipher ? unseal(c.apiKeyCipher) : ''
      };
      cfgAt = Date.now();
    } catch (e) { /* keep the last known settings */ }
    return cfgMem;
  }
  const key = () => cleanKey(process.env.VINASMM_API_KEY) || cleanKey(cfgMem.apiKey);
  const keySource = () => (cleanKey(process.env.VINASMM_API_KEY) ? 'env' : (cleanKey(cfgMem.apiKey) ? 'admin' : ''));
  getCfg(true).catch(() => {});

  const serviceRef = itemId => sealRef('boost2-service', { itemId }, process.env.JWT_SECRET);
  function serviceIdFromRef(token) {
    const value = openRef('boost2-service', token, process.env.JWT_SECRET);
    const id = Number(value.itemId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid service reference.');
    return id;
  }
  // Prices are stored per 1,000 units in ₦. Separate collections from the old provider so old IDs can never leak in.
  const Price = mongoose.models.VinaBoost2Price || mongoose.model('VinaBoost2Price', new mongoose.Schema({ itemId: { type: Number, unique: true, index: true }, sellPrice: { type: Number, default: 0 }, markup: { type: Number, default: 0 }, mode: { type: String, enum: ['specific', 'markup'], default: 'markup' }, enabled: { type: Boolean, default: true }, visible: { type: Boolean, default: true }, updatedAt: { type: Date, default: Date.now } }));
  // Same collection as before so history, stats and the ops dashboard keep working. Vina orders carry provider:'vina'.
  const ordersSchema = new mongoose.Schema({ userId: mongoose.Schema.Types.ObjectId, itemId: Number, itemName: String, quantity: Number, rateUnit: Number, link: String, clientRef: { type: String, unique: true, sparse: true }, providerOrder: String, idempotencyKey: { type: String, index: true }, status: String, reviewNote: String, txRecorded: { type: Boolean, default: false }, cost: Number, sellTotal: Number, provider: { type: String, index: true }, refundedAmount: { type: Number, default: 0 }, startCount: Number, remains: Number, lastSyncAt: Date, createdAt: { type: Date, default: Date.now } });
  const Order = mongoose.models.NovaBoost2Order || mongoose.model('NovaBoost2Order', ordersSchema);

  // ── Vina API (form POST) ──
  // e.kind === 'rejected'  : the provider answered and refused (JSON {error}) — safe to treat as "no order was created".
  // e.kind === 'ambiguous' : timeout / dropped connection / 5xx / unreadable answer — the order MAY exist.
  async function api(params) {
    if (!key()) { const e = new Error('Boost 2 is not set up yet. Please contact the administrator.'); e.status = 503; e.kind = 'unconfigured'; throw e; }
    const body = new URLSearchParams({ key: key(), ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])) });
    let r;
    try {
      r = await axios({ method: 'post', url: base(), data: body.toString(), timeout: 30000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, validateStatus: () => true });
    } catch (err) { const e = new Error('Provider unreachable.'); e.kind = 'ambiguous'; e.status = 0; throw e; }
    const status = Number(r.status) || 0;
    let d = r.data;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
    if (d && typeof d === 'object' && !Array.isArray(d) && d.error) { const e = new Error(String(d.error).slice(0, 300)); e.kind = 'rejected'; e.status = status; e.providerMessage = String(d.error).slice(0, 300); throw e; }
    if (status === 408 || status >= 500 || d === null || d === undefined || typeof d !== 'object') { const e = new Error('Unreadable provider answer (HTTP ' + (status || 'none') + ').'); e.kind = status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'ambiguous'; e.status = status; throw e; }
    if (status >= 400) { const e = new Error('Provider refused the request (HTTP ' + status + ').'); e.kind = 'rejected'; e.status = status; throw e; }
    return d;
  }
  async function fetchAllProducts() {
    const d = await api({ action: 'services' });
    if (!Array.isArray(d)) throw new Error('The provider returned an invalid Boost 2 catalogue.');
    const unique = new Map();
    for (const p of d) { const id = Number(p && p.service); if (Number.isInteger(id) && id > 0 && !unique.has(id)) unique.set(id, p); }
    return [...unique.values()];
  }
  // The provider list is stored in our database. Customers never trigger a provider call just by opening the page;
  // it is re-pulled on admin sync, on a customer Refresh (30s cooldown), every 30 minutes, or when nothing is stored.
  const Cache = mongoose.models.VinaBoost2Cache || mongoose.model('VinaBoost2Cache', new mongoose.Schema({ key: { type: String, unique: true }, products: { type: mongoose.Schema.Types.Mixed, default: [] }, syncedAt: Date, error: { type: String, default: '' } }, { minimize: false }));
  let inflight = null;
  let mem = null; const MEM_MS = 5 * 60 * 1000;
  async function loadProducts(refresh = false, force = false) {
    if (!refresh && mem && Date.now() - mem.at < MEM_MS) return mem.val;
    const val = await loadProductsDb(refresh, force);
    if (val && Array.isArray(val.products) && val.products.length) mem = { at: Date.now(), val };
    return val;
  }
  async function loadProductsDb(refresh = false, force = false) {
    const doc = await Cache.findOne({ key: 'smm' }).lean();
    const age = doc?.syncedAt ? Date.now() - new Date(doc.syncedAt).getTime() : Infinity;
    if (doc && Array.isArray(doc.products) && doc.products.length && !(refresh && (force || age > 30000))) return { products: doc.products, syncedAt: doc.syncedAt, stale: false };
    if (!inflight) inflight = fetchAllProducts().then(async products => {
      if (!products.length && Array.isArray(doc?.products) && doc.products.length) return { products: doc.products, syncedAt: doc.syncedAt, stale: true };
      const syncedAt = new Date(); await Cache.updateOne({ key: 'smm' }, { $set: { products, syncedAt, error: '' } }, { upsert: true }); return { products, syncedAt, stale: false };
    }).finally(() => { inflight = null; });
    try { return await inflight; }
    catch (e) {
      console.error('[boost2] catalogue pull failed:', e.kind || '', e.status || 'no response');
      if (doc && Array.isArray(doc.products) && doc.products.length) { Cache.updateOne({ key: 'smm' }, { $set: { error: String(e.message || '').slice(0, 300) } }).catch(() => {}); return { products: doc.products, syncedAt: doc.syncedAt, stale: true, error: e.message }; }
      throw e;
    }
  }
  setTimeout(() => { getCfg(true).then(() => (key() ? loadProducts(false) : null)).catch(() => {}); }, 4000);
  setInterval(() => { if (key()) loadProducts(true).catch(() => {}); }, 30 * 60 * 1000).unref?.();
  const friendly = e => e.kind === 'unconfigured' ? 'Boost 2 has no API key yet.' : (e.kind === 'rejected' && e.providerMessage ? 'The provider said: ' + e.providerMessage : 'The provider service is temporarily unavailable.');

  // ₦ per $1: the admin's own rate when set, otherwise the live market rate (fx.js).
  let lastRate = 0;
  async function usdToNgn() {
    if (cfgMem.usdRate > 0) return cfgMem.usdRate;
    try { const v = await fx.convert(1, 'USD', 'NGN'); if (Number.isFinite(v) && v > 0) { lastRate = v; return v; } } catch (e) { /* fall through */ }
    return lastRate;
  }
  // Only plain "link + quantity" services can be ordered from the Boost 2 form. Custom Comments / Mentions / Package
  // style services need extra fields, so they are shown to the admin but never sold to customers.
  const isSupportedType = t => /^default$/i.test(String(t || 'Default').trim());

  async function catalogue(refresh = false, force = false) {
    await getCfg();
    const { products, syncedAt, stale } = await loadProducts(refresh, force);
    const prices = await Price.find({}).lean(); const pm = new Map(prices.map(p => [Number(p.itemId), p]));
    const usd = await usdToNgn();
    const adj = cfgMem.adjustNgn, pct = cfgMem.defaultMarkupPercent;
    const list = products.map(p => {
      const id = Number(p.service); const cfg = pm.get(id) || {};
      const rateUsd = Number(p.rate); const cost = Number.isFinite(rateUsd) && rateUsd >= 0 ? round2(rateUsd * usd) : 0;
      const markup = Number(cfg.markup) || 0;
      const baseSell = cost + (cost * pct / 100) + markup;
      const sell = cfg.mode === 'specific' ? (Number(cfg.sellPrice) || 0) : (baseSell > 0 ? round2(Math.max(cost, baseSell + adj)) : 0);
      const type = String(p.type || 'Default');
      return { id, name: p.name || `Service ${id}`, category: p.category || 'Social boosting', description: '', type, supported: isSupportedType(type), refill: !!p.refill, cancel: !!p.cancel, min: Number(p.min) || 1, max: Number(p.max) || 100000, rateUnit: 1000, rateUsd: Number.isFinite(rateUsd) ? rateUsd : 0, cost, price: sell, mode: cfg.mode || 'markup', sellPrice: Number(cfg.sellPrice) || 0, markup, enabled: cfg.enabled !== false, visible: cfg.visible !== false, priced: sell > 0 };
    });
    list.syncedAt = syncedAt; list.stale = stale;
    return list;
  }
  function safeOrderStatus(value) {
    const status=String(value||'').trim().toLowerCase();
    if(['success','complete','completed','delivered'].includes(status)) return 'completed';
    if(['failed','error','rejected','cancelled','canceled'].includes(status)) return 'failed';
    if(['pending','processing','in progress','in_progress','partial','queued','review','refunding','refunded'].includes(status)) return status.replace('in progress','processing').replace('in_progress','processing');
    return 'processing';
  }
  function statusBucket(value) {
    const status=String(value||'').toLowerCase();
    if(['success','complete','completed','delivered','partial'].includes(status)) return 'delivered';
    if(['failed','error','rejected','cancelled','canceled','refunded'].includes(status)) return 'failed';
    return 'pending';
  }
  app.get('/api/boost2/services',auth,async(req,res)=>{
    res.set('Cache-Control','no-store');
    await getCfg();
    if(!cfgMem.enabled) return res.json({enabled:false,services:[],message:'Boost 2 is switched off right now. Please check back soon.'});
    if(!key()) return res.json({enabled:false,services:[],message:'Boost 2 is not available yet. Please contact the administrator.'});
    try {
      const list=await catalogue(String(req.query.refresh||'')==='1');
      const services=list.filter(x=>x.enabled&&x.visible&&x.priced&&x.supported)
        .map(({id,name,category,description,min,max,rateUnit,price})=>({serviceKey:serviceRef(id),name,category,description,min,max,rateUnit,price}));
      res.json({enabled:true,syncedAt:list.syncedAt,stale:!!list.stale,services});
    } catch(e) {
      console.error('[boost2] catalogue request failed:',e.response?.status||'no response');
      res.status(502).json({error:'Could not load Boost 2 services right now. Please try again shortly.'});
    }
  });
  function customerOrder(order) {
    return {orderId:String(order._id),status:safeOrderStatus(order.status),itemName:order.itemName,quantity:order.quantity,rateUnit:order.rateUnit,link:order.link,amountPaid:order.sellTotal,refunded:order.refundedAmount||0,createdAt:order.createdAt};
  }
  function respondExistingOrder(res, order) {
    if(['pending','review','refunding'].includes(String(order.status).toLowerCase())) {
      return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'This order is still being checked. Please do not submit it again.'});
    }
    if(['failed','refunded'].includes(String(order.status).toLowerCase())) {
      return res.status(409).json({error:'This order attempt has already finished. Review your order history before placing another order.'});
    }
    return res.json({...customerOrder(order),ok:true,repeated:true});
  }
  app.get('/api/boost2/orders',auth,async(req,res)=>{
    try {
      const rows=await Order.find({userId:req.user._id}).sort({createdAt:-1}).limit(50).lean();
      const statuses=await Order.find({userId:req.user._id}).select('status').lean();
      const counts={all:statuses.length,pending:0,delivered:0,failed:0};
      for(const row of statuses) counts[statusBucket(row.status)]++;
      res.set('Cache-Control','no-store');
      res.json({orders:rows.map(customerOrder),counts});
    } catch(e) {
      console.error('[boost2] customer history query failed:',e.name);
      res.status(500).json({error:'Could not load your Boost 2 order history.'});
    }
  });
  app.get('/api/boost2/orders/:id',auth,async(req,res)=>{
    if(!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({error:'Order not found.'});
    try {
      const order=await Order.findOne({_id:req.params.id,userId:req.user._id}).lean();
      if(!order) return res.status(404).json({error:'Order not found.'});
      res.set('Cache-Control','no-store');
      res.json(customerOrder(order));
    } catch(e) {
      console.error('[boost2] customer order detail query failed:',e.name);
      res.status(500).json({error:'Could not load this Boost 2 order.'});
    }
  });
  app.get('/api/boost2/orders',auth,async(req,res)=>{try{const rows=await Order.find({userId:req.user._id}).sort({createdAt:-1}).limit(15).lean();const label=s=>({review:'processing',refunding:'processing',pending:'processing',refunded:'refunded',failed:'failed'}[String(s||'').toLowerCase()]||String(s||'processing'));res.json(rows.map(o=>({service:o.itemName,quantity:o.quantity,total:o.sellTotal,status:label(o.status),createdAt:o.createdAt})));}catch(e){res.status(500).json({error:'Could not load your orders.'});}}); // MARVEL-UPGRADE
  app.post('/api/boost2/orders',auth,async(req,res)=>{
    let order=null, user=null, charged=0, providerCallStarted=false, clientRef='', purchaseTxRef='', refundTxRef='';
    try {
      let id;
      try { id=req.body?.serviceKey ? serviceIdFromRef(String(req.body.serviceKey)) : Number(req.body?.serviceId); }
      catch { return res.status(400).json({error:'Refresh the service list and choose a service again.'}); }
      const qty=Number(req.body?.quantity),link=String(req.body?.link||'').trim();
      clientRef=String(req.body?.clientRef||'').trim();
      if(clientRef&&!/^[A-Za-z0-9_-]{16,80}$/.test(clientRef)) return res.status(400).json({error:'Invalid order reference. Please review the order and try again.'});
      if(!clientRef) clientRef=crypto.randomUUID();
      if(!Number.isInteger(id)||id<=0||!Number.isInteger(qty)||qty<1||link.length>2048) return res.status(400).json({error:'Choose a service, valid quantity, and public http(s) link.'});
      let target;
      try { target=new URL(link); } catch { return res.status(400).json({error:'Enter a valid public http(s) link.'}); }
      if(!['http:','https:'].includes(target.protocol)||!target.hostname||target.username||target.password) return res.status(400).json({error:'Enter a valid public http(s) link.'});
      await getCfg();
      if(!cfgMem.enabled) return res.status(503).json({error:'Boost 2 is switched off right now. Nothing was charged.'});
      if(!key()) return res.status(503).json({error:'Boost 2 is not available right now. Nothing was charged.'});
      const previous=await Order.findOne({clientRef}).lean();
      if(previous) {
        if(String(previous.userId)!==String(req.user._id)) return res.status(409).json({error:'Invalid order reference.'});
        return respondExistingOrder(res,previous);
      }
      const s=(await catalogue(false)).find(x=>x.id===id&&x.enabled&&x.visible&&x.priced&&x.supported);
      if(!s) return res.status(404).json({error:'Service unavailable.'});
      if(qty<s.min||qty>s.max) return res.status(400).json({error:`Quantity must be between ${s.min} and ${s.max}.`});
      const rateUnit=1000;
      const total=Math.max(0.01,Math.ceil((s.price*qty/rateUnit)*100)/100);
      if(!Number.isFinite(total)||total<=0||!Number.isFinite(s.cost)||s.cost<0) return res.status(400).json({error:'Invalid service price. No charge was made.'});
      const recent=await Order.findOne({
        userId:req.user._id,itemId:id,quantity:qty,link,
        status:{$in:['pending','review','refunding','processing']},
        createdAt:{$gte:new Date(Date.now()-10*60*1000)}
      }).sort({createdAt:-1}).lean();
      if(recent) return res.status(202).json({ok:true,pending:true,orderId:String(recent._id),message:'A matching Boost 2 order is still being checked. Please review your order history before trying again.'});
      const idempotencyKey=clientRef;
      order=await Order.create({userId:req.user._id,itemId:id,itemName:s.name,quantity:qty,rateUnit,link,clientRef,providerOrder:'',idempotencyKey,status:'pending',provider:'vina',cost:Math.round((s.cost*qty/rateUnit)*100)/100,sellTotal:total});
      purchaseTxRef=`boost2:${order._id}:purchase`;
      refundTxRef=`boost2:${order._id}:refund`;
      user=await User.findOneAndUpdate({_id:req.user._id,balance:{$gte:total}},{$inc:{balance:-total}},{new:true});
      if(!user){await Order.updateOne({_id:order._id},{$set:{status:'failed',reviewNote:'Insufficient balance; provider was not called.'}});return res.status(400).json({error:'Insufficient wallet balance.'});}
      charged=total;
      await Transaction.create({userId:user._id,type:'purchase',amount:total,description:`Boost 2 — ${s.name}`,status:'pending',txRef:purchaseTxRef});
      let d;
      providerCallStarted=true;
      try {
        d=await api({action:'add',service:id,link,quantity:qty});
      } catch(e) {
        const status=Number(e.status||0);
        // Only an explicit answer from Vina ("not enough funds", "incorrect link"...) proves no order exists.
        // A timeout, dropped connection, 5xx or unreadable answer means Vina may already have created the order:
        // never refund automatically then; hold the debit and flag it for the admin to check on the Vina dashboard.
        const ambiguous=e.kind!=='rejected';
        if(ambiguous){
          const note=`Provider outcome unclear (${e.message||'no response'}). Check the order on the Vina dashboard (service ${id}, ${qty} units, link above) before refunding.`;
          await Order.updateOne({_id:order._id},{$set:{status:'review',reviewNote:note}}).catch(()=>{});
          console.error('[BOOST2-REVIEW] provider result is ambiguous; manual reconciliation is required.');
          return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'Your order is being verified because we could not confirm the result yet. Your balance is on hold; please do not order again yet.'});
        }
        if(/balance|fund|credit/i.test(String(e.providerMessage||''))) console.error('[BOOST2] The Vina account balance is too low to place orders. Top it up on vinasmm.com.');
        // Definite provider rejection: refund exactly once using an atomic order-state claim.
        const claim=await Order.findOneAndUpdate({_id:order._id,status:'pending'},{$set:{status:'refunding',reviewNote:`Provider rejected order: ${String(e.providerMessage||('HTTP '+status)).slice(0,200)}`}},{new:true});
        if(claim){
          try {
            await User.updateOne({_id:user._id},{$inc:{balance:total}});
            await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
            await Transaction.create({userId:user._id,type:'refund',amount:total,description:`Boost 2 refund — ${s.name}`,status:'success',txRef:refundTxRef});
          } catch(refundErr) {
            // Keep the refund claim in place: the wallet update may have succeeded before a
            // later ledger write failed, so reopening this order could credit it twice.
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{reviewNote:'Provider rejection was verified, but wallet/ledger refund requires manual reconciliation.'}}).catch(()=>{});
            console.error('[BOOST2-REFUND-REVIEW] wallet/ledger refund needs reconciliation:',refundErr.name);
            return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'The order could not be placed. Your refund is being processed; contact support if your balance is not restored shortly.'});
          }
          await Order.updateOne({_id:order._id,status:'refunding'},{$set:{status:'refunded',refundedAmount:total,reviewNote:'Provider rejection confirmed; wallet refunded.'}});
          charged=0;
        }
        return res.status(400).json({error:'This order could not be placed. Your wallet was refunded.'});
      }
      const providerOrder=d&&typeof d==='object'&&!Array.isArray(d)&&/^\d+$/.test(String(d.order??''))?String(d.order):'';
      if(!providerOrder){
        await Order.updateOne({_id:order._id},{$set:{status:'review',reviewNote:'Provider response did not include an order number.'}}).catch(()=>{});
        console.error('[BOOST2-REVIEW] provider response requires manual reconciliation.');
        return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'We have not confirmed the order details yet. Your balance is on hold; please do not submit it again.'});
      }
      const status='processing';
      await Order.updateOne({_id:order._id},{$set:{providerOrder,status,reviewNote:''}});
      try {
        const txResult=await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'success'}});
        if(!txResult.matchedCount) throw new Error('Pending Boost 2 ledger transaction was not found.');
        await Order.updateOne({_id:order._id},{$set:{txRecorded:true}});
      } catch(logErr){ console.error('[BOOST2-LEDGER-REVIEW] confirmed order transaction record needs reconciliation.'); }
      res.json({ok:true,orderId:String(order._id),status,amountPaid:total,balance:user.balance});
    } catch(e) {
      if(e.code===11000&&clientRef) {
        const existing=await Order.findOne({clientRef}).lean().catch(()=>null);
        if(existing&&String(existing.userId)===String(req.user._id)) return respondExistingOrder(res,existing);
      }
      if(charged && user?._id && !providerCallStarted){
        const claim=await Order.findOneAndUpdate({_id:order._id,status:'pending'},{$set:{status:'refunding',reviewNote:'Local failure before provider submission; refund claimed.'}},{new:true}).catch(()=>null);
        if(claim) {
          try {
            await User.updateOne({_id:user._id},{$inc:{balance:charged}});
            if(purchaseTxRef) await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
            if(refundTxRef) await Transaction.create({userId:user._id,type:'refund',amount:charged,description:`Boost 2 refund — ${order.itemName}`,status:'success',txRef:refundTxRef});
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{status:'refunded',reviewNote:'Local failure before provider submission; wallet refunded.'}});
            charged=0;
          } catch(refundErr) {
            // Never move an uncertain refund back to a retryable state after a wallet
            // increment may have happened. The admin handler intentionally won't credit a
            // refunding order a second time.
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{reviewNote:'Pre-provider refund needs reconciliation.'}}).catch(()=>{});
            console.error('[BOOST2-REFUND-REVIEW] pre-provider refund requires reconciliation:',refundErr.name);
          }
        }
      } else if(charged && order?._id && providerCallStarted) {
        await Order.updateOne({_id:order._id,status:'pending'},{$set:{status:'review',reviewNote:'Provider may have accepted the order; do not refund until reconciled.'}}).catch(()=>{});
      } else if(order?._id&&!charged&&!providerCallStarted) {
        await Order.updateOne({_id:order._id,status:'pending'},{$set:{status:'failed',reviewNote:'Local failure before wallet debit and provider submission.'}}).catch(()=>{});
      }
      console.error('[boost2] order handler failed:',e.name,e.response?.status||e.status||'');
      if(!res.headersSent) {
        if(providerCallStarted) return res.status(202).json({ok:true,pending:true,orderId:order?._id?String(order._id):undefined,message:'Your order result is still being checked. Please do not submit it again yet.'});
        const status=Number(e.status);
        res.status(status>=400&&status<500?status:502).json({error:providerCallStarted?'Order status is being checked. Please do not retry yet.':'The Boost 2 order could not be placed. Please try again.'});
      }
    }
  });
  // ── Admin: settings (global on/off, ₦ rate, default markup, ₦ add/minus, API key) ──
  async function configView() {
    await getCfg(true);
    let live = 0; try { live = Math.round((await fx.convert(1, 'USD', 'NGN')) * 100) / 100; } catch (e) { live = lastRate || 0; }
    const k = key();
    return { adjustNgn: cfgMem.adjustNgn, enabled: cfgMem.enabled, usdRate: cfgMem.usdRate, liveUsdRate: live, defaultMarkupPercent: cfgMem.defaultMarkupPercent, keySet: !!k, keySource: keySource(), keyHint: k ? '••••' + k.slice(-4) : '' };
  }
  app.get('/api/admin/boost2/config',anyAdminAuth,async(req,res)=>{res.set('Cache-Control','no-store');res.json(await configView());});
  app.put('/api/admin/boost2/config',anyAdminAuth,async(req,res)=>{
    try{
      const b=req.body||{},set={};
      if(b.adjustNgn!==undefined){const a=Number(b.adjustNgn);if(!Number.isFinite(a)||Math.abs(a)>1000000)return res.status(400).json({error:'Add/minus money must be between -₦1,000,000 and ₦1,000,000.'});set.adjustNgn=round2(a);}
      if(b.enabled!==undefined){if(typeof b.enabled!=='boolean')return res.status(400).json({error:'Enabled must be true or false.'});set.enabled=b.enabled;}
      if(b.usdRate!==undefined){const r=Number(b.usdRate);if(!Number.isFinite(r)||r<0||r>100000)return res.status(400).json({error:'Dollar rate must be 0 (automatic) or a naira amount per $1.'});set.usdRate=round2(r);}
      if(b.defaultMarkupPercent!==undefined){const p=Number(b.defaultMarkupPercent);if(!Number.isFinite(p)||p<0||p>1000)return res.status(400).json({error:'Default markup must be between 0% and 1000%.'});set.defaultMarkupPercent=round2(p);}
      if(b.apiKey!==undefined){
        if(req.adminRole!=='super')return res.status(403).json({error:'Only the owner can change the API key.'});
        const k=cleanKey(b.apiKey);if(k.length>300)return res.status(400).json({error:'That API key is too long.'});
        set.apiKeyCipher=k?seal(k):'';
      }
      if(!Object.keys(set).length)return res.status(400).json({error:'Nothing to save.'});
      await Cfg.updateOne({key:'main'},{$set:set},{upsert:true});
      await getCfg(true);
      if(set.apiKeyCipher!==undefined){mem=null;if(key())loadProducts(true,true).catch(()=>{});}
      res.json({ok:true,...(await configView())});
    }catch(e){res.status(500).json({error:'Could not save the Boost 2 settings.'});}
  });
  app.get('/api/admin/boost2/balance',anyAdminAuth,async(req,res)=>{
    try{await getCfg(true);const d=await api({action:'balance'});const usd=await usdToNgn();const bal=Number(d.balance);res.set('Cache-Control','no-store');res.json({balance:d.balance,currency:d.currency||'USD',balanceNgn:Number.isFinite(bal)&&String(d.currency||'USD').toUpperCase()==='USD'?Math.round(bal*usd):null});}
    catch(e){res.status(502).json({error:friendly(e)});}
  });
  app.get('/api/admin/boost2/services',anyAdminAuth,async(req,res)=>{try{res.json(await catalogue(String(req.query.refresh||'')==='1'));}catch(e){res.status(502).json({error:'Could not load the service list: '+friendly(e)});}});
  app.post('/api/admin/boost2/sync',anyAdminAuth,async(req,res)=>{try{await getCfg(true);const list=await catalogue(true,true);res.json({ok:true,count:list.length,stale:!!list.stale,syncedAt:list.syncedAt,message:list.stale?'Provider could not be reached; the previously stored list was kept.':`Synced ${list.length} services (${list.filter(x=>x.supported).length} can be sold on the site).`});}catch(e){res.status(502).json({error:'Sync failed: '+friendly(e)});}});
  app.put('/api/admin/boost2/services/:id',anyAdminAuth,async(req,res)=>{const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Invalid service ID'});const b=req.body||{},set={updatedAt:new Date()};if(b.mode!==undefined){if(!['specific','markup'].includes(b.mode))return res.status(400).json({error:'Mode must be specific or markup'});set.mode=b.mode;}for(const k of ['sellPrice','markup'])if(b[k]!==undefined){const n=Number(b[k]);if(!Number.isFinite(n)||n<0)return res.status(400).json({error:`${k} must be zero or greater`});set[k]=n;}if(typeof b.enabled==='boolean')set.enabled=b.enabled;if(typeof b.visible==='boolean')set.visible=b.visible;await Price.updateOne({itemId:id},{$set:{itemId:id,...set}},{upsert:true});res.json({ok:true});});
  app.get('/api/admin/boost2/orders',anyAdminAuth,async(req,res)=>{
    try {
      const rows=await Order.find({status:{$in:['pending','review','refunding']}})
        .sort({createdAt:-1}).limit(100).populate('userId','name email').lean();
      res.set('Cache-Control','no-store');
      res.json(rows.map(order=>({
        id:String(order._id),userName:order.userId?.name||'',userEmail:order.userId?.email||'',
        itemId:order.itemId,itemName:order.itemName,quantity:order.quantity,rateUnit:order.rateUnit,
        link:order.link,amount:order.sellTotal,status:order.status,reviewNote:order.reviewNote||'',
        providerOrder:order.providerOrder||'',clientRef:order.clientRef,createdAt:order.createdAt,
        txRecorded:!!order.txRecorded
      })));
    } catch(e) {
      console.error('[boost2] admin order review list failed:',e.name);
      res.status(500).json({error:'Could not load Boost 2 orders requiring review.'});
    }
  });
  app.post('/api/admin/boost2/orders/:id/resolve',anyAdminAuth,async(req,res)=>{
    if(!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({error:'Order not found.'});
    const action=String(req.body?.action||'');
    try {
      let order=await Order.findById(req.params.id);
      if(!order) return res.status(404).json({error:'Order not found.'});
      const purchaseTxRef=`boost2:${order._id}:purchase`, refundTxRef=`boost2:${order._id}:refund`;
      if(action==='review') {
        const result=await Order.updateOne({_id:order._id,status:'pending'},{$set:{status:'review',reviewNote:'Admin flagged this order for provider reconciliation; do not refund until checked.'}});
        if(!result.matchedCount) return res.status(409).json({error:'Only a pending order can be flagged for review.'});
        return res.json({ok:true,status:'review'});
      }
      if(action==='confirm') {
        const providerOrder=String(req.body?.providerOrder||'').trim().slice(0,128);
        const status=String(req.body?.status||'processing');
        if(!providerOrder||!['processing','completed'].includes(status)) return res.status(400).json({error:'Enter the confirmed provider order reference and a processing or completed status.'});
        if(order.status!=='review') return res.status(409).json({error:'Only an order awaiting review can be confirmed.'});
        const tx=await Transaction.findOne({txRef:purchaseTxRef}).lean();
        if(tx) await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'success'}});
        const result=await Order.updateOne({_id:order._id,status:'review'},{$set:{providerOrder,status,reviewNote:'',txRecorded:!!tx}});
        if(!result.matchedCount) return res.status(409).json({error:'The order changed while it was being resolved. Refresh and try again.'});
        return res.json({ok:true,status,ledgerRecorded:!!tx});
      }
      if(action==='refund') {
        if(order.status==='refunded') return res.json({ok:true,status:'refunded',repeated:true});
        if(order.status==='refunding') {
          const priorRefund=await Transaction.findOne({txRef:refundTxRef,status:'success'}).lean();
          if(priorRefund) {
            await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{status:'refunded',reviewNote:'Manual provider check confirmed no order; wallet refund reconciled.'}});
            return res.json({ok:true,status:'refunded',repeated:true});
          }
          return res.status(409).json({error:'This refund is already in progress and needs manual balance reconciliation; it will not be credited again automatically.'});
        }
        const claim=await Order.findOneAndUpdate({_id:order._id,status:'review'},{$set:{status:'refunding',reviewNote:'Admin confirmed the provider did not create this order; refund in progress.'}},{new:true});
        if(!claim) return res.status(409).json({error:'Only an order awaiting review can be refunded.'});
        try {
          const wallet=await User.updateOne({_id:claim.userId},{$inc:{balance:claim.sellTotal}});
          if(!wallet.matchedCount) throw new Error('The customer wallet was not found.');
          await Transaction.create({userId:claim.userId,type:'refund',amount:claim.sellTotal,description:`Boost 2 refund — ${claim.itemName}`,status:'success',txRef:refundTxRef});
          await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
          await Order.updateOne({_id:claim._id,status:'refunding'},{$set:{status:'refunded',reviewNote:'Manual provider check confirmed no order; wallet refunded.'}});
          return res.json({ok:true,status:'refunded',refunded:claim.sellTotal});
        } catch(refundError) {
          console.error('[BOOST2-ADMIN-REFUND] reconciliation required:',refundError.name);
          return res.status(202).json({ok:true,pending:true,status:'refunding',message:'Refund processing requires balance reconciliation. Do not retry the credit.'});
        }
      }
      return res.status(400).json({error:'Action must be confirm or refund.'});
    } catch(e) {
      console.error('[boost2] admin order resolution failed:',e.name);
      res.status(500).json({error:'Could not resolve this Boost 2 order.'});
    }
  });

  // ── Order status sync: asks Vina for the progress of our open orders and settles refunds ──
  // Completed -> completed. Canceled -> full refund. Partial -> refund for the units not delivered (remains).
  const mapVina = v => { const t = String(v || '').toLowerCase(); if (t === 'completed') return 'completed'; if (t === 'canceled' || t === 'cancelled') return 'canceled'; if (t === 'partial') return 'partial'; return 'processing'; };
  async function settleProviderRefund(o, st, remains, extra) {
    const qty = Number(o.quantity) || 0;
    const full = st === 'canceled' || (remains >= qty && qty > 0);
    const refund = full ? round2(o.sellTotal) : round2(o.sellTotal * Math.min(remains, qty) / qty);
    if (!(refund > 0)) { await Order.updateOne({ _id: o._id, status: 'processing' }, { $set: { ...extra, status: st === 'canceled' ? 'refunded' : 'partial', reviewNote: 'Provider reported ' + st + '; nothing to refund.' } }); return; }
    const claim = await Order.findOneAndUpdate({ _id: o._id, status: 'processing', provider: 'vina' }, { $set: { ...extra, status: 'refunding', reviewNote: `Provider reported ${st}; refund in progress.` } }, { new: true });
    if (!claim) return;
    const purchaseTxRef = `boost2:${o._id}:purchase`, refundTxRef = `boost2:${o._id}:refund`;
    try {
      const wallet = await User.updateOne({ _id: claim.userId }, { $inc: { balance: refund } });
      if (!wallet.matchedCount) throw new Error('The customer wallet was not found.');
      await Transaction.create({ userId: claim.userId, type: 'refund', amount: refund, description: `Boost 2 ${full ? 'refund' : 'partial refund'} — ${claim.itemName}`, status: 'success', txRef: refundTxRef });
      if (full) await Transaction.updateOne({ txRef: purchaseTxRef }, { $set: { status: 'failed' } });
      await Order.updateOne({ _id: claim._id, status: 'refunding' }, { $set: { status: full ? 'refunded' : 'partial', refundedAmount: refund, reviewNote: '' } });
    } catch (err) {
      // Stay in "refunding": the wallet may already have been credited, so this must never be retried automatically.
      await Order.updateOne({ _id: claim._id, status: 'refunding' }, { $set: { reviewNote: 'Provider reported ' + st + ' but the wallet/ledger refund needs manual reconciliation.' } }).catch(() => {});
      console.error('[BOOST2-SYNC-REFUND-REVIEW] reconciliation required:', err.name);
    }
  }
  let syncing = false;
  async function syncStatuses() {
    if (syncing || !key() || mongoose.connection.readyState !== 1) return { checked: 0 };
    syncing = true; let checked = 0;
    try {
      const rows = await Order.find({ provider: 'vina', status: 'processing', providerOrder: { $nin: ['', null] } }).sort({ createdAt: 1 }).limit(300).lean();
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        let d;
        try { d = await api({ action: 'status', orders: chunk.map(o => o.providerOrder).join(',') }); }
        catch (e) { console.error('[boost2] status sync failed:', e.kind || '', e.message); break; }
        for (const o of chunk) {
          const r = (d && d[o.providerOrder]) || (chunk.length === 1 && d && d.status ? d : null);
          if (!r || r.error) continue;
          checked++;
          const st = mapVina(r.status);
          const extra = { startCount: Number(r.start_count) || 0, remains: Number(r.remains) || 0, lastSyncAt: new Date() };
          try {
            if (st === 'processing') await Order.updateOne({ _id: o._id, status: 'processing' }, { $set: extra });
            else if (st === 'completed') await Order.updateOne({ _id: o._id, status: 'processing' }, { $set: { ...extra, status: 'completed' } });
            else await settleProviderRefund(o, st, Number(r.remains) || 0, extra);
          } catch (err) { console.error('[boost2] status update failed:', err.name); }
        }
      }
    } catch (e) { console.error('[boost2] status sync error:', e.name); }
    finally { syncing = false; }
    return { checked };
  }
  setTimeout(() => { syncStatuses().catch(() => {}); }, 20000);
  setInterval(() => { syncStatuses().catch(() => {}); }, 3 * 60 * 1000).unref?.();
  app.post('/api/admin/boost2/orders/sync',anyAdminAuth,async(req,res)=>{try{await getCfg(true);const r=await syncStatuses();res.json({ok:true,checked:r.checked,message:`Checked ${r.checked} open order(s) with Vina.`});}catch(e){res.status(502).json({error:'Status check failed: '+friendly(e)});}});
};
