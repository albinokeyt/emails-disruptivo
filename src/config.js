// ---------------------------------------------------------------------------
// Variables de entorno (SPEC §8).
//
// Este módulo NO escribe en process.env: el resto de la app sigue leyéndolas directamente.
// Aquí solo se normalizan, se aplican los valores por defecto y se comprueba que estén las
// obligatorias. La comprobación NO se hace al importar (romper el import dejaría sin arrancar
// también al worker o a la pasarela por una variable que ni usan): la dispara validarEntorno(),
// que llama src/index.js como primera instrucción del arranque.
// ---------------------------------------------------------------------------

const problemas = []
const avisos = []

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

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
const port = entero('PORT', 8080, { min: 1, max: 65535 })
const relayHabilitado = booleano('SMTP_RELAY_ENABLED', false)
const relayPuerto = entero('SMTP_RELAY_PORT', 2525, { min: 1, max: 65535 })
if (relayHabilitado && relayPuerto === port) {
  problemas.push(`SMTP_RELAY_PORT (${relayPuerto}) no puede ser el mismo puerto que PORT: son dos servidores distintos.`)
}

// --- TLS del relay ----------------------------------------------------------
const relayTlsCert = texto(process.env.SMTP_RELAY_TLS_CERT)
const relayTlsKey = texto(process.env.SMTP_RELAY_TLS_KEY)
if (Boolean(relayTlsCert) !== Boolean(relayTlsKey)) {
  problemas.push('SMTP_RELAY_TLS_CERT y SMTP_RELAY_TLS_KEY van siempre juntas: define las dos o ninguna.')
}
if (relayHabilitado && !relayTlsCert) {
  avisos.push(
    'El relay SMTP está activado sin certificado (SMTP_RELAY_TLS_CERT/_KEY): solo habrá STARTTLS ' +
      'oportunista con certificado autofirmado. Ver DEPLOY.md §D2.'
  )
}

// --- Tracking universal (SPEC §11.5) ----------------------------------------
// SMTP_BOUNCE_DOMAIN activa el VERP (Return-Path propio por envío) y la captura de rebotes en la
// pasarela SMTP. Es un nombre de dominio pelado (rebotes.tudominio.com): ni esquema, ni arroba,
// ni puerto. Sin definirla, la pieza entera queda apagada y nada cambia.
const bounceDomain = texto(process.env.SMTP_BOUNCE_DOMAIN).toLowerCase().replace(/\.+$/, '')
const RE_DOMINIO = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/
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
    puerto: relayPuerto,
    // lo que se le enseña al usuario para pegar en GHL; por defecto, el host de APP_BASE_URL
    host: texto(process.env.SMTP_RELAY_HOST) || hostPublico,
    tlsCert: relayTlsCert || null,
    tlsKey: relayTlsKey || null,
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
