import { Readable } from 'node:stream'
import { config } from '../config.js'
import { pool, q } from '../db.js'
import { requireLocation } from '../lib/auth.js'
import { cifrarCredenciales, randomCorrelationId } from '../lib/crypto.js'
import { RE_HOST, destinoPermitido, hostPublico } from '../lib/red.js'
import { consumirLimiteEnvio, rateLimit } from '../lib/ratelimit.js'
import { filtrarSuprimidos } from '../lib/suppression.js'
import { escaparHtml, textoDesdeHtml } from '../lib/render.js'
import { borrarMensajeBuzon, cuotaDe, recalcularUso, tamanoLegible } from '../lib/buzon.js'
import { borrarEnServidor, probarBuzon, sincronizarBuzon } from '../lib/buzon-sync.js'
import { MENSAJE_SIN_ACCESO, tieneAcceso } from '../lib/marketplace.js'
// Las mismas utilidades de validación que el resto del panel de subcuenta (y que reutiliza admin.js).
import { cabecera, esEmail, idDe, paginar, texto } from './location.js'

// SPEC §14.3 — API del Buzón (correo entrante por IMAP). TODAS las rutas van bajo requireLocation y
// TODAS las consultas filtran por el location_id de la sesión: una cuenta, un mensaje o un adjunto
// de otra subcuenta responde 404, nunca 403 (no se confirma ni que exista).
//
// La contraseña IMAP se guarda cifrada (AES-256-GCM, la misma clave que las credenciales de los
// proveedores) y NUNCA vuelve al panel: se devuelve { configurado: true }.
//
// Responder y reenviar NO abren ninguna conexión SMTP propia: encolan una fila en `messages` con
// origin='buzon' y cabeceras de hilo en extra_headers, y el worker de envío la saca por el remitente
// y proveedor de siempre. Así pasan por la lista de supresión, los límites de envío, el tracking y el
// historial como cualquier otro correo.

const MAX_CUENTAS = 20
const MAX_NOMBRE = 120
const MAX_USUARIO = 320
const MAX_CONTRASENA = 1000
const MAX_CARPETA = 200
const MAX_ASUNTO = 500
const MAX_HTML = 1_000_000
const MAX_DESTINATARIOS_COPIA = 20
const MAX_HILO = 100
const MAX_REFERENCIAS = 30
const MAX_ID_MENSAJE = 998
const MAX_SNIPPET = 160
const RANGO_ENCOLADO = 0
const RANGO_SUPRIMIDO = 93 // §4 del SPEC: 'suprimido' es terminal
// Pasada forzada desde el panel (corre dentro de la petición HTTP): mensajes y tiempo de importación
// acotados, y plazo tras el cual se responde «en curso» y la pasada sigue en segundo plano.
const MAX_MENSAJES_FORZADA = 50
const PLAZO_FORZADA_MS = 25_000
const PLAZO_RESPUESTA_MS = 40_000
const EN_CURSO = Symbol('en_curso')

const RE_FECHA = /^\d{4}-\d{2}-\d{2}$/
const RE_FECHA_HORA = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/
const RE_PREFIJO_RE = /^\s*re\s*:/i
const RE_PREFIJO_FWD = /^\s*(fwd?|rv|tr|wg)\s*:/i
// Tipo MIME con forma válida (solo tipo/subtipo, sin parámetros)
const RE_TIPO_MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i
// Tipos que un navegador podría interpretar si algún día se abrieran en línea: se sirven como
// binario aunque ya vayan con Content-Disposition: attachment y nosniff (defensa en profundidad).
const RE_TIPO_ACTIVO = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|application\/javascript|text\/javascript|application\/ecmascript)$/i

const CARPETAS = new Set(['bandeja', 'no_leidos', 'enviados'])

// Zona horaria con la que se escribe la fecha en la cita («El 4 sept 2026, 10:32, X escribió:»).
// El contenedor no suele tener TZ definida; la agencia y sus clientes trabajan en hora de España.
const ZONA_HORARIA = texto(process.env.TZ) || 'Europe/Madrid'

const malo = (reply, mensaje) => reply.code(400).send({ error: mensaje })

function fallo(codigo, mensaje) {
  const err = new Error(mensaje)
  err.codigo = codigo
  return err
}

// true/false, 'true'/'false', 1/0, 'si'/'no'; null si no se entiende
function booleano(v, def) {
  if (v === undefined || v === null || v === '') return def
  if (typeof v === 'boolean') return v
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'si', 'sí', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return null
}

const bandera = (v) => booleano(v, false) === true

const fechaValida = (v) => {
  const s = texto(v)
  return RE_FECHA.test(s) || RE_FECHA_HORA.test(s)
}

const patronBusqueda = (busqueda) => `%${busqueda.replace(/[%_\\]/g, (c) => `\\${c}`)}%`

// Acepta "ana@x.com" y "Ana Ruiz <ana@x.com>"
function normalizarEmail(v) {
  const bruto = texto(v)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim().toLowerCase()
}

/** Lista de direcciones desde array o cadena separada por comas/puntos y coma/saltos. */
function parseLista(v, etiqueta) {
  if (v === undefined || v === null || v === '') return { lista: [] }
  const bruto = Array.isArray(v) ? v : String(v).split(/[,;\n]/)
  const lista = []
  for (const parte of bruto) {
    const email = normalizarEmail(parte)
    if (!email) continue
    if (!esEmail(email)) return { error: `La dirección «${email}» del campo ${etiqueta} no es válida` }
    if (!lista.includes(email)) lista.push(email)
  }
  return { lista }
}

const paginasDe = (total, limite) => Math.max(1, Math.ceil(total / limite))

// ---------------------------------------------------------------------------
// Cabeceras de hilo (In-Reply-To / References)
// ---------------------------------------------------------------------------

/** Message-ID normalizado con sus ángulos y sin saltos de línea; '' si no hay nada útil. */
function idMensaje(v) {
  const s = texto(v).replace(/[\r\n\t]/g, '')
  if (!s) return ''
  const pelado = s.replace(/^<+|>+$/g, '').trim()
  if (!pelado || pelado.length > MAX_ID_MENSAJE) return ''
  return `<${pelado}>`
}

