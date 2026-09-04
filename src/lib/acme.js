import { createHash, randomBytes } from 'node:crypto'
import { config } from '../config.js'
import { q } from '../db.js'
import { redis } from '../redis.js'
import { cifrarCredenciales, descifrarCredenciales } from './crypto.js'

// ---------------------------------------------------------------------------
// Certificado TLS automático del relay SMTP (SPEC §13.1): emisión y renovación por ACME HTTP-01
// contra Let's Encrypt, sin volúmenes, sin sidecar y sin tocar nada a mano.
//
// El reto HTTP-01 exige que el puerto 80 del host del relay entregue a esta app la petición
// http://<host>/.well-known/acme-challenge/<token>: la ruta de src/routes/acme.js lee el
// keyAuthorization de Redis (acme:challenge:<token>) y lo devuelve. Eso pasa en un despliegue con
// un proxy «tonto» delante (o sin proxy). NO pasa detrás de Traefik con ACME (EasyPanel): su propio
// manejador ACME captura esa ruta para todos los hosts y responde 404 vacío antes de enrutar nada.
// Para ese caso está el modo traefik (src/lib/traefik.js), que lee el certificado que Traefik ya
// tiene; aquí solo se detecta la situación en la autocomprobación del reto y se aborta ANTES de
// pedir la validación, para no gastar intentos de la CA y dejar un motivo claro en last_error.
//
// Persistencia en tls_certificates (migración 004): la clave de la cuenta ACME y la privada del
// certificado van cifradas con ENCRYPTION_KEY, igual que las credenciales de los proveedores.
//
// Reglas que protegen las cuotas de Let's Encrypt (son estrictas y compartidas por dominio):
//   · solo se renueva cuando quedan menos de 30 días;
//   · un lock en Redis (acme:lock:<host>, 5 min) evita que dos instancias emitan a la vez;
//   · tras un fallo no se reintenta en una hora (last_attempt_at + last_error).
//
// asegurarCertificado NUNCA lanza: si algo falla devuelve el certificado vigente que haya en la
// base de datos (aunque le queden pocos días) o null, para que el relay siga en pie con lo que tenga.
// El motivo del último null se consulta con motivoSinCertificado(host).
// ---------------------------------------------------------------------------

const DIAS_RENOVACION = 30
const MS_DIA = 86_400_000
const LOCK_TTL_MS = 300_000
const CUOTA_TRAS_ERROR_MS = 3_600_000
const RETO_TTL_S = 600
const INTERVALO_RENOVACION_MS = 12 * 3_600_000
// sin certificado válido se vuelve a intentar cada hora (la cuota de 1/h manda de todos modos)
const INTERVALO_SIN_CERTIFICADO_MS = 3_600_000
// si el null fue por el lock de otra instancia (o uno huérfano de un redespliegue a mitad de
// emisión) se reintenta en cuanto el lock haya caducado, no dentro de una hora
const REINTENTO_TRAS_LOCK_MS = LOCK_TTL_MS + 30_000
// por debajo del TTL del lock: si la CA no responde, se suelta antes de que el lock caduque solo
const TIEMPO_MAXIMO_EMISION_MS = 240_000
const AUTOCOMPROBACION_TIMEOUT_MS = 5_000
const MAX_ERROR = 1000

const PREFIJO_RETO = 'acme:challenge:'
const PREFIJO_LOCK = 'acme:lock:'

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

// ---------------------------------------------------------------------------
// Log: acepta el logger de Fastify (pino), console o nada.
// ---------------------------------------------------------------------------
function registrador(base) {
  const nada = () => {}
  const l = base && typeof base === 'object' ? base : console
  const metodo = (nombre, alternativa) => (typeof l[nombre] === 'function' ? l[nombre].bind(l) : alternativa)
  const info = metodo('info', metodo('log', nada))
  return {
    info,
    warn: metodo('warn', info),
    error: metodo('error', info),
  }
}

