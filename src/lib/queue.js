import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { q } from '../db.js'
import { redis } from '../redis.js'
import { descifrarCredenciales } from './crypto.js'
import { cerrarProveedores, obtenerProveedor } from './providers/index.js'
import { rateLimit } from './ratelimit.js'
import { destinoPermitido } from './red.js'
import { prepararMensaje } from './render.js'
import { getLimites } from './settings.js'
import { filtrarSuprimidos, normalizarEmail, suprimir } from './suppression.js'
import { dominioTrackingDe } from './tracking.js'

// ---------------------------------------------------------------------------
// Worker de envío.
//
// La cola es la propia tabla `messages`: las tres vías de entrada (los dos nodos de GHL y el relay
// SMTP) escriben ahí y el worker recoge. No hay broker: con FOR UPDATE SKIP LOCKED sobre el índice
// messages_cola_idx, varios procesos pueden reclamar trabajo a la vez sin pisarse y sin perder
// mensajes si uno muere a mitad (para eso está el rescate por locked_at).
//
// Reglas de la máquina de estados (SPEC §4):
//   · status_rank nunca retrocede por un evento externo (eso lo garantiza src/routes/webhooks.js);
//   · el worker SÍ devuelve un mensaje de 'enviando' a 'reintento', pero solo mientras siga siendo
//     suyo (guarda `AND status = 'enviando'`): si un webhook adelantó el estado, no se toca;
//   · los terminales (≥90) no se reintentan jamás.
// ---------------------------------------------------------------------------

/** Rango de cada estado (SPEC §4). */
export const RANGOS = Object.freeze({
  encolado: 0, reintento: 5, enviando: 10, enviado: 20, diferido: 25,
  entregado: 30, rebotado: 90, spam: 91, fallido: 92, suprimido: 93,
})

// Retroceso exponencial de los reintentos, en minutos. La longitud del array ES el número máximo
// de intentos: al agotarlos el mensaje pasa a 'fallido'.
const ESPERAS_MINUTOS = [1, 5, 15, 60, 180, 360]
export const MAX_INTENTOS = ESPERAS_MINUTOS.length

const ESPERA_SIN_TRABAJO_MS = 1_000
const ESPERA_TRAS_ERROR_MS = 5_000
const RESCATE_CADA_MS = 60_000
const RESCATE_TRAS_S = 600 // 10 min bloqueado en 'enviando' = el proceso que lo tenía murió
const TIEMPO_MAXIMO_ENVIO_MS = 180_000
const MAX_ESPERA_MS = 6 * 3_600_000

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
const limpiar = (v, max = 500) => texto(v).replace(/[\r\n\t]+/g, ' ').slice(0, max)

function entero(valor, porDefecto) {
  const n = Number(valor)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : porDefecto
}

function registrador(base) {
  const nada = () => {}
  const l = base && typeof base === 'object' ? base : console
  const metodo = (nombre, alternativa) =>
    typeof l[nombre] === 'function' ? l[nombre].bind(l) : alternativa
  const info = metodo('info', nada)
  return {
    info,
    warn: metodo('warn', info),
    error: metodo('error', info),
    debug: metodo('debug', nada),
  }
}

const estado = {
  activo: false,
  id: null,
  concurrencia: 0,
  carriles: [],
  enVuelo: new Set(),
  temporizador: null,
  log: registrador(null),
}

// ---------------------------------------------------------------------------
// Esperas interrumpibles: al parar, los carriles no se quedan durmiendo un segundo más
// ---------------------------------------------------------------------------

const durmientes = new Set()

function dormir(ms) {
  return new Promise((resolve) => {
    let entrada
    const temporizador = setTimeout(() => {
      durmientes.delete(entrada)
      resolve()
    }, ms)
    entrada = { resolve, temporizador }
    durmientes.add(entrada)
  })
}

function despertarTodos() {
  for (const entrada of durmientes) {
    clearTimeout(entrada.temporizador)
    entrada.resolve()
  }
  durmientes.clear()
}

function conTiempoLimite(promesa, ms, mensajeError) {
  let temporizador
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => {
      const err = new Error(mensajeError)
      err.permanente = false // un envío que tarda demasiado se reintenta, no se descarta
      rechazar(err)
    }, ms)
  })
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador))
}

