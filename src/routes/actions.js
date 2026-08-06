import crypto from 'node:crypto'
import { q } from '../db.js'
import { consumirLimiteEnvio } from '../lib/ratelimit.js'
import { filtrarSuprimidos } from '../lib/suppression.js'

// Nodos de workflow de GHL (Custom Workflow Actions).
//   POST /api/ghl/accion/plantilla/:secreto        → ejecución del nodo "Enviar email con plantilla"
//   POST /api/ghl/accion/personalizado/:secreto    → ejecución del nodo "Enviar email personalizado"
//   POST /api/ghl/dinamico/plantilla/:secreto      → campo Dynamic del nodo 1 (remitente + plantilla)
//   POST /api/ghl/dinamico/personalizado/:secreto  → campo Dynamic del nodo 2 (remitente)
//
// GHL manda siempre {data:{…campos…}, extras:{locationId, contactId, workflowId}, meta:{key, version}}.
// Los desplegables "External API" NO reciben contexto: el filtrado por subcuenta solo es posible en el
// endpoint del campo Dynamic, que sí recibe extras.locationId.

// Clave pública Ed25519 publicada por HighLevel para X-GHL-Signature.
const CLAVE_GHL_ED25519 =
  '-----BEGIN PUBLIC KEY-----\n' +
  'MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=\n' +
  '-----END PUBLIC KEY-----\n'

const MAX_ASUNTO = 500
const MAX_NOMBRE = 200
const MAX_HTML = 1_000_000
const MAX_DESTINATARIOS_COPIA = 20
const RANGO_ENCOLADO = 0
const RANGO_SUPRIMIDO = 93 // §4 del SPEC: 'suprimido' es terminal

const RE_EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

function fallo(codigo, mensaje) {
  const err = new Error(mensaje)
  err.codigo = codigo
  return err
}

function igualSeguro(a, b) {
  const x = Buffer.from(String(a ?? ''), 'utf8')
  const y = Buffer.from(String(b ?? ''), 'utf8')
  if (x.length === 0 || x.length !== y.length) return false
  return crypto.timingSafeEqual(x, y)
}

// El secreto de la URL es lo que autentica de verdad a GHL (la firma no está confirmada para nodos).
// Se cachea unos segundos porque el endpoint Dynamic se llama en ráfagas mientras el usuario configura.
let cacheSecreto = { valor: null, expira: 0 }
async function secretoAccion() {
  if (cacheSecreto.expira > Date.now()) return cacheSecreto.valor
  const { rows: [fila] } = await q(`SELECT value FROM settings WHERE key = 'ghl'`)
  const valor = fila?.value?.action_secret ? String(fila.value.action_secret) : null
  cacheSecreto = { valor, expira: Date.now() + 15_000 }
  return valor
}

async function exigirSecreto(req) {
  const esperado = await secretoAccion()
  if (!esperado) throw fallo(503, 'La app de email todavía no tiene configurado el secreto de las acciones')
  if (!igualSeguro(req.params?.secreto, esperado)) throw fallo(401, 'Secreto de acción no válido')
}

// La firma solo se verifica si llega Y si el bootstrap guardó el cuerpo crudo: sin cuerpo original no
// hay nada que comprobar y la seguridad se apoya en el secreto de la URL.
function firmaAceptable(req) {
  const firma = req.headers['x-ghl-signature']
  if (!firma || firma === 'N/A') return true
  const crudo = req.rawBody ?? req.raw?.rawBody
  if (!crudo) return true
  try {
    const cuerpo = Buffer.isBuffer(crudo) ? crudo : Buffer.from(String(crudo), 'utf8')
    return crypto.verify(null, cuerpo, CLAVE_GHL_ED25519, Buffer.from(String(firma), 'base64'))
  } catch {
    return false
  }
}

