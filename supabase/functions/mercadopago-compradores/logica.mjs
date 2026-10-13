// =====================================================================
// MERCADO PAGO → SUPABASE (tabla "compradores")
//
// Lógica de la Edge Function de Supabase "mercadopago-compradores" (index.ts la
// ejecuta; pg_cron la llama cada 10 minutos con una clave secreta). Consulta en la
// cuenta de Mercado Pago los pagos APROBADOS recientes del producto y agrega a
// "compradores" el email que el cliente ingresó en Impul Tienda, para que pueda
// registrarse en la app.
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
//   - Solo cuenta pagos cobrados por tu cuenta (collector_id = tu id; descarta tus
//     propias compras), con status "approved", de tipo venta ("regular_payment")
//     y cuyo nombre/descripción contiene MP_PRODUCTO_TEXTO. Recién entonces busca
//     el email de la compra.
//   - En Supabase solo AGREGA emails nuevos: antes de insertar lee todos los emails
//     de "compradores" (sin distinguir mayúsculas) y agrega solo los que faltan.
//     Nunca modifica ni borra filas existentes.
//
// Variables (Supabase → Edge Functions → Secrets):
//   SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las pone Supabase solo; no hay que cargarlas.
//   MP_ACCESS_TOKEN            Access Token de PRODUCCIÓN de tu aplicación de Mercado Pago
//   CRON_SECRET                clave que pg_cron envía para poder ejecutar la función
//   MP_PRODUCTO_TEXTO          parte del nombre del producto tal como figura en Mercado Pago
//   MP_MODO                    "prueba" (por defecto: no escribe nada, solo informa) o "activo"
//   MP_DIAS                    cuántos días hacia atrás revisar (por defecto 3; usar 365 una vez
//                              para cargar compradores anteriores)
// =====================================================================

const MP_API = "https://api.mercadopago.com";
const TAMANO_PAGINA = 50;
const MAX_PAGOS = 1000; // tope de seguridad por ejecución
const CONSULTAS_EN_PARALELO = 5;
const TIEMPO_MAXIMO_MS = 20000; // margen amplio dentro del límite de las Edge Functions

// Minúsculas y sin acentos, para comparar nombres de producto.
export function normalizar(texto) {
  return String(texto || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

// Oculta parte del email para los registros (logs).
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
// cuentaId: id de tu cuenta de Mercado Pago. La búsqueda también trae pagos que hiciste
// vos como compradora; solo valen aquellos en los que tu cuenta es la que cobra.
export function evaluarPago(pago, productoTexto, cuentaId) {
  if (!pago || pago.status !== "approved") return { valido: false, motivo: "no aprobado" };
  if (!cuentaId || String(pago.collector_id || "") !== String(cuentaId)) return { valido: false, motivo: "no cobrado por tu cuenta" };
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


// Lee TODOS los emails que ya están en "compradores" (en minúsculas y sin espacios),
// de a 1000 filas. Se usa para agregar solo los que faltan: la tabla no tiene un índice
// único en email, así que la función evita los duplicados comparando antes de insertar.
export async function leerCompradores(supabaseUrl, clave) {
  const existentes = new Set();
  for (let desde = 0; ; desde += 1000) {
    const r = await fetch(`${supabaseUrl}/rest/v1/compradores?select=email&order=id.asc&limit=1000&offset=${desde}`, {
      headers: { apikey: clave, Authorization: `Bearer ${clave}` },
    });
    if (!r.ok) throw new Error(`Supabase respondió ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const filas = await r.json();
    for (const f of filas) { const e = limpiarEmail(f && f.email); if (e) existentes.add(e); }
    if (filas.length < 1000) return existentes;
  }
}

// Inserta filas nuevas (solo emails que no estaban). Nunca modifica ni borra filas.
async function agregarCompradores(supabaseUrl, clave, emails) {
  const r = await fetch(`${supabaseUrl}/rest/v1/compradores`, {
    method: "POST",
    headers: {
      apikey: clave,
      Authorization: `Bearer ${clave}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
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

  const cuenta = await leerMP(token, "/users/me");
  if (cuenta.error || !cuenta.datos || !cuenta.datos.id) throw new Error(`No se pudo identificar tu cuenta de Mercado Pago (${cuenta.error || "sin id"})`);
  const cuentaId = cuenta.datos.id;
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
    const ev = evaluarPago(pago, productoTexto, cuentaId);
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

  // Siempre (también en prueba) se lee la tabla: si la lectura falla, no se escribe nada.
  const lista = [...emails];
  const existentes = await leerCompradores(supabaseUrl, clave);
  const nuevos = lista.filter(e => !existentes.has(e));
  let agregados = 0;
  if (modo === "activo" && nuevos.length) agregados = await agregarCompradores(supabaseUrl, clave, nuevos);
  const supabase = { conexion: "ok", filasEnLaTabla: existentes.size, yaRegistrados: lista.length - nuevos.length, nuevos: nuevos.length };

  return {
    ok: true, modo, dias, productoTexto: productoTexto || "(sin configurar)",
    origenEmail: "preferencia.payer.email",
    pagosRevisados: pagos.length,
    ventasDelProducto: ventas.length,
    compradoresValidos: lista.length,
    pagadosPorOtraPersona: detalle.filter(v => v.pagoOtraPersona).length,
    agregadosNuevos: modo === "activo" ? agregados : "0 (modo prueba: no se escribió nada)",
    supabase,
    descartados: motivos,
    nombresDeProductosAprobados: nombresVistos,
    diagnosticoPorProducto: diagnostico,
    ventas: detalle,
  };
}

