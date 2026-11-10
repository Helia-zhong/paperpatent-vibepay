import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { AlipayGateway } from '../server/gateway.mjs';

test('RSA2 verification cannot use an unsigned duplicate response object', async t => {
  const provider = generateKeyPairSync('rsa', { modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  const gateway = new AlipayGateway({ forceSimulator: true });
  gateway.mode = 'sandbox';
  gateway.publicKey = provider.publicKey;
  const signed = JSON.stringify({ code: '10000', trade_status: 'WAIT_BUYER_PAY', out_trade_no: 'PP-test', total_amount: '2.80' });
  const signature = sign('RSA-SHA256', Buffer.from(signed), provider.privateKey).toString('base64');
  const malicious = JSON.stringify({ code: '10000', trade_status: 'TRADE_SUCCESS', out_trade_no: 'PP-test', total_amount: '2.80', trade_no: 'forged' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`{"alipay_trade_query_response":${signed},"alipay_trade_query_response":${malicious},"sign":${JSON.stringify(signature)}}`);
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => gateway.query({ outTradeNo: 'PP-test', idempotencyKey: 'test' }), /验签失败/);
});
