// functions/api/guardar.js (Formulario)
// Flujo: PDF → R2, datos → D1, IDvehiculo/Marca/Modelo → D1 (tabla vehiculos)

const SYNC_URL    = "https://repositorio-de-pruebas.pages.dev/api/sincronizar";
const SYNC_SECRET = "utcd-facturas-2026-sync-xK9mP";
const R2_PUBLIC   = "https://pub-9a4726fe82ba459fa6542b01ec3b1f4f.r2.dev";

const APPSCRIPT_URL = "https://script.google.com/macros/s/AKfycbxZ2pIfZy4aJ4NT3xQTHKNjFSEYfSUxiV1aBpgIXIZVthOUYbjbm-mllTQc2ZLkdTL1Ww/exec";

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
  const origin   = request.headers.get('Origin') || '*';
  const CORS     = { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };

  let bodyJson = null;
  try { bodyJson = JSON.parse(await request.text()); } catch (_) {}

  if (!bodyJson) {
    return new Response(JSON.stringify({ ok: false, status: 'ERROR', message: 'Payload inválido' }), { status: 400, headers: CORS });
  }

  // ── Validaciones / flujos que siguen yendo al AppScript ─────────────────
  const isValidacion  = bodyJson.validarDuplicadoSoloFactura || bodyJson.validarDuplicado;
  const isEstado      = bodyJson.actualizarEstado || bodyJson.accion === 'pagoLote' || bodyJson.accion === 'actualizarEstadoLote';
  const isLiquidacion = bodyJson.accion === 'generarLiquidacion';

  if (isValidacion || isEstado || isLiquidacion) {
    return forwardToAppScript(bodyJson, origin);
  }

  // ── Flujo principal: guardar nueva factura ───────────────────────────────
  const numeroFactura = (bodyJson.NumeroFactura || "").trim();
  const sector        = (bodyJson.Sector        || "").trim();
  const pdfBase64     = bodyJson.pdf;
  const filename      = (bodyJson.filename      || `${sector}_${numeroFactura}.pdf`).replace(/\s+/g, '_');

  if (!numeroFactura || !pdfBase64) {
    return new Response(JSON.stringify({ ok: false, status: 'ERROR', message: 'Faltan datos requeridos' }), { status: 400, headers: CORS });
  }

  // ── 1) Verificar duplicado en D1 (por NumeroFactura + Sector) ───────────
  if (env.DB && !bodyJson.reemplazarPorFactura) {
    try {
      const { results } = await env.DB
        .prepare("SELECT fila FROM facturas WHERE NumeroFactura = ? AND Sector = ? LIMIT 1")
        .bind(numeroFactura, sector)
        .all();
      if (results && results.length > 0) {
        return new Response(JSON.stringify({
          ok: false, status: 'ERROR', code: 'FACTURA_DUP',
          row: results[0].fila,
          message: 'La factura ya existe. Confirme reemplazo en el cliente.'
        }), { status: 200, headers: CORS });
      }
    } catch (e) {
      console.error("D1 duplicado check error:", e.message);
    }
  }

  // ── 2) Subir PDF a R2 ───────────────────────────────────────────────────
  let fileUrl = null;
  try {
    if (!env.PDF_BUCKET) throw new Error("PDF_BUCKET binding no configurado");
    const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    await env.PDF_BUCKET.put(filename, pdfBytes, {
      httpMetadata: { contentType: 'application/pdf' }
    });
    fileUrl = `${R2_PUBLIC}/${filename}`;
  } catch (e) {
    console.error("R2 upload error:", e.message);
    return new Response(JSON.stringify({ ok: false, status: 'ERROR', message: 'No se pudo subir el PDF: ' + e.message }), { status: 500, headers: CORS });
  }

  // ── 3) Resolver IDvehiculo, Marca, Modelo desde D1 ─────────────────────
  let idVehiculo = null, marca = null, modelo = null;
  try {
    if (env.DB && bodyJson.Placa) {
      const placa = bodyJson.Placa.toString().trim().toUpperCase();
      const { results } = await env.DB
        .prepare("SELECT IDvehiculo, Marca, Modelo FROM vehiculos WHERE Placa = ? LIMIT 1")
        .bind(placa)
        .all();
      if (results && results.length > 0) {
        idVehiculo = results[0].IDvehiculo || null;
        marca      = results[0].Marca      || null;
        modelo     = results[0].Modelo     || null;
      }
    }
  } catch (e) {
    console.error("D1 vehiculo lookup error:", e.message);
  }

  // ── 4) Determinar fila (reemplazo o nueva) ───────────────────────────────
  let fila = null;
  if (bodyJson.reemplazarPorFactura && env.DB) {
    try {
      const { results } = await env.DB
        .prepare("SELECT fila FROM facturas WHERE NumeroFactura = ? AND Sector = ? LIMIT 1")
        .bind(numeroFactura, sector)
        .all();
      if (results && results.length > 0) fila = results[0].fila;
    } catch (e) { console.error("D1 fila lookup error:", e.message); }
  }

  // Si no hay fila por reemplazo, obtener la siguiente disponible
  if (!fila && env.DB) {
    try {
      const { results } = await env.DB
        .prepare("SELECT MAX(fila) as maxFila FROM facturas")
        .all();
      fila = ((results && results[0] && results[0].maxFila) || 1) + 1;
    } catch (e) {
      fila = Date.now(); // fallback
    }
  }

  const fechaRegistro = new Date().toISOString().slice(0, 10);
  const submissionId  = (bodyJson.submissionId || "").trim() || null;

  // ── 5) Guardar en D1 ────────────────────────────────────────────────────
  const record = {
    fila,
    Sector:           sector || null,
    Placa:            String(bodyJson.Placa            || "").trim() || null,
    Proceso:          String(bodyJson.Proceso          || "").trim() || null,
    Nombre:           String(bodyJson.Nombre           || "").trim() || null,
    Identidad:        String(bodyJson.Identidad        || "").trim() || null,
    TotalGastado:     bodyJson.TotalGastado != null ? Number(bodyJson.TotalGastado) || null : null,
    LitrosConsumidos: String(bodyJson.LitrosConsumidos || "").trim() || null,
    MotivoLlenado:    String(bodyJson.MotivoDelLlenado || "").trim() || null,
    Fecha:            bodyJson.Fecha ? String(bodyJson.Fecha).slice(0, 10) : null,
    HorasViaje:       String(bodyJson.HorasDelViaje   || "").trim() || null,
    KmActual:         String(bodyJson.KmActual        || "").trim() || null,
    NombreComercio:   String(bodyJson.NombreComercio  || "").trim() || null,
    NumeroFactura:    numeroFactura || null,
    FechaRegistro:    fechaRegistro,
    IDvehiculo:       idVehiculo,
    EnlacePDF:        fileUrl,
    Estado:           "Registrada",
    Fondo:            null,
    FechaPago:        null,
    FechaRevision:    null,
    submission_id:    submissionId,
    EstatusF:         null,
    FacturaPrevia:    null,
    ID_PAGO:          null,
    Marca:            marca,
    Modelo:           modelo,
  };

  try {
    await fetch(SYNC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sync-Token": SYNC_SECRET },
      body: JSON.stringify({ rows: [record], truncate: false })
    });
  } catch (e) {
    console.error("D1 sync error:", e.message);
  }

  // ── 6) Responder al formulario ───────────────────────────────────────────
  return new Response(JSON.stringify({
    ok: true,
    status: 'OK',
    accion: bodyJson.reemplazarPorFactura ? 'actualizado' : 'creado',
    rowId: fila,
    fileUrl,
    idVehiculo,
    marca,
    modelo
  }), { status: 200, headers: CORS });
}

async function forwardToAppScript(bodyJson, origin) {
  const CORS = { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' };
  try {
    const resp = await fetch(APPSCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyJson)
    });
    const text = await resp.text();
    return new Response(text, { status: resp.status, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, status: 'ERROR', message: 'No se pudo conectar con Apps Script' }), { status: 502, headers: CORS });
  }
}
