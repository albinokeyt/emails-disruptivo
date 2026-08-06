import crypto from 'node:crypto'
import { q } from '../db.js'
import { clavesCifrado } from '../lib/crypto.js'
import { normalizarEmail, suprimir } from '../lib/suppression.js'

// Receptor de eventos transaccionales de Brevo:  POST /api/webhooks/brevo/:token
//
// Brevo no firma nada: el token de la URL (uno por proveedor) es toda la autenticación.
// El formato del lote no está publicado, así que el receptor es tolerante: array, objeto que envuelve
// un array, o evento suelto. Los eventos llegan repetidos y desordenados, de ahí dedupe_key y status_rank.

const RANGO_TERMINAL = 90

// Mapa del vocabulario snake_case del payload → vocabulario interno.
// (Brevo acepta camelCase al CREAR el webhook pero envía snake_case en el evento.)
const MAPA_EVENTOS = {
  request:           { evento: 'solicitado',            estado: 'enviado',   rango: 20 },
  sent:              { evento: 'solicitado',            estado: 'enviado',   rango: 20 },
  delivered:         { evento: 'entregado',             estado: 'entregado', rango: 30 },
  deferred:          { evento: 'diferido',              estado: 'diferido',  rango: 25 },
  // un rebote blando no es definitivo: se guarda como diferido, nunca como terminal
  soft_bounce:       { evento: 'rebote_blando',         estado: 'diferido',  rango: 25 },
  hard_bounce:       { evento: 'rebote_duro',           estado: 'rebotado',  rango: 90, supresion: 'rebote_duro' },
  invalid_email:     { evento: 'email_invalido',        estado: 'rebotado',  rango: 90, supresion: 'rebote_duro' },
  blocked:           { evento: 'bloqueado',             estado: 'rebotado',  rango: 90 },
  error:             { evento: 'error',                 estado: 'fallido',   rango: 92 },
  spam:              { evento: 'spam',                  estado: 'spam',      rango: 91, supresion: 'spam' },
  // la baja no es un fallo de entrega: solo suprime, no toca el estado
  unsubscribed:      { evento: 'baja',                  supresion: 'baja' },
  opened:            { evento: 'apertura',              marca: 'opened_at' },
  unique_opened:     { evento: 'apertura_unica',        marca: 'opened_at' },
  // Aperturas vía proxy (el prefetch de Apple MPP y similares): automáticas por definición, así que
  // NO fijan opened_at (SPEC §11.1: esa marca refleja solo eventos reales — la ponen el pixel/clic
  // propios o el 'opened' genuino) y se guardan con automatico=true para el badge del panel.
  proxy_open:        { evento: 'apertura_proxy',        automatico: true },
  unique_proxy_open: { evento: 'apertura_proxy_unica',  automatico: true },
  click:             { evento: 'clic',                  marca: 'clicked_at' },
  list_addition:     { evento: 'alta_en_lista' },
  contact_updated:   { evento: 'contacto_actualizado' },
  contact_deleted:   { evento: 'contacto_borrado' },
}

// ---------------------------------------------------------------------------
// Token del webhook
// ---------------------------------------------------------------------------

// ENCRYPTION_KEY admite VARIAS claves separadas por comas para rotarla sin parar la app
// (lib/crypto.js). Por eso la firma se calcula con la clave ACTIVA pero se acepta la de cualquiera
// de las configuradas: si no, al desplegar "nueva,vieja" todos los webhooks ya dados de alta en
// Brevo empezarían a responder 404 y se perderían los eventos de entrega.
function clavesFirma() {
  const claves = clavesCifrado()
  if (!claves.length) throw new Error('Falta ENCRYPTION_KEY: no se pueden firmar los tokens de webhook')
  return claves
}

const hmac = (clave, etiqueta, valor) =>
  crypto.createHmac('sha256', clave).update(`${etiqueta}:${valor}`).digest('base64url').slice(0, 32)

const firmar = (etiqueta, valor) => hmac(clavesFirma()[0], etiqueta, valor)

const firmaValida = (etiqueta, valor, firma) =>
  clavesFirma().some((clave) => igualSeguro(firma, hmac(clave, etiqueta, valor)))