/** References guardadas (texto separado por espacios, o array) → lista de ids sin repetidos. */
function listaReferencias(v) {
  const partes = Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)
  const ids = []
  for (const parte of partes) {
    const id = idMensaje(parte)
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

/**
 * Cabeceras que enlazan la respuesta con el hilo del original (RFC 5322 §3.6.4). Los clientes
 * truncan References por el principio cuando crece: se conservan la raíz y los últimos.
 */
function cabecerasHilo(original) {
  const idOriginal = idMensaje(original.message_id)
  const refs = listaReferencias(original.references)
  if (idOriginal && !refs.includes(idOriginal)) refs.push(idOriginal)
  const referencias = refs.length > MAX_REFERENCIAS ? [refs[0], ...refs.slice(-(MAX_REFERENCIAS - 1))] : refs
  const cabeceras = {}
  if (idOriginal) cabeceras['In-Reply-To'] = idOriginal
  if (referencias.length) cabeceras.References = referencias.join(' ')
  return cabeceras
}

// ---------------------------------------------------------------------------
// Asunto y cita del original
// ---------------------------------------------------------------------------

const asuntoBase = (s) => cabecera(s, MAX_ASUNTO - 6) || '(sin asunto)'
const asuntoRespuesta = (s) => (RE_PREFIJO_RE.test(asuntoBase(s)) ? asuntoBase(s) : `Re: ${asuntoBase(s)}`)
const asuntoReenvio = (s) => (RE_PREFIJO_FWD.test(asuntoBase(s)) ? asuntoBase(s) : `Fwd: ${asuntoBase(s)}`)

function fechaLegible(valor) {
  const d = new Date(valor)
  if (Number.isNaN(d.getTime())) return ''
  try {
    return d.toLocaleString('es-ES', {
      day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: ZONA_HORARIA,
    })
  } catch {
    return d.toISOString()
  }
}

function quien(nombre, email) {
  const n = cabecera(nombre, 200)
  const e = texto(email)
  if (n && e) return `${n} <${e}>`
  return n || e || '(desconocido)'
}

/** Destinatarios del original tal como los guardó la sincronización: [{tipo, email, name}]. */
function destinatariosDe(recipients) {
  const lista = Array.isArray(recipients) ? recipients : []
  const salida = []
  for (const r of lista) {
    const email = normalizarEmail(r && typeof r === 'object' ? r.email ?? r.address : r)
    if (!esEmail(email)) continue
    const tipo = texto(r?.tipo ?? r?.type).toLowerCase() === 'cc' ? 'cc' : 'to'
    salida.push({ tipo, email, name: cabecera(r?.name ?? r?.nombre, 200) || null })
  }
  return salida
}

const listaLegible = (destinatarios) => destinatarios.map((d) => quien(d.name, d.email)).join(', ')

/**
 * El HTML guardado está saneado para el panel: las imágenes remotas van en `data-src` (apagadas
 * hasta que el usuario pulsa «cargar imágenes») y las incrustadas por Content-ID en `data-cid`. Para
 * citarlo en una respuesta o reenvío las remotas recuperan su `src` (son URLs http(s) ya validadas
 * al sanear) y las incrustadas, que no viajan, se sustituyen por su texto alternativo: si no, el
 * destinatario recibiría la cita con todas las imágenes rotas. sanitize-html serializa los
 * atributos entre comillas dobles, por eso el alt se recupera así y se reinserta ya escapado.
 */
function htmlParaCita(html) {
  return String(html)
    .replace(/<img\b[^>]*\bdata-cid\s*=[^>]*>/gi, (etiqueta) => {
      const alt = texto(etiqueta.match(/\balt\s*=\s*"([^"]*)"/i)?.[1])
      return alt ? `[${alt}]` : ''
    })
    .replace(/<img\b[^>]*>/gi, (etiqueta) => etiqueta.replace(/\bdata-src(\s*=)/gi, 'src$1'))
}

const cuerpoHtmlOriginal = (m) => {
  if (texto(m.html)) return htmlParaCita(m.html)
  const t = texto(m.text)
  return t ? `<div style="white-space:pre-wrap">${escaparHtml(t)}</div>` : ''
}
const cuerpoTextoOriginal = (m) => texto(m.text) || textoDesdeHtml(m.html)

function citaHtml(m) {
  return (
    '<br><br><div class="buzon-cita" style="margin:16px 0 0;padding:0 0 0 12px;border-left:2px solid #cccccc;color:#555555">' +
    `<p style="margin:0 0 8px">El ${escaparHtml(fechaLegible(m.date))}, ${escaparHtml(quien(m.from_name, m.from_email))} escribió:</p>` +
    `<blockquote style="margin:0;padding:0;border:0">${cuerpoHtmlOriginal(m)}</blockquote></div>`
  )
}

// Variante sin el HTML del original, por si la suma se pasa del máximo (correos enormes).
function citaHtmlPlano(m) {
  return (
    '<br><br><div class="buzon-cita" style="margin:16px 0 0;padding:0 0 0 12px;border-left:2px solid #cccccc;color:#555555">' +
    `<p style="margin:0 0 8px">El ${escaparHtml(fechaLegible(m.date))}, ${escaparHtml(quien(m.from_name, m.from_email))} escribió:</p>` +
    `<div style="white-space:pre-wrap">${escaparHtml(cuerpoTextoOriginal(m))}</div></div>`
  )
}

function citaTexto(m) {
  const cuerpo = cuerpoTextoOriginal(m)
  const citado = cuerpo ? cuerpo.split('\n').map((linea) => `> ${linea}`).join('\n') : '>'
  return `\n\nEl ${fechaLegible(m.date)}, ${quien(m.from_name, m.from_email)} escribió:\n${citado}`
}

function cabeceraReenvioHtml(m) {
  const filas = [
    ['De', quien(m.from_name, m.from_email)],
    ['Fecha', fechaLegible(m.date)],
    ['Asunto', texto(m.subject) || '(sin asunto)'],
    ['Para', listaLegible(destinatariosDe(m.recipients).filter((d) => d.tipo === 'to'))],
  ]
  const cc = listaLegible(destinatariosDe(m.recipients).filter((d) => d.tipo === 'cc'))
  if (cc) filas.push(['Cc', cc])
  return (
    '<br><br><div class="buzon-reenvio" style="margin:16px 0 0;color:#555555">' +
    '<p style="margin:0 0 8px">---------- Mensaje reenviado ----------</p>' +
    filas.map(([k, v]) => `<p style="margin:0"><b>${k}:</b> ${escaparHtml(v)}</p>`).join('') +
    '</div><br>'
  )
}

function reenvioHtml(m) {
  return `${cabeceraReenvioHtml(m)}<div class="buzon-reenvio-cuerpo">${cuerpoHtmlOriginal(m)}</div>`
}
function reenvioHtmlPlano(m) {
  return `${cabeceraReenvioHtml(m)}<div style="white-space:pre-wrap">${escaparHtml(cuerpoTextoOriginal(m))}</div>`
}

function reenvioTexto(m) {
  const para = listaLegible(destinatariosDe(m.recipients).filter((d) => d.tipo === 'to'))
  const cc = listaLegible(destinatariosDe(m.recipients).filter((d) => d.tipo === 'cc'))
  return (
    '\n\n---------- Mensaje reenviado ----------\n' +
    `De: ${quien(m.from_name, m.from_email)}\nFecha: ${fechaLegible(m.date)}\nAsunto: ${texto(m.subject) || '(sin asunto)'}\n` +
    `Para: ${para}\n${cc ? `Cc: ${cc}\n` : ''}\n${cuerpoTextoOriginal(m)}`
  )
}

/**
 * Cuerpo escrito por el usuario en el panel: html, o text convertido a html si solo mandó texto.
 * Con opcional=true (reenvíos) se admite vacío. Devuelve { html, text } o { error }.
 */
function cuerpoUsuario(b, { opcional = false } = {}) {
  const html = typeof b.html === 'string' ? b.html : ''
  const textoPlano = typeof b.text === 'string' ? b.text : ''
  if (!html.trim() && !textoPlano.trim()) {
    if (!opcional) return { error: 'Escribe el texto del mensaje antes de enviarlo' }
    return { html: '', text: '' }
  }
  if (html.length > MAX_HTML || textoPlano.length > MAX_HTML) return { error: 'El mensaje es demasiado grande' }
  const htmlFinal = html.trim() ? html : `<div style="white-space:pre-wrap">${escaparHtml(textoPlano)}</div>`
  const textoFinal = textoPlano.trim() ? textoPlano : textoDesdeHtml(html)
  return { html: htmlFinal, text: textoFinal }
}

/** Une el cuerpo del usuario con la cita/reenvío sin pasarse del máximo. */
function componerCuerpo(cuerpo, original, { conHtml, sinHtml, textoPie }) {
  // sin cuerpo propio (reenvío tal cual) no hace falta el hueco que separa la cita
  const unir = (propio, pie) => (propio ? propio + pie : pie.replace(/^(<br\s*\/?>)+/i, ''))
  let html = unir(cuerpo.html, conHtml(original))
  if (html.length > MAX_HTML) html = unir(cuerpo.html, sinHtml(original))
  if (html.length > MAX_HTML) return { error: 'El mensaje con el original citado es demasiado grande' }
  let text = (cuerpo.text + textoPie(original)).replace(/^\n+/, '')
  if (text.length > MAX_HTML) text = text.slice(0, MAX_HTML)
  return { html, text }
}

// ---------------------------------------------------------------------------
// Serialización
// ---------------------------------------------------------------------------

// Columnas explícitas: password_enc no se selecciona jamás en las rutas que devuelven la cuenta.
const COLUMNAS_CUENTA = `b.id, b.name, b.email, b.host, b.port, b.secure, b.username, b.folder,
  b.delete_after_import, b.sync_interval_min, b.reply_sender_id, b.enabled, b.status, b.last_error,
  b.last_sync_at, b.last_uid, b.uidvalidity, b.created_at, b.updated_at,
  s.email AS remitente_email, s.name AS remitente_nombre,
  est.mensajes, est.no_leidos, est.usado_bytes`

// Espacio por cuenta = mensajes + adjuntos, la misma suma con la que se lleva buzon_used_bytes.
const JOINS_CUENTA = `FROM mailboxes b
  LEFT JOIN senders s ON s.id = b.reply_sender_id
  LEFT JOIN LATERAL (
    SELECT COUNT(m.id)::int AS mensajes,
           (COUNT(m.id) FILTER (WHERE NOT m.is_read))::int AS no_leidos,
           (COALESCE(SUM(m.size_bytes), 0) + COALESCE((
              SELECT SUM(a.size_bytes) FROM inbox_attachments a
                JOIN inbox_messages mm ON mm.id = a.message_id
               WHERE mm.mailbox_id = b.id), 0))::bigint AS usado_bytes
      FROM inbox_messages m WHERE m.mailbox_id = b.id
  ) est ON true`

const serializarCuenta = (c) => ({
  id: c.id,
  name: c.name,
  email: c.email,
  host: c.host,
  port: c.port,
  secure: c.secure,
  username: c.username,
  folder: c.folder,
  delete_after_import: c.delete_after_import,
  sync_interval_min: c.sync_interval_min,
  reply_sender_id: c.reply_sender_id,
  remitente_email: c.remitente_email ?? null,
  remitente_nombre: c.remitente_nombre ?? null,
  enabled: c.enabled,
  status: c.status,
  last_error: c.last_error,
  last_sync_at: c.last_sync_at,
  last_uid: Number(c.last_uid) || 0,
  created_at: c.created_at,
  updated_at: c.updated_at,
  // la contraseña nunca sale: solo se dice que está puesta
  contrasena: { configurado: true },
  mensajes: c.mensajes ?? 0,
  no_leidos: c.no_leidos ?? 0,
  usado_bytes: Number(c.usado_bytes) || 0,
  usado_legible: tamanoLegible(Number(c.usado_bytes) || 0),
})

const filaRecibido = (m) => ({
  id: m.id,
  tipo: 'recibido',
  mailbox_id: m.mailbox_id,
  cuenta_nombre: m.cuenta_nombre ?? null,
  cuenta_email: m.cuenta_email ?? null,
  from: { email: m.from_email ?? null, name: m.from_name ?? null },
  from_email: m.from_email ?? null,
  from_name: m.from_name ?? null,
  subject: m.subject,
  date: m.date,
  snippet: m.snippet,
  size_bytes: Number(m.size_bytes) || 0,
  size_legible: tamanoLegible(Number(m.size_bytes) || 0),
  has_attachments: m.has_attachments,
  is_read: m.is_read,
  thread_key: m.thread_key,
  message_id: m.message_id ?? null,
  respuestas: m.respuestas ?? 0,
})

const filaEnviado = (x) => ({
  id: x.id,
  tipo: 'enviado',
  to_email: x.to_email,
  to_name: x.to_name ?? null,
  cc: x.cc ?? null,
  bcc: x.bcc ?? null,
  subject: x.subject,
  date: x.created_at,
  snippet: x.snippet ?? null,
  status: x.status,
  last_error: x.last_error ?? null,
  attempts: x.attempts ?? 0,
  sent_at: x.sent_at ?? null,
  thread_key: x.thread_key,
  inbox_reply_to_id: x.inbox_reply_to_id ?? null,
  remitente_email: x.remitente_email ?? null,
  remitente_nombre: x.remitente_nombre ?? null,
  has_attachments: false,
  is_read: true,
})

const COLUMNAS_ENVIADO = `x.id, x.to_email, x.to_name, x.cc, x.bcc, x.subject, x.status, x.last_error, x.attempts,
  x.sent_at, x.created_at, x.thread_key, x.inbox_reply_to_id,
  left(regexp_replace(COALESCE(x.text, ''), '\\s+', ' ', 'g'), ${MAX_SNIPPET}) AS snippet,
  s.email AS remitente_email, s.name AS remitente_nombre`

// ---------------------------------------------------------------------------
// Validación de cuentas
// ---------------------------------------------------------------------------

/** Contraseña recibida del panel (password | contrasena | pass). '' si no llegó ninguna. */
function contrasenaDe(b) {
  const bruto = b.password ?? b.contrasena ?? b.pass
  if (typeof bruto !== 'string') return ''
  return bruto.trim()
}

/**
 * Lee y valida los campos de una cuenta IMAP. Con parcial=true solo toca los que llegan.
 * Devuelve { datos } o { error }.
 */
async function leerCuenta(b, locationId, { parcial = false } = {}) {
  const datos = {}

  if (!parcial || b.email !== undefined) {
    const email = texto(b.email).toLowerCase()
    if (!esEmail(email)) return { error: 'El correo de la cuenta no es válido' }
    datos.email = email
  }
  if (!parcial || b.name !== undefined) {
    const nombre = cabecera(b.name, MAX_NOMBRE) || datos.email || ''
    if (!nombre) return { error: 'El nombre de la cuenta es obligatorio' }
    datos.name = nombre
  }
  if (!parcial || b.host !== undefined) {
    const host = texto(b.host).toLowerCase().replace(/\.+$/, '')
    if (!host || !RE_HOST.test(host)) {
      return { error: 'El servidor IMAP no es un nombre de host válido (p. ej. imap.gmail.com)' }
    }
    // mismo guardarraíl que el SMTP de los proveedores: la app conecta hacia fuera con lo que se guarde aquí
    if (!hostPublico(host)) {
      return {
        error: 'El servidor IMAP tiene que ser un nombre de dominio público: no se admiten direcciones IP ni nombres de red interna',
      }
    }
    datos.host = host
  }
  if (!parcial || b.secure !== undefined) {
    const seguro = booleano(b.secure, true)
    if (seguro === null) return { error: 'El campo «secure» (TLS) tiene que ser verdadero o falso' }
    datos.secure = seguro
  }
  if (!parcial || b.port !== undefined) {
    if (b.port === undefined || b.port === null || b.port === '') {
      // sin puerto en el alta: el estándar según el modo de TLS (993 implícito, 143 STARTTLS);
      // en una edición, un puerto vacío es «no lo toques»
      if (!parcial) datos.port = datos.secure === false ? 143 : 993
    } else {
      const puerto = Number(b.port)
      if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
        return { error: 'El puerto IMAP tiene que estar entre 1 y 65535 (993 con TLS, 143 con STARTTLS)' }
      }
      datos.port = puerto
    }
  }
  if (!parcial || b.username !== undefined) {
    const usuario = cabecera(b.username, MAX_USUARIO) || datos.email || ''
    if (!usuario) return { error: 'El usuario IMAP es obligatorio' }
    datos.username = usuario
  }
  if (!parcial || b.folder !== undefined) {
    const carpeta = texto(b.folder).replace(/[\r\n\x00-\x1f\x7f]/g, '') || 'INBOX'
    if (carpeta.length > MAX_CARPETA) return { error: 'El nombre de la carpeta es demasiado largo' }
    datos.folder = carpeta
  }
  if (!parcial || b.delete_after_import !== undefined) {
    const borrar = booleano(b.delete_after_import, false)
    if (borrar === null) return { error: 'El campo «delete_after_import» tiene que ser verdadero o falso' }
    datos.delete_after_import = borrar
  }
  if (!parcial || b.sync_interval_min !== undefined) {
    if (b.sync_interval_min === undefined || b.sync_interval_min === null || b.sync_interval_min === '') {
      datos.sync_interval_min = 5
    } else {
      const minutos = Number(b.sync_interval_min)
      if (!Number.isInteger(minutos) || minutos < 1 || minutos > 1440) {
        return { error: 'El intervalo de sincronización tiene que ser un número entero de minutos entre 1 y 1440' }
      }
      datos.sync_interval_min = minutos
    }
  }
  if (!parcial || b.reply_sender_id !== undefined) {
    if (b.reply_sender_id === undefined || b.reply_sender_id === null || b.reply_sender_id === '') {
      datos.reply_sender_id = null
    } else {
      const senderId = idDe(b.reply_sender_id)
      if (!senderId) return { error: 'El remitente para responder no es válido' }
      const { rows: [s] } = await q('SELECT id FROM senders WHERE id=$1 AND location_id=$2', [senderId, locationId])
      if (!s) return { error: 'Ese remitente no existe en tu subcuenta' }
      datos.reply_sender_id = senderId
    }
  }
  if (!parcial || b.enabled !== undefined) {
    const activa = booleano(b.enabled, true)
    if (activa === null) return { error: 'El campo «enabled» tiene que ser verdadero o falso' }
    datos.enabled = activa
  }
  return { datos }
}

