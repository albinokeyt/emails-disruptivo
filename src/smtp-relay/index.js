import { readFileSync } from 'node:fs'
import { SMTPServer } from 'smtp-server'
import { capturaRebotesActiva, dominioRebotes } from '../lib/verp.js'
import { crearOnAuth } from './auth.js'
import { crearOnData, crearOnMailFrom, crearOnRcptTo } from './handler.js'
import { errorSmtp } from './routing.js'

// ---------------------------------------------------------------------------
// Pasarela de recepción SMTP (SPEC §6).
//
// Es el mismo servicio que ofrecen Mailgun, SendGrid o Postmark a sus clientes: un servidor de
// recepción AUTENTICADO. Cada subcuenta de la agencia tiene su usuario y su contraseña en
// relay_accounts, así que solo entra correo de clientes autenticados. No es un relay abierto.
//
// El usuario pega estos datos en GHL › Settings › Email Services › SMTP Service y a partir de ahí
// puede usar el nodo nativo de email de GHL: el correo llega aquí, se enruta por el `From`
// (routing.js) y se encola en la misma tabla `messages` que los nodos propios.
//
// Con SMTP_BOUNCE_DOMAIN definido, este MISMO servidor acepta además los avisos de rebote (DSN)
// que vuelven a las direcciones VERP de los envíos (SPEC §11.2). Es la única excepción a la
// autenticación obligatoria y está acotada en handler.js: sin credenciales, TODOS los RCPT tienen
// que ser b.<correlation_id>@<SMTP_BOUNCE_DOMAIN> de mensajes que existen; lo demás, 550.
//
// Solo se levanta si SMTP_RELAY_ENABLED=true. Está apagado por defecto porque publicar un puerto
// TCP y conseguirle un certificado TLS válido es la parte con fricción real del despliegue
// (EasyPanel/Traefik solo enruta HTTP).
// ---------------------------------------------------------------------------

const PUERTO_POR_DEFECTO = 2525
const MAX_SIZE_POR_DEFECTO = 26_214_400 // 25 MB, el estándar de facto de Gmail/Yahoo

// Techo de conexiones simultáneas del proceso entero.
const MAX_CLIENTES = 200
// Y techo por IP de origen: sin él, un solo cliente atascado agota las 200 y deja sin servicio a
// los demás. GHL sale por IPs compartidas, así que el límite es holgado a propósito.
const MAX_CONEXIONES_POR_IP = 20

const SOCKET_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 30_000

let servidor = null
let arrancando = null

// Conexiones vivas por IP. onClose se dispara siempre (también cuando onConnect rechaza), así que
// el contador no se descuadra.
const conexionesPorIp = new Map()

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

const ipDe = (session) => texto(session?.remoteAddress).replace(/^::ffff:/, '') || 'desconocida'

/** Acepta un logger (pino/fastify), un objeto con `.log`, o nada. */
function normalizarLog(entrada) {
  if (entrada && typeof entrada.info === 'function' && typeof entrada.error === 'function') return entrada
  const anidado = entrada?.log
  if (anidado && typeof anidado.info === 'function') return anidado
  return {
    info: (...a) => console.log('[relay]', ...a),
    warn: (...a) => console.warn('[relay]', ...a),
    error: (...a) => console.error('[relay]', ...a),
    debug: () => {},
  }
}

/** ¿Está activada la pasarela? Mismo criterio que el panel (src/routes/location.js). */
export const relayHabilitado = () =>
  String(process.env.SMTP_RELAY_ENABLED || '').toLowerCase() === 'true'

export const puertoRelay = () => Number(process.env.SMTP_RELAY_PORT) || PUERTO_POR_DEFECTO

export const tamanoMaximo = () => Number(process.env.SMTP_RELAY_MAX_SIZE) || MAX_SIZE_POR_DEFECTO

/** Host público que se le enseña al usuario para pegar en GHL; también va en el banner y en Received. */
export function hostRelay() {
  const explicito = texto(process.env.SMTP_RELAY_HOST)
  if (explicito) return explicito
  try {
    return new URL(String(process.env.APP_BASE_URL || '')).hostname
  } catch {
    return ''
  }
}