// ---------------------------------------------------------------------------
// Acceso a la cola
// ---------------------------------------------------------------------------

/**
 * Reclama UN mensaje. El SKIP LOCKED es lo que permite varios workers a la vez: el que llega
 * segundo salta la fila bloqueada en vez de esperarla.
 */
async function reclamar() {
  const { rows: [mensaje] } = await q(
    `WITH candidato AS (
       SELECT id FROM messages
        WHERE status IN ('encolado','reintento') AND next_attempt_at <= now()
        ORDER BY next_attempt_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE messages m
        SET status = 'enviando',
            status_rank = GREATEST(m.status_rank, $2::int),
            locked_at = now(),
            locked_by = $1,
            attempts = m.attempts + 1,
            updated_at = now()
       FROM candidato c
      WHERE m.id = c.id
     RETURNING m.*`,
    [estado.id, RANGOS.enviando]
  )
  return mensaje ?? null
}

async function anotar(messageId, evento, dedupe, datos) {
  await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
     VALUES ($1,$2,now(),$3,$4::jsonb)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
    [messageId, evento, dedupe, JSON.stringify(datos ?? {})]
  )
}

async function marcarEnviado(mensaje, resultado, proveedor) {
  const idProveedor = limpiar(resultado?.providerMessageId, 300) || null
  await q(
    `UPDATE messages
        SET status = CASE WHEN status_rank < $3::int THEN 'enviado' ELSE status END,
            status_rank = GREATEST(status_rank, $3::int),
            sent_at = COALESCE(sent_at, now()),
            provider_message_id = COALESCE(provider_message_id, $2::text),
            last_error = NULL,
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1`,
    [mensaje.id, idProveedor, RANGOS.enviado]
  )
  await anotar(mensaje.id, 'enviado', `envio:${mensaje.attempts}`, {
    proveedor: proveedor?.type ?? null,
    proveedor_id: proveedor?.id ?? null,
    provider_message_id: idProveedor,
    detalle: limpiar(resultado?.detalle, 300) || null,
    intento: mensaje.attempts,
  })
}

async function marcarFallido(mensaje, motivo, datos = {}) {
  const texto500 = limpiar(motivo, 500)
  await q(
    `UPDATE messages
        SET status = 'fallido', status_rank = $3::int, last_error = $2,
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1 AND status = 'enviando'`,
    [mensaje.id, texto500, RANGOS.fallido]
  )
  await anotar(mensaje.id, 'fallido', `fallo:${mensaje.attempts}`, { error: texto500, intento: mensaje.attempts, ...datos })
}

async function marcarSuprimido(mensaje, supresion) {
  const motivo = `Destinatario en la lista de supresión (${supresion?.reason || 'manual'})`
  await q(
    `UPDATE messages
        SET status = 'suprimido', status_rank = $3::int, last_error = $2,
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1 AND status = 'enviando'`,
    [mensaje.id, motivo, RANGOS.suprimido]
  )
  await anotar(mensaje.id, 'suprimido', 'suprimido', { motivo: supresion?.reason || 'manual', origen: supresion?.source || null })
}

/**
 * Devuelve el mensaje a la cola tras un fallo temporal. Baja el rango de 'enviando' (10) a
 * 'reintento' (5) a propósito: la regla de no retroceder protege del desorden de los webhooks, no
 * del ciclo de vida del propio worker. La guarda `status='enviando'` asegura que solo se toca si
 * el mensaje sigue siendo nuestro.
 */
async function programarReintento(mensaje, motivo, esperaMs) {
  const cuando = new Date(Date.now() + esperaMs)
  await q(
    `UPDATE messages
        SET status = 'reintento', status_rank = $4::int, next_attempt_at = $2::timestamptz, last_error = $3,
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1 AND status = 'enviando'`,
    [mensaje.id, cuando, limpiar(motivo, 500), RANGOS.reintento]
  )
  await anotar(mensaje.id, 'reintento', `reintento:${mensaje.attempts}`, {
    error: limpiar(motivo, 500),
    intento: mensaje.attempts,
    proximo_intento: cuando.toISOString(),
  })
}

/**
 * Aplaza sin gastar un intento: el mensaje no ha fallado, es que toca esperar (ritmo de envío o
 * límite diario del proveedor). Por eso se descuenta el intento que sumó la reclamación.
 */