// ---------------------------------------------------------------------------
// Hostname: solo se pide certificado para un nombre público de verdad. Pedirlo para localhost,
// una IP o un dominio de ejemplo no puede funcionar y solo consume intentos de la CA.
// ---------------------------------------------------------------------------

// FQDN: etiquetas DNS y un TLD que empieza por letra (así una IPv4 nunca pasa por nombre)
const RE_FQDN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/
const RE_IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/

// TLD internos, reservados o de pruebas (RFC 2606, RFC 6762, mDNS…): ninguna CA pública los emite
const TLD_NO_PUBLICOS = new Set([
  'localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'localdomain', 'corp', 'private',
  'test', 'example', 'invalid', 'onion', 'arpa',
])
// dominios de ejemplo que se cuelan de la documentación y de .env.example
const DOMINIOS_EJEMPLO = [
  /(?:^|\.)example\.(?:com|net|org)$/,
  /(?:^|\.)(?:tu|mi|su)dominio\.[a-z]+$/,
]

const normalizarHost = (h) => texto(h).toLowerCase().replace(/\.+$/, '')

/**
 * ¿Es un nombre para el que tiene sentido pedir un certificado público?
 * @returns {{ ok: boolean, hostname: string, motivo?: string }}
 */
export function comprobarHostname(hostname) {
  const h = normalizarHost(hostname)
  if (!h) return { ok: false, hostname: h, motivo: 'no hay host del relay (SMTP_RELAY_HOST o el dominio de APP_BASE_URL)' }
  if (h === 'localhost' || h.endsWith('.localhost')) {
    return { ok: false, hostname: h, motivo: 'localhost no puede tener un certificado público' }
  }
  if (RE_IPV4.test(h) || h.includes(':') || h.startsWith('[')) {
    return { ok: false, hostname: h, motivo: 'es una dirección IP, no un nombre de dominio' }
  }
  if (!RE_FQDN.test(h)) {
    return { ok: false, hostname: h, motivo: 'no es un nombre de dominio completo (FQDN) válido' }
  }
  const tld = h.slice(h.lastIndexOf('.') + 1)
  if (TLD_NO_PUBLICOS.has(tld)) {
    return { ok: false, hostname: h, motivo: `el dominio .${tld} es interno o de pruebas y ninguna CA pública lo emite` }
  }
  if (DOMINIOS_EJEMPLO.some((re) => re.test(h))) {
    return { ok: false, hostname: h, motivo: 'es un dominio de ejemplo de la documentación, no el tuyo' }
  }
  return { ok: true, hostname: h }
}

// ---------------------------------------------------------------------------
// Cifrado de los PEM. Se reutiliza el esquema de las credenciales de proveedor envolviendo el
// PEM en {pem}: mismo formato v1$…, mismas claves, misma rotación.
// ---------------------------------------------------------------------------
const cifrarPem = (pem) => cifrarCredenciales({ pem: String(pem) })

function descifrarPem(enc) {
  if (!enc) return null
  try {
    const { pem } = descifrarCredenciales(enc)
    return typeof pem === 'string' && pem.includes('-----BEGIN') ? pem : null
  } catch {
    // clave rotada sin la vieja en ENCRYPTION_KEY: se trata como si no hubiera dato y se regenera
    return null
  }
}