// Los "Reference" de los campos los teclea una persona en el panel del Marketplace y los campos que
// genera el bloque Dynamic pueden llegar anidados: se buscan varios alias y un nivel de anidamiento.
function leerCampo(data, ...claves) {
  if (!data || typeof data !== 'object') return undefined
  const util = (v) => v !== undefined && v !== null && v !== ''
  for (const clave of claves) if (util(data[clave])) return data[clave]
  for (const valor of Object.values(data)) {
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      for (const clave of claves) if (util(valor[clave])) return valor[clave]
    }
  }
  return undefined
}

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

// Inyección de cabeceras de correo: \r y \n fuera de asunto, nombres y reply-to.
const limpiarCabecera = (v, max) => texto(v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max)

// Acepta "ana@x.com" y "Ana Ruiz <ana@x.com>"
function normalizarEmail(v) {
  const bruto = texto(v)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim()
}

function esEmail(v) {
  const e = normalizarEmail(v)
  return e.length > 0 && e.length <= 320 && RE_EMAIL.test(e)
}

function parseLista(v, etiqueta) {
  if (v === undefined || v === null || v === '') return null
  const bruto = Array.isArray(v) ? v : String(v).split(/[,;\n]/)
  const lista = []
  for (const parte of bruto) {
    const email = normalizarEmail(parte)
    if (!email) continue
    if (!esEmail(email)) throw fallo(400, `La dirección "${email}" del campo ${etiqueta} no es válida`)
    lista.push(email)
  }
  return lista.length ? lista : null
}

const canonico = (v) => {
  if (Array.isArray(v)) return v.map(canonico)
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonico(v[k]); return acc }, {})
  }
  return v
}

// Idempotencia frente a los reintentos de GHL: mismo contacto + mismo workflow + mismos datos dentro de
// la misma hora = el mismo mensaje. El cubo horario evita bloquear reenvíos legítimos meses después.
function idCorrelacion(locationId, extras, meta, data, cubo) {
  const contactId = texto(extras?.contactId)
  if (!contactId) return `n-${crypto.randomBytes(16).toString('hex')}`
  const base = JSON.stringify([
    locationId, contactId, texto(extras?.workflowId), texto(meta?.key), texto(meta?.version),
    canonico(data ?? {}), cubo,
  ])
  return `n-${crypto.createHash('sha256').update(base).digest('hex').slice(0, 32)}`
}

// ---------------------------------------------------------------------------
// Resolución de subcuenta, proveedor, remitente y plantilla
// ---------------------------------------------------------------------------

async function subcuentaViva(locationId) {
  if (!locationId) throw fallo(400, 'GHL no envió la subcuenta (extras.locationId) en la ejecución del nodo')
  const { rows: [conn] } = await q('SELECT * FROM connections WHERE location_id = $1', [locationId])
  if (!conn) throw fallo(400, 'Esta subcuenta no tiene instalada la app de email: instálala desde el Marketplace')
  if (conn.status === 'uninstalled') throw fallo(400, 'La app de email fue desinstalada de esta subcuenta: vuelve a instalarla')
  return conn
}

const SQL_PROVEEDORES_VISIBLES = `
  SELECT p.*
    FROM providers p
   WHERE (
           (p.owner_scope = 'location' AND p.location_id = $1)
        OR (p.owner_scope = 'admin' AND EXISTS (
              SELECT 1 FROM provider_assignments a
               WHERE a.provider_id = p.id AND a.location_id = $1))
         )
     AND ($2::text IS NULL OR p.type = $2)
   ORDER BY (p.status = 'ok') DESC, (p.owner_scope = 'location') DESC, p.id`

