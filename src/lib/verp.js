// ---------------------------------------------------------------------------
// VERP y parseo de rebotes (SPEC §11.2).
//
// Con SMTP genérico el proveedor no avisa de nada: la única vía independiente de él es capturar los
// rebotes uno mismo. Para eso el sobre de cada envío sale con un Return-Path propio y ÚNICO por
// mensaje (VERP): b.<correlation_id>@<SMTP_BOUNCE_DOMAIN>. El servidor que rebota devuelve el aviso
// a ESA dirección, así que el rebote se atribuye por la dirección a la que llega, sin adivinar nada
// del texto libre del aviso.
//
// Este módulo no toca la base de datos ni la red: construye y parsea la dirección VERP y desmenuza
// el DSN (RFC 3464) que llega de vuelta. Quién lo usa:
//   · src/lib/providers/smtp.js  → construirDireccionVerp() al enviar
//   · src/smtp-relay/index.js    → capturaRebotesActiva() para decidir authOptional
//   · src/smtp-relay/handler.js  → parsearDireccionVerp() en el RCPT y parsearDsn() en el DATA
// ---------------------------------------------------------------------------

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

// El correlation_id que viaja en la parte local de la dirección. Los ids reales de la app son
// `n-<hex32>` (nodos), `r-<hex32>` (relay) o similares: minúsculas, dígitos, guion y guion bajo.
// Se valida en los DOS sentidos (construcción y parseo) con el mismo patrón: un id que no case aquí
// no genera VERP al enviar, y una dirección que no case aquí se rechaza al recibir. El tope de 60
// caracteres deja la parte local (b. + id) por debajo de los 64 octetos que recomienda RFC 5321.
const RE_CORRELACION = /^[a-z0-9][a-z0-9_-]{0,59}$/

// Prefijo fijo: distingue el tráfico VERP de cualquier otro correo al subdominio de rebotes.
const PREFIJO = 'b.'

/** Dominio de rebotes configurado (SMTP_BOUNCE_DOMAIN), en minúsculas y sin punto final. Vacío si no hay. */
export const dominioRebotes = () =>
  texto(process.env.SMTP_BOUNCE_DOMAIN).toLowerCase().replace(/\.+$/, '')

/** ¿Está activa la captura de rebotes? Es la variable la que enciende o apaga toda la pieza. */
export const capturaRebotesActiva = () => dominioRebotes().length > 0

/** Acepta «ana@x.com» y «Ana Ruiz <ana@x.com>» y devuelve la dirección en minúsculas. */
function soloDireccion(valor) {
  const bruto = texto(valor)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim().toLowerCase()
}

/**
 * Dirección VERP de un mensaje: b.<correlation_id>@<SMTP_BOUNCE_DOMAIN>.
 * Devuelve null si la captura está apagada o el correlation_id no es apto para una parte local
 * (en ese caso el envío sale con el sobre de siempre: la pieza degrada, no rompe).
 */
export function construirDireccionVerp(correlationId) {
  const dominio = dominioRebotes()
  const id = texto(correlationId)
  if (!dominio || !RE_CORRELACION.test(id)) return null
  return `${PREFIJO}${id}@${dominio}`
}

/**
 * Extrae el correlation_id de una dirección VERP propia. Devuelve null si la dirección no es
 * exactamente b.<id>@<SMTP_BOUNCE_DOMAIN>: es la comprobación con la que la pasarela decide si un
 * RCPT sin autenticar es tráfico de rebotes o un intento de usarla como buzón.
 */
export function parsearDireccionVerp(direccion) {
  const dominio = dominioRebotes()
  if (!dominio) return null
  const email = soloDireccion(direccion)
  const arroba = email.lastIndexOf('@')
  if (arroba <= 0 || email.slice(arroba + 1) !== dominio) return null
  const local = email.slice(0, arroba)
  if (!local.startsWith(PREFIJO)) return null
  const id = local.slice(PREFIJO.length)
  return RE_CORRELACION.test(id) ? id : null
}

