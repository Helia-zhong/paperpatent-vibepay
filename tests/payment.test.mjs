import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createServer } from 'node:http';
import { createApp } from '../server/app.mjs';

const completeDraft = '本发明公开一种高压压裂车多通道传感器自适应降噪控制方法与系统。采集压力、流量和振动信号，完成时间同步、异常检测及自适应滤波，依据实时噪声能量调整滤波参数；利用闭环反馈校正输出并记录控制过程。实验设置传统滤波、固定阈值和自适应控制三组基线，比较信噪比、响应延迟及误报率。系统包含采集模块、融合模块、控制模块与安全回退模块，并通过独立测试集验证方法有效性。';
let nextKey = 0;
const key = (prefix = 'test') => `${prefix}-${++nextKey}`;

function client(baseUrl) {
  let cookie = '';
  return async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const formBody = body instanceof URLSearchParams;
    const response = await fetch(`${typeof baseUrl === 'function' ? baseUrl() : baseUrl}${pathname}`, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': formBody ? 'application/x-www-form-urlencoded' : 'application/json' }), ...headers },
      body: body === undefined ? undefined : formBody ? body.toString() : JSON.stringify(body),
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    return {
      status: response.status,
      headers: response.headers,
      bytes,
      body: contentType.includes('application/json') && bytes.length ? JSON.parse(bytes.toString()) : bytes.toString(),
    };
  };
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'paperpatent-test-'));
  const dbPath = path.join(directory, 'test.sqlite');
  let app;
  let server;
  let baseUrl;
  async function stop() {
    if (server) {
      const active = server;
      server = undefined;
      active.closeAllConnections();
      await new Promise((resolve, reject) => active.close(error => error ? reject(error) : resolve()));
    }
    if (app) {
      app.locals.close();
      app = undefined;
    }
  }
  async function start() {
    app = createApp({ dbPath, forceSimulator: true });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    return baseUrl;
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  return { api: client(() => baseUrl), anotherClient: () => client(() => baseUrl), gateway: () => app.locals.gateway, stop, start, dbPath };
}

async function createOrder(api, overrides = {}) {
  const response = await api('/api/orders', {
    method: 'POST',
    body: { caseId: 'patent', mode: 'oneoff', draft: completeDraft, idempotencyKey: key(), ...overrides },
  });
  assert.ok([200, 201].includes(response.status), JSON.stringify(response.body));
  assert.ok(response.body.order.id);
  return response.body;
}

