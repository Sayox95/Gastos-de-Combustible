// functions/api/catalogos.js
// Sirve catálogo de vehículos activos desde D1 en vez de AppScript

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Vary': 'Origin'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestGet({ env }) {
  try {
    const { results } = await env.DB
      .prepare(`
        SELECT Placa, Sector, Jefe, Proceso
        FROM vehiculos
        WHERE UPPER(Estado) = 'ACTIVO'
        ORDER BY Sector, Placa
      `)
      .all();

    const data = (results || []).map(r => ({
      PLACA:           r.Placa  || "",
      Sector:          r.Sector || "",
      "Jefe inmediato": r.Jefe  || "",
      Proceso:         r.Proceso || ""
    }));

    return new Response(JSON.stringify(data), { status: 200, headers: CORS });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
  }
}
