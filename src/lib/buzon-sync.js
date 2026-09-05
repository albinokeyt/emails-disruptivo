import { randomBytes } from 'node:crypto'
import { ImapFlow } from 'imapflow'
import { simpleParser } from 'mailparser'
import { config } from '../config.js'
import { pool, q } from '../db.js'
import { redis } from '../redis.js'
import {
  ajustarUso,
  cuotaDe,
  extraerThreadKey,
  idsDeReferencias,
  normalizarMessageId,
  recalcularUso,
  resumenTexto,
  sanearHtml,
  tamanoLegible,
} from './buzon.js'
import { decrypt } from './crypto.js'
import { destinoPermitido } from './red.js'

// ---------------------------------------------------------------------------
// Sincronización del buzón IMAP (SPEC §14.2).
//
// Un bucle en el worker revisa cada minuto los buzones habilitados cuyo last_sync_at haya
// vencido y, por cada uno: conecta, abre la carpeta, pide los UID mayores que last_uid, descarga
// cada mensaje, lo parsea con mailparser, comprueba la cuota de la subcuenta, lo guarda con sus
// adjuntos y avanza last_uid. Reglas que no son negociables:
//
//   · Lock en Redis por buzón (buzon:lock:<id>, 5 min): dos instancias nunca sincronizan el mismo.
//     Si Redis no está, se sigue sin lock: el ON CONFLICT (mailbox_id, uid) y el GREATEST sobre
//     last_uid hacen que dos pasadas simultáneas no dupliquen nada.
//   · La cuota se comprueba ANTES de insertar. Si el siguiente mensaje no cabe, el buzón pasa a
//     `cuota_llena` y la pasada termina sin avanzar last_uid: al liberar espacio arranca sola.
//   · UIDVALIDITY distinto al guardado = los UID ya no significan lo mismo: last_uid vuelve a 0.
//   · Un correo por encima de BUZON_MAX_MENSAJE_MB no se descarga (bastaría uno de 300 MB para
//     tumbar el proceso al parsearlo en memoria): se guardan solo sus cabeceras con un aviso y el
//     original se conserva SIEMPRE en el servidor, aunque la cuenta borre al importar: lo guardado
//     aquí no es una copia completa y borrarlo allí sería perderlo.
//   · La cuota se comprueba dos veces: antes de descargar con el tamaño que anuncia el servidor
//     (RFC822.SIZE) y, ya parseado, con lo que de verdad se va a guardar (size_bytes + adjuntos).
//     size_bytes es el peso del correo SIN los adjuntos que se extraen a inbox_attachments, para
//     no contarlos dos veces (en el crudo van en base64 y en la tabla, decodificados).
//   · Errores → mailboxes.status='error' + last_error, sin tumbar el worker; last_sync_at se
//     actualiza también al fallar para que el reintento respete sync_interval_min.
//   · La contraseña IMAP no aparece jamás en logs ni en last_error: imapflow va con logger:false
//     y los mensajes de error se filtran por si un servidor la repitiera.
//   · Primera sincronización de una cuenta: solo los últimos MENSAJES_PRIMERA_SINCRONIZACION
//     correos. Traer años de historial llenaría la cuota con correo antiguo antes de que el
//     usuario viera el primero reciente.
// ---------------------------------------------------------------------------

const CADA_MS = 60_000
const PRIMERA_PASADA_MS = 5_000
const MAX_BUZONES_POR_VUELTA = 25
const MAX_MENSAJES_POR_PASADA = 200
const MENSAJES_PRIMERA_SINCRONIZACION = 100
const MAX_DESTINATARIOS_GUARDADOS = 100

const PREFIJO_LOCK = 'buzon:lock:'
const LOCK_TTL_S = 300
// la pasada termina antes de que caduque el lock, aunque quede trabajo (sigue en la siguiente)
const PLAZO_PASADA_MS = 240_000
const PLAZO_CONEXION_MS = 45_000
const PLAZO_CARPETA_MS = 30_000
const PLAZO_LOGOUT_MS = 5_000
const PLAZO_PARADA_MS = 15_000

// Los tiempos por defecto de imapflow son altísimos (90 s de conexión, 5 min de inactividad): un
// servidor colgado bloquearía el bucle entero.
const TIEMPOS = { connectionTimeout: 20_000, greetingTimeout: 15_000, socketTimeout: 120_000 }

const AVISO_MENSAJE_GRANDE = (tam, max) =>
  `Este correo pesa ${tamanoLegible(tam)} y supera el máximo de ${max} MB por mensaje: se ha guardado sin contenido ni adjuntos. ` +
  'El original sigue completo en el servidor de correo.'

/**
 * Bytes que ocupa un adjunto de `n` bytes codificado en base64 dentro del correo crudo (líneas de
 * 76 caracteres + CRLF, RFC 2045). Sirve para descontarlo de size_bytes: el adjunto se guarda aparte.
 */
function pesoBase64(n) {
  const caracteres = Math.ceil(Math.max(0, n) / 3) * 4
  return caracteres + Math.ceil(caracteres / 76) * 2
}

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
const limpiar = (v, max = 500) => texto(v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max)

function registrador(base) {
  const nada = () => {}
  const l = base && typeof base === 'object' ? base : console
  const metodo = (nombre, alternativa) => (typeof l[nombre] === 'function' ? l[nombre].bind(l) : alternativa)
  const info = metodo('info', nada)
  return { info, warn: metodo('warn', info), error: metodo('error', info), debug: metodo('debug', nada) }
}

