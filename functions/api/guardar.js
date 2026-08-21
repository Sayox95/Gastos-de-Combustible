// functions/api/guardar.js (Formulario)
// Flujo: validar → proteger reemplazo por Estado → PDF en R2 → datos en D1.
// Solo las facturas en Estado "Registrada" pueden ser reemplazadas.

const R2_PUBLIC = 'https://pub-9a4726fe82ba459fa6542b01ec3b1f4f.r2.dev';

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

  // Fail-safe: si Estado dice Registrada pero ya existe evidencia de una etapa
  // posterior, prevalece el estado más avanzado y el reemplazo queda bloqueado.
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
  // Para autorizar, la columna Estado debe decir explícitamente Registrada y
  // no debe existir evidencia de revisión, envío, pago o anulación.
  const estadoBase = estadoCanonico(row?.estado ?? row?.Estado);
  return estadoBase === 'Registrada' && resolverEstado(row) === 'Registrada';
}

function jsonResponse(payload, status, headers) {
  return new Response(JSON.stringify(payload), { status, headers });
}

function safeToken(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 64);
}

function buildReplacementFilename(filename, submissionId) {
  const dot = filename.toLowerCase().endsWith('.pdf') ? filename.slice(0, -4) : filename;
  const token = safeToken(submissionId) || safeToken(typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now());
  return `${dot}_reemplazo_${token}.pdf`;
}

function publicKeyFromUrl(url) {
  const prefix = `${R2_PUBLIC}/`;
  const value = String(url || '');
  return value.startsWith(prefix) ? value.slice(prefix.length) : null;
}

