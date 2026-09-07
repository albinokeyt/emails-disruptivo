import { q } from '../db.js'
import { MENSAJE_SIN_ACCESO, tieneAcceso } from '../lib/marketplace.js'

// ---------------------------------------------------------------------------
// Enrutado del relay SMTP (SPEC §6).
//
// LA REGLA CENTRAL: lo que decide por dónde sale el correo es el `From` REAL del mensaje, no lo que
// el usuario dejara escrito en GHL › Settings › Email Services. GHL solo admite un remitente por
// servicio SMTP, pero el cliente quiere poder elegir cualquiera de sus remitentes en el nodo nativo
// de email: por eso la pasarela deduce el proveedor a partir del `From` y NUNCA rechaza un mensaje
// por venir de un remitente distinto al configurado.
//
// Cadena de resolución:
//   1) la autenticación (auth.js) ya ha dado el location_id
//   1b) suscripción en el Marketplace Disruptivo (lib/marketplace.js) → 451 con el texto literal
//   2) dominio del `From` verificado por OTRA subcuenta → 550 (único rechazo duro)
//   3) `From` en senders por (location_id, email)          → se usa su provider_id  ← caso normal
//   4) accept_unknown_senders → alta automática del remitente (origin='auto') y se envía
//   5) sin default_provider_id → 451 temporal con mensaje claro
//   6) antes de encolar (en handler.js): lista de supresión y límite de envíos
//
// El dominio se comprueba ANTES que el remitente exacto: mirarlo después dejaba pasar cualquier
// remitente ya existente en `senders`, que es justo el hueco por el que se colaba la suplantación.
// ---------------------------------------------------------------------------

// Mismo patrón de validación que src/routes/location.js: si el panel lo acepta, el relay también.
const RE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

const MAX_NOMBRE = 200

// Transliteración a ASCII de lo que aparece en un texto en español. RFC 5321 limita el texto de una
// respuesta SMTP a ASCII, y hay mensajes que vienen de otros módulos ya acentuados (por ejemplo el
// motivo del límite de envíos de src/lib/ratelimit.js): sin esto, «Límite» saldría como «L mite».
const ASCII_EQUIVALENTE = new Map(Object.entries({
  á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e',
  í: 'i', ì: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o',
  ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c',
  Á: 'A', À: 'A', Ä: 'A', Â: 'A', É: 'E', È: 'E', Ë: 'E', Ê: 'E',
  Í: 'I', Ì: 'I', Ï: 'I', Î: 'I', Ó: 'O', Ò: 'O', Ö: 'O', Ô: 'O',
  Ú: 'U', Ù: 'U', Ü: 'U', Û: 'U', Ñ: 'N', Ç: 'C',
  '¿': '', '¡': '', '«': '"', '»': '"', '“': '"', '”': '"', '‘': "'", '’': "'",
  '—': '-', '–': '-', '…': '...', '›': '>', '‹': '<', '€': 'EUR',
}))

/**
 * Texto apto para una respuesta SMTP.
 *
 * Dos motivos, los dos obligatorios:
 *  - smtp-server escribe el mensaje en el socket TAL CUAL. Un `\r\n` colado dentro (por ejemplo en
 *    la dirección de remitente que se interpola en la respuesta) partiría la respuesta en dos y
 *    permitiría inyectar líneas de protocolo. Dejar solo ASCII imprimible corta ese vector.
 *  - RFC 5321 limita el texto de respuesta a ASCII imprimible.
 */
export function textoSmtp(mensaje, max = 220) {
  return String(mensaje ?? '')
    .replace(/[^\x20-\x7E]/g, (c) => ASCII_EQUIVALENTE.get(c) ?? ' ') // se lleva por delante \r y \n
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, max)
}

/** Error con código SMTP listo para el callback de smtp-server. */
export function errorSmtp(codigo, mensaje) {
  const err = new Error(textoSmtp(mensaje))
  err.responseCode = codigo
  return err
}

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

/** Quita saltos de línea y recorta: nada de inyección de cabeceras de correo. */
export const cabecera = (v, max) =>
  texto(v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max)

/** Acepta «ana@x.com» y «Ana Ruiz <ana@x.com>» y devuelve la dirección en minúsculas. */
export function normalizarDireccion(v) {
  const bruto = texto(v)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim().toLowerCase()
}

export function esEmail(v) {
  const e = normalizarDireccion(v)
  return e.length > 0 && e.length <= 320 && RE_EMAIL.test(e)
}