function errorBuzon(mensaje, opciones = {}) {
  const err = new Error(mensaje)
  err.buzon = true
  err.permanente = Boolean(opciones.permanente)
  return err
}

function conPlazo(promesa, ms, mensaje) {
  let temporizador
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(errorBuzon(mensaje)), ms)
  })
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador))
}

const estado = {
  activo: false,
  // true mientras dura el cierre ordenado: las pasadas en curso terminan tras el mensaje actual
  parando: false,
  temporizador: null,
  primera: null,
  enCurso: null,
  log: registrador(null),
  ultimaVuelta: null,
}

// Conexiones IMAP abiertas por este proceso: al parar se cierran para no dejar sockets colgando.
const clientesActivos = new Set()

// ---------------------------------------------------------------------------
// Lock entre instancias (SET NX EX). Se libera solo si sigue siendo nuestro.
// ---------------------------------------------------------------------------

const LUA_LIBERAR = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`
const LUA_RENOVAR = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) end return 0`

/** → token si se tomó, null si otra instancia lo tiene, 'sin-redis' si Redis no responde. */
async function adquirirLock(mailboxId) {
  const token = randomBytes(16).toString('hex')
  try {
    const res = await redis.set(PREFIJO_LOCK + mailboxId, token, 'EX', LOCK_TTL_S, 'NX')
    return res === 'OK' ? token : null
  } catch {
    return 'sin-redis'
  }
}

async function renovarLock(mailboxId, token) {
  if (!token || token === 'sin-redis') return
  try {
    await redis.eval(LUA_RENOVAR, 1, PREFIJO_LOCK + mailboxId, token, LOCK_TTL_S)
  } catch {
    // el lock caduca solo; la pasada termina antes por PLAZO_PASADA_MS
  }
}

async function liberarLock(mailboxId, token) {
  if (!token || token === 'sin-redis') return
  try {
    await redis.eval(LUA_LIBERAR, 1, PREFIJO_LOCK + mailboxId, token)
  } catch {
    // caduca solo a los 5 min
  }
}

// ---------------------------------------------------------------------------
// Fila del buzón, contraseña y conexión
// ---------------------------------------------------------------------------

async function filaBuzon(id) {
  const { rows: [fila] } = await q('SELECT * FROM mailboxes WHERE id = $1', [id])
  return fila ?? null
}

/**
 * Contraseña IMAP en claro a partir de password_enc. Se admite tanto un objeto cifrado con
 * cifrarCredenciales ({ password }) como la cadena cifrada directamente con encrypt().
 */
function contrasenaDe(fila) {
  let txt
  try {
    txt = decrypt(fila.password_enc)
  } catch {
    throw errorBuzon('No se pudo descifrar la contraseña del buzón: vuelve a guardarla en la configuración', { permanente: true })
  }
  try {
    const valor = JSON.parse(txt)
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      const clave = valor.password ?? valor.pass ?? valor.contrasena ?? valor.contraseña ?? valor.clave ?? ''
      return String(clave)
    }
    if (typeof valor === 'string') return valor
  } catch {
    // no era JSON: la contraseña se cifró tal cual
  }
  return txt
}

function crearCliente(fila, contrasena, log) {
  const seguro = Boolean(fila.secure)
  const cliente = new ImapFlow({
    host: texto(fila.host),
    port: Number(fila.port) || (seguro ? 993 : 143),
    secure: seguro,
    // sin TLS implícito el STARTTLS es OBLIGATORIO: las credenciales del cliente no salen en claro
    ...(seguro ? {} : { doSTARTTLS: true }),
    auth: { user: texto(fila.username), pass: contrasena },
    logger: false,
    disableAutoIdle: true,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: texto(fila.host) },
    clientInfo: { name: 'Emails Disruptivo', vendor: 'Departamento Disruptivo' },
    // un literal mayor que esto no se descarga jamás (el techo por mensaje se comprueba antes)
    maxLiteralSize: config.buzon.maxMensajeBytes + 2 * 1024 * 1024,
    maxResponseSize: config.buzon.maxMensajeBytes + 4 * 1024 * 1024,
    ...TIEMPOS,
  })
  // sin oyente, un 'error' del socket tras conectar tumbaría el proceso entero
  cliente.on('error', (err) => log.debug({ buzon: fila.id, err: limpiar(err?.message, 200) }, 'error de la conexión IMAP'))
  clientesActivos.add(cliente)
  return cliente
}

async function cerrarCliente(cliente) {
  if (!cliente) return
  clientesActivos.delete(cliente)
  try {
    await conPlazo(cliente.logout(), PLAZO_LOGOUT_MS, 'logout')
  } catch {
    try {
      cliente.close()
    } catch {
      // ya estaba cerrado
    }
  }
}

const CODIGOS_TLS = /CERT|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|WRONG_VERSION_NUMBER|HANDSHAKE/i

