import crypto from 'node:crypto'
import { q } from '../db.js'
import { clavesCifrado } from './crypto.js'
import { suprimir } from './suppression.js'

// ---------------------------------------------------------------------------
// Tokens firmados del seguimiento propio.
//
// Los genera el motor de envío (src/lib/render.js) y los verifica el redirector
// (src/routes/tracking.js). El esquema de firma es EXACTAMENTE el mismo en los dos sitios:
// HMAC-SHA256 sobre "<etiqueta>:<valor>", en base64url y recortado a 32 caracteres.
//
// Sin firma cualquiera podría fabricar aperturas y clics falsos, y el redirector se convertiría
// en un open redirect: por eso el destino real jamás viaja en la URL, solo un token opaco que se
// resuelve contra message_links.
// ---------------------------------------------------------------------------

const LARGO_FIRMA = 32
const MAX_TOKEN = 200

// ENCRYPTION_KEY admite VARIAS claves separadas por comas para poder rotarla sin parar la app
// (lib/crypto.js). Se firma con la ACTIVA y se acepta cualquiera de las configuradas: al desplegar
// "nueva,vieja" los pixels y enlaces del correo ya enviado siguen funcionando.
function clavesFirma() {
  const claves = clavesCifrado()
  if (!claves.length) throw new Error('Falta ENCRYPTION_KEY: no se pueden firmar los tokens de seguimiento')
  return claves
}

const hmac = (clave, etiqueta, valor) =>
  crypto.createHmac('sha256', clave).update(`${etiqueta}:${valor}`).digest('base64url').slice(0, LARGO_FIRMA)

const firmar = (etiqueta, valor) => hmac(clavesFirma()[0], etiqueta, valor)

function igualSeguro(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length === 0 || x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

const firmaValida = (etiqueta, valor, firma) =>
  clavesFirma().some((clave) => igualSeguro(firma, hmac(clave, etiqueta, valor)))

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

/** Separa "<valor>.<firma>" sin asumir que el valor no lleva puntos. */
function partirToken(token) {
  const limpio = texto(token)
  if (!limpio || limpio.length > MAX_TOKEN) return null
  const punto = limpio.lastIndexOf('.')
  if (punto <= 0 || punto === limpio.length - 1) return null
  return { valor: limpio.slice(0, punto), firma: limpio.slice(punto + 1) }
}

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------

/** Token del pixel de apertura de un mensaje. */
export function firmarTokenApertura(messageId) {
  const id = String(messageId)
  return `${id}.${firmar('apertura', id)}`
}

/** Token nuevo para un enlace reescrito. Se guarda tal cual en message_links.token. */
export function nuevoTokenEnlace() {
  const base = crypto.randomBytes(12).toString('base64url')
  return `${base}.${firmar('clic', base)}`
}

/** Token de baja en un clic (RFC 8058) de un mensaje concreto. */
export function firmarTokenBaja(messageId) {
  const id = String(messageId)
  return `${id}.${firmar('baja', id)}`
}

// ---------------------------------------------------------------------------
// Verificación
// ---------------------------------------------------------------------------

/** Devuelve el id de mensaje si el token del pixel es legítimo; null si no. */
export function verificarTokenApertura(token) {
  const partes = partirToken(String(token ?? '').replace(/\.gif$/i, ''))
  if (!partes || !/^\d+$/.test(partes.valor)) return null
  return firmaValida('apertura', partes.valor, partes.firma) ? partes.valor : null
}

/** Devuelve la parte aleatoria del token de enlace si la firma es legítima; null si no. */
export function verificarTokenEnlace(token) {
  const partes = partirToken(token)
  if (!partes) return null
  return firmaValida('clic', partes.valor, partes.firma) ? partes.valor : null
}

/** Devuelve el id de mensaje si el token de baja es legítimo; null si no. */
export function verificarTokenBaja(token) {
  const partes = partirToken(token)
  if (!partes || !/^\d+$/.test(partes.valor)) return null
  return firmaValida('baja', partes.valor, partes.firma) ? partes.valor : null
}

// ---------------------------------------------------------------------------
// URLs públicas
// ---------------------------------------------------------------------------

/** Base pública de la app, sin barra final. Cadena vacía si no está configurada. */
export const baseApp = () => String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '')

/** ¿Se pueden construir URLs públicas? Sin APP_BASE_URL no hay seguimiento posible. */
export const haySeguimiento = () => baseApp().length > 0 && clavesCifrado().length > 0

// Con dominio de tracking propio (SPEC §11.3) las URLs salen por https://<dominio-del-cliente>,
// que llega a la app por el CNAME que publicó el cliente. Sin dominio, APP_BASE_URL como siempre.
// Las rutas /t/* responden igual llegue el host que llegue, así que aquí solo cambia la base.
const baseSeguimiento = (dominio) => {
  const d = texto(dominio).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.+$/, '')
  return d ? `https://${d}` : baseApp()
}

/** URL del pixel de apertura, para incrustar al principio del HTML. `dominio` es opcional. */
export const urlPixel = (messageId, dominio) => `${baseSeguimiento(dominio)}/t/a/${firmarTokenApertura(messageId)}.gif`

/** URL del redirector de un enlace ya registrado en message_links. `dominio` es opcional. */
export const urlClic = (token, dominio) => `${baseSeguimiento(dominio)}/t/c/${token}`

/** URL de baja en un clic; la sirve `rutasBaja` (más abajo). `dominio` es opcional. */
export const urlBaja = (messageId, dominio) => `${baseSeguimiento(dominio)}/t/baja/${firmarTokenBaja(messageId)}`

