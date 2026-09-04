// ---------------------------------------------------------------------------
// Variables de entorno (SPEC §8, §11.5 y §13.2).
//
// Este módulo NO escribe en process.env: el resto de la app sigue leyéndolas directamente.
// Aquí solo se normalizan, se aplican los valores por defecto y se comprueba que estén las
// obligatorias. La comprobación NO se hace al importar (romper el import dejaría sin arrancar
// también al worker o a la pasarela por una variable que ni usan): la dispara validarEntorno(),
// que llama src/index.js como primera instrucción del arranque.
// ---------------------------------------------------------------------------

import path from 'node:path'

const problemas = []
const avisos = []

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

// Nombre de dominio pelado (etiquetas DNS, al menos un punto): lo usan SMTP_BOUNCE_DOMAIN y el
// host del relay para el certificado ACME.
const RE_DOMINIO = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

const VERDADEROS = new Set(['1', 'true', 'si', 'sí', 'yes', 'on'])
const FALSOS = new Set(['0', 'false', 'no', 'off'])

function booleano(nombre, def) {
  const s = texto(process.env[nombre]).toLowerCase()
  if (!s) return def
  if (VERDADEROS.has(s)) return true
  if (FALSOS.has(s)) return false
  problemas.push(`${nombre}="${s}" no es un valor booleano: usa true o false.`)
  return def
}

function entero(nombre, def, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const s = texto(process.env[nombre])
  if (!s) return def
  const n = Number(s)
  if (!Number.isInteger(n) || n < min || n > max) {
    problemas.push(`${nombre}="${s}" tiene que ser un número entero entre ${min} y ${max}.`)
    return def
  }
  return n
}

// Descripción de cada variable obligatoria: se enseña tal cual cuando falta, para que el mensaje
// del arranque baste sin abrir la documentación.
const OBLIGATORIAS = {
  DATABASE_URL: 'cadena de conexión a Postgres, p. ej. postgres://usuario:clave@host:5432/emails',
  REDIS_URL: 'cadena de conexión a Redis, p. ej. redis://host:6379 (sesiones, locks y límites de envío)',
  APP_BASE_URL: 'URL pública de la app SIN barra final, p. ej. https://emails.tudominio.com',
  ENCRYPTION_KEY: '32 bytes en base64 o 64 caracteres hex; cifra las credenciales de los proveedores',
  ADMIN_USER: 'usuario del panel de la agencia',
  ADMIN_PASS: 'contraseña del panel de la agencia (larga y única)',
}

for (const [nombre, para] of Object.entries(OBLIGATORIAS)) {
  if (!texto(process.env[nombre])) problemas.push(`Falta ${nombre}: ${para}.`)
}

// --- APP_BASE_URL -----------------------------------------------------------
const appBaseUrlBruta = texto(process.env.APP_BASE_URL).replace(/\/+$/, '')
let appBaseUrl = appBaseUrlBruta
let hostPublico = ''
if (appBaseUrlBruta) {
  try {
    const u = new URL(appBaseUrlBruta)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      problemas.push(`APP_BASE_URL="${appBaseUrlBruta}" tiene que empezar por http:// o https://.`)
    }
    if (u.pathname && u.pathname !== '/') {
      problemas.push(`APP_BASE_URL="${appBaseUrlBruta}" no puede llevar ruta: solo el dominio (${u.origin}).`)
    }
    hostPublico = u.hostname
    appBaseUrl = u.origin
    if (u.protocol === 'http:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
      // GoHighLevel solo carga Custom Pages por HTTPS, y la cookie del iframe exige Secure
      avisos.push('APP_BASE_URL no usa HTTPS: GoHighLevel no cargará el panel dentro de su iframe.')
    }
  } catch {
    problemas.push(`APP_BASE_URL="${appBaseUrlBruta}" no es una URL válida.`)
  }
}

// --- Puertos ----------------------------------------------------------------
const RANGO_PUERTO = { min: 1, max: 65535 }
const port = entero('PORT', 8080, RANGO_PUERTO)
const relayHabilitado = booleano('SMTP_RELAY_ENABLED', false)

// Escuchas INTERNAS del relay (SPEC §13.2): puertos altos a propósito, el contenedor no necesita
// privilegios para abrirlos; EasyPanel los publica como 587 → 2525 y 465 → 2465 (TCP).
const relayPuerto = entero('SMTP_RELAY_PORT', 2525, RANGO_PUERTO)

