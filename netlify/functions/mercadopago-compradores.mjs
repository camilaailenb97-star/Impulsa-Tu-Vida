// =====================================================================
// MERCADO PAGO → SUPABASE (tabla "compradores")
//
// Función PROGRAMADA de Netlify (corre sola cada 10 minutos; no tiene una URL
// pública que alguien pueda llamar). Consulta en la cuenta de Mercado Pago los
// pagos APROBADOS recientes del producto y agrega el email de cada comprador a
// "compradores" para que pueda registrarse en la app.
//
// Seguridad:
//   - No confía en avisos externos: lee los pagos directamente de la API oficial
//     de Mercado Pago con el Access Token de la cuenta (solo lectura).
//   - Solo cuenta pagos con status "approved", de tipo venta ("regular_payment")
//     y cuyo nombre/descripción contiene MP_PRODUCTO_TEXTO.
//   - En Supabase solo AGREGA emails nuevos (ignore-duplicates): nunca modifica
//     ni borra filas existentes.
//
// Variables de entorno (Netlify → Site configuration → Environment variables):
//   MP_ACCESS_TOKEN            Access Token de PRODUCCIÓN de tu aplicación de Mercado Pago
//   SUPABASE_URL               https://fxdqlihzxbkrciroomkb.supabase.co
//   SUPABASE_SERVICE_ROLE_KEY  clave secreta de Supabase (la misma que usa el webhook de Shopify)
//   MP_PRODUCTO_TEXTO          parte del nombre del producto tal como figura en Mercado Pago
//   MP_MODO                    "prueba" (por defecto: no escribe nada, solo informa) o "activo"
//   MP_DIAS                    cuántos días hacia atrás revisar (por defecto 3; usar 365 una vez
//                              para cargar compradores anteriores)
// =====================================================================

const MP_API = "https://api.mercadopago.com";
const TAMANO_PAGINA = 50;
const MAX_PAGOS = 1000; // tope de seguridad por ejecución

export const config = { schedule: "*/10 * * * *" };

