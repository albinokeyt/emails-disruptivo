import { randomBytes } from 'node:crypto'
import { redis } from '../redis.js'
import { q } from '../db.js'
import { decryptGhlSso, ssoAuthorized, normalizarIdentidadSso } from './sso.js'
import { getGhlConfig, getAdmins } from './settings.js'
import { fetchLocationName } from './ghl.js'

// Dos sesiones INDEPENDIENTES, con cookie propia cada una:
//   ed_admin → panel de la agencia (/admin/*). SameSite=Lax salvo que nazca dentro del iframe.
//   ed_loc   → panel de subcuenta, que SIEMPRE vive dentro del iframe de GHL, así que necesita
//              SameSite=None; Secure; Partitioned (CHIPS) para que el navegador la envíe.
// Separarlas evita que un admin de agencia que abre una subcuenta pierda su sesión de admin, y
// que la cookie del iframe se cuele en el panel de agencia.

const COOKIE_ADMIN = 'ed_admin'
const COOKIE_LOC = 'ed_loc'
const TTL_ADMIN = 60 * 60 * 24 * 7
const TTL_LOC = 60 * 60 * 12

const appBaseUrl = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')

const errorHttp = (status, mensaje) => {
  const err = new Error(mensaje)
  err.status = status
  err.statusCode = status
  return err
}

async function crearSesion(req, reply, cookie, datos, ttl, crossSite) {
  const token = randomBytes(32).toString('hex')
  await redis.set(`sess:${cookie}:${token}`, JSON.stringify(datos), 'EX', ttl)
  reply.setCookie(cookie, token, {
    path: '/',
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    // SameSite=None EXIGE Secure; en directo se mira el transporte real (trustProxy) con APP_BASE_URL de respaldo
    secure: crossSite || req?.protocol === 'https' || appBaseUrl().startsWith('https'),
    partitioned: crossSite || undefined,
    maxAge: ttl,
  })
  return token
}

async function leerSesion(req, cookie) {
  const token = req.cookies?.[cookie]
  if (!token) return null
  const raw = await redis.get(`sess:${cookie}:${token}`)
  if (!raw) return null
  try {
    const s = JSON.parse(raw)
    return s && typeof s === 'object' ? s : null
  } catch {
    return null
  }
}

async function borrarSesion(req, reply, cookie) {
  const token = req.cookies?.[cookie]
  if (token) await redis.del(`sess:${cookie}:${token}`)
  reply.clearCookie(cookie, { path: '/' })
}

// --- Sesión de admin de agencia ---------------------------------------------

/** datos = { usuario, email?, via: 'password'|'sso' }. */
export const crearSesionAdmin = (req, reply, datos, { crossSite = false } = {}) =>
  crearSesion(req, reply, COOKIE_ADMIN, { tipo: 'admin', ...datos }, TTL_ADMIN, crossSite)

export const getSesionAdmin = async (req) => {
  const s = await leerSesion(req, COOKIE_ADMIN)
  return s?.tipo === 'admin' ? s : null
}

export const destruirSesionAdmin = (req, reply) => borrarSesion(req, reply, COOKIE_ADMIN)

// --- Sesión de subcuenta (solo se crea desde el SSO descifrado) --------------

/** datos = { locationId, nombre, email, userId, companyId, esAdminAgencia }. */
export const crearSesionLocation = (req, reply, datos) =>
  crearSesion(req, reply, COOKIE_LOC, { tipo: 'location', ...datos }, TTL_LOC, true)

export const getSesionLocation = async (req) => {
  const s = await leerSesion(req, COOKIE_LOC)
  return s?.tipo === 'location' && s.locationId ? s : null
}

export const destruirSesionLocation = (req, reply) => borrarSesion(req, reply, COOKIE_LOC)