/** Dominio (en minúsculas) de una dirección de correo. */
export function dominioDe(email) {
  const e = normalizarDireccion(email)
  const arroba = e.lastIndexOf('@')
  return arroba > 0 ? e.slice(arroba + 1) : ''
}

const rechazo = (codigo, mensaje) => ({ ok: false, codigo, mensaje })

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/**
 * Cuenta de relay + estado de la instalación de la subcuenta.
 *
 * Se relee en cada mensaje (no se cachea en la sesión SMTP): GHL reutiliza la conexión, y si el
 * usuario apaga el relay o cambia el proveedor por defecto en el panel tiene que notarse en el
 * siguiente correo, no cuando a GHL le apetezca reconectar.
 */
export async function cargarCuentaRelay(locationId) {
  const { rows: [cuenta] } = await q(
    `SELECT r.id, r.location_id, r.username, r.enabled, r.default_provider_id,
            r.accept_unknown_senders, c.status AS estado_conexion
       FROM relay_accounts r
       LEFT JOIN connections c ON c.location_id = r.location_id
      WHERE r.location_id = $1`,
    [locationId]
  )
  return cuenta || null
}

/**
 * ¿Puede esta subcuenta enviar por este proveedor? Propio o cedido por la agencia.
 * Mismo criterio que `proveedorUsable` de src/routes/location.js.
 */
async function proveedorUsable(providerId, locationId) {
  if (!providerId) return false
  const { rows: [p] } = await q(
    `SELECT 1 FROM providers p
      WHERE p.id = $1 AND (
            (p.owner_scope = 'location' AND p.location_id = $2)
         OR EXISTS (SELECT 1 FROM provider_assignments a
                     WHERE a.provider_id = p.id AND a.location_id = $2))`,
    [providerId, locationId]
  )
  return Boolean(p)
}

/**
 * Direcciones de la lista de supresión, de entre las indicadas.
 * Devuelve un Map dirección → motivo. Se consulta SIEMPRE antes de encolar (SPEC §6).
 */
export async function suprimidos(locationId, direcciones) {
  const lista = [...new Set((direcciones || []).map(normalizarDireccion).filter(Boolean))]
  if (!lista.length) return new Map()
  const { rows } = await q(
    'SELECT email::text AS email, reason FROM suppressions WHERE location_id = $1 AND email = ANY($2::citext[])',
    [locationId, lista]
  )
  return new Map(rows.map((r) => [String(r.email).toLowerCase(), r.reason]))
}

// ---------------------------------------------------------------------------
// Resolución del remitente
// ---------------------------------------------------------------------------

/**
 * Decide remitente y proveedor a partir del `From` del mensaje.
 *
 * @param {object} args
 * @param {string} args.locationId   subcuenta autenticada
 * @param {object} args.cuenta       fila de relay_accounts (con default_provider_id y flags)
 * @param {string} args.from         dirección del `From` del mensaje
 * @param {string} [args.nombre]     nombre visible del `From`
 * @param {object} [args.log]        logger de la sesión (para los avisos de la comprobación de suscripción)
 * @returns {Promise<{ok:true, sender:object, providerId:number, altaAutomatica:boolean}
 *                 | {ok:false, codigo:number, mensaje:string}>}
 */
