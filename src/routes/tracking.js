import crypto from 'node:crypto'
import { q } from '../db.js'
import { verificarTokenApertura, verificarTokenEnlace } from '../lib/tracking.js'

// Seguimiento propio de aperturas y clics:
//   GET /t/a/:token.gif  → pixel 1×1 transparente, sin caché
//   GET /t/c/:token      → redirección al enlace ORIGINAL, que solo puede salir de message_links
//
// El redirector jamás acepta una URL por parámetro: eso sería un open redirect y un imán para phishing.
//
// La firma de los tokens NO se reimplementa aquí: se verifica con src/lib/tracking.js, que es quien
// los genera. Con dos implementaciones del mismo HMAC, cambiar el esquema en una sola dejaría de
// validar en silencio los pixels y los enlaces del correo YA enviado, sin error y sin log.
//
// Clasificación real/automático (SPEC §11.1): cada apertura y cada clic se clasifica ANTES de
// guardarse. Los automáticos (Apple MPP, escáneres de seguridad, bots) quedan en message_events
// para auditoría con automatico=true, pero NO tocan opened_at/clicked_at ni el estado del mensaje.
// Solo un evento real es prueba de que el correo llegó al buzón.

// GIF transparente de 1×1 (43 bytes), servido siempre, se reconozca el token o no.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')

const CABECERAS_SIN_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
}

// ---------------------------------------------------------------------------
// Señales de evento automático (SPEC §11.1)
// ---------------------------------------------------------------------------

// Proxy de imágenes de Gmail. MATIZ IMPORTANTE: descarga el pixel CUANDO el usuario abre de verdad
// (solo oculta la IP), así que en una APERTURA cuenta como REAL. En un CLIC, en cambio, es el fetch
// de un escáner: una persona que pulsa un enlace navega con su navegador, no con el proxy.
const UA_PROXY_GMAIL = /googleimageproxy|ggpht/i

// Apple Mail Privacy Protection precarga TODAS las imágenes, se abra o no el correo: su descarga
// del pixel no demuestra nada. Los fetch de Apple se identifican como CFNetwork/Darwin.
const UA_APPLE_MPP = /cfnetwork|darwin/i

// Escáneres de seguridad, proxys genéricos y bots: automáticos siempre, en aperturas y en clics.
const UA_ESCANER =
  /safelinks|urldefense|defender|barracuda|mimecast|proofpoint|forcepoint|symantec|trendmicro|yahoomailproxy|proxy|ahrefs|semrush|bot|crawler|spider|scanner|preview|monitor|validator|curl|wget|python|libwww|okhttp|go-http-client|java\/|headless|phantomjs/i

// Ventana de la ráfaga: un escáner visita todos los enlaces del mensaje casi a la vez; una persona
// no pulsa varios enlaces distintos en menos de 5 segundos.
const RAFAGA_MS = 5_000

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

function entero(valor, porDefecto) {
  const n = Number(valor)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto
}

// Umbral temporal: una apertura a menos de estos segundos del envío es el prefetch de un filtro,
// no una persona. Se lee en cada evento para que un cambio de env no exija reiniciar nada más.
const segundosMinimos = () => entero(process.env.TRACKING_SEGUNDOS_MINIMOS, 10)

/**
 * Clasifica una apertura de pixel. Cualquier señal basta para marcarla automática:
 * umbral temporal desde el envío, Apple MPP/CFNetwork o UA de escáner/bot.
 * GoogleImageProxy NO cuenta como automático aquí (ver el comentario del regex).
 */
export function clasificarApertura(userAgent, sentAt, ahora = new Date()) {
  if (sentAt && ahora.getTime() - new Date(sentAt).getTime() < segundosMinimos() * 1000) {
    return { automatico: true, motivo: 'umbral_temporal' }
  }
  const ua = texto(userAgent)
  if (UA_PROXY_GMAIL.test(ua)) return { automatico: false, motivo: null }
  if (UA_APPLE_MPP.test(ua)) return { automatico: true, motivo: 'apple_mpp' }
  if (UA_ESCANER.test(ua)) return { automatico: true, motivo: 'user_agent' }
  return { automatico: false, motivo: null }
}

/**
 * Clasifica un clic del redirector. Señales: petición HEAD (los escáneres sondean sin navegar),
 * ráfaga sobre varios enlaces distintos del mismo mensaje en menos de 5 s, o UA de proxy/escáner
 * (aquí GoogleImageProxy SÍ es automático: un clic suyo es un fetch de análisis, no una persona).
 */
export function clasificarClic({ userAgent, metodo, rafaga }) {
  if (texto(metodo).toUpperCase() === 'HEAD') return { automatico: true, motivo: 'metodo_head' }
  if (rafaga) return { automatico: true, motivo: 'rafaga' }
  const ua = texto(userAgent)
  if (UA_PROXY_GMAIL.test(ua) || UA_APPLE_MPP.test(ua) || UA_ESCANER.test(ua)) {
    return { automatico: true, motivo: 'user_agent' }
  }
  return { automatico: false, motivo: null }
}

