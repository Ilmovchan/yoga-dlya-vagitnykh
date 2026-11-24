// Сайт (статичні файли) + оплата через WayForPay.
//   POST /api/checkout              → створює замовлення, повертає підписану форму WayForPay
//   POST /pay/wayforpay/return      → WayForPay повертає сюди покупця після оплати
//   POST /api/wayforpay/callback    → WayForPay підтверджує оплату (server-to-server)
// Налаштування: vars WFP_MERCHANT, WFP_DOMAIN?, ENV_LABEL?; secrets WFP_SECRET, TG_BOT_TOKEN?, TG_CHAT_ID?; KV ORDERS.
import { createHmac } from 'node:crypto';

const PRODUCT = { name: 'Йога для вагітних — онлайн-курс', price: 449, currency: 'UAH' };
const WFP_PAY_URL = 'https://secure.wayforpay.com/pay';
const ORDER_TTL = 60 * 60 * 24 * 180; // зберігаємо замовлення пів року

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/checkout' && req.method === 'POST') return checkout(req, env, url);
    if (url.pathname === '/pay/wayforpay/return') return paymentReturn(req, env);
    if (url.pathname === '/api/wayforpay/callback' && req.method === 'POST') return callback(req, env);
    if (/^\/v\/[\w.-]+\.mp4$/.test(url.pathname)) return video(req, env, '/assets/' + url.pathname.slice(3));
    return env.ASSETS.fetch(req);
  }
};

// Статичні файли Workers не віддають Range (206), а без нього відео стартує повільно,
// не перемотується, а Safari на iOS може взагалі не відтворити. Тому відео йдуть через /v/<файл>
// (такого шляху серед файлів немає, тож запит гарантовано потрапляє сюди), а шматок вирізаємо самі,
// потоком — без завантаження всього файлу в пам'ять.
async function video(req, env, assetPath) {
  const assetUrl = new URL(assetPath, req.url);
  const res = await env.ASSETS.fetch(assetUrl);
  if (res.status !== 200) return res;
  const headers = new Headers(res.headers);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  if (req.headers.get('If-None-Match') && req.headers.get('If-None-Match') === res.headers.get('ETag')) {
    res.body?.cancel();
    return new Response(null, { status: 304, headers });
  }
  const size = await assetSize(env, assetUrl, res);
  headers.set('Content-Length', String(size));

  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') ?? '');
  if (!m || (!m[1] && !m[2])) return new Response(req.method === 'HEAD' ? null : res.body, { status: 200, headers });

  let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));   // "bytes=-N" — останні N байт
  let end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  if (start >= size || start > end) {
    res.body?.cancel();
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  if (req.method === 'HEAD' || !res.body) return new Response(null, { status: 206, headers });
  return new Response(res.body.pipeThrough(slice(start, end)), { status: 206, headers });
}

// Усередині воркера ASSETS не дає Content-Length, тож розмір рахуємо один раз і запам'ятовуємо
// (ключ включає ETag — після оновлення файлу розмір перерахується).
const sizes = new Map();
async function assetSize(env, assetUrl, res) {
  const key = assetUrl.pathname + (res.headers.get('ETag') ?? '');
  if (!sizes.has(key)) {
    const reader = (await env.ASSETS.fetch(assetUrl)).body.getReader();
    let n = 0;
    for (let r; !(r = await reader.read()).done;) n += r.value.byteLength;
    sizes.set(key, n);
  }
  return sizes.get(key);
}

function slice(start, end) {
  let pos = 0;
  return new TransformStream({
    transform(chunk, ctrl) {
      const from = Math.max(start - pos, 0), to = Math.min(end + 1 - pos, chunk.byteLength);
      if (from < to) ctrl.enqueue(chunk.subarray(from, to));
      pos += chunk.byteLength;
      if (pos > end) ctrl.terminate();
    }
  });
}

const sign = (secret, parts) => createHmac('md5', secret).update(parts.join(';')).digest('hex');
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const clean = (v, max = 100) => String(v ?? '').trim().slice(0, max);