/** Mensaje legible para last_error y el panel. Nunca contiene la contraseña. */
function describirError(err, fila = {}, contrasena = '') {
  const host = texto(fila.host) || 'el servidor IMAP'
  const puerto = Number(fila.port) || (fila.secure ? 993 : 143)
  const carpeta = texto(fila.folder) || 'INBOX'
  const codigo = texto(err?.code).toUpperCase()
  const detalle = limpiar(err?.responseText || err?.message, 300)

  let mensaje
  if (err?.buzon) {
    mensaje = err.message
  } else if (err?.authenticationFailed) {
    mensaje =
      'El servidor IMAP rechazó el usuario o la contraseña. Gmail y Outlook exigen una «contraseña de aplicación» ' +
      'con la verificación en dos pasos activada'
  } else if (err?.tlsFailed) {
    mensaje = `${host}:${puerto} no ofrece STARTTLS: activa TLS y usa el puerto 993`
  } else if (codigo === 'CONNECT_TIMEOUT' || codigo === 'ETIMEDOUT' || codigo === 'GREETINGTIMEOUT') {
    mensaje = `No se pudo conectar con ${host}:${puerto}: el servidor no respondió a tiempo`
  } else if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') {
    mensaje = `No se encontró el servidor ${host}: revisa el nombre del servidor IMAP`
  } else if (codigo === 'ECONNREFUSED') {
    mensaje = `${host}:${puerto} rechazó la conexión: revisa el puerto y si usa TLS`
  } else if (codigo === 'ECONNRESET' || codigo === 'EPIPE' || codigo === 'NOCONNECTION' || codigo === 'ECONNCLOSED') {
    mensaje = `${host} cortó la conexión${detalle ? `: ${detalle}` : ''}`
  } else if (CODIGOS_TLS.test(codigo)) {
    mensaje = `El certificado TLS de ${host} no es válido (${codigo})`
  } else if (codigo === 'LITERALTOOLARGE' || codigo === 'RESPONSETOOLARGE') {
    mensaje = `${host} envió una respuesta mayor de lo admitido (BUZON_MAX_MENSAJE_MB=${config.buzon.maxMensajeMb})`
  } else if (codigo === 'LOCKTIMEOUT') {
    mensaje = `No se pudo abrir la carpeta «${carpeta}» a tiempo`
  } else if (texto(err?.responseStatus).toUpperCase() === 'NO' && /mailbox|folder|select|examine|exist/i.test(detalle)) {
    mensaje = `No se pudo abrir la carpeta «${carpeta}»: ${detalle}`
  } else {
    mensaje = `Error del servidor IMAP${detalle ? `: ${detalle}` : ''}`
  }

  // por si algún servidor repitiera la contraseña en su respuesta
  if (contrasena && contrasena.length >= 4) mensaje = mensaje.split(contrasena).join('[oculta]')
  return limpiar(mensaje, 500)
}

// ---------------------------------------------------------------------------
// Extracción de los datos de un mensaje parseado
// ---------------------------------------------------------------------------

const RE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+$/

/** Direcciones de un campo de mailparser (objeto o array de objetos; los grupos se aplanan). */
function listaDirecciones(campo) {
  const objetos = Array.isArray(campo) ? campo : campo ? [campo] : []
  const salida = []
  const meter = (valores) => {
    for (const d of valores || []) {
      if (Array.isArray(d?.group)) {
        meter(d.group)
        continue
      }
      const email = texto(d?.address).toLowerCase().slice(0, 320)
      const name = limpiar(d?.name, 200)
      if (!email && !name) continue
      salida.push({ email: email && RE_EMAIL.test(email) ? email : null, name: name || null })
    }
  }
  for (const objeto of objetos) meter(objeto?.value)
  return salida
}

function fechaDe(parsed, meta) {
  const candidatos = [parsed?.date, meta?.internalDate]
  for (const c of candidatos) {
    const d = c instanceof Date ? c : c ? new Date(c) : null
    if (d && Number.isFinite(d.getTime())) return d
  }
  return new Date()
}

const EXTENSIONES = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg',
  'application/pdf': '.pdf', 'text/plain': '.txt', 'text/html': '.html', 'text/calendar': '.ics', 'text/csv': '.csv',
  'application/zip': '.zip', 'application/json': '.json', 'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.ms-excel': '.xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
}

const RE_TIPO_MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/

function tipoAdjunto(adjunto) {
  const tipo = texto(adjunto?.contentType).toLowerCase().split(';')[0].trim().slice(0, 150)
  return RE_TIPO_MIME.test(tipo) ? tipo : 'application/octet-stream'
}

