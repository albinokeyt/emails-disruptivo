import { createHash, randomBytes } from 'node:crypto'
import { simpleParser } from 'mailparser'
import { q } from '../db.js'
import { consumirLimiteEnvio } from '../lib/ratelimit.js'
import { suprimir } from '../lib/suppression.js'
import { capturaRebotesActiva, parsearDireccionVerp, parsearDsn } from '../lib/verp.js'
import {
  cabecera,
  cargarCuentaRelay,
  errorSmtp,
  esEmail,
  normalizarDireccion,
  resolverRuta,
  suprimidos,
  textoSmtp,
} from './routing.js'

// ---------------------------------------------------------------------------
// Recepción del mensaje: se parsea el MIME, se enruta por el `From` (routing.js) y se encola en la
// MISMA tabla `messages` que usan los nodos propios, con origin='relay'. A partir de ahí el worker
// no distingue de dónde vino el correo: historial y estados son únicos (SPEC §1).
//
// Hay una segunda entrada, mucho más estrecha: los REBOTES (SPEC §11.2). Cuando la sesión NO está
// autenticada, el único tráfico admitido son los avisos DSN que vuelven a las direcciones VERP
// b.<correlation_id>@<SMTP_BOUNCE_DOMAIN> de mensajes que existen de verdad. Esa rama no encola
// nada: parsea el DSN y actualiza el estado del mensaje al que pertenece el rebote.
// ---------------------------------------------------------------------------

// Límites que NO son opcionales: sin ellos la pasarela quema la IP y el dominio de la agencia.
const MAX_DESTINATARIOS = 50 // por transacción SMTP; GHL no aplica throttling propio
const MAX_ASUNTO = 500
const MAX_NOMBRE = 200
const MAX_HTML = 1_000_000 // mismo techo que los nodos propios (src/routes/actions.js)

// Un DSN legítimo trae UN destinatario VERP (una dirección por mensaje). Se dejan unos pocos de
// margen por si un MTA agrupa, pero nada parecido al límite del correo autenticado.
const MAX_DESTINATARIOS_REBOTE = 5

// Tope de RCPT RECHAZADOS por sesión sin autenticar. El límite de arriba solo cuenta los aceptados:
// sin este otro, un anónimo podría encadenar RCPT inválidos sin fin y cada uno con pinta de VERP
// costaría una consulta a la base de datos. Superado el tope se responde 421 a todo, sin tocar ya
// la base. Un MTA legítimo entrega un DSN a UNA dirección: jamás acumula tantos rechazos.
const MAX_RCPT_RECHAZADOS = 15

// Mensaje único para las dos ramas 550 del RCPT sin autenticar (patrón no-VERP y correlation_id
// desconocido): responder distinto convertiría el RCPT en un oráculo que confirma qué
// correlation_id existen. Hoy no son adivinables, pero el oráculo no cuesta nada cerrarlo.
const RECHAZO_REBOTE = 'Este servidor solo acepta avisos de rebote de sus propios envios'

const RANGO_ENCOLADO = 0
const RANGO_SUPRIMIDO = 93 // SPEC §4: 'suprimido' es terminal
const RANGO_DIFERIDO = 25 // SPEC §4
const RANGO_REBOTADO = 90 // SPEC §4: terminal

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

const ipDe = (session) => texto(session?.remoteAddress).replace(/^::ffff:/, '') || 'desconocida'

/**
 * Identificador de correlación propio del relay (viaja luego en X-Mailin-custom).
 *
 * Nunca lleva un punto: el redirector de aperturas (src/routes/tracking.js) parte por el último
 * punto para separar id y firma, y un correlation_id con puntos rompería esa lectura.
 *
 * Si el mensaje trae Message-ID se deriva de él: GHL puede reintentar la entrega tras un 4xx y el
 * mismo Message-ID no debe generar dos envíos. El cubo horario evita bloquear un reenvío legítimo
 * meses después con un cliente que reutilice identificadores.
 */
function idCorrelacion(locationId, messageId, destinos, cubo) {
  if (!messageId) return `r-${randomBytes(16).toString('hex')}`
  const base = JSON.stringify([locationId, messageId, [...destinos].sort(), cubo])
  return `r-${createHash('sha256').update(base).digest('hex').slice(0, 32)}`
}

