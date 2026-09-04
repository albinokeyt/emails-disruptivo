import { X509Certificate, createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createSecureContext } from 'node:tls'
import { config } from '../config.js'

// ---------------------------------------------------------------------------
// Modo «traefik» del certificado del relay (SPEC §13.1).
//
// En EasyPanel el puerto 80 lo atiende Traefik, y el manejador ACME del propio Traefik captura
// /.well-known/acme-challenge/ para TODOS los hosts (responde 404 vacío) antes de enrutar nada:
// el reto HTTP-01 de esta app nunca le llega. Pero Traefik ya tiene —y renueva solo— el
// certificado Let's Encrypt del host de la app, guardado en su acme.json. Con ese fichero montado
// en el contenedor (SMTP_RELAY_TRAEFIK_ACME=/certs/acme.json, solo lectura), aquí se lee el
// certificado del host del relay y src/index.js lo aplica en caliente a las escuchas SMTP: cero
// llamadas a la CA y renovación gratis cada vez que Traefik renueva el suyo.
//
// Formato de acme.json (Traefik v2/v3), un objeto por resolver:
//   { "<resolver>": { "Account": { "PrivateKey": … }, "Certificates": [
//       { "domain": { "main": "host", "sans": [ … ] }, "certificate": "<PEM en base64>", "key": "<PEM en base64>" }
//   ] } }
// Se admite también la forma de Traefik v1 (Certificates en la raíz, claves en mayúscula).
//
// El fichero contiene además la clave privada de la cuenta ACME de Traefik y las claves de todos
// sus certificados: NUNCA se registra su contenido, solo mensajes.
// ---------------------------------------------------------------------------

const INTERVALO_OK_MS = 12 * 3_600_000 // Traefik renueva 30 días antes de caducar: sobra margen
const INTERVALO_ERROR_MS = 5 * 60_000 // sin certificado utilizable se vuelve a mirar en 5 min
const ESPERA_CAMBIO_MS = 3_000 // Traefik escribe el fichero varias veces seguidas al renovar
const MAX_ERROR = 600

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
const normalizarHost = (h) => texto(h).toLowerCase().replace(/\.+$/, '')
const huella = (pem) => createHash('sha256').update(String(pem)).digest('hex')

// Solo el mensaje y sin material sensible: un error de OpenSSL o de JSON.parse puede arrastrar
// trozos del fichero.
function limpiarError(err) {
  let m = String(err?.message || err || 'error desconocido')
  m = m.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[pem]')
  m = m.replace(/\s+/g, ' ').trim()
  return m.slice(0, MAX_ERROR)
}

function registrador(base) {
  const nada = () => {}
  const l = base && typeof base === 'object' ? base : console
  const metodo = (nombre, alternativa) => (typeof l[nombre] === 'function' ? l[nombre].bind(l) : alternativa)
  const info = metodo('info', metodo('log', nada))
  return { info, warn: metodo('warn', info), error: metodo('error', info) }
}

// ---------------------------------------------------------------------------
// Lectura del fichero
// ---------------------------------------------------------------------------

/** ¿`patron` (un nombre o un comodín *.dominio) cubre `hostname`? */
function cubre(patron, hostname) {
  const p = normalizarHost(patron)
  if (!p) return false
  if (p === hostname) return true
  if (p.startsWith('*.')) {
    const sufijo = p.slice(1) // ".dominio.com"
    if (!hostname.endsWith(sufijo)) return false
    // un comodín cubre exactamente una etiqueta
    return !hostname.slice(0, -sufijo.length).includes('.')
  }
  return false
}

/** Traefik guarda los PEM en base64 (JSON de un []byte de Go); por si acaso se admite el PEM directo. */
function decodificarPem(valor) {
  const s = valor === undefined || valor === null ? '' : String(valor)
  if (!s.trim()) return ''
  if (s.includes('-----BEGIN')) return s
  const pem = Buffer.from(s.trim(), 'base64').toString('utf8')
  return pem.includes('-----BEGIN') ? pem : ''
}

/** Lista {resolver, main, sans, cert, key} con todos los certificados del fichero, sea v1 o v2/v3. */
function extraerEntradas(json) {
  const entradas = []
  const anadir = (resolver, lista) => {
    if (!Array.isArray(lista)) return
    for (const c of lista) {
      if (!c || typeof c !== 'object') continue
      const dominio = c.domain ?? c.Domain ?? {}
      entradas.push({
        resolver,
        main: normalizarHost(dominio.main ?? dominio.Main),
        sans: (Array.isArray(dominio.sans ?? dominio.SANs) ? dominio.sans ?? dominio.SANs : []).map(normalizarHost),
        cert: decodificarPem(c.certificate ?? c.Certificate),
        key: decodificarPem(c.key ?? c.Key),
      })
    }
  }
  if (!json || typeof json !== 'object') return entradas
  // v1: Certificates en la raíz
  anadir('(raíz)', json.Certificates ?? json.certificates)
  // v2/v3: un objeto por resolver
  for (const [resolver, valor] of Object.entries(json)) {
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) anadir(resolver, valor.Certificates ?? valor.certificates)
  }
  return entradas
}