function nombreAdjunto(adjunto, tipo, indice) {
  // ni separadores de ruta ni caracteres de control: el nombre viaja en Content-Disposition
  const nombre = texto(adjunto?.filename).replace(/[\\/:*?"<>|]|\p{Cc}/gu, '_').slice(0, 200)
  return nombre || `adjunto-${indice + 1}${EXTENSIONES[tipo] || ''}`
}

/**
 * Adjuntos que se guardan. Las imágenes incrustadas (Content-ID referenciado desde el HTML) ya van
 * dentro del HTML como data: URI gracias a mailparser: repetirlas como adjunto solo gastaría cuota.
 */
function adjuntosDe(parsed, hayHtml) {
  const lista = Array.isArray(parsed?.attachments) ? parsed.attachments : []
  const salida = []
  let indice = 0
  for (const adjunto of lista) {
    if (!Buffer.isBuffer(adjunto?.content) || !adjunto.content.length) continue
    if (hayHtml && adjunto.related === true) continue
    const tipo = tipoAdjunto(adjunto)
    salida.push({ filename: nombreAdjunto(adjunto, tipo, indice), content_type: tipo, content: adjunto.content, size_bytes: adjunto.content.length })
    indice += 1
  }
  return salida
}

/**
 * Clave del hilo de un mensaje entrante. Además de la regla del SPEC (primer id de References,
 * In-Reply-To o el propio Message-ID), si el mensaje contesta a algo que ya está en la app —un
 * correo recibido o una respuesta nuestra (messages.provider_message_id)— hereda su thread_key:
 * así la contestación a una respuesta enviada desde el buzón cae en el mismo hilo aunque el
 * cliente del remitente no rellene References.
 */
async function claveHilo(locationId, ids, respaldo) {
  const candidatos = [...new Set([...idsDeReferencias(ids.references), ...idsDeReferencias(ids.inReplyTo)])].slice(0, 20)
  if (candidatos.length) {
    const { rows: [recibido] } = await q(
      `SELECT thread_key FROM inbox_messages
        WHERE location_id = $1 AND message_id = ANY($2::text[])
        ORDER BY date ASC LIMIT 1`,
      [locationId, candidatos]
    )
    if (recibido?.thread_key) return recibido.thread_key
    const { rows: [enviado] } = await q(
      `SELECT thread_key FROM messages
        WHERE location_id = $1 AND thread_key IS NOT NULL AND provider_message_id = ANY($2::text[])
        ORDER BY id ASC LIMIT 1`,
      [locationId, candidatos]
    )
    if (enviado?.thread_key) return enviado.thread_key
  }
  return extraerThreadKey(ids) || respaldo
}

// ---------------------------------------------------------------------------
// Importación de un mensaje
// ---------------------------------------------------------------------------

/**
 * Descarga, parsea y guarda el UID indicado.
 * → 'nuevo' | 'parcial' | 'duplicado' | 'desaparecido' | 'sin_espacio'
 *   · 'parcial': el mensaje supera BUZON_MAX_MENSAJE_MB y no se descarga; se piden solo sus
 *     cabeceras y se guarda con un aviso como cuerpo. Quien llama NO debe borrarlo del servidor.
 *   · 'sin_espacio': parseado, lo que se iba a guardar (size_bytes + adjuntos) no cabe en los
 *     `libreBytes` de la cuota. No se escribe nada ni se avanza last_uid.
 */
async function importarMensaje(cliente, fila, uid, tamServidor, libreBytes = Infinity) {
  const grande = tamServidor > config.buzon.maxMensajeBytes
  const consulta = grande
    ? { uid: true, size: true, internalDate: true, headers: true }
    : { uid: true, size: true, internalDate: true, source: true }
  const meta = await cliente.fetchOne(String(uid), consulta, { uid: true })
  if (!meta) return 'desaparecido'

  const crudo = grande ? meta.headers : meta.source
  if (!Buffer.isBuffer(crudo) || !crudo.length) return 'desaparecido'

  const parsed = await simpleParser(crudo, { skipTextToHtml: true, skipTextLinks: true })

  const messageId = normalizarMessageId(parsed.messageId)
  const inReplyTo = idsDeReferencias(parsed.inReplyTo)
  const references = idsDeReferencias(parsed.references)
  const remitente = listaDirecciones(parsed.from)[0] ?? null
  const destinatarios = [
    ...listaDirecciones(parsed.to).map((d) => ({ tipo: 'to', ...d })),
    ...listaDirecciones(parsed.cc).map((d) => ({ tipo: 'cc', ...d })),
  ].slice(0, MAX_DESTINATARIOS_GUARDADOS)

  const aviso = grande ? AVISO_MENSAJE_GRANDE(tamServidor, config.buzon.maxMensajeMb) : ''
  const html = grande ? '' : sanearHtml(parsed.html)
  const textoPlano = grande ? aviso : texto(parsed.text)
  const snippet = grande ? aviso : resumenTexto(textoPlano, html)
  const adjuntos = grande ? [] : adjuntosDe(parsed, Boolean(html))
  const bytesAdjuntos = adjuntos.reduce((total, a) => total + a.size_bytes, 0)
  // size_bytes = el crudo sin los adjuntos extraídos (que se cuentan aparte en inbox_attachments).
  // Si un adjunto no venía en base64 el descuento sería excesivo: nunca baja de lo que se guarda.
  const descuentoAdjuntos = adjuntos.reduce((total, a) => total + pesoBase64(a.size_bytes), 0)
  const minimoGuardado = Buffer.byteLength(textoPlano) + Buffer.byteLength(html) + 1024
  const sizeBytes = Math.max(minimoGuardado, crudo.length - descuentoAdjuntos)
  // Segunda comprobación de la cuota, ya con lo que de verdad se va a guardar (la primera, antes de
  // descargar, solo conocía el tamaño que anunciaba el servidor).
  if (sizeBytes + bytesAdjuntos > libreBytes) return 'sin_espacio'
  const respaldoHilo = `sin-id:${fila.id}:${uid}`
  const threadKey = await claveHilo(fila.location_id, { messageId, inReplyTo, references }, respaldoHilo)

  const conexion = await pool.connect()
  try {
    await conexion.query('BEGIN')

    // dedupe por Message-ID dentro de la subcuenta: el mismo correo llegado a dos cuentas (alias,
    // reenvíos automáticos) se guarda una sola vez
    if (messageId) {
      const { rows: [repetido] } = await conexion.query(
        'SELECT id FROM inbox_messages WHERE location_id = $1 AND message_id = $2 LIMIT 1',
        [fila.location_id, messageId]
      )
      if (repetido) {
        await conexion.query('UPDATE mailboxes SET last_uid = GREATEST(last_uid, $2::bigint), updated_at = now() WHERE id = $1', [fila.id, uid])
        await conexion.query('COMMIT')
        return 'duplicado'
      }
    }

    const { rows: [insertado] } = await conexion.query(
      `INSERT INTO inbox_messages (location_id, mailbox_id, uid, message_id, in_reply_to, "references", thread_key,
                                   from_email, from_name, recipients, subject, date, snippet, text, html,
                                   size_bytes, has_attachments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17)
       ON CONFLICT (mailbox_id, uid) DO NOTHING
       RETURNING id`,
      [
        fila.location_id, fila.id, uid, messageId || null, inReplyTo[0] || null, references.length ? references.join(' ') : null, threadKey,
        remitente?.email || null, remitente?.name || null, JSON.stringify(destinatarios), limpiar(parsed.subject, 500) || null,
        fechaDe(parsed, meta), snippet || null, textoPlano || null, html || null,
        sizeBytes, adjuntos.length > 0,
      ]
    )

    if (!insertado) {
      await conexion.query('UPDATE mailboxes SET last_uid = GREATEST(last_uid, $2::bigint), updated_at = now() WHERE id = $1', [fila.id, uid])
      await conexion.query('COMMIT')
      return 'duplicado'
    }

    for (const adjunto of adjuntos) {
      await conexion.query(
        `INSERT INTO inbox_attachments (message_id, filename, content_type, size_bytes, content)
         VALUES ($1,$2,$3,$4,$5)`,
        [insertado.id, adjunto.filename, adjunto.content_type, adjunto.size_bytes, adjunto.content]
      )
    }

    await ajustarUso(fila.location_id, sizeBytes + bytesAdjuntos, conexion)
    await conexion.query('UPDATE mailboxes SET last_uid = GREATEST(last_uid, $2::bigint), updated_at = now() WHERE id = $1', [fila.id, uid])
    await conexion.query('COMMIT')
    return grande ? 'parcial' : 'nuevo'
  } catch (err) {
    await conexion.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    conexion.release()
  }
}

/** Marca \Deleted y expulsa el UID (UID EXPUNGE con UIDPLUS; EXPUNGE normal si no). Nunca lanza. */
async function borrarUid(cliente, uid, log, buzonId) {
  try {
    await cliente.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true })
    const hecho = await cliente.messageDelete(String(uid), { uid: true })
    return hecho === true
  } catch (err) {
    log.warn({ buzon: buzonId, uid, err: limpiar(err?.message, 200) }, 'no se pudo borrar el mensaje en el servidor IMAP')
    return false
  }
}