/** ¿Es esta dirección una dirección VERP nuestra? */
export const esDireccionVerp = (direccion) => parsearDireccionVerp(direccion) !== null

// ---------------------------------------------------------------------------
// DSN (RFC 3464)
//
// Un rebote bien formado es un multipart/report con una parte message/delivery-status. Esa parte
// son grupos de campos estilo cabecera separados por línea en blanco: el primero describe al MTA
// que reporta y los siguientes, UNO POR DESTINATARIO, traen Action, Status y Diagnostic-Code.
// mailparser entrega esa parte como adjunto; aquí solo se desmenuza el texto.
// ---------------------------------------------------------------------------

// Tipos de la parte de estado. El «global» es la variante SMTPUTF8 (RFC 6533).
const TIPOS_DELIVERY_STATUS = new Set(['message/delivery-status', 'message/global-delivery-status'])

// Código de estado ampliado (RFC 3463): clase 2 éxito, 4 transitorio, 5 permanente.
const RE_STATUS = /\b([245])\.\d{1,3}\.\d{1,3}\b/

// Código SMTP clásico dentro del Diagnostic-Code («smtp; 550 5.1.1 …»): sirve de último recurso
// cuando el campo Status falta o no es legible.
const RE_CODIGO_SMTP = /\b([245])\d{2}\b/

/** Quita el prefijo de tipo («rfc822; usuario@x.com» → «usuario@x.com»). */
function direccionDsn(valor) {
  const bruto = texto(valor)
  const punto = bruto.indexOf(';')
  return soloDireccion(punto >= 0 ? bruto.slice(punto + 1) : bruto)
}

/**
 * Parte el texto de message/delivery-status en bloques de campos.
 * Cada bloque es un objeto { campo-en-minúsculas: valor }; las líneas que empiezan por espacio son
 * continuaciones del campo anterior (plegado clásico de cabeceras).
 */
function partirEnBloques(contenido) {
  const bloques = []
  let actual = {}
  let ultimaClave = null

  const cerrar = () => {
    if (Object.keys(actual).length) bloques.push(actual)
    actual = {}
    ultimaClave = null
  }

  for (const linea of String(contenido ?? '').split(/\r?\n/)) {
    if (!linea.trim()) {
      cerrar()
      continue
    }
    if (/^[ \t]/.test(linea) && ultimaClave) {
      actual[ultimaClave] += ` ${linea.trim()}`
      continue
    }
    const m = linea.match(/^([A-Za-z][A-Za-z0-9-]*)\s*:\s*(.*)$/)
    if (!m) continue // línea que no es un campo: se ignora, el resto del bloque sigue valiendo
    ultimaClave = m[1].toLowerCase()
    if (!(ultimaClave in actual)) actual[ultimaClave] = m[2].trim()
  }
  cerrar()
  return bloques
}

/**
 * Clasifica un destinatario del DSN en duro / blando / desconocido.
 *
 * Manda la CLASE del Status (RFC 3463): 5.x.x permanente → duro, 4.x.x transitorio → blando.
 * Sin Status legible se cae al vocabulario cerrado de Action (failed → duro, delayed → blando).
 * Todo lo demás (delivered, relayed, expanded, o un aviso ilegible) es «desconocido» y NUNCA toca
 * el estado del mensaje: clasificar mal un aviso raro como rebote duro suprimiría a un destinatario
 * legítimo, que es el peor error posible de esta pieza.
 */
export function clasificarDsn({ status, accion } = {}) {
  const clase = texto(status).charAt(0)
  if (clase === '5') return 'duro'
  if (clase === '4') return 'blando'
  const a = texto(accion).toLowerCase()
  if (a === 'failed') return 'duro'
  if (a === 'delayed') return 'blando'
  return 'desconocido'
}

