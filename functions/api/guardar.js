export async function onRequestPost(context) {
  try {
    const bodyText = await context.request.text();

    const response = await fetch("https://script.google.com/macros/s/AKfycbz9-0whnU42v7g2OfmoWceewhQ2SYtpttN8d9u_okwXQMOX_HmPRK_07F28Q9m9gLHSiA/exec", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain"
      },
      body: bodyText
    });

    const resultText = await response.text();

    return new Response(resultText, {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      }
    });

  } catch (err) {
    return new Response(JSON.stringify({
      status: "ERROR",
      message: "Proxy error",
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