// El valor puede llegar como id numérico (lo normal) o como tipo ('brevo'/'smtp') si el select del nodo
// se configuró con constantes. Se admiten los dos y, si no llega nada, manda el proveedor del remitente.
async function resolverProveedor(valor, locationId, remitente) {
  const bruto = texto(valor)
  if (/^\d+$/.test(bruto)) {
    const { rows: [p] } = await q(
      `SELECT p.* FROM providers p
        WHERE p.id = $1 AND (
              (p.owner_scope = 'location' AND p.location_id = $2)
           OR (p.owner_scope = 'admin' AND EXISTS (
                 SELECT 1 FROM provider_assignments a
                  WHERE a.provider_id = p.id AND a.location_id = $2)))`,
      [Number(bruto), locationId]
    )
    if (!p) throw fallo(400, 'El proveedor elegido en el nodo no existe o no pertenece a esta subcuenta')
    return p
  }

  const tipo = ['brevo', 'smtp'].includes(bruto.toLowerCase()) ? bruto.toLowerCase() : null
  const { rows: candidatos } = await q(SQL_PROVEEDORES_VISIBLES, [locationId, tipo])
  if (!candidatos.length) {
    throw fallo(400, tipo
      ? `Esta subcuenta no tiene ningún proveedor de tipo ${tipo} configurado en la app de email`
      : 'Esta subcuenta no tiene ningún proveedor de email configurado: créalo en la app de email')
  }
  if (remitente?.provider_id) {
    const propio = candidatos.find((p) => String(p.id) === String(remitente.provider_id))
    if (propio) return propio
  }
  return candidatos[0]
}

async function resolverRemitente(valor, locationId) {
  const bruto = texto(valor)
  if (/^\d+$/.test(bruto)) {
    const { rows: [s] } = await q('SELECT * FROM senders WHERE id = $1 AND location_id = $2', [Number(bruto), locationId])
    if (!s) throw fallo(400, 'El remitente elegido en el nodo no existe en esta subcuenta')
    return s
  }
  if (bruto && esEmail(bruto)) {
    const { rows: [s] } = await q('SELECT * FROM senders WHERE location_id = $1 AND email = $2', [locationId, normalizarEmail(bruto)])
    if (!s) throw fallo(400, `El remitente ${normalizarEmail(bruto)} no está dado de alta en esta subcuenta`)
    return s
  }
  const { rows: [pordefecto] } = await q(
    'SELECT * FROM senders WHERE location_id = $1 ORDER BY is_default DESC, id ASC LIMIT 1', [locationId])
  if (!pordefecto) throw fallo(400, 'Esta subcuenta no tiene remitentes: da de alta uno en la app de email')
  return pordefecto
}

async function resolverPlantilla(valor, locationId) {
  const bruto = texto(valor)
  if (!bruto) throw fallo(400, 'Falta la plantilla en la configuración del nodo')
  if (/^\d+$/.test(bruto)) {
    const { rows: [t] } = await q(
      'SELECT * FROM templates WHERE id = $1 AND (location_id = $2 OR location_id IS NULL)',
      [Number(bruto), locationId]
    )
    if (!t) throw fallo(400, 'La plantilla elegida en el nodo no existe o no está disponible para esta subcuenta')
    return t
  }
  const { rows: [t] } = await q(
    `SELECT * FROM templates WHERE name = $1 AND (location_id = $2 OR location_id IS NULL)
      ORDER BY (location_id IS NOT NULL) DESC, id ASC LIMIT 1`,
    [bruto, locationId]
  )
  if (!t) throw fallo(400, `No existe ninguna plantilla llamada "${bruto}" en esta subcuenta`)
  return t
}

// ---------------------------------------------------------------------------
// Ejecución de los nodos
// ---------------------------------------------------------------------------