// La escucha SSL (TLS implícito) se levanta por defecto en 2465. Se apaga dejando la variable
// vacía o con 0/false/no/off: la ausencia de la variable NO la apaga (sería el valor por defecto).
function puertoOpcional(nombre, def) {
  const bruto = process.env[nombre]
  if (bruto === undefined) return def
  const s = texto(bruto).toLowerCase()
  if (!s || FALSOS.has(s)) return null
  return entero(nombre, def, RANGO_PUERTO)
}
const relayPuertoSsl = puertoOpcional('SMTP_RELAY_PORT_SSL', 2465)

// Puertos PÚBLICOS: los que EasyPanel publica hacia las escuchas internas y los que el panel enseña
// al cliente para pegar en GHL (587 · TLS/STARTTLS y 465 · SSL, los que documenta GoHighLevel).
const relayPuertoPublico = entero('SMTP_RELAY_PUBLIC_PORT', 587, RANGO_PUERTO)
const relayPuertoPublicoSsl = entero('SMTP_RELAY_PUBLIC_PORT_SSL', 465, RANGO_PUERTO)

if (relayHabilitado) {
  // las escuchas internas conviven en el mismo contenedor: tres servidores, tres puertos
  if (relayPuerto === port) {
    problemas.push(`SMTP_RELAY_PORT (${relayPuerto}) no puede ser el mismo puerto que PORT: son dos servidores distintos.`)
  }
  if (relayPuertoSsl !== null && relayPuertoSsl === port) {
    problemas.push(`SMTP_RELAY_PORT_SSL (${relayPuertoSsl}) no puede ser el mismo puerto que PORT: son dos servidores distintos.`)
  }
  if (relayPuertoSsl !== null && relayPuertoSsl === relayPuerto) {
    problemas.push(
      `SMTP_RELAY_PORT_SSL (${relayPuertoSsl}) no puede coincidir con SMTP_RELAY_PORT: la escucha STARTTLS y la SSL ` +
        'son dos servidores distintos.'
    )
  }
  // los públicos se publican en el mismo host del VPS: tampoco pueden pisarse entre sí
  if (relayPuertoSsl !== null && relayPuertoPublico === relayPuertoPublicoSsl) {
    problemas.push(
      `SMTP_RELAY_PUBLIC_PORT y SMTP_RELAY_PUBLIC_PORT_SSL no pueden ser el mismo puerto (${relayPuertoPublico}): ` +
        'uno es el de STARTTLS y otro el de SSL.'
    )
  }
}

// --- TLS del relay ----------------------------------------------------------
// Precedencia del certificado (SPEC §13.1): ficheros SMTP_RELAY_TLS_CERT/_KEY (manual) > Traefik
// (SMTP_RELAY_TRAEFIK_ACME: se lee el acme.json que Traefik ya renueva solo) > ACME propio por
// HTTP-01 (SMTP_RELAY_TLS_AUTO, por defecto true) > autofirmado de smtp-server.
const relayTlsCert = texto(process.env.SMTP_RELAY_TLS_CERT)
const relayTlsKey = texto(process.env.SMTP_RELAY_TLS_KEY)
if (Boolean(relayTlsCert) !== Boolean(relayTlsKey)) {
  problemas.push('SMTP_RELAY_TLS_CERT y SMTP_RELAY_TLS_KEY van siempre juntas: define las dos o ninguna.')
}
const relayTlsAuto = booleano('SMTP_RELAY_TLS_AUTO', true)

// Modo «traefik»: ruta, DENTRO del contenedor, del acme.json de Traefik (bind mount de solo
// lectura). Es el modo para EasyPanel: el ACME del propio Traefik captura el reto HTTP-01 en el
// puerto 80 antes de enrutar nada, así que la app no puede validar por sí misma; pero Traefik ya
// tiene (y renueva) el certificado del host, y basta con leerlo. Con esta variable definida no se
// llama nunca a la CA desde la app.
const relayTraefikAcme = texto(process.env.SMTP_RELAY_TRAEFIK_ACME)
if (relayTraefikAcme && !path.isAbsolute(relayTraefikAcme)) {
  problemas.push(
    `SMTP_RELAY_TRAEFIK_ACME="${relayTraefikAcme}" tiene que ser una ruta absoluta dentro del contenedor, ` +
      'p. ej. /certs/acme.json (DEPLOY.md §D).'
  )
}