/** Direcciones del sobre SMTP: es lo que de verdad hay que entregar, mande lo que mande la cabecera. */
function destinatariosDelSobre(session) {
  const vistos = new Set()
  for (const r of session?.envelope?.rcptTo || []) {
    const email = normalizarDireccion(r?.address)
    if (email && esEmail(email)) vistos.add(email)
  }
  return [...vistos]
}

/** Direcciones de una cabecera ya parseada (`to`, `cc`), con su nombre visible. */
function direccionesDe(campo) {
  const salida = new Map()
  for (const v of campo?.value || []) {
    const email = normalizarDireccion(v?.address)
    if (email) salida.set(email, texto(v?.name))
  }
  return salida
}

/**
 * Reparte los destinatarios del sobre entre `to`, `cc` y `bcc`. Se guarda UNA fila por mensaje
 * (igual que los nodos propios), no una por destinatario: así el worker hace un solo envío y nadie
 * recibe copias duplicadas.
 *
 * Quien venía en `To` o en `Cc` se queda en copia VISIBLE aunque no pueda ser el destinatario
 * principal (la tabla solo guarda un `to_email`): pasarlo a `bcc` lo ocultaría de una lista en la
 * que el remitente lo había puesto a la vista. A `bcc` solo van los que ya eran copia ciega, es
 * decir, los que están en el sobre y en ninguna cabecera.
 */
function repartirDestinatarios(destinos, cabeceraTo, cabeceraCc) {
  const principal = destinos.find((d) => cabeceraTo.has(d)) ?? destinos[0]
  const resto = destinos.filter((d) => d !== principal)
  const cc = resto.filter((d) => cabeceraTo.has(d) || cabeceraCc.has(d))
  const bcc = resto.filter((d) => !cabeceraTo.has(d) && !cabeceraCc.has(d))
  return {
    to: principal,
    toName: cabecera(cabeceraTo.get(principal), MAX_NOMBRE) || null,
    cc: cc.length ? cc : null,
    bcc: bcc.length ? bcc : null,
  }
}

// ---------------------------------------------------------------------------
// MAIL FROM y RCPT TO
// ---------------------------------------------------------------------------

const sesionAutenticada = (session) => Boolean(texto(session?.user?.locationId))

/**
 * MAIL FROM. Con la sesión autenticada no se filtra nada aquí (igual que siempre: el enrutado real
 * se decide por el `From` de cabecera en DATA). Sin autenticar solo se sigue adelante si la captura
 * de rebotes está activa, y se admite cualquier remitente de sobre —incluido el vacío `<>`, que es
 * el remitente OBLIGATORIO de un DSN según RFC 5321—, porque el filtro de verdad es el RCPT: un
 * rebote se identifica por la dirección VERP a la que llega, no por quién dice enviarlo.
 */
export function crearOnMailFrom() {
  return function onMailFrom(address, session, callback) {
    if (sesionAutenticada(session)) return callback()
    if (!capturaRebotesActiva()) {
      // smtp-server solo deja llegar aquí sin AUTH cuando authOptional está activo, y ese flag solo
      // se enciende con SMTP_BOUNCE_DOMAIN definido; esta guarda cubre el caso de que la variable
      // se retire en caliente entre el arranque y la sesión.
      return callback(errorSmtp(530, 'Autenticacion obligatoria'))
    }
    return callback()
  }
}

/**
 * Se corta aquí y no en DATA para no tragarse megas de un mensaje que se va a rechazar igual.
 * 452 (temporal) y no 550: es un límite de la pasarela, no un problema de la dirección.
 *
 * La lista de supresión NO se mira aquí a propósito: responder distinto según la dirección exista o
 * no en ella convertiría el RCPT en un oráculo de datos del cliente. Se comprueba al encolar y el
 * mensaje queda registrado como 'suprimido' en el historial (SPEC §6.6).
 *
 * Sin sesión autenticada la regla es otra y es cerrada (SPEC §11.2): TODOS los RCPT tienen que ser
 * direcciones VERP b.<correlation_id>@<SMTP_BOUNCE_DOMAIN> de mensajes que EXISTEN en `messages`;
 * cualquier otra cosa se rechaza con 550. Sin esta regla, aceptar correo sin autenticar convertiría
 * el servidor en un buzón abierto: cualquiera podría descargarle spam, usarlo para backscatter o
 * fabricarse rebotes de mensajes inventados. Con ella, lo único que un desconocido puede hacer es
 * entregar un aviso sobre un envío que realmente salió de esta app.
 */
