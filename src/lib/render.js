import { q } from '../db.js'
import { haySeguimiento, nuevoTokenEnlace, urlBaja, urlClic, urlPixel } from './tracking.js'

// ---------------------------------------------------------------------------
// Composición del mensaje final: lo que el worker entrega al proveedor.
//
// Aquí se hace, en este orden:
//   1. sustitución de variables en asunto, preheader, HTML y texto;
//   2. versión en texto plano a partir del HTML si el mensaje no traía una;
//   3. reescritura de los enlaces http(s) para medir clics (alta en message_links);
//   4. preheader oculto + pixel de apertura al principio del cuerpo;
//   5. cabeceras List-Unsubscribe / List-Unsubscribe-Post y de correlación.
//
// Regla de seguridad transversal: TODO lo que va a una cabecera de correo (asunto, nombre visible,
// reply-to, valores de List-Unsubscribe) pierde \r y \n. Un salto de línea en esos campos permite
// inyectar cabeceras arbitrarias —incluido un Bcc— en el mensaje que sale.
// Y todo valor de variable que se sustituye dentro del HTML se escapa: el nombre de un contacto es
// texto ajeno y no puede acabar convertido en etiquetas.
// ---------------------------------------------------------------------------

const MAX_ASUNTO = 500
const MAX_NOMBRE_VISIBLE = 70 // límite de Brevo para el nombre del remitente y del destinatario
const MAX_CABECERA = 900
const MAX_URL = 2000

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

/** Quita \r, \n y tabuladores: es lo que corta la inyección de cabeceras de correo. */
export const limpiarCabecera = (valor, max = MAX_CABECERA) =>
  texto(valor).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max)

/** Escapa el texto que se inserta dentro del HTML del correo. */
export function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Acepta "ana@x.com" y "Ana Ruiz <ana@x.com>". */
export function direccionDe(valor) {
  const bruto = texto(valor)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim()
}

/** Normaliza una dirección a { email, name } admitiendo cadena u objeto. */
export function normalizarDestinatario(valor) {
  if (!valor) return null
  if (typeof valor === 'object') {
    const email = direccionDe(valor.email ?? valor.address ?? '')
    if (!email) return null
    const name = limpiarCabecera(valor.name ?? valor.nombre ?? '', MAX_NOMBRE_VISIBLE)
    return name ? { email, name } : { email }
  }
  const email = direccionDe(valor)
  return email ? { email } : null
}

const listaDestinatarios = (valores) =>
  (Array.isArray(valores) ? valores : valores ? [valores] : [])
    .map(normalizarDestinatario)
    .filter(Boolean)

// ---------------------------------------------------------------------------
// Variables
// ---------------------------------------------------------------------------

// Se admiten {{clave}}, {{ clave }} y las formas con prefijo que usa GHL ({{contact.first_name}},
// {{params.pedido}}…). El prefijo se descarta y se busca la clave por su nombre.
const RE_VARIABLE = /\{\{\s*([\w.\-\s]{1,80}?)\s*\}\}/g
const PREFIJOS = [
  'params.', 'param.', 'contact.', 'contacto.', 'custom_values.', 'custom_value.',
  'message.', 'mensaje.', 'destinatario.', 'lead.', 'user.',
]

const normalizarClave = (clave) => String(clave).trim().toLowerCase().replace(/\s+/g, '_')

function mapaVariables(variables) {
  const mapa = new Map()
  const meter = (clave, valor) => {
    const k = normalizarClave(clave)
    if (k && !mapa.has(k)) mapa.set(k, valor)
  }
  for (const [clave, valor] of Object.entries(variables || {})) {
    if (valor && typeof valor === 'object' && !Array.isArray(valor)) {
      // un nivel de anidamiento: { contacto: { nombre } } → contacto.nombre y nombre
      for (const [sub, subValor] of Object.entries(valor)) {
        if (subValor && typeof subValor === 'object') continue
        meter(`${clave}.${sub}`, subValor)
        meter(sub, subValor)
      }
      continue
    }
    meter(clave, valor)
  }
  return mapa
}

