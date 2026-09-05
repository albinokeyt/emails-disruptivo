import crypto from 'node:crypto'
import nodemailer from 'nodemailer'
import { cabecerasExtra } from '../render.js'
import { construirDireccionVerp } from '../verp.js'

// Integración con cualquier SMTP genérico (SPEC §7), vía nodemailer.
//
// Lo que se sabe de verdad al enviar por SMTP es MUY poco: un 250 significa solo «acepto la
// responsabilidad de la entrega». No hay confirmación de bandeja, ni aperturas, ni rebotes por esta
// vía: los rebotes llegan después, de forma asíncrona, al Return-Path. Por eso el estado se queda en
// «enviado» salvo que el servidor rechace en el momento.
//
// Detalles que no son negociables:
//   · 587 → STARTTLS obligatorio (requireTLS). Sin él, si el servidor no anuncia STARTTLS el correo
//     saldría en claro con las credenciales del cliente por delante.
//   · 465 → TLS implícito (secure: true).
//   · Los tiempos de espera por defecto de nodemailer son altísimos (hasta 10 min): se bajan, porque
//     un socket colgado bloquea un carril del worker.

const TIEMPOS = {
  connectionTimeout: 15_000,
  greetingTimeout: 10_000,
  socketTimeout: 120_000,
  dnsTimeout: 10_000,
}

const POOL = { maxConnections: 5, maxMessages: 100 }
const INACTIVIDAD_MS = 10 * 60_000
const BARRIDO_MS = 60_000

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
const limpiar = (v, max = 400) => texto(v).replace(/[\r\n\t]+/g, ' ').slice(0, max)

function errorProveedor(mensaje, opciones = {}) {
  const err = new Error(mensaje)
  err.permanente = Boolean(opciones.permanente)
  err.proveedor = 'smtp'
  if (opciones.codigo != null) err.codigo = opciones.codigo
  if (opciones.credenciales) err.credenciales = true
  return err
}

/** Acepta "ana@x.com" y "Ana Ruiz <ana@x.com>". */
function soloDireccion(valor) {
  const bruto = texto(valor)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim()
}

/** Direcciones en el formato de nodemailer: { name, address }. */
function direcciones(valores) {
  const lista = Array.isArray(valores) ? valores : valores ? [valores] : []
  const salida = []
  for (const valor of lista) {
    const bruto = valor && typeof valor === 'object' ? valor : { email: valor }
    const address = soloDireccion(bruto?.email ?? bruto?.address)
    if (!address) continue
    const name = limpiar(bruto?.name ?? bruto?.nombre, 200)
    salida.push(name ? { name, address } : { address })
  }
  return salida
}

// References acumula un <id> por cada vuelta del hilo (SPEC §14): tiene más margen que el resto.
const MAX_VALOR_CABECERA = 900
const MAX_VALOR_REFERENCES = 4000

function cabecerasSmtp(cabeceras) {
  const salida = {}
  for (const [clave, valor] of Object.entries(cabeceras || {})) {
    const nombre = limpiar(clave, 100).replace(/[^A-Za-z0-9-]/g, '')
    const contenido = limpiar(valor, /^references$/i.test(nombre) ? MAX_VALOR_REFERENCES : MAX_VALOR_CABECERA)
    if (nombre && contenido) salida[nombre] = contenido
  }
  return salida
}

// ---------------------------------------------------------------------------
// Transportes: se reutilizan (pool) entre envíos del mismo proveedor
// ---------------------------------------------------------------------------

const transportes = new Map()

const nombreEhlo = () => {
  try {
    const host = new URL(String(process.env.APP_BASE_URL || '')).hostname
    return host || undefined
  } catch {
    return undefined
  }
}

function opcionesTransporte(credenciales = {}, config = {}, { pool = true } = {}) {
  const host = texto(config.host)
  if (!host) throw errorProveedor('Falta el servidor SMTP en la configuración del proveedor', { permanente: true })
  const puerto = Number(config.port) || (config.secure ? 465 : 587)
  const seguro = config.secure === undefined ? puerto === 465 : Boolean(config.secure)
  const usuario = texto(credenciales.user ?? credenciales.usuario)
  const clave = credenciales.pass ?? credenciales.password ?? ''
  if (!usuario || !clave) {
    throw errorProveedor('Faltan el usuario y la contraseña del SMTP en este proveedor', {
      permanente: true, credenciales: true,
    })
  }

  return {
    host,
    port: puerto,
    secure: seguro,
    // en el 587 el cifrado NO es opcional: si el servidor no ofrece STARTTLS, no se envía
    requireTLS: seguro ? undefined : config.requireTLS !== false,
    auth: { user: usuario, pass: String(clave) },
    name: nombreEhlo(),
    pool,
    ...(pool ? POOL : {}),
    ...TIEMPOS,
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: host },
  }
}

