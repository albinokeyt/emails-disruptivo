// Cliente HTTP único del panel. Cubre todos los endpoints del contrato (SPEC §5.1, §5.2 y §5.3).
// Todas las respuestas de error del backend son { error: "mensaje en español" }.

export class ErrorApi extends Error {
  constructor(mensaje, estado, cuerpo) {
    super(mensaje)
    this.name = 'ErrorApi'
    this.estado = estado
    this.cuerpo = cuerpo || null
    this.sesionCaducada = estado === 401
  }
}

// Endpoints que solo *comprueban* si hay sesión: su 401 es una respuesta normal,
// no una sesión que se ha caído a media navegación, así que no avisan a la app.
const SONDAS_DE_SESION = ['/api/sesion', '/api/admin/yo']

function ambitoDeRuta(ruta) {
  if (ruta.startsWith('/api/admin')) return 'admin'
  return 'location'
}

function avisarSesionCaducada(ruta) {
  if (typeof window === 'undefined') return
  if (SONDAS_DE_SESION.some((s) => ruta === s || ruta.startsWith(`${s}?`))) return
  window.dispatchEvent(new CustomEvent('sesion:caducada', { detail: { ambito: ambitoDeRuta(ruta) } }))
}

export function emitir(nombre, detalle) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(nombre, { detail: detalle || null }))
}

async function solicitar(metodo, ruta, cuerpo) {
  let res
  try {
    res = await fetch(ruta, {
      method: metodo,
      credentials: 'same-origin',
      headers: cuerpo === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
    })
  } catch {
    throw new ErrorApi('No hay conexión con el servidor. Inténtalo de nuevo.', 0)
  }

  let datos = null
  try { datos = await res.json() } catch { /* respuestas sin cuerpo (204) */ }

  if (!res.ok) {
    if (res.status === 401) avisarSesionCaducada(ruta)
    const mensaje = datos?.error || datos?.mensaje || `Error ${res.status}`
    throw new ErrorApi(mensaje, res.status, datos)
  }
  return datos
}

export const api = {
  get: (ruta) => solicitar('GET', ruta),
  post: (ruta, cuerpo) => solicitar('POST', ruta, cuerpo === undefined ? {} : cuerpo),
  put: (ruta, cuerpo) => solicitar('PUT', ruta, cuerpo === undefined ? {} : cuerpo),
  patch: (ruta, cuerpo) => solicitar('PATCH', ruta, cuerpo === undefined ? {} : cuerpo),
  del: (ruta) => solicitar('DELETE', ruta),
}