async function payAndQuery(api, order) {
  const paid = await api(`/api/orders/${order.id}/simulate-pay`, { method: 'POST' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  const queried = await api(`/api/orders/${order.id}/query`, { method: 'POST' });
  assert.equal(queried.status, 200, JSON.stringify(queried.body));
  return queried.body.order;
}

test('public health check confirms database readiness without creating a browser session', async t => {
  const { api } = await fixture(t);
  const health = await api('/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: 'ok', service: 'paperpatent-vibepay' });
  assert.equal(health.headers.has('set-cookie'), false);
});

test('one-off closure: provider payment and browser return cannot unlock; verified query grants valid deliverables once', async t => {
  const { api } = await fixture(t);
  const { order } = await createOrder(api);
  assert.equal(order.status, 'WAIT_BUYER_PAY');
  assert.equal(order.entitlement, 'LOCKED');
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
  assert.equal((await api(`/api/orders/${order.id}/download?format=zip`)).status, 403);

  await api(`/api/alipay/return?out_trade_no=${encodeURIComponent(order.outTradeNo)}&trade_status=TRADE_SUCCESS`);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
  const unpaidQuery = await api(`/api/orders/${order.id}/query`, { method: 'POST' });
  assert.equal(unpaidQuery.body.order.entitlement, 'LOCKED');

  assert.equal((await api(`/api/orders/${order.id}/simulate-pay`, { method: 'POST' })).status, 200);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
  const queried = await api(`/api/orders/${order.id}/query`, { method: 'POST' });
  assert.equal(queried.body.verified, true);
  assert.equal(queried.body.order.tradeStatus, 'TRADE_SUCCESS');
  assert.equal(queried.body.order.status, 'ENTITLEMENT_GRANTED');
  assert.equal(queried.body.order.entitlement, 'GRANTED');
  assert.equal(queried.body.order.grantCount, 1);
  assert.ok(queried.body.order.qualityScore >= 85);
  assert.ok(queried.body.order.tradeNo);
  assert.match(queried.body.order.tradeNo, /^\d{28}$/);

  const delivery = await api(`/api/orders/${order.id}/deliverables`);
  assert.equal(delivery.status, 200);
  assert.ok(delivery.body.markdown.length > 100);
  assert.match(delivery.body.svg, /<svg/);
  assert.match(delivery.body.latex, /\\documentclass/);
  for (const format of ['zip', 'docx']) {
    const download = await api(`/api/orders/${order.id}/download?format=${format}`);
    assert.equal(download.status, 200);
    assert.equal(download.bytes.subarray(0, 4).toString('hex'), '504b0304');
    assert.match(download.headers.get('content-disposition'), /attachment/);
    if (format === 'docx') assert.ok(download.bytes.includes(Buffer.from('word/document.xml')));
  }

  const before = (await api('/api/bootstrap')).body;
  const replay = await api(`/api/orders/${order.id}/replay`, { method: 'POST' });
  assert.equal(replay.body.duplicate, true);
  const repeatedQueries = await Promise.all(Array.from({ length: 6 }, () => api(`/api/orders/${order.id}/query`, { method: 'POST' })));
  for (const result of repeatedQueries) {
    assert.equal(result.status, 200);
    assert.equal(result.body.order.grantCount, 1);
  }
  const after = (await api('/api/bootstrap')).body;
  assert.equal(after.orders.length, 1);
  assert.equal(after.kpis.gmv, before.kpis.gmv);
  assert.equal(after.kpis.cost, before.kpis.cost);
  assert.equal(after.kpis.paidOrders, before.kpis.paidOrders);
});

test('SLA score 58 triggers full refund and keeps all delivery access revoked, including after concurrent queries', async t => {
  const { api } = await fixture(t);
  const { order } = await createOrder(api, { caseId: 'sla', draft: '不完整草稿' });
  const refunded = await payAndQuery(api, order);
  assert.equal(refunded.qualityScore, 58);
  assert.equal(refunded.status, 'REFUND_SUCCESS');
  assert.equal(refunded.entitlement, 'REVOKED');
  assert.equal(refunded.grantCount, 0);
  assert.ok(refunded.refundedAt);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
  assert.equal((await api(`/api/orders/${order.id}/download?format=docx`)).status, 403);
  const queries = await Promise.all(Array.from({ length: 4 }, () => api(`/api/orders/${order.id}/query`, { method: 'POST' })));
  for (const result of queries) assert.equal(result.body.order.entitlement, 'REVOKED');
  const state = (await api('/api/bootstrap')).body;
  assert.equal(state.kpis.refunds, 1);
  assert.equal(state.kpis.gmv, 0);
  assert.ok(state.logs.some(log => JSON.stringify(log).includes('alipay.trade.refund')));
});

test('manual refunds are idempotent under concurrency and revoke an already granted result', async t => {
  const { api } = await fixture(t);
  const { order } = await createOrder(api);
  assert.equal((await payAndQuery(api, order)).entitlement, 'GRANTED');
  const refunds = await Promise.all(Array.from({ length: 5 }, () => api(`/api/orders/${order.id}/refund`, { method: 'POST' })));
  for (const response of refunds) {
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.order.status, 'REFUND_SUCCESS');
    assert.equal(response.body.order.entitlement, 'REVOKED');
  }
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
  assert.equal((await api(`/api/orders/${order.id}/download?format=zip`)).status, 403);
  const state = (await api('/api/bootstrap')).body;
  assert.equal(state.kpis.refunds, 1);
  assert.equal(state.kpis.gmv, 0);
});

test('credits pack purchase credits 100 once, each delivery debits 10 once, and an existing balance creates no new charge', async t => {
  const { api } = await fixture(t);
  const { order } = await createOrder(api, { caseId: 'paper', mode: 'credits' });
  assert.equal(order.amountCents, 990);
  await payAndQuery(api, order);
  const initialState = (await api('/api/bootstrap')).body;
  assert.equal(initialState.account.credits, 90);
  await Promise.all(Array.from({ length: 4 }, () => api(`/api/orders/${order.id}/query`, { method: 'POST' })));
  await api(`/api/orders/${order.id}/replay`, { method: 'POST' });
  assert.equal((await api('/api/bootstrap')).body.account.credits, 90);

  const { order: nextOrder } = await createOrder(api, { caseId: 'paper', mode: 'credits' });
  assert.equal(nextOrder.paymentRequired, false);
  assert.equal(nextOrder.amountCents, 0);
  assert.equal(nextOrder.entitlement, 'GRANTED');
  await api(`/api/orders/${nextOrder.id}/query`, { method: 'POST' });
  const state = (await api('/api/bootstrap')).body;
  assert.equal(state.account.credits, 80);
  assert.equal(state.kpis.gmv, initialState.kpis.gmv);
  const competing = await Promise.all(Array.from({ length: 10 }, () => createOrder(api, { caseId: 'paper', mode: 'credits' })));
  assert.equal(competing.filter(result => result.order.entitlement === 'GRANTED').length, 8);
  assert.equal(competing.filter(result => result.order.paymentRequired).length, 2);
  assert.equal((await api('/api/bootstrap')).body.account.credits, 0);
});

test('prepaid Pro subscription is granted once for 30 days and reused without charging again', async t => {
  const { api } = await fixture(t);
  const { order } = await createOrder(api, { mode: 'subscription' });
  assert.equal(order.amountCents, 2990);
  const before = Date.now();
  await payAndQuery(api, order);
  const state = (await api('/api/bootstrap')).body;
  const expiry = new Date(state.account.subscriptionUntil).getTime();
  assert.ok(expiry >= before + 29 * 24 * 60 * 60 * 1000);
  assert.ok(expiry <= Date.now() + 31 * 24 * 60 * 60 * 1000);
  await Promise.all(Array.from({ length: 4 }, () => api(`/api/orders/${order.id}/query`, { method: 'POST' })));
  const { order: secondOrder } = await createOrder(api, { caseId: 'report', mode: 'subscription' });
  assert.equal(secondOrder.paymentRequired, false);
  assert.equal(secondOrder.amountCents, 0);
  assert.equal(secondOrder.entitlement, 'GRANTED');
  const after = (await api('/api/bootstrap')).body;
  assert.equal(after.account.subscriptionUntil, state.account.subscriptionUntil);
  assert.equal(after.kpis.gmv, state.kpis.gmv);
});

test('create idempotency returns the same order and rejects a changed request using the same key', async t => {
  const { api } = await fixture(t);
  const idempotencyKey = key('create');
  const first = await createOrder(api, { idempotencyKey });
  const repeated = await Promise.all(Array.from({ length: 5 }, () => createOrder(api, { idempotencyKey })));
  for (const second of repeated) {
    assert.equal(second.order.id, first.order.id);
    assert.equal(second.reused, true);
  }
  const changed = await api('/api/orders', {
    method: 'POST',
    body: { caseId: 'report', mode: 'oneoff', draft: completeDraft, idempotencyKey },
  });
  assert.equal(changed.status, 409);
  assert.equal((await api('/api/bootstrap')).body.orders.length, 1);
});

test('invalid callback signatures and other sessions cannot grant or download an order', async t => {
  const { api, anotherClient } = await fixture(t);
  const { order } = await createOrder(api);
  const stranger = anotherClient();
  await stranger('/api/bootstrap');
  for (const route of [`/api/orders/${order.id}/deliverables`, `/api/orders/${order.id}/download?format=zip`]) {
    assert.equal((await stranger(route)).status, 404);
  }
  assert.equal((await stranger(`/api/orders/${order.id}/simulate-pay`, { method: 'POST' })).status, 404);
  assert.equal((await stranger(`/api/orders/${order.id}/query`, { method: 'POST' })).status, 404);
  const callback = await api('/api/alipay/notify', {
    method: 'POST',
    body: { out_trade_no: order.outTradeNo, trade_no: 'tampered-transaction', trade_status: 'TRADE_SUCCESS', total_amount: '0.01', sign_type: 'RSA2', sign: 'invalid' },
  });
  assert.equal(callback.status, 400);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
});

test('RSA2-signed asynchronous notification grants once; tampered signed amount is rejected', async t => {
  const { api, gateway } = await fixture(t);
  const { order } = await createOrder(api);
  const paid = await api(`/api/orders/${order.id}/simulate-pay`, { method: 'POST' });
  const notification = gateway().createNotification(paid.body.order);
  const tampered = await api('/api/alipay/notify', {
    method: 'POST', body: new URLSearchParams({ ...notification, total_amount: '0.01' }),
  });
  assert.equal(tampered.status, 400);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);

  const first = await api('/api/alipay/notify', { method: 'POST', body: new URLSearchParams(notification) });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body, 'success');
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 200);
  const state = (await api('/api/bootstrap')).body;
  const duplicate = await api('/api/alipay/notify', { method: 'POST', body: new URLSearchParams(notification) });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body, 'success');
  const after = (await api('/api/bootstrap')).body;
  assert.equal(after.orders[0].grantCount, 1);
  assert.equal(after.kpis.gmv, state.kpis.gmv);
  assert.equal(after.kpis.cost, state.kpis.cost);
});