/**
 * Certificado del servidor. Sin él, smtp-server usa su certificado autofirmado de ejemplo: el
 * STARTTLS se anuncia igual, pero cualquier cliente que valide el certificado (GHL entre ellos)
 * cortará la conexión. Por eso, si falta, se avisa bien alto en el arranque.
 */
function cargarTLS(log) {
  const rutaCert = texto(process.env.SMTP_RELAY_TLS_CERT)
  const rutaKey = texto(process.env.SMTP_RELAY_TLS_KEY)
  if (!rutaCert && !rutaKey) {
    log.warn(
      'relay: sin SMTP_RELAY_TLS_CERT/SMTP_RELAY_TLS_KEY. Se usara el certificado autofirmado de smtp-server ' +
        'y los clientes que validen el certificado rechazaran STARTTLS: solo sirve para pruebas en local.'
    )
    return {}
  }
  if (!rutaCert || !rutaKey) {
    log.error('relay: SMTP_RELAY_TLS_CERT y SMTP_RELAY_TLS_KEY van juntas; falta una y se ignoran las dos')
    return {}
  }
  try {
    return { cert: readFileSync(rutaCert), key: readFileSync(rutaKey) }
  } catch (err) {
    log.error({ err }, 'relay: no se ha podido leer el certificado TLS; se arranca sin el')
    return {}
  }
}

/** Límite de conexiones simultáneas por IP de origen. */
function crearOnConnect(log) {
  return function onConnect(session, callback) {
    const ip = ipDe(session)
    const vivas = (conexionesPorIp.get(ip) || 0) + 1
    conexionesPorIp.set(ip, vivas)
    if (vivas > MAX_CONEXIONES_POR_IP) {
      log.warn({ ip, vivas }, 'relay: demasiadas conexiones simultaneas desde una misma IP')
      // 421 = el servidor cierra; es el código que los clientes SMTP entienden como "vuelve luego".
      return callback(errorSmtp(421, 'Demasiadas conexiones simultaneas, reintentalo en un momento'))
    }
    return callback()
  }
}

function onClose(session) {
  const ip = ipDe(session)
  const vivas = (conexionesPorIp.get(ip) || 0) - 1
  if (vivas > 0) conexionesPorIp.set(ip, vivas)
  else conexionesPorIp.delete(ip)
}

/**
 * Levanta la pasarela. NUNCA lanza ni rechaza: si no puede arrancar lo deja escrito en el log y
 * devuelve null, porque un puerto SMTP ocupado no puede tumbar el panel ni los nodos de GHL.
 *
 * @param {object} [entrada] logger (o cualquier objeto con `.log`)
 * @returns {Promise<import('smtp-server').SMTPServer|null>}
 */
