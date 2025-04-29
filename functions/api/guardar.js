// CORS Preflight handler
export function onRequestOptions(context) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

// POST handler para guardar datos
export async function onRequestPost(context) {
  try {
    const contentType = context.request.headers.get('content-type') || '';
    let rawBody;

    // Soportar JSON o texto plano
    if (contentType.includes('application/json') || contentType.includes('text/plain')) {
      const json = await context.request.json();
      rawBody = new URLSearchParams(json).toString();
    }
    // Soportar form-data o urlencoded
    else if (contentType.includes('form-data') || contentType.includes('x-www-form-urlencoded')) {
      const formData = await context.request.formData();
      const params = new URLSearchParams();
      for (const [key, value] of formData.entries()) {
        params.append(key, value);
      }
      rawBody = params.toString();
    }
    // Content-Type no soportado
    else {
      return new Response(JSON.stringify({
        status: 'ERROR',
        message: 'Unsupported Content-Type',
        detail: contentType
      }), {
        status: 415,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Content-Type': 'application/json'
        }
      });
    }

    // Log de depuración
    console.log('➡️ Enviando datos a App Script...');
    console.log('Contenido:', rawBody);

    // Reenvío a tu App Script
    const response = await fetch(
      'https://script.google.com/macros/s/AKfycbxREud0DKMxyAOL0gTBNMyHCuG52AGzXM-62l4mwcYtXeuprr0H0uO06ETBzifLEebVuA/exec',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: rawBody
      }
    );

    const resultText = await response.text();

    // Log de respuesta del App Script
    console.log('⬅️ Respuesta de App Script recibida:');
    console.log(resultText);

    // Responder al cliente
    return new Response(JSON.stringify({
      status: 'OK',
      appScriptResponse: resultText
    }), {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        'Content-Type': 'application/json'
      }
    });

  } catch (err) {
    console.error('❌ Error en el Worker:', err);

    return new Response(JSON.stringify({
      status: 'ERROR',
      message: 'Cloudflare Worker Exception',
      detail: err.message
    }), {
      status: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json',
        'Vary': 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers'
      }
    });
  }
}