async function checkout(req, env, url) {
  if (!env.WFP_MERCHANT || !env.WFP_SECRET) return json({ error: 'payments_not_configured' }, 503);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const name = clean(body.name), email = clean(body.email), telegram = clean(body.telegram);
  if (name.length < 2 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || telegram.length < 4) return json({ error: 'invalid_fields' }, 400);

  const orderReference = `EC-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`.toUpperCase();
  const orderDate = Math.floor(Date.now() / 1000);
  const merchantDomainName = env.WFP_DOMAIN || url.hostname;

  const fields = {
    merchantAccount: env.WFP_MERCHANT,
    merchantAuthType: 'SimpleSignature',
    merchantDomainName,
    orderReference,
    orderDate,
    amount: PRODUCT.price,
    currency: PRODUCT.currency,
    productName: [PRODUCT.name],
    productCount: [1],
    productPrice: [PRODUCT.price],
    clientFirstName: name,
    clientEmail: email,
    language: 'UA',
    returnUrl: `${url.origin}/pay/wayforpay/return`,
    serviceUrl: `${url.origin}/api/wayforpay/callback`
  };
  fields.merchantSignature = sign(env.WFP_SECRET, [
    fields.merchantAccount, merchantDomainName, orderReference, orderDate, PRODUCT.price, PRODUCT.currency,
    ...fields.productName, ...fields.productCount, ...fields.productPrice
  ]);

  await env.ORDERS?.put(orderReference, JSON.stringify({
    orderReference, name, email, telegram, amount: PRODUCT.price, currency: PRODUCT.currency,
    status: 'Created', createdAt: new Date().toISOString()
  }), { expirationTtl: ORDER_TTL });

  return json({ action: WFP_PAY_URL, fields });
}

// Підпис відповіді WayForPay (returnUrl і serviceUrl мають однаковий набір полів)
const validResponse = (env, d) => d?.merchantSignature && d.merchantSignature === sign(env.WFP_SECRET, [
  d.merchantAccount, d.orderReference, d.amount, d.currency, d.authCode, d.cardPan, d.transactionStatus, d.reasonCode
]);

const resultOf = status =>
  status === 'Approved' ? 'success' :
  ['Pending', 'InProcessing', 'WaitingAuthComplete', 'Created'].includes(status) ? 'pending' : 'fail';

async function paymentReturn(req, env) {
  let status;
  if (req.method === 'POST') {
    const d = Object.fromEntries(await req.formData());
    if (validResponse(env, d)) status = d.transactionStatus;
    else if (d.orderReference) status = JSON.parse(await env.ORDERS?.get(d.orderReference) ?? 'null')?.status;
  }
  return Response.redirect(new URL(`/?payment=${resultOf(status)}`, req.url), 303);
}

async function callback(req, env) {
  // WayForPay шле JSON у тілі; деякі інтеграції отримують його як ключ form-urlencoded
  const raw = await req.text();
  let d;
  try { d = JSON.parse(raw); } catch { try { d = JSON.parse([...new URLSearchParams(raw).keys()][0]); } catch {} }
  if (!env.WFP_SECRET || !validResponse(env, d)) return json({ error: 'bad_signature' }, 400);

  const order = JSON.parse(await env.ORDERS?.get(d.orderReference) ?? 'null') ?? { orderReference: d.orderReference };
  const firstApproval = d.transactionStatus === 'Approved' && !order.paidAt;
  Object.assign(order, { status: d.transactionStatus, reason: d.reason, updatedAt: new Date().toISOString() });
  if (firstApproval) {
    order.paidAt = order.updatedAt;
    order.paymentEmail = d.email; order.paymentPhone = d.phone;
    await notifyTelegram(env, order, d);
  }
  await env.ORDERS?.put(d.orderReference, JSON.stringify(order), { expirationTtl: ORDER_TTL });

  const time = Math.floor(Date.now() / 1000);
  return json({ orderReference: d.orderReference, status: 'accept', time, signature: sign(env.WFP_SECRET, [d.orderReference, 'accept', time]) });
}

async function notifyTelegram(env, order, d) {
  const text = [
    `${env.ENV_LABEL ? `[${env.ENV_LABEL}] ` : ''}💰 Нова оплата — ${d.amount} ${d.currency}`,
    `Ім’я: ${order.name ?? '—'}`,
    `Telegram: ${order.telegram ?? '—'}`,
    `Email: ${order.email ?? d.email ?? '—'}`,
    d.phone ? `Телефон: ${d.phone}` : null,
    `Замовлення: ${d.orderReference}`
  ].filter(Boolean).join('\n');
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) { console.log('[telegram not configured]', text); return; }
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text })
  }).catch(e => console.log('[telegram error]', e));
}
