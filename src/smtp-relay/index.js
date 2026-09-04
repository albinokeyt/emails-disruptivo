import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createSecureContext } from 'node:tls'
import { SMTPServer } from 'smtp-server'
import { config } from '../config.js'
import { capturaRebotesActiva, dominioRebotes } from '../lib/verp.js'
import { crearOnAuth } from './auth.js'
import { crearOnData, crearOnMailFrom, crearOnRcptTo } from './handler.js'
import { errorSmtp } from './routing.js'

// ---------------------------------------------------------------------------
// Pasarela de recepción SMTP (SPEC §6 y §13).
//
// Es el mismo servicio que ofrecen Mailgun, SendGrid o Postmark a sus clientes: un servidor de
// recepción AUTENTICADO. Cada subcuenta de la agencia tiene su usuario y su contraseña en
// relay_accounts, así que solo entra correo de clientes autenticados. No es un relay abierto.
//
// El usuario pega estos datos en GHL › Settings › Email Services › SMTP Service y a partir de ahí
// puede usar el nodo nativo de email de GHL: el correo llega aquí, se enruta por el `From`
// (routing.js) y se encola en la misma tabla `messages` que los nodos propios.
//
// Dos escuchas, un solo servicio (SPEC §13.2). GHL documenta 587 (STARTTLS) y 465 (SSL), así que
// se ofrecen los dos: una escucha en claro que sube con STARTTLS (SMTP_RELAY_PORT, 2525) y otra
// con TLS implícito (SMTP_RELAY_PORT_SSL, 2465). Son puertos altos a propósito: el contenedor no
// necesita privilegios para abrirlos y EasyPanel los publica como 587 → 2525 y 465 → 2465. Las dos
// comparten autenticación, handlers, límites y certificado; al cliente se le enseñan siempre los
// puertos PÚBLICOS (SMTP_RELAY_PUBLIC_PORT/_SSL).
//
// Certificado (SPEC §13.1). Precedencia: ficheros SMTP_RELAY_TLS_CERT/_KEY > Traefik (el acme.json
// que Traefik ya renueva, SMTP_RELAY_TRAEFIK_ACME) > ACME propio por HTTP-01 (SMTP_RELAY_TLS_AUTO,
// por defecto true) > autofirmado de smtp-server. El arranque NUNCA espera al certificado: las
// escuchas se abren al instante con lo que haya. La obtención del certificado la orquesta
// src/index.js (§7b) con src/lib/traefik.js o src/lib/acme.js, en segundo plano, y cuando llega lo
// entrega a actualizarCertificado({ key, cert, origen }), que lo aplica en caliente con
// updateSecureContext en todas las escuchas sin cortar ni una conexión. Este módulo no habla con
// la CA ni lee el acme.json: así solo hay un dueño del ciclo de emisión y renovación.
//
// Con SMTP_BOUNCE_DOMAIN definido, este MISMO servidor acepta además los avisos de rebote (DSN)
// que vuelven a las direcciones VERP de los envíos (SPEC §11.2). Es la única excepción a la
// autenticación obligatoria y está acotada en handler.js: sin credenciales, TODOS los RCPT tienen
// que ser b.<correlation_id>@<SMTP_BOUNCE_DOMAIN> de mensajes que existen; lo demás, 550.
//
// Solo se levanta si SMTP_RELAY_ENABLED es verdadero. Toda la configuración sale de src/config.js
// (config.relay): un único sitio decide qué significa cada variable, y el panel (routes/location.js)
// y esta pasarela no pueden volver a discrepar sobre puertos o valores booleanos.
// ---------------------------------------------------------------------------

// Techo de conexiones simultáneas por escucha.
const MAX_CLIENTES = 200
// Y techo por IP de origen, compartido por las dos escuchas: sin él, un solo cliente atascado
// agota las 200 y deja sin servicio a los demás. GHL sale por IPs compartidas, así que el límite
// es holgado a propósito.
const MAX_CONEXIONES_POR_IP = 20

const SOCKET_TIMEOUT_MS = 60_000
const CLOSE_TIMEOUT_MS = 30_000