async function marcarCuotaLlena(fila, cuota, tamPendiente = 0) {
  const detalle =
    `Cuota de espacio alcanzada (${tamanoLegible(cuota.usado_bytes)} de ${cuota.cuota_mb} MB)` +
    (tamPendiente ? `: el siguiente correo pesa ${tamanoLegible(tamPendiente)}` : '') +
    '. Borra correo del buzón para que la sincronización continúe'
  await q(
    `UPDATE mailboxes SET status = 'cuota_llena', last_error = $2, last_sync_at = now(), updated_at = now() WHERE id = $1`,
    [fila.id, detalle]
  )
  return detalle
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

// Entero dentro de [1, maximo]; si no llega nada válido, el máximo.
function acotar(valor, maximo) {
  const n = Number(valor)
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), maximo) : maximo
}

/**
 * Sincroniza un buzón. `forzar` (botón «Sincronizar ahora») salta la comprobación de `enabled`.
 * `maxMensajes` y `plazoMs` acotan la pasada por debajo de los topes del bucle (la forzada desde el
 * panel responde dentro de una petición HTTP: lo que no quepa sigue en la siguiente pasada).
 * Nunca lanza: → { ok, nuevos, detalle } (y además parciales, duplicados, omitidos, borrados, pendientes).
 */
