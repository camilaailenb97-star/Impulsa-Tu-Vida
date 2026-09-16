exports.handler = async (event) => {
  const email = (event.queryStringParameters?.email || "").trim().toLowerCase();

  const emailsPermitidos = [
    "camila.ailen.b97@gmail.com"
  ].map(e => e.toLowerCase());

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify({
      autorizado: emailsPermitidos.includes(email)
    })
  };
};
