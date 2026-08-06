// Integración con la API transaccional de Brevo (SPEC §7).
//
// Envío:      POST https://api.brevo.com/v3/smtp/email  con la cabecera `api-key`.
// Validación: GET  /v3/account (endpoint barato y oficialmente recomendado para probar la clave).
//
// La correlación con los webhooks se hace con la cabecera `X-Mailin-custom`: viaja en el envío y
// vuelve ÍNTEGRA en todos los eventos (src/routes/webhooks.js la lee de ahí). Sin ella habría que
// depender del message-id, que unas veces llega entre <> y otras sin ellos.
//
// La clave de API no aparece NUNCA en un mensaje de error ni en un log.

const API = 'https://api.brevo.com/v3'
const TIEMPO_ENVIO_MS = 30_000
const TIEMPO_CONSULTA_MS = 15_000
const MAX_DESTINATARIOS = 99 // límite de Brevo por mensaje (con adjuntos baja a este número)
const MAX_NOMBRE = 70 // límite documentado del nombre visible
const MAX_ESPERA_MS = 3_600_000

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
const limpiar = (v, max = 400) => texto(v).replace(/[\r\n\t]+/g, ' ').slice(0, max)

/** Error normalizado del proveedor: `permanente` decide si el worker reintenta o no. */
function errorProveedor(mensaje, opciones = {}) {
  const err = new Error(mensaje)
  err.permanente = Boolean(opciones.permanente)
  err.proveedor = 'brevo'
  if (opciones.codigo != null) err.codigo = opciones.codigo
  if (opciones.credenciales) err.credenciales = true
  if (opciones.esperarMs) err.esperarMs = opciones.esperarMs
  return err
}

/** El message-id de Brevo llega unas veces con <> y otras sin: se normaliza SIEMPRE. */
const normalizarMessageId = (v) => texto(v).replace(/^<+/, '').replace(/>+$/, '').trim()

/** Acepta "ana@x.com" y "Ana Ruiz <ana@x.com>". */
function soloDireccion(valor) {
  const bruto = texto(valor)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim()
}

function direccionesBrevo(valores) {
  const lista = Array.isArray(valores) ? valores : valores ? [valores] : []
  const salida = []
  for (const valor of lista) {
    const bruto = valor && typeof valor === 'object' ? valor : { email: valor }
    const email = soloDireccion(bruto?.email ?? bruto?.address)
    if (!email) continue
    const nombre = limpiar(bruto?.name ?? bruto?.nombre, MAX_NOMBRE)
    salida.push(nombre ? { email, name: nombre } : { email })
  }
  return salida
}

// Brevo espera las cabeceras personalizadas en Title-Case-Format y no admite saltos de línea.
function cabecerasBrevo(cabeceras) {
  const salida = {}
  for (const [clave, valor] of Object.entries(cabeceras || {})) {
    const nombre = limpiar(clave, 100).replace(/[^A-Za-z0-9-]/g, '')
    const contenido = limpiar(valor, 900)
    if (nombre && contenido) salida[nombre] = contenido
  }
  return salida
}

function errorDeRespuesta(respuesta, datos, cuerpoTexto) {
  const estado = respuesta.status
  const codigoBrevo = texto(datos?.code)
  const mensajeBrevo = limpiar(datos?.message || (typeof cuerpoTexto === 'string' ? cuerpoTexto : ''))
  const sufijo = mensajeBrevo ? `: ${mensajeBrevo}` : ''

  if (estado === 429) {
    // Brevo no manda Retry-After: el tiempo que queda de ventana viene en x-sib-ratelimit-reset.
    const reset = Number(respuesta.headers.get('x-sib-ratelimit-reset'))
    return errorProveedor(`Brevo está limitando las peticiones (429)${sufijo}`, {
      permanente: false,
      codigo: estado,
      esperarMs: Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, MAX_ESPERA_MS) : null,
    })
  }
  if (estado >= 500) {
    return errorProveedor(`Brevo devolvió un error temporal (${estado})${sufijo}`, { permanente: false, codigo: estado })
  }
  if (estado === 401 || estado === 403) {
    return errorProveedor(`La clave de API de Brevo no es válida o no tiene permisos (${estado})${sufijo}`, {
      permanente: true, codigo: estado, credenciales: true,
    })
  }
  if (estado === 402 || codigoBrevo === 'not_enough_credits') {
    return errorProveedor(`La cuenta de Brevo no tiene créditos suficientes para enviar${sufijo}`, {
      permanente: true, codigo: estado,
    })
  }
  // 400 con invalid_parameter es, casi siempre, un remitente sin verificar: es permanente y hay que
  // arreglarlo en Brevo, no reintentarlo (cada reintento gastaría cuota para el mismo rechazo).
  return errorProveedor(
    `Brevo rechazó la petición (${estado}${codigoBrevo ? `, ${codigoBrevo}` : ''})${sufijo}`,
    { permanente: true, codigo: estado }
  )
}

