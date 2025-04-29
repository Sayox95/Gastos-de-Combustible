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
      throw new Error("Unsupported Content-Type: " + contentType);
    }

    const response = await fetch("https://script.google.com/macros/s/AKfycbz9-0whnU42v7g2OfmoWceewhQ2SYtpttN8d9u_okwXQMOX_HmPRK_07F28Q9m9gLHSiA/exec", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
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