export async function sincronizarBuzon(mailboxId, opciones = {}) {
  const log = registrador(opciones.log ?? estado.log)
  const forzar = opciones.forzar === true
  const maxMensajes = acotar(opciones.maxMensajes, MAX_MENSAJES_POR_PASADA)
  const plazoMs = acotar(opciones.plazoMs, PLAZO_PASADA_MS)
  const id = Number(mailboxId)
  const resultado = {
    ok: false, nuevos: 0, parciales: 0, duplicados: 0, omitidos: 0, desaparecidos: 0, borrados: 0, pendientes: 0, detalle: '',
  }
  if (!Number.isInteger(id) || id <= 0) return { ...resultado, detalle: 'Identificador de buzón no válido' }

  const fila = await filaBuzon(id)
  if (!fila) return { ...resultado, detalle: 'El buzón no existe' }
  if (!fila.enabled && !forzar) return { ...resultado, detalle: 'El buzón está desactivado' }

  const token = await adquirirLock(id)
  if (!token) return { ...resultado, detalle: 'Ya hay una sincronización en curso de este buzón' }
  if (token === 'sin-redis') log.warn({ buzon: id }, 'Redis no responde: se sincroniza sin lock entre instancias')

  const inicio = Date.now()
  const quedaTiempo = () => Date.now() - inicio < plazoMs
  let cliente = null
  let bloqueo = null
  let contrasena = ''
  let noBorrados = 0

  try {
    // el contador de uso es una caché: se recalcula por si un borrado en cascada lo dejó desviado
    await recalcularUso(fila.location_id)
    const cuotaInicial = await cuotaDe(fila.location_id)
    if (cuotaInicial.libre_bytes <= 0) {
      return { ...resultado, detalle: await marcarCuotaLlena(fila, cuotaInicial) }
    }

    if (!(await destinoPermitido(fila.host))) {
      throw errorBuzon('El servidor IMAP apunta a una dirección de red interna: revisa el host de la cuenta', { permanente: true })
    }
    contrasena = contrasenaDe(fila)
    cliente = crearCliente(fila, contrasena, log)
    await conPlazo(cliente.connect(), PLAZO_CONEXION_MS, 'El servidor IMAP no respondió a tiempo al conectar')

    const carpeta = texto(fila.folder) || 'INBOX'
    bloqueo = await cliente.getMailboxLock(carpeta, { acquireTimeout: PLAZO_CARPETA_MS })
    const buzon = cliente.mailbox
    if (!buzon) throw errorBuzon(`No se pudo abrir la carpeta «${carpeta}»`)

    // UIDVALIDITY: si cambia, los UID guardados ya no identifican los mismos mensajes
    const validez = buzon.uidValidity !== undefined && buzon.uidValidity !== null ? String(buzon.uidValidity) : null
    const validezPrevia = fila.uidvalidity !== undefined && fila.uidvalidity !== null ? String(fila.uidvalidity) : null
    let ultimoUid = Math.max(0, Number(fila.last_uid) || 0)
    let primeraVez = validezPrevia === null && ultimoUid === 0
    if (validez && validezPrevia && validez !== validezPrevia) {
      log.warn({ buzon: id, anterior: validezPrevia, actual: validez }, 'UIDVALIDITY cambió: se vuelve a leer la carpeta desde el principio')
      ultimoUid = 0
      // se recorre la carpeta como la primera vez: solo los últimos N, no años de histórico (el
      // dedupe por Message-ID evita repetir lo que ya estaba guardado)
      primeraVez = true
    }
    if (validez !== validezPrevia || ultimoUid !== Number(fila.last_uid)) {
      await q('UPDATE mailboxes SET uidvalidity = $2, last_uid = $3, updated_at = now() WHERE id = $1', [id, validez, ultimoUid])
    }

    // UID pendientes. «N:*» devuelve el último mensaje aunque su UID sea menor que N (RFC 3501):
    // el filtro > ultimoUid es obligatorio.
    let uids = []
    if (Number(buzon.exists) > 0) {
      const encontrados = await cliente.search({ uid: `${ultimoUid + 1}:*` }, { uid: true })
      uids = (Array.isArray(encontrados) ? encontrados : [])
        .map(Number)
        .filter((u) => Number.isInteger(u) && u > ultimoUid)
        .sort((a, b) => a - b)
    }
    if (primeraVez && uids.length > MENSAJES_PRIMERA_SINCRONIZACION) {
      resultado.omitidos = uids.length - MENSAJES_PRIMERA_SINCRONIZACION
      uids = uids.slice(-MENSAJES_PRIMERA_SINCRONIZACION)
      ultimoUid = uids[0] - 1
      await q('UPDATE mailboxes SET last_uid = $2, updated_at = now() WHERE id = $1', [id, ultimoUid])
      log.info({ buzon: id, omitidos: resultado.omitidos }, 'primera sincronización: se traen solo los correos más recientes')
    }

    const lote = uids.slice(0, maxMensajes)
    const tamanos = new Map()
    if (lote.length) {
      for await (const m of cliente.fetch(lote, { uid: true, size: true }, { uid: true })) {
        tamanos.set(Number(m.uid), Number(m.size) || 0)
      }
    }

    let cuotaLlena = false
    let procesados = 0
    for (const uid of lote) {
      // sin tiempo (el lock caducaría) o con el proceso cerrándose: lo que quede va a la siguiente pasada
      if (!quedaTiempo() || estado.parando) break
      const tam = tamanos.get(uid) ?? 0
      const cuota = await cuotaDe(fila.location_id)
      // lo que se va a guardar: el mensaje entero, o solo sus cabeceras si supera el máximo
      const necesario = tam > config.buzon.maxMensajeBytes ? Math.min(tam, 64 * 1024) : tam
      if (necesario > cuota.libre_bytes) {
        cuotaLlena = true
        resultado.detalle = await marcarCuotaLlena(fila, cuota, tam)
        break
      }

      const guardado = await importarMensaje(cliente, fila, uid, tam, cuota.libre_bytes)
      if (guardado === 'sin_espacio') {
        // parseado no cabe aunque el tamaño anunciado sí: se para aquí sin avanzar last_uid
        cuotaLlena = true
        resultado.detalle = await marcarCuotaLlena(fila, await cuotaDe(fila.location_id), tam)
        break
      }
      procesados += 1
      if (guardado === 'nuevo') {
        resultado.nuevos += 1
      } else if (guardado === 'parcial') {
        resultado.nuevos += 1
        resultado.parciales += 1
      } else if (guardado === 'duplicado') {
        resultado.duplicados += 1
      } else {
        resultado.desaparecidos += 1
      }
      ultimoUid = Math.max(ultimoUid, uid)

      // Un correo por encima del máximo (guardado 'parcial', o repetido de uno parcial) NUNCA se
      // borra del servidor: allí está la única copia completa.
      const conservar = tam > config.buzon.maxMensajeBytes
      if (fila.delete_after_import && !conservar && (guardado === 'nuevo' || guardado === 'duplicado')) {
        if (await borrarUid(cliente, uid, log, id)) resultado.borrados += 1
        else noBorrados += 1
      }
      if (procesados % 25 === 0) await renovarLock(id, token)
    }

    resultado.pendientes = Math.max(0, uids.length - procesados)
    if (cuotaLlena) return resultado

    await q(
      `UPDATE mailboxes
          SET status = 'ok', last_error = NULL, last_sync_at = now(),
              last_uid = GREATEST(last_uid, $2::bigint), updated_at = now()
        WHERE id = $1`,
      [id, ultimoUid]
    )
    const partes = [`${resultado.nuevos} mensaje(s) nuevo(s)`]
    if (resultado.parciales) {
      partes.push(
        `${resultado.parciales} grande(s) guardado(s) solo con cabeceras` +
        (fila.delete_after_import ? ' y conservado(s) en el servidor' : '')
      )
    }
    if (resultado.duplicados) partes.push(`${resultado.duplicados} repetido(s) omitido(s)`)
    if (resultado.omitidos) partes.push(`${resultado.omitidos} antiguo(s) no traído(s)`)
    if (resultado.desaparecidos) partes.push(`${resultado.desaparecidos} ya no estaba(n) en el servidor`)
    if (resultado.borrados) partes.push(`${resultado.borrados} borrado(s) del servidor`)
    if (noBorrados) partes.push(`${noBorrados} no se pudieron borrar del servidor`)
    if (resultado.pendientes) partes.push(`quedan ${resultado.pendientes} para la siguiente pasada`)
    resultado.ok = true
    resultado.detalle = partes.join(' · ')
    return resultado
  } catch (err) {
    const detalle = describirError(err, fila, contrasena)
    log.warn({ buzon: id, host: texto(fila.host), detalle }, 'fallo sincronizando el buzón')
    await q(
      `UPDATE mailboxes SET status = 'error', last_error = $2, last_sync_at = now(), updated_at = now() WHERE id = $1`,
      [id, detalle]
    ).catch((errDb) => log.error({ err: errDb, buzon: id }, 'no se pudo guardar el error del buzón'))
    return { ...resultado, ok: false, detalle }
  } finally {
    try {
      bloqueo?.release()
    } catch {
      // la conexión ya se había cerrado
    }
    await cerrarCliente(cliente)
    await liberarLock(id, token)
  }
}

