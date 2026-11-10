import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { createApp } from '../server/app.mjs';

test('inline checkout stays visible on locked tabs and unlocks a one-off result only after server verification', async t => {
  const app = createApp({ dbPath: ':memory:', forceSimulator: true });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: origin });
  const originalGlobals = new Map();
  const nativeFetch = globalThis.fetch;
  const nativeSetTimeout = globalThis.setTimeout;
  const timers = new Set();
  const calls = [];
  const scrolls = [];
  let cookie = '';
  let queryWaiting = false;
  let releaseQuery;
  const queryGate = new Promise(resolve => { releaseQuery = resolve; });
  let vite;
  let root;

  function installGlobal(name, value) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  t.after(async () => {
    releaseQuery();
    if (root) await act(async () => root.unmount());
    if (vite) await vite.close();
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    app.locals.close();
    for (const timer of timers) clearTimeout(timer);
    dom.window.close();
    for (const [name, descriptor] of originalGlobals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });

  for (const name of ['window', 'document', 'navigator', 'location']) installGlobal(name, name === 'window' ? dom.window : dom.window[name]);
  installGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  installGlobal('setTimeout', (...args) => {
    const timer = nativeSetTimeout(...args);
    timers.add(timer);
    return timer;
  });
  dom.window.HTMLElement.prototype.scrollIntoView = function (options) { scrolls.push({ element: this, options }); };
  installGlobal('fetch', async (input, options = {}) => {
    const url = new URL(input, origin);
    assert.equal(url.origin, origin, 'UI requests must remain on the test API');
    const method = options.method || 'GET';
    if (method === 'POST' && url.pathname.endsWith('/query')) {
      queryWaiting = true;
      await queryGate;
    }
    const headers = new Headers(options.headers);
    if (cookie) headers.set('cookie', cookie);
    const response = await nativeFetch(url, { ...options, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    calls.push({ path: url.pathname, method, request: options.body ? JSON.parse(options.body) : null, status: response.status, response: await response.clone().json() });
    return response;
  });

  vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  const { default: App } = await vite.ssrLoadModule('/src/App.jsx');
  const { createRoot } = await import('react-dom/client');
  root = createRoot(dom.window.document.getElementById('root'));
  const document = dom.window.document;
  const select = selector => document.querySelector(selector);
  const tab = label => [...document.querySelectorAll('.preview-tabs button')].find(button => button.textContent === label);
  const click = async element => {
    assert.ok(element, 'expected UI control exists');
    await act(async () => element.click());
  };
  const waitFor = async (predicate, message) => {
    const deadline = Date.now() + 10000;
    while (!predicate() && Date.now() < deadline) await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    assert.ok(predicate(), message);
  };

  await act(async () => root.render(React.createElement(App)));
  await waitFor(() => document.querySelectorAll('.expert-row').length === 3, 'free diagnosis should show three experts');
  const banner = select('.inline-paywall-cta');
  assert.match(banner.textContent, /剩余 70% 核心成果待解锁/);
  assert.match(banner.textContent, /支付宝 ¥2\.80 立即解锁并核销/);
  assert.ok(banner.previousElementSibling.classList.contains('experts-list'), 'the banner follows the free diagnosis');
  assert.equal(select('.delivery-bottom button').disabled, true);

  await click(tab('权利要求书'));
  assert.ok(select('.inline-paywall-cta'), 'claims tab exposes inline checkout');
  await click(tab('架构附图'));
  assert.ok(select('.inline-paywall-cta'), 'diagram tab exposes inline checkout');
  await click(select('.inline-checkout-link'));
  assert.equal(scrolls.at(-1).element, select('.checkout-panel'));
  assert.deepEqual(scrolls.at(-1).options, { behavior: 'smooth', block: 'center' });
  assert.equal(document.activeElement, select('.checkout-panel'), 'cashier receives keyboard focus');

  await click([...document.querySelectorAll('.payment-mode-tabs button')].find(button => button.textContent === '算力包'));
  assert.match(select('.checkout-price').textContent, /9\.90/);
  await click(select('.inline-unlock-button'));
  await waitFor(() => queryWaiting, 'quick checkout should request server verification after payment');
  const mutationsBeforeQuery = calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/orders'));
  assert.equal(mutationsBeforeQuery.length, 2);
  const [created, paid] = mutationsBeforeQuery;
  assert.equal(created.path, '/api/orders');
  assert.equal(created.request.mode, 'oneoff', 'quick unlock ignores the previously selected credit pack');
  assert.equal(created.response.order.amount, 2.8);
  assert.equal(created.response.order.entitlementStatus, 'LOCKED');
  assert.equal(paid.path, `/api/orders/${created.response.order.id}/simulate-pay`);
  assert.equal(paid.response.order.entitlementStatus, 'LOCKED', 'provider payment alone must not grant access');
  assert.ok(select('.inline-paywall-cta'), 'CTA remains while verification is pending');
  assert.equal(select('.delivery-bottom button').disabled, true, 'exports stay locked before server query');
  const protectedResponse = await nativeFetch(`${origin}/api/orders/${created.response.order.id}/deliverables`, { headers: { cookie } });
  assert.equal(protectedResponse.status, 403);
  await protectedResponse.arrayBuffer();

  releaseQuery();
  await waitFor(() => !select('.inline-paywall-cta') && !select('.delivery-bottom button').disabled, 'verified payment removes the paywall and enables export');
  await waitFor(() => calls.some(call => call.path.endsWith('/deliverables')), 'unlocked UI loads the protected deliverables');
  const mutations = calls.filter(call => call.method === 'POST' && call.path.startsWith('/api/orders'));
  assert.deepEqual(mutations.map(call => call.path), ['/api/orders', paid.path, `/api/orders/${created.response.order.id}/query`], 'UI grants access exclusively through the server query flow');
  assert.equal(mutations[2].response.order.entitlementStatus, 'ENTITLEMENT_GRANTED');
  assert.equal(mutations[2].response.order.grantCount, 1);
  assert.equal(select('.payment-mode-tabs button.active').textContent, '按果买断');
  assert.match(select('.delivery-panel .small-tag').textContent, /完整交付已解锁/);
});