/** Token público del webhook de Brevo de un proveedor. Es determinista: no hace falta guardarlo. */
export function tokenWebhookBrevo(providerId) {
  const id = String(providerId)
  return `${id}.${firmar('webhook-brevo', id)}`
}

/** URL completa que se registra en Brevo (POST /v3/webhooks). */
export function urlWebhookBrevo(providerId) {
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')
  return `${base}/api/webhooks/brevo/${tokenWebhookBrevo(providerId)}`
}

function igualSeguro(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length === 0 || x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

// El token SOLO vale si lleva la firma HMAC de la app. No hay vía alternativa por
// providers.config: esa columna la escribe el usuario del panel, así que aceptar un
// `webhook_token` de ahí sería dejar que una subcuenta se fabrique su propia credencial.
async function proveedorPorToken(token) {
  const limpio = String(token || '').trim()
  if (!limpio || limpio.length > 200) return null

  const punto = limpio.lastIndexOf('.')
  if (punto <= 0) return null
  const id = limpio.slice(0, punto)
  if (!/^\d+$/.test(id) || !firmaValida('webhook-brevo', id, limpio.slice(punto + 1))) return null

  const { rows: [p] } = await q('SELECT id, type, location_id, owner_scope FROM providers WHERE id = $1', [Number(id)])
  return p ?? null
}

// ---------------------------------------------------------------------------
// Normalización del payload
// ---------------------------------------------------------------------------

// La doc de Brevo no publica el formato de los lotes: se aceptan las tres formas plausibles.
function listarEventos(cuerpo) {
  if (Array.isArray(cuerpo)) return cuerpo.filter((e) => e && typeof e === 'object')
  if (!cuerpo || typeof cuerpo !== 'object') return []
  for (const clave of ['items', 'events', 'data', 'batch', 'webhooks']) {
    if (Array.isArray(cuerpo[clave])) return cuerpo[clave].filter((e) => e && typeof e === 'object')
  }
  const claves = Object.keys(cuerpo)
  if (claves.length === 1 && Array.isArray(cuerpo[claves[0]])) {
    return cuerpo[claves[0]].filter((e) => e && typeof e === 'object')
  }
  return [cuerpo]
}

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

// El message-id llega unas veces con <> y otras sin ellos: se normaliza SIEMPRE.
const normalizarMessageId = (v) => texto(v).replace(/^<+/, '').replace(/>+$/, '').trim()

function correlacionDelEvento(ev) {
  const bruto = texto(ev['X-Mailin-custom'] ?? ev['X-Mailin-Custom'] ?? ev['x-mailin-custom'] ?? ev.mailin_custom)
  if (!bruto) return null
  if (bruto.startsWith('{')) {
    try {
      const obj = JSON.parse(bruto)
      for (const clave of ['correlation_id', 'correlationId', 'envio_id', 'cid']) {
        if (obj?.[clave]) return texto(obj[clave])
      }
    } catch {
      // no era JSON: se usa el valor tal cual
      return bruto
    }
    return null
  }
  return bruto
}

// Brevo manda `date` como "2024-02-01 13:45:22", en la hora de París (CET/CEST) y SIN indicar la
// zona. Interpretarlo con new Date() lo lee como hora LOCAL del proceso —UTC en el contenedor— y el
// occurred_at que se guarda y se pinta en el histórico queda desplazado 1 o 2 horas, desplazamiento
// que además entra en la clave de deduplicación (claveDedupe usa los segundos).
const RE_ZONA = /(Z|[+-]\d{2}:?\d{2})$/i
const RE_FECHA_BREVO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/

const FMT_PARIS = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris',
  hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** Desplazamiento de Europe/Paris (en ms) en un instante UTC dado, según la base de zonas de Node. */
function desfaseParis(ms) {
  try {
    const p = {}
    for (const parte of FMT_PARIS.formatToParts(new Date(ms))) p[parte.type] = parte.value
    // hour12:false devuelve "24" para la medianoche en algunas versiones de ICU
    const comoUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second)
    return comoUtc - ms
  } catch {
    return 0 // sin datos de zona horaria se deja como estaba: mejor UTC que una hora inventada
  }
}