function buscarVariable(mapa, clave) {
  const k = normalizarClave(clave)
  if (mapa.has(k)) return mapa.get(k)
  for (const prefijo of PREFIJOS) {
    if (k.startsWith(prefijo)) {
      const corta = k.slice(prefijo.length)
      if (mapa.has(corta)) return mapa.get(corta)
      if (mapa.has(corta.replace(/\./g, '_'))) return mapa.get(corta.replace(/\./g, '_'))
    }
  }
  const guiones = k.replace(/\./g, '_')
  return mapa.has(guiones) ? mapa.get(guiones) : undefined
}

/**
 * Sustituye {{variables}}. Dentro del HTML los valores se escapan; en el asunto y en el texto plano
 * no hay nada que escapar. Una variable desconocida se sustituye por vacío: dejar «{{nombre}}» a la
 * vista en el correo del cliente final es peor que no poner nada.
 */
export function sustituirVariables(plantilla, variables = {}, opciones = {}) {
  const cadena = plantilla === undefined || plantilla === null ? '' : String(plantilla)
  if (!cadena.includes('{{')) return cadena
  const { escapar = false, conservarDesconocidas = false } = opciones
  const mapa = variables instanceof Map ? variables : mapaVariables(variables)
  return cadena.replace(RE_VARIABLE, (completo, clave) => {
    const valor = buscarVariable(mapa, clave)
    if (valor === undefined) return conservarDesconocidas ? completo : ''
    const bruto = valor === null ? '' : String(valor)
    return escapar ? escaparHtml(bruto) : bruto
  })
}

/** Variables que la app conoce de un mensaje concreto, sin llamar a nadie. */
export function variablesDeMensaje(mensaje, remitente = {}, extra = {}) {
  const nombre = texto(mensaje?.to_name)
  const ahora = new Date()
  const base = {
    nombre,
    to_name: nombre,
    nombre_destinatario: nombre,
    first_name: nombre ? nombre.split(/\s+/)[0] : '',
    nombre_pila: nombre ? nombre.split(/\s+/)[0] : '',
    email: texto(mensaje?.to_email),
    to_email: texto(mensaje?.to_email),
    correo: texto(mensaje?.to_email),
    asunto: texto(mensaje?.subject),
    subject: texto(mensaje?.subject),
    remitente_nombre: texto(remitente?.name),
    remitente_email: texto(remitente?.email),
    from_name: texto(remitente?.name),
    from_email: texto(remitente?.email),
    fecha: ahora.toLocaleDateString('es-ES', { timeZone: 'Europe/Madrid' }),
    anio: String(ahora.getFullYear()),
    year: String(ahora.getFullYear()),
    location_id: texto(mensaje?.location_id),
  }
  return { ...base, ...(extra || {}) }
}

// ---------------------------------------------------------------------------
// HTML → texto plano
// ---------------------------------------------------------------------------

const ENTIDADES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', eacute: 'é', aacute: 'á', iacute: 'í', oacute: 'ó',
  uacute: 'ú', ntilde: 'ñ', Ntilde: 'Ñ', uuml: 'ü', euro: '€', copy: '©', reg: '®', trade: '™',
  zwnj: '', shy: '',
}

function decodificarEntidades(cadena) {
  return String(cadena)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => cadenaDeCodigo(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => cadenaDeCodigo(Number(dec)))
    .replace(/&([a-z]+);/gi, (completo, nombre) => (nombre in ENTIDADES ? ENTIDADES[nombre] : completo))
}

function cadenaDeCodigo(codigo) {
  if (!Number.isFinite(codigo) || codigo < 1 || codigo > 0x10ffff) return ''
  try {
    return String.fromCodePoint(codigo)
  } catch {
    return ''
  }
}

const RE_ENLACE_TEXTO = /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+))[^>]*>([\s\S]*?)<\/a>/gi

/**
 * Versión en texto plano razonable a partir del HTML. No pretende ser un navegador: pretende que el
 * correo tenga parte de texto (los filtros de spam penalizan los mensajes que solo llevan HTML).
 */