// Modos con un certificado real en servicio: un rechazo posterior no puede pisar su estado.
const MODOS_REALES = new Set(['acme', 'traefik', 'ficheros'])

/**
 * Escuchas vivas: { etiqueta: 'starttls'|'ssl', puerto, secure, servidor, escuchando }.
 * Se registran ANTES de abrir el puerto para que un certificado que llegue durante el arranque
 * se aplique también a ellas.
 */
const escuchas = []
let arrancando = null
// Cada arranque tiene su generación: si la pasarela se para mientras se abre un puerto o se emite
// el certificado, las continuaciones de la generación anterior se descartan.
let generacion = 0

// Estado del certificado que sirven las escuchas ahora mismo (SPEC §13.2 → estadoRelay().tls).
// `error` describe el certificado EN SERVICIO (ficheros ilegibles o caducados, TLS_AUTO apagado,
// un certificado rechazado cuando aún no había ninguno real); `ultimo_rechazo` guarda aparte el
// último certificado que no se pudo aplicar, para que un rechazo con un certificado bueno ya en
// servicio no lo pinte como roto. Los fallos de la emisión ACME viven en tls_certificates.last_error
// (src/lib/acme.js) y los del modo traefik en estadoTraefik() (src/lib/traefik.js).
const tlsEstado = { modo: 'autofirmado', valido_hasta: null, error: null, ultimo_rechazo: null }

// Conexiones vivas por IP. onClose se dispara siempre (también cuando onConnect rechaza), así que
// el contador no se descuadra.
const conexionesPorIp = new Map()

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

const ipDe = (session) => texto(session?.remoteAddress).replace(/^::ffff:/, '') || 'desconocida'

// Solo el mensaje: los errores de ACME o de OpenSSL pueden arrastrar cuerpos de respuesta o
// material que no debe acabar en los logs.
const mensajeDe = (err) => texto(err?.message) || 'error desconocido'

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

// Lectores de configuración. Todos delegan en config.relay (src/config.js), que ya aplica los
// valores por defecto y la semántica de cada variable (SMTP_RELAY_ENABLED admite 1/true/si/yes/on;
// SMTP_RELAY_PORT_SSL sin definir = 2465, vacía o 0/false/no/off = escucha SSL apagada).

/** ¿Está activada la pasarela? Mismo criterio que src/config.js y que el panel. */
export const relayHabilitado = () => config.relay.habilitado

/** Puerto interno de la escucha STARTTLS (en claro + STARTTLS). */
export const puertoRelay = () => config.relay.puerto

/** Puerto interno de la escucha con TLS implícito (SPEC §13.2); null = no se levanta. */
export const puertoRelaySsl = () => config.relay.puertoSsl

/** Puerto PÚBLICO de la escucha STARTTLS: el que EasyPanel publica y el que se enseña al cliente. */
export const puertoPublico = () => config.relay.puertoPublico

/** Puerto PÚBLICO de la escucha SSL; null si la escucha SSL no está configurada. */
export const puertoPublicoSsl = () => config.relay.puertoPublicoSsl

/** ¿Se emite el certificado por ACME propio? Por defecto sí (SPEC §13.1); no cuenta en modo traefik. */
export const tlsAutoActivo = () => config.relay.tlsAuto

/** ¿Se lee el certificado del acme.json de Traefik (SPEC §13.1)? */
export const modoTraefikActivo = () => Boolean(config.relay.traefikAcme)

export const tamanoMaximo = () => config.relay.tamMaximo

/**
 * Host público que se le enseña al usuario para pegar en GHL; también va en el banner, en Received
 * y es el nombre del certificado. En minúsculas y sin punto final, que es como lo quiere ACME.
 */
export const hostRelay = () => config.relay.host

// ---------------------------------------------------------------------------
// Certificado
// ---------------------------------------------------------------------------

/**
 * Comprueba clave y certificado ANTES de tocar ninguna escucha (createSecureContext lanza si el
 * PEM está roto o la clave no casa) y devuelve la fecha de caducidad del certificado de hoja.
 * Con un fullchain, X509Certificate lee el primer certificado, que es el del host.
 */
