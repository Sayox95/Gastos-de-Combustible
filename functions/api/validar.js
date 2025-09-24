// functions/api/validar.js
export async function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin') || '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin'
    }
  });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '*';
  const bodyText = await request.text(); // aquí solo va { NumeroFactura, validarDuplicadoSoloFactura:true }

  const upstream =
    env?.APPS_SCRIPT_POST_URL ||
    'https://script.google.com/macros/s/AKfycby-zReunHtHx3ziMwnyAXbeyGpQ6D5LTqsd9cB_WuZhFU43jyNBmRdf5ifiucpYA1SY/exec';

  try {
    const resp = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText
    });

    const text = await resp.text();
    const ct   = resp.headers.get('content-type') || 'application/json';
    const ra   = resp.headers.get('retry-after');

    const hdrs = {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': ct,
      'Cache-Control': 'no-store',
      'Vary': 'Origin'
    };
    if (ra) hdrs['Retry-After'] = ra;

    return new Response(text, { status: resp.status, headers: hdrs });
  } catch (e) {
    return new Response(JSON.stringify({ status:'ERROR', message:'No se pudo validar' }), {
      status: 502,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Vary': 'Origin'
      }
    });
  }
}