// La clave del caché incluye un hash de la contraseña: al rotarla en el panel, el transporte viejo
// deja de usarse solo. La contraseña en claro no entra nunca en la clave.
function claveTransporte(opciones) {
  const huella = crypto.createHash('sha256').update(String(opciones.auth?.pass ?? '')).digest('hex').slice(0, 16)
  return [opciones.host, opciones.port, opciones.secure, opciones.requireTLS, opciones.auth?.user, huella].join('|')
}

function transporteDe(credenciales, config) {
  const opciones = opcionesTransporte(credenciales, config, { pool: true })
  const clave = claveTransporte(opciones)
  const guardado = transportes.get(clave)
  if (guardado) {
    guardado.ultimoUso = Date.now()
    return guardado.transporte
  }
  const transporte = nodemailer.createTransport(opciones)
  transportes.set(clave, { transporte, ultimoUso: Date.now() })
  return transporte
}

function cerrarTransporte(clave) {
  const guardado = transportes.get(clave)
  if (!guardado) return
  transportes.delete(clave)
  try {
    guardado.transporte.close()
  } catch {
    // cerrar un pool ya cerrado no es un problema
  }
}

// Barrido de transportes inactivos: un servidor con muchas subcuentas acumularía un pool por
// proveedor y cada pool mantiene conexiones abiertas contra el SMTP del cliente.
const barrido = setInterval(() => {
  const limite = Date.now() - INACTIVIDAD_MS
  for (const [clave, guardado] of transportes) {
    if (guardado.ultimoUso < limite) cerrarTransporte(clave)
  }
}, BARRIDO_MS)
if (typeof barrido.unref === 'function') barrido.unref()

/** Cierra todos los pools abiertos (cierre ordenado del proceso). */
export function cerrarTransportes() {
  for (const clave of [...transportes.keys()]) cerrarTransporte(clave)
}

// ---------------------------------------------------------------------------
// Clasificación de errores
// ---------------------------------------------------------------------------