// Construye ?a=1&b=2 descartando vacíos, null y undefined.
export function consulta(filtros) {
  if (!filtros) return ''
  const p = new URLSearchParams()
  for (const [clave, valor] of Object.entries(filtros)) {
    if (valor === null || valor === undefined || valor === '') continue
    p.set(clave, String(valor))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

/* ============================================================
   §5.1 Sesión
   ============================================================ */

// URL de instalación OAuth: es una redirección del navegador, no una llamada fetch.
export const urlInstalacion = () => '/api/oauth/instalar'

// `payload` es el paquete cifrado que devuelve GHL por postMessage (ver sso.js).
export const iniciarSesionSso = (payload) => api.post('/api/sesion/sso', { payload })

export const obtenerSesion = () => api.get('/api/sesion')

/* ============================================================
   §5.2 Panel de subcuenta — /api/loc/*
   ============================================================ */

export const obtenerResumen = () => api.get('/api/loc/resumen')

export const listarProveedores = () => api.get('/api/loc/proveedores')
export const crearProveedor = (datos) => api.post('/api/loc/proveedores', datos)
export const actualizarProveedor = (id, datos) => api.patch(`/api/loc/proveedores/${id}`, datos)
export const eliminarProveedor = (id) => api.del(`/api/loc/proveedores/${id}`)
export const probarProveedor = (id) => api.post(`/api/loc/proveedores/${id}/probar`)
export const registrarWebhookProveedor = (id) => api.post(`/api/loc/proveedores/${id}/webhook`)

export const listarRemitentes = () => api.get('/api/loc/remitentes')
export const crearRemitente = (datos) => api.post('/api/loc/remitentes', datos)
export const actualizarRemitente = (id, datos) => api.patch(`/api/loc/remitentes/${id}`, datos)
export const eliminarRemitente = (id) => api.del(`/api/loc/remitentes/${id}`)

export const listarPlantillas = () => api.get('/api/loc/plantillas')
export const crearPlantilla = (datos) => api.post('/api/loc/plantillas', datos)
export const actualizarPlantilla = (id, datos) => api.patch(`/api/loc/plantillas/${id}`, datos)
export const eliminarPlantilla = (id) => api.del(`/api/loc/plantillas/${id}`)

// filtros: { estado, desde, hasta, q, origen, pagina, limite }
export const listarEnvios = (filtros) => api.get(`/api/loc/envios${consulta(filtros)}`)
export const obtenerEnvio = (id) => api.get(`/api/loc/envios/${id}`)

export const listarSupresiones = (filtros) => api.get(`/api/loc/supresiones${consulta(filtros)}`)
export const crearSupresion = (datos) => api.post('/api/loc/supresiones', datos)
export const eliminarSupresion = (id) => api.del(`/api/loc/supresiones/${id}`)

// Rebotados (SPEC §12): supresiones por rebote duro y su DND en el canal Email de GHL.
// filtros: { q, dnd ('todos'|'con'|'sin'), desde, hasta, pagina, limite }
export const listarRebotados = (filtros) => api.get(`/api/loc/rebotados${consulta(filtros)}`)
export const dndRebotado = (id) => api.post(`/api/loc/rebotados/${id}/dnd`)
// procesa hasta 100 pendientes por llamada; la pantalla repite mientras `restantes > 0`
export const dndMasivo = () => api.post('/api/loc/rebotados/dnd-masivo')
// descarga de CSV: es un enlace directo del navegador, no una llamada fetch. Acepta los mismos
// filtros que la lista (q, dnd, desde, hasta): lo que se ve en pantalla es lo que se descarga.
export const urlExportarRebotados = (filtros) => `/api/loc/rebotados/exportar${consulta(filtros)}`
export const obtenerPreferencias = () => api.get('/api/loc/preferencias')
export const guardarPreferencias = (datos) => api.patch('/api/loc/preferencias', datos)

// GET devuelve { dominios, dominios_remitentes }: la pantalla se construye a partir de los
// dominios que la subcuenta usa en sus remitentes, no de un campo libre.
export const listarDominios = () => api.get('/api/loc/dominios')
export const crearDominio = (datos) => api.post('/api/loc/dominios', datos)
export const verificarDominio = (id) => api.post(`/api/loc/dominios/${id}/verificar`)
export const eliminarDominio = (id) => api.del(`/api/loc/dominios/${id}`)

// Dominio de tracking por subcuenta (SPEC §11.3): CNAME del cliente hacia el host de la app.
// GET devuelve { dominios: [...], destino_cname } — como mucho hay un dominio por subcuenta.
export const listarDominiosTracking = () => api.get('/api/loc/dominios-tracking')
export const crearDominioTracking = (datos) => api.post('/api/loc/dominios-tracking', datos)
export const verificarDominioTracking = (id) => api.post(`/api/loc/dominios-tracking/${id}/verificar`)
export const eliminarDominioTracking = (id) => api.del(`/api/loc/dominios-tracking/${id}`)

// GET devuelve `port` (el PÚBLICO, 587 por defecto: nunca la escucha interna del contenedor),
// `puerto_ssl` (465, o null si la escucha SSL no está levantada), `tls_ok` y `tls_valido_hasta`
// (SPEC §13.3). La pantalla usa `tls_error` si el backend lo incluye; si no, un certificado no
// válido se muestra como «en emisión».
export const obtenerRelay = () => api.get('/api/loc/relay')
// activar y rotar devuelven la contraseña UNA SOLA VEZ: hay que enseñarla en ese momento.
export const activarRelay = () => api.post('/api/loc/relay/activar')
export const rotarRelay = () => api.post('/api/loc/relay/rotar')
export const actualizarRelay = (datos) => api.patch('/api/loc/relay', datos)

/* ============================================================
   §14 Buzón — correo entrante por IMAP (/api/loc/buzon/*)
   ============================================================ */

// Cuentas IMAP. La contraseña nunca vuelve: llega como { configurado:true }. En PATCH solo se
// manda `password` si el usuario ha escrito una nueva.
export const listarCuentasBuzon = () => api.get('/api/loc/buzon/cuentas')
export const crearCuentaBuzon = (datos) => api.post('/api/loc/buzon/cuentas', datos)
export const actualizarCuentaBuzon = (id, datos) => api.patch(`/api/loc/buzon/cuentas/${id}`, datos)
export const eliminarCuentaBuzon = (id) => api.del(`/api/loc/buzon/cuentas/${id}`)
// → { ok, detalle, mensajes_en_servidor }
export const probarCuentaBuzon = (id) => api.post(`/api/loc/buzon/cuentas/${id}/probar`)
// → { ok, nuevos, detalle }
export const sincronizarCuentaBuzon = (id) => api.post(`/api/loc/buzon/cuentas/${id}/sincronizar`)

// filtros: { cuenta, q, no_leidos, desde, hasta, pagina, limite } → { mensajes, total, pagina, limite }
export const listarMensajesBuzon = (filtros) => api.get(`/api/loc/buzon/mensajes${consulta(filtros)}`)
// mensaje completo + adjuntos (metadatos) + hilo; el backend lo marca como leído al abrirlo
export const obtenerMensajeBuzon = (id) => api.get(`/api/loc/buzon/mensajes/${id}`)
export const marcarMensajeBuzon = (id, leido) => api.patch(`/api/loc/buzon/mensajes/${id}`, { is_read: Boolean(leido) })
// `servidor` = borrarlo también en el IMAP si el UID sigue existiendo allí
export const eliminarMensajeBuzon = (id, servidor = false) =>
  api.del(`/api/loc/buzon/mensajes/${id}${servidor ? '?servidor=1' : ''}`)
// descarga directa del navegador (Content-Disposition: attachment), no una llamada fetch
export const urlAdjuntoBuzon = (id) => `/api/loc/buzon/adjuntos/${id}`
// { html, text, sender_id?, todos, cc, bcc } → encola en `messages` con origin 'buzon'
export const responderMensajeBuzon = (id, datos) => api.post(`/api/loc/buzon/mensajes/${id}/responder`, datos)
// { to, html, text, sender_id? } — sin adjuntos en esta versión
export const reenviarMensajeBuzon = (id, datos) => api.post(`/api/loc/buzon/mensajes/${id}/reenviar`, datos)
// → { usado_bytes, cuota_mb, porcentaje, por_cuenta:[…] }
export const obtenerEspacioBuzon = () => api.get('/api/loc/buzon/espacio')

// Contador del menú lateral: pide una sola fila de no leídos y se queda con el `total`.
export async function contarNoLeidosBuzon() {
  const d = await listarMensajesBuzon({ no_leidos: 1, limite: 1 })
  const n = Number(d?.total)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/* ============================================================
   §5.3 Panel de admin — /api/admin/*
   ============================================================ */

export async function adminEntrar(usuario, contrasena) {
  const r = await api.post('/api/admin/login', { usuario, contrasena })
  emitir('sesion:iniciada', { ambito: 'admin' })
  return r
}

export async function adminSalir() {
  try { await api.post('/api/admin/logout') } catch { /* la sesión se cierra igual en el cliente */ }
  emitir('sesion:cerrada', { ambito: 'admin' })
}

export const adminYo = () => api.get('/api/admin/yo')

export const adminListarSubcuentas = () => api.get('/api/admin/subcuentas')

export const adminListarProveedores = () => api.get('/api/admin/proveedores')
export const adminCrearProveedor = (datos) => api.post('/api/admin/proveedores', datos)
export const adminActualizarProveedor = (id, datos) => api.patch(`/api/admin/proveedores/${id}`, datos)
export const adminEliminarProveedor = (id) => api.del(`/api/admin/proveedores/${id}`)
export const adminProbarProveedor = (id) => api.post(`/api/admin/proveedores/${id}/probar`)
export const registrarWebhookProveedorAdmin = (id) => api.post(`/api/admin/proveedores/${id}/webhook`)

export const adminListarAsignaciones = (proveedorId) => api.get(`/api/admin/proveedores/${proveedorId}/asignaciones`)
export const adminAsignarProveedor = (proveedorId, locationId) =>
  api.post(`/api/admin/proveedores/${proveedorId}/asignaciones`, { location_id: locationId })
export const adminDesasignarProveedor = (proveedorId, locationId) =>
  api.del(`/api/admin/proveedores/${proveedorId}/asignaciones/${encodeURIComponent(locationId)}`)

// filtros: { location_id }
export const adminListarRemitentes = (filtros) => api.get(`/api/admin/remitentes${consulta(filtros)}`)
export const adminCrearRemitente = (datos) => api.post('/api/admin/remitentes', datos)
export const adminActualizarRemitente = (id, datos) => api.patch(`/api/admin/remitentes/${id}`, datos)
export const adminEliminarRemitente = (id) => api.del(`/api/admin/remitentes/${id}`)

// location_id null = plantilla global visible por todas las subcuentas
export const adminListarPlantillas = (filtros) => api.get(`/api/admin/plantillas${consulta(filtros)}`)
export const adminCrearPlantilla = (datos) => api.post('/api/admin/plantillas', datos)
export const adminActualizarPlantilla = (id, datos) => api.patch(`/api/admin/plantillas/${id}`, datos)
export const adminEliminarPlantilla = (id) => api.del(`/api/admin/plantillas/${id}`)

// filtros: { location_id, estado, desde, hasta, q, origen, pagina, limite }
export const adminListarEnvios = (filtros) => api.get(`/api/admin/envios${consulta(filtros)}`)

export const adminActivarRelay = (locationId) =>
  api.post(`/api/admin/subcuentas/${encodeURIComponent(locationId)}/relay`)

// Buzón (SPEC §14.3, admin): uso y cuota de todas las subcuentas, y cuota por subcuenta
// (`quota_mb` null = volver al valor por defecto de Ajustes → límites → buzon_quota_mb).
export const adminEspacioBuzon = () => api.get('/api/admin/buzon/espacio')
export const adminCuotaBuzon = (locationId, quotaMb) =>
  api.patch(`/api/admin/subcuentas/${encodeURIComponent(locationId)}/buzon`, { quota_mb: quotaMb })

export const adminObtenerAjustes = () => api.get('/api/admin/ajustes')
export const adminGuardarAjustes = (datos) => api.put('/api/admin/ajustes', datos)

// Relay SMTP y certificado TLS (SPEC §13.3): estadoRelay() del relay + estadoCertificado() de ACME.
export const obtenerEstadoRelayAdmin = () => api.get('/api/admin/relay')
// Fuerza la emisión o renovación del certificado ahora. Respeta el lock entre instancias y la cuota
// de un intento por hora tras un error. Responde { ok, estado } o { ok:false, error } con 200:
// hay que mirar `ok`, no solo confiar en que no lance.
export const emitirCertificadoRelay = () => api.post('/api/admin/relay/certificado')

/* ============================================================
   Formateo
   ============================================================ */

export const fmtFecha = (v) =>
  v ? new Date(v).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'

export const fmtFechaHora = (v) =>
  v
    ? new Date(v).toLocaleString('es-ES', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      })
    : '—'

export const fmtNumero = (v) =>
  v === null || v === undefined || v === '' ? '—' : new Intl.NumberFormat('es-ES').format(Number(v) || 0)

// "1,4 MB" para tamaños de mensajes, adjuntos y cuota del buzón (base 1024, como el sistema).
export function fmtBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n < 1024) return `${Math.round(n)} B`
  const unidades = ['KB', 'MB', 'GB', 'TB']
  let valor = n / 1024
  let i = 0
  while (valor >= 1024 && i < unidades.length - 1) {
    valor /= 1024
    i += 1
  }
  const decimales = valor < 10 ? 1 : 0
  return `${new Intl.NumberFormat('es-ES', { maximumFractionDigits: decimales }).format(valor)} ${unidades[i]}`
}