async function aplazar(mensaje, cuando, motivo) {
  await q(
    `UPDATE messages
        SET status = 'reintento', status_rank = $4::int, next_attempt_at = $2::timestamptz, last_error = $3,
            attempts = GREATEST(attempts - 1, 0),
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE id = $1 AND status = 'enviando'`,
    [mensaje.id, cuando, limpiar(motivo, 500), RANGOS.reintento]
  )
  estado.log.debug({ mensaje: mensaje.id, hasta: cuando.toISOString() }, 'envío aplazado por ritmo')
}

async function marcarProveedorEnError(proveedorId, detalle) {
  if (!proveedorId) return
  await q(
    `UPDATE providers SET status = 'error', last_error = $2, last_check_at = now(), updated_at = now()
      WHERE id = $1`,
    [proveedorId, limpiar(detalle, 500)]
  )
}

// ---------------------------------------------------------------------------
// Datos del mensaje
// ---------------------------------------------------------------------------

async function filaProveedor(id) {
  if (!id) return null
  const { rows: [p] } = await q(
    `SELECT id, name, type, credentials_enc, config, daily_limit, owner_scope, location_id
       FROM providers WHERE id = $1`,
    [id]
  )
  return p ?? null
}

async function filaRemitente(id) {
  if (!id) return null
  const { rows: [s] } = await q(
    'SELECT id, location_id, email, name, reply_to FROM senders WHERE id = $1',
    [id]
  )
  return s ?? null
}

// ---------------------------------------------------------------------------
// Ritmo de salida
//
// El hueco de envío por subcuenta (consumirLimiteEnvio) se consume ANTES de encolar, en el nodo y
// en el relay (SPEC §6): volver a consumirlo aquí gastaría dos unidades por mensaje y dejaría el
// límite configurado en la mitad. Lo que sí hace falta aquí es marcar el RITMO de salida, porque
// una tanda de reintentos vence toda junta y saldría de golpe contra el proveedor. Para eso se usa
// el limitador genérico de lib/ratelimit.js con su propio cubo, y un mensaje que no cabe se aplaza,
// nunca se descarta.
// ---------------------------------------------------------------------------

const inicioSiguienteMinuto = () => new Date(Math.floor(Date.now() / 60_000) * 60_000 + 61_000)
const inicioSiguienteDia = () => new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 + 86_400_000 + 5_000)

