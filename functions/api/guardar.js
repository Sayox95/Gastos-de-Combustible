// functions/api/guardar.js (Formulario)
// POST: guarda en AppScript/Sheets y sincroniza la nueva factura en D1

const SYNC_URL    = "https://repositorio-de-pruebas.pages.dev/api/sincronizar";
const SYNC_SECRET = "utcd-facturas-2026-sync-xK9mP";

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
  const bodyText = await request.text();
  let bodyJson = null;
  try { bodyJson = JSON.parse(bodyText); } catch (_) {}

  const upstream =
    env?.APPS_SCRIPT_POST_URL ||
    'https://script.google.com/macros/s/AKfycbxC62s5NqxX-V2IRYL99bMwC3kPcml5OVsX2pumEGaJCVklI5KiVERhWb4mYfZMONMtag/exec';

  // ── 1) Enviar a AppScript ────────────────────────────────────────────────
  let resp;
  try {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 45000);
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
      { status: 502, headers: { 'Access-Control-Allow-Origin': origin, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'Origin' } }
    );
  }

  const text = await resp.text();
  let appJson = null;
  try { appJson = JSON.parse(text); } catch (_) {}

  // ── 2) Si AppScript confirmó guardado, sincronizar a D1 ─────────────────
  // Solo sincronizar cuando es un guardado real (ok:true, status:OK, tiene rowId)
  // Ignorar: validaciones, duplicados, pagos, cambios de estado
  const esGuardadoReal = appJson &&
    appJson.ok === true &&
    appJson.status === "OK" &&
    appJson.rowId &&
    !appJson.alreadySaved &&       // no era idempotente (ya existía)
    !appJson.pago &&               // no era un pago
    bodyJson &&
    bodyJson.NumeroFactura;        // tiene datos de factura (cubre creado y reemplazo)

  if (esGuardadoReal) {
    try {
      const fila     = appJson.rowId;
      const fileUrl  = appJson.fileUrl ?? null;
      const accion   = appJson.accion ?? "creado"; // "creado" o "actualizado"

      const record = {
        fila,
        Sector:           String(bodyJson.Sector           || "").trim() || null,
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
        NumeroFactura:    String(bodyJson.NumeroFactura   || "").trim() || null,
        FechaRegistro:    new Date().toISOString().slice(0, 10),
        IDvehiculo:       String(appJson.idVehiculo || "").trim() || null,
        Marca:            String(appJson.marca  || "").trim() || null,
        Modelo:           String(appJson.modelo || "").trim() || null,
        EnlacePDF:        fileUrl,
        Estado:           "Registrada",
        Fondo:            null,
        FechaPago:        null,
        FechaRevision:    null,
        submission_id:    String(bodyJson.submissionId    || "").trim() || null,
        EstatusF:         null,
        FacturaPrevia:    null,
        ID_PAGO:          null,
      };

      await fetch(SYNC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sync-Token": SYNC_SECRET
        },
        body: JSON.stringify({ rows: [record], truncate: false })
      });

    } catch (e) {
      // Error en D1 no bloquea la respuesta al formulario
      console.error("D1 sync error:", e.message);
    }
  }

  // ── 3) Devolver respuesta original del AppScript al formulario ───────────
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