/**
 * Prueba de conexión (botón «Probar conexión»): conecta, abre la carpeta en solo lectura y cuenta
 * los mensajes. Nunca lanza: → { ok, detalle, mensajes_en_servidor }. Actualiza status/last_error
 * del buzón salvo que esté en cuota_llena (ese estado lo levanta solo la sincronización).
 */
export async function probarBuzon(mailboxId, opciones = {}) {
  const log = registrador(opciones.log ?? estado.log)
  const id = Number(mailboxId)
  if (!Number.isInteger(id) || id <= 0) return { ok: false, detalle: 'Identificador de buzón no válido', mensajes_en_servidor: null }
  const fila = await filaBuzon(id)
  if (!fila) return { ok: false, detalle: 'El buzón no existe', mensajes_en_servidor: null }

  let cliente = null
  let contrasena = ''
  try {
    if (!(await destinoPermitido(fila.host))) {
      throw errorBuzon('El servidor IMAP apunta a una dirección de red interna: revisa el host de la cuenta', { permanente: true })
    }
    contrasena = contrasenaDe(fila)
    cliente = crearCliente(fila, contrasena, log)
    await conPlazo(cliente.connect(), PLAZO_CONEXION_MS, 'El servidor IMAP no respondió a tiempo al conectar')
    const carpeta = texto(fila.folder) || 'INBOX'
    const buzon = await conPlazo(cliente.mailboxOpen(carpeta, { readOnly: true }), PLAZO_CARPETA_MS, `No se pudo abrir la carpeta «${carpeta}» a tiempo`)
    const total = Number(buzon?.exists) || 0
    const puerto = Number(fila.port) || (fila.secure ? 993 : 143)
    const detalle =
      `Conexión y autenticación correctas con ${texto(fila.host)}:${puerto} (${fila.secure ? 'TLS' : 'STARTTLS'}) · ` +
      `carpeta «${carpeta}» con ${total} mensaje(s) en el servidor`
    await q(
      `UPDATE mailboxes
          SET status = CASE WHEN status = 'cuota_llena' THEN status ELSE 'ok' END,
              last_error = CASE WHEN status = 'cuota_llena' THEN last_error ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [id]
    ).catch(() => {})
    return { ok: true, detalle, mensajes_en_servidor: total }
  } catch (err) {
    const detalle = describirError(err, fila, contrasena)
    await q(`UPDATE mailboxes SET status = 'error', last_error = $2, updated_at = now() WHERE id = $1`, [id, detalle]).catch(() => {})
    return { ok: false, detalle, mensajes_en_servidor: null }
  } finally {
    await cerrarCliente(cliente)
  }
}

/**
 * Borra un mensaje en el servidor IMAP por UID (DELETE …?servidor=1). Devuelve true solo si el
 * mensaje seguía existiendo con ese UID (misma UIDVALIDITY) y se expulsó. Nunca lanza.
 */
export async function borrarEnServidor(mailboxId, uid, opciones = {}) {
  const log = registrador(opciones.log ?? estado.log)
  const id = Number(mailboxId)
  const u = Number(uid)
  if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(u) || u <= 0) return false
  const fila = await filaBuzon(id)
  if (!fila) return false

  let cliente = null
  let bloqueo = null
  let contrasena = ''
  try {
    if (!(await destinoPermitido(fila.host))) return false
    contrasena = contrasenaDe(fila)
    cliente = crearCliente(fila, contrasena, log)
    await conPlazo(cliente.connect(), PLAZO_CONEXION_MS, 'El servidor IMAP no respondió a tiempo al conectar')
    bloqueo = await cliente.getMailboxLock(texto(fila.folder) || 'INBOX', { acquireTimeout: PLAZO_CARPETA_MS })
    const buzon = cliente.mailbox
    const validez = buzon?.uidValidity !== undefined && buzon?.uidValidity !== null ? String(buzon.uidValidity) : null
    // con otra UIDVALIDITY el UID guardado apuntaría a un mensaje distinto: no se borra nada
    if (fila.uidvalidity !== null && fila.uidvalidity !== undefined && validez && String(fila.uidvalidity) !== validez) return false
    const encontrados = await cliente.search({ uid: String(u) }, { uid: true })
    if (!Array.isArray(encontrados) || !encontrados.map(Number).includes(u)) return false
    return await borrarUid(cliente, u, log, id)
  } catch (err) {
    log.warn({ buzon: id, uid: u, detalle: describirError(err, fila, contrasena) }, 'no se pudo borrar el mensaje en el servidor')
    return false
  } finally {
    try {
      bloqueo?.release()
    } catch {
      // la conexión ya se había cerrado
    }
    await cerrarCliente(cliente)
  }
}

// ---------------------------------------------------------------------------
// Bucle periódico
// ---------------------------------------------------------------------------

async function vuelta() {
  if (!estado.activo || estado.enCurso) return estado.enCurso
  estado.enCurso = (async () => {
    try {
      const { rows } = await q(
        `SELECT id FROM mailboxes
          WHERE enabled
            AND (last_sync_at IS NULL OR last_sync_at < now() - make_interval(mins => GREATEST(sync_interval_min, 1)))
          ORDER BY last_sync_at ASC NULLS FIRST, id ASC
          LIMIT $1`,
        [MAX_BUZONES_POR_VUELTA]
      )
      for (const fila of rows) {
        if (!estado.activo) break
        try {
          const r = await sincronizarBuzon(fila.id, { log: estado.log })
          if (r.nuevos || !r.ok) {
            estado.log.info({ buzon: fila.id, ok: r.ok, nuevos: r.nuevos, detalle: r.detalle }, 'buzón sincronizado')
          }
        } catch (err) {
          // sincronizarBuzon no lanza; esto cubre un fallo de la propia base de datos
          estado.log.error({ err, buzon: fila.id }, 'fallo inesperado sincronizando un buzón')
        }
      }
      estado.ultimaVuelta = new Date()
    } catch (err) {
      estado.log.error({ err }, 'fallo en la vuelta de sincronización del buzón')
    } finally {
      estado.enCurso = null
    }
  })()
  return estado.enCurso
}

/** Estado del bucle, para diagnóstico. */
export function estadoSyncBuzon() {
  return {
    activo: estado.activo,
    en_curso: Boolean(estado.enCurso),
    conexiones_abiertas: clientesActivos.size,
    ultima_vuelta: estado.ultimaVuelta ? estado.ultimaVuelta.toISOString() : null,
    cada_ms: CADA_MS,
  }
}

// src/index.js llama con el logger suelto (arrancarSyncBuzon(app.log)); se admite también { log }.
function normalizarOpciones(entrada) {
  const esLogger = entrada && typeof entrada.info === 'function' && typeof entrada.error === 'function'
  return esLogger ? { log: entrada } : { ...(entrada || {}) }
}

/** Arranca el bucle (idempotente): primera vuelta a los 5 s y luego cada 60 s. */
export function arrancarSyncBuzon(entrada = {}) {
  const opciones = normalizarOpciones(entrada)
  if (opciones.log) estado.log = registrador(opciones.log)
  if (estado.activo) return estadoSyncBuzon()

  estado.activo = true
  estado.parando = false
  estado.primera = setTimeout(() => {
    estado.primera = null
    vuelta().catch((err) => estado.log.error({ err }, 'fallo en la primera vuelta del buzón'))
  }, PRIMERA_PASADA_MS)
  estado.temporizador = setInterval(() => {
    vuelta().catch((err) => estado.log.error({ err }, 'fallo en la vuelta del buzón'))
  }, CADA_MS)
  if (typeof estado.primera.unref === 'function') estado.primera.unref()
  if (typeof estado.temporizador.unref === 'function') estado.temporizador.unref()

  estado.log.info({ cada_s: CADA_MS / 1000 }, 'sincronización del buzón arrancada')
  return estadoSyncBuzon()
}

/** Parada ordenada: no empieza buzones nuevos, espera a la vuelta en curso y cierra las conexiones. */
export async function pararSyncBuzon() {
  if (!estado.activo && !estado.enCurso && !clientesActivos.size) return estadoSyncBuzon()
  estado.activo = false
  estado.parando = true
  if (estado.primera) {
    clearTimeout(estado.primera)
    estado.primera = null
  }
  if (estado.temporizador) {
    clearInterval(estado.temporizador)
    estado.temporizador = null
  }

  if (estado.enCurso) {
    let vencido
    await Promise.race([
      estado.enCurso,
      new Promise((resolve) => {
        vencido = setTimeout(resolve, PLAZO_PARADA_MS)
      }),
    ])
    clearTimeout(vencido)
  }

  // lo que siga abierto (una descarga larga) se corta: la transacción pendiente se deshace y el
  // mensaje se vuelve a traer en la siguiente pasada
  for (const cliente of [...clientesActivos]) {
    clientesActivos.delete(cliente)
    try {
      cliente.close()
    } catch {
      // ya estaba cerrado
    }
  }
  estado.log.info('sincronización del buzón parada')
  return estadoSyncBuzon()
}

export default { sincronizarBuzon, probarBuzon, borrarEnServidor, arrancarSyncBuzon, pararSyncBuzon, estadoSyncBuzon }