// El callback de OAuth guarda el nombre de la subcuenta al instalar, pero si aquella llamada falló
// (o la fila nació de un SSO sin instalación OAuth) la conexión se queda sin nombre para siempre y
// el panel enseña «Sin nombre». Este auto-reparado lo reintenta al iniciar sesión: como el nombre es
// cosmético, se espera como mucho 5 s — si GHL tarda más, la promesa pendiente lo deja guardado
// igualmente y la PRÓXIMA entrada ya lo enseña. Un fallo se apunta en Redis 10 minutos para que una
// subcuenta cuyo nombre no se puede resolver (sin token, GHL caído…) no pague la espera en cada
// handshake indefinidamente.
const ESPERA_NOMBRE_MS = 5_000
const REINTENTO_NOMBRE_S = 600
async function recuperarNombreConexion(connectionId, locationId) {
  const claveFallo = `locname:fallo:${connectionId}`
  try {
    if (await redis.get(claveFallo)) return null
  } catch {
    /* sin Redis se intenta igual: el timeout de abajo sigue acotando la espera */
  }
  try {
    const intento = fetchLocationName(connectionId, locationId)
      .then(async (n) => {
        const nombre = String(n || '').trim().slice(0, 200)
        if (!nombre) return null
        // COALESCE por si otra petición simultánea (u OAuth) ya lo escribió: no se pisa
        await q(
          `UPDATE connections SET name = COALESCE(name, $1), updated_at = now() WHERE id = $2`,
          [nombre, connectionId]
        )
        return nombre
      })
      .catch(() => null)
    const nombre = await Promise.race([intento, new Promise((r) => setTimeout(r, ESPERA_NOMBRE_MS, null))])
    if (!nombre) await redis.set(claveFallo, '1', 'EX', REINTENTO_NOMBRE_S).catch(() => {})
    return nombre
  } catch {
    return null
  }
}

/**
 * Canjea el payload cifrado que GHL entrega al iframe (postMessage REQUEST_USER_DATA) por las
 * sesiones que correspondan. Es el ÚNICO sitio de toda la app donde nace un location_id de sesión:
 * viene firmado con el Shared Secret, así que no se puede falsificar como sí se podría con un
 * parámetro de la URL.
 * Devuelve { locationId, nombre, esAdminAgencia } tal y como espera POST /api/sesion/sso.
 */
export async function iniciarSesionSso(req, reply, payloadCifrado) {
  if (!payloadCifrado) throw errorHttp(400, 'Falta el contexto cifrado de GoHighLevel')
  const cfg = await getGhlConfig()
  if (!cfg.shared_secret) {
    throw errorHttp(503, 'SSO sin configurar: falta el Shared Secret de la app en Ajustes')
  }

  let identidad
  try {
    identidad = decryptGhlSso(payloadCifrado, cfg.shared_secret)
  } catch {
    // no se filtra el motivo: para el cliente solo hay "no te puedo identificar"
    throw errorHttp(401, 'No se pudo verificar tu identidad de GoHighLevel')
  }

  const id = normalizarIdentidadSso(identidad)
  const esAdminAgencia = ssoAuthorized(identidad, await getAdmins(), cfg)

  if (esAdminAgencia) {
    await crearSesionAdmin(
      req, reply,
      { usuario: id.email || id.userId || 'sso', email: id.email, via: 'sso', companyId: id.companyId },
      { crossSite: true }
    )
  }

  if (!id.locationId) {
    // contexto de agencia: sin subcuenta activa solo tiene sentido si es admin autorizado
    if (!esAdminAgencia) {
      throw errorHttp(403, 'Abre la app desde una subcuenta: en el contexto de agencia no hay nada que gestionar')
    }
    return { locationId: null, nombre: null, esAdminAgencia: true }
  }

  const { rows: [conn] } = await q(
    'SELECT id, name, status FROM connections WHERE location_id=$1',
    [id.locationId]
  )
  if (conn?.status === 'uninstalled') {
    throw errorHttp(403, 'La app ya no está instalada en esta subcuenta. Vuelve a instalarla para continuar.')
  }

  let nombre = conn?.name || null
  if (!nombre && conn?.id) nombre = await recuperarNombreConexion(conn.id, id.locationId)
  await crearSesionLocation(req, reply, {
    locationId: id.locationId,
    nombre,
    email: id.email,
    userId: id.userId,
    companyId: id.companyId,
    esAdminAgencia,
  })
  return { locationId: id.locationId, nombre, esAdminAgencia }
}

/** Resumen de la sesión activa para GET /api/sesion. null si no hay ninguna. */
export async function sesionActual(req) {
  const loc = await getSesionLocation(req)
  const admin = await getSesionAdmin(req)
  if (!loc && !admin) return null
  return {
    locationId: loc?.locationId ?? null,
    nombre: loc?.nombre ?? null,
    email: loc?.email ?? admin?.email ?? null,
    esAdminAgencia: Boolean(admin) || Boolean(loc?.esAdminAgencia),
  }
}