// El blob cifrado lleva la contraseña bajo `password` y `pass` (la forma de las credenciales SMTP),
// para que quien la descifre la encuentre con cualquiera de los dos nombres.
const cifrarContrasena = (usuario, contrasena) => cifrarCredenciales({ user: usuario, pass: contrasena, password: contrasena })

// ---------------------------------------------------------------------------
// Remitente y proveedor con los que sale una respuesta
// ---------------------------------------------------------------------------

async function remitentePorId(id, locationId) {
  const { rows: [s] } = await q('SELECT * FROM senders WHERE id=$1 AND location_id=$2', [id, locationId])
  return s || null
}

/** body.sender_id → mailboxes.reply_sender_id → remitente por defecto (o el primero). 400 si no hay. */
async function resolverRemitente(locationId, senderIdBody, replySenderId) {
  if (senderIdBody !== undefined && senderIdBody !== null && senderIdBody !== '') {
    const senderId = idDe(senderIdBody)
    if (!senderId) throw fallo(400, 'El remitente indicado no es válido')
    const s = await remitentePorId(senderId, locationId)
    if (!s) throw fallo(400, 'Ese remitente no existe en tu subcuenta')
    return s
  }
  if (replySenderId) {
    const s = await remitentePorId(replySenderId, locationId)
    if (s) return s
  }
  const { rows: [porDefecto] } = await q(
    'SELECT * FROM senders WHERE location_id=$1 ORDER BY is_default DESC, id ASC LIMIT 1', [locationId])
  if (!porDefecto) {
    throw fallo(400, 'No hay ningún remitente con el que responder: da de alta uno en Remitentes o elige el «remitente para responder» en la cuenta del buzón')
  }
  return porDefecto
}