/** Convierte la fecha de Brevo a un instante real, resolviendo CET/CEST cuando no trae zona. */
function fechaBrevo(valor) {
  const bruto = texto(valor)
  if (!bruto) return null
  if (RE_ZONA.test(bruto)) {
    const conZona = new Date(bruto.replace(' ', 'T'))
    return Number.isNaN(conZona.getTime()) ? null : conZona
  }
  const p = RE_FECHA_BREVO.exec(bruto)
  if (!p) return null
  const leidoComoUtc = Date.UTC(+p[1], +p[2] - 1, +p[3], +p[4], +p[5], +(p[6] ?? 0))
  // Se evalúa el desfase dos veces: la primera sobre la lectura en UTC y la segunda sobre el
  // instante ya corregido, para acertar también en las horas frontera del cambio de horario.
  const aproximado = leidoComoUtc - desfaseParis(leidoComoUtc)
  const real = leidoComoUtc - desfaseParis(aproximado)
  return new Date(real)
}

// ts / ts_event van en segundos, ts_epoch a veces en milisegundos.
function momentoDelEvento(ev) {
  const seg = Number(ev.ts_event ?? ev.ts)
  if (Number.isFinite(seg) && seg > 1e9 && seg < 1e11) return new Date(seg * 1000)
  const epoch = Number(ev.ts_epoch)
  if (Number.isFinite(epoch) && epoch > 1e9) return new Date(epoch > 1e12 ? epoch : epoch * 1000)
  const fecha = fechaBrevo(ev.date)
  if (fecha && !Number.isNaN(fecha.getTime())) return fecha
  return new Date()
}

function claveDedupe(ev, nombre, cuando) {
  const segundos = Math.floor(cuando.getTime() / 1000)
  const extra = texto(ev.link ?? ev.reason ?? '')
  if (!extra) return `${nombre}:${segundos}`
  const resumen = extra.length <= 80 ? extra : crypto.createHash('sha1').update(extra).digest('hex').slice(0, 16)
  return `${nombre}:${segundos}:${resumen}`
}

// El mensaje se busca SIEMPRE acotado al proveedor cuyo token se ha presentado. El correlation_id
// no es un secreto (viaja en la cabecera X-Mailin-custom del correo saliente y lo ve cualquier
// destinatario): sin este filtro, quien tuviera un token de webhook válido podría marcar como
// rebotado el mensaje de otra subcuenta y provocarle un alta en su lista de supresión.
// messages.provider_id guarda el proveedor concreto con el que se envió, así que el filtro vale
// igual para un proveedor de agencia cedido a varias subcuentas.
async function localizarMensaje(ev, proveedorId) {
  const campos = 'id, location_id, to_email, ghl_contact_id, status, status_rank, provider_message_id'
  const correlacion = correlacionDelEvento(ev)
  if (correlacion) {
    const { rows: [m] } = await q(
      `SELECT ${campos} FROM messages WHERE correlation_id = $1 AND provider_id = $2`,
      [correlacion, proveedorId]
    )
    if (m) return m
  }
  const messageId = normalizarMessageId(ev['message-id'] ?? ev.message_id ?? ev.messageId)
  if (messageId) {
    const { rows: [m] } = await q(
      `SELECT ${campos} FROM messages
        WHERE provider_id = $2 AND (provider_message_id = $1 OR provider_message_id = '<' || $1 || '>')
        ORDER BY id DESC LIMIT 1`, [messageId, proveedorId])
    if (m) return m
  }
  return null
}

// ---------------------------------------------------------------------------
// Aplicación de un evento
// ---------------------------------------------------------------------------