// ---------------------------------------------------------------------------
// Resolución de tokens
// ---------------------------------------------------------------------------

/**
 * Mensaje al que apunta el pixel. SOLO se acepta el token con firma HMAC.
 *
 * Antes se admitía también un valor sin firma tratado como correlation_id, y eso era un agujero: el
 * correlation_id NO es un secreto (viaja en la cabecera X-Correlation-Id del propio correo, y en
 * X-Mailin-custom con Brevo), así que cualquier destinatario que mirase las cabeceras del mensaje
 * podía fabricarse aperturas a voluntad y contaminar las métricas del panel. Ningún emisor de la app
 * genera pixels por correlation_id, así que la rama no daba compatibilidad con nada.
 */
async function mensajeDeTokenApertura(token) {
  const id = verificarTokenApertura(token)
  if (!id) return null
  const { rows: [m] } = await q('SELECT id, sent_at FROM messages WHERE id = $1', [Number(id)])
  return m ?? null
}

async function enlaceDeToken(token) {
  const limpio = texto(token)
  if (!limpio || limpio.length > 200) return null

  const { rows: [exacto] } = await q('SELECT id, message_id, url FROM message_links WHERE token = $1', [limpio])
  if (exacto) return exacto

  // tolerancia: el token puede haberse guardado sin la firma que viaja en la URL
  const base = verificarTokenEnlace(limpio)
  if (!base) return null
  const { rows: [fila] } = await q('SELECT id, message_id, url FROM message_links WHERE token = $1', [base])
  return fila ?? null
}

const cuboHorario = (fecha) => fecha.toISOString().slice(0, 13)

const huellaAgente = (userAgent, ip) =>
  crypto.createHash('sha1').update(`${userAgent}|${ip}`).digest('hex').slice(0, 12)

// ---------------------------------------------------------------------------
// Promoción de estados y convalidación de aperturas
// ---------------------------------------------------------------------------

// Rango de 'entregado' en la máquina de estados (SPEC §4), el mismo que aplica webhooks.js.
const RANGO_ENTREGADO = 30

/**
 * Todo evento REAL (apertura o clic) es prueba de entrega (SPEC §11.1): si el mensaje aún no
 * está confirmado se promociona a 'entregado' con el evento 'entrega_confirmada'.
 * Misma mecánica de status_rank que webhooks.js: nunca se retrocede, y los terminales (≥90)
 * no se tocan porque su rango ya supera al de 'entregado'.
 */
async function confirmarEntrega(messageId, fuente, cuando) {
  const { rowCount } = await q(
    `UPDATE messages
        SET status = 'entregado', status_rank = $2::int, updated_at = now()
      WHERE id = $1 AND status_rank < $2::int`,
    [messageId, RANGO_ENTREGADO]
  )
  if (!rowCount) return

  await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, automatico, data)
     VALUES ($1,'entrega_confirmada',$2,'entrega_confirmada',false,$3)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
    [messageId, cuando, JSON.stringify({ fuente })]
  )
}

/**
 * Un clic real convalida la apertura (SPEC §11.1): si el pixel se bloqueó pero alguien pulsó un
 * enlace, el correo se abrió. Se inserta la apertura real con data.fuente='clic' SOLO si el
 * mensaje no tenía ya una apertura real; el dedupe fijo garantiza una sola por mensaje.
 */
async function convalidarApertura(messageId, { userAgent, ip }, cuando) {
  const { rows: [previa] } = await q(
    `SELECT id FROM message_events
      WHERE message_id = $1 AND event = 'apertura' AND NOT automatico
      LIMIT 1`,
    [messageId]
  )
  if (previa) return

  await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, automatico, data)
     VALUES ($1,'apertura',$2,'apertura:clic',false,$3)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
    [messageId, cuando, JSON.stringify({ fuente: 'clic', user_agent: userAgent, ip })]
  )
}

// ---------------------------------------------------------------------------
// Registro de eventos
// ---------------------------------------------------------------------------