function validarMaterial(key, cert) {
  createSecureContext({ key, cert })
  const x509 = new X509Certificate(cert)
  const hasta = x509.validToDate instanceof Date ? x509.validToDate : new Date(x509.validTo)
  return Number.isNaN(hasta.getTime()) ? null : hasta
}

/**
 * Certificado inicial según la precedencia del SPEC §13.1. Solo cubre los ficheros: el ACME llega
 * después, en caliente, y si no hay nada smtp-server usa su certificado autofirmado de ejemplo
 * (cualquier cliente que valide el certificado, GHL entre ellos, cortará la conexión).
 *
 * Deja tlsEstado consistente y devuelve las opciones TLS con las que construir las escuchas.
 */
function cargarTLS(log) {
  tlsEstado.modo = 'autofirmado'
  tlsEstado.valido_hasta = null
  tlsEstado.error = null
  tlsEstado.ultimo_rechazo = null

  const rutaCert = texto(config.relay.tlsCert)
  const rutaKey = texto(config.relay.tlsKey)

  if (rutaCert || rutaKey) {
    if (!rutaCert || !rutaKey) {
      log.error('relay: SMTP_RELAY_TLS_CERT y SMTP_RELAY_TLS_KEY van juntas; falta una y se ignoran las dos')
    } else {
      try {
        const cert = readFileSync(rutaCert)
        const key = readFileSync(rutaKey)
        const hasta = validarMaterial(key, cert)
        tlsEstado.modo = 'ficheros'
        tlsEstado.valido_hasta = hasta ? hasta.toISOString() : null
        if (hasta && hasta.getTime() <= Date.now()) {
          tlsEstado.error = `El certificado de SMTP_RELAY_TLS_CERT caducó el ${hasta.toISOString()}: renuévalo`
          log.error({ valido_hasta: tlsEstado.valido_hasta }, 'relay: el certificado TLS de ficheros está caducado')
        }
        return { key, cert }
      } catch (err) {
        // se sigue por la precedencia (ACME o autofirmado) en vez de arrancar sin nada
        log.error({ motivo: mensajeDe(err) }, 'relay: no se ha podido cargar el certificado TLS de ficheros')
      }
    }
  }

  if (modoTraefikActivo()) {
    log.info(
      { ruta: config.relay.traefikAcme },
      'relay: sin certificado de ficheros; se arranca con el autofirmado hasta leer el de Traefik (lo hace src/index.js en segundo plano)'
    )
  } else if (tlsAutoActivo()) {
    log.info('relay: sin certificado de ficheros; se arranca con el autofirmado hasta que llegue el de ACME (lo pide src/index.js en segundo plano)')
  } else {
    tlsEstado.error =
      'Sin certificado: SMTP_RELAY_TLS_AUTO está desactivado y no hay SMTP_RELAY_TLS_CERT/_KEY ni SMTP_RELAY_TRAEFIK_ACME'
    log.warn(
      'relay: sin SMTP_RELAY_TLS_CERT/_KEY, sin SMTP_RELAY_TRAEFIK_ACME y con SMTP_RELAY_TLS_AUTO desactivado. Se usara el ' +
        'certificado autofirmado de smtp-server y los clientes que validen el certificado rechazaran la conexion.'
    )
  }
  return {}
}

/**
 * Aplica un certificado en caliente a TODAS las escuchas vivas (SPEC §13.1). Lo llaman la emisión
 * ACME en segundo plano, la renovación periódica, la lectura del acme.json de Traefik y el botón
 * «Emitir / renovar ahora» del admin.
 *
 * No corta conexiones: smtp-server reconstruye el contexto TLS y lo usan las sesiones que empiecen
 * (o hagan STARTTLS) a partir de ese momento. Los ficheros SMTP_RELAY_TLS_CERT/_KEY tienen
 * prioridad y no se sobrescriben. Nunca lanza.
 *
 * Un certificado rechazado NO toca el estado del que ya está en servicio: si hay uno real (ACME o
 * Traefik) sirviendo, tls.error sigue en null y el rechazo queda en tls.ultimo_rechazo. Solo cuando
 * la pasarela sigue con el autofirmado el rechazo pasa a ser el error visible.
 *
 * @param {{ key: string|Buffer, cert: string|Buffer, expiresAt?: Date|string, origen?: 'acme'|'traefik' }} certificado
 *   `origen` decide el modo que enseña el panel; por defecto 'acme'.
 * @returns {{ aplicado: boolean, error: string|null, tls: object }}
 */
