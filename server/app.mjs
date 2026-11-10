import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, randomInt, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { AlipayGateway } from './gateway.mjs';
import { CASES, estimate, preview, qualityScore, buildDeliverables } from './content.mjs';

const now = () => new Date().toISOString();
const providerTradeNo = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date()).replace(/\D/g, '') + Date.now() + String(randomInt(0, 10000000)).padStart(7, '0');
const yuan = cents => Number((cents / 100).toFixed(2));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const safeHtml = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const freshAccount = () => ({ buckets: [], subscriptionUntil: null, subscriptionOrderId: null });

export function createApp({ dbPath = 'data/paperpatent.db', forceSimulator = false } = {}) {
  if (dbPath !== ':memory:') mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, out_trade_no TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency (session_id TEXT NOT NULL, key TEXT NOT NULL, fingerprint TEXT NOT NULL, order_id TEXT NOT NULL, PRIMARY KEY(session_id, key));
    CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS deliverables (order_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  const app = express();
  app.disable('x-powered-by');
  app.get('/api/health', (req, res) => {
    db.prepare('SELECT 1').get();
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok', service: 'paperpatent-vibepay' });
  });
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  let activeSession = null;
  const storedKeys = db.prepare('SELECT value FROM settings WHERE name=?').get('simulator_keys');
  const gateway = new AlipayGateway({ forceSimulator, simulatorKeys: storedKeys ? JSON.parse(storedKeys.value) : undefined, log: entry => {
    db.prepare('INSERT INTO logs (session_id,data) VALUES (?,?)').run(activeSession, JSON.stringify({ ...entry, time: now() }));
  } });
  if (gateway.mode === 'simulator' && !storedKeys) {
    db.prepare('INSERT INTO settings (name,value) VALUES (?,?)').run('simulator_keys', JSON.stringify(gateway.simulatorKeys));
  }
  let queue = Promise.resolve();
  const serial = action => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const atomic = action => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      db.exec('COMMIT');
      return result;
    } catch (cause) {
      db.exec('ROLLBACK');
      throw cause;
    }
  };
  const account = id => JSON.parse(db.prepare('SELECT data FROM sessions WHERE id=?').get(id)?.data || JSON.stringify(freshAccount()));
  const saveAccount = (id, value) => db.prepare('INSERT OR REPLACE INTO sessions (id,data) VALUES (?,?)').run(id, JSON.stringify(value));
  const getOrder = id => {
    const row = db.prepare('SELECT data FROM orders WHERE id=?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const saveOrder = order => db.prepare('INSERT OR REPLACE INTO orders (id,session_id,out_trade_no,data) VALUES (?,?,?,?)')
    .run(order.id, order.sessionId, order.outTradeNo, JSON.stringify(order));
  const listOrders = id => db.prepare('SELECT data FROM orders WHERE session_id=? ORDER BY rowid DESC').all(id).map(row => JSON.parse(row.data));
  const viewOrder = order => {
    const receivedCents = order.paidAt ? order.amountCents - order.refundedCents : 0;
    return ({
    id: order.id, outTradeNo: order.outTradeNo, tradeNo: order.tradeNo, caseId: order.caseId, mode: order.mode,
    subject: order.subject, amount: yuan(order.amountCents), amountCents: order.amountCents,
    cost: yuan(order.costCents), costCents: order.costCents,
    receivedAmount: yuan(receivedCents), profit: yuan(receivedCents - order.costCents),
    margin: receivedCents > 0 ? Number(((1 - order.costCents / receivedCents) * 100).toFixed(1)) : 0,
    status: order.status, tradeStatus: order.tradeStatus, entitlement: order.entitlement,
    entitlementStatus: order.entitlement === 'GRANTED' ? 'ENTITLEMENT_GRANTED' : order.entitlement,
    qualityScore: order.qualityScore, stage: order.stage, paymentRequired: order.paymentRequired,
    createdAt: order.createdAt, paidAt: order.paidAt, refundedAt: order.refundedAt,
    refundedAmount: yuan(order.refundedCents), refundReason: order.refundReason, refundRequestNo: order.refundRequestNo,
    duplicateCallbacks: order.duplicateCallbacks, grantCount: order.grantCount, engine: order.engine,
    qualityChecks: order.qualityChecks || [],
  }); };
  const getOwned = req => {
    const order = getOrder(req.params.id);
    if (!order || order.sessionId !== req.sessionId) throw error('订单不存在', 404);
    return order;
  };
  const accountView = id => {
    const value = account(id);
    return { credits: value.buckets.reduce((sum, bucket) => sum + bucket.remaining, 0),
      subscriptionUntil: value.subscriptionUntil, subscriptionActive: Boolean(value.subscriptionUntil && Date.parse(value.subscriptionUntil) > Date.now()) };
  };
  app.use('/api', (req, res, next) => {
    const cookies = Object.fromEntries((req.headers.cookie || '').split(';').map(item => item.trim().split('=')).filter(([key]) => key));
    const existing = cookies.pp_session && db.prepare('SELECT id FROM sessions WHERE id=?').get(cookies.pp_session);
    req.sessionId = existing ? cookies.pp_session : randomUUID();
    if (!existing) {
      saveAccount(req.sessionId, freshAccount());
      res.setHeader('Set-Cookie', `pp_session=${req.sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    }
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const route = action => (req, res, next) => Promise.resolve(action(req, res)).catch(next);
  const transactionRoute = action => route((req, res) => serial(async () => {
    activeSession = req.sessionId;
    try { await action(req, res); } finally { activeSession = null; }
  }));

  function releaseBenefits(order) {
    const value = account(order.sessionId);
    if (order.mode === 'credits') {
      if (order.amountCents > 0) {
        value.buckets.push({ orderId: order.id, remaining: 100 });
        order.creditSourceOrderId = order.id;
      }
      const bucket = value.buckets.find(item => item.orderId === order.creditSourceOrderId);
      if (!bucket || bucket.remaining < 10) throw error('科研算力余额不足');
      bucket.remaining -= 10;
      order.creditsSpent = 10;
    }
    if (order.mode === 'subscription' && order.amountCents > 0) {
      value.subscriptionUntil = new Date(Date.now() + 30 * 86400000).toISOString();
      value.subscriptionOrderId = order.id;
      order.subscriptionSourceOrderId = order.id;
    }
    saveAccount(order.sessionId, value);
  }

  async function refundOrder(order, reason, { providerConfirmedClosed = false } = {}) {
    if (order.status === 'REFUND_SUCCESS') return order;
    if (!order.paidAt) throw error('未确认付款的订单不可退款', 409);
    order.refundReason = reason;
    order.refundRequestNo ||= `REFUND_${order.outTradeNo}`;
    order.entitlement = 'REVOKED';
    saveOrder(order);
    if (order.amountCents > 0) {
      if (!providerConfirmedClosed) {
        const response = await gateway.refund(order);
        if (response.out_trade_no !== order.outTradeNo || response.trade_no !== order.tradeNo || Math.round(Number(response.refund_fee) * 100) !== order.amountCents) {
          throw error('退款响应订单、交易号或金额不一致，拒绝确认退款', 502);
        }
      }
      order.refundedCents = order.amountCents;
      order.providerRefunded = true;
      order.tradeStatus = 'TRADE_CLOSED';
    }
    atomic(() => {
      const value = account(order.sessionId);
      if (order.mode === 'credits') {
        if (order.amountCents > 0) value.buckets = value.buckets.filter(item => item.orderId !== order.id);
        else if (order.creditsSpent) {
          const bucket = value.buckets.find(item => item.orderId === order.creditSourceOrderId);
          if (bucket) bucket.remaining += order.creditsSpent;
        }
      }
      if (order.mode === 'subscription' && value.subscriptionOrderId === order.id) {
        value.subscriptionUntil = null;
        value.subscriptionOrderId = null;
      }
      saveAccount(order.sessionId, value);
      // Refunding a prepaid product withdraws all access that purchase funded.
      for (const related of listOrders(order.sessionId)) {
        if (related.id !== order.id && related.status !== 'REFUND_SUCCESS' && (related.creditSourceOrderId === order.id || related.subscriptionSourceOrderId === order.id)) {
          related.entitlement = 'REVOKED'; related.status = 'ENTITLEMENT_REVOKED'; related.stage = 5;
          related.refundReason = '关联的科研算力包或会员订单已退款';
          saveOrder(related);
        }
      }
      order.status = 'REFUND_SUCCESS'; order.entitlement = 'REVOKED'; order.stage = 5; order.refundedAt = now();
      saveOrder(order);
    });
    return order;
  }

  async function completeDelivery(order) {
    if (order.refundRequestNo && order.status !== 'REFUND_SUCCESS') return refundOrder(order, order.refundReason);
    if (['ENTITLEMENT_GRANTED', 'ENTITLEMENT_REVOKED', 'REFUND_SUCCESS'].includes(order.status)) return order;
    order.status = 'TRADE_SUCCESS'; order.stage = 4; order.paidAt ||= now();
    order.qualityScore = qualityScore(order.caseId, order.draft);
    saveOrder(order);
    if (order.qualityScore < 85) {
      order.costCents = 18;
      return refundOrder(order, `SLA 形式审查 ${order.qualityScore}/100，低于 85 分阈值`);
    }
    let delivery;
    try { delivery = await buildDeliverables(order); }
    catch (cause) {
      if (Number.isFinite(cause.actualCost)) order.costCents = Math.max(0, Math.round(cause.actualCost * 100));
      order.qualityScore = 0;
      return refundOrder(order, `AI 交付失败，保护性全额退款：${cause.message}`);
    }
    order.costCents = Math.max(0, Math.round(delivery.cost * 100));
    order.engine = delivery.engine;
    order.qualityScore = Math.min(order.qualityScore, delivery.quality.score);
    order.qualityChecks = delivery.quality.checks;
    if (!delivery.quality.passed) return refundOrder(order, `AI 输出结构 SLA ${order.qualityScore}/100 未达标：${delivery.quality.checks.filter(item => !item.passed).map(item => item.label).join('、')}`);
    const stored = { ...delivery, docx: delivery.docx.toString('base64'), zip: delivery.zip.toString('base64') };
    atomic(() => {
      db.prepare('INSERT OR REPLACE INTO deliverables (order_id,data) VALUES (?,?)').run(order.id, JSON.stringify(stored));
      releaseBenefits(order);
      order.status = 'ENTITLEMENT_GRANTED'; order.entitlement = 'GRANTED'; order.stage = 5; order.grantCount++;
      saveOrder(order);
    });
    return order;
  }

  function checkPaymentFields(order, response, notification = false) {
    if (response.out_trade_no !== order.outTradeNo || Math.round(Number(response.total_amount) * 100) !== order.amountCents) {
      throw error('支付宝订单号或支付金额不一致，权益保持锁定', 400);
    }
    if (notification && response.app_id !== gateway.appId) throw error('回调 app_id 不匹配', 400);
    if (response.app_id && response.app_id !== gateway.appId) throw error('支付宝 app_id 不匹配', 400);
    if (gateway.sellerId && (notification || response.seller_id) && response.seller_id !== gateway.sellerId) throw error('支付宝收款方 seller_id 不匹配', 400);
    if (response.trade_status === 'TRADE_SUCCESS' || response.trade_status === 'TRADE_FINISHED') {
      if (!response.trade_no || (order.tradeNo && response.trade_no !== order.tradeNo)) throw error('支付宝交易号不一致', 400);
    }
  }
  async function acceptNotification(order, fields) {
    const verified = gateway.verifyNotification(fields);
    gateway.record('alipay.notify.verify', fields, { verified, result: verified ? 'RSA2_SIGNATURE_VALID' : 'INVALID_SIGNATURE' }, fields.notify_id, verified);
    if (!verified) throw error('支付宝异步通知 RSA2 验签失败', 400);
    checkPaymentFields(order, fields, true);
    if (!['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(fields.trade_status)) return { order, duplicate: false };
    if (['ENTITLEMENT_GRANTED', 'ENTITLEMENT_REVOKED', 'REFUND_SUCCESS'].includes(order.status)) {
      order.duplicateCallbacks++; saveOrder(order);
      if (order.refundRequestNo && order.status !== 'REFUND_SUCCESS') await refundOrder(order, order.refundReason);
      return { order, duplicate: true };
    }
    order.tradeNo = fields.trade_no; order.tradeStatus = fields.trade_status; order.providerPaid = true;
    saveOrder(order);
    return { order: await completeDelivery(order), duplicate: false };
  }

  app.get('/api/bootstrap', route((req, res) => {
    const orders = listOrders(req.sessionId);
    const paid = orders.filter(item => item.paidAt);
    const gmvCents = paid.reduce((sum, item) => sum + item.amountCents - item.refundedCents, 0);
    const costCents = paid.reduce((sum, item) => sum + item.costCents, 0);
    const granted = paid.filter(item => item.entitlement === 'GRANTED').length;
    const logs = db.prepare('SELECT id,data FROM logs WHERE session_id=? ORDER BY id DESC LIMIT 100').all(req.sessionId)
      .map(row => ({ id: row.id, ...JSON.parse(row.data) }));
    res.json({ cases: CASES, orders: orders.map(viewOrder), logs, account: accountView(req.sessionId),
      kpis: { gmv: yuan(gmvCents), cost: yuan(costCents), margin: gmvCents ? Number(((1 - costCents / gmvCents) * 100).toFixed(1)) : 0,
        passRate: paid.length ? Number((granted / paid.length * 100).toFixed(1)) : 100,
        refunds: paid.filter(item => item.status === 'REFUND_SUCCESS').length, paidOrders: paid.filter(item => item.amountCents > 0).length },
      environment: { mode: gateway.mode, appId: gateway.appId, gateway: gateway.gateway, aiMode: process.env.AI_API_KEY ? 'live' : 'demo',
        subscriptionNote: '应用管理的 30 天预付会员，不自动代扣续费',
        simulationNote: '本地 RSA2 签名报文仿真，不是支付宝官方认证沙箱交易' },
    });
  }));

  app.post('/api/estimate', route((req, res) => {
    if (!CASES.some(item => item.id === req.body.caseId)) throw error('请选择有效案卷');
    const draft = String(req.body.draft || '').slice(0, 100000);
    res.json({ ...estimate(req.body.caseId, draft), preview: preview(req.body.caseId, draft) });
  }));

  app.post('/api/orders', transactionRoute(async (req, res) => {
    const { caseId, mode, idempotencyKey } = req.body;
    const selected = CASES.find(item => item.id === caseId);
    if (!selected || !['oneoff', 'credits', 'subscription'].includes(mode)) throw error('无效的案卷或付费模式');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim() || idempotencyKey.length > 200) throw error('必须提供有效幂等键 idempotencyKey');
    const draft = String(req.body.draft || '').slice(0, 100000);
    const fingerprint = digest({ caseId, mode, draft });
    const prior = db.prepare('SELECT fingerprint,order_id FROM idempotency WHERE session_id=? AND key=?').get(req.sessionId, idempotencyKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw error('幂等键已用于不同订单参数', 409);
      const order = getOrder(prior.order_id);
      return res.json({ order: viewOrder(order), paymentUrl: order.paymentRequired ? `/api/payments/${order.id}/page` : null, reused: true });
    }
    const value = account(req.sessionId);
    const bucket = value.buckets.find(item => item.remaining >= 10);
    const activeSubscription = value.subscriptionUntil && Date.parse(value.subscriptionUntil) > Date.now();
    const amountCents = mode === 'credits' ? (bucket ? 0 : 990) : mode === 'subscription' ? (activeSubscription ? 0 : 2990) : Math.round(estimate(caseId, draft).price * 100);
    const id = randomUUID();
    const order = {
      id, sessionId: req.sessionId, outTradeNo: `PP${Date.now()}${id.replaceAll('-', '').slice(0, 10).toUpperCase()}`,
      tradeNo: null, caseId, mode, draft, subject: mode === 'credits' ? 'PaperPatent 科研算力包 100 点' : mode === 'subscription' ? 'PaperPatent Pro 30 天预付会员' : selected.title,
      amountCents, costCents: 0, refundedCents: 0, status: 'WAIT_BUYER_PAY', tradeStatus: 'WAIT_BUYER_PAY',
      entitlement: 'LOCKED', qualityScore: null, stage: 1, paymentRequired: amountCents > 0,
      idempotencyKey, createdAt: now(), paidAt: null, refundedAt: null, providerPaid: false,
      providerRefunded: false, duplicateCallbacks: 0, grantCount: 0, engine: null,
      creditSourceOrderId: mode === 'credits' && bucket ? bucket.orderId : null,
      subscriptionSourceOrderId: mode === 'subscription' && activeSubscription ? value.subscriptionOrderId : null,
    };
    atomic(() => {
      saveOrder(order);
      db.prepare('INSERT INTO idempotency (session_id,key,fingerprint,order_id) VALUES (?,?,?,?)').run(req.sessionId, idempotencyKey, fingerprint, id);
    });
    if (!order.paymentRequired) {
      order.tradeStatus = 'TRADE_SUCCESS'; order.paidAt = now();
      await completeDelivery(order);
    } else gateway.payment(order, `${req.protocol}://${req.get('host')}`);
    res.status(201).json({ order: viewOrder(order), paymentUrl: order.paymentRequired ? `/api/payments/${id}/page` : null });
  }));

  app.post('/api/orders/:id/simulate-pay', transactionRoute((req, res) => {
    if (gateway.mode !== 'simulator') throw error('真实沙箱模式不允许模拟付款', 403);
    const order = getOwned(req);
    if (!order.paymentRequired || order.providerRefunded) throw error('此订单无需付款或已退款', 409);
    order.providerPaid = true;
    order.tradeNo ||= providerTradeNo();
    if (order.stage < 2) order.stage = 2;
    saveOrder(order);
    res.json({ order: viewOrder(order), message: '仿真支付已完成，服务端查询核销后才可放行权益' });
  }));

  app.post('/api/orders/:id/query', transactionRoute(async (req, res) => {
    let order = getOwned(req);
    if (!order.paymentRequired) return res.json({ order: viewOrder(order), verified: true });
    const response = await gateway.query(order);
    checkPaymentFields(order, response);
    if (['TRADE_SUCCESS', 'TRADE_FINISHED'].includes(response.trade_status)) {
      order.tradeNo = response.trade_no; order.tradeStatus = response.trade_status; order.providerPaid = true;
      order.stage = Math.max(order.stage, 3); saveOrder(order);
      order = await completeDelivery(order);
    } else if (response.trade_status === 'TRADE_CLOSED') {
      order.tradeStatus = 'TRADE_CLOSED';
      if (order.paidAt && order.status !== 'REFUND_SUCCESS') {
        order = await refundOrder(order, '支付宝查询确认已付款交易关闭，原路退款并收回权益', { providerConfirmedClosed: true });
      } else saveOrder(order);
    }
    res.json({ order: viewOrder(order), verified: true });
  }));

  app.post('/api/orders/:id/replay', transactionRoute(async (req, res) => {
    const order = getOwned(req);
    if (gateway.mode !== 'simulator') throw error('真实沙箱不可伪造支付宝回调；可使用查询核销', 403);
    if (!order.providerPaid || !order.tradeNo) throw error('请先完成仿真付款', 409);
    const result = await acceptNotification(order, gateway.createNotification(order));
    res.json({ order: viewOrder(result.order), duplicate: result.duplicate });
  }));

  app.post('/api/orders/:id/refund', transactionRoute(async (req, res) => {
    const order = await refundOrder(getOwned(req), '用户发起 SLA 保护退款演练');
    res.json({ order: viewOrder(order) });
  }));

  app.post('/api/alipay/notify', route((req, res) => serial(async () => {
    const row = db.prepare('SELECT data FROM orders WHERE out_trade_no=?').get(String(req.body.out_trade_no || ''));
    if (!row) return res.status(404).type('text').send('failure');
    const order = JSON.parse(row.data);
    activeSession = order.sessionId;
    try {
      await acceptNotification(order, req.body);
      res.type('text').send('success');
    } catch { res.status(400).type('text').send('failure'); }
    finally { activeSession = null; }
  })));

  app.get('/api/alipay/return', (req, res) => res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>支付返回 · PaperPatent</title><body style="font-family:system-ui;background:#070B14;color:#e5e7eb;padding:70px"><h1>已从支付宝返回</h1><p>页面跳转不代表支付成功。请返回工作台，执行服务端订单查询与 RSA2 验签，确认 TRADE_SUCCESS 后解锁交付物。</p><a href="/" style="color:#60a5fa">返回工作台查询核销 →</a></body></html>`));

  app.get('/api/payments/:id/page', transactionRoute((req, res) => {
    const order = getOwned(req);
    if (!order.paymentRequired) throw error('此订单使用已购买权益，无需再次支付', 409);
    if (order.status === 'REFUND_SUCCESS' || order.tradeStatus === 'TRADE_CLOSED') throw error('订单已退款或关闭', 409);
    const request = gateway.payment(order, `${req.protocol}://${req.get('host')}`);
    if (gateway.mode === 'sandbox') {
      return res.type('html').send(`<!doctype html><html><meta charset="utf-8"><title>支付宝安全收银台</title><body><form id="pay" method="post" action="${safeHtml(gateway.gateway)}">${Object.entries(request).map(([key, value]) => `<input type="hidden" name="${safeHtml(key)}" value="${safeHtml(value)}">`).join('')}<button type="submit">前往支付宝安全支付</button></form><script>document.getElementById('pay').submit()</script></body></html>`);
    }
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>支付宝 RSA2 仿真收银台</title><body style="font-family:system-ui;background:#070B14;color:#e5e7eb;padding:70px;max-width:660px;margin:auto"><p style="color:#60a5fa">支付宝 AI 付 · LOCAL SIMULATOR</p><h1>PaperPatent 安全收银台</h1><p>本地 RSA2 报文仿真，不产生真实扣款。</p><h2>¥ ${moneyDisplay(order.amountCents)}</h2><p>${safeHtml(order.subject)}</p><code>${safeHtml(order.outTradeNo)}</code><p><button id="pay" style="background:#1677ff;color:white;border:0;padding:15px 28px;border-radius:8px;cursor:pointer">确认仿真支付</button></p><p id="status">支付完成后，仍需回到工作台查询核销。</p><a href="/" style="color:#60a5fa">返回工作台</a><script>document.getElementById('pay').onclick=async()=>{const r=await fetch('/api/orders/${order.id}/simulate-pay',{method:'POST'});const d=await r.json();document.getElementById('status').textContent=r.ok?'仿真支付完成。请返回工作台查询核销。':d.error;if(r.ok)document.getElementById('pay').disabled=true;};</script></body></html>`);
  }));

  function deliveryFor(req) {
    const order = getOwned(req);
    if (order.entitlement !== 'GRANTED') throw error('完整交付物需支付核销并通过 SLA；已退款订单的下载权限已收回', 403);
    const row = db.prepare('SELECT data FROM deliverables WHERE order_id=?').get(order.id);
    if (!row) throw error('交付物尚未就绪', 409);
    return { order, data: JSON.parse(row.data) };
  }
  app.get('/api/orders/:id/deliverables', route((req, res) => {
    const { data } = deliveryFor(req);
    const { docx, zip, ...result } = data;
    res.json(result);
  }));
  app.get('/api/orders/:id/download', route((req, res) => {
    const { order, data } = deliveryFor(req);
    const format = req.query.format || 'zip';
    const options = {
      zip: ['application/zip', Buffer.from(data.zip, 'base64')],
      docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from(data.docx, 'base64')],
      tex: ['application/x-tex; charset=utf-8', data.latex], svg: ['image/svg+xml; charset=utf-8', data.svg],
      md: ['text/markdown; charset=utf-8', data.markdown],
    };
    if (!options[format]) throw error('不支持的导出格式');
    res.setHeader('Content-Disposition', `attachment; filename="PaperPatent-${order.outTradeNo}.${format}"`);
    res.type(options[format][0]).send(options[format][1]);
  }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'API 不存在' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    res.status(err.status || 500).json({ error: err.message || '服务暂时不可用' });
  });
  app.locals.store = db;
  app.locals.gateway = gateway;
  app.locals.close = () => db.close();
  return app;
}

const moneyDisplay = cents => (cents / 100).toFixed(2);