test('paid orders and entitlements remain available after the app reopens its SQLite database', async t => {
  const { api, stop, start } = await fixture(t);
  const { order } = await createOrder(api);
  await payAndQuery(api, order);
  const before = (await api('/api/bootstrap')).body;
  await stop();
  await start();
  const after = (await api('/api/bootstrap')).body;
  assert.equal(after.orders.length, 1);
  assert.equal(after.orders[0].id, order.id);
  assert.equal(after.orders[0].entitlement, 'GRANTED');
  assert.equal(after.kpis.gmv, before.kpis.gmv);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 200);
});

test('unpaid orders have no received revenue or profit', async t => {
  const { api } = await fixture(t);
  const { order } = await createOrder(api);
  assert.ok(order.amount > 0);
  assert.equal(order.receivedAmount, 0);
  assert.equal(order.profit, 0);
  assert.equal(order.margin, 0);
  const paid = await payAndQuery(api, order);
  assert.equal(paid.receivedAmount, paid.amount);
  assert.equal(paid.profit, Number((paid.amount - paid.cost).toFixed(2)));
});

for (const mode of ['credits', 'subscription']) {
  test(`SLA failure using existing ${mode} access preserves prepaid balance but never grants or exports the failed task`, async t => {
    const { api } = await fixture(t);
    const { order: purchase } = await createOrder(api, { mode });
    await payAndQuery(api, purchase);
    const before = (await api('/api/bootstrap')).body;
    const { order: failed } = await createOrder(api, { mode, caseId: 'sla', draft: '残缺草稿' });
    assert.equal(failed.amountCents, 0);
    assert.equal(failed.status, 'REFUND_SUCCESS');
    assert.equal(failed.entitlement, 'REVOKED');
    for (const suffix of ['deliverables', 'download?format=zip', 'download?format=docx']) {
      assert.equal((await api(`/api/orders/${failed.id}/${suffix}`)).status, 403);
    }
    const after = (await api('/api/bootstrap')).body;
    assert.equal(after.account.credits, before.account.credits);
    assert.equal(after.account.subscriptionUntil, before.account.subscriptionUntil);
    assert.equal(after.kpis.gmv, before.kpis.gmv);
    assert.equal(after.kpis.paidOrders, before.kpis.paidOrders);
    assert.equal((await api(`/api/orders/${purchase.id}/deliverables`)).status, 200);
    await api(`/api/orders/${purchase.id}/refund`, { method: 'POST' });
    const stillFailed = await api(`/api/orders/${failed.id}/query`, { method: 'POST' });
    assert.equal(stillFailed.body.order.status, 'REFUND_SUCCESS');
    assert.match(stillFailed.body.order.refundReason, /58/);
  });
}