export function actualizarCertificado(certificado, entrada) {
  const log = normalizarLog(entrada)
  const key = certificado?.key
  const cert = certificado?.cert
  const origen = certificado?.origen === 'traefik' ? 'traefik' : 'acme'
  const etiqueta = origen === 'traefik' ? 'de Traefik' : 'ACME'
  const resultado = (aplicado, error = null) => ({ aplicado, error, tls: estadoTls() })
  const rechazar = (error, datos, mensaje) => {
    tlsEstado.ultimo_rechazo = error
    if (!MODOS_REALES.has(tlsEstado.modo)) tlsEstado.error = error
    log.error(datos, mensaje)
    return resultado(false, error)
  }

  if (!key || !cert) return resultado(false, 'Faltan la clave o el certificado')
  if (tlsEstado.modo === 'ficheros') {
    return resultado(false, 'El relay usa el certificado de SMTP_RELAY_TLS_CERT/_KEY, que tiene prioridad sobre el automático')
  }

  let hasta
  try {
    hasta = validarMaterial(key, cert)
  } catch (err) {
    return rechazar(
      `El certificado recibido no es válido: ${mensajeDe(err)}`,
      { origen, motivo: mensajeDe(err) },
      `relay: certificado ${etiqueta} rechazado`
    )
  }
  if (!hasta && certificado.expiresAt) {
    const alt = new Date(certificado.expiresAt)
    if (!Number.isNaN(alt.getTime())) hasta = alt
  }
  if (hasta && hasta.getTime() <= Date.now()) {
    return rechazar(
      `El certificado recibido ya ha caducado (${hasta.toISOString()})`,
      { origen, valido_hasta: hasta.toISOString() },
      `relay: certificado ${etiqueta} caducado, no se aplica`
    )
  }
  if (!escuchas.length) {
    return resultado(false, 'El relay no está en marcha en esta instancia: el certificado se aplicará en el próximo arranque')
  }

  let aplicadas = 0
  for (const escucha of escuchas) {
    try {
      escucha.servidor.updateSecureContext({ key, cert })
      aplicadas++
    } catch (err) {
      log.error({ escucha: escucha.etiqueta, origen, motivo: mensajeDe(err) }, 'relay: no se pudo aplicar el certificado a una escucha')
    }
  }
  if (!aplicadas) {
    return rechazar('No se pudo aplicar el certificado a ninguna escucha', { origen }, `relay: certificado ${etiqueta} sin aplicar`)
  }

  tlsEstado.modo = origen
  tlsEstado.valido_hasta = hasta ? hasta.toISOString() : null
  tlsEstado.error = null
  tlsEstado.ultimo_rechazo = null
  log.info(
    { origen, valido_hasta: tlsEstado.valido_hasta, escuchas: aplicadas },
    `relay: certificado ${etiqueta} aplicado, válido hasta ${tlsEstado.valido_hasta || 'fecha desconocida'}`
  )
  return resultado(true)
}

// ---------------------------------------------------------------------------
// Conexiones
// ---------------------------------------------------------------------------

/** Límite de conexiones simultáneas por IP de origen (compartido por las dos escuchas). */
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

/** Abre el puerto de una escucha. Nunca rechaza: si falla, lo deja en el log y la marca como no viva. */
function abrirEscucha(escucha, log) {
  return new Promise((resolve) => {
    const { servidor, puerto, etiqueta } = escucha
    const alFallarArranque = (err) => {
      log.error({ err, puerto, escucha: etiqueta }, 'relay: no se ha podido abrir el puerto SMTP')
      resolve(false)
    }
    servidor.once('error', alFallarArranque)
    // 0.0.0.0: dentro del contenedor hay que escuchar en todas las interfaces para que EasyPanel
    // pueda publicar el puerto como TCP. SMTP_RELAY_HOST es el nombre público, no la escucha.
    servidor.listen(puerto, '0.0.0.0', () => {
      servidor.removeListener('error', alFallarArranque)
      escucha.escuchando = true
      resolve(true)
    })
  })
}