const relayHost = texto(process.env.SMTP_RELAY_HOST).toLowerCase().replace(/\.+$/, '') || hostPublico

const ACME_LETSENCRYPT_PRODUCCION = 'https://acme-v02.api.letsencrypt.org/directory'
const ACME_LETSENCRYPT_STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory'

// ACME_DIRECTORY: vacío = producción de Let's Encrypt. Se admiten los atajos "staging" y
// "produccion" además de una URL completa (Pebble en local, otra CA…).
const acmeDirectoryBruto = texto(process.env.ACME_DIRECTORY)
let acmeDirectory = ACME_LETSENCRYPT_PRODUCCION
if (acmeDirectoryBruto) {
  const atajo = acmeDirectoryBruto.toLowerCase()
  if (atajo === 'staging' || atajo === 'pruebas') acmeDirectory = ACME_LETSENCRYPT_STAGING
  else if (atajo === 'produccion' || atajo === 'producción' || atajo === 'production') acmeDirectory = ACME_LETSENCRYPT_PRODUCCION
  else {
    try {
      const u = new URL(acmeDirectoryBruto)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('esquema')
      acmeDirectory = u.href
    } catch {
      problemas.push(
        `ACME_DIRECTORY="${acmeDirectoryBruto}" no es válido: usa la URL de un directorio ACME, o "staging" para ` +
          'las pruebas de Let\'s Encrypt.'
      )
    }
  }
}

const acmeEmail = texto(process.env.ACME_EMAIL).toLowerCase()
if (acmeEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(acmeEmail)) {
  problemas.push(`ACME_EMAIL="${acmeEmail}" no es una dirección de correo válida (es el contacto opcional de la cuenta ACME).`)
}

const hostRelayPublico =
  Boolean(relayHost) && RE_DOMINIO.test(relayHost) && relayHost !== 'localhost' && !/^\d+(\.\d+){3}$/.test(relayHost)

if (relayHabilitado && !relayTlsCert) {
  if (relayTraefikAcme) {
    if (!hostRelayPublico) {
      avisos.push(
        `El relay SMTP lee su certificado del acme.json de Traefik, pero el host "${relayHost || '(vacío)'}" no es un ` +
          'nombre de dominio público (SMTP_RELAY_HOST o el dominio de APP_BASE_URL): Traefik no tendrá certificado para él.'
      )
    }
  } else if (!relayTlsAuto) {
    avisos.push(
      'El relay SMTP está activado sin certificado (SMTP_RELAY_TLS_CERT/_KEY) y con SMTP_RELAY_TLS_AUTO=false: ' +
        'solo habrá STARTTLS oportunista con certificado autofirmado. Ver DEPLOY.md §D.'
    )
  } else if (!hostRelayPublico) {
    // el certificado ACME se emite para un nombre público: sin él, la emisión automática no puede ni intentarse
    avisos.push(
      `El relay SMTP no podrá emitir su certificado automáticamente: el host "${relayHost || '(vacío)'}" no es un ` +
        'nombre de dominio público (SMTP_RELAY_HOST o el dominio de APP_BASE_URL). Se arrancará con certificado autofirmado.'
    )
  } else {
    // detrás de Traefik (EasyPanel) el HTTP-01 propio no puede funcionar: se avisa ya en el arranque
    avisos.push(
      'El relay SMTP va a pedir su certificado por ACME HTTP-01 desde la app. Si delante hay Traefik con ACME ' +
        '(EasyPanel), ese reto no llega a la app: define SMTP_RELAY_TRAEFIK_ACME para leer el certificado de Traefik (DEPLOY.md §D).'
    )
  }
}

// --- Tracking universal (SPEC §11.5) ----------------------------------------
// SMTP_BOUNCE_DOMAIN activa el VERP (Return-Path propio por envío) y la captura de rebotes en la
// pasarela SMTP. Es un nombre de dominio pelado (rebotes.tudominio.com): ni esquema, ni arroba,
// ni puerto. Sin definirla, la pieza entera queda apagada y nada cambia.
const bounceDomain = texto(process.env.SMTP_BOUNCE_DOMAIN).toLowerCase().replace(/\.+$/, '')
if (bounceDomain && !RE_DOMINIO.test(bounceDomain)) {
  problemas.push(
    `SMTP_BOUNCE_DOMAIN="${bounceDomain}" no es un nombre de dominio válido: usa solo el dominio, ` +
      'p. ej. rebotes.tudominio.com (sin https://, sin @ y sin puerto).'
  )
}
if (bounceDomain && !relayHabilitado) {
  // no bloquea: los envíos ya saldrán con VERP, pero nadie escuchará los rebotes hasta activar el relay
  avisos.push(
    'SMTP_BOUNCE_DOMAIN está definido pero SMTP_RELAY_ENABLED no es true: los rebotes no se ' +
      'capturarán hasta levantar el servidor SMTP (ver DEPLOY.md, «Captura de rebotes (VERP)»).'
  )
}

