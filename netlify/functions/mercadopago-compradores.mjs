// =====================================================================
// MERCADO PAGO → SUPABASE (tabla "compradores")
//
// Función PROGRAMADA de Netlify (corre sola cada 10 minutos; no tiene una URL
// pública que alguien pueda llamar). Consulta en la cuenta de Mercado Pago los
// pagos APROBADOS recientes del producto y agrega a "compradores" el email que el
// cliente ingresó en Impul Tienda, para que pueda registrarse en la app.
//
// De dónde sale el email:
//   Impul Tienda crea en tu cuenta una "preferencia de pago" por cada compra, con
//   el email del checkout en preferencia.payer.email. La función lo busca así:
//   pago → orden (merchant_order) → preferencia. NO usa el email de quien paga
//   (pago.payer.email), porque puede pagar otra persona. Si la preferencia no se
//   puede leer o no trae un email válido, esa venta NO se autoriza y se informa
//   en los registros para resolverla a mano.
//
// Seguridad:
//   - No confía en avisos externos: lee los pagos directamente de la API oficial
//     de Mercado Pago con el Access Token de la cuenta (solo lectura).
//   - Solo cuenta pagos con status "approved", de tipo venta ("regular_payment")
//     y cuyo nombre/descripción contiene MP_PRODUCTO_TEXTO. Recién entonces busca
//     el email de la compra.
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
const CONSULTAS_EN_PARALELO = 5;
const TIEMPO_MAXIMO_MS = 20000; // Netlify corta las funciones programadas a los 30 s
const MAX_VENTAS_EN_REGISTRO = 20;

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

export function limpiarEmail(email) {
  const e = String(email || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) ? e : "";
}

function textoDelProducto(pago) {
  const items = (pago.additional_info && Array.isArray(pago.additional_info.items)) ? pago.additional_info.items : [];
  return [...new Set([pago.description, ...items.map(i => i && i.title)].filter(Boolean))].join(" | ");
}

// Decide si un pago es una venta aprobada del producto (todavía sin mirar el email).
// Devuelve { valido: true, nombre } o { valido: false, motivo }.
export function evaluarPago(pago, productoTexto) {
  if (!pago || pago.status !== "approved") return { valido: false, motivo: "no aprobado" };
  if (pago.operation_type && pago.operation_type !== "regular_payment") return { valido: false, motivo: "no es una venta (" + pago.operation_type + ")" };
  const nombre = textoDelProducto(pago);
  if (!productoTexto || !normalizar(nombre).includes(normalizar(productoTexto))) return { valido: false, motivo: "otro producto", nombre };
  return { valido: true, nombre };
}

