const crypto = require("crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Método no permitido" };
  }

  try {
    const hmac = event.headers["x-shopify-hmac-sha256"];
    const hash = crypto
      .createHmac("sha256", process.env.SHOPIFY_CLIENT_SECRET)
      .update(event.body, "utf8")
      .digest("base64");

    if (!hmac || !crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(hmac))) {
      return { statusCode: 401, body: "Firma inválida" };
    }

    const pedido = JSON.parse(event.body || "{}");
    const email = (pedido.email || pedido.contact_email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return { statusCode: 400, body: "Pedido sin email" };
    }

    const respuesta = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/compradores`,
      {
        method: "POST",
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({ email })
      }
    );

    if (!respuesta.ok) {
      const error = await respuesta.text();
      console.error(error);
      return { statusCode: 500, body: "Error guardando comprador" };
    }

    return { statusCode: 200, body: "OK" };
  } catch (error) {
    console.error(error);
    return { statusCode: 500, body: "Error interno" };
  }
};