/* ============================================================
   Dominios de correo gratuito
   ============================================================ */

// Espejo de esDominioGratuito en src/routes/location.js (la fuente de verdad es el backend: el
// flag `gratuito` de GET /api/loc/dominios sale de ahí). Este espejo existe solo para avisos en
// vivo mientras se teclea un correo, sin llamar a la API. Si cambias uno, cambia el otro.
const DOMINIOS_GRATUITOS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com',
  'icloud.com', 'me.com', 'aol.com', 'msn.com', 'proton.me', 'protonmail.com', 'gmx.com',
  'yandex.com', 'zoho.com', 'mail.com', 'ymail.com', 'rocketmail.com', 'web.de', 't-online.de',
  'laposte.net', 'libero.it', 'wanadoo.fr', 'orange.fr', 'free.fr', 'mail.ru', 'seznam.cz',
])
const MARCAS_GRATUITAS = new Set([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'hotmail', 'outlook', 'live', 'msn', 'icloud',
  'aol', 'proton', 'protonmail', 'gmx', 'yandex', 'zoho',
])
const RE_SUFIJO_PUBLICO = /^(?:[a-z]{2,3}|(?:co|com|net|org)\.[a-z]{2})$/

export function esDominioGratuito(dominio) {
  const d = String(dominio || '').toLowerCase()
  if (DOMINIOS_GRATUITOS.has(d)) return true
  const punto = d.indexOf('.')
  if (punto <= 0) return false
  return MARCAS_GRATUITAS.has(d.slice(0, punto)) && RE_SUFIJO_PUBLICO.test(d.slice(punto + 1))
}

// "hace 3 min" para las columnas de actividad reciente.
export function fmtRelativo(v) {
  if (!v) return '—'
  const seg = Math.round((Date.now() - new Date(v).getTime()) / 1000)
  const rtf = new Intl.RelativeTimeFormat('es-ES', { numeric: 'auto' })
  const tramos = [
    [60, 'second', 1],
    [3600, 'minute', 60],
    [86400, 'hour', 3600],
    [2592000, 'day', 86400],
    [31536000, 'month', 2592000],
    [Infinity, 'year', 31536000],
  ]
  for (const [limite, unidad, divisor] of tramos) {
    if (Math.abs(seg) < limite) return rtf.format(-Math.round(seg / divisor), unidad)
  }
  return fmtFecha(v)
}
