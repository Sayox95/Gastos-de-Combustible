// functions/api/validar.js
// Valida duplicados de factura consultando D1 en vez de AppScript/Sheets

const APPSCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbznSLsTh5_BBp88VJbjWhaBD-6CKXjns2rywJbwQ8FkK5c5evp7-2_oGF-MFZZC3i4AxA/exec';

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Vary': 'Origin'
});

export async function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin') || '*';
  return new Response(null, { status: 204, headers: CORS(origin) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '*';
  let bodyJson = null;
  try { bodyJson = JSON.parse(await request.text()); } catch (_) {}

  const numeroFactura = (bodyJson?.NumeroFactura || "").toString().trim();

  // Si no viene número de factura o no hay D1, caer al AppScript
  if (!numeroFactura || !env.DB) {
    return fallbackAppScript(bodyJson, origin);
  }

  // ── Validar duplicado en D1 ──────────────────────────────────────────────
  try {
    const { results } = await env.DB
      .prepare("SELECT fila FROM facturas WHERE NumeroFactura = ? LIMIT 1")
      .bind(numeroFactura)
      .all();

    const duplicado = results && results.length > 0;
    return new Response(JSON.stringify({ duplicado }), {
      status: 200, headers: CORS(origin)
    });

  } catch (e) {
    // Si D1 falla, caer al AppScript como respaldo
    console.error("D1 validar error:", e.message);
    return fallbackAppScript(bodyJson, origin);
  }
}

async function fallbackAppScript(bodyJson, origin) {
  const CORS_HEADERS = {
    'Access-Control-Allow-Origin': origin,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };
  try {
    const resp = await fetch(APPSCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyJson)
    });
    const text = await resp.text();
    return new Response(text, { status: resp.status, headers: CORS_HEADERS });
  } catch (e) {
    return new Response(
      JSON.stringify({ status: 'ERROR', message: 'No se pudo validar' }),
      { status: 502, headers: CORS_HEADERS }
    );
  }
}