test('a callback signed before restart is still trusted and refunded orders remain revoked after restart', async t => {
  const { api, gateway, stop, start } = await fixture(t);
  const { order } = await createOrder(api);
  const paid = await api(`/api/orders/${order.id}/simulate-pay`, { method: 'POST' });
  const notification = gateway().createNotification(paid.body.order);
  await stop();
  await start();
  const notified = await api('/api/alipay/notify', { method: 'POST', body: new URLSearchParams(notification) });
  assert.equal(notified.status, 200);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 200);
  const refunded = await api(`/api/orders/${order.id}/refund`, { method: 'POST' });
  await stop();
  await start();
  const duplicate = await api(`/api/orders/${order.id}/refund`, { method: 'POST' });
  assert.equal(duplicate.body.order.refundRequestNo, refunded.body.order.refundRequestNo);
  assert.equal((await api(`/api/orders/${order.id}/download?format=zip`)).status, 403);
});

test('a refund timeout stays revoked and a later query retries the same refund instead of regenerating delivery', async t => {
  const { api, gateway } = await fixture(t);
  const { order } = await createOrder(api);
  await payAndQuery(api, order);
  const originalRefund = gateway().refund.bind(gateway());
  const seenKeys = [];
  let calls = 0;
  gateway().refund = async pending => {
    seenKeys.push(pending.refundRequestNo);
    if (++calls === 1) throw new Error('simulated network timeout');
    return originalRefund(pending);
  };
  assert.equal((await api(`/api/orders/${order.id}/refund`, { method: 'POST' })).status, 500);
  assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
  const retry = await api(`/api/orders/${order.id}/query`, { method: 'POST' });
  assert.equal(retry.body.order.status, 'REFUND_SUCCESS');
  assert.equal(retry.body.order.grantCount, 1);
  assert.equal(seenKeys.length, 2);
  assert.equal(seenKeys[0], seenKeys[1]);
});