async function safeDeleteR2(bucket, key) {
  if (!bucket || !key) return;
  try { await bucket.delete(key); } catch (e) { console.error('R2 cleanup error:', e.message); }
}

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
  const CORS = {
    'Access-Control-Allow-Origin': origin,
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Vary': 'Origin'
  };

  let bodyJson = null;
  try { bodyJson = JSON.parse(await request.text()); } catch (_) {}

  if (!bodyJson) {
    return jsonResponse({ ok: false, status: 'ERROR', message: 'Payload inválido' }, 400, CORS);
  }

  const numeroFactura = String(bodyJson.NumeroFactura || '').trim();
  const sector        = String(bodyJson.Sector || '').trim();
  const pdfBase64     = bodyJson.pdf;
  const filename      = String(bodyJson.filename || `${sector}_${numeroFactura}.pdf`).replace(/\s+/g, '_');
  const reemplazar    = bodyJson.reemplazarPorFactura === true;
  const submissionId  = String(bodyJson.submissionId || '').trim() || null;

  if (!numeroFactura || !pdfBase64) {
    return jsonResponse({ ok: false, status: 'ERROR', message: 'Faltan datos requeridos' }, 400, CORS);
  }

  if (!/^\d{3}-\d{3}-\d{2}-\d{8}$/.test(numeroFactura)) {
    return jsonResponse({
      ok: false,
      status: 'ERROR',
      code: 'FACTURA_FORMATO_INVALIDO',
      message: 'El número de factura debe contener exactamente 16 dígitos en formato 000-000-00-00000000'
    }, 400, CORS);
  }

  // No tocar R2 si la base no está disponible: sin D1 no podemos proteger Estado.
  if (!env.DB) {
    return jsonResponse({
      ok: false,
      status: 'ERROR',
      code: 'DB_NO_DISPONIBLE',
      message: 'No se puede guardar el reporte porque la base de datos no está disponible.'
    }, 503, CORS);
  }

  // ── 1) Leer una sola vez la factura existente y su Estado ──────────────
  let existente = null;
  try {
    const { results } = await env.DB
      .prepare(`
        SELECT
          fila, EnlacePDF,
          Estado AS estado,
          EstatusF AS estatusF,
          FechaPago AS fechaPago,
          FechaRevision AS fechaRevision,
          ID_PAGO AS idPago
        FROM facturas
        WHERE NumeroFactura = ? AND Sector = ?
        LIMIT 1
      `)
      .bind(numeroFactura, sector)
      .all();
    existente = results && results.length > 0 ? results[0] : null;
  } catch (e) {
    console.error('D1 duplicado/estado check error:', e.message);
    return jsonResponse({
      ok: false,
      status: 'ERROR',
      code: 'DB_VALIDACION_ERROR',
      message: 'No se pudo verificar el estado actual de la factura. Inténtelo nuevamente.'
    }, 503, CORS);
  }

  if (!reemplazar && existente) {
    const estado = resolverEstado(existente);
    return jsonResponse({
      ok: false,
      status: 'ERROR',
      code: 'FACTURA_DUP',
      row: existente.fila,
      estado,
      reemplazable: esReemplazable(existente),
      message: esReemplazable(existente)
        ? `La factura ya existe en estado ${estado}. Confirme el reemplazo en el formulario.`
        : `La factura ya existe en estado ${estado} y no puede ser reemplazada.`
    }, 409, CORS);
  }

  if (reemplazar) {
    if (!existente) {
      return jsonResponse({
        ok: false,
        status: 'ERROR',
        code: 'FACTURA_REEMPLAZO_NO_ENCONTRADA',
        message: 'No se encontró la factura original que se intentó reemplazar. Valide nuevamente antes de continuar.'
      }, 409, CORS);
    }

    if (!esReemplazable(existente)) {
      const estado = resolverEstado(existente);
      return jsonResponse({
        ok: false,
        status: 'ERROR',
        code: 'FACTURA_REEMPLAZO_BLOQUEADO',
        row: existente.fila,
        estado,
        reemplazable: false,
        message: `La factura se encuentra en estado ${estado} y no puede ser reemplazada. Solo las facturas en estado Registrada pueden reemplazarse.`
      }, 409, CORS);
    }
  }

  // ── 2) Resolver IDvehiculo, Marca, Modelo antes de escribir ────────────
  let idVehiculo = null, marca = null, modelo = null;
  try {
    if (bodyJson.Placa) {
      const placa = String(bodyJson.Placa).trim().toUpperCase();
      const { results } = await env.DB
        .prepare('SELECT IDvehiculo, Marca, Modelo FROM vehiculos WHERE Placa = ? LIMIT 1')
        .bind(placa)
        .all();
      if (results && results.length > 0) {
        idVehiculo = results[0].IDvehiculo || null;
        marca      = results[0].Marca      || null;
        modelo     = results[0].Modelo     || null;
      }
    }
  } catch (e) {
    console.error('D1 vehiculo lookup error:', e.message);
  }

  // ── 3) Preparar fila / archivo ─────────────────────────────────────────
  let fila = reemplazar ? existente.fila : null;
  if (!fila) {
    try {
      const { results } = await env.DB.prepare('SELECT MAX(fila) as maxFila FROM facturas').all();
      fila = ((results && results[0] && results[0].maxFila) || 1) + 1;
    } catch (e) {
      console.error('D1 fila lookup error:', e.message);
      return jsonResponse({
        ok: false,
        status: 'ERROR',
        code: 'DB_FILA_ERROR',
        message: 'No se pudo preparar el registro en la base de datos.'
      }, 500, CORS);
    }
  }

  // En reemplazos usamos una clave nueva para no sobrescribir el PDF vigente
  // antes de confirmar nuevamente que el Estado sigue siendo "Registrada".
  const storageFilename = reemplazar ? buildReplacementFilename(filename, submissionId) : filename;

  let fileUrl = null;
  try {
    if (!env.PDF_BUCKET) throw new Error('PDF_BUCKET binding no configurado');
    const pdfBytes = Uint8Array.from(atob(pdfBase64), c => c.charCodeAt(0));
    await env.PDF_BUCKET.put(storageFilename, pdfBytes, {
      httpMetadata: { contentType: 'application/pdf' }
    });
    fileUrl = `${R2_PUBLIC}/${storageFilename}`;
  } catch (e) {
    console.error('R2 upload error:', e.message);
    return jsonResponse({ ok: false, status: 'ERROR', message: 'No se pudo subir el PDF: ' + e.message }, 500, CORS);
  }

  const fechaRegistro = new Date().toISOString().slice(0, 10);

  // ── 4) Guardar / actualizar en D1 ─────────────────────────────────────
  try {
    if (reemplazar) {
      // UPDATE preserva Estado, FechaPago, FechaRevision, ID_PAGO, Fondo,
      // EstatusF y cualquier dato administrativo. La condición de Estado evita
      // que una factura procesada sea modificada aunque cambie entre validación y guardado.
      const result = await env.DB.prepare(`
        UPDATE facturas SET
          Sector = ?, Placa = ?, Proceso = ?, Nombre = ?, Identidad = ?,
          TotalGastado = ?, LitrosConsumidos = ?, MotivoLlenado = ?, Fecha = ?,
          HorasViaje = ?, KmActual = ?, NombreComercio = ?, NumeroFactura = ?,
          FechaRegistro = ?, IDvehiculo = ?, EnlacePDF = ?, submission_id = ?,
          Marca = ?, Modelo = ?
        WHERE fila = ?
          AND UPPER(TRIM(COALESCE(Estado, ''))) = 'REGISTRADA'
          AND TRIM(COALESCE(CAST(ID_PAGO AS TEXT), '')) = ''
          AND TRIM(COALESCE(CAST(FechaPago AS TEXT), '')) = ''
          AND UPPER(TRIM(COALESCE(EstatusF, ''))) NOT IN ('REVISADA','ENVIADA','PAGADA','PAGADO','ANULADA','ANULADO')
          AND TRIM(COALESCE(CAST(FechaRevision AS TEXT), '')) = ''
      `).bind(
        sector || null,
        String(bodyJson.Placa            || '').trim() || null,
        String(bodyJson.Proceso          || '').trim() || null,
        String(bodyJson.Nombre           || '').trim() || null,
        String(bodyJson.Identidad        || '').trim() || null,
        bodyJson.TotalGastado != null ? Number(bodyJson.TotalGastado) || null : null,
        String(bodyJson.LitrosConsumidos || '').trim() || null,
        String(bodyJson.MotivoDelLlenado || '').trim() || null,
        bodyJson.Fecha ? String(bodyJson.Fecha).slice(0, 10) : null,
        String(bodyJson.HorasDelViaje    || '').trim() || null,
        String(bodyJson.KmActual         || '').trim() || null,
        String(bodyJson.NombreComercio   || '').trim() || null,
        numeroFactura,
        fechaRegistro,
        idVehiculo,
        fileUrl,
        submissionId,
        marca,
        modelo,
        fila
      ).run();

      const changes = Number(result?.meta?.changes ?? result?.changes ?? 0);
      if (changes < 1) {
        // El Estado pudo cambiar mientras se generaba/subía el PDF. El nuevo
        // archivo se elimina y el registro original queda intacto.
        await safeDeleteR2(env.PDF_BUCKET, storageFilename);

        let estadoActual = 'No disponible';
        try {
          const { results } = await env.DB
            .prepare(`
              SELECT
                Estado AS estado,
                EstatusF AS estatusF,
                FechaPago AS fechaPago,
                FechaRevision AS fechaRevision,
                ID_PAGO AS idPago
              FROM facturas
              WHERE fila = ?
              LIMIT 1
            `)
            .bind(fila)
            .all();
          if (results && results.length > 0) estadoActual = resolverEstado(results[0]);
        } catch (_) {}

        return jsonResponse({
          ok: false,
          status: 'ERROR',
          code: 'FACTURA_REEMPLAZO_BLOQUEADO',
          row: fila,
          estado: estadoActual,
          reemplazable: false,
          message: `La factura se encuentra en estado ${estadoActual} y no puede ser reemplazada. Solo las facturas en estado Registrada pueden reemplazarse.`
        }, 409, CORS);
      }

      // El UPDATE ya apunta al nuevo PDF. Limpiamos el anterior si pertenece a este R2.
      const oldKey = publicKeyFromUrl(existente.EnlacePDF);
      if (oldKey && oldKey !== storageFilename) {
        await safeDeleteR2(env.PDF_BUCKET, oldKey);
      }
    } else {
      await env.DB.prepare(`
        INSERT INTO facturas (
          fila, Sector, Placa, Proceso, Nombre, Identidad,
          TotalGastado, LitrosConsumidos, MotivoLlenado, Fecha,
          HorasViaje, KmActual, NombreComercio, NumeroFactura,
          FechaRegistro, IDvehiculo, EnlacePDF, Estado, Fondo,
          FechaPago, FechaRevision, submission_id, EstatusF,
          FacturaPrevia, ID_PAGO, Marca, Modelo
        ) VALUES (
          ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?
        )
      `).bind(
        fila,
        sector || null,
        String(bodyJson.Placa            || '').trim() || null,
        String(bodyJson.Proceso          || '').trim() || null,
        String(bodyJson.Nombre           || '').trim() || null,
        String(bodyJson.Identidad        || '').trim() || null,
        bodyJson.TotalGastado != null ? Number(bodyJson.TotalGastado) || null : null,
        String(bodyJson.LitrosConsumidos || '').trim() || null,
        String(bodyJson.MotivoDelLlenado || '').trim() || null,
        bodyJson.Fecha ? String(bodyJson.Fecha).slice(0, 10) : null,
        String(bodyJson.HorasDelViaje    || '').trim() || null,
        String(bodyJson.KmActual         || '').trim() || null,
        String(bodyJson.NombreComercio   || '').trim() || null,
        numeroFactura,
        fechaRegistro,
        idVehiculo,
        fileUrl,
        'Registrada',
        null,
        null,
        null,
        submissionId,
        null,
        null,
        null,
        marca,
        modelo
      ).run();
    }
  } catch (e) {
    console.error('D1 save error:', e.message);
    await safeDeleteR2(env.PDF_BUCKET, storageFilename);
    return jsonResponse({ ok: false, status: 'ERROR', message: 'No se pudo guardar en D1: ' + e.message }, 500, CORS);
  }

  // ── 5) Responder al formulario ─────────────────────────────────────────
  return jsonResponse({
    ok: true,
    status: 'OK',
    accion: reemplazar ? 'actualizado' : 'creado',
    rowId: fila,
    fileUrl,
    idVehiculo,
    marca,
    modelo
  }, 200, CORS);
}
