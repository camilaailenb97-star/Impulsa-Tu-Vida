// Edge Function de Supabase: Mercado Pago → tabla "compradores".
// La llama pg_cron cada 10 minutos (ver supabase/programar-compradores.sql).
// Solo responde si recibe el encabezado x-cron-secret con el valor de CRON_SECRET.
import { sincronizar } from "./logica.mjs";

const MAX_VENTAS_EN_REGISTRO = 20;

// Compara dos textos sin revelar por el tiempo de respuesta cuánto coinciden.
async function iguales(a: string, b: string): Promise<boolean> {
  const hash = async (t: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  const [x, y] = await Promise.all([hash(a), hash(b)]);
  let diferencia = 0;
  for (let i = 0; i < x.length; i++) diferencia |= x[i] ^ y[i];
  return diferencia === 0;
}

Deno.serve(async (req) => {
  const secreto = Deno.env.get("CRON_SECRET") || "";
  if (!secreto || !(await iguales(secreto, req.headers.get("x-cron-secret") || ""))) {
    return new Response(JSON.stringify({ ok: false, error: "no autorizado" }), { status: 401, headers: { "Content-Type": "application/json" } });
  }
  const env = Object.fromEntries(
    ["MP_ACCESS_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MP_PRODUCTO_TEXTO", "MP_MODO", "MP_DIAS"]
      .map(k => [k, Deno.env.get(k) || ""]),
  );
  try {
    const resultado = await sincronizar(env);
    const { diagnosticoPorProducto, ventas, ...resumen } = resultado;
    console.log("[mercadopago-compradores]", JSON.stringify(resumen));
    for (const venta of (ventas || []).slice(0, MAX_VENTAS_EN_REGISTRO)) {
      console.log("[mercadopago-compradores][venta]", JSON.stringify(venta));
    }
    // La respuesta solo incluye datos ocultos (sin emails completos ni claves).
    return new Response(JSON.stringify({ ...resumen, diagnosticoPorProducto, ventas: (ventas || []).slice(0, MAX_VENTAS_EN_REGISTRO) }), {
      status: resultado.ok ? 200 : 500, headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[mercadopago-compradores] Error:", (error as Error).message);
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});