function fechaCaducidad(certPem) {
  const x509 = new X509Certificate(certPem)
  const hasta = x509.validToDate instanceof Date ? x509.validToDate : new Date(x509.validTo)
  return Number.isNaN(hasta.getTime()) ? null : hasta
}

/**
 * Lee el certificado del host del relay del acme.json de Traefik.
 *
 * @param {string} [ruta] por defecto config.relay.traefikAcme
 * @param {string} [hostname] por defecto config.relay.host
 * @returns {Promise<{ key: string, cert: string, expiresAt: Date, resolver: string, origen: 'traefik' }>}
 * @throws {Error} con un mensaje apto para el panel (sin material sensible) si no hay fichero, no se
 *   puede leer o parsear, no contiene el host, o el certificado está roto o caducado.
 */
export async function leerCertificadoTraefik(ruta = config.relay.traefikAcme, hostname = config.relay.host) {
  const fichero = texto(ruta)
  const host = normalizarHost(hostname)
  if (!fichero) throw new Error('SMTP_RELAY_TRAEFIK_ACME no está definido')
  if (!host) throw new Error('no hay host del relay (SMTP_RELAY_HOST o el dominio de APP_BASE_URL)')

  let crudo
  try {
    crudo = await readFile(fichero, 'utf8')
  } catch (err) {
    const codigo = err?.code || ''
    if (codigo === 'ENOENT' || codigo === 'ENOTDIR') {
      throw new Error(`no existe ${fichero} dentro del contenedor: revisa el Mount de EasyPanel (DEPLOY.md §D)`)
    }
    if (codigo === 'EACCES' || codigo === 'EPERM') {
      throw new Error(`sin permiso para leer ${fichero}: el acme.json de Traefik es 0600 de root y el contenedor no lo puede abrir`)
    }
    throw new Error(`no se pudo leer ${fichero}: ${codigo || limpiarError(err)}`)
  }

  let json
  try {
    json = JSON.parse(crudo)
  } catch {
    throw new Error(`${fichero} no es un JSON válido (¿es de verdad el acme.json de Traefik?)`)
  }
  crudo = null

  const entradas = extraerEntradas(json)
  if (!entradas.length) {
    throw new Error(`${fichero} no contiene ningún certificado todavía: Traefik aún no ha emitido ninguno`)
  }

  let mejor = null
  let ultimoFallo = null
  for (const e of entradas) {
    if (!(cubre(e.main, host) || e.sans.some((s) => cubre(s, host)))) continue
    if (!e.cert || !e.key) {
      ultimoFallo = `la entrada de ${e.main || host} no trae certificado y clave en PEM`
      continue
    }
    try {
      createSecureContext({ key: e.key, cert: e.cert })
      const hasta = fechaCaducidad(e.cert)
      if (!hasta) {
        ultimoFallo = `el certificado de ${e.main || host} no tiene fecha de caducidad legible`
        continue
      }
      // con varias entradas para el mismo host (renovación reciente) se queda la que más dura
      if (!mejor || hasta.getTime() > mejor.expiresAt.getTime()) {
        mejor = { key: e.key, cert: e.cert, expiresAt: hasta, resolver: e.resolver, origen: 'traefik' }
      }
    } catch (err) {
      ultimoFallo = `el certificado de ${e.main || host} no es válido: ${limpiarError(err)}`
    }
  }

  if (!mejor) {
    if (ultimoFallo) throw new Error(ultimoFallo)
    const hosts = [...new Set(entradas.map((e) => e.main).filter(Boolean))]
    throw new Error(
      `Traefik no tiene certificado para ${host} (tiene: ${hosts.slice(0, 8).join(', ') || 'ninguno'}${hosts.length > 8 ? '…' : ''}): ` +
        'da de alta ese host en Domains de EasyPanel con HTTPS y espera a que Traefik lo emita'
    )
  }
  if (mejor.expiresAt.getTime() <= Date.now()) {
    throw new Error(`el certificado de Traefik para ${host} caducó el ${mejor.expiresAt.toISOString()} y Traefik no lo ha renovado`)
  }
  return mejor
}

// ---------------------------------------------------------------------------
// Vigilancia: lectura al arrancar, relectura cuando el fichero cambia y comprobación periódica
// ---------------------------------------------------------------------------
const estado = {
  ultima_lectura: null,
  ultimo_error: null,
  valido_hasta: null,
  resolver: null,
}
let huellaAplicada = null
let temporizador = null
let vigilante = null
let esperaCambio = null
let comprobando = false
let generacion = 0

/**
 * Estado del modo traefik para los paneles (admin y subcuenta).
 * @returns {{ configurado: boolean, ruta: string|null, hostname: string|null, ultima_lectura: string|null,
 *   ultimo_error: string|null, valido_hasta: string|null, resolver: string|null }}
 */
export function estadoTraefik() {
  return {
    configurado: Boolean(config.relay.traefikAcme),
    ruta: config.relay.traefikAcme,
    hostname: normalizarHost(config.relay.host) || null,
    ultima_lectura: estado.ultima_lectura,
    ultimo_error: estado.ultimo_error,
    valido_hasta: estado.valido_hasta,
    resolver: estado.resolver,
  }
}

