import sanitizeHtml from 'sanitize-html'
import { config } from '../config.js'
import { pool, q } from '../db.js'
import { textoDesdeHtml } from './render.js'
import { getLimites } from './settings.js'

// ---------------------------------------------------------------------------
// Buzón IMAP (SPEC §14): utilidades compartidas por la sincronización (lib/buzon-sync.js) y las
// rutas (routes/buzon.js).
//
//   · sanearHtml        — el HTML de un correo ajeno se guarda ya limpio: sin scripts, estilos
//                         globales, iframes ni formularios, y con las imágenes remotas apagadas
//                         (src → data-src) hasta que el usuario pulse «cargar imágenes».
//   · extraerThreadKey  — clave de hilo: primer id de References, o In-Reply-To, o el Message-ID.
//   · cuotaDe/ajustarUso/recalcularUso — cuota de espacio por subcuenta y contador cacheado
//                         location_settings.buzon_used_bytes.
//   · borrarMensajeBuzon — baja de un mensaje con sus adjuntos descontando la cuota.
//
// Convención de identificadores: message_id, in_reply_to, "references" y thread_key se guardan
// SIN los ángulos (<…>) y sin espacios alrededor. Al componer una respuesta, render.js vuelve a
// envolverlos en <…> (cabecerasExtra), así que da igual cómo los reciba.
// ---------------------------------------------------------------------------

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

const MB = 1024 * 1024

// Por encima de este tamaño el HTML se recorta antes de sanearlo: sanitize-html trabaja en memoria
// y un correo con imágenes incrustadas en base64 puede pesar decenas de megas.
const MAX_HTML = 2_000_000
const AVISO_RECORTE =
  '<p style="color:#b45309;font-size:12px"><em>[El contenido de este correo se ha recortado por su tamaño]</em></p>'

// ---------------------------------------------------------------------------
// Saneado del HTML
// ---------------------------------------------------------------------------

// Un valor de estilo vale si no invoca funciones que cargan recursos o ejecutan código: url(),
// expression(), behavior… y también las demás funciones de imagen de CSS (image-set(), image(),
// src(), cross-fade(), paint(), element(), con o sin prefijo -webkit-/-moz-), que cargarían un
// píxel de seguimiento en `background` sin pasar por el bloqueo de imágenes del panel.
// rgb()/rgba()/hsl() y calc() siguen permitidos. La barra invertida está vetada: sin escapes CSS
// (\75 rl = url) no hay forma de disfrazar un nombre de función.
const RE_VALOR_ESTILO =
  /^(?!.*(?:url|expression|javascript|import|behavior|binding|image-set|image|src|cross-fade|paint|element)\s*\()[^;{}<>\\]{1,300}$/i

const PROPIEDADES_ESTILO = [
  'color', 'background', 'background-color',
  'font', 'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'line-height', 'letter-spacing', 'text-align', 'text-decoration', 'text-transform', 'text-indent',
  'vertical-align', 'white-space', 'word-break', 'word-wrap', 'overflow-wrap', 'direction',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius', 'border-collapse', 'border-spacing',
  'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height',
  'display', 'float', 'clear', 'opacity', 'list-style', 'list-style-type', 'table-layout', 'box-sizing',
]

const ETIQUETAS_PERMITIDAS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img', 'center', 'font', 'del', 'ins', 'strike', 'big', 'tt', 'details', 'summary',
]

const RE_URL_REMOTA = /^https?:\/\/[^\s"'<>]{1,2000}$/i

/** URL http(s) bien formada o ''. Acepta también la forma sin esquema (//host/…) y la fija a https. */
function urlRemota(valor) {
  let s = texto(valor)
  if (s.startsWith('//')) s = `https:${s}`
  if (!RE_URL_REMOTA.test(s)) return ''
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : ''
  } catch {
    return ''
  }
}

