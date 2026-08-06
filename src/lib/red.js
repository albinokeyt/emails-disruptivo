import { promises as dns } from 'node:dns'

// ---------------------------------------------------------------------------
// Destinos de red admisibles para una conexión saliente (el SMTP que registra un cliente).
//
// Vive en lib/ y no dentro de una ruta porque lo necesitan DOS sitios que no pueden importarse entre
// sí: el botón «Probar conexión» del panel (src/routes/location.js) y el worker de envío
// (src/lib/queue.js), que es quien abre la conexión de verdad.
//
// Validar solo el texto del host no basta: un nombre de dominio perfectamente público puede resolver
// a 127.0.0.1, a 169.254.169.254 o a 10.x en el momento del envío (rebinding, o un simple cambio del
// registro A posterior al alta). Sin esta comprobación antes de conectar, el worker se convierte en
// un sondeador de la red interna del contenedor a petición del cliente.
// ---------------------------------------------------------------------------

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

/** Nombre de host con forma válida (etiquetas DNS y al menos un punto). */
export const RE_HOST = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i

// Rangos que jamás son un servidor SMTP legítimo del cliente: son la red interna del servidor.
const RE_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
const RESERVADAS_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.0\.0\./, /^198\.1[89]\./, /^22[4-9]\./, /^2[3-5]\d\./,
]
const SUFIJOS_INTERNOS = /\.(local|internal|localdomain|home|lan|intranet)$/i

/** ¿Esta IP (v4 o v6, ya resuelta) pertenece a la red interna? */
export function esIpInterna(ip) {
  const s = texto(ip).toLowerCase().replace(/^::ffff:/, '')
  if (!s) return true
  if (RE_IPV4.test(s)) return RESERVADAS_V4.some((re) => re.test(s))
  // IPv6: loopback, enlace local y direcciones únicas locales (fc00::/7)
  return s === '::' || s === '::1' || /^fe[89ab]/.test(s) || /^f[cd]/.test(s)
}

/** Host admisible como servidor de correo ajeno: ni IP literal, ni nombre interno. */
export function hostPublico(host) {
  const h = texto(host).toLowerCase()
  if (!h || !RE_HOST.test(h)) return false
  if (RE_IPV4.test(h) || h.includes(':')) return false
  return !SUFIJOS_INTERNOS.test(h)
}

/**
 * Comprobación previa a abrir una conexión saliente: resuelve el DNS y descarta los destinos de
 * red interna.
 *
 * Si el DNS no resuelve se devuelve `true` a propósito: no hay evidencia de destino interno y es
 * preferible que falle el intento de conexión con su propio mensaje de error, que es el que el
 * cliente entiende, a bloquear un servidor legítimo por una incidencia pasajera del resolutor.
 */
export async function destinoPermitido(host) {
  if (!hostPublico(host)) return false
  try {
    const direcciones = await dns.lookup(texto(host).toLowerCase(), { all: true, verbatim: true })
    if (!direcciones.length) return false
    return !direcciones.some((d) => esIpInterna(d.address))
  } catch {
    return true
  }
}