async function leerMP(token, ruta) {
  const r = await fetch(`${MP_API}${ruta}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return { error: r.status };
  return { datos: await r.json() };
}

// Email que el cliente ingresó en Impul Tienda: pago → orden → preferencia.payer.email.
// Devuelve { email } o { motivo }.
export async function emailDeLaCompra(token, pago) {
  const ordenId = pago.order && pago.order.id;
  if (!ordenId) return { motivo: "sin orden en Mercado Pago" };
  const orden = await leerMP(token, `/merchant_orders/${encodeURIComponent(ordenId)}`);
  if (orden.error) return { motivo: `no se pudo leer la orden (${orden.error})` };
  const pagosDeLaOrden = Array.isArray(orden.datos.payments) ? orden.datos.payments : null;
  if (pagosDeLaOrden && !pagosDeLaOrden.some(p => p && String(p.id) === String(pago.id))) return { motivo: "la orden no contiene este pago" };
  const preferenciaId = orden.datos.preference_id;
  if (!preferenciaId) return { motivo: "orden sin preferencia" };
  const pref = await leerMP(token, `/checkout/preferences/${encodeURIComponent(preferenciaId)}`);
  if (pref.error) return { motivo: `no se pudo leer la preferencia (${pref.error})` };
  const email = limpiarEmail(pref.datos.payer && pref.datos.payer.email);
  if (!email) return { motivo: "preferencia sin email válido" };
  return { email };
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

export async function sincronizar(env, ahora = () => Date.now()) {
  const inicio = ahora();
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
  const motivos = {};
  const contar = m => { motivos[m] = (motivos[m] || 0) + 1; };
  const nombresVistos = {}; // nombres de productos aprobados (sirve para ajustar MP_PRODUCTO_TEXTO)
  const diagnostico = {}; // por producto aprobado: datos para confirmar que es la venta correcta (sin datos sensibles)
  const ventas = [];
  for (const pago of pagos) {
    if (pago.status === "approved") {
      const n = textoDelProducto(pago) || "(sin nombre)";
      nombresVistos[n] = (nombresVistos[n] || 0) + 1;
      const d = diagnostico[n] || (diagnostico[n] = { ventas: 0, montoMin: null, montoMax: null, monedas: {}, tiposOperacion: {}, fechas: [] });
      d.ventas++;
      const monto = Number(pago.transaction_amount);
      if (!isNaN(monto)) { d.montoMin = d.montoMin === null ? monto : Math.min(d.montoMin, monto); d.montoMax = d.montoMax === null ? monto : Math.max(d.montoMax, monto); }
      d.monedas[pago.currency_id || "?"] = (d.monedas[pago.currency_id || "?"] || 0) + 1;
      d.tiposOperacion[pago.operation_type || "?"] = (d.tiposOperacion[pago.operation_type || "?"] || 0) + 1;
      if (d.fechas.length < 5) d.fechas.push(String(pago.date_approved || pago.date_created || "").slice(0, 16));
    }
    const ev = evaluarPago(pago, productoTexto);
    if (ev.valido) ventas.push(pago);
    else contar(ev.motivo);
  }

  // Solo para las ventas válidas: buscar el email de la compra (de a varias en paralelo,
  // de la más reciente a la más vieja, sin pasarse del tiempo disponible).
  const emails = new Set();
  const detalle = [];
  let sinTiempo = 0;
  for (let i = 0; i < ventas.length; i += CONSULTAS_EN_PARALELO) {
    if (ahora() - inicio > TIEMPO_MAXIMO_MS) { sinTiempo = ventas.length - i; break; }
    const tanda = ventas.slice(i, i + CONSULTAS_EN_PARALELO);
    const resultados = await Promise.all(tanda.map(p => emailDeLaCompra(token, p).catch(e => ({ motivo: "error: " + e.message }))));
    tanda.forEach((pago, k) => {
      const res = resultados[k];
      const pagador = limpiarEmail(pago.payer && pago.payer.email);
      const fila = { fecha: String(pago.date_approved || pago.date_created || "").slice(0, 16), pagador: pagador ? ocultarEmail(pagador) : "(sin email)" };
      if (res.email) {
        emails.add(res.email);
        detalle.push({ ...fila, emailCompra: ocultarEmail(res.email), pagoOtraPersona: Boolean(pagador) && pagador !== res.email });
      } else {
        contar(res.motivo);
        detalle.push({ ...fila, emailCompra: null, motivo: res.motivo });
      }
    });
  }
  if (sinTiempo) contar("pendiente: sin tiempo en esta ejecución");

  const lista = [...emails];
  let agregados = 0;
  if (modo === "activo" && lista.length) agregados = await agregarCompradores(supabaseUrl, clave, lista);

  return {
    ok: true, modo, dias, productoTexto: productoTexto || "(sin configurar)",
    origenEmail: "preferencia.payer.email",
    pagosRevisados: pagos.length,
    ventasDelProducto: ventas.length,
    compradoresValidos: lista.length,
    pagadosPorOtraPersona: detalle.filter(v => v.pagoOtraPersona).length,
    agregadosNuevos: modo === "activo" ? agregados : "0 (modo prueba: no se escribió nada)",
    descartados: motivos,
    nombresDeProductosAprobados: nombresVistos,
    diagnosticoPorProducto: diagnostico,
    ventas: detalle,
  };
}

export default async () => {
  try {
    const resultado = await sincronizar(process.env);
    const { diagnosticoPorProducto, ventas, ...resumen } = resultado;
    console.log("[mercadopago-compradores]", JSON.stringify(resumen));
    for (const [producto, datos] of Object.entries(diagnosticoPorProducto || {})) {
      console.log("[mercadopago-compradores][diagnostico]", JSON.stringify({ producto, ...datos }));
    }
    for (const venta of (ventas || []).slice(0, MAX_VENTAS_EN_REGISTRO)) {
      console.log("[mercadopago-compradores][venta]", JSON.stringify(venta));
    }
    return new Response(JSON.stringify({ ok: resultado.ok }), { status: resultado.ok ? 200 : 500 });
  } catch (error) {
    console.error("[mercadopago-compradores] Error:", error.message);
    return new Response(JSON.stringify({ ok: false }), { status: 500 });
  }
};
