// functions/api/guardar.js

/**
 * Responde al preflight OPTIONS para habilitar CORS
 */
export async function onRequestOptions({ request }) {
  return new Response(null, {
    status: 204,
    headers: {
      // Permite que cualquier origen llame a esta función
      'Access-Control-Allow-Origin': '*',
      // Métodos permitidos
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      // Cabeceras permitidas en la petición
      'Access-Control-Allow-Headers': 'Content-Type',
      // Permite enviar credenciales (por si usas cookies; opcional)
      'Access-Control-Allow-Credentials': 'true'
    }
  });
}

/**
 * Maneja las peticiones POST reenviándolas a tu Apps Script
 */
export async function onRequestPost({ request }) {
  // Leemos el cuerpo como texto (JSON serializado por el front)
  const bodyText = await request.text();

  // Reenviamos al endpoint de Apps Script
  const resp = await fetch(
    "https://script.google.com/macros/s/AKfycbxhGh19qtJ6makKRjiSdX4On2ywBrs93U_XgudH100cIK0TvS9yO_oNcarmQtAhKMbhuw/exec",
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: bodyText
    }
  );

  // Capturamos la respuesta (texto o JSON)
  const resultText = await resp.text();

  // Respondemos al cliente con los mismos datos y CORS habilitado
  return new Response(resultText, {
    status: resp.status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': 'true',
      'Content-Type': 'application/json'
    }
  });
}