async function aplicarEvento(ev, req, proveedor) {
  const nombreBrevo = texto(ev.event).toLowerCase()
  if (!nombreBrevo) return 'ignorado'

  const mensaje = await localizarMensaje(ev, proveedor.id)
  if (!mensaje) return 'sin_correlacionar'

  // un evento desconocido se guarda igual: nunca se pierde información del proveedor
  const mapa = MAPA_EVENTOS[nombreBrevo] ?? { evento: nombreBrevo.replace(/[^a-z0-9_]/g, '_') }
  const cuando = momentoDelEvento(ev)
  const dedupe = claveDedupe(ev, mapa.evento, cuando)

  const { rows: [nuevo] } = await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data, automatico)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [mensaje.id, mapa.evento, cuando, dedupe, JSON.stringify({ proveedor: 'brevo', evento: nombreBrevo, ...ev }), Boolean(mapa.automatico)]
  )
  // repetido: el estado ya se aplicó la primera vez
  if (!nuevo) return 'duplicado'

  const messageId = normalizarMessageId(ev['message-id'] ?? ev.message_id ?? ev.messageId)
  const razon = texto(ev.reason).slice(0, 500)

  const sets = []
  const params = [mensaje.id]
  const añadir = (valor) => { params.push(valor); return `$${params.length}` }

  if (mapa.estado) {
    // status_rank es la única barrera contra los webhooks desordenados: nunca se retrocede.
    // Los terminales (>=90) ganan solos porque su rango supera al de cualquier estado intermedio.
    const pRango = añadir(mapa.rango)
    const pEstado = añadir(mapa.estado)
    sets.push(`status = CASE WHEN status_rank < ${pRango} THEN ${pEstado} ELSE status END`)
    sets.push(`status_rank = CASE WHEN status_rank < ${pRango} THEN ${pRango} ELSE status_rank END`)
    if (mapa.rango === 20) sets.push(`sent_at = COALESCE(sent_at, ${añadir(cuando)})`)
    if (razon && mapa.rango >= RANGO_TERMINAL) sets.push(`last_error = ${añadir(razon)}`)
  }
  // opened_at y clicked_at son marcas, no estados: se queda la primera vez que ocurrió
  if (mapa.marca) sets.push(`${mapa.marca} = COALESCE(${mapa.marca}, ${añadir(cuando)})`)
  if (messageId && !mensaje.provider_message_id) {
    sets.push(`provider_message_id = COALESCE(provider_message_id, ${añadir(messageId)})`)
  }

  if (sets.length) {
    await q(`UPDATE messages SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, params)
  }

  if (mapa.supresion) {
    // El alta va por lib/suppression.js y no por un INSERT directo: es lo que hace que un
    // rebote_duro dispare el auto-DND del contacto (SPEC §12.4). Las altas por spam/baja pasan por
    // el mismo sitio pero suppression.js no les activa el DND.
    const email = texto(ev.email) || mensaje.to_email
    if (email) {
      // el ghl_contact_id del mensaje es el del destinatario PRINCIPAL: si el evento habla de una
      // copia (CC/BCC), vincularle ese contacto marcaría el DND a la persona equivocada
      const esPrincipal = normalizarEmail(email) === normalizarEmail(mensaje.to_email)
      await suprimir(mensaje.location_id, email, mapa.supresion, `brevo:${nombreBrevo}`, {
        ghlContactId: esPrincipal ? mensaje.ghl_contact_id || null : null,
        messageId: mensaje.id,
      })
    }
  }

  req.log.debug({ mensaje: mensaje.id, evento: mapa.evento }, 'evento de Brevo aplicado')
  return 'aplicado'
}

// ---------------------------------------------------------------------------

export default async function webhooksRoutes(app) {
  app.post('/api/webhooks/brevo/:token', async (req, reply) => {
    let proveedor
    try {
      proveedor = await proveedorPorToken(req.params.token)
    } catch (err) {
      req.log.error({ err }, 'no se pudo resolver el token del webhook de Brevo')
      return reply.code(503).send({ error: 'Error temporal procesando el webhook' })
    }
    if (!proveedor) return reply.code(404).send({ error: 'Webhook desconocido' })

    const eventos = listarEventos(req.body)
    const resumen = { recibidos: eventos.length, aplicados: 0, duplicados: 0, sin_correlacionar: 0, ignorados: 0 }

    for (const ev of eventos) {
      try {
        const resultado = await aplicarEvento(ev, req, proveedor)
        if (resultado === 'aplicado') resumen.aplicados++
        else if (resultado === 'duplicado') resumen.duplicados++
        else if (resultado === 'sin_correlacionar') resumen.sin_correlacionar++
        else resumen.ignorados++
      } catch (err) {
        // un evento roto no puede tumbar el lote entero
        req.log.error({ err, evento: texto(ev?.event) }, 'fallo aplicando un evento de Brevo')
        resumen.ignorados++
      }
    }

    if (resumen.sin_correlacionar) {
      req.log.warn({ proveedor: proveedor.id, ...resumen }, 'eventos de Brevo sin mensaje correlacionado')
    }
    return reply.send({ ok: true, ...resumen })
  })
}
