import { randomBytes } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { q } from '../db.js'
import { redis } from '../redis.js'
import { requireLocation } from '../lib/auth.js'
import { cifrarCredenciales, descifrarCredenciales, hashPassword, randomPassword, randomToken } from '../lib/crypto.js'
// El guardarraíl de destinos de red vive en lib/ porque lo comparten este panel («Probar conexión»)
// y el worker de envío (src/lib/queue.js), que es quien abre la conexión SMTP de verdad.
import { RE_HOST, destinoPermitido, esIpInterna, hostPublico } from '../lib/red.js'
// El worker cachea el dominio de tracking de cada subcuenta (lib/tracking.js): al verificarlo o
// eliminarlo desde el panel hay que invalidar esa caché para que el cambio sea inmediato.
import { olvidarDominioTracking } from '../lib/tracking.js'
// SPEC §12: aplicarDnd activa el DND del canal Email del contacto en GHL (resolviendo el contacto
// por email si la supresión no trae ghl_contact_id) y deja el resultado en dnd_at/dnd_error.
import { aplicarDnd } from '../lib/dnd.js'
import { urlWebhookBrevo } from './webhooks.js'

// SPEC §5.2 — API del panel de subcuenta. TODAS las rutas van bajo requireLocation y TODAS las
// consultas filtran por el location_id de la sesión (que solo nace del SSO cifrado de GHL).
// Las credenciales de proveedor jamás salen de aquí: se devuelven como { configurado: true }.

const ESTADOS = new Set([
  'encolado', 'reintento', 'enviando', 'enviado', 'diferido',
  'entregado', 'rebotado', 'spam', 'fallido', 'suprimido',
])
const ORIGENES = new Set(['nodo_plantilla', 'nodo_personalizado', 'relay'])
const MOTIVOS_SUPRESION = new Set(['rebote_duro', 'spam', 'baja', 'manual'])
const TIPOS_PROVEEDOR = new Set(['smtp', 'brevo'])

const MAX_NOMBRE = 200
const MAX_ASUNTO = 500
const MAX_HTML = 1_000_000
const MAX_CONFIG = 8_000

const RE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/
const RE_DOMINIO = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/
const RE_FECHA_HORA = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/

// Prefijo del registro TXT de verificación de dominio (ver POST /api/loc/dominios/:id/verificar)
const TXT_PREFIJO = 'disruptivo-verify='
const TXT_SUBDOMINIO = '_disruptivo-verify'

// Dominios de correo gratuito: no pertenecen a ninguna subcuenta, así que ni se verifican ni
// bloquean a nadie. La pantalla de Dominios los enseña como «no aplica» y el alta los rechaza.
// Además del listado exacto se cubren las variantes regionales (hotmail.fr, yahoo.co.uk,
// outlook.com.br…): marca gratuita + sufijo público conocido. OJO: la marca sola no basta —
// mail.<empresa>.com o web.<empresa>.de son subdominios corporativos legítimos y no deben caer aquí.
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
// Sufijos bajo los que operan esas marcas: TLD simple (fr, de, it…) o compuesto (co.uk, com.br…)
const RE_SUFIJO_PUBLICO = /^(?:[a-z]{2,3}|(?:co|com|net|org)\.[a-z]{2})$/
export function esDominioGratuito(dominio) {
  const d = String(dominio || '').toLowerCase()
  if (DOMINIOS_GRATUITOS.has(d)) return true
  const punto = d.indexOf('.')
  if (punto <= 0) return false
  return MARCAS_GRATUITAS.has(d.slice(0, punto)) && RE_SUFIJO_PUBLICO.test(d.slice(punto + 1))
}

// Host público de la app: es el destino del CNAME del dominio de tracking (SPEC §11.3)
const hostApp = () => {
  try {
    return new URL(String(process.env.APP_BASE_URL || '')).hostname.toLowerCase()
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// Utilidades de validación
// ---------------------------------------------------------------------------

// Estas utilidades las reutiliza tal cual el panel de agencia (src/routes/admin.js): validar igual
// en los dos sitios evita que por el panel de la agencia entren datos que el de subcuenta rechaza.
export const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
// Inyección de cabeceras de correo: \r y \n fuera de nombres, asuntos y reply-to
export const cabecera = (v, max) => texto(v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max)
export const esEmail = (v) => {
  const e = texto(v)
  return e.length > 0 && e.length <= 320 && RE_EMAIL.test(e)
}
export const idDe = (v) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}
const malo = (reply, mensaje) => reply.code(400).send({ error: mensaje })

// LIMIT/OFFSET se interpolan en el SQL: por eso se fuerzan a entero acotado antes de tocar la
// consulta. La página también lleva techo: sin él, ?pagina=1e20 llega al SQL como OFFSET 1e+22 y
// Postgres revienta con un 500 en vez del 400 en español del contrato de errores.
const MAX_PAGINA = 100_000
const enteroAcotado = (valor, def, min, max) => {
  if (valor === undefined || valor === null || String(valor).trim() === '') return def
  const n = Number(valor)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.max(Math.floor(n), min), max)
}

export function paginar(query) {
  const limite = enteroAcotado(query?.limite, 50, 1, 200)
  const pagina = enteroAcotado(query?.pagina, 1, 1, MAX_PAGINA)
  return { limite, pagina, offset: (pagina - 1) * limite }
}

function fechaValida(v) {
  const s = texto(v)
  return RE_FECHA.test(s) || RE_FECHA_HORA.test(s)
}

/**
 * Añade a `where`/`params` los filtros comunes de la tabla de envíos (alias m).
 * Devuelve un mensaje de error en español, o null si todo es correcto.
 */