const resultadoActual = () => {
  const vivas = escuchas.filter((e) => e.escuchando)
  if (!vivas.length) return null
  return {
    starttls: vivas.find((e) => e.etiqueta === 'starttls')?.servidor || null,
    ssl: vivas.find((e) => e.etiqueta === 'ssl')?.servidor || null,
  }
}

/**
 * Levanta la pasarela: la escucha STARTTLS siempre y la SSL si SMTP_RELAY_PORT_SSL está definido.
 * NUNCA lanza ni rechaza: si no puede abrir ningún puerto lo deja escrito en el log y devuelve
 * null, porque un puerto SMTP ocupado no puede tumbar el panel ni los nodos de GHL. Vuelve en
 * cuanto los puertos están abiertos, sin esperar al certificado.
 *
 * @param {object} [entrada] logger (o cualquier objeto con `.log`)
 * @returns {Promise<{ starttls: import('smtp-server').SMTPServer|null, ssl: import('smtp-server').SMTPServer|null }|null>}
 */
export function arrancarRelay(entrada) {
  const log = normalizarLog(entrada)

  if (!relayHabilitado()) {
    log.info('relay: desactivado (SMTP_RELAY_ENABLED no es verdadero)')
    return Promise.resolve(null)
  }
  if (escuchas.length) return Promise.resolve(resultadoActual())
  if (arrancando) return arrancando

  const miGeneracion = ++generacion
  const host = hostRelay()
  const maxSize = tamanoMaximo()
  const puertoStarttls = puertoRelay()
  const puertoSsl = puertoRelaySsl()
  const tlsInicial = cargarTLS(log)

  // Un solo juego de handlers para las dos escuchas: misma auth, mismo enrutado, mismos límites.
  const comunes = {
    name: host || 'emails-disruptivo',
    banner: 'Relay de la app de email',
    ...tlsInicial,

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
    // Jamás AUTH en claro. smtp-server SÍ anuncia AUTH PLAIN LOGIN en el EHLO en claro, pero con
    // allowInsecureAuth:false rechaza el comando con «538 Must issue a STARTTLS command first»
    // hasta que la sesión sube a TLS: ninguna credencial viaja sin cifrar.
    allowInsecureAuth: false,
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
  }

  // secure:false = se empieza en claro y se sube con STARTTLS (587 público);
  // secure:true  = TLS implícito desde el primer byte (465 público).
  const definiciones = [{ etiqueta: 'starttls', puerto: puertoStarttls, publico: puertoPublico(), secure: false }]
  if (puertoSsl) {
    if (puertoSsl === puertoStarttls) {
      log.error({ puerto: puertoSsl }, 'relay: SMTP_RELAY_PORT_SSL no puede ser el mismo puerto que SMTP_RELAY_PORT; la escucha SSL no se levanta')
    } else {
      definiciones.push({ etiqueta: 'ssl', puerto: puertoSsl, publico: puertoPublicoSsl(), secure: true })
    }
  }

  const nuevas = definiciones.map((d) => {
    const servidor = new SMTPServer({ ...comunes, secure: d.secure })
    const escucha = { ...d, servidor, escuchando: false }
    // Errores del servidor ya en marcha (sockets rotos, EMFILE…): se anotan y se sigue sirviendo.
    // Los del arranque los recoge abrirEscucha, por eso aquí se callan hasta que está escuchando.
    servidor.on('error', (err) => {
      if (escucha.escuchando) log.error({ err, escucha: d.etiqueta }, 'relay: error del servidor SMTP')
    })
    return escucha
  })
  escuchas.push(...nuevas)

  arrancando = Promise.all(nuevas.map((e) => abrirEscucha(e, log))).then(() => {
    arrancando = null
    if (generacion !== miGeneracion) return null // pararRelay llegó antes de terminar de abrir

    for (const e of nuevas) {
      if (e.escuchando) continue
      const i = escuchas.indexOf(e)
      if (i >= 0) escuchas.splice(i, 1)
    }
    const vivas = nuevas.filter((e) => e.escuchando)
    if (!vivas.length) {
      log.error('relay: no se ha podido abrir ninguna escucha SMTP; la pasarela queda apagada')
      return null
    }

    log.info(
      {
        host: host || null,
        escuchas: vivas.map((e) => ({ tipo: e.etiqueta, puerto: e.puerto, publico: e.publico })),
        maxSize,
        tls: tlsEstado.modo,
        tls_origen: modoTraefikActivo() ? 'traefik' : tlsAutoActivo() ? 'acme' : 'ninguno',
        rebotes: dominioRebotes() || null,
      },
      'relay: escuchando'
    )
    return resultadoActual()
  })

  return arrancando
}

