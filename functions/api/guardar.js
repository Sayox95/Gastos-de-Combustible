export async function onRequestPost(context) {
  try {
    const contentType = context.request.headers.get("content-type") || "";

    let rawBody;

    if (contentType.includes("application/json") || contentType.includes("text/plain")) {
      rawBody = await context.request.text();
    } else if (contentType.includes("form-data") || contentType.includes("x-www-form-urlencoded")) {
      const formData = await context.request.formData();
      const payload = {};
      for (const [key, value] of formData.entries()) {
        payload[key] = value;
      }
      rawBody = JSON.stringify(payload);
    } else {
      throw new Error("Unsupported Content-Type: " + contentType);
    }

    const response = await fetch("https://script.google.com/macros/s/AKfycbz9-0whnU42v7g2OfmoWceewhQ2SYtpttN8d9u_okwXQMOX_HmPRK_07F28Q9m9gLHSiA/exec", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain"
      },
      body: rawBody
    });

    const resultText = await response.text();

    return new Response(resultText, {
      status: response.status,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      status: "ERROR",
      message: "Worker error",
      detail: err.message
    }), {
      status: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      }
    });
  }
}
