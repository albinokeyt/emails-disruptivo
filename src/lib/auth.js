import { q } from '../db.js'
import { safeEqual } from './crypto.js'
import { getActionSecret } from './settings.js'
import { getSesionAdmin, getSesionLocation, destruirSesionLocation } from './session.js'

// preHandlers de Fastify. Todos son FAIL-CLOSED: si algo no cuadra, cortan la petición.
// Estos son los ÚNICOS guardas de la app: src/routes/location.js y src/routes/admin.js los
// importan de aquí en vez de definir los suyos. Tener dos versiones con distinta severidad
// acabaría registrando la floja creyendo usar la estricta.

// ---------------------------------------------------------------------------
// Defensa CSRF
//
// La cookie de subcuenta se emite con SameSite=None (obligatorio: el panel vive dentro del iframe
// de GHL), así que el navegador la adjunta TAMBIÉN en peticiones nacidas en cualquier otra web.
// El panel siempre llama desde su propio origen, de modo que un método que muta llegando desde
// otro origen solo puede ser una petición forjada. Se corta en los guardas porque es el único
// punto por el que pasan todas las rutas de /api/loc/* y /api/admin/*.
// ---------------------------------------------------------------------------
const METODOS_QUE_MUTAN = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

function origenesPropios(req) {
  const permitidos = new Set()
  const base = String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')
  if (base) {
    try {
      permitidos.add(new URL(base).origin)
    } catch {
      /* APP_BASE_URL mal formada: se ignora y manda el host de la petición */
    }
  }
  const host = req.headers?.host
  if (host) permitidos.add(`${req.protocol || 'https'}://${host}`)
  return permitidos
}

/** ¿Es una petición que muta llegada desde otro sitio? (true = hay que rechazarla) */
export function peticionCruzada(req) {
  if (!METODOS_QUE_MUTAN.has(String(req.method || '').toUpperCase())) return false
  const sitio = String(req.headers['sec-fetch-site'] || '').toLowerCase()
  if (sitio && sitio !== 'same-origin' && sitio !== 'none') return true
  const origen = String(req.headers.origin || '').trim()
  // sin cabecera Origin no hay navegador detrás (curl, un servidor): no hay CSRF que valga
  if (!origen) return false
  if (origen === 'null') return true // origen opaco (iframe con sandbox): no es nuestro panel
  try {
    return !origenesPropios(req).has(new URL(origen).origin)
  } catch {
    return true
  }
}

const cortarSiCruzada = (req, reply) => {
  if (!peticionCruzada(req)) return false
  reply.code(403).send({ error: 'Petición rechazada: no procede del panel de la aplicación' })
  return true
}

/** Panel de agencia (/api/admin/*). Deja la sesión en req.sesion. */
export async function requireAdmin(req, reply) {
  if (cortarSiCruzada(req, reply)) return reply
  const sesion = await getSesionAdmin(req)
  if (!sesion) return reply.code(401).send({ error: 'No autorizado' })
  req.sesion = sesion
  req.esAdmin = true
}

/**
 * Panel de subcuenta (/api/loc/*). Deja el tenant en req.locationId.
 *
 * REGLA CRÍTICA DE AISLAMIENTO: el location_id sale EXCLUSIVAMENTE de la sesión creada al
 * descifrar el SSO de GHL. Jamás de la query string, del body, de una cabecera ni de un parámetro
 * de ruta: cualquiera de esos sitios es texto que el cliente controla y bastaría para leer los
 * datos de otra subcuenta. De este preHandler depende todo el multi-tenant.
 */
export async function requireLocation(req, reply) {
  if (cortarSiCruzada(req, reply)) return reply
  const sesion = await getSesionLocation(req)
  const locationId = sesion?.locationId
  if (!locationId) {
    return reply.code(401).send({
      error: 'Sesión de subcuenta no válida. Abre la app desde el menú de GoHighLevel.',
    })
  }
  // si la subcuenta desinstaló la app, la sesión que quedara viva deja de valer al instante
  const { rows: [conn] } = await q('SELECT status FROM connections WHERE location_id=$1', [locationId])
  if (conn?.status === 'uninstalled') {
    await destruirSesionLocation(req, reply)
    return reply.code(403).send({ error: 'La app ya no está instalada en esta subcuenta.' })
  }
  req.sesion = sesion
  req.locationId = locationId
  req.conexion = conn || null
}

/**
 * Endpoints que llama GoHighLevel al ejecutar un nodo o al pintar un campo Dynamic
 * (/api/ghl/accion/... y /api/ghl/dinamico/...). La firma del POST de GHL no está confirmada, así
 * que la autenticación real es el segmento secreto de la URL (settings.ghl.action_secret),
 * comparado en tiempo constante.
 *
 * Además resuelve el tenant a partir de extras.locationId, pero SOLO si esa subcuenta tiene una
 * instalación viva: req.locationId queda sin definir en cualquier otro caso, de modo que una ruta
 * que lo exija falla sola. Los errores van con {ok:false,...} porque se leen en el log del workflow.
 */
export async function requireActionSecret(req, reply) {
  const esperado = await getActionSecret()
  if (!esperado) {
    return reply.code(503).send({
      ok: false,
      error: 'La app aún no tiene generado el secreto de las acciones. Entra en Ajustes del panel de agencia.',
    })
  }
  const recibido = String(req.params?.secreto || '')
  if (!recibido || !safeEqual(recibido, esperado)) {
    return reply.code(401).send({ ok: false, error: 'Secreto de acción no válido' })
  }

  const extras = req.body?.extras || {}
  req.ghlExtras = extras
  req.ghlMeta = req.body?.meta || {}
  req.ghlData = req.body?.data || {}

  const locationId = String(extras.locationId || '').trim()
  if (locationId) {
    const { rows: [conn] } = await q(
      'SELECT id, location_id, name, status FROM connections WHERE location_id=$1',
      [locationId]
    )
    if (conn && conn.status !== 'uninstalled') {
      req.locationId = conn.location_id
      req.conexion = conn
    }
  }
}
