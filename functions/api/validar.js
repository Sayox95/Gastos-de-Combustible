// functions/api/validar.js
const memo = new Map(); // cache en memoria por 5 min

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '*';
  const ua = request.headers.get('User-Agent') || 'Mozilla/5.0';
  const ref = request.headers.get('Referer') || origin || '';

  // token bucket simple: 4 req / 10s por IP
  const ip = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  if (!globalThis.bk) globalThis.bk = new Map();
  const now = Date.now();
  const b = globalThis.bk.get(ip) || { t: now, tok: 4 };
  const add = Math.floor((now - b.t) / 2500);
  b.tok = Math.min(4, b.tok + add);
  b.t = now;
  if (b.tok <= 0) {
    return new Response(JSON.stringify({ status: 'RATE_LIMIT', message: 'Demasiadas validaciones' }), {
      status: 429,
      headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json', 'Retry-After': '2', 'Vary': 'Origin' }
    });
  }
  b.tok -= 1; globalThis.bk.set(ip, b);

  const bodyText = await request.text();
  let nf = null; try { nf = (JSON.parse(bodyText).NumeroFactura || '').trim(); } catch {}

  if (nf && memo.has(nf)) {
    const hit = memo.get(nf);
    if (now - hit.t < 5 * 60 * 1000) {
      return new Response(hit.body, {
        status: 200,
        headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': hit.ct, 'Cache-Control': 'no-store', 'Vary': 'Origin' }
      });
    } else memo.delete(nf);
  }

  const upstream = env?.APPS_SCRIPT_POST_URL ||
    'https://script.google.com/macros/s/AKfycbzOnARKPvpMeRo1SYonzEZXZ97ejZCcXbuUYJYDT-6YzvMlZO9CqQEvu4QQE23I2c5v4A/exec';

  const resp = await fetch(upstream, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // pasa señales de cliente (ayuda a que Google no lo marque como bot)
      'User-Agent': ua,
      'Referer': ref
    },
    body: bodyText
  });

  const text = await resp.text();
  const ct = resp.headers.get('content-type') || 'application/json';

  // Log útil para tu diagnóstico
  console.log(JSON.stringify({ route:'/api/validar', upstreamStatus: resp.status, retryAfter: resp.headers.get('retry-after') || null }));

  if (nf && resp.ok && text.length < 2048) memo.set(nf, { t: now, body: text, ct });

  return new Response(text, {
    status: resp.status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': ct,
      'Cache-Control': 'no-store',
      'Vary': 'Origin',
      'Retry-After': resp.headers.get('retry-after') || undefined
    }
  });
}