export function arrancarRelay(entrada) {
  const log = normalizarLog(entrada)

  if (!relayHabilitado()) {
    log.info('relay: desactivado (SMTP_RELAY_ENABLED no es "true")')
    return Promise.resolve(null)
  }
  if (servidor) return Promise.resolve(servidor)
  if (arrancando) return arrancando

  const puerto = puertoRelay()
  const maxSize = tamanoMaximo()
  const host = hostRelay()

  const instancia = new SMTPServer({
    name: host || 'emails-disruptivo',
    banner: 'Relay de la app de email',
    // El 465 es TLS implícito; en 587/2525 se empieza en claro y se sube con STARTTLS.
    secure: puerto === 465,
    ...cargarTLS(log),

    // Lo que usa GHL, y nada más.
    authMethods: ['PLAIN', 'LOGIN'],
    // authOptional SOLO se enciende cuando la captura de rebotes está activa (SMTP_BOUNCE_DOMAIN),
    // porque los DSN llegan de MTAs ajenos que ni tienen ni pueden tener credenciales nuestras.
    // No convierte el servidor en un buzón abierto: la sesión sin autenticar pasa por
    // crearOnMailFrom/crearOnRcptTo (handler.js), donde TODOS los RCPT tienen que casar con el
    // patrón VERP b.<correlation_id>@<dominio de rebotes> y el correlation_id tiene que existir en
    // `messages`; cualquier otro destino sin credenciales se corta con 550. Sin ese doble candado,
    // aceptar correo anónimo aquí sería regalar un buzón (spam entrante ilimitado), un blanco de
    // backscatter y una vía para fabricar rebotes falsos. Con la variable sin definir, la
    // autenticación es obligatoria exactamente igual que siempre.
    authOptional: capturaRebotesActiva(),
    allowInsecureAuth: false, // jamás AUTH en claro: el AUTH ni se anuncia antes de STARTTLS
    hideSTARTTLS: false,

    size: maxSize, // se anuncia en el EHLO y se corta el DATA en cuanto se pasa
    hideSize: false,
    maxClients: MAX_CLIENTES,
    socketTimeout: SOCKET_TIMEOUT_MS,
    closeTimeout: CLOSE_TIMEOUT_MS,
    // No se usa el nombre inverso del cliente para nada y resolverlo añade latencia a cada conexión.
    disableReverseLookup: true,
    // Log propio: el de smtp-server vuelca los comandos de la sesión, incluida la línea del AUTH.
    logger: false,

    onConnect: crearOnConnect(log),
    onClose,
    onAuth: crearOnAuth(log),
    onMailFrom: crearOnMailFrom(),
    onRcptTo: crearOnRcptTo(log),
    onData: crearOnData({ maxSize, log }),
  })

  // Errores del servidor ya en marcha (sockets rotos, EMFILE…): se anotan y se sigue sirviendo.
  instancia.on('error', (err) => log.error({ err }, 'relay: error del servidor SMTP'))

  arrancando = new Promise((resolve) => {
    const alFallarArranque = (err) => {
      log.error({ err, puerto }, 'relay: no se ha podido abrir el puerto SMTP')
      arrancando = null
      resolve(null)
    }
    instancia.once('error', alFallarArranque)

    // 0.0.0.0: dentro del contenedor hay que escuchar en todas las interfaces para que EasyPanel
    // pueda publicar el puerto como TCP. SMTP_RELAY_HOST es el nombre público, no la escucha.
    instancia.listen(puerto, '0.0.0.0', () => {
      instancia.removeListener('error', alFallarArranque)
      servidor = instancia
      arrancando = null
      log.info(
        {
          puerto,
          host: host || null,
          maxSize,
          tls: Boolean(process.env.SMTP_RELAY_TLS_CERT),
          rebotes: dominioRebotes() || null,
        },
        'relay: escuchando'
      )
      resolve(instancia)
    })
  })

  return arrancando
}

/**
 * Cierra la pasarela para el apagado ordenado de la app: deja de aceptar conexiones y espera a que
 * terminen las que están a medio mensaje (smtp-server las corta pasado closeTimeout).
 */
export function pararRelay(entrada) {
  const log = normalizarLog(entrada)
  const instancia = servidor
  servidor = null
  arrancando = null
  conexionesPorIp.clear()
  if (!instancia) return Promise.resolve()

  return new Promise((resolve) => {
    // Red de seguridad: si algún socket se resiste, no se bloquea el apagado de todo el proceso.
    const guardia = setTimeout(() => {
      log.warn('relay: cierre forzado tras agotar la espera')
      resolve()
    }, CLOSE_TIMEOUT_MS + 5_000)
    guardia.unref?.()

    instancia.close(() => {
      clearTimeout(guardia)
      log.info('relay: detenido')
      resolve()
    })
  })
}

/** Estado para diagnósticos y para el endpoint de salud. */
export const estadoRelay = () => ({
  habilitado: relayHabilitado(),
  escuchando: Boolean(servidor),
  puerto: puertoRelay(),
  host: hostRelay(),
  max_size: tamanoMaximo(),
  tls_propio: Boolean(texto(process.env.SMTP_RELAY_TLS_CERT) && texto(process.env.SMTP_RELAY_TLS_KEY)),
  captura_rebotes: capturaRebotesActiva(),
  dominio_rebotes: dominioRebotes() || null,
  conexiones: servidor?.connections?.size ?? 0,
})

// Alias en las dos formas que suele usar el resto del proyecto, para que src/index.js pueda
// importarlo como prefiera sin tener que adivinar el nombre.
export const iniciarRelay = arrancarRelay
export const detenerRelay = pararRelay

export default { arrancarRelay, pararRelay, iniciarRelay, detenerRelay, estadoRelay, relayHabilitado }