// Ni PEM, ni token del reto, ni keyAuthorization pueden acabar en last_error o en los logs.
function limpiarError(err) {
  let m = String(err?.message || err || 'error desconocido')
  // acme-client (su interceptor de axios) convierte un corte de red a mitad de emisión en este
  // TypeError sin información; se traduce a algo que se entienda en Ajustes
  if (/reading 'config'/.test(m)) m = 'la CA dejó de responder a mitad de la emisión (fallo de red hacia el directorio ACME)'
  m = m.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[pem]')
  m = m.replace(/acme-challenge\/[A-Za-z0-9_-]+/g, 'acme-challenge/[token]')
  m = m.replace(/\b[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\b/g, '[keyAuthorization]')
  m = m.replace(/\s+/g, ' ').trim()
  return m.slice(0, MAX_ERROR)
}

const huella = (certPem) => createHash('sha256').update(String(certPem)).digest('hex')

// Última huella devuelta por hostname: la comprobación periódica la compara para saber si hay que
// aplicar un certificado nuevo al relay (lo haya renovado esta instancia u otra).
const huellas = new Map()

// Motivo del último null de asegurarCertificado por hostname:
//   'host'  el nombre no puede tener certificado público · 'cuota' falló hace menos de una hora ·
//   'lock'  otra instancia (o un lock huérfano) lo tiene · 'error' la emisión falló ·
//   'fallo' error inesperado (Postgres, Redis, cifrado)
const motivos = new Map()

// ---------------------------------------------------------------------------
// Persistencia (tls_certificates)
// ---------------------------------------------------------------------------
async function leerFila(hostname) {
  const { rows: [fila] } = await q(
    `SELECT hostname, account_key_enc, private_key_enc, certificate_pem, issued_at, expires_at,
            last_attempt_at, last_error
       FROM tls_certificates WHERE hostname = $1`,
    [hostname]
  )
  return fila ?? null
}

// La clave de cuenta se guarda en cuanto existe: Let's Encrypt limita las cuentas nuevas por IP, y
// perderla en cada intento fallido acabaría agotando ese límite. Sin `reemplazar`, COALESCE: nunca
// se pisa una ya guardada. Con `reemplazar` (la guardada no se pudo descifrar: ENCRYPTION_KEY
// rotada sin dejar la vieja) se sobrescribe, o cada emisión crearía otra cuenta nueva en la CA y
// ninguna se reutilizaría.
async function guardarClaveCuenta(hostname, accountKeyEnc, { reemplazar = false } = {}) {
  const asignacion = reemplazar
    ? 'account_key_enc = EXCLUDED.account_key_enc'
    : 'account_key_enc = COALESCE(tls_certificates.account_key_enc, EXCLUDED.account_key_enc)'
  await q(
    `INSERT INTO tls_certificates (hostname, account_key_enc, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (hostname) DO UPDATE
       SET ${asignacion},
           updated_at = now()`,
    [hostname, accountKeyEnc]
  )
}

async function guardarCertificado(hostname, { privateKeyEnc, certPem, issuedAt, expiresAt }) {
  await q(
    `INSERT INTO tls_certificates
       (hostname, private_key_enc, certificate_pem, issued_at, expires_at, last_attempt_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, now(), NULL, now())
     ON CONFLICT (hostname) DO UPDATE
       SET private_key_enc = EXCLUDED.private_key_enc,
           certificate_pem = EXCLUDED.certificate_pem,
           issued_at = EXCLUDED.issued_at,
           expires_at = EXCLUDED.expires_at,
           last_attempt_at = now(),
           last_error = NULL,
           updated_at = now()`,
    [hostname, privateKeyEnc, certPem, issuedAt, expiresAt]
  )
}

async function registrarFallo(hostname, motivo) {
  await q(
    `INSERT INTO tls_certificates (hostname, last_attempt_at, last_error, updated_at)
     VALUES ($1, now(), $2, now())
     ON CONFLICT (hostname) DO UPDATE
       SET last_attempt_at = now(), last_error = EXCLUDED.last_error, updated_at = now()`,
    [hostname, motivo]
  )
}

function certificadoDeFila(fila) {
  if (!fila?.certificate_pem || !fila.private_key_enc || !fila.expires_at) return null
  const key = descifrarPem(fila.private_key_enc)
  if (!key) return null
  return { key, cert: String(fila.certificate_pem), expiresAt: new Date(fila.expires_at) }
}

const msRestantes = (expiresAt) => new Date(expiresAt).getTime() - Date.now()
const esVigente = (c) => Boolean(c) && msRestantes(c.expiresAt) > 0
const tocaRenovar = (c) => !c || msRestantes(c.expiresAt) < DIAS_RENOVACION * MS_DIA

/** ¿Falló el último intento hace menos de una hora? Entonces no se vuelve a molestar a la CA. */
function enCuota(fila) {
  if (!fila?.last_error || !fila.last_attempt_at) return false
  return Date.now() - new Date(fila.last_attempt_at).getTime() < CUOTA_TRAS_ERROR_MS
}

// ---------------------------------------------------------------------------
// Lock entre instancias (SET NX PX). Se libera solo si sigue siendo nuestro: si la emisión tardó
// más que el TTL y otra instancia ya tiene el lock, no se le puede borrar el suyo.
// ---------------------------------------------------------------------------
const LUA_LIBERAR = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`

async function adquirirLock(hostname) {
  const token = randomBytes(16).toString('hex')
  const res = await redis.set(PREFIJO_LOCK + hostname, token, 'PX', LOCK_TTL_MS, 'NX')
  return res === 'OK' ? token : null
}

async function liberarLock(hostname, token) {
  try {
    await redis.eval(LUA_LIBERAR, 1, PREFIJO_LOCK + hostname, token)
  } catch {
    // el lock caduca solo a los 5 min; no hay nada más que hacer
  }
}

// ---------------------------------------------------------------------------
// Emisión con acme-client
// ---------------------------------------------------------------------------

// Carga perezosa: importar este módulo no arrastra acme-client, y si la dependencia faltara o
// estuviera rota, el fallo queda dentro de asegurarCertificado (que nunca lanza).
let acmePromesa = null
function cargarAcme() {
  acmePromesa ??= import('acme-client')
    .then((m) => m.default ?? m)
    .catch((err) => {
      acmePromesa = null
      throw new Error(`no se pudo cargar acme-client: ${err.message}`)
    })
  return acmePromesa
}

function etiquetaDirectorio() {
  const url = config.relay.acmeDirectory
  if (/acme-staging-v02\.api\.letsencrypt\.org/.test(url)) return 'letsencrypt-staging'
  if (/acme-v02\.api\.letsencrypt\.org/.test(url)) return 'letsencrypt-produccion'
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function conTiempoMaximo(promesa, ms, mensaje) {
  let temporizador
  const plazo = new Promise((_, reject) => {
    temporizador = setTimeout(() => reject(new Error(mensaje)), ms)
    temporizador.unref?.()
  })
  // si gana el plazo, el rechazo tardío de la promesa original no puede quedar sin manejar
  promesa.catch(() => {})
  return Promise.race([promesa, plazo]).finally(() => clearTimeout(temporizador))
}

/** Error de la autocomprobación que sí debe abortar la emisión (antes de pedir la validación a la CA). */
class RetoInterceptado extends Error {}

/**
 * Autocomprobación del reto: se pide la URL pública igual que hará la CA.
 *
 * Casi siempre es solo informativa: si no se ve, se avisa con el motivo (DNS, redirección rota…)
 * pero NO se aborta, porque la validación de verdad la hace la CA y desde dentro del contenedor la
 * vuelta por la IP pública puede fallar (timeouts, DNS interno) por motivos que a la CA no le
 * afectan.
 *
 * La excepción es la firma del manejador ACME de Traefik: 404 con cuerpo vacío y sin Content-Type.
 * Nuestra ruta (src/routes/acme.js) responde siempre con texto y Content-Type, así que un 404
 * desnudo solo puede venir de un proxy que captura /.well-known/acme-challenge/ antes que la app,
 * y la CA verá exactamente lo mismo. Entonces se aborta lanzando RetoInterceptado: cada validación
 * fallida gasta cuota de Let's Encrypt y el motivo real es más útil que el genérico de la CA.
 */
async function autocomprobarReto(hostname, token, keyAuthorization, log) {
  let resp
  let cuerpo
  try {
    resp = await fetch(`http://${hostname}/.well-known/acme-challenge/${token}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(AUTOCOMPROBACION_TIMEOUT_MS),
      headers: { 'user-agent': 'emails-disruptivo/acme-autocomprobacion' },
    })
    cuerpo = (await resp.text()).trim()
  } catch (err) {
    log.warn({ hostname, motivo: limpiarError(err) }, 'acme: no se pudo autocomprobar el reto HTTP-01; se pide la validación igualmente')
    return
  }

  if (resp.ok && cuerpo === keyAuthorization) {
    log.info({ hostname }, 'acme: el reto HTTP-01 se sirve correctamente desde fuera')
    return
  }

  const sinContentType = !texto(resp.headers.get('content-type'))
  if (resp.status === 404 && !cuerpo && sinContentType) {
    throw new RetoInterceptado(
      `el reto HTTP-01 no llega a la app: el puerto 80 de ${hostname} lo atiende el ACME del propio Traefik ` +
        '(responde 404 vacío en /.well-known/acme-challenge/ para todos los hosts, antes de enrutar a la app). ' +
        'Usa el modo traefik (SMTP_RELAY_TRAEFIK_ACME, DEPLOY.md §D) o un certificado en ficheros'
    )
  }

  log.warn(
    { hostname, status: resp.status },
    'acme: el reto HTTP-01 no se ve desde fuera como se espera (¿el host enruta HTTP a esta app?); se pide la validación igualmente'
  )
}