export function crearOnRcptTo(log) {
  return function onRcptTo(address, session, callback) {
    if (!sesionAutenticada(session)) {
      if (!capturaRebotesActiva()) return callback(errorSmtp(530, 'Autenticacion obligatoria'))

      // Sesión con demasiados rechazos acumulados: 421 en seco, sin mirar nada más. El contador
      // vive en el objeto de sesión de smtp-server, que persiste durante toda la conexión.
      const rechazados = Number(session.rcptVerpRechazados) || 0
      if (rechazados >= MAX_RCPT_RECHAZADOS) {
        return callback(errorSmtp(421, 'Demasiados destinatarios invalidos, cierra la conexion'))
      }
      const rechazar = (codigo, mensaje) => {
        session.rcptVerpRechazados = rechazados + 1
        return callback(errorSmtp(codigo, mensaje))
      }

      if ((session?.envelope?.rcptTo?.length ?? 0) >= MAX_DESTINATARIOS_REBOTE) {
        return rechazar(452, 'Demasiados destinatarios para un aviso de rebote')
      }
      const correlacion = parsearDireccionVerp(address?.address)
      if (!correlacion) {
        // 550 y no 4xx: no es temporal, esta dirección no va a existir nunca. Es el cierre que
        // impide usar el puerto de rebotes como buzón o como relay.
        return rechazar(550, RECHAZO_REBOTE)
      }
      q('SELECT 1 FROM messages WHERE correlation_id = $1', [correlacion]).then(
        ({ rows }) => {
          if (!rows.length) {
            return rechazar(550, RECHAZO_REBOTE)
          }
          return callback()
        },
        (err) => {
          // Base de datos caída: 451 para que el MTA que rebota lo reintente, el aviso no se pierde.
          log?.error?.({ err, sesion: session?.id }, 'relay: no se pudo comprobar una direccion de rebote')
          return callback(errorSmtp(451, 'No se pudo comprobar la direccion ahora mismo, reintentalo'))
        }
      )
      return
    }

    if ((session?.envelope?.rcptTo?.length ?? 0) >= MAX_DESTINATARIOS) {
      return callback(errorSmtp(452, `Demasiados destinatarios en un mismo mensaje (maximo ${MAX_DESTINATARIOS})`))
    }
    if (!esEmail(address?.address)) {
      return callback(errorSmtp(501, 'La direccion de destino no es una direccion de correo valida'))
    }
    return callback()
  }
}

// ---------------------------------------------------------------------------
// DATA: parsear, enrutar y encolar
// ---------------------------------------------------------------------------