async function comprobarRitmo(mensaje, proveedor) {
  const limites = await getLimites()
  const porMinuto = entero(limites.envio_minuto, 0)
  if (porMinuto > 0) {
    const paso = await rateLimit(`ritmo-envio:${mensaje.location_id}`, porMinuto, 60)
    if (!paso.ok) {
      return {
        cuando: inicioSiguienteMinuto(),
        motivo: `En espera: esta subcuenta ya ha enviado ${porMinuto} correos este minuto`,
      }
    }
  }

  const diario = entero(proveedor?.daily_limit, 0)
  if (diario > 0) {
    const paso = await rateLimit(`proveedor-dia:${proveedor.id}`, diario, 86_400)
    if (!paso.ok) {
      return {
        cuando: inicioSiguienteDia(),
        motivo: `En espera: el proveedor «${proveedor.name}» ha alcanzado su límite de ${diario} envíos diarios`,
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Proceso de un mensaje
// ---------------------------------------------------------------------------

/** Retroceso exponencial con jitter, respetando el `esperarMs` que pida el proveedor (429). */
export function esperaDeReintento(intento, esperarMs = null) {
  const indice = Math.min(Math.max(Number(intento) || 1, 1) - 1, ESPERAS_MINUTOS.length - 1)
  const base = ESPERAS_MINUTOS[indice] * 60_000
  const pedida = Number(esperarMs)
  const elegida = Number.isFinite(pedida) && pedida > 0 ? Math.max(base, pedida) : base
  const jitter = 0.8 + Math.random() * 0.4 // ±20 %: evita que toda una tanda vuelva a la vez
  return Math.min(Math.round(elegida * jitter), MAX_ESPERA_MS)
}

// Estados ampliados 5.1.x que apuntan al buzón de DESTINO (RFC 3463): 5.1.1 no existe, 5.1.2 el
// sistema de destino no existe, 5.1.3 sintaxis mala, 5.1.4 ambigua, 5.1.6 buzón movido. Se excluyen
// a propósito 5.1.0 (ambiguo), y 5.1.7/5.1.8, que hablan del REMITENTE.
const RE_ESTADO_BUZON_DESTINO = /\b5\.1\.[1-46]\b/
// Frases con las que los MTA explican un buzón inexistente o inservible.
const RE_MOTIVO_DESTINATARIO =
  /user unknown|unknown user|no such (?:user|mailbox|recipient)|recipient address rejected|invalid (?:recipient|mailbox)|(?:recipient|mailbox)\s+(?:unknown|unavailable|not found|does not exist|disabled|rejected)|mailbox (?:full|is full)|account (?:disabled|does not exist)/i
// Si el texto habla del remitente, el rechazo no es del destinatario aunque sea un 5xx.
const RE_HABLA_DEL_REMITENTE = /\bsender\b|\bremitente\b|mail from|from address/i

/**
 * ¿El error permanente señala al DESTINATARIO? (SPEC §12.1)
 *
 * Solo entonces el fallo cuenta además como rebote duro: un error de credenciales, un remitente
 * rechazado o un contenido bloqueado también son permanentes, pero no dicen NADA de la dirección
 * de destino y suprimirla por ellos sería castigar a un contacto sano. Señales, por orden:
 *   · `err.rejected` de nodemailer (o `err.recipient`) con el destinatario dentro;
 *   · un 5xx del SMTP que cita la dirección del destinatario en la respuesta;
 *   · un 5xx con estado ampliado 5.1.x de buzón de destino o con las frases típicas de
 *     "usuario inexistente", siempre que el texto no esté hablando del remitente.
 */
function rechazoDelDestinatario(err, mensaje) {
  if (err?.permanente !== true || err?.credenciales) return false
  const destinatario = normalizarEmail(mensaje.to_email)
  if (!destinatario) return false

  const esDestinatario = (valor) =>
    normalizarEmail(valor && typeof valor === 'object' ? valor.address ?? valor.email : valor) === destinatario
  if (Array.isArray(err?.rejected) && err.rejected.some(esDestinatario)) return true
  if (err?.recipient && esDestinatario(err.recipient)) return true

  const codigo = Number(err?.codigo ?? err?.responseCode)
  if (codigo >= 500 && codigo < 600) {
    const textoError = `${err?.message ?? ''} ${err?.response ?? ''}`.toLowerCase()
    if (textoError.includes(destinatario)) return true
    if (RE_HABLA_DEL_REMITENTE.test(textoError)) return false
    if (RE_ESTADO_BUZON_DESTINO.test(textoError)) return true
    if (RE_MOTIVO_DESTINATARIO.test(textoError)) return true
  }
  return false
}

async function tratarFallo(mensaje, proveedor, err) {
  const motivo = limpiar(err?.message, 500) || 'Error desconocido al enviar'
  if (err?.credenciales) {
    // credenciales malas: se marca el proveedor en el panel para que el cliente lo vea y no se
    // insiste (a los pocos intentos, el proveedor bloquea la cuenta)
    await marcarProveedorEnError(proveedor?.id, motivo).catch(() => {})
  }
  if (err?.permanente === true) {
    estado.log.warn({ mensaje: mensaje.id, proveedor: proveedor?.id }, 'envío fallido de forma permanente')
    await marcarFallido(mensaje, motivo, { permanente: true, codigo: err?.codigo ?? null })
    // SPEC §12.1: el rechazo permanente del destinatario en el propio envío es un rebote duro
    // aunque nunca llegue un DSN ni un webhook. El alta con reason='rebote_duro' pasa por
    // lib/suppression.js, que es quien dispara el auto-DND (§12.4) sin bloquear este carril.
    if (rechazoDelDestinatario(err, mensaje)) {
      await suprimir(mensaje.location_id, mensaje.to_email, 'rebote_duro', 'envio', {
        ghlContactId: mensaje.ghl_contact_id || null,
        messageId: mensaje.id,
      }).catch((errSup) =>
        estado.log.error({ err: errSup, mensaje: mensaje.id }, 'no se pudo suprimir al destinatario rechazado')
      )
    }
    return
  }
  if (mensaje.attempts >= MAX_INTENTOS) {
    return marcarFallido(mensaje, `Se agotaron los ${MAX_INTENTOS} intentos de envío. Último error: ${motivo}`, {
      permanente: false, agotado: true, codigo: err?.codigo ?? null,
    })
  }
  return programarReintento(mensaje, motivo, esperaDeReintento(mensaje.attempts, err?.esperarMs))
}

async function procesarMensaje(mensaje) {
  if (mensaje.attempts > MAX_INTENTOS) {
    return marcarFallido(mensaje, `Se agotaron los ${MAX_INTENTOS} intentos de envío`, { agotado: true })
  }

  // Lista de supresión: se comprueba SIEMPRE justo antes de enviar, aunque ya se mirara al encolar.
  // Entre una cosa y otra pueden haber pasado horas y haber llegado un rebote duro o una baja.
  // Se miran destinatario, CC y BCC: quien va en copia también recibe el correo, así que un rebote
  // duro o una baja tienen que valer igual para él (mismo criterio que la pasarela SMTP).
  const bloqueados = await filtrarSuprimidos(
    mensaje.location_id,
    [mensaje.to_email, ...(mensaje.cc ?? []), ...(mensaje.bcc ?? [])]
  )
  const supresion = bloqueados.get(normalizarEmail(mensaje.to_email))
  // Solo el destinatario principal convierte el mensaje en terminal: que una copia esté suprimida
  // no puede impedir la entrega al resto.
  if (supresion) return marcarSuprimido(mensaje, supresion)

  const proveedor = await filaProveedor(mensaje.provider_id)
  if (!proveedor) {
    return marcarFallido(mensaje, 'El proveedor con el que se iba a enviar ya no existe: revísalo en la app de email')
  }
  if (proveedor.owner_scope === 'location' && proveedor.location_id !== mensaje.location_id) {
    // no debería pasar nunca; si pasa, es un fallo de aislamiento entre subcuentas y no se envía
    return marcarFallido(mensaje, 'El proveedor de este mensaje pertenece a otra subcuenta')
  }

  const remitente = await filaRemitente(mensaje.sender_id)
  if (!remitente) {
    return marcarFallido(mensaje, 'El remitente con el que se iba a enviar ya no existe: revísalo en la app de email')
  }
  if (remitente.location_id !== mensaje.location_id) {
    return marcarFallido(mensaje, 'El remitente de este mensaje pertenece a otra subcuenta')
  }

  const integracion = obtenerProveedor(proveedor.type)
  if (!integracion || typeof integracion.enviar !== 'function') {
    return marcarFallido(mensaje, `No hay integración disponible para proveedores de tipo «${proveedor.type}»`)
  }

  // El alta del proveedor (validarConfig) ya exige que el host sea un nombre de dominio público,
  // pero un nombre público puede resolver a 127.0.0.1, 169.254.169.254 o 10.x EN EL MOMENTO DEL
  // ENVÍO (rebinding, o un simple cambio del registro A posterior al alta). Se resuelve el DNS justo
  // antes de conectar: si no, el worker acaba sondeando la red interna del contenedor a petición del
  // cliente, con el resultado de vuelta en last_error.
  if (proveedor.type === 'smtp' && !(await destinoPermitido(proveedor.config?.host))) {
    return marcarFallido(
      mensaje,
      'El servidor SMTP de este proveedor apunta a una dirección de red interna: revisa el host en la app de email'
    )
  }

  const espera = await comprobarRitmo(mensaje, proveedor)
  if (espera) return aplazar(mensaje, espera.cuando, espera.motivo)

  let credenciales
  try {
    credenciales = descifrarCredenciales(proveedor.credentials_enc)
  } catch {
    // el mensaje del error de cifrado nunca lleva material sensible, pero tampoco aporta nada aquí
    return marcarFallido(
      mensaje,
      'No se pudieron descifrar las credenciales del proveedor: vuelve a guardarlas en la app de email'
    )
  }

  // Las copias suprimidas se quitan del mensaje que se COMPONE, no de la fila de `messages`: la
  // tabla guarda los destinatarios tal y como los pidió el workflow, que es lo que hay que poder
  // auditar después en el panel. Lo que no se entregó queda explicado en el histórico de eventos.
  let aEnviar = mensaje
  if (bloqueados.size) {
    const quitar = (lista) => {
      if (!Array.isArray(lista) || !lista.length) return lista
      const quedan = lista.filter((d) => !bloqueados.has(normalizarEmail(d)))
      return quedan.length ? quedan : null
    }
    aEnviar = { ...mensaje, cc: quitar(mensaje.cc), bcc: quitar(mensaje.bcc) }
    await anotar(mensaje.id, 'destinatarios_suprimidos', 'worker-supresion', {
      direcciones: Object.fromEntries([...bloqueados].map(([email, fila]) => [email, fila.reason])),
    }).catch(() => {})
  }

  // Dominio de tracking verificado de la subcuenta (SPEC §11.3): render.js lo usa para el pixel
  // y los enlaces; si es null, sigue con APP_BASE_URL como hasta ahora.
  const dominioTracking = await dominioTrackingDe(mensaje.location_id)

  let compuesto
  try {
    compuesto = await prepararMensaje(aEnviar, {
      remitente: { email: remitente.email, name: remitente.name, reply_to: remitente.reply_to },
      etiquetas: [`loc:${mensaje.location_id}`],
      dominioTracking,
      // lo que llega por el relay ya viene sustituido por GHL: sus {{llaves}} son texto literal
      conservarDesconocidas: mensaje.origin === 'relay',
    })
  } catch (err) {
    return marcarFallido(mensaje, `No se pudo componer el mensaje: ${limpiar(err?.message, 300)}`)
  }

  try {
    const resultado = await conTiempoLimite(
      integracion.enviar({
        ...compuesto,
        credenciales,
        config: proveedor.config || {},
        locationId: mensaje.location_id,
        mensajeId: mensaje.id,
      }),
      TIEMPO_MAXIMO_ENVIO_MS,
      'El proveedor no respondió dentro del tiempo máximo de envío'
    )
    await marcarEnviado(mensaje, resultado || {}, proveedor)
    estado.log.debug({ mensaje: mensaje.id, proveedor: proveedor.type }, 'mensaje enviado')
  } catch (err) {
    await tratarFallo(mensaje, proveedor, err)
  }
}

// ---------------------------------------------------------------------------
// Rescate de mensajes bloqueados (el proceso que los tenía murió a mitad)
// ---------------------------------------------------------------------------

async function rescatarBloqueados() {
  // Lock suave: basta con que barra una instancia. Si Redis no está, se barre igual (es idempotente).
  try {
    const tomado = await redis.set('worker:rescate', estado.id, 'EX', 55, 'NX')
    if (tomado !== 'OK') return 0
  } catch {
    // sin Redis no hay coordinación, pero el UPDATE es seguro aunque lo lancen dos instancias
  }

  const { rows } = await q(
    `UPDATE messages
        SET status = 'reintento', status_rank = $2::int, next_attempt_at = now(),
            locked_at = NULL, locked_by = NULL,
            last_error = 'El proceso que estaba enviando este mensaje se interrumpió',
            updated_at = now()
      WHERE status = 'enviando' AND locked_at < now() - make_interval(secs => $1::int)
     RETURNING id, attempts`,
    [RESCATE_TRAS_S, RANGOS.reintento]
  )
  if (!rows.length) return 0

  const cubo = new Date().toISOString().slice(0, 16)
  for (const fila of rows) {
    await anotar(fila.id, 'rescatado', `rescate:${cubo}`, { intento: fila.attempts }).catch(() => {})
  }
  estado.log.warn({ rescatados: rows.length }, 'mensajes devueltos a la cola tras quedarse bloqueados')
  return rows.length
}

// ---------------------------------------------------------------------------
// Entrega inferida (SPEC §11.2)
//
// Con SMTP genérico nadie confirma la entrega: el proveedor solo confirma el primer salto. Si tras
// INFERENCIA_ENTREGA_HORAS (48 por defecto) un mensaje 'enviado' no ha recibido rebote ni spam, se
// promociona a 'entregado' con el evento 'entrega_inferida' y data.inferido=true. El panel lo
// distingue del confirmado: la inferencia nunca se vende como una confirmación real.
// ---------------------------------------------------------------------------

const INFERENCIA_LOTE = 500 // mensajes por pasada: acota el UPDATE, nunca se barre la tabla entera

const horasInferencia = () => entero(process.env.INFERENCIA_ENTREGA_HORAS, 48)

async function inferirEntregas() {
  // Lock suave como el del rescate: basta con que barra una instancia por ciclo.
  try {
    const tomado = await redis.set('worker:inferencia', estado.id, 'EX', 55, 'NX')
    if (tomado !== 'OK') return 0
  } catch {
    // sin Redis se barre igual: el FOR UPDATE SKIP LOCKED evita que dos instancias se pisen
  }

  const horas = horasInferencia()
  // El filtro por status='enviado' ya descarta lo rebotado/diferido/spam (esos eventos cambian el
  // estado), pero el NOT EXISTS cubre los rebotes que NO tocan el estado (rebote_desconocido, o un
  // rebote blando llegado con el mensaje ya en otro estado): con cualquier señal negativa no se infiere.
  const { rows } = await q(
    `WITH candidatos AS (
       SELECT id FROM messages
        WHERE status = 'enviado'
          AND sent_at < now() - make_interval(hours => $1::int)
          AND NOT EXISTS (
            SELECT 1 FROM message_events e
             WHERE e.message_id = messages.id
               AND e.event IN ('rebote','rebote_duro','rebote_blando','rebote_desconocido','bloqueado','email_invalido','spam')
          )
        ORDER BY sent_at
        LIMIT $2
        FOR UPDATE SKIP LOCKED
     )
     UPDATE messages m
        SET status = 'entregado', status_rank = GREATEST(m.status_rank, $3::int), updated_at = now()
       FROM candidatos c
      WHERE m.id = c.id AND m.status = 'enviado'
     RETURNING m.id`,
    [horas, INFERENCIA_LOTE, RANGOS.entregado]
  )
  if (!rows.length) return 0

  for (const fila of rows) {
    await anotar(fila.id, 'entrega_inferida', 'entrega_inferida', { inferido: true, horas }).catch(() => {})
  }
  estado.log.info({ inferidos: rows.length, horas }, 'mensajes promovidos a entregado por inferencia')
  return rows.length
}

/** Suelta lo que este proceso tenía bloqueado y no llegó a enviar (cierre ordenado). */
async function liberarMisBloqueados() {
  const enVuelo = [...estado.enVuelo]
  const { rowCount } = await q(
    `UPDATE messages
        SET status = 'reintento', status_rank = $3::int, next_attempt_at = now(),
            locked_at = NULL, locked_by = NULL, updated_at = now()
      WHERE status = 'enviando' AND locked_by = $1
        AND NOT (id = ANY($2::bigint[]))`,
    [estado.id, enVuelo, RANGOS.reintento]
  )
  if (rowCount) estado.log.info({ liberados: rowCount }, 'mensajes devueltos a la cola al parar el worker')
  return rowCount
}

// ---------------------------------------------------------------------------
// Carriles
// ---------------------------------------------------------------------------

async function carril() {
  while (estado.activo) {
    let mensaje = null
    try {
      mensaje = await reclamar()
    } catch (err) {
      estado.log.error({ err }, 'el worker no pudo reclamar trabajo de la cola')
      await dormir(ESPERA_TRAS_ERROR_MS)
      continue
    }

    if (!mensaje) {
      await dormir(ESPERA_SIN_TRABAJO_MS + Math.floor(Math.random() * 250))
      continue
    }

    estado.enVuelo.add(mensaje.id)
    try {
      await procesarMensaje(mensaje)
    } catch (err) {
      // Un fallo aquí es un bug nuestro (base de datos caída a mitad, por ejemplo): el mensaje no
      // puede quedarse bloqueado en 'enviando' esperando al rescate.
      estado.log.error({ err, mensaje: mensaje.id }, 'fallo inesperado procesando un mensaje')
      await programarReintento(
        mensaje,
        `Fallo interno del worker: ${limpiar(err?.message, 300) || 'error desconocido'}`,
        esperaDeReintento(mensaje.attempts)
      ).catch(() => {})
    } finally {
      estado.enVuelo.delete(mensaje.id)
    }
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/** Estado actual del worker, para /healthz y para los logs. */
export function estadoWorker() {
  return {
    activo: estado.activo,
    id: estado.id,
    concurrencia: estado.concurrencia,
    en_vuelo: estado.enVuelo.size,
    max_intentos: MAX_INTENTOS,
  }
}

/**
 * Normaliza el primer argumento del arranque/parada. src/index.js invoca los procesos de fondo como
 * `iniciar(app.log, { log: app.log, config })`, es decir, pasando el logger SUELTO como primer
 * argumento; otros sitios llaman con un objeto de opciones. Se aceptan las dos formas: si lo que
 * llega parece un logger (tiene .info y .error) se envuelve como { log }, y sin él quedaría
 * registrador(undefined) → console, perdiendo el logger de pino.
 */
function normalizarOpciones(entrada, extra) {
  const esLogger = entrada && typeof entrada.info === 'function' && typeof entrada.error === 'function'
  const base = esLogger ? { log: entrada } : { ...(entrada || {}) }
  return { ...base, ...(extra && typeof extra === 'object' ? extra : {}), log: base.log ?? extra?.log }
}

/**
 * Arranca el worker. Idempotente: llamarlo dos veces no duplica carriles.
 * Opciones: { log, concurrencia, habilitado }.
 */
export function arrancarWorker(entrada = {}, extra = undefined) {
  const opciones = normalizarOpciones(entrada, extra)
  estado.log = registrador(opciones.log)
  if (estado.activo) return estadoWorker()

  const habilitado =
    opciones.habilitado !== undefined
      ? Boolean(opciones.habilitado)
      : String(process.env.WORKER_HABILITADO ?? 'true').trim().toLowerCase() !== 'false'
  if (!habilitado) {
    estado.log.warn('worker de envío desactivado (WORKER_HABILITADO=false): los mensajes se quedarán en cola')
    return estadoWorker()
  }

  const concurrencia = Math.min(
    entero(opciones.concurrencia ?? process.env.WORKER_CONCURRENCIA, 5),
    50
  )

  estado.activo = true
  estado.concurrencia = concurrencia
  estado.id = `${hostname()}/${process.pid}/${randomBytes(3).toString('hex')}`.slice(0, 120)
  estado.enVuelo.clear()
  estado.carriles = Array.from({ length: concurrencia }, () => carril())

  // Barrido al arrancar: si el despliegue anterior se cayó, sus mensajes vuelven a la cola ya.
  rescatarBloqueados().catch((err) => estado.log.error({ err }, 'fallo en el rescate inicial de mensajes'))
  inferirEntregas().catch((err) => estado.log.error({ err }, 'fallo en la inferencia inicial de entregas'))
  estado.temporizador = setInterval(() => {
    rescatarBloqueados().catch((err) => estado.log.error({ err }, 'fallo rescatando mensajes bloqueados'))
    inferirEntregas().catch((err) => estado.log.error({ err }, 'fallo infiriendo entregas'))
  }, RESCATE_CADA_MS)
  if (typeof estado.temporizador.unref === 'function') estado.temporizador.unref()

  estado.log.info({ worker: estado.id, concurrencia }, 'worker de envío arrancado')
  return estadoWorker()
}

/** Parada ordenada: deja de reclamar, espera a lo que hay en vuelo y suelta los bloqueos. */
export async function pararWorker(entrada = {}, extra = undefined) {
  const opciones = normalizarOpciones(entrada, extra)
  if (opciones.log) estado.log = registrador(opciones.log)
  const esperaMs = entero(opciones.esperaMs, 20_000)
  if (!estado.activo) {
    await cerrarProveedores()
    return estadoWorker()
  }

  estado.activo = false
  despertarTodos()
  if (estado.temporizador) {
    clearInterval(estado.temporizador)
    estado.temporizador = null
  }

  const carriles = Promise.allSettled(estado.carriles)
  let vencido
  await Promise.race([
    carriles,
    new Promise((resolve) => {
      vencido = setTimeout(resolve, esperaMs)
    }),
  ])
  clearTimeout(vencido)
  estado.carriles = []

  try {
    await liberarMisBloqueados()
  } catch (err) {
    estado.log.error({ err }, 'no se pudieron liberar los mensajes bloqueados al parar')
  }
  await cerrarProveedores()

  estado.log.info('worker de envío parado')
  const final = estadoWorker()
  estado.id = null
  estado.concurrencia = 0
  return final
}

// Alias por comodidad de quien monta el arranque de la app.
export const iniciarWorker = arrancarWorker
export const detenerWorker = pararWorker

export default { arrancarWorker, pararWorker, estadoWorker, esperaDeReintento, RANGOS, MAX_INTENTOS }