export function textoDesdeHtml(html) {
  let t = String(html ?? '')
  if (!t.trim()) return ''
  t = t.replace(/<!--[\s\S]*?-->/g, ' ')
  t = t.replace(/<(script|style|head|title|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  t = t.replace(RE_ENLACE_TEXTO, (completo, c1, c2, c3, contenido) => {
    const url = texto(decodificarEntidades(c1 ?? c2 ?? c3 ?? ''))
    const visible = decodificarEntidades(String(contenido).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
    if (!url || /^(mailto:|tel:|#|javascript:)/i.test(url)) return visible
    if (!visible) return url
    return visible.includes(url) ? visible : `${visible} (${url})`
  })
  t = t.replace(/<br\s*\/?>/gi, '\n')
  t = t.replace(/<li\b[^>]*>/gi, '\n- ')
  t = t.replace(/<\/(p|div|tr|li|ul|ol|h[1-6]|table|section|article|header|footer|blockquote)\s*>/gi, '\n')
  t = t.replace(/<(hr)\b[^>]*>/gi, '\n----------\n')
  t = t.replace(/<[^>]+>/g, '')
  t = decodificarEntidades(t)
  t = t.replace(/\r/g, '')
  t = t
    .split('\n')
    .map((linea) => linea.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
  return t.replace(/\n{3,}/g, '\n\n').trim()
}

// ---------------------------------------------------------------------------
// Preheader, pixel y enlaces
// ---------------------------------------------------------------------------

// Relleno invisible: empuja fuera de la vista previa el texto que el cliente de correo pondría
// detrás del preheader (espacios de ancho cero + juntadores de palabra).
const RELLENO_PREHEADER = '&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;'.repeat(12)

const ESTILO_OCULTO =
  'display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;' +
  'max-height:0;max-width:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px'

const RE_BODY = /<body\b[^>]*>/i

/** Inserta un fragmento justo detrás de <body> (o al principio si el HTML es un fragmento suelto). */
export function insertarAlPrincipio(html, fragmento) {
  const cuerpo = String(html ?? '')
  if (!fragmento) return cuerpo
  const coincide = cuerpo.match(RE_BODY)
  if (coincide) {
    const corte = coincide.index + coincide[0].length
    return cuerpo.slice(0, corte) + fragmento + cuerpo.slice(corte)
  }
  return fragmento + cuerpo
}

/** Bloque oculto con el texto de vista previa. */
export function bloquePreheader(preheader) {
  const valor = limpiarCabecera(preheader, 300)
  if (!valor) return ''
  return `<div style="${ESTILO_OCULTO}">${escaparHtml(valor)}${RELLENO_PREHEADER}</div>`
}

/** Pixel de apertura. Va al PRINCIPIO: Gmail recorta el mensaje a partir de ~102 KB. */
export function bloquePixel(url) {
  if (!url) return ''
  return (
    `<img src="${escaparHtml(url)}" width="1" height="1" alt="" ` +
    `style="display:block;border:0;outline:none;text-decoration:none;height:1px;width:1px" />`
  )
}

export const insertarPreheader = (html, preheader) => insertarAlPrincipio(html, bloquePreheader(preheader))
export const insertarPixel = (html, url) => insertarAlPrincipio(html, bloquePixel(url))

const RE_ANCLA_HREF = /(<a\b[^>]*?\shref\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'`=<>]+))/gi

function reescribible(url, basesExcluidas) {
  if (!url || url.length > MAX_URL) return false
  if (url.includes('{{')) return false // variable sin resolver: no se toca
  if (!/^https?:\/\//i.test(url)) return false
  // no se reescribe lo que ya es nuestro (pixel, redirector, baja): sería un doble salto
  for (const base of basesExcluidas) {
    if (base && url.toLowerCase().startsWith(`${base.toLowerCase()}/t/`)) return false
  }
  return true
}

/**
 * Reescribe los href http(s) del HTML hacia el redirector propio.
 * `previos` (Map url→token) permite que un reintento reutilice los tokens ya guardados en vez de
 * sembrar una fila nueva en message_links por cada intento.
 * `baseExcluida` admite una cadena o una lista: con dominio de tracking propio hay DOS bases
 * nuestras que no deben reescribirse (APP_BASE_URL y el dominio del cliente).
 */
export function reescribirEnlaces(html, opciones = {}) {
  const cuerpo = String(html ?? '')
  const { previos = new Map(), baseExcluida = '', generarToken = nuevoTokenEnlace, urlDe = urlClic } = opciones
  const basesExcluidas = (Array.isArray(baseExcluida) ? baseExcluida : [baseExcluida]).filter(Boolean)
  if (!cuerpo.includes('<a')) return { html: cuerpo, enlaces: [] }

  const usados = new Map() // url → { token, nuevo }
  const nuevoHtml = cuerpo.replace(RE_ANCLA_HREF, (completo, prefijo, _cita, doble, simple, desnudo) => {
    const bruto = doble ?? simple ?? desnudo ?? ''
    const url = decodificarEntidades(bruto).trim()
    if (!reescribible(url, basesExcluidas)) return completo

    let entrada = usados.get(url)
    if (!entrada) {
      const previo = previos.get(url)
      entrada = previo ? { token: previo, nuevo: false } : { token: generarToken(), nuevo: true }
      usados.set(url, entrada)
    }
    return `${prefijo}"${escaparHtml(urlDe(entrada.token))}"`
  })

  const enlaces = [...usados.entries()].map(([url, { token, nuevo }]) => ({ url, token, nuevo }))
  return { html: nuevoHtml, enlaces }
}

// ---------------------------------------------------------------------------
// Persistencia de los enlaces reescritos
// ---------------------------------------------------------------------------

/** Enlaces ya registrados de un mensaje: Map url→token. */
export async function enlacesDeMensaje(messageId) {
  if (!messageId) return new Map()
  const { rows } = await q('SELECT token, url FROM message_links WHERE message_id = $1', [messageId])
  return new Map(rows.map((f) => [f.url, f.token]))
}

/** Alta de los enlaces nuevos. El redirector SOLO redirige a una URL que esté en esta tabla. */
export async function registrarEnlaces(messageId, enlaces) {
  const nuevos = (enlaces || []).filter((e) => e?.nuevo && e.token && e.url)
  if (!messageId || !nuevos.length) return 0
  const { rowCount } = await q(
    `INSERT INTO message_links (message_id, token, url)
     SELECT $1, t.token, t.url FROM unnest($2::text[], $3::text[]) AS t(token, url)
     ON CONFLICT (token) DO NOTHING`,
    [messageId, nuevos.map((e) => e.token), nuevos.map((e) => e.url)]
  )
  return rowCount
}

// ---------------------------------------------------------------------------
// Composición
// ---------------------------------------------------------------------------

/**
 * Compone el mensaje sin tocar la base de datos (sirve también para vistas previas).
 *
 * `mensaje`  fila de messages (id, to_email, to_name, cc, bcc, reply_to, subject, preheader,
 *            html, text, correlation_id, location_id, origin).
 * `opciones` { remitente:{email,name,reply_to}, variables, seguimiento:{aperturas,clics},
 *             baja, enlacesPrevios, etiquetas, conservarDesconocidas, dominioTracking }
 *
 * `baja`: si no se indica, la baja en un clic se pone solo cuando `mensaje.origin` es 'relay'.
 * `dominioTracking`: dominio de tracking VERIFICADO de la subcuenta (SPEC §11.3). Con él, el pixel,
 * los enlaces reescritos y la baja salen por https://<dominio>; sin él, por APP_BASE_URL. Lo
 * resuelve el worker con dominioTrackingDe() de lib/tracking.js.
 */
export function componerMensaje(mensaje, opciones = {}) {
  const m = mensaje || {}
  const remitente = opciones.remitente || {}
  const seguimiento = { aperturas: true, clics: true, ...(opciones.seguimiento || {}) }
  const activo = haySeguimiento() && Boolean(m.id)
  const base = activo ? String(process.env.APP_BASE_URL || '').trim().replace(/\/+$/, '') : ''
  // se admite el dominio pelado (contrato) y, por tolerancia, con esquema o barra final
  const dominioTracking = texto(opciones.dominioTracking)
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.+$/, '')

  const de = normalizarDestinatario({ email: remitente.email, name: remitente.name })
  if (!de) throw new Error('El mensaje no tiene remitente: revisa el remitente configurado en la app de email')

  const para = listaDestinatarios([{ email: m.to_email, name: m.to_name }])
  if (!para.length) throw new Error('El mensaje no tiene destinatario')

  const variables = mapaVariables(variablesDeMensaje(m, de, opciones.variables))
  // El correo que entra por el relay ya pasó por la sustitución de variables de GHL: lo que quede
  // entre llaves es texto literal del cliente y no se toca.
  const sust = { conservarDesconocidas: opciones.conservarDesconocidas === true }

  const asunto = limpiarCabecera(sustituirVariables(m.subject, variables, sust), MAX_ASUNTO)
  const preheader = limpiarCabecera(sustituirVariables(m.preheader, variables, sust), 300)

  let html = sustituirVariables(m.html, variables, { ...sust, escapar: true })
  let plano = sustituirVariables(m.text, variables, sust)
  if (!plano.trim() && html.trim()) plano = textoDesdeHtml(html)

  // Los enlaces se reescriben ANTES de meter el pixel y el preheader: así el pixel nunca entra en
  // el barrido y el preheader no puede aportar enlaces que no estaban en la plantilla.
  let enlaces = []
  if (html.trim() && activo && seguimiento.clics) {
    const resultado = reescribirEnlaces(html, {
      previos: opciones.enlacesPrevios instanceof Map ? opciones.enlacesPrevios : new Map(),
      baseExcluida: [base, dominioTracking ? `https://${dominioTracking}` : ''],
      urlDe: (token) => urlClic(token, dominioTracking),
    })
    html = resultado.html
    enlaces = resultado.enlaces
  }

  if (html.trim()) {
    const cabeza =
      bloquePreheader(preheader) +
      (activo && seguimiento.aperturas ? bloquePixel(urlPixel(m.id, dominioTracking)) : '')
    if (cabeza) html = insertarAlPrincipio(html, cabeza)
  }

  const replyToBruto = direccionDe(m.reply_to || remitente.reply_to || '')
  const replyTo = replyToBruto ? { email: replyToBruto } : null

  // Baja en un clic SOLO en el correo del relay (SPEC §6: es una salvaguarda de la pasarela, no del
  // correo transaccional). procesarBaja() suprime a nivel de SUBCUENTA y sin distinguir tipo de
  // correo, así que pintarle a Gmail el botón «Cancelar suscripción» en un aviso de pedido o en un
  // enlace de recuperación de contraseña deja al cliente sin recibir NADA más de esa subcuenta para
  // siempre por un clic que él entendía como "no quiero más publicidad".
  // `opciones.baja` manda en los dos sentidos: permite forzarla o quitarla desde quien compone.
  const bajaPedida = opciones.baja === undefined ? texto(m.origin) === 'relay' : opciones.baja !== false
  const enlaceBaja = activo && bajaPedida ? urlBaja(m.id, dominioTracking) : ''
  const cabeceras = cabecerasDeMensaje({
    correlationId: m.correlation_id,
    enlaceBaja,
    correoBaja: replyToBruto || de.email,
  })

  return {
    correlationId: texto(m.correlation_id),
    de,
    para,
    cc: listaDestinatarios(m.cc),
    bcc: listaDestinatarios(m.bcc),
    replyTo,
    asunto,
    preheader,
    html: html.trim() ? html : null,
    texto: plano.trim() ? plano : null,
    cabeceras,
    enlaces,
    enlaceBaja: enlaceBaja || null,
    etiquetas: Array.isArray(opciones.etiquetas) ? opciones.etiquetas.filter(Boolean).map(String) : undefined,
  }
}

/**
 * Cabeceras comunes. List-Unsubscribe-Post SOLO se pone si hay una URL https detrás: RFC 8058 exige
 * que la baja en un clic sea un POST a una URL, y anunciarla sin endpoint sería peor que no ponerla.
 */
export function cabecerasDeMensaje({ correlationId, enlaceBaja, correoBaja }) {
  const cabeceras = {}
  const correlacion = limpiarCabecera(correlationId, 200)
  if (correlacion) cabeceras['X-Correlation-Id'] = correlacion

  const destinos = []
  if (enlaceBaja) destinos.push(`<${limpiarCabecera(enlaceBaja, 400)}>`)
  const correo = direccionDe(correoBaja)
  if (correo) destinos.push(`<mailto:${limpiarCabecera(correo, 320)}?subject=unsubscribe>`)
  if (destinos.length) cabeceras['List-Unsubscribe'] = destinos.join(', ')
  if (enlaceBaja) cabeceras['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click'
  return cabeceras
}

/**
 * Igual que componerMensaje pero dejando los enlaces dados de alta en message_links (y reutilizando
 * los de un intento anterior). Es lo que llama el worker.
 */
export async function prepararMensaje(mensaje, opciones = {}) {
  const previos = opciones.enlacesPrevios instanceof Map ? opciones.enlacesPrevios : await enlacesDeMensaje(mensaje?.id)
  const compuesto = componerMensaje(mensaje, { ...opciones, enlacesPrevios: previos })
  await registrarEnlaces(mensaje?.id, compuesto.enlaces)
  return compuesto
}
