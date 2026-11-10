import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';

const money = cents => (cents / 100).toFixed(2);
const pem = (value, kind) => {
  const text = String(value || '').replace(/\\n/g, '\n').trim();
  if (text.includes('-----BEGIN')) return text;
  return `-----BEGIN ${kind} KEY-----\n${text.match(/.{1,64}/g)?.join('\n') || ''}\n-----END ${kind} KEY-----`;
};
const canonical = (params, notification = false) => Object.keys(params)
  .filter(key => key !== 'sign' && (!notification || key !== 'sign_type') && params[key] !== '' && params[key] != null)
  .sort().map(key => `${key}=${params[key]}`).join('&');
const rsaSign = (text, key) => sign('RSA-SHA256', Buffer.from(text, 'utf8'), key).toString('base64');
const rsaVerify = (text, signature, key) => {
  try { return verify('RSA-SHA256', Buffer.from(text, 'utf8'), key, Buffer.from(signature || '', 'base64')); }
  catch { return false; }
};
const beijingTimestamp = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(new Date());
const pair = () => generateKeyPairSync('rsa', {
  modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// Alipay signs the original response object bytes, not a reserialized object.
function responseValue(raw, name) {
  const marker = JSON.stringify(name);
  const at = raw.indexOf(marker);
  if (at < 0) throw new Error('支付宝响应缺少指定业务报文');
  let start = raw.indexOf(':', at + marker.length) + 1;
  while (/\s/.test(raw[start])) start++;
  if (raw[start] !== '{') throw new Error('支付宝响应业务报文格式错误');
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < raw.length; i++) {
    const char = raw[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  throw new Error('支付宝响应报文不完整');
}

export class AlipayGateway {
  constructor({ forceSimulator = false, simulatorKeys, log = () => {} } = {}) {
    this.log = log;
    const configured = process.env.ALIPAY_APP_ID && process.env.ALIPAY_PRIVATE_KEY && process.env.ALIPAY_PUBLIC_KEY;
    this.mode = configured && !forceSimulator ? 'sandbox' : 'simulator';
    this.appId = this.mode === 'simulator' ? '2026111000000001' : process.env.ALIPAY_APP_ID;
    this.gateway = process.env.ALIPAY_GATEWAY || 'https://openapi-sandbox.dl.alipaydev.com/gateway.do';
    this.sellerId = process.env.ALIPAY_SELLER_ID || (this.mode === 'simulator' ? '2088100000000000' : null);
    if (this.mode === 'simulator') {
      const merchant = simulatorKeys?.merchant || pair(), provider = simulatorKeys?.provider || pair();
      this.simulatorKeys = { merchant, provider };
      this.privateKey = merchant.privateKey;
      this.merchantPublicKey = merchant.publicKey;
      this.providerPrivateKey = provider.privateKey;
      this.publicKey = provider.publicKey;
    } else {
      this.privateKey = pem(process.env.ALIPAY_PRIVATE_KEY, 'PRIVATE');
      this.publicKey = pem(process.env.ALIPAY_PUBLIC_KEY, 'PUBLIC');
    }
  }

  request(method, business, extra = {}) {
    const params = {
      app_id: this.appId, method, format: 'JSON', charset: 'utf-8', sign_type: 'RSA2',
      timestamp: beijingTimestamp(), version: '1.0', ...extra, biz_content: JSON.stringify(business),
    };
    params.sign = rsaSign(canonical(params), this.privateKey);
    return params;
  }

  record(method, request, response, idempotencyKey, verified) {
    this.log({ method, request, response, idempotencyKey,
      signatureDigest: createHash('sha256').update(request.sign || '').digest('hex'), verified, mode: this.mode });
  }

  payment(order, origin) {
    const request = this.request('alipay.trade.page.pay', {
      out_trade_no: order.outTradeNo, product_code: 'FAST_INSTANT_TRADE_PAY',
      total_amount: money(order.amountCents), subject: order.subject,
    }, {
      notify_url: process.env.ALIPAY_NOTIFY_URL || `${origin}/api/alipay/notify`,
      return_url: process.env.ALIPAY_RETURN_URL || `${origin}/api/alipay/return`,
    });
    this.record('alipay.trade.page.pay', request, {
      type: 'PAGE_REDIRECT', gateway: this.gateway,
      note: this.mode === 'simulator' ? '本地 RSA2 仿真收银台，未向支付宝发送资金交易' : '签名表单跳转；页面返回不能作为支付凭证',
    }, order.idempotencyKey, null);
    return request;
  }

  async invoke(method, business, order, idempotencyKey) {
    const request = this.request(method, business);
    const envelopeName = `${method.replaceAll('.', '_')}_response`;
    let envelope, raw;
    if (this.mode === 'simulator') {
      if (!rsaVerify(canonical(request), request.sign, this.merchantPublicKey)) throw new Error('仿真引擎商户请求 RSA2 验签失败');
      let response;
      if (method === 'alipay.trade.query') response = {
        code: '10000', msg: 'Success', out_trade_no: order.outTradeNo,
        trade_no: order.tradeNo || '', buyer_logon_id: 'judge***@sandbox.local',
        trade_status: order.providerPaid ? (order.providerRefunded ? 'TRADE_CLOSED' : 'TRADE_SUCCESS') : 'WAIT_BUYER_PAY',
        total_amount: money(order.amountCents), receipt_amount: order.providerPaid ? money(order.amountCents) : '0.00',
        buyer_pay_amount: order.providerPaid ? money(order.amountCents) : '0.00', seller_id: this.sellerId,
      };
      else if (method === 'alipay.trade.refund') response = {
        code: '10000', msg: 'Success', out_trade_no: order.outTradeNo, trade_no: order.tradeNo,
        buyer_logon_id: 'judge***@sandbox.local', fund_change: order.providerRefunded ? 'N' : 'Y',
        refund_fee: money(order.amountCents), gmt_refund_pay: beijingTimestamp(),
      };
      else throw new Error('不支持的仿真交易方法');
      const body = JSON.stringify(response);
      envelope = { [envelopeName]: response, sign: rsaSign(body, this.providerPrivateKey) };
      raw = JSON.stringify(envelope);
    } else {
      const response = await fetch(this.gateway, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
        body: new URLSearchParams(request), signal: AbortSignal.timeout(25000),
      });
      raw = await response.text();
      if (!response.ok) throw new Error(`支付宝网关 HTTP ${response.status}`);
      try { envelope = JSON.parse(raw); } catch { throw new Error('支付宝网关返回了无效 JSON'); }
    }
    const signedBody = responseValue(raw, envelopeName);
    const response = JSON.parse(signedBody);
    const verified = rsaVerify(signedBody, envelope.sign, this.publicKey)
      && JSON.stringify(response) === JSON.stringify(envelope[envelopeName]);
    this.record(method, request, envelope, idempotencyKey, verified);
    if (!verified) throw new Error('支付宝响应 RSA2 验签失败，权益保持锁定');
    if (response.code !== '10000') throw new Error(`${response.sub_msg || response.msg || '支付宝请求失败'} (${response.sub_code || response.code})`);
    return response;
  }

  query(order) { return this.invoke('alipay.trade.query', { out_trade_no: order.outTradeNo }, order, order.idempotencyKey); }
  refund(order) {
    return this.invoke('alipay.trade.refund', {
      out_trade_no: order.outTradeNo, refund_amount: money(order.amountCents),
      refund_reason: order.refundReason || '交付质量 SLA 未达标，原路全额退款', out_request_no: order.refundRequestNo,
    }, order, order.refundRequestNo);
  }

  createNotification(order) {
    if (this.mode !== 'simulator') throw new Error('真实支付宝回调不可由应用伪造');
    const fields = {
      app_id: this.appId, notify_id: `notify_${order.outTradeNo}`, notify_type: 'trade_status_sync',
      notify_time: beijingTimestamp(), charset: 'utf-8', version: '1.0', sign_type: 'RSA2',
      out_trade_no: order.outTradeNo, trade_no: order.tradeNo, trade_status: 'TRADE_SUCCESS',
      total_amount: money(order.amountCents), receipt_amount: money(order.amountCents),
      seller_id: this.sellerId, buyer_id: '2088000000000001', gmt_payment: beijingTimestamp(),
    };
    fields.sign = rsaSign(canonical(fields, true), this.providerPrivateKey);
    return fields;
  }
  verifyNotification(fields) {
    return fields.sign_type === 'RSA2' && rsaVerify(canonical(fields, true), fields.sign, this.publicKey);
  }
}