const CODIGOS_TEMPORALES = new Set(['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'ETIME', 'EDNS', 'ESTREAM', 'ECONNRESET', 'EPIPE'])

/**
 * Normaliza el error de nodemailer a la forma del SPEC (`err.permanente`).
 * 4xx del SMTP, red y tiempos de espera → temporal (se reintenta con retroceso).
 * 5xx, credenciales y contenido rechazado → permanente (reintentar solo empeora las cosas: con
 * EAUTH, a los pocos intentos el proveedor bloquea la cuenta del cliente).
 */
export function normalizarErrorSmtp(err) {
  if (err?.permanente !== undefined) return err

  const codigo = Number(err?.responseCode)
  const tieneCodigo = Number.isFinite(codigo) && codigo >= 100
  const nombre = texto(err?.code).toUpperCase()
  const respuesta = limpiar(err?.response || err?.message, 400) || 'error desconocido'

  let permanente
  let credenciales = false
  if (tieneCodigo) permanente = codigo >= 500
  if (nombre === 'EAUTH') {
    credenciales = true
    if (!tieneCodigo) permanente = true
  } else if (nombre === 'EENVELOPE' || nombre === 'EMESSAGE') {
    if (!tieneCodigo) permanente = true
  } else if (CODIGOS_TEMPORALES.has(nombre)) {
    if (!tieneCodigo) permanente = false
  }
  if (permanente === undefined) permanente = false // lo desconocido se reintenta, no se descarta

  const prefijo = credenciales
    ? 'El servidor SMTP rechazó las credenciales'
    : permanente
      ? 'El servidor SMTP rechazó el mensaje'
      : 'No se pudo enviar por SMTP'
  const detalles = [tieneCodigo ? String(codigo) : null, nombre || null].filter(Boolean).join(' ')

  const normalizado = errorProveedor(`${prefijo}${detalles ? ` (${detalles})` : ''}: ${respuesta}`, {
    permanente,
    codigo: tieneCodigo ? codigo : null,
    credenciales,
  })
  // El worker decide si un fallo permanente es además un rebote duro del DESTINATARIO
  // (rechazoDelDestinatario, SPEC §12.1) mirando err.rejected / err.recipient / err.response del
  // error original de nodemailer. Sin copiarlos al error normalizado esa señal directa se pierde y
  // la supresión quedaría colgando solo de las heurísticas de texto sobre el mensaje.
  if (Array.isArray(err?.rejected) && err.rejected.length) normalizado.rejected = err.rejected
  if (err?.recipient) normalizado.recipient = err.recipient
  if (err?.response) normalizado.response = String(err.response)
  return normalizado
}

// El id de cola del servidor viaja en la última línea de respuesta ("250 Ok: queued as XXXX") y es
// lo único que permite cruzar después con los logs del proveedor.
function idDeCola(respuesta) {
  const linea = texto(respuesta)
  const m = linea.match(/queued\s+as\s+([A-Za-z0-9._-]+)/i) || linea.match(/queued\s+on\s+\S+\s+as\s+(\S+)/i)
  return m ? m[1] : null
}

const normalizarMessageId = (v) => texto(v).replace(/^<+/, '').replace(/>+$/, '').trim()

export default {
  tipo: 'smtp',

  camposCredenciales: [
    { clave: 'user', etiqueta: 'Usuario', tipo: 'texto', requerido: true, ayuda: 'El usuario de la cuenta SMTP (a veces es «apikey»).' },
    { clave: 'pass', etiqueta: 'Contraseña o clave de API', tipo: 'password', requerido: true },
  ],

  camposConfig: [
    { clave: 'host', etiqueta: 'Servidor SMTP', tipo: 'texto', requerido: true, placeholder: 'smtp.proveedor.com' },
    { clave: 'port', etiqueta: 'Puerto', tipo: 'numero', requerido: true, valorPorDefecto: 587, ayuda: '587 con STARTTLS o 465 con SSL.' },
    { clave: 'secure', etiqueta: 'SSL/TLS implícito (puerto 465)', tipo: 'booleano', requerido: false },
    { clave: 'requireTLS', etiqueta: 'Exigir STARTTLS (puerto 587)', tipo: 'booleano', requerido: false, valorPorDefecto: true },
  ],

  /** Conexión + AUTH sin enviar nada (transporter.verify). Nunca lanza. */
  async validar(credenciales = {}, config = {}) {
    let transporte = null
    try {
      transporte = nodemailer.createTransport(opcionesTransporte(credenciales, config, { pool: false }))
      await transporte.verify()
      const puerto = Number(config.port) || (config.secure ? 465 : 587)
      const seguridad = config.secure ? 'SSL/TLS' : config.requireTLS === false ? 'sin cifrado obligatorio' : 'STARTTLS'
      return {
        ok: true,
        detalle: `Conexión y autenticación correctas con ${texto(config.host)}:${puerto} (${seguridad})`,
        cuenta: { host: texto(config.host), puerto, seguridad },
      }
    } catch (err) {
      return { ok: false, detalle: normalizarErrorSmtp(err).message, cuenta: null }
    } finally {
      try {
        transporte?.close()
      } catch {
        // nada que hacer si ya estaba cerrado
      }
    }
  },

  /** Envía el mensaje. Devuelve { providerMessageId, aceptado }. */
  async enviar(ctx = {}) {
    const de = direcciones(ctx.de)[0]
    const para = direcciones(ctx.para)
    const cc = direcciones(ctx.cc)
    const bcc = direcciones(ctx.bcc)
    const replyTo = direcciones(ctx.replyTo)[0]

    if (!de) throw errorProveedor('El mensaje no tiene remitente', { permanente: true })
    if (!para.length) throw errorProveedor('El mensaje no tiene destinatario', { permanente: true })
    const asunto = limpiar(ctx.asunto, 500)
    if (!asunto) throw errorProveedor('El mensaje no tiene asunto', { permanente: true })
    if (!ctx.html && !ctx.texto) throw errorProveedor('El mensaje no tiene contenido', { permanente: true })

    // Cabeceras de hilo de una respuesta del buzón (In-Reply-To/References, SPEC §14): render.js
    // ya las funde en ctx.cabeceras; si alguien llama a enviar() directamente puede pasarlas en
    // ctx.extraHeaders. Van con menos prioridad: las de la app nunca quedan pisadas.
    const cabeceras = cabecerasSmtp({ ...cabecerasExtra(ctx.extraHeaders ?? ctx.extra_headers), ...(ctx.cabeceras || {}) })
    const correlationId = limpiar(ctx.correlationId, 200)
    // Con SMTP no hay webhooks: la correlación se guarda en una cabecera propia para poder cruzar
    // con los logs del proveedor o con un rebote que llegue después.
    if (correlationId && !cabeceras['X-Correlation-Id']) cabeceras['X-Correlation-Id'] = correlationId

    const transporte = transporteDe(ctx.credenciales, ctx.config)

    // Return-Path propio (VERP, SPEC §11.2). Con SMTP_BOUNCE_DOMAIN definido, el sobre sale con
    // MAIL FROM = b.<correlation_id>@<dominio de rebotes>: el rebote asíncrono vuelve a esa
    // dirección y la pasarela lo atribuye al mensaje sin adivinar nada. El From VISIBLE no cambia.
    // Sin la variable (o con un correlationId no apto), construirDireccionVerp devuelve null y el
    // envío es idéntico al de siempre: nodemailer deriva el sobre de las cabeceras.
    // Ojo con DMARC: SPF se evalúa contra el dominio del Return-Path, así que con VERP deja de
    // alinear con el From del cliente; la alineación tiene que aportarla DKIM (INVESTIGACION.md A.2).
    const remitenteRebotes = construirDireccionVerp(correlationId)
    const sobreVerp = remitenteRebotes
      ? {
          envelope: {
            from: remitenteRebotes,
            // al fijar el sobre a mano hay que enumerar TODOS los destinatarios reales
            to: [...para, ...cc, ...bcc].map((d) => d.address),
          },
        }
      : {}

    let info
    try {
      info = await transporte.sendMail({
        from: de,
        to: para,
        ...(cc.length ? { cc } : {}),
        ...(bcc.length ? { bcc } : {}),
        ...(replyTo ? { replyTo } : {}),
        subject: asunto,
        ...(ctx.html ? { html: String(ctx.html) } : {}),
        ...(ctx.texto ? { text: String(ctx.texto) } : {}),
        ...(Object.keys(cabeceras).length ? { headers: cabeceras } : {}),
        ...sobreVerp,
      })
    } catch (err) {
      throw normalizarErrorSmtp(err)
    }

    // Con varios destinatarios la promesa se resuelve si al menos UNO fue aceptado: hay que mirar
    // `rejected` siempre, un try/catch no basta.
    const aceptados = Array.isArray(info?.accepted) ? info.accepted : []
    const rechazados = Array.isArray(info?.rejected) ? info.rejected : []
    if (!aceptados.length) {
      const primero = Array.isArray(info?.rejectedErrors) ? info.rejectedErrors[0] : null
      const rechazo = primero
        ? normalizarErrorSmtp(primero) // trae responseCode→codigo y recipient si nodemailer los dio
        : errorProveedor(
            `El servidor SMTP rechazó a todos los destinatarios: ${limpiar(info?.response, 300) || 'sin detalle'}`,
            { permanente: true }
          )
      // La lista de rechazados viaja SIEMPRE con el error: es la señal directa (sin heurísticas
      // de texto) con la que el worker suprime al destinatario rechazado (SPEC §12.1).
      if (!Array.isArray(rechazo.rejected) && rechazados.length) rechazo.rejected = rechazados
      if (rechazo.response === undefined && info?.response) rechazo.response = String(info.response)
      throw rechazo
    }

    const cola = idDeCola(info?.response)
    const partes = [limpiar(info?.response, 200) || 'aceptado']
    if (rechazados.length) partes.push(`rechazados: ${rechazados.length}`)

    return {
      providerMessageId: normalizarMessageId(info?.messageId) || cola || null,
      aceptado: true,
      detalle: partes.join(' · '),
      colaProveedor: cola,
      rechazados: rechazados.length,
    }
  },

  /** SMTP genérico no expone la lista de remitentes de la cuenta. */
  async listarRemitentes() {
    return null
  },

  /** Cierre ordenado: lo llama el worker al parar. */
  async cerrar() {
    cerrarTransportes()
  },
}
