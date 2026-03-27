// functions/api/procesos.js
// Sirve lista de procesos desde D1

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'public, max-age=3600', // cache 1 hora
  'Vary': 'Origin'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB
      .prepare("SELECT Proceso FROM procesos ORDER BY Proceso")
      .all();

    const procesos = (results || []).map(r => r.Proceso).filter(Boolean);

    return new Response(JSON.stringify({ procesos }), { status: 200, headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}