/** Status de un bloque: el campo Status y, si falta, lo que se pueda leer del Diagnostic-Code. */
function statusDeBloque(bloque) {
  const directo = RE_STATUS.exec(texto(bloque.status))
  if (directo) return directo[0]
  const diagnostico = texto(bloque['diagnostic-code'])
  const ampliado = RE_STATUS.exec(diagnostico)
  if (ampliado) return ampliado[0]
  const clasico = RE_CODIGO_SMTP.exec(diagnostico)
  if (clasico) return `${clasico[1]}.0.0` // solo se conoce la clase; el detalle queda en el diagnóstico
  return null
}

/**
 * Interpreta un correo ya parseado por mailparser como DSN RFC 3464.
 *
 * @param {object} mail  resultado de simpleParser (con `attachments`)
 * @returns {{esDsn: boolean, mtaReportante: string|null, destinatarios: Array<{
 *            destinatario: string|null, accion: string|null, status: string|null,
 *            diagnostico: string|null, mtaRemoto: string|null, clase: 'duro'|'blando'|'desconocido'}>}}
 *
 * `esDsn: false` = el contenido no trae parte message/delivery-status: no es un DSN y quien llama
 * lo registra como rebote_desconocido sin tocar ningún estado.
 */
export function parsearDsn(mail) {
  const sinDsn = { esDsn: false, mtaReportante: null, destinatarios: [] }

  // Camino normal: simpleParser(crudo, { keepDeliveryStatus: true }) entrega la parte de estado
  // como adjunto con su contenido crudo.
  const adjuntos = Array.isArray(mail?.attachments) ? mail.attachments : []
  const parte = adjuntos.find((a) => TIPOS_DELIVERY_STATUS.has(texto(a?.contentType).toLowerCase()))

  let contenido = ''
  if (parte) {
    try {
      contenido = Buffer.isBuffer(parte.content) ? parte.content.toString('utf8') : String(parte.content ?? '')
    } catch {
      return sinDsn
    }
  } else {
    // Sin keepDeliveryStatus, mailparser FUNDE message/delivery-status dentro de `text`. Si el
    // content-type global declara multipart/report de entrega, los bloques de campos se leen del
    // texto: las líneas humanas del aviso no casan como campo y se descartan solas.
    const ct = mail?.headers?.get?.('content-type')
    const esReport =
      texto(ct?.value).toLowerCase() === 'multipart/report' &&
      texto(ct?.params?.['report-type']).toLowerCase() === 'delivery-status'
    if (!esReport) return sinDsn
    contenido = texto(mail?.text)
  }
  if (!contenido.trim()) return sinDsn

  const bloques = partirEnBloques(contenido)
  let mtaReportante = null
  const destinatarios = []

  for (const bloque of bloques) {
    if (!mtaReportante && bloque['reporting-mta']) {
      mtaReportante = texto(bloque['reporting-mta']).slice(0, 200) || null
    }
    // Un bloque por destinatario: Action es obligatorio por RFC, pero se admite también un bloque
    // con solo Status o Final-Recipient (hay MTAs que recortan campos).
    if (!('action' in bloque) && !('final-recipient' in bloque) && !('status' in bloque)) continue

    const status = statusDeBloque(bloque)
    const accion = texto(bloque.action).toLowerCase().slice(0, 40) || null
    const destinatario =
      direccionDsn(bloque['final-recipient']) || direccionDsn(bloque['original-recipient']) || null
    destinatarios.push({
      destinatario,
      accion,
      status,
      diagnostico: texto(bloque['diagnostic-code']).slice(0, 500) || null,
      mtaRemoto: texto(bloque['remote-mta']).slice(0, 200) || null,
      clase: clasificarDsn({ status, accion }),
    })
  }

  return { esDsn: true, mtaReportante, destinatarios }
}

export default {
  dominioRebotes,
  capturaRebotesActiva,
  construirDireccionVerp,
  parsearDireccionVerp,
  esDireccionVerp,
  clasificarDsn,
  parsearDsn,
}