async function registrarApertura(mensaje, req) {
  const ahora = new Date()
  const userAgent = texto(req.headers['user-agent']).slice(0, 500)
  const ip = texto(req.ip).slice(0, 60)
  const { automatico, motivo } = clasificarApertura(userAgent, mensaje.sent_at, ahora)

  // Una apertura por hora, agente y CLASE: los proxies recargan el pixel sin parar, y separar
  // real/auto en la clave evita que un prefetch automático nada más enviar se trague la apertura
  // real del mismo agente una hora después.
  const dedupe = `pixel:${automatico ? 'auto' : 'real'}:${cuboHorario(ahora)}:${huellaAgente(userAgent, ip)}`

  const { rows: [nuevo] } = await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, automatico, data)
     VALUES ($1,'apertura',$2,$3,$4,$5)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [mensaje.id, ahora, dedupe, automatico,
     JSON.stringify({ fuente: 'pixel', user_agent: userAgent, ip, automatico, motivo })]
  )
  if (!nuevo || automatico) return

  // opened_at solo refleja eventos REALES (SPEC §11.1) y es una marca, NO un estado
  await q('UPDATE messages SET opened_at = COALESCE(opened_at, $2), updated_at = now() WHERE id = $1',
    [mensaje.id, ahora])
  await confirmarEntrega(mensaje.id, 'pixel', ahora)
}

/** ¿Hay un clic reciente sobre OTRO enlace del mismo mensaje? Entonces esto es una ráfaga. */
async function esRafaga(enlace, ahora) {
  const desde = new Date(ahora.getTime() - RAFAGA_MS)
  const { rows: [otro] } = await q(
    `SELECT 1 AS hay FROM message_events
      WHERE message_id = $1 AND event = 'clic' AND occurred_at >= $2
        AND COALESCE(data->>'url','') <> $3
      LIMIT 1`,
    [enlace.message_id, desde, enlace.url]
  )
  return Boolean(otro)
}

async function registrarClic(enlace, req) {
  const ahora = new Date()
  const userAgent = texto(req.headers['user-agent']).slice(0, 500)
  const ip = texto(req.ip).slice(0, 60)
  const metodo = texto(req.method).toUpperCase()

  // contador bruto del enlace: incluye lo automático a propósito (sirve para detectar escáneres)
  await q('UPDATE message_links SET clicks = clicks + 1 WHERE id = $1', [enlace.id])

  const rafaga = await esRafaga(enlace, ahora)
  const { automatico, motivo } = clasificarClic({ userAgent, metodo, rafaga })

  const dedupe = `clic:${enlace.id}:${automatico ? 'auto' : 'real'}:${cuboHorario(ahora)}:${huellaAgente(userAgent, ip)}`
  const { rows: [nuevo] } = await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, automatico, data)
     VALUES ($1,'clic',$2,$3,$4,$5)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [enlace.message_id, ahora, dedupe, automatico,
     JSON.stringify({ fuente: 'redirector', url: enlace.url, user_agent: userAgent, ip, automatico, motivo, metodo })]
  )
  if (!nuevo || automatico) return

  // clicked_at/opened_at solo con eventos REALES; un clic implica apertura aunque el pixel se bloqueara
  await q(
    `UPDATE messages SET clicked_at = COALESCE(clicked_at, $2), opened_at = COALESCE(opened_at, $2), updated_at = now()
      WHERE id = $1`,
    [enlace.message_id, ahora]
  )
  await convalidarApertura(enlace.message_id, { userAgent, ip }, ahora)
  await confirmarEntrega(enlace.message_id, 'clic', ahora)
}

// ---------------------------------------------------------------------------

export default async function trackingRoutes(app) {
  // El pixel devuelve SIEMPRE el GIF: un token inválido no puede distinguirse desde fuera.
  app.get('/t/a/:token', async (req, reply) => {
    reply.headers({ 'Content-Type': 'image/gif', 'Content-Length': PIXEL.length, ...CABECERAS_SIN_CACHE })

    mensajeDeTokenApertura(req.params.token)
      .then((mensaje) => (mensaje ? registrarApertura(mensaje, req) : null))
      .catch((err) => req.log.warn({ err }, 'no se pudo registrar una apertura'))

    return reply.send(PIXEL)
  })

  // Fastify atiende también los HEAD con este mismo handler: se registran igual y la clasificación
  // los marca automáticos (los escáneres sondean con HEAD; un navegador nunca).
  app.get('/t/c/:token', async (req, reply) => {
    let enlace = null
    try {
      enlace = await enlaceDeToken(req.params.token)
    } catch (err) {
      req.log.error({ err }, 'fallo resolviendo un enlace de seguimiento')
      return reply.code(503).type('text/plain; charset=utf-8').send('Servicio no disponible, vuelve a intentarlo')
    }

    // Solo se redirige a una URL registrada y solo si es http(s): nunca a nada que venga de la petición.
    if (!enlace || !/^https?:\/\//i.test(enlace.url)) {
      return reply.code(404).type('text/plain; charset=utf-8').send('Este enlace ha caducado o no existe')
    }

    registrarClic(enlace, req).catch((err) => req.log.warn({ err }, 'no se pudo registrar un clic'))

    reply.headers({ ...CABECERAS_SIN_CACHE, 'Referrer-Policy': 'no-referrer' })
    return reply.redirect(enlace.url, 302)
  })
}