/**
 * Comprobación previa del directorio ACME. acme-client, si la CA no responde, reintenta durante
 * minutos y acaba lanzando un error sin información; aquí se falla en 10 s y con el motivo real
 * (DNS, conexión rechazada, proxy…), que es lo que luego se lee en Ajustes.
 */
async function comprobarDirectorio() {
  const url = config.relay.acmeDirectory
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(10_000),
      headers: { 'user-agent': 'emails-disruptivo/acme', accept: 'application/json' },
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const dir = await resp.json()
    if (!dir || typeof dir.newOrder !== 'string') throw new Error('la respuesta no es un directorio ACME')
  } catch (err) {
    const motivo = err?.cause?.code || err?.cause?.message || err?.message || 'sin respuesta'
    throw new Error(`no se pudo leer el directorio ACME (${etiquetaDirectorio()}): ${motivo}`)
  }
}

async function emitir(hostname, fila, log) {
  await comprobarDirectorio()
  const acme = await cargarAcme()

  const claveGuardada = Boolean(fila?.account_key_enc)
  let accountKey = descifrarPem(fila?.account_key_enc)
  if (!accountKey) {
    accountKey = (await acme.crypto.createPrivateEcdsaKey('P-256')).toString()
    // si había una clave y no se pudo descifrar, se reemplaza: conservarla obligaría a crear una
    // cuenta nueva en la CA en cada emisión (límite de 10 cuentas nuevas por IP cada 3 h)
    await guardarClaveCuenta(hostname, cifrarPem(accountKey), { reemplazar: claveGuardada })
    log.info(
      { hostname, reemplazada: claveGuardada || undefined },
      claveGuardada
        ? 'acme: la clave de cuenta ACME guardada no se pudo descifrar (¿ENCRYPTION_KEY rotada?); se sustituye por una nueva'
        : 'acme: clave de cuenta ACME nueva guardada'
    )
  }

  const client = new acme.Client({
    directoryUrl: config.relay.acmeDirectory,
    accountKey,
    backoffAttempts: 8,
    backoffMin: 3_000,
    backoffMax: 20_000,
  })

  // RSA 2048 para el certificado: es lo que entiende cualquier cliente SMTP, por viejo que sea
  const [certKey, csr] = await acme.crypto.createCsr({ commonName: hostname })

  const certPem = await conTiempoMaximo(
    client.auto({
      csr,
      email: config.relay.acmeEmail || undefined,
      termsOfServiceAgreed: true,
      challengePriority: ['http-01'],
      // la autocomprobación propia decide sola qué abortar; la de acme-client aborta (con 10
      // reintentos de hasta 30 s) si la vuelta por la IP pública falla desde el contenedor, y eso
      // no dice nada de lo que verá la CA
      skipChallengeVerification: true,
      async challengeCreateFn(authz, challenge, keyAuthorization) {
        if (challenge.type !== 'http-01') {
          throw new Error(`la CA solo ofrece retos ${challenge.type} y aquí solo se resuelve HTTP-01`)
        }
        await redis.set(PREFIJO_RETO + challenge.token, keyAuthorization, 'EX', RETO_TTL_S)
        // Si lanza (reto interceptado por Traefik), acme-client no llega a completeChallenge:
        // desactiva la autorización y propaga el error. Ninguna validación fallida cuenta en la CA.
        await autocomprobarReto(hostname, challenge.token, keyAuthorization, log)
      },
      async challengeRemoveFn(authz, challenge) {
        await redis.del(PREFIJO_RETO + challenge.token)
      },
    }),
    TIEMPO_MAXIMO_EMISION_MS,
    'la CA no completó la emisión en 4 minutos'
  )

  const info = acme.crypto.readCertificateInfo(certPem)
  const dominios = [info.domains?.commonName, ...(info.domains?.altNames || [])]
    .filter(Boolean)
    .map((d) => String(d).toLowerCase())
  if (!dominios.includes(hostname)) {
    throw new Error(`el certificado recibido no cubre ${hostname} (cubre: ${dominios.join(', ') || 'nada'})`)
  }

  const expiresAt = new Date(info.notAfter)
  const issuedAt = new Date(info.notBefore)
  const key = certKey.toString()
  const cert = String(certPem)

  await guardarCertificado(hostname, { privateKeyEnc: cifrarPem(key), certPem: cert, issuedAt, expiresAt })
  return { key, cert, expiresAt }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

// Devuelve el certificado guardado (si lo hay) anotando por qué no se ha emitido uno nuevo.
function devolverGuardado(hostname, vigente, motivo) {
  if (motivo) motivos.set(hostname, motivo)
  else motivos.delete(hostname)
  if (!vigente) return null
  huellas.set(hostname, huella(vigente.cert))
  return { key: vigente.key, cert: vigente.cert, expiresAt: vigente.expiresAt, origen: 'guardado' }
}

/**
 * Motivo por el que la última llamada a asegurarCertificado(host) no emitió: 'host' | 'cuota' |
 * 'lock' | 'error' | 'fallo', o null si emitió, renovó o no hacía falta. Sirve para que la
 * renovación periódica reintente pronto tras un lock (caduca en 5 min) y para que el botón del
 * admin explique la situación real.
 */
export function motivoSinCertificado(hostname) {
  return motivos.get(normalizarHost(hostname || config.relay.host)) ?? null
}

/**
 * Devuelve un certificado válido para el host del relay, emitiéndolo o renovándolo si hace falta.
 *
 * @param {string} [hostname] por defecto config.relay.host
 * @param {object} [opciones]
 * @param {object} [opciones.log] logger (pino/Fastify o console)
 * @param {boolean} [opciones.forzar] renueva aunque queden más de 30 días (botón del admin);
 *   respeta igualmente el lock y la cuota de un intento por hora tras error
 * @returns {Promise<{ key: string, cert: string, expiresAt: Date, origen: 'guardado'|'emitido'|'renovado' }|null>}
 *   null = no hay certificado utilizable (el relay sigue con autofirmado). NUNCA lanza.
 */
export async function asegurarCertificado(hostname, opciones = {}) {
  const log = registrador(opciones.log)
  const forzar = Boolean(opciones.forzar)

  const comprobacion = comprobarHostname(hostname || config.relay.host)
  if (!comprobacion.ok) {
    log.warn({ hostname: comprobacion.hostname || null }, `acme: no se pide certificado: ${comprobacion.motivo}`)
    if (comprobacion.hostname) motivos.set(comprobacion.hostname, 'host')
    return null
  }
  const host = comprobacion.hostname

  let vigente = null
  try {
    let fila = await leerFila(host)
    let actual = certificadoDeFila(fila)
    vigente = esVigente(actual) ? actual : null

    if (vigente && !forzar && !tocaRenovar(vigente)) return devolverGuardado(host, vigente)

    if (enCuota(fila)) {
      log.warn(
        { hostname: host, ultimo_intento: fila.last_attempt_at, motivo: fila.last_error },
        'acme: el último intento falló hace menos de una hora; no se reintenta todavía para no agotar la cuota de la CA'
      )
      return devolverGuardado(host, vigente, 'cuota')
    }

    const token = await adquirirLock(host)
    if (!token) {
      log.info(
        { hostname: host },
        'acme: otra instancia tiene el lock de emisión (o quedó uno huérfano de un redespliegue; caduca en 5 min); se usa el guardado y se reintenta en breve'
      )
      return devolverGuardado(host, vigente, 'lock')
    }

    try {
      // con el lock en la mano se relee: otra instancia puede haber terminado justo antes
      fila = await leerFila(host)
      actual = certificadoDeFila(fila)
      vigente = esVigente(actual) ? actual : null
      if (vigente && !forzar && !tocaRenovar(vigente)) return devolverGuardado(host, vigente)
      if (enCuota(fila)) return devolverGuardado(host, vigente, 'cuota')

      log.info(
        { hostname: host, directorio: etiquetaDirectorio(), forzado: forzar || undefined },
        vigente ? 'acme: renovando el certificado' : 'acme: emitiendo el certificado'
      )

      try {
        const nuevo = await emitir(host, fila, log)
        huellas.set(host, huella(nuevo.cert))
        motivos.delete(host)
        log.info(
          { hostname: host, valido_hasta: nuevo.expiresAt.toISOString() },
          vigente ? 'acme: certificado renovado' : 'acme: certificado emitido'
        )
        return { ...nuevo, origen: vigente ? 'renovado' : 'emitido' }
      } catch (err) {
        const motivo = limpiarError(err)
        if (err instanceof RetoInterceptado) {
          log.error({ hostname: host, motivo }, 'acme: emisión abortada antes de pedir la validación: el reto HTTP-01 no llega a la app')
        } else {
          log.error({ hostname: host, motivo }, 'acme: no se pudo emitir el certificado')
        }
        await registrarFallo(host, motivo).catch((e) =>
          log.error({ hostname: host, motivo: limpiarError(e) }, 'acme: tampoco se pudo anotar el fallo en tls_certificates')
        )
        return devolverGuardado(host, vigente, 'error')
      }
    } finally {
      await liberarLock(host, token)
    }
  } catch (err) {
    // Postgres o Redis caídos, clave de cifrado inválida…: se registra y el relay sigue con lo que tenga
    log.error({ hostname: host, motivo: limpiarError(err) }, 'acme: fallo inesperado comprobando el certificado')
    return devolverGuardado(host, vigente, 'fallo')
  }
}

/**
 * Estado del certificado para el panel de admin y el de subcuenta.
 * @param {string} [hostname] por defecto config.relay.host
 */
export async function estadoCertificado(hostname) {
  const host = normalizarHost(hostname || config.relay.host)
  const fila = host ? await leerFila(host) : null
  const expiresAt = fila?.expires_at ? new Date(fila.expires_at) : null
  const valido = Boolean(fila?.certificate_pem && fila?.private_key_enc && expiresAt && expiresAt.getTime() > Date.now())

  // ¿hay una emisión en curso (lock vivo)? Sirve al panel para enseñar «en emisión, espera un minuto».
  let emitiendo = false
  if (host) {
    try {
      emitiendo = (await redis.exists(PREFIJO_LOCK + host)) === 1
    } catch {
      emitiendo = false
    }
  }

  return {
    hostname: host || null,
    valido,
    issued_at: fila?.issued_at ?? null,
    expires_at: expiresAt,
    last_error: fila?.last_error ?? null,
    last_attempt_at: fila?.last_attempt_at ?? null,
    dias_restantes: expiresAt ? Math.max(0, Math.floor(msRestantes(expiresAt) / MS_DIA)) : null,
    emitiendo,
  }
}

// ---------------------------------------------------------------------------
// Renovación periódica
// ---------------------------------------------------------------------------
let temporizador = null
let comprobando = false
let generacion = 0

// Cuándo volver a mirar cuando no hay certificado: en cuanto caduque el lock si fue por el lock;
// si no, dentro de una hora (la cuota de 1/h manda igualmente).
const esperaSinCertificado = (host) =>
  motivos.get(host) === 'lock' ? REINTENTO_TRAS_LOCK_MS : INTERVALO_SIN_CERTIFICADO_MS

/**
 * Comprueba cada 12 h si toca renovar (< 30 días) y, cuando hay certificado nuevo —lo haya
 * renovado esta instancia u otra—, llama a alRenovar({ key, cert, expiresAt, origen }).
 * Mientras no haya certificado válido se comprueba cada hora (la cuota de 1/h manda igualmente),
 * salvo que el motivo sea el lock de otra instancia: entonces en cuanto el lock haya caducado.
 */
export function programarRenovacion({ log, alRenovar } = {}) {
  detenerRenovacion()
  const registro = registrador(log)
  const miGeneracion = ++generacion
  const hostConfigurado = normalizarHost(config.relay.host)

  const planificar = (ms) => {
    if (miGeneracion !== generacion) return
    temporizador = setTimeout(comprobar, ms)
    temporizador.unref?.()
  }

  async function comprobar() {
    if (temporizador) {
      clearTimeout(temporizador)
      temporizador = null
    }
    if (comprobando) return planificar(INTERVALO_SIN_CERTIFICADO_MS)
    comprobando = true
    let resultado = null
    try {
      const antes = huellas.get(hostConfigurado) ?? null
      resultado = await asegurarCertificado(hostConfigurado, { log: registro })
      if (resultado && huella(resultado.cert) !== antes && typeof alRenovar === 'function') {
        await alRenovar({ key: resultado.key, cert: resultado.cert, expiresAt: resultado.expiresAt, origen: resultado.origen })
        registro.info(
          { hostname: hostConfigurado, valido_hasta: resultado.expiresAt.toISOString(), origen: resultado.origen },
          'acme: certificado nuevo aplicado al relay'
        )
      }
    } catch (err) {
      registro.error({ motivo: limpiarError(err) }, 'acme: fallo en la comprobación periódica del certificado')
    } finally {
      comprobando = false
      planificar(resultado ? INTERVALO_RENOVACION_MS : esperaSinCertificado(hostConfigurado))
    }
  }

  // sin certificado conocido (la emisión del arranque falló, está en cuota o el lock era de otro)
  // se vuelve antes
  const hayCertificado = huellas.has(hostConfigurado)
  planificar(hayCertificado ? INTERVALO_RENOVACION_MS : esperaSinCertificado(hostConfigurado))
  return { detener: detenerRenovacion, comprobarAhora: comprobar }
}

/** Para la comprobación periódica (cierre ordenado). Idempotente. */
export function detenerRenovacion() {
  generacion++
  if (temporizador) {
    clearTimeout(temporizador)
    temporizador = null
  }
}

export default {
  asegurarCertificado,
  estadoCertificado,
  motivoSinCertificado,
  programarRenovacion,
  detenerRenovacion,
  comprobarHostname,
}