export function filtrosEnvios(query, where, params) {
  const qy = query || {}
  const estado = texto(qy.estado)
  if (estado) {
    if (!ESTADOS.has(estado)) return 'Ese estado de envío no existe'
    params.push(estado)
    where.push(`m.status = $${params.length}`)
  }
  const origen = texto(qy.origen)
  if (origen) {
    if (!ORIGENES.has(origen)) return 'Ese origen de envío no existe'
    params.push(origen)
    where.push(`m.origin = $${params.length}`)
  }
  const desde = texto(qy.desde)
  if (desde) {
    if (!fechaValida(desde)) return 'La fecha "desde" no es válida (usa AAAA-MM-DD)'
    params.push(desde)
    where.push(`m.created_at >= $${params.length}::timestamptz`)
  }
  const hasta = texto(qy.hasta)
  if (hasta) {
    if (!fechaValida(hasta)) return 'La fecha "hasta" no es válida (usa AAAA-MM-DD)'
    params.push(hasta)
    // una fecha suelta incluye el día entero; un instante completo se respeta tal cual
    where.push(
      RE_FECHA.test(hasta)
        ? `m.created_at < ($${params.length}::timestamptz + interval '1 day')`
        : `m.created_at <= $${params.length}::timestamptz`
    )
  }
  const busqueda = texto(qy.q)
  if (busqueda) {
    if (busqueda.length > 200) return 'La búsqueda es demasiado larga'
    params.push(`%${busqueda.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
    where.push(`(m.to_email::text ILIKE $${params.length} ESCAPE '\\' OR m.subject ILIKE $${params.length} ESCAPE '\\')`)
  }
  return null
}

export const COLUMNAS_ENVIO = `m.id, m.location_id, m.status, m.origin, m.to_email, m.to_name, m.subject,
  m.provider_id, m.sender_id, m.template_id, m.attempts, m.last_error, m.created_at, m.sent_at,
  m.opened_at, m.clicked_at, m.updated_at, m.next_attempt_at,
  s.email AS remitente_email, s.name AS remitente_nombre,
  p.name AS proveedor_nombre, t.name AS plantilla_nombre`

export const JOINS_ENVIO = `FROM messages m
  LEFT JOIN senders   s ON s.id = m.sender_id
  LEFT JOIN providers p ON p.id = m.provider_id
  LEFT JOIN templates t ON t.id = m.template_id`

// ---------------------------------------------------------------------------
// Rebotados (SPEC §12): la sección lee suppressions con reason='rebote_duro' (alias s)
// ---------------------------------------------------------------------------

const FILTROS_DND = new Set(['todos', 'con', 'sin'])
// U+FEFF al principio del CSV: sin él, Excel abre el UTF-8 con los acentos rotos (SPEC §12.3)
const BOM_UTF8 = String.fromCharCode(0xfeff)
// El botón masivo llama a GHL en serie y con una pausa corta: su rate limit es por ráfagas y por
// subcuenta, y un lote de 100 contactos disparado de golpe se comería el cupo entero.
const LOTE_DND = 100
const PAUSA_DND_MS = 300

const pausa = (ms) => new Promise((resolver) => setTimeout(resolver, ms))

// Último mensaje que rebotó a esa dirección: 'rebotado' (webhook de Brevo o DSN duro VERP) o
// 'fallido' (rechazo permanente del RCPT en el momento del envío, SPEC §12.1). Los 'suprimido'
// posteriores no cuentan: nunca llegaron a salir.
const SQL_ULTIMO_REBOTE = `LEFT JOIN LATERAL (
  SELECT m.id, m.subject, m.sent_at FROM messages m
   WHERE m.location_id = s.location_id AND m.to_email = s.email
     AND m.status IN ('rebotado','fallido')
   ORDER BY m.created_at DESC, m.id DESC LIMIT 1
) um ON true`

const COLUMNAS_REBOTADO = `s.id, s.email, s.source, s.created_at, s.ghl_contact_id, s.dnd_at, s.dnd_error,
  um.id AS mensaje_id, um.subject AS mensaje_asunto, um.sent_at AS mensaje_enviado`

/** Filtros comunes de la lista y el CSV de rebotados. Devuelve un error en español o null. */
function filtrosRebotados(query, where, params) {
  const qy = query || {}
  const dnd = texto(qy.dnd) || 'todos'
  if (!FILTROS_DND.has(dnd)) return 'El filtro «dnd» tiene que ser «todos», «con» o «sin»'
  if (dnd === 'con') where.push('s.dnd_at IS NOT NULL')
  if (dnd === 'sin') where.push('s.dnd_at IS NULL')
  const desde = texto(qy.desde)
  if (desde) {
    if (!fechaValida(desde)) return 'La fecha "desde" no es válida (usa AAAA-MM-DD)'
    params.push(desde)
    where.push(`s.created_at >= $${params.length}::timestamptz`)
  }
  const hasta = texto(qy.hasta)
  if (hasta) {
    if (!fechaValida(hasta)) return 'La fecha "hasta" no es válida (usa AAAA-MM-DD)'
    params.push(hasta)
    // una fecha suelta incluye el día entero; un instante completo se respeta tal cual
    where.push(
      RE_FECHA.test(hasta)
        ? `s.created_at < ($${params.length}::timestamptz + interval '1 day')`
        : `s.created_at <= $${params.length}::timestamptz`
    )
  }
  const busqueda = texto(qy.q)
  if (busqueda) {
    if (busqueda.length > 200) return 'La búsqueda es demasiado larga'
    params.push(`%${busqueda.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
    where.push(`s.email::text ILIKE $${params.length} ESCAPE '\\'`)
  }
  return null
}

const filaRebotado = (f) => ({
  id: f.id,
  email: f.email,
  created_at: f.created_at,
  source: f.source,
  ghl_contact_id: f.ghl_contact_id,
  dnd_at: f.dnd_at,
  dnd_error: f.dnd_error,
  ultimo_mensaje: f.mensaje_id
    ? { id: f.mensaje_id, subject: f.mensaje_asunto, sent_at: f.mensaje_enviado }
    : null,
})

// Campo CSV: comillas dobladas y campos con comas/comillas/saltos entre comillas. Los valores que
// empiezan por =, +, - o @ se prefijan con apóstrofe para que Excel no los ejecute como fórmula
// (inyección CSV): el fichero está pensado para abrirse y reimportarse en GHL sin sustos.
const campoCsv = (v) => {
  let s = v === undefined || v === null ? '' : String(v)
  if (/^[=+\-@]/.test(s)) s = `'${s}`
  if (/[",;\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`
  return s
}

export function validarCredenciales(tipo, cred) {
  if (!cred || typeof cred !== 'object' || Array.isArray(cred)) return 'Faltan las credenciales del proveedor'
  const claves = Object.keys(cred)
  if (!claves.length) return 'Faltan las credenciales del proveedor'
  if (claves.length > 20) return 'Las credenciales tienen demasiados campos'
  for (const k of claves) {
    const v = cred[k]
    if (v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      return `El campo «${k}» de las credenciales no es válido`
    }
    if (typeof v === 'string' && v.length > 4000) return `El campo «${k}» de las credenciales es demasiado largo`
  }
  if (tipo === 'brevo' && !texto(cred.api_key)) return 'Falta la clave de API de Brevo'
  if (tipo === 'smtp' && (!texto(cred.user) || !texto(cred.pass))) return 'Faltan el usuario y la contraseña del SMTP'
  return null
}

// providers.config es una columna que escribe el usuario del panel, así que solo se guardan las
// claves que el envío necesita de verdad. Cualquier otra se descarta: si no, la subcuenta podría
// sembrar ahí material de autenticación (p. ej. un webhook_token elegido por ella).
const CLAVES_CONFIG = {
  smtp: ['host', 'port', 'secure', 'requireTLS', 'pool'],
  brevo: [],
}

// Alcanzar la red interna desde "Probar conexión" convertiría el botón en un escáner de puertos con
// oráculo: la lista de rangos y la resolución de DNS están en src/lib/red.js, que comparten este
// panel y el worker. Se reexportan para no romper a quien las importe desde aquí.
export { esIpInterna, hostPublico, destinoPermitido }

export function validarConfig(tipo, config) {
  if (config === undefined || config === null) return { valor: {}, error: null }
  if (typeof config !== 'object' || Array.isArray(config)) return { valor: null, error: 'La configuración no es válida' }
  if (JSON.stringify(config).length > MAX_CONFIG) return { valor: null, error: 'La configuración es demasiado grande' }

  const permitidas = CLAVES_CONFIG[tipo] || []
  const limpia = {}
  for (const clave of permitidas) {
    if (config[clave] !== undefined) limpia[clave] = config[clave]
  }

  if (tipo === 'smtp') {
    const host = texto(limpia.host)
    if (!host || !RE_HOST.test(host)) return { valor: null, error: 'El servidor SMTP no es un nombre de host válido' }
    if (!hostPublico(host)) {
      return {
        valor: null,
        error: 'El servidor SMTP tiene que ser un nombre de dominio público: no se admiten direcciones IP ni nombres de red interna',
      }
    }
    const puerto = Number(limpia.port)
    if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
      return { valor: null, error: 'El puerto SMTP tiene que estar entre 1 y 65535' }
    }
    const valor = { ...limpia, host, port: puerto }
    if (valor.secure !== undefined) valor.secure = Boolean(valor.secure)
    if (valor.requireTLS !== undefined) valor.requireTLS = Boolean(valor.requireTLS)
    if (valor.pool !== undefined) valor.pool = Boolean(valor.pool)
    return { valor, error: null }
  }
  return { valor: limpia, error: null }
}

/**
 * URL que hay que dar de alta en Brevo (Transactional › Settings › Webhook) para recibir los
 * eventos de entrega. Sin ella no llega ni un solo evento y el historial se queda en «enviado».
 * Solo se expone para proveedores PROPIOS: el token de un proveedor cedido por la agencia sirve
 * para todas las subcuentas que lo comparten, así que no se le entrega a ninguna de ellas.
 */
export function urlWebhookDe(proveedor) {
  if (proveedor?.type !== 'brevo' || proveedor?.asignado) return null
  try {
    return urlWebhookBrevo(proveedor.id)
  } catch {
    return null // sin ENCRYPTION_KEY no hay token que firmar: el panel simplemente no la enseña
  }
}

/**
 * ¿El dominio de este correo lo tiene verificado OTRA subcuenta?
 *
 * El índice único parcial de sender_domains (SPEC §3) es el único guardarraíl duro entre clientes de
 * la agencia, pero en la pasarela solo lo mira el paso del dominio, y ese paso no se alcanza cuando
 * el remitente exacto ya existe en `senders`. Sin esta comprobación en el alta y la edición bastaba
 * con crearse el remitente `quien-sea@dominio-de-otro-cliente.com` para saltárselo por completo:
 * a partir de ahí se podía enviar suplantando ese dominio tanto por el relay como por los dos nodos
 * propios, quemándole la reputación a su dueño con un rastro indistinguible de un spoofing.
 */
export async function dominioAjenoVerificado(email, locationId) {
  const dominio = texto(email).toLowerCase().split('@').pop()
  if (!dominio) return false
  const { rows: [ajeno] } = await q(
    'SELECT 1 FROM sender_domains WHERE domain = $1 AND verified AND location_id <> $2',
    [dominio, locationId]
  )
  return Boolean(ajeno)
}

export const ERROR_DOMINIO_AJENO =
  'El dominio de ese correo está verificado por otra subcuenta: no puedes enviar desde él'

export function validarLimiteDiario(v) {
  if (v === undefined || v === null || v === '') return { valor: null, error: null }
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1) return { valor: null, error: 'El límite diario tiene que ser un número entero mayor que cero' }
  return { valor: n, error: null }
}

// El registro de proveedores (SPEC §7) lo publica src/lib/providers/. Se carga de forma perezosa:
// así un problema ahí solo afecta al botón "Probar conexión", no a todo el panel.
export async function cargarProveedor(tipo) {
  let mod
  try {
    mod = await import('../lib/providers/index.js')
  } catch {
    return null
  }
  const registro = mod.default && typeof mod.default === 'object' && !mod.default.tipo ? { ...mod, ...mod.default } : mod
  const candidato =
    (typeof registro.obtenerProveedor === 'function' ? registro.obtenerProveedor(tipo) : null) ||
    registro.proveedores?.[tipo] ||
    registro[tipo] ||
    null
  return candidato && typeof candidato.validar === 'function' ? candidato : null
}

// Limitador por subcuenta para las acciones que salen a internet (probar proveedor, verificar DNS)
async function limitar(clave, maximo, ventanaS) {
  try {
    const n = await redis.incr(clave)
    if (n === 1) await redis.expire(clave, ventanaS)
    return n <= maximo
  } catch {
    return true
  }
}

const datosRelay = () => ({
  host: texto(process.env.SMTP_RELAY_HOST) || (() => {
    try {
      return new URL(String(process.env.APP_BASE_URL || '')).hostname
    } catch {
      return ''
    }
  })(),
  port: Number(process.env.SMTP_RELAY_PORT) || 2525,
  servidor_activo: String(process.env.SMTP_RELAY_ENABLED || '').toLowerCase() === 'true',
})

const usuarioRelay = () => `ed${randomBytes(5).toString('hex')}`

/** Activa (o crea) la cuenta de relay de una subcuenta. La contraseña se devuelve UNA sola vez. */
export async function activarCuentaRelay(locationId) {
  const { rows: [existente] } = await q('SELECT * FROM relay_accounts WHERE location_id=$1', [locationId])
  if (existente) {
    const { rows: [cuenta] } = await q(
      'UPDATE relay_accounts SET enabled=true, updated_at=now() WHERE id=$1 RETURNING *',
      [existente.id]
    )
    return { cuenta, contrasena: null }
  }
  for (let intento = 0; intento < 5; intento++) {
    const contrasena = randomPassword(18)
    try {
      const { rows: [cuenta] } = await q(
        `INSERT INTO relay_accounts (location_id, username, password_hash, enabled, rotated_at)
         VALUES ($1,$2,$3,true,now()) RETURNING *`,
        [locationId, usuarioRelay(), hashPassword(contrasena)]
      )
      return { cuenta, contrasena }
    } catch (err) {
      if (err?.code !== '23505') throw err
      // carrera: otra petición creó la cuenta de esta subcuenta mientras tanto
      const { rows: [ya] } = await q('SELECT * FROM relay_accounts WHERE location_id=$1', [locationId])
      if (ya) return { cuenta: ya, contrasena: null }
      // si el choque fue por el usuario, se prueba con otro
    }
  }
  throw new Error('No se pudo generar un usuario de relay libre')
}

export function serializarRelay(cuenta) {
  const base = datosRelay()
  if (!cuenta) {
    return {
      enabled: false,
      host: base.host,
      port: base.port,
      username: null,
      tiene_password: false,
      default_provider_id: null,
      accept_unknown_senders: true,
      servidor_activo: base.servidor_activo,
    }
  }
  return {
    enabled: cuenta.enabled,
    host: base.host,
    port: base.port,
    username: cuenta.username,
    tiene_password: Boolean(cuenta.password_hash),
    default_provider_id: cuenta.default_provider_id,
    accept_unknown_senders: cuenta.accept_unknown_senders,
    servidor_activo: base.servidor_activo,
    last_used_at: cuenta.last_used_at,
    rotated_at: cuenta.rotated_at,
  }
}

// La guarda vive en src/lib/auth.js (comprueba además que la app siga instalada y corta las
// peticiones cruzadas). Se reexporta para no romper a quien la importe desde aquí.
export { requireLocation }

// ---------------------------------------------------------------------------

export default async function locationRoutes(app) {
  const guard = { preHandler: requireLocation }
  const loc = (req) => req.sesion.locationId

  // Proveedor utilizable por esta subcuenta: propio, o cedido por la agencia.
  const proveedorUsable = async (id, locationId) => {
    const { rows: [p] } = await q(
      `SELECT p.*, (p.owner_scope = 'admin') AS asignado FROM providers p
       WHERE p.id = $1 AND (
         (p.owner_scope = 'location' AND p.location_id = $2)
         OR EXISTS (SELECT 1 FROM provider_assignments a WHERE a.provider_id = p.id AND a.location_id = $2)
       )`,
      [id, locationId]
    )
    return p || null
  }

  const proveedorPropio = async (id, locationId) => {
    const { rows: [p] } = await q(
      `SELECT * FROM providers WHERE id=$1 AND owner_scope='location' AND location_id=$2`,
      [id, locationId]
    )
    return p || null
  }

  // ---------------------------------------------------------------------------
  // Resumen
  // ---------------------------------------------------------------------------
  app.get('/api/loc/resumen', guard, async (req) => {
    const locationId = loc(req)
    const [estados, dias, contadores, ultimos, relay, seguimiento] = await Promise.all([
      q(
        `SELECT status, COUNT(*)::int AS total FROM messages
         WHERE location_id=$1 AND created_at >= now() - interval '7 days' GROUP BY status`,
        [locationId]
      ),
      q(
        `SELECT to_char(d.dia, 'YYYY-MM-DD') AS fecha,
                COUNT(m.id)::int AS total,
                (COUNT(m.id) FILTER (WHERE m.status IN ('entregado','enviado')))::int AS entregados,
                (COUNT(m.id) FILTER (WHERE m.status IN ('rebotado','spam','fallido','suprimido')))::int AS fallidos
         FROM generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') AS d(dia)
         LEFT JOIN messages m ON m.location_id=$1
              AND m.created_at >= date_trunc('day', now()) - interval '6 days'
              AND date_trunc('day', m.created_at) = d.dia
         GROUP BY d.dia ORDER BY d.dia`,
        [locationId]
      ),
      q(
        `SELECT
           (SELECT COUNT(*)::int FROM providers WHERE owner_scope='location' AND location_id=$1) AS proveedores,
           (SELECT COUNT(*)::int FROM provider_assignments WHERE location_id=$1) AS proveedores_cedidos,
           (SELECT COUNT(*)::int FROM senders WHERE location_id=$1) AS remitentes,
           (SELECT COUNT(*)::int FROM templates WHERE location_id=$1 OR location_id IS NULL) AS plantillas,
           (SELECT COUNT(*)::int FROM sender_domains WHERE location_id=$1) AS dominios,
           (SELECT COUNT(*)::int FROM suppressions WHERE location_id=$1) AS supresiones`,
        [locationId]
      ),
      q(
        `SELECT ${COLUMNAS_ENVIO} ${JOINS_ENVIO}
         WHERE m.location_id=$1 ORDER BY m.created_at DESC, m.id DESC LIMIT 5`,
        [locationId]
      ),
      q('SELECT enabled FROM relay_accounts WHERE location_id=$1', [locationId]),
      // SPEC §11.1: el resumen agrega SOLO los eventos reales. Los automáticos (Apple MPP, proxys,
      // escáneres de seguridad) quedan en message_events para auditoría, pero no cuentan aquí.
      q(
        `SELECT
           (COUNT(DISTINCT e.message_id) FILTER (WHERE e.event = 'apertura'))::int AS aperturas,
           (COUNT(DISTINCT e.message_id) FILTER (WHERE e.event = 'clic'))::int AS clics
         FROM message_events e
         JOIN messages m ON m.id = e.message_id
        WHERE m.location_id = $1 AND m.created_at >= now() - interval '7 days' AND NOT e.automatico`,
        [locationId]
      ),
    ])

    const por_estado = {}
    let total = 0
    for (const f of estados.rows) {
      por_estado[f.status] = f.total
      total += f.total
    }
    return {
      dias: 7,
      total,
      por_estado,
      por_dia: dias.rows,
      contadores: contadores.rows[0],
      ultimos: ultimos.rows,
      relay: { activo: Boolean(relay.rows[0]?.enabled) },
      // mensajes distintos con apertura/clic REAL en los últimos 7 días
      seguimiento: seguimiento.rows[0],
    }
  })

  // ---------------------------------------------------------------------------
  // Proveedores
  // ---------------------------------------------------------------------------
  app.get('/api/loc/proveedores', guard, async (req) => {
    const locationId = loc(req)
    const { rows } = await q(
      `SELECT p.id, p.name, p.type, p.config, p.status, p.last_check_at, p.last_error, p.daily_limit,
              p.created_at, p.updated_at, false AS asignado
         FROM providers p
        WHERE p.owner_scope='location' AND p.location_id=$1
       UNION ALL
       SELECT p.id, p.name, p.type, p.config, p.status, p.last_check_at, p.last_error, p.daily_limit,
              p.created_at, p.updated_at, true AS asignado
         FROM provider_assignments a
         JOIN providers p ON p.id = a.provider_id AND p.owner_scope='admin'
        WHERE a.location_id=$1
        ORDER BY asignado, name`,
      [locationId]
    )
    // las credenciales nunca salen: solo se dice que están puestas
    return {
      proveedores: rows.map((p) => ({
        ...p,
        credenciales: { configurado: true },
        webhook_url: urlWebhookDe(p),
      })),
    }
  })

  app.post('/api/loc/proveedores', guard, async (req, reply) => {
    const b = req.body || {}
    const nombre = cabecera(b.name, 120)
    if (!nombre) return malo(reply, 'El nombre del proveedor es obligatorio')
    const tipo = texto(b.type)
    if (!TIPOS_PROVEEDOR.has(tipo)) return malo(reply, 'El tipo de proveedor tiene que ser «smtp» o «brevo»')
    const errCred = validarCredenciales(tipo, b.credentials)
    if (errCred) return malo(reply, errCred)
    const cfg = validarConfig(tipo, b.config)
    if (cfg.error) return malo(reply, cfg.error)
    const limite = validarLimiteDiario(b.daily_limit)
    if (limite.error) return malo(reply, limite.error)

    const { rows: [p] } = await q(
      `INSERT INTO providers (owner_scope, location_id, name, type, credentials_enc, config, daily_limit)
       VALUES ('location',$1,$2,$3,$4,$5::jsonb,$6)
       RETURNING id, name, type, config, status, last_check_at, last_error, daily_limit, created_at, updated_at`,
      [loc(req), nombre, tipo, cifrarCredenciales(b.credentials), JSON.stringify(cfg.valor), limite.valor]
    )
    return reply.code(201).send({ proveedor: { ...p, asignado: false, credenciales: { configurado: true } } })
  })

  app.patch('/api/loc/proveedores/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    const actual = await proveedorPropio(id, loc(req))
    if (!actual) {
      const cedido = await proveedorUsable(id, loc(req))
      if (cedido) return reply.code(403).send({ error: 'Este proveedor lo gestiona la agencia: no puedes editarlo' })
      return reply.code(404).send({ error: 'Proveedor no encontrado' })
    }
    const b = req.body || {}
    if (b.type !== undefined && texto(b.type) !== actual.type) {
      return malo(reply, 'No se puede cambiar el tipo de un proveedor: crea uno nuevo')
    }

    const campos = []
    const params = []
    const set = (sql, valor) => {
      params.push(valor)
      campos.push(`${sql} = $${params.length}`)
    }

    if (b.name !== undefined) {
      const nombre = cabecera(b.name, 120)
      if (!nombre) return malo(reply, 'El nombre del proveedor es obligatorio')
      set('name', nombre)
    }
    if (b.config !== undefined) {
      const cfg = validarConfig(actual.type, b.config)
      if (cfg.error) return malo(reply, cfg.error)
      params.push(JSON.stringify(cfg.valor))
      campos.push(`config = $${params.length}::jsonb`)
    }
    if (b.daily_limit !== undefined) {
      const limite = validarLimiteDiario(b.daily_limit)
      if (limite.error) return malo(reply, limite.error)
      set('daily_limit', limite.valor)
    }
    // credenciales opcionales: si no vienen, se conservan las guardadas
    if (b.credentials !== undefined && b.credentials !== null) {
      const errCred = validarCredenciales(actual.type, b.credentials)
      if (errCred) return malo(reply, errCred)
      set('credentials_enc', cifrarCredenciales(b.credentials))
      campos.push(`status = 'sin_probar'`, `last_error = NULL`, `last_check_at = NULL`)
    }
    if (!campos.length) return malo(reply, 'No hay nada que actualizar')

    params.push(id)
    const { rows: [p] } = await q(
      `UPDATE providers SET ${campos.join(', ')}, updated_at = now() WHERE id = $${params.length}
       RETURNING id, name, type, config, status, last_check_at, last_error, daily_limit, created_at, updated_at`,
      params
    )
    return { proveedor: { ...p, asignado: false, credenciales: { configurado: true } } }
  })

  app.delete('/api/loc/proveedores/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    const actual = await proveedorPropio(id, loc(req))
    if (!actual) {
      const cedido = await proveedorUsable(id, loc(req))
      if (cedido) return reply.code(403).send({ error: 'Este proveedor lo gestiona la agencia: no puedes eliminarlo' })
      return reply.code(404).send({ error: 'Proveedor no encontrado' })
    }
    const { rows: [uso] } = await q(
      `SELECT (SELECT COUNT(*)::int FROM senders WHERE provider_id=$1) AS remitentes,
              (SELECT COUNT(*)::int FROM messages WHERE provider_id=$1
                 AND status IN ('encolado','reintento','enviando')) AS en_cola`,
      [id]
    )
    if (uso.remitentes > 0) {
      return reply.code(409).send({
        error: `No se puede eliminar: hay ${uso.remitentes} remitente(s) usando este proveedor. Cámbialos de proveedor primero.`,
      })
    }
    if (uso.en_cola > 0) {
      return reply.code(409).send({ error: `No se puede eliminar: hay ${uso.en_cola} mensaje(s) en cola con este proveedor.` })
    }
    await q('DELETE FROM providers WHERE id=$1', [id])
    return { ok: true }
  })

  app.post('/api/loc/proveedores/:id/probar', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    const locationId = loc(req)
    // SOLO proveedores propios: probar uno cedido por la agencia ejercitaría sus credenciales,
    // devolvería los datos de su cuenta y, sobre todo, escribiría status/last_error en una fila
    // que leen TODAS las demás subcuentas que lo tienen cedido.
    const prov = await proveedorPropio(id, locationId)
    if (!prov) {
      const cedido = await proveedorUsable(id, locationId)
      if (cedido) {
        return reply.code(403).send({ error: 'Este proveedor lo gestiona la agencia: es ella quien puede probarlo' })
      }
      return reply.code(404).send({ error: 'Proveedor no encontrado' })
    }
    if (!(await limitar(`probar:${locationId}`, 20, 60))) {
      return reply.code(429).send({ error: 'Demasiadas pruebas seguidas. Espera un minuto.' })
    }
    if (prov.type === 'smtp' && !(await destinoPermitido(prov.config?.host))) {
      return malo(reply, 'El servidor SMTP configurado apunta a una dirección de red interna y no se puede probar')
    }

    const integracion = await cargarProveedor(prov.type)
    if (!integracion) {
      return reply.code(501).send({ error: `Todavía no hay integración disponible para el tipo «${prov.type}»` })
    }

    let resultado
    try {
      const credenciales = descifrarCredenciales(prov.credentials_enc)
      const r = await integracion.validar(credenciales, prov.config || {})
      resultado = { ok: r?.ok !== false, detalle: texto(r?.detalle) || 'Conexión correcta', cuenta: r?.cuenta ?? null }
    } catch (err) {
      // nunca se registra el error con las credenciales dentro: solo el mensaje del proveedor
      resultado = { ok: false, detalle: texto(err?.message) || 'No se pudo conectar con el proveedor', cuenta: null }
    }

    await q(
      `UPDATE providers SET status=$1, last_check_at=now(), last_error=$2, updated_at=now() WHERE id=$3`,
      [resultado.ok ? 'ok' : 'error', resultado.ok ? null : resultado.detalle.slice(0, 500), id]
    )
    return resultado
  })

  // ---------------------------------------------------------------------------
  // Remitentes
  // ---------------------------------------------------------------------------
  app.get('/api/loc/remitentes', guard, async (req) => {
    const { rows } = await q(
      `SELECT s.*, p.name AS proveedor_nombre, p.type AS proveedor_tipo
         FROM senders s LEFT JOIN providers p ON p.id = s.provider_id
        WHERE s.location_id=$1 ORDER BY s.is_default DESC, s.email`,
      [loc(req)]
    )
    return { remitentes: rows }
  })

  app.post('/api/loc/remitentes', guard, async (req, reply) => {
    const locationId = loc(req)
    const b = req.body || {}
    const email = texto(b.email).toLowerCase()
    if (!esEmail(email)) return malo(reply, 'El correo del remitente no es válido')
    const nombre = cabecera(b.name, MAX_NOMBRE)
    if (!nombre) return malo(reply, 'El nombre visible del remitente es obligatorio')
    const replyTo = b.reply_to ? cabecera(b.reply_to, 320) : null
    if (replyTo && !esEmail(replyTo)) return malo(reply, 'La dirección de respuesta no es válida')
    const providerId = idDe(b.provider_id)
    if (!providerId) return malo(reply, 'Elige el proveedor por el que saldrá este remitente')
    if (!(await proveedorUsable(providerId, locationId))) {
      return malo(reply, 'Ese proveedor no existe o no está disponible para tu subcuenta')
    }
    // aislamiento entre clientes de la agencia: mismo criterio que POST /api/loc/dominios
    if (await dominioAjenoVerificado(email, locationId)) {
      return reply.code(409).send({ error: ERROR_DOMINIO_AJENO })
    }
    const porDefecto = Boolean(b.is_default)

    try {
      // solo puede haber un remitente por defecto por subcuenta (índice parcial único)
      if (porDefecto) {
        await q('UPDATE senders SET is_default=false, updated_at=now() WHERE location_id=$1 AND is_default', [locationId])
      }
      const { rows: [s] } = await q(
        `INSERT INTO senders (location_id, provider_id, email, name, reply_to, is_default, origin)
         VALUES ($1,$2,$3,$4,$5,$6,'panel') RETURNING *`,
        [locationId, providerId, email, nombre, replyTo, porDefecto]
      )
      return reply.code(201).send({ remitente: s })
    } catch (err) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Ya tienes un remitente con ese correo' })
      throw err
    }
  })

  app.patch('/api/loc/remitentes/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de remitente no válido')
    const locationId = loc(req)
    const { rows: [actual] } = await q('SELECT * FROM senders WHERE id=$1 AND location_id=$2', [id, locationId])
    if (!actual) return reply.code(404).send({ error: 'Remitente no encontrado' })

    const b = req.body || {}
    const campos = []
    const params = []
    const set = (columna, valor) => {
      params.push(valor)
      campos.push(`${columna} = $${params.length}`)
    }

    if (b.email !== undefined) {
      const email = texto(b.email).toLowerCase()
      if (!esEmail(email)) return malo(reply, 'El correo del remitente no es válido')
      // se comprueba también al editar: si no, se daba de alta un correo propio y luego se cambiaba
      if (await dominioAjenoVerificado(email, locationId)) {
        return reply.code(409).send({ error: ERROR_DOMINIO_AJENO })
      }
      set('email', email)
    }
    if (b.name !== undefined) {
      const nombre = cabecera(b.name, MAX_NOMBRE)
      if (!nombre) return malo(reply, 'El nombre visible del remitente es obligatorio')
      set('name', nombre)
    }
    if (b.reply_to !== undefined) {
      const replyTo = b.reply_to ? cabecera(b.reply_to, 320) : null
      if (replyTo && !esEmail(replyTo)) return malo(reply, 'La dirección de respuesta no es válida')
      set('reply_to', replyTo)
    }
    if (b.provider_id !== undefined) {
      const providerId = idDe(b.provider_id)
      if (!providerId) return malo(reply, 'El proveedor indicado no es válido')
      if (!(await proveedorUsable(providerId, locationId))) {
        return malo(reply, 'Ese proveedor no existe o no está disponible para tu subcuenta')
      }
      set('provider_id', providerId)
    }
    if (b.is_default !== undefined) {
      if (b.is_default) {
        await q(
          'UPDATE senders SET is_default=false, updated_at=now() WHERE location_id=$1 AND is_default AND id<>$2',
          [locationId, id]
        )
      }
      set('is_default', Boolean(b.is_default))
    }
    if (!campos.length) return malo(reply, 'No hay nada que actualizar')

    params.push(id, locationId)
    try {
      const { rows: [s] } = await q(
        `UPDATE senders SET ${campos.join(', ')}, updated_at=now()
         WHERE id=$${params.length - 1} AND location_id=$${params.length} RETURNING *`,
        params
      )
      return { remitente: s }
    } catch (err) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Ya tienes un remitente con ese correo' })
      throw err
    }
  })

  app.delete('/api/loc/remitentes/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de remitente no válido')
    const locationId = loc(req)
    const { rows: [existe] } = await q('SELECT id FROM senders WHERE id=$1 AND location_id=$2', [id, locationId])
    if (!existe) return reply.code(404).send({ error: 'Remitente no encontrado' })

    // messages.sender_id es ON DELETE SET NULL: borrar un remitente con envíos vivos los deja sin
    // remitente y el worker los mata con «El remitente ... ya no existe». Se corta igual que en el
    // borrado de proveedores para no perder correo que la app ya había aceptado.
    const { rows: [uso] } = await q(
      `SELECT COUNT(*)::int AS en_cola FROM messages
        WHERE sender_id=$1 AND status IN ('encolado','reintento','enviando')`,
      [id]
    )
    if (uso.en_cola > 0) {
      return reply.code(409).send({ error: `No se puede eliminar: hay ${uso.en_cola} mensaje(s) en cola con este remitente.` })
    }
    await q('DELETE FROM senders WHERE id=$1 AND location_id=$2', [id, locationId])
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // Plantillas (las globales de la agencia se ven pero no se tocan)
  // ---------------------------------------------------------------------------
  app.get('/api/loc/plantillas', guard, async (req) => {
    const { rows } = await q(
      `SELECT id, location_id, name, subject, preheader, html, text, variables, created_at, updated_at,
              (location_id IS NULL) AS global
         FROM templates WHERE location_id=$1 OR location_id IS NULL
        ORDER BY global, name`,
      [loc(req)]
    )
    return { plantillas: rows }
  })

  const leerPlantilla = (b, { parcial = false } = {}) => {
    const datos = {}
    if (!parcial || b.name !== undefined) {
      const nombre = cabecera(b.name, 120)
      if (!nombre) return { error: 'El nombre de la plantilla es obligatorio' }
      datos.name = nombre
    }
    if (!parcial || b.subject !== undefined) {
      const asunto = cabecera(b.subject, MAX_ASUNTO)
      if (!asunto) return { error: 'El asunto es obligatorio' }
      datos.subject = asunto
    }
    if (!parcial || b.preheader !== undefined) {
      datos.preheader = b.preheader ? cabecera(b.preheader, MAX_ASUNTO) : null
    }
    if (!parcial || b.html !== undefined) {
      const html = String(b.html ?? '')
      if (!html.trim()) return { error: 'El cuerpo HTML es obligatorio' }
      if (html.length > MAX_HTML) return { error: 'El cuerpo HTML es demasiado grande' }
      datos.html = html
    }
    if (!parcial || b.text !== undefined) {
      const plano = b.text === null || b.text === undefined ? null : String(b.text)
      if (plano && plano.length > MAX_HTML) return { error: 'La versión en texto es demasiado grande' }
      datos.text = plano
    }
    if (!parcial || b.variables !== undefined) {
      const vars = b.variables ?? []
      if (!Array.isArray(vars) || vars.length > 100) return { error: 'La lista de variables no es válida' }
      const limpias = vars.map((v) => texto(v).slice(0, 80)).filter(Boolean)
      datos.variables = limpias
    }
    return { datos }
  }

  app.post('/api/loc/plantillas', guard, async (req, reply) => {
    const r = leerPlantilla(req.body || {})
    if (r.error) return malo(reply, r.error)
    const d = r.datos
    const { rows: [t] } = await q(
      `INSERT INTO templates (location_id, name, subject, preheader, html, text, variables)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *, false AS global`,
      [loc(req), d.name, d.subject, d.preheader, d.html, d.text, JSON.stringify(d.variables)]
    )
    return reply.code(201).send({ plantilla: t })
  })

  app.patch('/api/loc/plantillas/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de plantilla no válido')
    const { rows: [actual] } = await q('SELECT id, location_id FROM templates WHERE id=$1', [id])
    if (!actual) return reply.code(404).send({ error: 'Plantilla no encontrada' })
    if (actual.location_id === null) {
      return reply.code(403).send({ error: 'Las plantillas globales solo las edita la agencia' })
    }
    if (actual.location_id !== loc(req)) return reply.code(404).send({ error: 'Plantilla no encontrada' })

    const r = leerPlantilla(req.body || {}, { parcial: true })
    if (r.error) return malo(reply, r.error)
    const claves = Object.keys(r.datos)
    if (!claves.length) return malo(reply, 'No hay nada que actualizar')

    const params = []
    const campos = claves.map((k) => {
      params.push(k === 'variables' ? JSON.stringify(r.datos[k]) : r.datos[k])
      return `${k} = $${params.length}${k === 'variables' ? '::jsonb' : ''}`
    })
    params.push(id, loc(req))
    const { rows: [t] } = await q(
      `UPDATE templates SET ${campos.join(', ')}, updated_at=now()
       WHERE id=$${params.length - 1} AND location_id=$${params.length} RETURNING *, false AS global`,
      params
    )
    return { plantilla: t }
  })

  app.delete('/api/loc/plantillas/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de plantilla no válido')
    const { rows: [actual] } = await q('SELECT id, location_id FROM templates WHERE id=$1', [id])
    if (!actual) return reply.code(404).send({ error: 'Plantilla no encontrada' })
    if (actual.location_id === null) {
      return reply.code(403).send({ error: 'Las plantillas globales solo las elimina la agencia' })
    }
    if (actual.location_id !== loc(req)) return reply.code(404).send({ error: 'Plantilla no encontrada' })
    await q('DELETE FROM templates WHERE id=$1 AND location_id=$2', [id, loc(req)])
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // Envíos
  // ---------------------------------------------------------------------------
  app.get('/api/loc/envios', guard, async (req, reply) => {
    const where = ['m.location_id = $1']
    const params = [loc(req)]
    const err = filtrosEnvios(req.query, where, params)
    if (err) return malo(reply, err)

    const { limite, pagina, offset } = paginar(req.query)
    const filtro = where.join(' AND ')
    const [filas, total] = await Promise.all([
      q(
        `SELECT ${COLUMNAS_ENVIO} ${JOINS_ENVIO} WHERE ${filtro}
         ORDER BY m.created_at DESC, m.id DESC LIMIT ${limite} OFFSET ${offset}`,
        params
      ),
      q(`SELECT COUNT(*)::int AS n FROM messages m WHERE ${filtro}`, params),
    ])
    return {
      envios: filas.rows,
      total: total.rows[0].n,
      pagina,
      limite,
      paginas: Math.max(1, Math.ceil(total.rows[0].n / limite)),
    }
  })

  app.get('/api/loc/envios/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de envío no válido')
    const { rows: [envio] } = await q(
      `SELECT m.*, s.email AS remitente_email, s.name AS remitente_nombre,
              p.name AS proveedor_nombre, p.type AS proveedor_tipo, t.name AS plantilla_nombre
         FROM messages m
         LEFT JOIN senders s ON s.id = m.sender_id
         LEFT JOIN providers p ON p.id = m.provider_id
         LEFT JOIN templates t ON t.id = m.template_id
        WHERE m.id=$1 AND m.location_id=$2`,
      [id, loc(req)]
    )
    if (!envio) return reply.code(404).send({ error: 'Envío no encontrado' })
    // `automatico` viaja por evento para que el panel pinte el badge gris «automático», y los
    // agregados de aperturas/clics cuentan SOLO los reales (SPEC §11.1).
    const [{ rows: eventos }, { rows: [seguimiento] }] = await Promise.all([
      q(
        `SELECT id, event, occurred_at, data, automatico, created_at FROM message_events
          WHERE message_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT 200`,
        [id]
      ),
      q(
        `SELECT
           (COUNT(*) FILTER (WHERE event = 'apertura' AND NOT automatico))::int AS aperturas,
           (COUNT(*) FILTER (WHERE event = 'clic' AND NOT automatico))::int AS clics,
           (COUNT(*) FILTER (WHERE event = 'apertura' AND automatico))::int AS aperturas_automaticas,
           (COUNT(*) FILTER (WHERE event = 'clic' AND automatico))::int AS clics_automaticos
         FROM message_events WHERE message_id=$1`,
        [id]
      ),
    ])
    return { envio, eventos, seguimiento }
  })

  // ---------------------------------------------------------------------------
  // Supresiones
  // ---------------------------------------------------------------------------
  app.get('/api/loc/supresiones', guard, async (req, reply) => {
    const where = ['location_id = $1']
    const params = [loc(req)]
    const busqueda = texto(req.query?.q)
    if (busqueda) {
      if (busqueda.length > 200) return malo(reply, 'La búsqueda es demasiado larga')
      params.push(`%${busqueda.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
      where.push(`email::text ILIKE $${params.length} ESCAPE '\\'`)
    }
    const motivo = texto(req.query?.reason)
    if (motivo) {
      if (!MOTIVOS_SUPRESION.has(motivo)) return malo(reply, 'Ese motivo de supresión no existe')
      params.push(motivo)
      where.push(`reason = $${params.length}`)
    }
    const { limite, pagina, offset } = paginar(req.query)
    const filtro = where.join(' AND ')
    const [filas, total] = await Promise.all([
      q(
        `SELECT id, email, reason, source, created_at FROM suppressions WHERE ${filtro}
         ORDER BY created_at DESC, id DESC LIMIT ${limite} OFFSET ${offset}`,
        params
      ),
      q(`SELECT COUNT(*)::int AS n FROM suppressions WHERE ${filtro}`, params),
    ])
    return { supresiones: filas.rows, total: total.rows[0].n, pagina, limite }
  })

  app.post('/api/loc/supresiones', guard, async (req, reply) => {
    const b = req.body || {}
    const email = texto(b.email).toLowerCase()
    if (!esEmail(email)) return malo(reply, 'El correo no es válido')
    const motivo = texto(b.reason) || 'manual'
    if (!MOTIVOS_SUPRESION.has(motivo)) return malo(reply, 'Ese motivo de supresión no existe')
    const { rows: [s] } = await q(
      `INSERT INTO suppressions (location_id, email, reason, source) VALUES ($1,$2,$3,'panel')
       ON CONFLICT (location_id, email) DO UPDATE SET reason = EXCLUDED.reason
       RETURNING id, email, reason, source, created_at`,
      [loc(req), email, motivo]
    )
    return reply.code(201).send({ supresion: s })
  })

  app.delete('/api/loc/supresiones/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de supresión no válido')
    const { rowCount } = await q('DELETE FROM suppressions WHERE id=$1 AND location_id=$2', [id, loc(req)])
    if (!rowCount) return reply.code(404).send({ error: 'Esa supresión no existe' })
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // Rebotados (SPEC §12): los rebotes duros convertidos en acciones sobre el
  // contacto de GHL (DND del canal Email, nunca el DND global)
  // ---------------------------------------------------------------------------

  // aplicarDnd (lib/dnd.js) ya guarda dnd_at/dnd_error en la fila; aquí solo se normaliza su
  // respuesta para que un fallo inesperado no tumbe el endpoint con un 500 sin mensaje.
  // Se conserva el ghl_contact_id que aplicarDnd resuelve: el panel lo usa para habilitar el
  // botón «Ficha en GHL» sin tener que recargar la lista.
  const ejecutarDnd = async (fila) => {
    try {
      const r = await aplicarDnd(fila)
      if (r?.ok) return { ok: true, dnd_at: r.dnd_at ?? null, ghl_contact_id: r.ghl_contact_id ?? null }
      return { ok: false, error: texto(r?.error) || 'No se pudo activar el DND en GHL' }
    } catch (err) {
      return { ok: false, error: texto(err?.message) || 'No se pudo activar el DND en GHL' }
    }
  }

  app.get('/api/loc/rebotados', guard, async (req, reply) => {
    const where = ['s.location_id = $1', `s.reason = 'rebote_duro'`]
    const params = [loc(req)]
    const err = filtrosRebotados(req.query, where, params)
    if (err) return malo(reply, err)

    const { limite, pagina, offset } = paginar(req.query)
    const filtro = where.join(' AND ')
    const [filas, total] = await Promise.all([
      q(
        `SELECT ${COLUMNAS_REBOTADO}
           FROM suppressions s ${SQL_ULTIMO_REBOTE}
          WHERE ${filtro}
          ORDER BY s.created_at DESC, s.id DESC LIMIT ${limite} OFFSET ${offset}`,
        params
      ),
      q(`SELECT COUNT(*)::int AS n FROM suppressions s WHERE ${filtro}`, params),
    ])
    return {
      rebotados: filas.rows.map(filaRebotado),
      total: total.rows[0].n,
      pagina,
      limite,
      paginas: Math.max(1, Math.ceil(total.rows[0].n / limite)),
    }
  })

  // CSV pensado para reimportar en GHL. Acepta los mismos filtros que la lista: lo que se ve
  // en pantalla es lo que se descarga.
  app.get('/api/loc/rebotados/exportar', guard, async (req, reply) => {
    const where = ['s.location_id = $1', `s.reason = 'rebote_duro'`]
    const params = [loc(req)]
    const err = filtrosRebotados(req.query, where, params)
    if (err) return malo(reply, err)

    const { rows } = await q(
      `SELECT ${COLUMNAS_REBOTADO}
         FROM suppressions s ${SQL_ULTIMO_REBOTE}
        WHERE ${where.join(' AND ')}
        ORDER BY s.created_at DESC, s.id DESC`,
      params
    )
    const lineas = [['email', 'motivo', 'fecha', 'contacto_ghl', 'dnd', 'ultimo_asunto'].join(',')]
    for (const f of rows) {
      lineas.push([
        campoCsv(f.email),
        campoCsv(f.source || 'rebote_duro'),
        campoCsv(f.created_at ? new Date(f.created_at).toISOString() : ''),
        campoCsv(f.ghl_contact_id),
        campoCsv(f.dnd_at ? new Date(f.dnd_at).toISOString() : ''),
        campoCsv(f.mensaje_asunto),
      ].join(','))
    }
    // El BOM delante hace que Excel abra el UTF-8 con los acentos bien (SPEC §12.3)
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename="rebotados.csv"')
      .header('cache-control', 'no-store')
      .send(BOM_UTF8 + lineas.join('\r\n') + '\r\n')
  })

  app.post('/api/loc/rebotados/:id/dnd', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de rebotado no válido')
    const locationId = loc(req)
    const { rows: [fila] } = await q(
      'SELECT * FROM suppressions WHERE id=$1 AND location_id=$2',
      [id, locationId]
    )
    if (!fila) return reply.code(404).send({ error: 'Ese rebotado no existe' })
    if (fila.reason !== 'rebote_duro') {
      return malo(reply, 'Esa supresión no es un rebote duro: el DND solo se activa desde Rebotados')
    }
    // idempotente: si el DND ya está puesto, no se vuelve a llamar a GHL
    if (fila.dnd_at) return { ok: true, dnd_at: fila.dnd_at, ghl_contact_id: fila.ghl_contact_id ?? null }
    if (!(await limitar(`dnd:${locationId}`, 30, 60))) {
      return reply.code(429).send({ error: 'Demasiadas activaciones seguidas. Espera un minuto.' })
    }

    const r = await ejecutarDnd(fila)
    if (!r.ok) return { ok: false, error: r.error }
    let dndAt = r.dnd_at
    if (!dndAt) {
      const { rows: [tras] } = await q('SELECT dnd_at FROM suppressions WHERE id=$1', [id])
      dndAt = tras?.dnd_at ?? null
    }
    // El SPEC §12.3 define el mínimo {ok, dnd_at}; el ghl_contact_id recién resuelto se añade para
    // que la fila del panel active «Ficha en GHL» al momento (el frontend ya lo consume).
    return { ok: true, dnd_at: dndAt, ghl_contact_id: r.ghl_contact_id ?? fila.ghl_contact_id ?? null }
  })

  app.post('/api/loc/rebotados/dnd-masivo', guard, async (req) => {
    const locationId = loc(req)
    // Se descartan las filas cuyo último intento falló por falta de conexión con GHL: hasta que la
    // subcuenta no reconecte la app, reintentarlas en masa es machacar 100 veces el mismo fallo.
    // (El botón individual sí las reintenta, por si la conexión acaba de volver.)
    const sinConexion = `(s.dnd_error IS NULL OR s.dnd_error NOT ILIKE '%conexi%')`
    // Las filas nunca intentadas van SIEMPRE por delante de las que ya fallaron: si el lote se
    // ordenara solo por fecha, 100 fallos persistentes antiguos (p. ej. «No existe ningún contacto
    // en GHL con ese correo») coparían todas las pasadas y las pendientes nuevas no se intentarían
    // jamás. Los fallos previos solo rellenan el hueco que dejen las nuevas.
    const { rows: pendientes } = await q(
      `SELECT s.* FROM suppressions s
        WHERE s.location_id=$1 AND s.reason='rebote_duro' AND s.dnd_at IS NULL AND ${sinConexion}
        ORDER BY (s.dnd_error IS NOT NULL), s.created_at, s.id LIMIT ${LOTE_DND}`,
      [locationId]
    )

    let correctos = 0
    let fallidos = 0
    for (let i = 0; i < pendientes.length; i++) {
      const r = await ejecutarDnd(pendientes[i])
      if (r.ok) correctos++
      else fallidos++
      if (i < pendientes.length - 1) await pausa(PAUSA_DND_MS)
    }

    // «restantes» guía el bucle del panel (repite mientras > 0): cuenta SOLO lo nunca intentado.
    // Queda fuera TODA fila con dnd_error —las de este lote y las de lotes anteriores, que
    // ejecutarDnd deja siempre marcadas—, porque si contaran, un puñado de fallos persistentes
    // mantendría «Quedan N pendientes» para siempre. Los fallos se reintentan en la siguiente
    // pulsación manual del botón masivo o fila a fila.
    const { rows: [restantes] } = await q(
      `SELECT COUNT(*)::int AS n FROM suppressions s
        WHERE s.location_id=$1 AND s.reason='rebote_duro' AND s.dnd_at IS NULL AND s.dnd_error IS NULL`,
      [locationId]
    )

    return {
      procesados: pendientes.length,
      correctos,
      fallidos,
      restantes: restantes.n,
    }
  })

  // ---------------------------------------------------------------------------
  // Preferencias de la subcuenta (SPEC §12.3): de momento solo el auto-DND
  // ---------------------------------------------------------------------------
  app.get('/api/loc/preferencias', guard, async (req) => {
    const { rows: [p] } = await q('SELECT auto_dnd FROM location_settings WHERE location_id=$1', [loc(req)])
    return { auto_dnd: Boolean(p?.auto_dnd) }
  })

  app.patch('/api/loc/preferencias', guard, async (req, reply) => {
    const b = req.body || {}
    if (b.auto_dnd === undefined) return malo(reply, 'No hay nada que actualizar')
    if (typeof b.auto_dnd !== 'boolean') return malo(reply, 'El valor de «auto_dnd» tiene que ser verdadero o falso')
    const { rows: [p] } = await q(
      `INSERT INTO location_settings (location_id, auto_dnd) VALUES ($1,$2)
       ON CONFLICT (location_id) DO UPDATE SET auto_dnd=EXCLUDED.auto_dnd, updated_at=now()
       RETURNING auto_dnd`,
      [loc(req), b.auto_dnd]
    )
    return { auto_dnd: p.auto_dnd }
  })

  // ---------------------------------------------------------------------------
  // Dominios (la verificación es el guardarraíl del relay: un dominio verificado
  // pertenece a UNA sola subcuenta)
  // ---------------------------------------------------------------------------
  const serializarDominio = (d) => ({
    id: d.id,
    domain: d.domain,
    verified: d.verified,
    verified_at: d.verified_at,
    created_at: d.created_at,
    registro_txt: `${TXT_SUBDOMINIO}.${d.domain}`,
    valor_txt: d.verify_token ? `${TXT_PREFIJO}${d.verify_token}` : null,
  })

  // Además de las filas de sender_domains, se devuelven los dominios que la subcuenta usa de
  // verdad en sus remitentes: la pantalla se construye a partir de ELLOS (sin campo libre), así
  // que aquí viaja todo lo que necesita en una sola llamada.
  app.get('/api/loc/dominios', guard, async (req) => {
    const locationId = loc(req)
    const [dominios, remitentes] = await Promise.all([
      q('SELECT * FROM sender_domains WHERE location_id=$1 ORDER BY verified DESC, domain', [locationId]),
      q(
        `SELECT lower(split_part(email::text, '@', 2)) AS domain, COUNT(*)::int AS remitentes
           FROM senders WHERE location_id=$1 GROUP BY 1 ORDER BY 1`,
        [locationId]
      ),
    ])
    return {
      dominios: dominios.rows.map(serializarDominio),
      dominios_remitentes: remitentes.rows.map((f) => ({
        domain: f.domain,
        remitentes: f.remitentes,
        gratuito: esDominioGratuito(f.domain),
      })),
    }
  })

  app.post('/api/loc/dominios', guard, async (req, reply) => {
    const locationId = loc(req)
    const b = req.body || {}
    let dominio = texto(b.dominio || b.domain).toLowerCase()
    dominio = dominio.replace(/^[a-z]+:\/\//, '').split('/')[0].split('@').pop().replace(/\.$/, '')
    if (!RE_DOMINIO.test(dominio)) return malo(reply, 'Ese dominio no es válido')
    if (esDominioGratuito(dominio)) {
      return malo(
        reply,
        'Los dominios de correo gratuito (Gmail, Outlook…) no se pueden verificar: no son de nadie en particular y tus envíos funcionan igual sin este paso'
      )
    }
    // Solo dominios que la subcuenta usa de verdad: sin esto, cualquiera podía dar de alta el
    // dominio de otro cliente «por si acaso» y llenar el sistema de reclamaciones que no le
    // corresponden (nunca podría verificarlas sin el DNS, pero ni el ruido ni el intento se quieren).
    const { rows: [mio] } = await q(
      `SELECT 1 FROM senders WHERE location_id=$1 AND lower(split_part(email::text, '@', 2)) = $2 LIMIT 1`,
      [locationId, dominio]
    )
    if (!mio) {
      return malo(
        reply,
        'Solo puedes verificar dominios que ya uses en tus remitentes. Crea primero un remitente con un correo de ese dominio.'
      )
    }

    const { rows: [ajeno] } = await q(
      'SELECT 1 FROM sender_domains WHERE domain=$1 AND verified AND location_id<>$2',
      [dominio, locationId]
    )
    if (ajeno) return reply.code(409).send({ error: 'Ese dominio ya está verificado por otra subcuenta' })

    try {
      const { rows: [d] } = await q(
        'INSERT INTO sender_domains (location_id, domain, verify_token) VALUES ($1,$2,$3) RETURNING *',
        [locationId, dominio, randomToken(16)]
      )
      return reply.code(201).send({ dominio: serializarDominio(d) })
    } catch (err) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Ese dominio ya está dado de alta' })
      throw err
    }
  })

  // Quitar un dominio solo renuncia a su exclusividad (deja de bloquear a otras subcuentas):
  // no toca remitentes ni envíos, así que se permite incluso verificado.
  app.delete('/api/loc/dominios/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de dominio no válido')
    const { rowCount } = await q('DELETE FROM sender_domains WHERE id=$1 AND location_id=$2', [id, loc(req)])
    if (!rowCount) return reply.code(404).send({ error: 'Dominio no encontrado' })
    return { ok: true }
  })

  app.post('/api/loc/dominios/:id/verificar', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de dominio no válido')
    const locationId = loc(req)
    const { rows: [d] } = await q('SELECT * FROM sender_domains WHERE id=$1 AND location_id=$2', [id, locationId])
    if (!d) return reply.code(404).send({ error: 'Dominio no encontrado' })
    if (d.verified) return { ok: true, verificado: true, detalle: 'Este dominio ya estaba verificado', dominio: serializarDominio(d) }
    if (!d.verify_token) return reply.code(409).send({ error: 'Este dominio no tiene token de verificación: vuelve a darlo de alta' })
    if (!(await limitar(`dnsver:${locationId}`, 30, 60))) {
      return reply.code(429).send({ error: 'Demasiadas comprobaciones seguidas. Espera un minuto.' })
    }

    const esperado = `${TXT_PREFIJO}${d.verify_token}`
    // se acepta el TXT en el subdominio dedicado o en la raíz del dominio: los paneles de DNS
    // varían mucho y publicar en la raíz es lo más habitual
    let encontrado = false
    let ultimoFallo = ''
    for (const nombre of [`${TXT_SUBDOMINIO}.${d.domain}`, d.domain]) {
      try {
        const registros = await dns.resolveTxt(nombre)
        if (registros.some((partes) => partes.join('').trim() === esperado)) {
          encontrado = true
          break
        }
      } catch (err) {
        ultimoFallo = err?.code || err?.message || ''
      }
    }
    if (!encontrado) {
      return reply.code(409).send({
        ok: false,
        verificado: false,
        error: `Todavía no se ve el registro TXT «${esperado}» en ${TXT_SUBDOMINIO}.${d.domain} (ni en ${d.domain}). Los cambios de DNS pueden tardar hasta 24 h.${
          ultimoFallo ? ` [${ultimoFallo}]` : ''
        }`,
      })
    }

    try {
      const { rows: [actualizado] } = await q(
        'UPDATE sender_domains SET verified=true, verified_at=now() WHERE id=$1 AND location_id=$2 RETURNING *',
        [id, locationId]
      )
      return { ok: true, verificado: true, detalle: 'Dominio verificado', dominio: serializarDominio(actualizado) }
    } catch (err) {
      // índice único parcial: otra subcuenta se adelantó a verificar el mismo dominio
      if (err?.code === '23505') {
        return reply.code(409).send({ error: 'Ese dominio acaba de ser verificado por otra subcuenta' })
      }
      throw err
    }
  })

  // ---------------------------------------------------------------------------
  // Dominio de tracking (SPEC §11.3): el pixel y los enlaces reescritos salen por un
  // CNAME del cliente (link.sudominio.com → host de la app) en vez del dominio compartido.
  // Un dominio por subcuenta y un dominio para una sola subcuenta (dos UNIQUE en la tabla).
  // ---------------------------------------------------------------------------
  const serializarDominioTracking = (d) => ({
    id: d.id,
    domain: d.domain,
    verified: d.verified,
    verified_at: d.verified_at,
    created_at: d.created_at,
    registro_cname: d.domain, // el nombre del registro CNAME es el propio dominio elegido
    destino_cname: hostApp(), // y su valor, el host público de la app
    // El TXT de propiedad no puede vivir en el mismo nombre que el CNAME (DNS no admite otros
    // registros junto a un CNAME): va en el subdominio dedicado _disruptivo-verify.<dominio>.
    registro_txt: `${TXT_SUBDOMINIO}.${d.domain}`,
    valor_txt: d.verify_token ? `${TXT_PREFIJO}${d.verify_token}` : null,
  })

  app.get('/api/loc/dominios-tracking', guard, async (req) => {
    const { rows } = await q('SELECT * FROM tracking_domains WHERE location_id=$1 ORDER BY id', [loc(req)])
    return { dominios: rows.map(serializarDominioTracking), destino_cname: hostApp() }
  })

  app.post('/api/loc/dominios-tracking', guard, async (req, reply) => {
    const b = req.body || {}
    let dominio = texto(b.dominio || b.domain).toLowerCase()
    dominio = dominio.replace(/^[a-z]+:\/\//, '').split('/')[0].split('@').pop().replace(/\.$/, '')
    if (!RE_DOMINIO.test(dominio)) return malo(reply, 'Ese dominio no es válido')
    if (dominio === hostApp()) {
      return malo(reply, 'Ese es el dominio de la propia app: usa un subdominio tuyo, por ejemplo link.tudominio.com')
    }

    try {
      const { rows: [d] } = await q(
        'INSERT INTO tracking_domains (location_id, domain, verify_token) VALUES ($1,$2,$3) RETURNING *',
        [loc(req), dominio, randomToken(16)]
      )
      return reply.code(201).send({ dominio: serializarDominioTracking(d) })
    } catch (err) {
      if (err?.code === '23505') {
        // la tabla tiene dos UNIQUE: se distingue cuál saltó mirando si esta subcuenta ya tiene uno
        const { rows: [mio] } = await q('SELECT 1 FROM tracking_domains WHERE location_id=$1', [loc(req)])
        return reply.code(409).send({
          error: mio
            ? 'Tu subcuenta ya tiene un dominio de tracking: elimínalo antes de añadir otro'
            : 'Ese dominio de tracking ya lo usa otra subcuenta',
        })
      }
      throw err
    }
  })

  app.post('/api/loc/dominios-tracking/:id/verificar', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de dominio no válido')
    const locationId = loc(req)
    let { rows: [d] } = await q('SELECT * FROM tracking_domains WHERE id=$1 AND location_id=$2', [id, locationId])
    if (!d) return reply.code(404).send({ error: 'Dominio de tracking no encontrado' })
    if (d.verified) {
      return { ok: true, verificado: true, detalle: 'Este dominio ya estaba verificado', dominio: serializarDominioTracking(d) }
    }
    const destino = hostApp()
    if (!destino) {
      return reply.code(503).send({ error: 'La app no tiene APP_BASE_URL configurada: no se puede comprobar el CNAME' })
    }
    // Filas dadas de alta antes de exigirse el TXT: se les genera el token aquí mismo, una vez.
    if (!d.verify_token) {
      const { rows: [conToken] } = await q(
        'UPDATE tracking_domains SET verify_token=$3 WHERE id=$1 AND location_id=$2 AND verify_token IS NULL RETURNING *',
        [id, locationId, randomToken(16)]
      )
      // si una petición simultánea se adelantó, vale el token que dejó ella
      d = conToken ?? (await q('SELECT * FROM tracking_domains WHERE id=$1 AND location_id=$2', [id, locationId])).rows[0]
      if (!d?.verify_token) return reply.code(404).send({ error: 'Dominio de tracking no encontrado' })
    }
    // mismo cubo que la verificación de dominios de remitente: las dos son consultas DNS salientes
    if (!(await limitar(`dnsver:${locationId}`, 30, 60))) {
      return reply.code(429).send({ error: 'Demasiadas comprobaciones seguidas. Espera un minuto.' })
    }

    const normal = (h) => texto(h).toLowerCase().replace(/\.$/, '')
    let objetivos = []
    let ultimoFallo = ''
    try {
      objetivos = (await dns.resolveCname(d.domain)).map(normal)
    } catch (err) {
      ultimoFallo = err?.code || err?.message || ''
    }
    if (!objetivos.includes(destino)) {
      const visto = objetivos.length ? ` Ahora mismo apunta a ${objetivos.join(', ')}.` : ''
      return reply.code(409).send({
        ok: false,
        verificado: false,
        error: `Todavía no se ve el CNAME de ${d.domain} apuntando a ${destino}.${visto} Los cambios de DNS pueden tardar hasta 24 h.${
          ultimoFallo ? ` [${ultimoFallo}]` : ''
        }`,
      })
    }

    // Además del CNAME, un TXT con el token de la fila: el CNAME apunta a un host COMPARTIDO por
    // todas las subcuentas, así que por sí solo no prueba quién controla el dominio — sin el TXT,
    // con el UNIQUE(domain) por orden de llegada, una subcuenta podría dar de alta y verificar el
    // dominio de otro cliente cuyo CNAME ya existiera, quedándose sus enlaces y bloqueándolo con un
    // 409. El TXT no puede publicarse en el mismo nombre que el CNAME (DNS no lo admite): se busca
    // en _disruptivo-verify.<dominio> y, como cortesía, en el mismo nombre bajo el dominio padre
    // (quien controla la zona padre controla también el subdominio del CNAME).
    const esperado = `${TXT_PREFIJO}${d.verify_token}`
    const padre = d.domain.split('.').slice(1).join('.')
    const nombresTxt = [`${TXT_SUBDOMINIO}.${d.domain}`]
    if (padre.includes('.')) nombresTxt.push(`${TXT_SUBDOMINIO}.${padre}`)
    let tokenVisto = false
    let falloTxt = ''
    for (const nombre of nombresTxt) {
      try {
        const registros = await dns.resolveTxt(nombre)
        if (registros.some((partes) => partes.join('').trim() === esperado)) {
          tokenVisto = true
          break
        }
      } catch (err) {
        falloTxt = err?.code || err?.message || ''
      }
    }
    if (!tokenVisto) {
      return reply.code(409).send({
        ok: false,
        verificado: false,
        error: `El CNAME ya apunta bien, pero falta el registro TXT de propiedad: publica «${esperado}» como TXT en ${nombresTxt.join(
          ' (o en '
        )}${nombresTxt.length > 1 ? ')' : ''} y vuelve a comprobar. Los cambios de DNS pueden tardar hasta 24 h.${
          falloTxt ? ` [${falloTxt}]` : ''
        }`,
      })
    }

    const { rows: [actualizado] } = await q(
      'UPDATE tracking_domains SET verified=true, verified_at=now() WHERE id=$1 AND location_id=$2 RETURNING *',
      [id, locationId]
    )
    // el worker cachea el dominio verificado: invalidar aquí hace que el cambio sea inmediato
    olvidarDominioTracking(locationId)
    return { ok: true, verificado: true, detalle: 'Dominio de tracking verificado', dominio: serializarDominioTracking(actualizado) }
  })

  app.delete('/api/loc/dominios-tracking/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de dominio no válido')
    const { rowCount } = await q('DELETE FROM tracking_domains WHERE id=$1 AND location_id=$2', [id, loc(req)])
    if (!rowCount) return reply.code(404).send({ error: 'Dominio de tracking no encontrado' })
    // los mensajes que aún estén en cola saldrán por APP_BASE_URL; los ya enviados siguen
    // funcionando mientras el CNAME exista, porque /t/* responde igual llegue el host que llegue
    olvidarDominioTracking(loc(req))
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // Relay SMTP
  // ---------------------------------------------------------------------------
  app.get('/api/loc/relay', guard, async (req) => {
    const { rows: [cuenta] } = await q('SELECT * FROM relay_accounts WHERE location_id=$1', [loc(req)])
    return serializarRelay(cuenta)
  })

  app.post('/api/loc/relay/activar', guard, async (req) => {
    const { cuenta, contrasena } = await activarCuentaRelay(loc(req))
    // la contraseña solo existe en esta respuesta: en la base solo queda su hash scrypt
    return { ...serializarRelay(cuenta), contrasena }
  })

  app.post('/api/loc/relay/rotar', guard, async (req, reply) => {
    const locationId = loc(req)
    const { rows: [cuenta] } = await q('SELECT id FROM relay_accounts WHERE location_id=$1', [locationId])
    if (!cuenta) return reply.code(404).send({ error: 'Todavía no has activado el relay' })
    const contrasena = randomPassword(18)
    const { rows: [actualizada] } = await q(
      'UPDATE relay_accounts SET password_hash=$1, rotated_at=now(), updated_at=now() WHERE id=$2 RETURNING *',
      [hashPassword(contrasena), cuenta.id]
    )
    return { ...serializarRelay(actualizada), contrasena }
  })

  app.patch('/api/loc/relay', guard, async (req, reply) => {
    const locationId = loc(req)
    const { rows: [cuenta] } = await q('SELECT * FROM relay_accounts WHERE location_id=$1', [locationId])
    if (!cuenta) return reply.code(404).send({ error: 'Todavía no has activado el relay' })

    const b = req.body || {}
    const campos = []
    const params = []
    const set = (columna, valor) => {
      params.push(valor)
      campos.push(`${columna} = $${params.length}`)
    }
    if (b.enabled !== undefined) set('enabled', Boolean(b.enabled))
    if (b.accept_unknown_senders !== undefined) set('accept_unknown_senders', Boolean(b.accept_unknown_senders))
    if (b.default_provider_id !== undefined) {
      if (b.default_provider_id === null || b.default_provider_id === '') {
        set('default_provider_id', null)
      } else {
        const providerId = idDe(b.default_provider_id)
        if (!providerId) return malo(reply, 'El proveedor por defecto no es válido')
        if (!(await proveedorUsable(providerId, locationId))) {
          return malo(reply, 'Ese proveedor no existe o no está disponible para tu subcuenta')
        }
        set('default_provider_id', providerId)
      }
    }
    if (!campos.length) return malo(reply, 'No hay nada que actualizar')

    params.push(cuenta.id)
    const { rows: [actualizada] } = await q(
      `UPDATE relay_accounts SET ${campos.join(', ')}, updated_at=now() WHERE id=$${params.length} RETURNING *`,
      params
    )
    return serializarRelay(actualizada)
  })
}
