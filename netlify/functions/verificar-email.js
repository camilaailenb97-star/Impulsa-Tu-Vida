exports.handler = async (event) => {
  try {
    const email = (event.queryStringParameters?.email || "")
      .trim()
      .toLowerCase();

    if (!email) {
      return {
        statusCode: 400,
        body: JSON.stringify({ autorizado: false })
      };
    }

    const respuesta = await fetch(
      `https://fxdqlihzxbkrciroomkb.supabase.co/rest/v1/compradores?email=eq.${encodeURIComponent(email)}&select=email`,
      {
        headers: {
          apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    );

    if (!respuesta.ok) {
      throw new Error(await respuesta.text());
    }

    const compradores = await respuesta.json();

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify({
        autorizado: compradores.length > 0
      })
    };
  } catch (error) {
    console.error(error);

    return {
      statusCode: 500,
      body: JSON.stringify({
        autorizado: false,
        error: "No se pudo verificar el acceso"
      })
    };
  }
};