/**
 * Cierra las dos escuchas para el apagado ordenado de la app: dejan de aceptar conexiones y se
 * espera a que terminen las que están a medio mensaje (smtp-server las corta pasado closeTimeout).
 */
export function pararRelay(entrada) {
  const log = normalizarLog(entrada)
  generacion++
  arrancando = null
  conexionesPorIp.clear()
  const vivas = escuchas.splice(0)
  if (!vivas.length) return Promise.resolve()

  return new Promise((resolve) => {
    // Red de seguridad: si algún socket se resiste, no se bloquea el apagado de todo el proceso.
    const guardia = setTimeout(() => {
      log.warn('relay: cierre forzado tras agotar la espera')
      resolve()
    }, CLOSE_TIMEOUT_MS + 5_000)
    guardia.unref?.()

    // También se cierran las que aún no habían terminado de abrirse: net.Server admite close()
    // en cuanto se ha llamado a listen(), y así no queda ningún puerto huérfano.
    const cierres = vivas.map(
      (e) =>
        new Promise((fin) => {
          try {
            e.servidor.close(() => {
              e.escuchando = false
              fin()
            })
          } catch {
            e.escuchando = false
            fin()
          }
        })
    )
    Promise.all(cierres).then(() => {
      clearTimeout(guardia)
      log.info('relay: detenido')
      resolve()
    })
  })
}

// Forma del SPEC §13.2 más `ultimo_rechazo` (informativo: el último certificado que no se pudo
// aplicar, aunque el que está en servicio siga bien).
const estadoTls = () => ({
  modo: tlsEstado.modo,
  valido_hasta: tlsEstado.valido_hasta,
  error: tlsEstado.error,
  ultimo_rechazo: tlsEstado.ultimo_rechazo,
  hostname: hostRelay(),
})

/**
 * Puerto SSL que se anuncia al cliente: el configurado mientras la pasarela está apagada (para que
 * las instrucciones del panel sean completas) y, con la pasarela en marcha, solo si la escucha SSL
 * está realmente abierta. Anunciar un 465 que no escucha es mandar al cliente a un timeout.
 */
function puertoSslAnunciado() {
  const configurado = puertoPublicoSsl()
  if (!configurado) return null
  const activa = escuchas.some((e) => e.escuchando)
  if (!activa) return configurado
  return escuchas.some((e) => e.etiqueta === 'ssl' && e.escuchando) ? configurado : null
}

/**
 * Estado para el panel y los diagnósticos, con la forma exacta del SPEC §13.2. Los puertos son los
 * PÚBLICOS (los que se pegan en GHL); `ssl` es null si la escucha SSL no está configurada.
 */
export const estadoRelay = () => ({
  activo: escuchas.some((e) => e.escuchando),
  host: hostRelay(),
  puertos: { starttls: puertoPublico(), ssl: puertoSslAnunciado() },
  tls: estadoTls(),
})

// Alias en las dos formas que suele usar el resto del proyecto, para que src/index.js pueda
// importarlo como prefiera sin tener que adivinar el nombre.
export const iniciarRelay = arrancarRelay
export const detenerRelay = pararRelay

export default {
  arrancarRelay,
  pararRelay,
  iniciarRelay,
  detenerRelay,
  estadoRelay,
  actualizarCertificado,
  relayHabilitado,
  modoTraefikActivo,
  hostRelay,
}