export async function resolverRuta({ locationId, cuenta, from, nombre, log }) {
  const email = normalizarDireccion(from)

  // Sin un `From` legible no hay nada que enrutar y reintentar no lo va a arreglar: es un mensaje
  // mal formado, no una decisión de política sobre el remitente.
  if (!esEmail(email)) {
    return rechazo(550, 'El mensaje no trae una direccion de remitente (From) valida')
  }

  // La instalación puede haberse borrado después de crear la cuenta de relay. Se responde temporal
  // (451) y no permanente: al reinstalar la app el correo se recupera solo.
  if (!cuenta || !cuenta.estado_conexion || cuenta.estado_conexion === 'uninstalled') {
    return rechazo(451, 'La app de email no esta instalada en esta subcuenta: vuelve a instalarla desde el Marketplace')
  }
  if (!cuenta.enabled) {
    return rechazo(451, 'El relay SMTP esta desactivado en el panel de la app de email')
  }

  // ── Paso 1b: la suscripción en el Marketplace Disruptivo ──────────────────
  // Segundo punto de corte (antes de aceptar un envío). 451 temporal y no 550: al reactivar la
  // suscripción GHL reintenta y el correo sale solo. El texto es el literal del encargo; textoSmtp
  // solo le quita las tildes porque RFC 5321 limita la respuesta a ASCII.
  const acceso = await tieneAcceso(locationId, { log })
  if (!acceso.access) return rechazo(451, MENSAJE_SIN_ACCESO)

  // ── Paso 2: el dominio. ÚNICO rechazo duro de toda la pasarela ────────────
  // Un dominio verificado pertenece a UNA sola subcuenta (índice único parcial en sender_domains).
  // Si el `From` cae en el dominio verificado de otro cliente de la agencia se corta con un 550
  // permanente: sin esto, cualquier subcuenta con credenciales de relay podría enviar suplantando
  // el dominio de otra, quemarle la reputación y dejar un rastro indistinguible de un spoofing.
  // Es el único caso en el que se rechaza en firme; todo lo demás se enruta o se aplaza.
  //
  // Va ANTES de buscar el remitente exacto a propósito: el panel ya impide dar de alta un remitente
  // de un dominio ajeno verificado, pero un remitente creado ANTES de que el otro cliente verificara
  // el dominio seguiría existiendo en `senders`, y mirar primero el remitente lo dejaría pasar.
  const dominio = dominioDe(email)
  const { rows: [duenoDominio] } = await q(
    'SELECT location_id FROM sender_domains WHERE domain = $1 AND verified',
    [dominio]
  )
  if (duenoDominio && duenoDominio.location_id !== locationId) {
    return rechazo(550, `El dominio ${dominio} esta verificado por otra subcuenta: no puedes enviar desde el`)
  }

  // ── Paso 3: el remitente exacto. Es el caso normal ────────────────────────
  const { rows: [sender] } = await q(
    `SELECT id, location_id, provider_id, email::text AS email, name, reply_to, origin, verified_state
       FROM senders WHERE location_id = $1 AND email = $2`,
    [locationId, email]
  )

  if (sender) {
    if (await proveedorUsable(sender.provider_id, locationId)) {
      return { ok: true, sender, providerId: Number(sender.provider_id), altaAutomatica: false }
    }
    // El proveedor del remitente se borró (ON DELETE SET NULL) o la agencia le retiró la cesión:
    // se cae al proveedor por defecto de la subcuenta antes de rendirse.
    if (await proveedorUsable(cuenta.default_provider_id, locationId)) {
      return { ok: true, sender, providerId: Number(cuenta.default_provider_id), altaAutomatica: false }
    }
    return rechazo(
      451,
      `El remitente ${email} no tiene proveedor de envio valido y la subcuenta no tiene proveedor por defecto: configuralo en la app de email`
    )
  }

  // ── Paso 4: alta automática del remitente ─────────────────────────────────
  if (!cuenta.accept_unknown_senders) {
    // El usuario ha desactivado el alta automática a propósito. No se reescribe el `From` por otro
    // (eso rompería la trazabilidad y sería indistinguible de una suplantación) ni se rechaza en
    // firme: 451 para que pueda dar de alta el remitente y que el correo se recupere.
    return rechazo(
      451,
      `El remitente ${email} no esta dado de alta y el alta automatica esta desactivada: crealo en la app de email`
    )
  }

  // ── Paso 5: sin proveedor por defecto no hay por dónde sacarlo ────────────
  if (!(await proveedorUsable(cuenta.default_provider_id, locationId))) {
    return rechazo(
      451,
      `El remitente ${email} es nuevo y la subcuenta no tiene proveedor por defecto: eligelo en la seccion Relay de la app de email`
    )
  }

  const nombreVisible = cabecera(nombre, MAX_NOMBRE) || email.split('@')[0]
  // ON CONFLICT: dos correos simultáneos con el mismo `From` nuevo entran a la vez. El DO UPDATE
  // (en vez de DO NOTHING) garantiza que siempre haya RETURNING, gane quien gane la carrera.
  const { rows: [alta] } = await q(
    `INSERT INTO senders (location_id, provider_id, email, name, origin, verified_state)
     VALUES ($1,$2,$3,$4,'auto','desconocido')
     ON CONFLICT (location_id, email) DO UPDATE SET updated_at = now()
     RETURNING id, location_id, provider_id, email::text AS email, name, reply_to, origin, verified_state`,
    [locationId, cuenta.default_provider_id, email, nombreVisible]
  )

  // Si la carrera la ganó una fila que ya existía con otro proveedor, manda el suyo.
  const providerId = (await proveedorUsable(alta.provider_id, locationId))
    ? Number(alta.provider_id)
    : Number(cuenta.default_provider_id)

  return { ok: true, sender: alta, providerId, altaAutomatica: true }
}
