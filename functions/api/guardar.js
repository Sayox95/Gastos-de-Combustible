export async function onRequestPost(context) {
  try {
    const contentType = context.request.headers.get("content-type") || "";
    let rawBody;

    if (contentType.includes("application/json") || contentType.includes("text/plain")) {
      const json = await context.request.json();
      rawBody = new URLSearchParams(json).toString();
    } else if (contentType.includes("form-data") || contentType.includes("x-www-form-urlencoded")) {
      const formData = await context.request.formData();
      const params = new URLSearchParams();
      for (const [key, value] of formData.entries()) {
        params.append(key, value);
      }
      rawBody = params.toString();
    } else {
      return new Response(JSON.stringify({
        status: "ERROR",
        message: "Unsupported Content-Type",
        detail: contentType
      }), {
        status: 415,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          "Content-Type": "application/json"
        }
      });
    }

    // 🧪 Log antes de hacer fetch
    console.log("➡️ Enviando datos a App Script...");
    console.log("Contenido:", rawBody);

    const response = await fetch("https://script.google.com/macros/s/AKfycbwLjj4Fz22_PnIXc7FZHLE-9sPQ9HeHLsk_RvePK0y-nbpmOR57PWNwYGkHDF2UwAwS1A/exec", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: rawBody
    });

    const resultText = await response.text();

    // 🧪 Log después del fetch
    console.log("⬅️ Respuesta de App Script recibida:");
    console.log(resultText);

    return new Response(JSON.stringify({
      status: "OK",
      appScriptResponse: resultText
    }), {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    console.error("❌ Error en el Worker:", err);

    return new Response(JSON.stringify({
      status: "ERROR",
      message: "Cloudflare Worker Exception",
      detail: err.message
    }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
        "Vary": "Origin, Access-Control-Request-Method, Access-Control-Request-Headers"
      }
    });
  }
}