const OPCIONES_SANEADO = {
  allowedTags: ETIQUETAS_PERMITIDAS,
  // el contenido de estas etiquetas se descarta entero (no solo la etiqueta)
  nonTextTags: ['script', 'style', 'textarea', 'option', 'noscript', 'title', 'head', 'iframe', 'object', 'embed', 'applet', 'svg', 'math', 'template'],
  allowedAttributes: {
    '*': [
      'style', 'class', 'id', 'dir', 'lang', 'title', 'align', 'valign', 'width', 'height', 'border',
      'bgcolor', 'color', 'cellpadding', 'cellspacing', 'colspan', 'rowspan', 'nowrap', 'face', 'size', 'role',
    ],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'data-src', 'data-cid'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  // solo data:image/… sobrevive en src (lo filtra transformTags); lo remoto pasa a data-src
  allowedSchemesByTag: { img: ['data'] },
  allowProtocolRelative: false,
  allowedStyles: { '*': Object.fromEntries(PROPIEDADES_ESTILO.map((p) => [p, [RE_VALOR_ESTILO]])) },
  transformTags: {
    img(tagName, attribs) {
      const a = { ...attribs }
      const src = texto(a.src)
      delete a.src
      delete a.srcset
      if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(src)) {
        a.src = src
      } else if (/^cid:/i.test(src)) {
        // imagen incrustada por Content-ID sin resolver: se deja la pista, no se carga nada
        a['data-cid'] = src.slice(4).replace(/^<|>$/g, '').slice(0, 300)
      } else {
        const remota = urlRemota(src)
        if (remota) a['data-src'] = remota
      }
      return { tagName: 'img', attribs: a }
    },
    a(tagName, attribs) {
      // el detalle se pinta en un <iframe sandbox>: cualquier enlace abre fuera y sin opener
      return { tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow' } }
    },
  },
}

/**
 * HTML de un correo entrante listo para guardarse y pintarse en el panel: sin script/style/
 * iframe/form/object, sin atributos on*, con estilos inline básicos y con las imágenes remotas
 * pasadas a `data-src` (el panel las carga solo al pulsar «cargar imágenes»). Devuelve ''.
 */
export function sanearHtml(html) {
  let entrada = html === undefined || html === null ? '' : String(html)
  if (!entrada.trim()) return ''
  let recortado = false
  if (entrada.length > MAX_HTML) {
    entrada = entrada.slice(0, MAX_HTML)
    recortado = true
  }
  const salida = sanitizeHtml(entrada, OPCIONES_SANEADO).trim()
  return recortado ? `${salida}\n${AVISO_RECORTE}` : salida
}

/** Resumen de una línea (para la lista del buzón): del texto plano o, si no hay, del HTML. */
export function resumenTexto(textoPlano, html, max = 200) {
  let base = texto(textoPlano)
  if (!base && html) base = textoDesdeHtml(html)
  base = base.replace(/\s+/g, ' ').trim()
  if (base.length <= max) return base
  return `${base.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

// ---------------------------------------------------------------------------
// Identificadores e hilos
// ---------------------------------------------------------------------------

const MAX_ID = 500

/** Message-ID sin ángulos ni espacios: '' si no hay nada aprovechable. */
export function normalizarMessageId(valor) {
  const bruto = Array.isArray(valor) ? valor[0] : valor
  const s = texto(bruto).replace(/^<+/, '').replace(/>+$/, '').trim()
  if (!s || /[\s<>]/.test(s)) return ''
  return s.slice(0, MAX_ID)
}

/**
 * Lista de ids de una cabecera References / In-Reply-To (cadena con varios <id>, o array), ya
 * normalizados y sin repetidos. Se conserva el orden: el primero es la raíz del hilo.
 */
export function idsDeReferencias(valor) {
  const partes = Array.isArray(valor) ? valor.flatMap((v) => texto(v).split(/\s+/)) : texto(valor).split(/\s+/)
  const vistos = new Set()
  const salida = []
  for (const parte of partes) {
    const id = normalizarMessageId(parte)
    if (!id || vistos.has(id)) continue
    vistos.add(id)
    salida.push(id)
  }
  return salida
}

/**
 * Clave del hilo (SPEC §14.2): el primer id de References; si no hay, el de In-Reply-To; si no,
 * el propio Message-ID. Devuelve '' si el mensaje no trae ninguno (quien guarda decide el respaldo).
 */
export function extraerThreadKey({ messageId, references, inReplyTo } = {}) {
  const refs = idsDeReferencias(references)
  if (refs.length) return refs[0]
  const respuestaA = idsDeReferencias(inReplyTo)
  if (respuestaA.length) return respuestaA[0]
  return normalizarMessageId(messageId)
}

// ---------------------------------------------------------------------------
// Cuota de espacio
// ---------------------------------------------------------------------------

const enteroPositivo = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/**
 * Cuota y uso de una subcuenta. La cuota sale de location_settings.buzon_quota_mb; si es NULL, de
 * settings.limites.buzon_quota_mb; y si tampoco, de BUZON_QUOTA_MB_DEFAULT.
 * → { cuota_mb, cuota_bytes, usado_bytes, libre_bytes, porcentaje, origen }
 */
export async function cuotaDe(locationId) {
  const loc = texto(locationId)
  let fila = null
  if (loc) {
    const { rows } = await q(
      'SELECT buzon_quota_mb, buzon_used_bytes FROM location_settings WHERE location_id = $1',
      [loc]
    )
    fila = rows[0] ?? null
  }

  let origen = 'subcuenta'
  let cuotaMb = enteroPositivo(fila?.buzon_quota_mb)
  if (!cuotaMb) {
    origen = 'global'
    const limites = await getLimites()
    cuotaMb = enteroPositivo(limites?.buzon_quota_mb)
  }
  if (!cuotaMb) {
    origen = 'defecto'
    cuotaMb = config.buzon.quotaMbDefault
  }

  const usado = Math.max(0, Math.trunc(Number(fila?.buzon_used_bytes) || 0))
  const cuotaBytes = cuotaMb * MB
  return {
    cuota_mb: cuotaMb,
    cuota_bytes: cuotaBytes,
    usado_bytes: usado,
    libre_bytes: Math.max(0, cuotaBytes - usado),
    porcentaje: Math.min(100, Math.round((usado / cuotaBytes) * 1000) / 10),
    origen,
  }
}

/**
 * Suma `deltaBytes` (positivo al guardar, negativo al borrar) al contador cacheado de la subcuenta.
 * UPSERT atómico: el contador nunca baja de 0 y la fila de location_settings se crea si no existe.
 * `cliente` permite hacerlo dentro de una transacción abierta. Devuelve el uso resultante.
 */
export async function ajustarUso(locationId, deltaBytes, cliente = null) {
  const loc = texto(locationId)
  const delta = Math.trunc(Number(deltaBytes) || 0)
  if (!loc) return 0
  const ejecutar = cliente ? (sql, params) => cliente.query(sql, params) : q
  const { rows: [fila] } = await ejecutar(
    `INSERT INTO location_settings (location_id, buzon_used_bytes)
     VALUES ($1, GREATEST(0, $2::bigint))
     ON CONFLICT (location_id) DO UPDATE
       SET buzon_used_bytes = GREATEST(0, location_settings.buzon_used_bytes + $2::bigint),
           updated_at = now()
     RETURNING buzon_used_bytes`,
    [loc, delta]
  )
  return Number(fila?.buzon_used_bytes) || 0
}

/**
 * Recalcula el contador desde las tablas (suma de size_bytes de mensajes + adjuntos). El contador
 * es una caché y puede desviarse (un DELETE de mailboxes arrastra los mensajes en cascada sin
 * pasar por ajustarUso): la sincronización lo llama al empezar cada pasada y conviene llamarlo
 * también al dar de baja una cuenta. Devuelve el valor recalculado.
 */
export async function recalcularUso(locationId) {
  const loc = texto(locationId)
  if (!loc) return 0
  const { rows: [fila] } = await q(
    `INSERT INTO location_settings (location_id, buzon_used_bytes)
     VALUES ($1, (
       SELECT COALESCE(SUM(m.size_bytes), 0)
            + COALESCE((SELECT SUM(a.size_bytes) FROM inbox_attachments a
                          JOIN inbox_messages im ON im.id = a.message_id
                         WHERE im.location_id = $1), 0)
         FROM inbox_messages m WHERE m.location_id = $1
     ))
     ON CONFLICT (location_id) DO UPDATE
       SET buzon_used_bytes = EXCLUDED.buzon_used_bytes, updated_at = now()
     RETURNING buzon_used_bytes`,
    [loc]
  )
  return Number(fila?.buzon_used_bytes) || 0
}

/**
 * Borra un mensaje del buzón con sus adjuntos y descuenta su tamaño de la cuota, todo en una
 * transacción. El mensaje tiene que ser de la subcuenta indicada.
 * → { ok, bytes, adjuntos }
 */
export async function borrarMensajeBuzon(id, locationId) {
  const mensajeId = Number(id)
  const loc = texto(locationId)
  if (!Number.isInteger(mensajeId) || mensajeId <= 0 || !loc) return { ok: false, bytes: 0, adjuntos: 0 }

  const cliente = await pool.connect()
  try {
    await cliente.query('BEGIN')
    const { rows: [mensaje] } = await cliente.query(
      'SELECT id, size_bytes FROM inbox_messages WHERE id = $1 AND location_id = $2 FOR UPDATE',
      [mensajeId, loc]
    )
    if (!mensaje) {
      await cliente.query('ROLLBACK')
      return { ok: false, bytes: 0, adjuntos: 0 }
    }
    const { rows: [adjuntos] } = await cliente.query(
      'SELECT COALESCE(SUM(size_bytes), 0)::bigint AS total, COUNT(*)::int AS n FROM inbox_attachments WHERE message_id = $1',
      [mensajeId]
    )
    const bytes = Math.max(0, (Number(mensaje.size_bytes) || 0) + (Number(adjuntos?.total) || 0))
    // los adjuntos caen en cascada (FK ON DELETE CASCADE)
    await cliente.query('DELETE FROM inbox_messages WHERE id = $1', [mensajeId])
    await ajustarUso(loc, -bytes, cliente)
    await cliente.query('COMMIT')
    return { ok: true, bytes, adjuntos: Number(adjuntos?.n) || 0 }
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    cliente.release()
  }
}

// ---------------------------------------------------------------------------
// Presentación
// ---------------------------------------------------------------------------

const UNIDADES = ['KB', 'MB', 'GB', 'TB']

/** «812 B», «12,4 KB», «3,1 MB»… con coma decimal, para el panel y los mensajes de error. */
export function tamanoLegible(bytes) {
  const n = Math.max(0, Number(bytes) || 0)
  if (n < 1024) return `${Math.round(n)} B`
  let valor = n / 1024
  let indice = 0
  while (valor >= 1024 && indice < UNIDADES.length - 1) {
    valor /= 1024
    indice += 1
  }
  const decimales = valor >= 100 ? 0 : 1
  return `${valor.toFixed(decimales).replace('.', ',')} ${UNIDADES[indice]}`
}

export default {
  sanearHtml,
  resumenTexto,
  normalizarMessageId,
  idsDeReferencias,
  extraerThreadKey,
  cuotaDe,
  ajustarUso,
  recalcularUso,
  borrarMensajeBuzon,
  tamanoLegible,
}