// Minúsculas y sin acentos, para comparar nombres de producto.
export function normalizar(texto) {
  return String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

// Oculta parte del email para los registros (logs) de Netlify.
export function ocultarEmail(email) {
  const [usuario, dominio] = String(email).split("@");
  if (!dominio) return "***";
  return usuario.slice(0, 2) + "***@" + dominio.slice(0, 2) + "***";
}

function textoDelProducto(pago) {
  const items = (pago.additional_info && Array.isArray(pago.additional_info.items)) ? pago.additional_info.items : [];
  return [...new Set([pago.description, ...items.map(i => i && i.title)].filter(Boolean))].join(" | ");
}

// Decide si un pago corresponde a una venta aprobada del producto y devuelve el email.
// Devuelve { valido: true, email } o { valido: false, motivo }.
export function evaluarPago(pago, productoTexto) {
  if (!pago || pago.status !== "approved") return { valido: false, motivo: "no aprobado" };
  if (pago.operation_type && pago.operation_type !== "regular_payment") return { valido: false, motivo: "no es una venta (" + pago.operation_type + ")" };
  const nombre = textoDelProducto(pago);
  if (!productoTexto || !normalizar(nombre).includes(normalizar(productoTexto))) return { valido: false, motivo: "otro producto", nombre };
  const email = String((pago.payer && pago.payer.email) || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { valido: false, motivo: "sin email válido", nombre };
  return { valido: true, email, nombre };
}

async function buscarPagos(token, dias) {
  const pagos = [];
  for (let offset = 0; offset < MAX_PAGOS; offset += TAMANO_PAGINA) {
    const params = new URLSearchParams({
      sort: "date_created", criteria: "desc",
      range: "date_created", begin_date: `NOW-${dias}DAYS`, end_date: "NOW",
      limit: String(TAMANO_PAGINA), offset: String(offset),
    });
    const r = await fetch(`${MP_API}/v1/payments/search?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Mercado Pago respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const datos = await r.json();
    const resultados = Array.isArray(datos.results) ? datos.results : [];
    pagos.push(...resultados);
    const total = datos.paging && Number(datos.paging.total);
    if (resultados.length < TAMANO_PAGINA || (total && pagos.length >= total)) break;
  }
  return pagos;
}

async function agregarCompradores(supabaseUrl, clave, emails) {
  const r = await fetch(`${supabaseUrl}/rest/v1/compradores?on_conflict=email`, {
    method: "POST",
    headers: {
      apikey: clave,
      Authorization: `Bearer ${clave}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=representation", // solo agrega; nunca modifica existentes
    },
    body: JSON.stringify(emails.map(email => ({ email }))),
  });
  if (!r.ok) throw new Error(`Supabase respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const insertadas = await r.json().catch(() => []);
  return Array.isArray(insertadas) ? insertadas.length : 0;
}

export async function sincronizar(env) {
  const token = env.MP_ACCESS_TOKEN;
  const supabaseUrl = (env.SUPABASE_URL || "").replace(/\/+$/, "");
  const clave = env.SUPABASE_SERVICE_ROLE_KEY;
  const productoTexto = (env.MP_PRODUCTO_TEXTO || "").trim();
  const modo = env.MP_MODO === "activo" ? "activo" : "prueba";
  const dias = Math.min(Math.max(parseInt(env.MP_DIAS || "3", 10) || 3, 1), 365);

  const faltan = ["MP_ACCESS_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].filter(k => !env[k]);
  if (faltan.length) return { ok: false, error: "Faltan variables de entorno: " + faltan.join(", ") };
  if (modo === "activo" && !productoTexto) return { ok: false, error: "MP_MODO=activo requiere MP_PRODUCTO_TEXTO (si no, se agregarían compradores de cualquier pago)" };

  const pagos = await buscarPagos(token, dias);
  const emails = new Set();
  const motivos = {};
  const nombresVistos = {}; // nombres de productos aprobados (sirve para ajustar MP_PRODUCTO_TEXTO)
  const diagnostico = {}; // por producto aprobado: datos para confirmar que es la venta correcta (sin datos sensibles)
  for (const pago of pagos) {
    if (pago.status === "approved") {
      const n = textoDelProducto(pago) || "(sin nombre)";
      nombresVistos[n] = (nombresVistos[n] || 0) + 1;
      const d = diagnostico[n] || (diagnostico[n] = { ventas: 0, montoMin: null, montoMax: null, monedas: {}, tiposOperacion: {}, fechas: [], conEmailValido: 0, emailsOcultos: [], emailEnOtrosCampos: 0 });
      d.ventas++;
      const monto = Number(pago.transaction_amount);
      if (!isNaN(monto)) { d.montoMin = d.montoMin === null ? monto : Math.min(d.montoMin, monto); d.montoMax = d.montoMax === null ? monto : Math.max(d.montoMax, monto); }
      d.monedas[pago.currency_id || "?"] = (d.monedas[pago.currency_id || "?"] || 0) + 1;
      d.tiposOperacion[pago.operation_type || "?"] = (d.tiposOperacion[pago.operation_type || "?"] || 0) + 1;
      if (d.fechas.length < 5) d.fechas.push(String(pago.date_approved || pago.date_created || "").slice(0, 16));
      const email = String((pago.payer && pago.payer.email) || "").trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { d.conEmailValido++; if (d.emailsOcultos.length < 5) d.emailsOcultos.push(ocultarEmail(email)); }
      const otro = pago.additional_info && pago.additional_info.payer && pago.additional_info.payer.email;
      if (otro || (pago.metadata && Object.keys(pago.metadata).some(k => /mail/i.test(k)))) d.emailEnOtrosCampos++;
    }
    const ev = evaluarPago(pago, productoTexto);
    if (ev.valido) emails.add(ev.email);
    else motivos[ev.motivo] = (motivos[ev.motivo] || 0) + 1;
  }

  const lista = [...emails];
  let agregados = 0;
  if (modo === "activo" && lista.length) agregados = await agregarCompradores(supabaseUrl, clave, lista);

  return {
    ok: true, modo, dias, productoTexto: productoTexto || "(sin configurar)",
    pagosRevisados: pagos.length,
    compradoresValidos: lista.length,
    emailsOcultos: lista.map(ocultarEmail),
    agregadosNuevos: modo === "activo" ? agregados : "0 (modo prueba: no se escribió nada)",
    descartados: motivos,
    nombresDeProductosAprobados: nombresVistos,
    diagnosticoPorProducto: diagnostico,
  };
}

export default async () => {
  try {
    const resultado = await sincronizar(process.env);
    const { diagnosticoPorProducto, ...resumen } = resultado;
    console.log("[mercadopago-compradores]", JSON.stringify(resumen));
    if (diagnosticoPorProducto) {
      for (const [producto, datos] of Object.entries(diagnosticoPorProducto)) {
        console.log("[mercadopago-compradores][diagnostico]", JSON.stringify({ producto, ...datos }));
      }
    }
    return new Response(JSON.stringify({ ok: resultado.ok }), { status: resultado.ok ? 200 : 500 });
  } catch (error) {
    console.error("[mercadopago-compradores] Error:", error.message);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
};