/**
 * Lee el acme.json ahora mismo y, si el certificado ha cambiado respecto al último aplicado, llama
 * a alCambiar({ key, cert, expiresAt, origen: 'traefik' }). Devuelve el certificado leído o null
 * (con el motivo en estadoTraefik().ultimo_error). Nunca lanza.
 */
export async function comprobarCertificadoTraefik({ log, alCambiar, forzar = false } = {}) {
  const registro = registrador(log)
  const host = normalizarHost(config.relay.host)
  try {
    const leido = await leerCertificadoTraefik(config.relay.traefikAcme, host)
    estado.ultima_lectura = new Date().toISOString()
    estado.ultimo_error = null
    estado.valido_hasta = leido.expiresAt.toISOString()
    estado.resolver = leido.resolver
    const h = huella(leido.cert)
    if ((forzar || h !== huellaAplicada) && typeof alCambiar === 'function') {
      const resultado = await alCambiar(leido)
      // si quien aplica dice explícitamente que no pudo, se vuelve a intentar en la siguiente vuelta
      if (!resultado || resultado.aplicado !== false) huellaAplicada = h
    }
    return leido
  } catch (err) {
    estado.ultima_lectura = new Date().toISOString()
    estado.ultimo_error = limpiarError(err)
    registro.warn({ hostname: host, ruta: config.relay.traefikAcme, motivo: estado.ultimo_error }, 'traefik: sin certificado utilizable en el acme.json')
    return null
  }
}

/**
 * Arranca la vigilancia del acme.json: lectura inmediata, relectura (con espera de 3 s) cuando el
 * fichero cambia y comprobación cada 12 h (cada 5 min mientras no haya certificado utilizable).
 * Idempotente: una nueva llamada sustituye a la anterior.
 *
 * @returns {{ detener: () => void, comprobarAhora: () => Promise<object|null> }}
 */
export function vigilarCertificadoTraefik({ log, alCambiar } = {}) {
  detenerVigilanciaTraefik()
  const registro = registrador(log)
  const miGeneracion = ++generacion
  const ruta = texto(config.relay.traefikAcme)

  const planificar = (ms) => {
    if (miGeneracion !== generacion) return
    if (temporizador) clearTimeout(temporizador)
    temporizador = setTimeout(comprobar, ms)
    temporizador.unref?.()
  }

  async function comprobar() {
    if (temporizador) {
      clearTimeout(temporizador)
      temporizador = null
    }
    if (comprobando) return planificar(INTERVALO_ERROR_MS)
    comprobando = true
    let leido = null
    try {
      leido = await comprobarCertificadoTraefik({ log: registro, alCambiar })
    } finally {
      comprobando = false
      planificar(leido ? INTERVALO_OK_MS : INTERVALO_ERROR_MS)
    }
    return leido
  }

  // Se vigila el DIRECTORIO y se filtra por nombre: si Traefik (o el mount) sustituyen el fichero
  // en vez de reescribirlo, un vigilante sobre el fichero se quedaría mirando el inodo viejo.
  // fs.watch puede no estar disponible según el sistema de ficheros del mount: entonces manda la
  // comprobación periódica.
  if (ruta) {
    try {
      const nombre = path.basename(ruta)
      vigilante = watch(path.dirname(ruta), { persistent: false }, (_evento, fichero) => {
        if (fichero && String(fichero) !== nombre) return
        if (esperaCambio) clearTimeout(esperaCambio)
        esperaCambio = setTimeout(() => {
          esperaCambio = null
          if (miGeneracion !== generacion) return
          registro.info({ ruta }, 'traefik: el acme.json ha cambiado; se relee el certificado')
          comprobar().catch(() => {})
        }, ESPERA_CAMBIO_MS)
        esperaCambio.unref?.()
      })
      vigilante.on('error', (err) => {
        registro.warn({ ruta, motivo: limpiarError(err) }, 'traefik: no se puede vigilar el acme.json; se seguirá comprobando cada 12 h')
        vigilante = null
      })
    } catch (err) {
      registro.warn({ ruta, motivo: limpiarError(err) }, 'traefik: no se puede vigilar el acme.json; se seguirá comprobando cada 12 h')
      vigilante = null
    }
  }

  comprobar().catch(() => {})
  return { detener: detenerVigilanciaTraefik, comprobarAhora: comprobar }
}

/** Para la vigilancia (cierre ordenado). Idempotente. */
export function detenerVigilanciaTraefik() {
  generacion++
  if (temporizador) {
    clearTimeout(temporizador)
    temporizador = null
  }
  if (esperaCambio) {
    clearTimeout(esperaCambio)
    esperaCambio = null
  }
  if (vigilante) {
    try {
      vigilante.close()
    } catch {
      // ya cerrado
    }
    vigilante = null
  }
}

export default {
  leerCertificadoTraefik,
  comprobarCertificadoTraefik,
  vigilarCertificadoTraefik,
  detenerVigilanciaTraefik,
  estadoTraefik,
}
