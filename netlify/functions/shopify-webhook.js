const crypto = require("crypto");

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Metodo no permitido",
    };
  }

  try {
    const shopifySecret = process.env.SHOPIFY_CLIENT_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!shopifySecret || !supabaseUrl || !supabaseKey) {
      console.error("Faltan variables de entorno");
      return {
        statusCode: 500,
        body: "Configuracion incompleta",
      };
    }

    // Verificar que realmente venga de Shopify
    const hmacHeader =
      event.headers["x-shopify-hmac-sha256"] ||
      event.headers["X-Shopify-Hmac-Sha256"];

    const calculatedHmac = crypto
      .createHmac("sha256", shopifySecret)
      .update(event.body, "utf8")
      .digest("base64");

    if (
      !hmacHeader ||
      hmacHeader.length !== calculatedHmac.length ||
      !crypto.timingSafeEqual(
        Buffer.from(hmacHeader),
        Buffer.from(calculatedHmac)
      )
    ) {
      console.error("Firma de Shopify invalida");
      return {
        statusCode: 401,
        body: "Firma invalida",
      };
    }

    const order = JSON.parse(event.body || "{}");

    const email = String(
      order.email ||
      order.contact_email ||
      order.customer?.email ||
      ""
    )
      .trim()
      .toLowerCase();

    if (!email) {
      console.error("El pedido no contiene email");
      return {
        statusCode: 400,
        body: "Pedido sin email",
      };
    }

    console.log("Procesando comprador:", email);

    const response = await fetch(
      `${supabaseUrl}/rest/v1/compradores?on_conflict=email`,
      {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({ email }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Error de Supabase:", response.status, errorText);

      return {
        statusCode: 500,
        body: "Error guardando comprador",
      };
    }

    console.log("Comprador autorizado correctamente:", email);

    return {
      statusCode: 200,
      body: "OK",
    };
  } catch (error) {
    console.error("Error del webhook:", error);

    return {
      statusCode: 500,
      body: "Error interno",
    };
  }
};