/** Proveedor del remitente, comprobando que siga disponible para la subcuenta (propio o cedido). */
async function proveedorDe(remitente, locationId) {
  if (!remitente.provider_id) {
    throw fallo(400, `El remitente ${remitente.email} no tiene proveedor asignado: asígnale uno en Remitentes antes de responder`)
  }
  const { rows: [p] } = await q(
    `SELECT p.id FROM providers p
      WHERE p.id = $1 AND (
            (p.owner_scope = 'location' AND p.location_id = $2)
         OR (p.owner_scope = 'admin' AND EXISTS (
               SELECT 1 FROM provider_assignments a WHERE a.provider_id = p.id AND a.location_id = $2)))`,
    [remitente.provider_id, locationId]
  )
  if (!p) throw fallo(400, `El proveedor del remitente ${remitente.email} ya no está disponible para tu subcuenta`)
  return p
}

// Reply-To de lo que sale del buzón: la propia cuenta IMAP, para que la contestación vuelva a
// entrar por aquí aunque el remitente sea otra dirección (p. ej. se responde por Brevo desde
// hola@dominio.com con el buzón en soporte@gmail.com). Si coinciden, manda el reply_to del remitente.
function replyToDe(remitente, cuentaEmail) {
  const cuenta = texto(cuentaEmail).toLowerCase()
  if (cuenta && cuenta !== texto(remitente.email).toLowerCase()) return cabecera(cuenta, 320)
  return remitente.reply_to ? cabecera(remitente.reply_to, 320) : null
}

// ---------------------------------------------------------------------------
// Encolado en `messages` (mismo patrón que los nodos de GHL en src/routes/actions.js)
// ---------------------------------------------------------------------------