async function ejecutar(req, reply, origen) {
  try {
    await exigirSecreto(req)
    if (!firmaAceptable(req)) throw fallo(401, 'Firma de HighLevel no válida')

    const cuerpo = req.body && typeof req.body === 'object' ? req.body : {}
    const data = cuerpo.data && typeof cuerpo.data === 'object' ? cuerpo.data : {}
    const extras = cuerpo.extras && typeof cuerpo.extras === 'object' ? cuerpo.extras : {}
    const meta = cuerpo.meta && typeof cuerpo.meta === 'object' ? cuerpo.meta : {}
    const locationId = texto(extras.locationId)

    await subcuentaViva(locationId)

    const destino = normalizarEmail(leerCampo(data, 'to_email', 'para', 'destinatario', 'email'))
    if (!destino) throw fallo(400, 'Falta el destinatario (to_email) en la configuración del nodo')
    if (!esEmail(destino)) throw fallo(400, `El destinatario "${destino}" no es una dirección de correo válida`)

    const remitente = await resolverRemitente(leerCampo(data, 'sender_id', 'remitente_id', 'remitente'), locationId)
    const proveedor = await resolverProveedor(leerCampo(data, 'provider_id', 'proveedor_id', 'proveedor'), locationId, remitente)

    let plantilla = null
    let asunto, preheader, html, textoPlano
    if (origen === 'nodo_plantilla') {
      plantilla = await resolverPlantilla(leerCampo(data, 'template_id', 'plantilla_id', 'plantilla'), locationId)
      asunto = limpiarCabecera(leerCampo(data, 'subject', 'asunto') ?? plantilla.subject, MAX_ASUNTO)
      preheader = texto(leerCampo(data, 'preheader') ?? plantilla.preheader ?? '')
      html = plantilla.html ?? ''
      textoPlano = plantilla.text ?? null
    } else {
      asunto = limpiarCabecera(leerCampo(data, 'subject', 'asunto'), MAX_ASUNTO)
      preheader = texto(leerCampo(data, 'preheader'))
      html = texto(leerCampo(data, 'html', 'cuerpo_html', 'body_html'))
      textoPlano = texto(leerCampo(data, 'text', 'cuerpo_texto')) || null
      if (!asunto) throw fallo(400, 'Falta el asunto en la configuración del nodo')
      if (!html && !textoPlano) throw fallo(400, 'Falta el cuerpo HTML en la configuración del nodo')
    }
    if (!asunto) throw fallo(400, 'La plantilla elegida no tiene asunto')
    if (html.length > MAX_HTML) throw fallo(400, `El cuerpo HTML supera el máximo permitido (${MAX_HTML} caracteres)`)

    const cc = parseLista(leerCampo(data, 'cc'), 'CC')
    const bcc = parseLista(leerCampo(data, 'bcc'), 'BCC')
    if ((cc?.length ?? 0) + (bcc?.length ?? 0) > MAX_DESTINATARIOS_COPIA) {
      throw fallo(400, `Demasiadas direcciones en CC/BCC (máximo ${MAX_DESTINATARIOS_COPIA})`)
    }

    const replyBruto = normalizarEmail(leerCampo(data, 'reply_to', 'responder_a') ?? remitente.reply_to ?? '')
    if (replyBruto && !esEmail(replyBruto)) throw fallo(400, `La dirección de respuesta "${replyBruto}" no es válida`)
    const replyTo = replyBruto ? limpiarCabecera(replyBruto, MAX_NOMBRE) : null
    const nombreDestino = limpiarCabecera(leerCampo(data, 'to_name', 'nombre_destinatario', 'nombre'), MAX_NOMBRE) || null

    // Lista de supresión. Se comprueban TODOS los destinatarios que van a recibir el correo, no solo
    // el principal: un rebote duro, una queja de spam o una baja en un clic tienen que valer igual
    // para quien va en copia (es lo que ya hace la pasarela SMTP en src/smtp-relay/handler.js).
    // El mensaje se guarda igualmente, aunque no salga, para que quede rastro en el historial.
    const bloqueados = await filtrarSuprimidos(locationId, [destino, ...(cc ?? []), ...(bcc ?? [])])
    const supresion = bloqueados.get(destino.toLowerCase()) ?? null
    const sinSuprimir = (lista) => {
      if (!lista) return null
      const quedan = lista.filter((d) => !bloqueados.has(d.toLowerCase()))
      return quedan.length ? quedan : null
    }
    const ccFinal = sinSuprimir(cc)
    const bccFinal = sinSuprimir(bcc)

    // El mensaje solo se marca terminal si cae el destinatario principal: que una copia esté
    // suprimida no puede impedir la entrega al resto.
    const estado = supresion ? 'suprimido' : 'encolado'
    const rango = supresion ? RANGO_SUPRIMIDO : RANGO_ENCOLADO
    const ultimoError = supresion ? `Destinatario en la lista de supresión (${supresion.reason})` : null

    const cubo = Math.floor(Date.now() / 3_600_000)
    const correlacion = idCorrelacion(locationId, extras, meta, data, cubo)
    const correlacionPrevia = idCorrelacion(locationId, extras, meta, data, cubo - 1)

    const { rows: [previo] } = await q(
      'SELECT id, status FROM messages WHERE correlation_id = ANY($1::text[])',
      [[correlacion, correlacionPrevia]]
    )
    if (previo) return reply.send({ ok: true, message_id: String(previo.id), estado: previo.status })

    // Límite de envíos de la subcuenta (SPEC §6 y §8). GHL dispara todos los correos de un workflow
    // de golpe y sin freno propio: esta es la salvaguarda que evita quemar la reputación del dominio.
    // Se consume DESPUÉS de comprobar la idempotencia (si no, un reintento de GHL gastaría cuota dos
    // veces) y solo si el mensaje va a salir de verdad: uno suprimido no consume hueco.
    if (!supresion) {
      const cupo = await consumirLimiteEnvio(locationId)
      if (!cupo.ok) throw fallo(503, cupo.motivo || 'Se ha alcanzado el límite de envíos de esta subcuenta')
    }

    const columnas = [
      locationId, proveedor.id, remitente.id, plantilla?.id ?? null, origen, estado, rango,
      destino, nombreDestino, ccFinal, bccFinal, replyTo, asunto, preheader || null, html || null, textoPlano,
      texto(extras.contactId) || null, texto(extras.workflowId) || null, correlacion, ultimoError,
    ]
    const { rows: [insertado] } = await q(
      `INSERT INTO messages (location_id, provider_id, sender_id, template_id, origin, status, status_rank,
                             to_email, to_name, cc, bcc, reply_to, subject, preheader, html, text,
                             ghl_contact_id, ghl_workflow_id, correlation_id, last_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (correlation_id) DO NOTHING
       RETURNING id, status`,
      columnas
    )

    let fila = insertado
    if (!fila) {
      const { rows: [existente] } = await q('SELECT id, status FROM messages WHERE correlation_id = $1', [correlacion])
      if (!existente) throw fallo(503, 'No se pudo encolar el mensaje, reinténtalo')
      fila = existente
    }

    // Copias suprimidas: queda escrito en el histórico para que el usuario vea en el panel por qué a
    // esa dirección no le llegó nada (mismo evento que deja el relay).
    if (insertado && bloqueados.size && !supresion) {
      await q(
        `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
         VALUES ($1,'destinatarios_suprimidos', now(), 'nodo-supresion', $2::jsonb)
         ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
        [
          insertado.id,
          JSON.stringify({
            direcciones: Object.fromEntries([...bloqueados].map(([email, f]) => [email, f.reason])),
          }),
        ]
      ).catch((err) => req.log.warn({ err, mensaje: insertado.id }, 'no se pudo registrar la supresión parcial'))
    }

    return reply.send({ ok: true, message_id: String(fila.id), estado: fila.status })
  } catch (err) {
    // 400 = error de configuración (se lee en el log del workflow). 503 = temporal, GHL reintenta.
    const codigo = err.codigo ?? 503
    if (codigo >= 500) req.log.error({ err }, 'fallo temporal ejecutando un nodo de email')
    return reply.code(codigo).send({
      ok: false,
      error: codigo >= 500 && !err.codigo ? 'La app de email no pudo procesar el envío, reinténtalo' : err.message,
    })
  }
}

// ---------------------------------------------------------------------------
// Campo Dynamic: es el único punto de la configuración donde llega extras.locationId
// ---------------------------------------------------------------------------

// Se emiten a la vez las claves del SPEC (key/label/type) y las de la doc de GHL (field/title/fieldType).
function campo(clave, etiqueta, tipo, requerido, opciones) {
  const f = {
    key: clave, field: clave,
    label: etiqueta, title: etiqueta,
    type: tipo, fieldType: tipo,
    required: requerido,
  }
  if (opciones) f.options = opciones
  return f
}

const opcionInformativa = (label) => [{ label, value: '' }]

async function opcionesRemitentes(locationId, proveedorId) {
  const { rows } = await q(
    `SELECT id, email, name, provider_id, is_default FROM senders
      WHERE location_id = $1 ORDER BY is_default DESC, name ASC, id ASC`, [locationId])
  if (!rows.length) {
    return opcionInformativa('No hay remitentes en esta subcuenta: créalos en la app de email')
  }
  const delProveedor = (s) => proveedorId && String(s.provider_id) === String(proveedorId)
  const ordenados = proveedorId
    ? [...rows].sort((a, b) => Number(delProveedor(b)) - Number(delProveedor(a)))
    : rows
  return ordenados.map((s) => ({
    label: `${s.name} <${s.email}>${proveedorId && !delProveedor(s) ? ' — otro proveedor' : ''}`,
    value: String(s.id),
  }))
}

async function opcionesPlantillas(locationId) {
  const { rows } = await q(
    `SELECT id, name, location_id FROM templates
      WHERE location_id = $1 OR location_id IS NULL
      ORDER BY (location_id IS NULL) ASC, name ASC, id ASC`, [locationId])
  if (!rows.length) {
    return opcionInformativa('No hay plantillas disponibles: créalas en la app de email')
  }
  return rows.map((t) => ({ label: t.location_id ? t.name : `${t.name} (global)`, value: String(t.id) }))
}

async function dinamico(req, reply, conPlantilla) {
  try {
    await exigirSecreto(req)

    const cuerpo = req.body && typeof req.body === 'object' ? req.body : {}
    const data = cuerpo.data && typeof cuerpo.data === 'object' ? cuerpo.data : {}
    const locationId = texto(cuerpo.extras?.locationId)

    // Este endpoint jamás devuelve error de configuración: siempre pinta campos, con una opción
    // informativa si falta algo. Un array vacío deja al usuario sin saber qué hacer.
    let sinInstalar = !locationId
    if (locationId) {
      const { rows: [conn] } = await q('SELECT status FROM connections WHERE location_id = $1', [locationId])
      sinInstalar = !conn || conn.status === 'uninstalled'
    }

    const campos = []
    if (sinInstalar) {
      const aviso = opcionInformativa('La app de email no está instalada en esta subcuenta')
      campos.push(campo('sender_id', 'Remitente', 'select', true, aviso))
      if (conPlantilla) campos.push(campo('template_id', 'Plantilla', 'select', true, aviso))
    } else {
      const proveedorBruto = texto(leerCampo(data, 'provider_id', 'proveedor_id', 'proveedor'))
      const proveedorId = /^\d+$/.test(proveedorBruto) ? proveedorBruto : null
      campos.push(campo('sender_id', 'Remitente', 'select', true, await opcionesRemitentes(locationId, proveedorId)))
      if (conPlantilla) campos.push(campo('template_id', 'Plantilla', 'select', true, await opcionesPlantillas(locationId)))
    }

    return reply.send({ inputs: [{ section: 'Envío', fields: campos }] })
  } catch (err) {
    const codigo = err.codigo ?? 503
    if (codigo >= 500) req.log.error({ err }, 'fallo resolviendo el campo dinámico del nodo de email')
    return reply.code(codigo).send({
      ok: false,
      error: codigo >= 500 && !err.codigo ? 'La app de email no pudo cargar las opciones, reinténtalo' : err.message,
    })
  }
}

export default async function accionesRoutes(app) {
  app.post('/api/ghl/accion/plantilla/:secreto', (req, reply) => ejecutar(req, reply, 'nodo_plantilla'))
  app.post('/api/ghl/accion/personalizado/:secreto', (req, reply) => ejecutar(req, reply, 'nodo_personalizado'))
  app.post('/api/ghl/dinamico/plantilla/:secreto', (req, reply) => dinamico(req, reply, true))
  app.post('/api/ghl/dinamico/personalizado/:secreto', (req, reply) => dinamico(req, reply, false))
}