// ---------------------------------------------------------------------------
// Dominio de tracking por subcuenta (SPEC §11.3)
//
// El worker resuelve aquí el dominio verificado de la subcuenta y se lo pasa a componerMensaje en
// opciones.dominioTracking. La caché evita un SELECT por cada mensaje compuesto; el TTL es corto y
// el panel invalida al verificar o eliminar (olvidarDominioTracking), así que el desfase real es
// de un minuto como mucho en el peor de los casos (otro proceso distinto al del panel).
// ---------------------------------------------------------------------------

const CACHE_DOMINIO_MS = 60_000
const MAX_CACHE_DOMINIOS = 5000
const cacheDominios = new Map() // locationId → { dominio: string|null, hasta: epoch ms }

/** Dominio de tracking VERIFICADO de una subcuenta, o null (⇒ las URLs salen por APP_BASE_URL). */
export async function dominioTrackingDe(locationId) {
  const id = texto(locationId)
  if (!id) return null
  const guardado = cacheDominios.get(id)
  if (guardado && guardado.hasta > Date.now()) return guardado.dominio

  let dominio = null
  try {
    const { rows: [fila] } = await q(
      'SELECT domain FROM tracking_domains WHERE location_id = $1 AND verified',
      [id]
    )
    dominio = texto(fila?.domain).toLowerCase() || null
  } catch {
    // si la consulta falla no se cachea nada: el mensaje sale por APP_BASE_URL y no se pierde
    return guardado ? guardado.dominio : null
  }
  if (cacheDominios.size >= MAX_CACHE_DOMINIOS && !cacheDominios.has(id)) {
    cacheDominios.delete(cacheDominios.keys().next().value)
  }
  cacheDominios.set(id, { dominio, hasta: Date.now() + CACHE_DOMINIO_MS })
  return dominio
}

/** Invalida la caché de una subcuenta; lo llama el panel al verificar o eliminar su dominio. */
export function olvidarDominioTracking(locationId) {
  cacheDominios.delete(texto(locationId))
}

// ---------------------------------------------------------------------------
// Endpoint de baja (List-Unsubscribe / List-Unsubscribe-Post, RFC 8058)
//
// Gmail y Yahoo exigen que la URL de List-Unsubscribe acepte un POST directo, sin landing ni
// confirmación, y que la baja se procese en menos de 48 h. El token es opaco y firmado porque
// cualquiera que lo tenga puede dar de baja: no puede ser adivinable ni contener el correo.
// ---------------------------------------------------------------------------

const CABECERAS_SIN_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Robots-Tag': 'noindex, nofollow',
}

const paginaBaja = (titulo, detalle) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${titulo}</title></head>` +
  `<body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;margin:0;padding:48px 16px">` +
  `<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 1px 3px rgba(0,0,0,.08)">` +
  `<h1 style="font-size:20px;margin:0 0 12px">${titulo}</h1>` +
  `<p style="font-size:15px;line-height:1.5;color:#444;margin:0">${detalle}</p>` +
  `</div></body></html>`

/** Da de baja al destinatario del mensaje. Idempotente: se puede llamar mil veces. */
async function procesarBaja(messageId, fuente) {
  const { rows: [mensaje] } = await q(
    'SELECT id, location_id, to_email FROM messages WHERE id = $1',
    [Number(messageId)]
  )
  if (!mensaje) return null

  await suprimir(mensaje.location_id, mensaje.to_email, 'baja', fuente)
  await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
     VALUES ($1,'baja',now(),$2,$3)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
    [mensaje.id, `baja:${fuente}`, JSON.stringify({ fuente })]
  )
  return mensaje
}

/**
 * Rutas de la baja en un clic. Se monta como plugin de Fastify:
 *   app.register(rutasBaja)
 * Sin ella las cabeceras List-Unsubscribe de los correos apuntarían a un 404.
 */
export async function rutasBaja(app) {
  // El POST es el que hacen Gmail/Yahoo/Outlook: sin navegador, sin confirmación y en segundo plano.
  app.post('/t/baja/:token', async (req, reply) => {
    reply.headers(CABECERAS_SIN_CACHE)
    const id = verificarTokenBaja(req.params.token)
    // Un token inválido responde igual que uno válido: no se filtra qué mensajes existen.
    if (!id) return reply.send({ ok: true })
    try {
      await procesarBaja(id, 'un-clic')
    } catch (err) {
      req.log.error({ err }, 'no se pudo procesar una baja en un clic')
      return reply.code(503).send({ error: 'No se pudo procesar la baja, vuelve a intentarlo' })
    }
    return reply.send({ ok: true })
  })

  // El GET lo usan los clientes que enseñan el enlace de baja en la cabecera del mensaje.
  app.get('/t/baja/:token', async (req, reply) => {
    reply.headers({ ...CABECERAS_SIN_CACHE, 'Content-Type': 'text/html; charset=utf-8' })
    const id = verificarTokenBaja(req.params.token)
    if (!id) {
      return reply
        .code(404)
        .send(paginaBaja('Enlace no válido', 'Este enlace de baja ha caducado o no es correcto.'))
    }
    let mensaje
    try {
      mensaje = await procesarBaja(id, 'enlace')
    } catch (err) {
      req.log.error({ err }, 'no se pudo procesar una baja desde el enlace')
      return reply
        .code(503)
        .send(paginaBaja('Ahora mismo no podemos procesarlo', 'Vuelve a intentarlo dentro de unos minutos.'))
    }
    if (!mensaje) {
      return reply
        .code(404)
        .send(paginaBaja('Enlace no válido', 'Este enlace de baja ha caducado o no es correcto.'))
    }
    return reply.send(
      paginaBaja('Baja confirmada', 'No volverás a recibir correos de este remitente en esta dirección.')
    )
  })
}