async function encolarDesdeBuzon({
  locationId, log, original, remitente, proveedor, destino, nombreDestino, cc, bcc, asunto, html, text,
}) {
  // Suscripción en el Marketplace Disruptivo: responder o reenviar desde el buzón también es un
  // envío, así que se corta aquí con el texto literal (403: la sesión sigue siendo válida).
  const acceso = await tieneAcceso(locationId, { log })
  if (!acceso.access) throw fallo(403, MENSAJE_SIN_ACCESO)

  // Lista de supresión: se comprueban TODOS los destinatarios, no solo el principal. El mensaje se
  // guarda igualmente aunque no salga, para que quede rastro en el hilo y en el historial.
  const bloqueados = await filtrarSuprimidos(locationId, [destino, ...cc, ...bcc])
  const supresion = bloqueados.get(destino.toLowerCase()) ?? null
  const sinSuprimir = (lista) => {
    const quedan = lista.filter((d) => !bloqueados.has(d.toLowerCase()))
    return quedan.length ? quedan : null
  }
  const ccFinal = sinSuprimir(cc)
  const bccFinal = sinSuprimir(bcc)

  const estado = supresion ? 'suprimido' : 'encolado'
  const rango = supresion ? RANGO_SUPRIMIDO : RANGO_ENCOLADO
  const ultimoError = supresion ? `Destinatario en la lista de supresión (${supresion.reason})` : null

  // Límite de envíos de la subcuenta: solo si el mensaje va a salir de verdad.
  if (!supresion) {
    const cupo = await consumirLimiteEnvio(locationId)
    if (!cupo.ok) throw fallo(429, cupo.motivo || 'Se ha alcanzado el límite de envíos de esta subcuenta')
  }

  const { rows: [insertado] } = await q(
    `INSERT INTO messages (location_id, provider_id, sender_id, template_id, origin, status, status_rank,
                           to_email, to_name, cc, bcc, reply_to, subject, preheader, html, text,
                           correlation_id, last_error, extra_headers, inbox_reply_to_id, thread_key)
     VALUES ($1,$2,$3,NULL,'buzon',$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13,$14,$15,$16::jsonb,$17,$18)
     RETURNING id, status, created_at`,
    [
      locationId, proveedor.id, remitente.id, estado, rango,
      destino, nombreDestino, ccFinal, bccFinal, replyToDe(remitente, original.cuenta_email),
      asunto, html, text, randomCorrelationId(), ultimoError,
      JSON.stringify(cabecerasHilo(original)), original.id, original.thread_key,
    ]
  )

  // Copias suprimidas: queda escrito en el histórico por qué a esa dirección no le llegó nada.
  if (bloqueados.size && !supresion) {
    await q(
      `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
       VALUES ($1,'destinatarios_suprimidos', now(), 'buzon-supresion', $2::jsonb)
       ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
      [
        insertado.id,
        JSON.stringify({
          direcciones: Object.fromEntries([...bloqueados].map(([email, f]) => [email, f.reason])),
        }),
      ]
    ).catch((err) => log?.warn?.({ err, mensaje: insertado.id }, 'buzón: no se pudo registrar la supresión parcial'))
  }

  // Contestar o reenviar algo es haberlo leído.
  await q('UPDATE inbox_messages SET is_read = true WHERE id = $1 AND NOT is_read', [original.id])

  return {
    ok: true,
    message_id: String(insertado.id),
    estado: insertado.status,
    to_email: destino,
    cc: ccFinal,
    bcc: bccFinal,
    subject: asunto,
    remitente: { id: remitente.id, email: remitente.email, name: remitente.name },
    created_at: insertado.created_at,
    aviso: supresion
      ? `El destinatario ${destino} está en la lista de supresión (${supresion.reason}): el mensaje se ha guardado pero no saldrá`
      : bloqueados.size
        ? `Algunas direcciones en copia están en la lista de supresión y no lo recibirán: ${[...bloqueados.keys()].join(', ')}`
        : null,
  }
}

// ---------------------------------------------------------------------------

export default async function buzonRoutes(app) {
  const guard = { preHandler: requireLocation }
  const loc = (req) => req.locationId

  const cuentaDe = async (id, locationId) => {
    const { rows: [c] } = await q(
      `SELECT ${COLUMNAS_CUENTA} ${JOINS_CUENTA} WHERE b.id = $1 AND b.location_id = $2`,
      [id, locationId]
    )
    return c || null
  }

  // Mensaje recibido con los datos de su cuenta (para citarlo, responderlo o borrarlo).
  const originalDe = async (id, locationId) => {
    const { rows: [m] } = await q(
      `SELECT m.*, b.email AS cuenta_email, b.name AS cuenta_nombre, b.reply_sender_id
         FROM inbox_messages m JOIN mailboxes b ON b.id = m.mailbox_id
        WHERE m.id = $1 AND m.location_id = $2`,
      [id, locationId]
    )
    return m || null
  }

  // Limitador por subcuenta para las acciones que abren una conexión IMAP desde el panel.
  const frenar = async (clave, locationId, maximo, ventanaS) => (await rateLimit(`buzon:${clave}:${locationId}`, maximo, ventanaS)).ok

  // ---------------------------------------------------------------------------
  // Cuentas IMAP
  // ---------------------------------------------------------------------------
  app.get('/api/loc/buzon/cuentas', guard, async (req) => {
    const { rows } = await q(
      `SELECT ${COLUMNAS_CUENTA} ${JOINS_CUENTA} WHERE b.location_id = $1 ORDER BY b.name, b.id`,
      [loc(req)]
    )
    return { cuentas: rows.map(serializarCuenta) }
  })

  app.get('/api/loc/buzon/cuentas/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de cuenta no válido')
    const cuenta = await cuentaDe(id, loc(req))
    if (!cuenta) return reply.code(404).send({ error: 'Cuenta de buzón no encontrada' })
    return { cuenta: serializarCuenta(cuenta) }
  })

  app.post('/api/loc/buzon/cuentas', guard, async (req, reply) => {
    const locationId = loc(req)
    const b = req.body || {}
    const r = await leerCuenta(b, locationId)
    if (r.error) return malo(reply, r.error)
    const d = r.datos
    const contrasena = contrasenaDe(b)
    if (!contrasena) return malo(reply, 'La contraseña IMAP es obligatoria (Gmail y Outlook exigen una «contraseña de aplicación»)')
    if (contrasena.length > MAX_CONTRASENA) return malo(reply, 'La contraseña es demasiado larga')

    const { rows: [{ n }] } = await q('SELECT COUNT(*)::int AS n FROM mailboxes WHERE location_id=$1', [locationId])
    if (n >= MAX_CUENTAS) return malo(reply, `Has llegado al máximo de ${MAX_CUENTAS} cuentas de buzón por subcuenta`)

    let id
    try {
      const { rows: [creada] } = await q(
        `INSERT INTO mailboxes (location_id, name, email, host, port, secure, username, password_enc, folder,
                                delete_after_import, sync_interval_min, reply_sender_id, enabled)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [
          locationId, d.name, d.email, d.host, d.port, d.secure, d.username, cifrarContrasena(d.username, contrasena),
          d.folder, d.delete_after_import, d.sync_interval_min, d.reply_sender_id, d.enabled,
        ]
      )
      id = creada.id
    } catch (err) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Ya tienes una cuenta de buzón con ese correo' })
      throw err
    }
    return reply.code(201).send({ cuenta: serializarCuenta(await cuentaDe(id, locationId)) })
  })

  app.patch('/api/loc/buzon/cuentas/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de cuenta no válido')
    const locationId = loc(req)
    const actual = await cuentaDe(id, locationId)
    if (!actual) return reply.code(404).send({ error: 'Cuenta de buzón no encontrada' })

    const b = req.body || {}
    const r = await leerCuenta(b, locationId, { parcial: true })
    if (r.error) return malo(reply, r.error)
    const d = r.datos

    const campos = []
    const params = []
    const set = (columna, valor) => {
      params.push(valor)
      campos.push(`${columna} = $${params.length}`)
    }
    for (const [columna, valor] of Object.entries(d)) set(columna, valor)

    // la contraseña es opcional: si no llega (o llega vacía) se conserva la guardada
    const contrasena = contrasenaDe(b)
    if (contrasena) {
      if (contrasena.length > MAX_CONTRASENA) return malo(reply, 'La contraseña es demasiado larga')
      set('password_enc', cifrarContrasena(d.username ?? actual.username, contrasena))
    }
    if (!campos.length) return malo(reply, 'No hay nada que actualizar')

    // Cambiar de servidor, usuario o carpeta cambia el espacio de UIDs: el cursor vuelve a cero
    // para que la siguiente sincronización traiga lo que haya allí (el dedupe por Message-ID
    // evita duplicados si es el mismo correo). Con credenciales o servidor nuevos, además, el
    // estado pasa a «sin probar» hasta que se compruebe la conexión.
    const reinicia = ['host', 'username', 'folder'].some((c) => d[c] !== undefined && d[c] !== actual[c])
    if (reinicia) campos.push('last_uid = 0', 'uidvalidity = NULL')
    const reprobar = reinicia || Boolean(contrasena) || (d.port !== undefined && d.port !== actual.port) ||
      (d.secure !== undefined && d.secure !== actual.secure)
    if (reprobar) campos.push(`status = 'sin_probar'`, 'last_error = NULL')

    params.push(id, locationId)
    try {
      await q(
        `UPDATE mailboxes SET ${campos.join(', ')}, updated_at = now()
          WHERE id = $${params.length - 1} AND location_id = $${params.length}`,
        params
      )
    } catch (err) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Ya tienes una cuenta de buzón con ese correo' })
      throw err
    }
    return { cuenta: serializarCuenta(await cuentaDe(id, locationId)) }
  })

  // Borra la cuenta y, en cascada, sus mensajes y adjuntos. El espacio liberado se calcula en la
  // misma transacción con la fila de la cuenta bloqueada (una sincronización que estuviera
  // insertando espera al FK y falla después) y, tras el COMMIT, el contador de la cuota se
  // recalcula desde las tablas en vez de restar: así el borrado de una cuenta deja siempre el
  // contador exacto, aunque viniera descuadrado.
  app.delete('/api/loc/buzon/cuentas/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de cuenta no válido')
    const locationId = loc(req)

    let bytes = 0
    let mensajes = 0
    const cliente = await pool.connect()
    try {
      await cliente.query('BEGIN')
      const { rows: [cuenta] } = await cliente.query(
        'SELECT id FROM mailboxes WHERE id = $1 AND location_id = $2 FOR UPDATE', [id, locationId])
      if (!cuenta) {
        await cliente.query('ROLLBACK')
        return reply.code(404).send({ error: 'Cuenta de buzón no encontrada' })
      }
      const { rows: [uso] } = await cliente.query(
        `SELECT COUNT(m.id)::int AS mensajes,
                (COALESCE(SUM(m.size_bytes), 0) + COALESCE((
                   SELECT SUM(a.size_bytes) FROM inbox_attachments a
                     JOIN inbox_messages mm ON mm.id = a.message_id
                    WHERE mm.mailbox_id = $1), 0))::bigint AS bytes
           FROM inbox_messages m WHERE m.mailbox_id = $1`,
        [id]
      )
      await cliente.query('DELETE FROM mailboxes WHERE id = $1 AND location_id = $2', [id, locationId])
      await cliente.query('COMMIT')
      bytes = Number(uso.bytes) || 0
      mensajes = uso.mensajes
    } catch (err) {
      await cliente.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      cliente.release()
    }

    let usadoBytes = null
    try {
      usadoBytes = await recalcularUso(locationId)
    } catch (err) {
      req.log.warn({ err, bytes }, 'buzón: la cuenta se borró pero no se pudo recalcular el espacio usado')
    }
    return {
      ok: true,
      mensajes_borrados: mensajes,
      bytes_liberados: bytes,
      bytes_legible: tamanoLegible(bytes),
      usado_bytes: usadoBytes,
    }
  })

  // Conecta y abre la carpeta → { ok, detalle, mensajes_en_servidor }. Deja el estado en la cuenta.
  app.post('/api/loc/buzon/cuentas/:id/probar', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de cuenta no válido')
    const locationId = loc(req)
    const cuenta = await cuentaDe(id, locationId)
    if (!cuenta) return reply.code(404).send({ error: 'Cuenta de buzón no encontrada' })
    if (!(await frenar('probar', locationId, 20, 60))) {
      return reply.code(429).send({ error: 'Demasiadas pruebas seguidas. Espera un minuto.' })
    }
    if (!(await destinoPermitido(cuenta.host))) {
      return malo(reply, 'El servidor IMAP configurado apunta a una dirección de red interna y no se puede probar')
    }

    let resultado
    try {
      const r = await probarBuzon(id)
      resultado = {
        ok: r?.ok === true,
        detalle: texto(r?.detalle) || (r?.ok === true ? 'Conexión correcta' : 'No se pudo conectar con el servidor IMAP'),
        mensajes_en_servidor: Number.isFinite(Number(r?.mensajes_en_servidor)) ? Number(r.mensajes_en_servidor) : null,
      }
    } catch (err) {
      // solo el mensaje del servidor: la contraseña no pasa por aquí ni por el log
      resultado = { ok: false, detalle: texto(err?.message) || 'No se pudo conectar con el servidor IMAP', mensajes_en_servidor: null }
    }
    // un buzón parado por cuota sigue parado aunque la conexión funcione
    await q(
      `UPDATE mailboxes
          SET status = CASE WHEN $2 THEN (CASE WHEN status = 'cuota_llena' THEN status ELSE 'ok' END) ELSE 'error' END,
              last_error = $3, updated_at = now()
        WHERE id = $1 AND location_id = $4`,
      [id, resultado.ok, resultado.ok ? null : resultado.detalle.slice(0, 500), locationId]
    )
    return resultado
  })

  // Fuerza una pasada de sincronización ahora → { ok, nuevos, detalle }.
  //
  // La pasada corre dentro de la petición HTTP, así que se acota (MAX_MENSAJES_FORZADA mensajes y
  // PLAZO_FORZADA_MS de importación; lo que quede sigue en la siguiente pasada del bucle) y, si aun
  // así el servidor IMAP tarda (conectar y abrir la carpeta tienen sus propios plazos), pasado
  // PLAZO_RESPUESTA_MS se responde { ok:true, en_curso:true } y la pasada termina en segundo plano:
  // un proxy con timeout de 60-100 s cortaría la respuesta y el panel mostraría un error falso.
  app.post('/api/loc/buzon/cuentas/:id/sincronizar', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de cuenta no válido')
    const locationId = loc(req)
    const cuenta = await cuentaDe(id, locationId)
    if (!cuenta) return reply.code(404).send({ error: 'Cuenta de buzón no encontrada' })
    if (!(await frenar('sincronizar', locationId, 10, 60))) {
      return reply.code(429).send({ error: 'Demasiadas sincronizaciones seguidas. Espera un minuto.' })
    }
    if (!(await destinoPermitido(cuenta.host))) {
      return malo(reply, 'El servidor IMAP configurado apunta a una dirección de red interna y no se puede sincronizar')
    }

    const pasada = sincronizarBuzon(id, { log: req.log, forzar: true, maxMensajes: MAX_MENSAJES_FORZADA, plazoMs: PLAZO_FORZADA_MS })
      .catch((err) => ({ ok: false, nuevos: 0, detalle: texto(err?.message) || 'No se pudo sincronizar el buzón' }))
    let temporizador
    const plazo = new Promise((resolve) => {
      temporizador = setTimeout(() => resolve(EN_CURSO), PLAZO_RESPUESTA_MS)
    })
    const r = await Promise.race([pasada, plazo]).finally(() => clearTimeout(temporizador))

    let resultado
    if (r === EN_CURSO) {
      // la pasada sigue; cuando acabe deja su resultado en la cuenta (status, last_error, last_sync_at)
      pasada.then((fin) => {
        if (fin?.nuevos || !fin?.ok) req.log.info({ buzon: id, ok: fin?.ok, nuevos: fin?.nuevos, detalle: fin?.detalle }, 'buzón sincronizado en segundo plano')
      })
      resultado = {
        ok: true,
        en_curso: true,
        nuevos: 0,
        detalle: 'El servidor de correo está tardando: la sincronización sigue en segundo plano y la bandeja se actualizará sola en un momento',
      }
    } else {
      resultado = {
        ok: r?.ok === true,
        en_curso: false,
        nuevos: Number(r?.nuevos) || 0,
        detalle: texto(r?.detalle) || (r?.ok === true ? 'Sincronización completada' : 'No se pudo sincronizar el buzón'),
      }
    }
    const tras = await cuentaDe(id, locationId)
    return { ...resultado, cuenta: tras ? serializarCuenta(tras) : null }
  })

  // ---------------------------------------------------------------------------
  // Mensajes
  // ---------------------------------------------------------------------------

  // Filtros comunes de la bandeja (alias m: inbox_messages). Devuelve un error en español o null.
  const filtrosBandeja = (query, where, params) => {
    const qy = query || {}
    const cuenta = texto(qy.cuenta)
    if (cuenta) {
      const mailboxId = idDe(cuenta)
      if (!mailboxId) return 'La cuenta indicada no es válida'
      params.push(mailboxId)
      where.push(`m.mailbox_id = $${params.length}`)
    }
    if (bandera(qy.no_leidos)) where.push('NOT m.is_read')
    const desde = texto(qy.desde)
    if (desde) {
      if (!fechaValida(desde)) return 'La fecha "desde" no es válida (usa AAAA-MM-DD)'
      params.push(desde)
      where.push(`m.date >= $${params.length}::timestamptz`)
    }
    const hasta = texto(qy.hasta)
    if (hasta) {
      if (!fechaValida(hasta)) return 'La fecha "hasta" no es válida (usa AAAA-MM-DD)'
      params.push(hasta)
      where.push(
        RE_FECHA.test(hasta)
          ? `m.date < ($${params.length}::timestamptz + interval '1 day')`
          : `m.date <= $${params.length}::timestamptz`
      )
    }
    const busqueda = texto(qy.q)
    if (busqueda) {
      if (busqueda.length > 200) return 'La búsqueda es demasiado larga'
      params.push(patronBusqueda(busqueda))
      const p = `$${params.length}`
      where.push(
        `(m.from_email::text ILIKE ${p} ESCAPE '\\' OR m.from_name ILIKE ${p} ESCAPE '\\' ` +
        `OR m.subject ILIKE ${p} ESCAPE '\\' OR m.snippet ILIKE ${p} ESCAPE '\\')`
      )
    }
    return null
  }

  // Carpeta «Enviados desde el buzón» (alias x: messages con origin='buzon').
  const filtrosEnviados = (query, where, params) => {
    const qy = query || {}
    const desde = texto(qy.desde)
    if (desde) {
      if (!fechaValida(desde)) return 'La fecha "desde" no es válida (usa AAAA-MM-DD)'
      params.push(desde)
      where.push(`x.created_at >= $${params.length}::timestamptz`)
    }
    const hasta = texto(qy.hasta)
    if (hasta) {
      if (!fechaValida(hasta)) return 'La fecha "hasta" no es válida (usa AAAA-MM-DD)'
      params.push(hasta)
      where.push(
        RE_FECHA.test(hasta)
          ? `x.created_at < ($${params.length}::timestamptz + interval '1 day')`
          : `x.created_at <= $${params.length}::timestamptz`
      )
    }
    const busqueda = texto(qy.q)
    if (busqueda) {
      if (busqueda.length > 200) return 'La búsqueda es demasiado larga'
      params.push(patronBusqueda(busqueda))
      const p = `$${params.length}`
      where.push(`(x.to_email::text ILIKE ${p} ESCAPE '\\' OR x.subject ILIKE ${p} ESCAPE '\\')`)
    }
    // los enviados no tienen cuenta IMAP; se respeta el filtro «cuenta» acotando por el original
    const cuenta = texto(qy.cuenta)
    if (cuenta) {
      const mailboxId = idDe(cuenta)
      if (!mailboxId) return 'La cuenta indicada no es válida'
      params.push(mailboxId)
      where.push(`EXISTS (SELECT 1 FROM inbox_messages o WHERE o.id = x.inbox_reply_to_id AND o.mailbox_id = $${params.length})`)
    }
    return null
  }

  // Total de no leídos de la subcuenta (opcionalmente de una cuenta): alimenta el contador del menú.
  const noLeidosDe = async (locationId, mailboxId) => {
    const { rows: [f] } = await q(
      `SELECT COUNT(*)::int AS n FROM inbox_messages
        WHERE location_id = $1 AND NOT is_read AND ($2::bigint IS NULL OR mailbox_id = $2)`,
      [locationId, mailboxId]
    )
    return f.n
  }

  app.get('/api/loc/buzon/mensajes', guard, async (req, reply) => {
    const locationId = loc(req)
    const carpeta = texto(req.query?.carpeta) || (bandera(req.query?.no_leidos) ? 'no_leidos' : 'bandeja')
    if (!CARPETAS.has(carpeta)) return malo(reply, 'La carpeta tiene que ser «bandeja», «no_leidos» o «enviados»')
    const { limite, pagina, offset } = paginar(req.query)
    const mailboxId = texto(req.query?.cuenta) ? idDe(req.query.cuenta) : null

    if (carpeta === 'enviados') {
      const where = ['x.location_id = $1', `x.origin = 'buzon'`]
      const params = [locationId]
      const err = filtrosEnviados(req.query, where, params)
      if (err) return malo(reply, err)
      const filtro = where.join(' AND ')
      const [filas, total, noLeidos] = await Promise.all([
        q(
          `SELECT ${COLUMNAS_ENVIADO} FROM messages x LEFT JOIN senders s ON s.id = x.sender_id
            WHERE ${filtro} ORDER BY x.created_at DESC, x.id DESC LIMIT ${limite} OFFSET ${offset}`,
          params
        ),
        q(`SELECT COUNT(*)::int AS n FROM messages x WHERE ${filtro}`, params),
        noLeidosDe(locationId, mailboxId),
      ])
      return {
        carpeta,
        mensajes: filas.rows.map(filaEnviado),
        total: total.rows[0].n,
        pagina,
        limite,
        paginas: paginasDe(total.rows[0].n, limite),
        no_leidos: noLeidos,
      }
    }

    const where = ['m.location_id = $1']
    const params = [locationId]
    if (carpeta === 'no_leidos') where.push('NOT m.is_read')
    const err = filtrosBandeja(req.query, where, params)
    if (err) return malo(reply, err)
    const filtro = where.join(' AND ')
    const [filas, total, noLeidos] = await Promise.all([
      q(
        `SELECT m.id, m.mailbox_id, m.from_email, m.from_name, m.subject, m.date, m.snippet, m.size_bytes,
                m.has_attachments, m.is_read, m.thread_key, m.message_id,
                b.name AS cuenta_nombre, b.email AS cuenta_email,
                (SELECT COUNT(*)::int FROM messages x
                  WHERE x.location_id = m.location_id AND x.thread_key = m.thread_key) AS respuestas
           FROM inbox_messages m JOIN mailboxes b ON b.id = m.mailbox_id
          WHERE ${filtro} ORDER BY m.date DESC, m.id DESC LIMIT ${limite} OFFSET ${offset}`,
        params
      ),
      q(`SELECT COUNT(*)::int AS n FROM inbox_messages m WHERE ${filtro}`, params),
      noLeidosDe(locationId, mailboxId),
    ])
    return {
      carpeta,
      mensajes: filas.rows.map(filaRecibido),
      total: total.rows[0].n,
      pagina,
      limite,
      paginas: paginasDe(total.rows[0].n, limite),
      no_leidos: noLeidos,
    }
  })

  // Mensaje completo + adjuntos (metadatos) + hilo. Abrirlo lo marca como leído.
  app.get('/api/loc/buzon/mensajes/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de mensaje no válido')
    const locationId = loc(req)
    const m = await originalDe(id, locationId)
    if (!m) return reply.code(404).send({ error: 'Mensaje no encontrado' })

    const [{ rows: adjuntos }, { rows: recibidos }, { rows: enviados }] = await Promise.all([
      q(
        `SELECT id, filename, content_type, size_bytes, created_at FROM inbox_attachments
          WHERE message_id = $1 ORDER BY id`,
        [id]
      ),
      q(
        `SELECT m.id, m.mailbox_id, m.from_email, m.from_name, m.recipients, m.subject, m.date, m.snippet,
                m.text, m.html, m.size_bytes, m.has_attachments, m.is_read, m.message_id, m.thread_key,
                b.name AS cuenta_nombre, b.email AS cuenta_email
           FROM inbox_messages m JOIN mailboxes b ON b.id = m.mailbox_id
          WHERE m.location_id = $1 AND m.thread_key = $2
          ORDER BY m.date, m.id LIMIT ${MAX_HILO}`,
        [locationId, m.thread_key]
      ),
      q(
        `SELECT ${COLUMNAS_ENVIADO}, x.html, x.text
           FROM messages x LEFT JOIN senders s ON s.id = x.sender_id
          WHERE x.location_id = $1 AND x.thread_key = $2
          ORDER BY x.created_at, x.id LIMIT ${MAX_HILO}`,
        [locationId, m.thread_key]
      ),
    ])
    if (!m.is_read) {
      await q('UPDATE inbox_messages SET is_read = true WHERE id = $1 AND location_id = $2', [id, locationId])
    }

    const hilo = [
      ...recibidos.map((r) => ({
        ...filaRecibido(r),
        is_read: r.id === id ? true : r.is_read,
        recipients: destinatariosDe(r.recipients),
        html: r.html,
        text: r.text,
      })),
      ...enviados.map((x) => ({ ...filaEnviado(x), html: x.html, text: x.text })),
    ].sort((a, b) => new Date(a.date) - new Date(b.date) || (a.tipo === b.tipo ? a.id - b.id : a.tipo === 'recibido' ? -1 : 1))

    return {
      mensaje: {
        ...filaRecibido({ ...m, respuestas: enviados.length }),
        is_read: true,
        uid: Number(m.uid) || null,
        in_reply_to: m.in_reply_to ?? null,
        references: m.references ?? null,
        recipients: destinatariosDe(m.recipients),
        html: m.html,
        text: m.text,
        reply_sender_id: m.reply_sender_id ?? null,
        created_at: m.created_at,
      },
      adjuntos: adjuntos.map((a) => ({
        id: a.id,
        filename: a.filename,
        content_type: a.content_type,
        size_bytes: Number(a.size_bytes) || 0,
        size_legible: tamanoLegible(Number(a.size_bytes) || 0),
        url: `/api/loc/buzon/adjuntos/${a.id}`,
      })),
      hilo,
    }
  })

  app.patch('/api/loc/buzon/mensajes/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de mensaje no válido')
    const b = req.body || {}
    if (b.is_read === undefined) return malo(reply, 'No hay nada que actualizar')
    const leido = booleano(b.is_read, null)
    if (leido === null) return malo(reply, 'El valor de «is_read» tiene que ser verdadero o falso')
    const { rows: [m] } = await q(
      'UPDATE inbox_messages SET is_read = $3 WHERE id = $1 AND location_id = $2 RETURNING id, is_read',
      [id, loc(req), leido]
    )
    if (!m) return reply.code(404).send({ error: 'Mensaje no encontrado' })
    return { ok: true, id: m.id, is_read: m.is_read }
  })

  // Borra el mensaje y sus adjuntos descontando la cuota. Con ?servidor=1 lo borra también en el
  // IMAP si su UID sigue existiendo; si el servidor no responde, se borra igualmente en la app y
  // se devuelve borrado_servidor:false con el motivo.
  app.delete('/api/loc/buzon/mensajes/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de mensaje no válido')
    const locationId = loc(req)
    const { rows: [m] } = await q(
      'SELECT id, mailbox_id, uid FROM inbox_messages WHERE id = $1 AND location_id = $2', [id, locationId])
    if (!m) return reply.code(404).send({ error: 'Mensaje no encontrado' })

    let borradoServidor = null
    let detalle = null
    if (bandera(req.query?.servidor)) {
      try {
        borradoServidor = (await borrarEnServidor(m.mailbox_id, Number(m.uid))) === true
        if (!borradoServidor) detalle = 'El mensaje ya no estaba en el servidor'
      } catch (err) {
        borradoServidor = false
        detalle = texto(err?.message) || 'No se pudo borrar el mensaje en el servidor IMAP'
      }
    }

    const r = await borrarMensajeBuzon(id, locationId)
    if (!r?.ok) return reply.code(404).send({ error: 'Mensaje no encontrado' })
    const bytes = Number(r.bytes) || 0
    return { ok: true, bytes, bytes_legible: tamanoLegible(bytes), borrado_servidor: borradoServidor, detalle }
  })

  // ---------------------------------------------------------------------------
  // Adjuntos: descarga con el tipo real pero como fichero (attachment + nosniff)
  // ---------------------------------------------------------------------------
  app.get('/api/loc/buzon/adjuntos/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de adjunto no válido')
    // la propiedad se comprueba por el mensaje al que pertenece: nunca se sirve un adjunto de otra subcuenta
    const { rows: [a] } = await q(
      `SELECT a.id, a.filename, a.content_type, a.content
         FROM inbox_attachments a JOIN inbox_messages m ON m.id = a.message_id
        WHERE a.id = $1 AND m.location_id = $2`,
      [id, loc(req)]
    )
    if (!a) return reply.code(404).send({ error: 'Adjunto no encontrado' })

    const contenido = Buffer.isBuffer(a.content) ? a.content : Buffer.from(a.content ?? '')
    const tipoBruto = texto(a.content_type).split(';')[0].trim().toLowerCase()
    const tipo = RE_TIPO_MIME.test(tipoBruto) && !RE_TIPO_ACTIVO.test(tipoBruto) ? tipoBruto : 'application/octet-stream'
    const nombre = texto(a.filename).replace(/[\r\n"\\/\x00-\x1f\x7f]/g, '_').slice(0, 200) || 'adjunto'
    const nombreAscii = nombre.replace(/[^\x20-\x7e]/g, '_')

    return reply
      .header('content-type', tipo)
      .header('content-length', String(contenido.length))
      .header('content-disposition', `attachment; filename="${nombreAscii}"; filename*=UTF-8''${encodeURIComponent(nombre)}`)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(Readable.from(contenido))
  })

  // ---------------------------------------------------------------------------
  // Responder y reenviar: se encola en `messages` (origin='buzon')
  // ---------------------------------------------------------------------------

  // {html, text, sender_id?, todos, cc, bcc} → Re: … con la cita del original al final
  app.post('/api/loc/buzon/mensajes/:id/responder', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de mensaje no válido')
    const locationId = loc(req)
    const original = await originalDe(id, locationId)
    if (!original) return reply.code(404).send({ error: 'Mensaje no encontrado' })
    const b = req.body || {}

    const destino = normalizarEmail(original.from_email)
    if (!esEmail(destino)) return malo(reply, 'El mensaje original no tiene un remitente válido al que responder')

    const cuerpo = cuerpoUsuario(b)
    if (cuerpo.error) return malo(reply, cuerpo.error)
    const compuesto = componerCuerpo(cuerpo, original, { conHtml: citaHtml, sinHtml: citaHtmlPlano, textoPie: citaTexto })
    if (compuesto.error) return malo(reply, compuesto.error)

    const ccBody = parseLista(b.cc, 'CC')
    if (ccBody.error) return malo(reply, ccBody.error)
    const bccBody = parseLista(b.bcc, 'BCC')
    if (bccBody.error) return malo(reply, bccBody.error)
    const todos = booleano(b.todos, false)
    if (todos === null) return malo(reply, 'El campo «todos» tiene que ser verdadero o falso')

    try {
      const remitente = await resolverRemitente(locationId, b.sender_id, original.reply_sender_id)
      const proveedor = await proveedorDe(remitente, locationId)

      // Responder a todos: los destinatarios del original menos nosotros (la cuenta del buzón y el
      // remitente con el que salimos) y menos el destino principal.
      const propios = new Set([destino, texto(original.cuenta_email).toLowerCase(), texto(remitente.email).toLowerCase()])
      const cc = []
      if (todos) {
        for (const d of destinatariosDe(original.recipients)) {
          if (!propios.has(d.email) && !cc.includes(d.email)) cc.push(d.email)
        }
      }
      for (const e of ccBody.lista) if (!propios.has(e) && !cc.includes(e)) cc.push(e)
      const bcc = bccBody.lista.filter((e) => !propios.has(e) && !cc.includes(e))
      if (cc.length + bcc.length > MAX_DESTINATARIOS_COPIA) {
        return malo(reply, `Demasiadas direcciones en copia (máximo ${MAX_DESTINATARIOS_COPIA})`)
      }

      const resultado = await encolarDesdeBuzon({
        locationId,
        log: req.log,
        original,
        remitente,
        proveedor,
        destino,
        nombreDestino: cabecera(original.from_name, 200) || null,
        cc,
        bcc,
        asunto: asuntoRespuesta(original.subject),
        html: compuesto.html,
        text: compuesto.text,
      })
      return reply.code(201).send(resultado)
    } catch (err) {
      if (err?.codigo) return reply.code(err.codigo).send({ error: err.message })
      throw err
    }
  })

  // {to, html, text, sender_id?} → Fwd: … con el original al final (sin adjuntos en esta versión)
  app.post('/api/loc/buzon/mensajes/:id/reenviar', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de mensaje no válido')
    const locationId = loc(req)
    const original = await originalDe(id, locationId)
    if (!original) return reply.code(404).send({ error: 'Mensaje no encontrado' })
    const b = req.body || {}

    const para = parseLista(b.to ?? b.para, 'Para')
    if (para.error) return malo(reply, para.error)
    if (!para.lista.length) return malo(reply, 'Indica a quién reenviar el mensaje')
    const ccBody = parseLista(b.cc, 'CC')
    if (ccBody.error) return malo(reply, ccBody.error)
    const bccBody = parseLista(b.bcc, 'BCC')
    if (bccBody.error) return malo(reply, bccBody.error)

    // reenviar sin añadir nada es legítimo: el cuerpo propio es opcional
    const cuerpo = cuerpoUsuario(b, { opcional: true })
    if (cuerpo.error) return malo(reply, cuerpo.error)
    const compuesto = componerCuerpo(cuerpo, original, { conHtml: reenvioHtml, sinHtml: reenvioHtmlPlano, textoPie: reenvioTexto })
    if (compuesto.error) return malo(reply, compuesto.error)

    try {
      const remitente = await resolverRemitente(locationId, b.sender_id, original.reply_sender_id)
      const proveedor = await proveedorDe(remitente, locationId)

      const [destino, ...resto] = para.lista
      const cc = [...resto]
      for (const e of ccBody.lista) if (e !== destino && !cc.includes(e)) cc.push(e)
      const bcc = bccBody.lista.filter((e) => e !== destino && !cc.includes(e))
      if (cc.length + bcc.length > MAX_DESTINATARIOS_COPIA) {
        return malo(reply, `Demasiadas direcciones en copia (máximo ${MAX_DESTINATARIOS_COPIA})`)
      }

      const resultado = await encolarDesdeBuzon({
        locationId,
        log: req.log,
        original,
        remitente,
        proveedor,
        destino,
        nombreDestino: null,
        cc,
        bcc,
        asunto: asuntoReenvio(original.subject),
        html: compuesto.html,
        text: compuesto.text,
      })
      if (original.has_attachments) {
        const nota = 'Los adjuntos del mensaje original no se reenvían en esta versión: descárgalos y adjúntalos desde tu correo si hacen falta'
        resultado.aviso = resultado.aviso ? `${resultado.aviso}. ${nota}` : nota
      }
      return reply.code(201).send(resultado)
    } catch (err) {
      if (err?.codigo) return reply.code(err.codigo).send({ error: err.message })
      throw err
    }
  })

  // ---------------------------------------------------------------------------
  // Espacio
  // ---------------------------------------------------------------------------
  app.get('/api/loc/buzon/espacio', guard, async (req) => {
    const locationId = loc(req)
    const [cuota, { rows: cuentas }] = await Promise.all([
      cuotaDe(locationId),
      q(`SELECT ${COLUMNAS_CUENTA} ${JOINS_CUENTA} WHERE b.location_id = $1 ORDER BY b.name, b.id`, [locationId]),
    ])
    const usado = Number(cuota?.usado_bytes) || 0
    const cuotaMb = Number(cuota?.cuota_mb) || 0
    const porcentaje = Number.isFinite(Number(cuota?.porcentaje))
      ? Number(cuota.porcentaje)
      : cuotaMb > 0 ? Math.round((usado / (cuotaMb * 1024 * 1024)) * 1000) / 10 : 0
    const porCuenta = cuentas.map(serializarCuenta)
    return {
      usado_bytes: usado,
      usado_legible: tamanoLegible(usado),
      cuota_mb: cuotaMb,
      cuota_legible: tamanoLegible(cuotaMb * 1024 * 1024),
      porcentaje,
      // por encima de esto un correo se guarda solo con cabeceras y se conserva en el servidor
      max_mensaje_mb: config.buzon.maxMensajeMb,
      cuota_llena: porcentaje >= 100 || porCuenta.some((c) => c.status === 'cuota_llena'),
      no_leidos: porCuenta.reduce((acc, c) => acc + (c.no_leidos || 0), 0),
      por_cuenta: porCuenta.map((c) => ({
        id: c.id,
        name: c.name,
        email: c.email,
        status: c.status,
        enabled: c.enabled,
        mensajes: c.mensajes,
        no_leidos: c.no_leidos,
        usado_bytes: c.usado_bytes,
        usado_legible: c.usado_legible,
        porcentaje: usado > 0 ? Math.round((c.usado_bytes / usado) * 1000) / 10 : 0,
      })),
    }
  })
}