async function procesar({ crudo, session, log }) {
  const locationId = texto(session?.user?.locationId)
  if (!locationId) throw errorSmtp(530, 'Sesion sin autenticar')

  let mail
  try {
    mail = await simpleParser(crudo)
  } catch {
    // MIME ilegible: reintentarlo daría exactamente el mismo resultado.
    throw errorSmtp(550, 'No se ha podido leer el mensaje: el MIME esta mal formado')
  }

  // El esquema guarda asunto y cuerpo, no adjuntos, así que aceptar un correo con adjuntos sería
  // entregarlo mutilado sin que nadie se entere. Mejor decirlo en claro y que el workflow lo vea.
  if (mail.attachments?.length) {
    throw errorSmtp(
      554,
      'Este relay no reenvia adjuntos: usa el nodo "Enviar email personalizado" de la app de email para enviarlos'
    )
  }

  const cuenta = await cargarCuentaRelay(locationId)
  const ruta = await resolverRuta({
    locationId,
    cuenta,
    from: mail.from?.value?.[0]?.address,
    nombre: mail.from?.value?.[0]?.name,
    log,
  })
  if (!ruta.ok) throw errorSmtp(ruta.codigo, ruta.mensaje)

  const destinosSobre = destinatariosDelSobre(session)
  if (!destinosSobre.length) throw errorSmtp(554, 'El mensaje no lleva ningun destinatario valido')

  const asunto = cabecera(mail.subject, MAX_ASUNTO) || '(sin asunto)'
  const html = typeof mail.html === 'string' && mail.html ? mail.html : null
  const plano = typeof mail.text === 'string' && mail.text ? mail.text : null
  if (html && html.length > MAX_HTML) {
    throw errorSmtp(552, `El cuerpo HTML supera el maximo admitido (${MAX_HTML} caracteres)`)
  }

  const replyBruto = normalizarDireccion(mail.replyTo?.value?.[0]?.address) || texto(ruta.sender.reply_to)
  const replyTo = replyBruto && esEmail(replyBruto) ? cabecera(replyBruto, 320) : null

  // ── Paso 6a: lista de supresión ───────────────────────────────────────────
  const bloqueados = await suprimidos(locationId, destinosSobre)
  const destinos = destinosSobre.filter((d) => !bloqueados.has(d))

  const cabeceraTo = direccionesDe(mail.to)
  const cabeceraCc = direccionesDe(mail.cc)
  const reparto = destinos.length
    ? repartirDestinatarios(destinos, cabeceraTo, cabeceraCc)
    : { to: destinosSobre[0], toName: null, cc: null, bcc: null }

  const todoSuprimido = destinos.length === 0
  const estado = todoSuprimido ? 'suprimido' : 'encolado'
  const rango = todoSuprimido ? RANGO_SUPRIMIDO : RANGO_ENCOLADO
  const ultimoError = todoSuprimido
    ? `Destinatario en la lista de supresión (${bloqueados.get(destinosSobre[0]) ?? 'manual'})`
    : null

  // ── Idempotencia frente a los reintentos de GHL ───────────────────────────
  const cubo = Math.floor(Date.now() / 3_600_000)
  const messageId = cabecera(mail.messageId, 300)
  const correlacion = idCorrelacion(locationId, messageId, destinosSobre, cubo)
  const correlacionPrevia = idCorrelacion(locationId, messageId, destinosSobre, cubo - 1)
  if (messageId) {
    const { rows: [previo] } = await q(
      'SELECT id, status FROM messages WHERE correlation_id = ANY($1::text[])',
      [[correlacion, correlacionPrevia]]
    )
    if (previo) return { id: previo.id, estado: previo.status, repetido: true, suprimidos: bloqueados.size }
  }

  // ── Paso 6b: límite de envíos de la subcuenta ─────────────────────────────
  // Se consume DESPUÉS de la idempotencia (un reintento de GHL no debe gastar cuota dos veces) y
  // solo por los destinatarios que van a salir de verdad: los suprimidos no consumen hueco.
  if (!todoSuprimido) {
    const cupo = await consumirLimiteEnvio(locationId, { unidades: destinos.length })
    if (!cupo.ok) {
      // 451 temporal: el correo no se pierde, se aplaza. GHL dispara los workflows de golpe y sin
      // freno propio, así que esta es la única barrera contra quemar la reputación del dominio.
      throw errorSmtp(451, cupo.motivo || 'Limite de envios de la subcuenta alcanzado, reintentalo en unos minutos')
    }
  }

  const { rows: [insertado] } = await q(
    `INSERT INTO messages (location_id, provider_id, sender_id, template_id, origin, status, status_rank,
                           to_email, to_name, cc, bcc, reply_to, subject, preheader, html, text,
                           ghl_contact_id, ghl_workflow_id, correlation_id, last_error)
     VALUES ($1,$2,$3,NULL,'relay',$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,$13,NULL,NULL,$14,$15)
     ON CONFLICT (correlation_id) DO NOTHING
     RETURNING id, status`,
    [
      locationId, ruta.providerId, ruta.sender.id, estado, rango,
      reparto.to, reparto.toName, reparto.cc, reparto.bcc, replyTo, asunto,
      html, plano ?? (html ? null : ''), correlacion, ultimoError,
    ]
  )

  if (!insertado) {
    // El DO NOTHING saltó: otra conexión encoló el mismo mensaje a la vez. Se devuelve el suyo.
    const { rows: [existente] } = await q('SELECT id, status FROM messages WHERE correlation_id = $1', [correlacion])
    if (!existente) throw errorSmtp(451, 'No se ha podido encolar el mensaje, reintentalo')
    return { id: existente.id, estado: existente.status, repetido: true, suprimidos: bloqueados.size }
  }

  // Destinatarios suprimidos parcialmente: queda escrito en el histórico del mensaje para que el
  // usuario vea en el panel por qué a esa dirección no le llegó nada.
  if (bloqueados.size && !todoSuprimido) {
    await q(
      `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
       VALUES ($1,'destinatarios_suprimidos', now(), 'relay-supresion', $2::jsonb)
       ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
      [insertado.id, JSON.stringify({ direcciones: Object.fromEntries(bloqueados) })]
    ).catch((err) => log?.warn?.({ err, mensaje: insertado.id }, 'relay: no se pudo registrar la supresion parcial'))
  }

  return { id: insertado.id, estado: insertado.status, repetido: false, suprimidos: bloqueados.size }
}

// ---------------------------------------------------------------------------
// DATA sin autenticar: captura de rebotes (SPEC §11.2)
//
// RIESGO ASUMIDO (documentado a propósito): la dirección VERP no va firmada. Un tercero no puede
// falsificar un DSN de un mensaje ajeno (el correlation_id son 128 bits aleatorios o un SHA-256
// truncado, no adivinables), pero el DESTINATARIO de un mensaje sí conoce el suyo —viaja en la
// cabecera X-Correlation-Id del propio correo— y puede fabricar un DSN 5.x.x que marque SU mensaje
// como 'rebotado' (ensucia las métricas del remitente) y suprima su propia dirección; con el
// fallback al to_email, alguien en copia puede provocar la supresión del destinatario principal
// (dirección que ya ve en el propio correo). La supresión está acotada a direcciones DEL mensaje,
// nunca ajenas, así que el daño posible se queda dentro de ese sobre. El endurecimiento estándar
// (Mailgun/SendGrid) es firmar la parte local VERP —b.<id>.<hmac> verificado en
// parsearDireccionVerp—; se descarta en esta fase por no complicar el formato de dirección.
// ---------------------------------------------------------------------------

const diaDe = (fecha) => fecha.toISOString().slice(0, 10)

const resumen = (valor) => createHash('sha1').update(String(valor ?? '')).digest('hex').slice(0, 12)

/** Evento del histórico con dedupe: la idempotencia vive en UNIQUE(message_id, dedupe_key). */
async function anotarEventoRebote(messageId, evento, dedupe, datos) {
  const { rows: [nuevo] } = await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
     VALUES ($1,$2,now(),$3,$4::jsonb)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING
     RETURNING id`,
    [messageId, evento, dedupe, JSON.stringify(datos ?? {})]
  )
  return Boolean(nuevo)
}

/** Datos comunes de un bloque del DSN para dejarlos en el histórico (sin nada sensible). */
const datosDeBloque = (bloque, dsn) => ({
  fuente: 'verp',
  accion: bloque?.accion ?? null,
  status: bloque?.status ?? null,
  diagnostico: bloque?.diagnostico ?? null,
  destinatario: bloque?.destinatario ?? null,
  mta_remoto: bloque?.mtaRemoto ?? null,
  mta_reportante: dsn?.mtaReportante ?? null,
})

/**
 * Aplica UN bloque del DSN a UN mensaje, respetando la máquina de estados del SPEC §4 con el mismo
 * patrón que src/routes/webhooks.js: status_rank nunca retrocede (el CASE WHEN status_rank < rango).
 *
 *   5.x.x (duro)   → estado 'rebotado' + alta en suppressions + evento 'rebote'
 *   4.x.x (blando) → evento 'rebote_blando'; si el mensaje estaba 'enviado' pasa a 'diferido'
 *   otra cosa      → evento 'rebote_desconocido' sin tocar el estado
 */
async function aplicarBloqueDsn(mensaje, bloque, dsn) {
  const datos = datosDeBloque(bloque, dsn)

  if (bloque.clase === 'duro') {
    const dedupe = `verp:rebote:${bloque.status ?? 'sin-status'}:${resumen(bloque.destinatario ?? mensaje.to_email)}`
    const nuevo = await anotarEventoRebote(mensaje.id, 'rebote', dedupe, datos)

    // El UPDATE de estado y la supresión se ejecutan SIEMPRE, también cuando el evento ya existía:
    // si un intento anterior murió entre el INSERT del evento y estos pasos (se respondió 451 y el
    // MTA reenvió el DSN), el reintento llega aquí con el evento duplicado, y cortarse en el dedupe
    // dejaría el mensaje en 'enviado' para siempre —con la inferencia dándolo por 'entregado' a las
    // 48 h—. Ambas operaciones son idempotentes por construcción (CASE por status_rank aquí y
    // ON CONFLICT DO NOTHING en suppressions), así que repetirlas no cuesta nada.
    const motivo = `Rebote duro (${bloque.status ?? 'DSN'})${bloque.diagnostico ? `: ${bloque.diagnostico}` : ''}`.slice(0, 500)
    await q(
      `UPDATE messages
          SET status = CASE WHEN status_rank < $2::int THEN 'rebotado' ELSE status END,
              status_rank = CASE WHEN status_rank < $2::int THEN $2::int ELSE status_rank END,
              last_error = CASE WHEN status_rank < $2::int THEN $3 ELSE last_error END,
              updated_at = now()
        WHERE id = $1`,
      [mensaje.id, RANGO_REBOTADO, motivo]
    )

    // La dirección que se suprime es la del propio DSN SOLO si era destinataria de este mensaje:
    // el correlation_id no es secreto (viaja en X-Correlation-Id y lo ve el destinatario), así que
    // aceptar cualquier Final-Recipient dejaría fabricar supresiones de direcciones ajenas.
    const delMensaje = new Set(
      [mensaje.to_email, ...(mensaje.cc ?? []), ...(mensaje.bcc ?? [])].map(normalizarDireccion).filter(Boolean)
    )
    const candidata = normalizarDireccion(bloque.destinatario)
    const aSuprimir = candidata && delMensaje.has(candidata) ? candidata : normalizarDireccion(mensaje.to_email)
    // El ghl_contact_id del mensaje es el del destinatario PRINCIPAL (los mensajes del relay no lo
    // traen, pero los de los nodos que salen por SMTP con VERP sí): solo se vincula cuando el que
    // rebota es él, nunca una copia. El alta por suppression.js dispara el auto-DND (SPEC §12.4).
    const esPrincipal = aSuprimir === normalizarDireccion(mensaje.to_email)
    await suprimir(mensaje.location_id, aSuprimir, 'rebote_duro', 'verp:dsn', {
      ghlContactId: esPrincipal ? mensaje.ghl_contact_id || null : null,
      messageId: mensaje.id,
    })
    return { evento: 'rebote', repetido: !nuevo }
  }

  if (bloque.clase === 'blando') {
    // Cubo diario en el dedupe: el MTA remoto puede mandar un aviso de retraso por cada reintento
    // durante días, y conviene ver esa persistencia en el histórico sin apuntar cada repetición.
    const dedupe = `verp:blando:${bloque.status ?? 'sin-status'}:${resumen(bloque.destinatario ?? mensaje.to_email)}:${diaDe(new Date())}`
    const nuevo = await anotarEventoRebote(mensaje.id, 'rebote_blando', dedupe, datos)

    // Mismo criterio que el duro: el UPDATE se aplica aunque el evento estuviera repetido, para
    // cubrir el reintento del MTA tras un fallo a medias entre el INSERT y el cambio de estado.
    // Solo 'enviado' pasa a 'diferido' (SPEC §11.2): un blando no adelanta un estado menor ni
    // retrocede 'entregado' o un terminal. El doble filtro (status y rango) lo garantiza.
    await q(
      `UPDATE messages
          SET status = 'diferido', status_rank = $2::int, updated_at = now()
        WHERE id = $1 AND status = 'enviado' AND status_rank < $2::int`,
      [mensaje.id, RANGO_DIFERIDO]
    )
    return { evento: 'rebote_blando', repetido: !nuevo }
  }

  const dedupe = `verp:desconocido:${diaDe(new Date())}:${resumen(`${bloque.accion ?? ''}|${bloque.status ?? ''}|${bloque.diagnostico ?? ''}`)}`
  const nuevo = await anotarEventoRebote(mensaje.id, 'rebote_desconocido', dedupe, datos)
  return { evento: 'rebote_desconocido', repetido: !nuevo }
}

/**
 * Procesa lo que llega a una dirección VERP sin autenticar. onRcptTo ya garantizó que TODOS los
 * RCPT son direcciones VERP de mensajes existentes; aquí se parsea el DSN y se aplica.
 *
 * Al emisor de un rebote se le responde SIEMPRE 250 (también cuando el contenido no es un DSN
 * legible): un MTA que rebota no debe reintentar la entrega del aviso, y devolverle un error solo
 * generaría más tráfico de backscatter. Los únicos errores que salen de aquí son los de nuestra
 * propia base de datos (451, para que el aviso se reintente y no se pierda).
 */
async function procesarRebote({ crudo, session, log }) {
  const correlaciones = [
    ...new Set(
      (session?.envelope?.rcptTo || [])
        .map((r) => parsearDireccionVerp(r?.address))
        .filter(Boolean)
    ),
  ]
  if (!correlaciones.length) throw errorSmtp(550, RECHAZO_REBOTE)

  let mail = null
  try {
    // keepDeliveryStatus: sin esta opción mailparser funde message/delivery-status en `text` en
    // vez de entregarlo como adjunto, y el DSN quedaría irreconocible para parsearDsn.
    mail = await simpleParser(crudo, { keepDeliveryStatus: true })
  } catch {
    // MIME ilegible: se registra como desconocido igualmente, el aviso llegó a una dirección válida
    mail = null
  }
  const dsn = mail ? parsearDsn(mail) : { esDsn: false, mtaReportante: null, destinatarios: [] }

  const aplicados = []
  for (const correlacion of correlaciones) {
    const { rows: [mensaje] } = await q(
      `SELECT id, location_id, to_email, cc, bcc, status, status_rank, ghl_contact_id
         FROM messages WHERE correlation_id = $1`,
      [correlacion]
    )
    // Pudo borrarse entre el RCPT y el DATA: no queda nada que anotar y reintentar no lo arregla.
    if (!mensaje) continue

    if (!dsn.esDsn || !dsn.destinatarios.length) {
      // Correo a b.<corr>@… que no es un DSN válido: se deja constancia sin tocar el estado.
      const dedupe = `verp:desconocido:${diaDe(new Date())}:${resumen(`${texto(mail?.from?.text)}|${texto(mail?.subject)}`)}`
      await anotarEventoRebote(mensaje.id, 'rebote_desconocido', dedupe, {
        fuente: 'verp',
        motivo: dsn.esDsn ? 'DSN sin bloques de destinatario' : 'el contenido no es un DSN',
        remitente: texto(mail?.from?.value?.[0]?.address).slice(0, 320) || null,
        asunto: texto(mail?.subject).slice(0, 200) || null,
      })
      aplicados.push({ mensaje: mensaje.id, evento: 'rebote_desconocido' })
      continue
    }

    for (const bloque of dsn.destinatarios) {
      const resultado = await aplicarBloqueDsn(mensaje, bloque, dsn)
      aplicados.push({ mensaje: mensaje.id, evento: resultado.evento, repetido: resultado.repetido })
    }
  }

  return { correlaciones: correlaciones.length, aplicados }
}

/**
 * Construye el `onData` que espera smtp-server.
 * @param {object} opciones
 * @param {number} opciones.maxSize  tamaño máximo del mensaje (SMTP_RELAY_MAX_SIZE)
 * @param {object} [opciones.log]    logger tipo pino/fastify
 */
export function crearOnData({ maxSize, log } = {}) {
  const tope = Number(maxSize) > 0 ? Number(maxSize) : 26_214_400

  return function onData(stream, session, callback) {
    const trozos = []
    let bytes = 0
    let respondido = false

    // El callback tiene que dispararse exactamente una vez: si se llama dos veces smtp-server manda
    // dos respuestas al mismo DATA y descoloca la conversación con GHL.
    const responder = (err, mensaje) => {
      if (respondido) return
      respondido = true
      callback(err, mensaje)
    }

    stream.on('error', (err) => {
      log?.warn?.({ err, sesion: session?.id }, 'relay: error leyendo el DATA')
      responder(errorSmtp(451, 'Error leyendo el mensaje, reintentalo'))
    })

    stream.on('data', (trozo) => {
      bytes += trozo.length
      // Se sigue drenando el stream aunque ya sobre tamaño (hay que consumirlo entero para que la
      // conexión no se quede colgada), pero no se guarda en memoria ni un byte de más.
      if (bytes <= tope) trozos.push(trozo)
    })

    stream.on('end', () => {
      if (stream.sizeExceeded || bytes > tope) {
        return responder(errorSmtp(552, `El mensaje supera el tamano maximo admitido (${tope} bytes)`))
      }

      const crudo = Buffer.concat(trozos)

      // Sesión sin autenticar = tráfico de rebotes (onMailFrom/onRcptTo ya lo acotaron a VERP).
      if (!sesionAutenticada(session)) {
        procesarRebote({ crudo, session, log }).then(
          (res) => {
            log?.info?.(
              { sesion: session?.id, ip: ipDe(session), correlaciones: res.correlaciones, aplicados: res.aplicados, bytes },
              'relay: aviso de rebote procesado'
            )
            responder(null, textoSmtp('Aviso de entrega procesado'))
          },
          (err) => {
            if (err?.responseCode) {
              log?.warn?.({ sesion: session?.id, ip: ipDe(session), codigo: err.responseCode, motivo: err?.message }, 'relay: aviso de rebote rechazado')
              return responder(errorSmtp(Number(err.responseCode), err.message))
            }
            // Fallo nuestro (Postgres…): 451 para que el MTA reintente y el rebote no se pierda.
            log?.error?.({ err, sesion: session?.id, ip: ipDe(session) }, 'relay: fallo procesando un aviso de rebote')
            responder(errorSmtp(451, 'No se pudo procesar el aviso ahora mismo, reintentalo'))
          }
        )
        return
      }

      procesar({ crudo, session, log }).then(
        (res) => {
          log?.info?.(
            {
              sesion: session?.id,
              ip: ipDe(session),
              location: session?.user?.locationId,
              mensaje: res.id,
              estado: res.estado,
              repetido: res.repetido,
              suprimidos: res.suprimidos,
              bytes,
            },
            'relay: mensaje encolado'
          )
          const aviso = res.estado === 'suprimido' ? ' (destinatario en la lista de supresion)' : ''
          responder(null, textoSmtp(`Mensaje aceptado id=${res.id}${aviso}`))
        },
        (err) => {
          const codigo = Number(err?.responseCode) || 451
          if (codigo >= 500 && codigo < 600) {
            log?.warn?.(
              { sesion: session?.id, ip: ipDe(session), location: session?.user?.locationId, codigo, motivo: err?.message },
              'relay: mensaje rechazado'
            )
          } else if (err?.responseCode) {
            log?.info?.(
              { sesion: session?.id, location: session?.user?.locationId, codigo, motivo: err?.message },
              'relay: mensaje aplazado'
            )
          } else {
            // Error inesperado (Postgres, Redis…): nunca se le enseña la traza al cliente SMTP.
            log?.error?.({ err, sesion: session?.id, location: session?.user?.locationId }, 'relay: fallo procesando el mensaje')
          }
          responder(
            err?.responseCode
              ? errorSmtp(codigo, err.message)
              : errorSmtp(451, 'La app de email no ha podido procesar el mensaje, reintentalo')
          )
        }
      )
    })
  }
}
