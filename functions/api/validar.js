// functions/api/validar.js
// Valida formato y duplicados de factura consultando D1.
// Una factura duplicada solo puede reemplazarse mientras su Estado efectivo sea "Registrada".

const APPSCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbz0yqZOeSxZohrbiWtlizFpbvryrnqi38_70xvdvKD2YSNTGGdlc7pqrlDIZs8aIuJp_A/exec';

const CORS = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'Vary': 'Origin'
});

function cleanValue(value) {
  const text = String(value ?? '').trim();
  if (!text || /^<null>$/i.test(text) || /^null$/i.test(text)) return '';
  return text;
}

function estadoCanonico(value) {
  const raw = cleanValue(value);
  if (!raw) return '';
  switch (raw.toUpperCase()) {
    case 'REGISTRADA': return 'Registrada';
    case 'REVISADA': return 'Revisada';
    case 'ENVIADA': return 'Enviada';
    case 'PAGADA':
    case 'PAGADO': return 'Pagada';
    case 'ANULADA':
    case 'ANULADO': return 'Anulada';
    default: return raw;
  }
}

function estadoProcesadoDesdeEstatusF(row) {
  const value = estadoCanonico(row?.estatusF ?? row?.EstatusF);
  const known = ['Registrada', 'Revisada', 'Enviada', 'Pagada', 'Anulada'];
  return known.includes(value) ? value : '';
}

function resolverEstado(row) {
  if (!row) return 'Sin estado';

  const estadoBase = estadoCanonico(row.estado ?? row.Estado);
  const estatusF = estadoProcesadoDesdeEstatusF(row);
  const tienePago = !!cleanValue(row.idPago ?? row.ID_PAGO) || !!cleanValue(row.fechaPago ?? row.FechaPago);
  const tieneRevision = !!cleanValue(row.fechaRevision ?? row.FechaRevision);

  // Fail-safe: si la fila dice Registrada pero ya tiene evidencia administrativa
  // posterior, mostramos el estado más avanzado y nunca habilitamos reemplazo.
  if (estadoBase === 'Registrada') {
    if (tienePago || estatusF === 'Pagada') return 'Pagada';
    if (estatusF === 'Enviada') return 'Enviada';
    if (estatusF === 'Revisada' || tieneRevision) return 'Revisada';
    if (estatusF === 'Anulada') return 'Anulada';
    return 'Registrada';
  }

  if (estadoBase) return estadoBase;
  if (tienePago) return 'Pagada';
  if (estatusF) return estatusF;
  if (tieneRevision) return 'Revisada';
  return 'Sin estado';
}

function esReemplazable(row) {
  // Para autorizar no basta con un estado inferido: la columna Estado debe decir
  // explícitamente Registrada y no debe existir evidencia de procesamiento posterior.
  const estadoBase = estadoCanonico(row?.estado ?? row?.Estado);
  return estadoBase === 'Registrada' && resolverEstado(row) === 'Registrada';
}

export async function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin') || '*';
  return new Response(null, { status: 204, headers: CORS(origin) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '*';
  let bodyJson = null;
  try { bodyJson = JSON.parse(await request.text()); } catch (_) {}

  const numeroFactura = (bodyJson?.NumeroFactura || '').toString().trim();
  const sector        = (bodyJson?.Sector        || '').toString().trim();

  // La validación del frontend no es una barrera de seguridad.
  if (!/^\d{3}-\d{3}-\d{2}-\d{8}$/.test(numeroFactura)) {
    return new Response(JSON.stringify({
      ok: false,
      status: 'ERROR',
      code: 'FACTURA_FORMATO_INVALIDO',
      message: 'El número de factura debe contener exactamente 16 dígitos en formato 000-000-00-00000000'
    }), { status: 400, headers: CORS(origin) });
  }

  // Si D1 no está disponible, el respaldo puede confirmar duplicidad, pero no
  // autorizar reemplazos porque no puede garantizar el Estado actual.
  if (!env.DB) {
    return fallbackAppScript(bodyJson, origin);
  }

  try {
    const selectCols = `
      SELECT
        fila,
        Estado AS estado,
        EstatusF AS estatusF,
        FechaPago AS fechaPago,
        FechaRevision AS fechaRevision,
        ID_PAGO AS idPago
      FROM facturas
    `;

    let results;
    if (sector) {
      ({ results } = await env.DB
        .prepare(selectCols + ' WHERE NumeroFactura = ? AND Sector = ? LIMIT 1')
        .bind(numeroFactura, sector)
        .all());
    } else {
      ({ results } = await env.DB
        .prepare(selectCols + ' WHERE NumeroFactura = ? LIMIT 1')
        .bind(numeroFactura)
        .all());
    }

    const row = results && results.length > 0 ? results[0] : null;
    const duplicado = !!row;
    const estado = duplicado ? resolverEstado(row) : null;
    const reemplazable = duplicado ? esReemplazable(row) : false;

    return new Response(JSON.stringify({
      ok: true,
      status: 'OK',
      duplicado,
      estado,
      reemplazable,
      row: duplicado ? row.fila : null
    }), { status: 200, headers: CORS(origin) });

  } catch (e) {
    console.error('D1 validar error:', e.message);
    return fallbackAppScript(bodyJson, origin);
  }
}

async function fallbackAppScript(bodyJson, origin) {
  const headers = CORS(origin);
  try {
    const resp = await fetch(APPSCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyJson)
    });
    const text = await resp.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) {}

    // Fail closed: si el respaldo detecta duplicado, nunca afirmamos que sea
    // reemplazable sin conocer el Estado desde D1.
    if (parsed && parsed.duplicado === true) {
      parsed.reemplazable = false;
      parsed.estado = parsed.estado || 'No disponible';
      parsed.message = parsed.message || 'La factura ya existe, pero no se pudo verificar su estado. No se permite reemplazarla en este momento.';
    }

    return new Response(JSON.stringify(parsed || { status: 'ERROR', message: 'No se pudo validar' }), {
      status: resp.status,
      headers
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ status: 'ERROR', message: 'No se pudo validar' }),
      { status: 502, headers }
    );
  }
}