async function peticion(ruta, opciones = {}) {
  const { metodo = 'GET', apiKey, cuerpo = null, timeoutMs = TIEMPO_CONSULTA_MS } = opciones
  const clave = texto(apiKey)
  if (!clave) {
    throw errorProveedor('Falta la clave de API de Brevo en este proveedor', { permanente: true, credenciales: true })
  }

  let respuesta
  try {
    respuesta = await fetch(`${API}${ruta}`, {
      method: metodo,
      headers: {
        'api-key': clave,
        accept: 'application/json',
        ...(cuerpo ? { 'content-type': 'application/json' } : {}),
      },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const porTiempo = err?.name === 'TimeoutError' || err?.name === 'AbortError'
    // la red y los tiempos de espera son SIEMPRE temporales: se reintentan
    throw errorProveedor(
      porTiempo
        ? 'Brevo no respondió a tiempo'
        : `No se pudo conectar con la API de Brevo (${limpiar(err?.code || err?.name || 'error de red', 60)})`,
      { permanente: false }
    )
  }

  const cuerpoTexto = await respuesta.text().catch(() => '')
  let datos = null
  if (cuerpoTexto) {
    try {
      datos = JSON.parse(cuerpoTexto)
    } catch {
      datos = null
    }
  }
  if (!respuesta.ok) throw errorDeRespuesta(respuesta, datos, cuerpoTexto)
  return { datos, respuesta }
}

export default {
  tipo: 'brevo',

  camposCredenciales: [
    {
      clave: 'api_key',
      etiqueta: 'Clave de API',
      tipo: 'password',
      requerido: true,
      placeholder: 'xkeysib-…',
      ayuda: 'Brevo › SMTP & API › API Keys. Necesita permiso de envío transaccional.',
    },
  ],

  // No hay configuración no secreta: el endpoint y el host los pone la integración.
  camposConfig: [],

  /** Comprueba la clave contra GET /v3/account. Nunca lanza: devuelve { ok, detalle, cuenta }. */
  async validar(credenciales = {}) {
    try {
      const { datos } = await peticion('/account', { apiKey: credenciales.api_key })
      const plan = Array.isArray(datos?.plan) ? datos.plan[0] : null
      const cuenta = {
        empresa: texto(datos?.companyName) || null,
        email: texto(datos?.email) || null,
        plan: texto(plan?.type) || null,
        creditos: plan?.credits ?? null,
        transaccional: datos?.relay?.enabled !== false,
      }
      if (datos?.relay && datos.relay.enabled === false) {
        return {
          ok: false,
          detalle: 'La clave es válida, pero el envío transaccional está desactivado en esta cuenta de Brevo',
          cuenta,
        }
      }
      const extras = [cuenta.empresa, cuenta.plan, cuenta.creditos != null ? `${cuenta.creditos} créditos` : null]
        .filter(Boolean)
        .join(' · ')
      return { ok: true, detalle: extras ? `Clave válida · ${extras}` : 'Clave válida', cuenta }
    } catch (err) {
      return { ok: false, detalle: err.message, cuenta: null }
    }
  },

  /** Envía por POST /v3/smtp/email. Devuelve { providerMessageId, aceptado }. */
  async enviar(ctx = {}) {
    const de = direccionesBrevo(ctx.de)[0]
    const para = direccionesBrevo(ctx.para)
    const cc = direccionesBrevo(ctx.cc)
    const bcc = direccionesBrevo(ctx.bcc)
    const replyTo = direccionesBrevo(ctx.replyTo)[0]

    if (!de) throw errorProveedor('El mensaje no tiene remitente', { permanente: true })
    if (!para.length) throw errorProveedor('El mensaje no tiene destinatario', { permanente: true })
    const asunto = limpiar(ctx.asunto, 500)
    if (!asunto) throw errorProveedor('El mensaje no tiene asunto', { permanente: true })
    if (!ctx.html && !ctx.texto) throw errorProveedor('El mensaje no tiene contenido', { permanente: true })
    if (para.length + cc.length + bcc.length > MAX_DESTINATARIOS) {
      throw errorProveedor(`Brevo admite como mucho ${MAX_DESTINATARIOS} destinatarios por mensaje`, { permanente: true })
    }

    const cabeceras = cabecerasBrevo(ctx.cabeceras)
    const correlationId = limpiar(ctx.correlationId, 200)
    // Clave de correlación: vuelve tal cual en TODOS los webhooks de Brevo.
    if (correlationId) cabeceras['X-Mailin-custom'] = correlationId

    const cuerpo = {
      sender: de,
      to: para,
      subject: asunto,
    }
    if (ctx.html) cuerpo.htmlContent = String(ctx.html)
    if (ctx.texto) cuerpo.textContent = String(ctx.texto)
    if (cc.length) cuerpo.cc = cc
    if (bcc.length) cuerpo.bcc = bcc
    if (replyTo) cuerpo.replyTo = replyTo
    if (Object.keys(cabeceras).length) cuerpo.headers = cabeceras
    const etiquetas = (Array.isArray(ctx.etiquetas) ? ctx.etiquetas : []).map((t) => limpiar(t, 60)).filter(Boolean)
    if (etiquetas.length) cuerpo.tags = etiquetas.slice(0, 10)

    const { datos } = await peticion('/smtp/email', {
      metodo: 'POST',
      apiKey: ctx.credenciales?.api_key,
      cuerpo,
      timeoutMs: TIEMPO_ENVIO_MS,
    })

    const id = normalizarMessageId(datos?.messageId ?? (Array.isArray(datos?.messageIds) ? datos.messageIds[0] : ''))
    return {
      providerMessageId: id || null,
      aceptado: true,
      detalle: id ? `Aceptado por Brevo (${id})` : 'Aceptado por Brevo',
    }
  },

  /**
   * Remitentes de la cuenta. `active` de /v3/senders NO significa verificado, así que el estado real
   * se cruza con /v3/senders/domains, que es donde vive `authenticated`.
   * Devuelve null si no se puede consultar (es información de apoyo, nunca bloquea un envío).
   */
  async listarRemitentes(credenciales = {}) {
    try {
      const { datos } = await peticion('/senders', { apiKey: credenciales.api_key })
      const remitentes = Array.isArray(datos?.senders) ? datos.senders : []

      let dominios = new Map()
      try {
        const respuesta = await peticion('/senders/domains', { apiKey: credenciales.api_key })
        const lista = Array.isArray(respuesta.datos?.domains) ? respuesta.datos.domains : []
        dominios = new Map(
          lista.map((d) => [
            texto(d?.domain ?? d?.domain_name).toLowerCase(),
            Boolean(d?.authenticated) || Boolean(d?.verified),
          ])
        )
      } catch {
        // el estado de los dominios es opcional: sin él solo se pierde el aviso de verificación
      }

      return remitentes.map((s) => {
        const email = texto(s?.email)
        const dominio = email.split('@')[1]?.toLowerCase() || ''
        return {
          id: s?.id ?? null,
          email,
          name: texto(s?.name),
          activo: s?.active !== false,
          verificado: dominios.get(dominio) === true,
        }
      })
    } catch {
      return null
    }
  },
}