test('provider-confirmed closure of a paid order revokes downloads without sending another refund', async t => {
  const { api, gateway } = await fixture(t);
  const { order } = await createOrder(api);
  const paid = await payAndQuery(api, order);
  gateway().query = async () => ({ code: '10000', trade_status: 'TRADE_CLOSED',
    out_trade_no: paid.outTradeNo, trade_no: paid.tradeNo, total_amount: paid.amount.toFixed(2), seller_id: gateway().sellerId });
  gateway().refund = async () => { throw new Error('must not refund again'); };
  const closed = await api(`/api/orders/${order.id}/query`, { method: 'POST' });
  assert.equal(closed.status, 200);
  assert.equal(closed.body.order.status, 'REFUND_SUCCESS');
  assert.equal(closed.body.order.receivedAmount, 0);
  assert.equal((await api(`/api/orders/${order.id}/download?format=zip`)).status, 403);
});

for (const mode of ['credits', 'subscription']) {
  test(`refunding the ${mode} source permanently revokes related tasks across repeated queries and callbacks`, async t => {
    const { api } = await fixture(t);
    const { order: purchase } = await createOrder(api, { mode });
    await payAndQuery(api, purchase);
    const { order: task } = await createOrder(api, { mode });
    assert.equal(task.entitlement, 'GRANTED');
    assert.equal((await api(`/api/orders/${purchase.id}/refund`, { method: 'POST' })).status, 200);
    await api(`/api/orders/${purchase.id}/replay`, { method: 'POST' });
    for (let attempt = 0; attempt < 3; attempt++) {
      const queried = await api(`/api/orders/${task.id}/query`, { method: 'POST' });
      assert.equal(queried.body.order.status, 'ENTITLEMENT_REVOKED');
      assert.equal(queried.body.order.entitlement, 'REVOKED');
      assert.equal(queried.body.order.grantCount, 1);
      assert.equal((await api(`/api/orders/${task.id}/download?format=zip`)).status, 403);
    }
    const state = (await api('/api/bootstrap')).body;
    assert.equal(state.account.credits, 0);
    assert.equal(state.account.subscriptionUntil, null);
    assert.equal(state.kpis.gmv, 0);
    assert.equal(state.kpis.refunds, 1);
    assert.match(state.environment.appId, /^\d{16}$/);
  });
}

test('live AI output must pass actual structure SLA; truncated output refunds and records returned Token cost', async t => {
  const names = ['AI_API_KEY', 'AI_MODEL', 'AI_BASE_URL', 'AI_INPUT_CNY_PER_1M', 'AI_OUTPUT_CNY_PER_1M'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  let finishReason = 'stop';
  const provider = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: '泛泛而谈且缺少权利要求和章节的长篇回答。'.repeat(150) } }],
        usage: { prompt_tokens: 1000, completion_tokens: 2000 } }));
    });
  }).listen(0, '127.0.0.1');
  await once(provider, 'listening');
  Object.assign(process.env, { AI_API_KEY: 'local-test-key', AI_MODEL: 'local-test-model',
    AI_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, AI_INPUT_CNY_PER_1M: '8', AI_OUTPUT_CNY_PER_1M: '32' });
  t.after(async () => {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
    provider.closeAllConnections();
    await new Promise(resolve => provider.close(resolve));
  });
  const { api } = await fixture(t);
  for (const reason of ['stop', 'length']) {
    finishReason = reason;
    const { order } = await createOrder(api);
    const result = await payAndQuery(api, order);
    assert.equal(result.status, 'REFUND_SUCCESS');
    assert.ok(result.qualityScore < 85);
    assert.equal(result.grantCount, 0);
    assert.equal(result.cost, 0.07);
    assert.equal((await api(`/api/orders/${order.id}/deliverables`)).status, 403);
    assert.equal((await api(`/api/orders/${order.id}/download?format=docx`)).status, 403);
  }
});
