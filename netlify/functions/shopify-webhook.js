exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Método no permitido" };
  }

  try {
    const pedido = JSON.parse(event.body || "{}");
    const email = (pedido.email || pedido.contact_email || "").trim().toLowerCase();

    if (!email) {
      return { statusCode: 400, body: "Pedido sin email" };
    }

    console.log("COMPRA_PAGADA:", email);

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };
  } catch (error) {
    return {
      statusCode: 400,
      body: "Error procesando pedido"
    };
  }
};