const inferenciaEntregaHoras = entero('INFERENCIA_ENTREGA_HORAS', 48, { min: 1, max: 720 })
const trackingSegundosMinimos = entero('TRACKING_SEGUNDOS_MINIMOS', 10, { min: 0, max: 3600 })

// --- Worker y límites -------------------------------------------------------
const workerHabilitado = booleano('WORKER_HABILITADO', true)
const workerConcurrencia = entero('WORKER_CONCURRENCIA', 5, { min: 1, max: 100 })
if (!workerHabilitado) {
  // no es un error: se apaga a propósito para escalar workers en otro servicio
  avisos.push('WORKER_HABILITADO=false: esta instancia no enviará correo, solo servirá la API y el panel.')
}

export const config = {
  entorno: texto(process.env.NODE_ENV) || 'production',
  port,
  databaseUrl: texto(process.env.DATABASE_URL),
  redisUrl: texto(process.env.REDIS_URL) || 'redis://127.0.0.1:6379',
  appBaseUrl,
  adminUser: texto(process.env.ADMIN_USER),
  // la contraseña no se expone en ningún log ni en /healthz: solo la lee routes/admin.js desde process.env
  adminPass: texto(process.env.ADMIN_PASS),
  relay: {
    habilitado: relayHabilitado,
    // escuchas internas del contenedor (SPEC §13.2); puertoSsl null = la escucha SSL no se levanta
    puerto: relayPuerto,
    puertoSsl: relayPuertoSsl,
    // puertos públicos: los que EasyPanel publica hacia las escuchas y los que ve el cliente en el panel
    puertoPublico: relayPuertoPublico,
    puertoPublicoSsl: relayPuertoSsl === null ? null : relayPuertoPublicoSsl,
    // lo que se le enseña al usuario para pegar en GHL y el host del certificado; por defecto, el de APP_BASE_URL
    host: relayHost,
    tlsCert: relayTlsCert || null,
    tlsKey: relayTlsKey || null,
    // modo traefik: ruta del acme.json de Traefik dentro del contenedor (null = no se usa)
    traefikAcme: relayTraefikAcme || null,
    // emisión automática del certificado por ACME HTTP-01 (solo cuenta si no hay ficheros ni modo traefik)
    tlsAuto: relayTlsAuto,
    acmeEmail: acmeEmail || null,
    acmeDirectory,
    tamMaximo: entero('SMTP_RELAY_MAX_SIZE', 26_214_400, { min: 1024 }),
  },
  limites: {
    envioMinuto: entero('ENVIO_LIMITE_MINUTO', 60),
    envioDia: entero('ENVIO_LIMITE_DIA', 5000),
  },
  tracking: {
    // dominio de rebotes (VERP); null = captura de rebotes apagada
    bounceDomain: bounceDomain || null,
    // horas sin rebote ni spam tras las que el reconciliador infiere la entrega (SPEC §11.2)
    inferenciaEntregaHoras,
    // apertura a menos de este umbral del envío = automática, no humana (SPEC §11.1)
    segundosMinimos: trackingSegundosMinimos,
  },
  worker: {
    habilitado: workerHabilitado,
    concurrencia: workerConcurrencia,
  },
}

/**
 * Comprueba el entorno. Lanza con TODOS los problemas juntos (no de uno en uno: quien despliega
 * quiere corregirlos de una pasada) y devuelve los avisos no bloqueantes para que los registre
 * el arranque.
 */
export function validarEntorno() {
  if (problemas.length) {
    throw new Error(
      `Revisa las variables de entorno del servicio (tienes la lista completa en .env.example):\n` +
        problemas.map((p) => `  · ${p}`).join('\n')
    )
  }
  return [...avisos]
}
