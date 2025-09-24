// functions/api/guardar.js

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
  const bodyText = await request.text(); // payload original (incluye base64 del PDF)

  const upstream =
    env?.APPS_SCRIPT_POST_URL ||
    'https://script.google.com/macros/s/AKfycby-zReunHtHx3ziMwnyAXbeyGpQ6D5LTqsd9cB_WuZhFU43jyNBmRdf5ifiucpYA1SY/exec';

  let resp;
  try {
    // Timeout (ajústalo o quítalo si prefieres el default de CF ~50s)
    const controller = new AbortController();
    const timeoutMs = 45000;
    const id = setTimeout(() => controller.abort(), timeoutMs);

    resp = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyText,
      signal: controller.signal
    });

    clearTimeout(id);
  } catch (e) {
    return new Response(
      JSON.stringify({ status: 'ERROR', message: 'No se pudo conectar con Apps Script' }),
      {
        status: 502,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Vary': 'Origin'
        }
      }
    );
  }

  const text = await resp.text(); // lee SOLO una vez

  // Content-Type del upstream, con fallback a JSON
  const upstreamCT = resp.headers.get('content-type') || 'application/json';

  return new Response(text, {
    status: resp.status,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Content-Type': upstreamCT,
      'Cache-Control': 'no-store',
      'Vary': 'Origin'
    }
  });
}
