import { q } from '../db.js'
import { redis } from '../redis.js'
import { getGhlConfig } from './settings.js'

const API = 'https://services.leadconnectorhq.com'
const VERSION = '2021-07-28'
const AUTH_BASE = 'https://marketplace.gohighlevel.com/oauth/chooselocation'

// La app solo necesita identificar la subcuenta (el SSO ya la certifica) y poder leer su nombre.
// oauth.write es lo que habilita el canje agencia → subcuenta de /oauth/locationToken.
// contacts.readonly + contacts.write son de la sección «Rebotados» (SPEC §12.2): resolver el
// contacto por email y activarle el DND del canal Email. Son scopes de subcuenta, así que no
// convierten la app en "Agency Only"; eso sí, una instalación anterior a este cambio tiene que
// REINSTALARSE para que su token los traiga (GHL-SETUP.md lo avisa).
// NO se piden scopes de nivel agencia de la lista negra de distribución (companies.*, location.write,
// snapshots.*, custom-menu-link.*): pedirlos convertiría la app en "Agency Only" y se perdería la
// instalación por subcuenta, que es de donde sale la entrada del menú lateral.
export const DEFAULT_SCOPES = ['locations.readonly', 'oauth.readonly', 'oauth.write', 'contacts.readonly', 'contacts.write']

export function buildAuthUrl(cfg, redirectUri, { scopes = DEFAULT_SCOPES, state } = {}) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.client_id,
    redirect_uri: redirectUri,
    scope: scopes.join(' '),
  })
  if (state) params.set('state', state)
  return `${AUTH_BASE}?${params}`
}

async function tokenRequest(form) {
  // timeout menor que el TTL del lock de refresh (20s): la sección crítica queda acotada
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const raw = data?.message || data?.error_description || data?.error || `HTTP ${res.status}`
    const err = new Error(`OAuth GHL falló: ${Array.isArray(raw) ? raw.join('; ') : raw}`)
    err.status = res.status
    throw err
  }
  return data
}

export async function exchangeCode(code, redirectUri) {
  const cfg = await getGhlConfig()
  if (!cfg.client_id || !cfg.client_secret) {
    throw new Error('Faltan las credenciales de la app GHL (client_id/client_secret) en Ajustes')
  }
  // sin user_type=Location GHL devuelve token de agencia sin locationId
  return tokenRequest({
    grant_type: 'authorization_code',
    client_id: cfg.client_id,
    client_secret: cfg.client_secret,
    code,
    user_type: 'Location',
    redirect_uri: redirectUri,
  })
}

/**
 * Canje agencia → subcuenta. Si quien instaló fue la agencia, el token del callback es de tipo
 * Company y no trae locationId: hay que cambiarlo por uno de subcuenta antes de poder tocar sus
 * endpoints. Devuelve { access_token, expires_in, locationId, userType, ... }.
 * OJO: la respuesta NO incluye refresh_token; caduca en ~24 h y hay que volver a canjearlo.
 */
export async function exchangeLocationToken(agencyAccessToken, companyId, locationId) {
  if (!agencyAccessToken) throw new Error('Falta el token de agencia para canjear el token de subcuenta')
  if (!companyId || !locationId) throw new Error('Faltan companyId o locationId para el canje')
  const res = await fetch(`${API}/oauth/locationToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      Version: VERSION,
      Authorization: `Bearer ${agencyAccessToken}`,
    },
    body: new URLSearchParams({ companyId, locationId }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const raw = data?.message || data?.error || `HTTP ${res.status}`
    const err = new Error(`No se pudo canjear el token de subcuenta: ${Array.isArray(raw) ? raw.join('; ') : raw}`)
    err.status = res.status
    throw err
  }
  return data
}

/** Subcuentas donde la agencia tiene la app instalada (requiere token de agencia). */
export async function listInstalledLocations(agencyAccessToken, companyId, appId, { limit = 100, skip = 0 } = {}) {
  const url = new URL(`${API}/oauth/installedLocations`)
  url.searchParams.set('companyId', companyId)
  if (appId) url.searchParams.set('appId', appId)
  url.searchParams.set('isInstalled', 'true')
  url.searchParams.set('limit', String(limit))
  url.searchParams.set('skip', String(skip))
  const res = await fetch(url, {
    headers: { Accept: 'application/json', Version: VERSION, Authorization: `Bearer ${agencyAccessToken}` },
    signal: AbortSignal.timeout(30_000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const raw = data?.message || data?.error || `HTTP ${res.status}`
    const err = new Error(`No se pudieron listar las subcuentas instaladas: ${Array.isArray(raw) ? raw.join('; ') : raw}`)
    err.status = res.status
    throw err
  }
  return data?.locations || []
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const expMs = (conn) => (conn?.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0)
const tokenFresh = (conn) => Boolean(conn?.access_token) && expMs(conn) - Date.now() > 120_000

// Los refresh tokens de GHL son de UN SOLO USO: serializar el refresh con lock Redis
export async function getAccessToken(connectionId) {
  const { rows: [conn] } = await q('SELECT * FROM connections WHERE id=$1', [connectionId])
  if (!conn || conn.status !== 'connected') throw new Error('Conexión GHL no disponible')
  if (tokenFresh(conn)) return conn.access_token
  if (!conn.refresh_token) throw new Error('Conexión sin refresh token: reconecta la subcuenta')

  const lockKey = `ghltok:${connectionId}`
  const lockVal = `${Date.now()}-${Math.random()}`
  let locked = false
  for (let i = 0; i < 40; i++) {
    locked = Boolean(await redis.set(lockKey, lockVal, 'PX', 20_000, 'NX'))
    if (locked) break
    await sleep(250)
    const { rows: [again] } = await q('SELECT * FROM connections WHERE id=$1', [connectionId])
    if (tokenFresh(again)) return again.access_token
  }
  if (!locked) throw new Error('Timeout esperando el refresh del token GHL')

  try {
    const { rows: [fresh] } = await q('SELECT * FROM connections WHERE id=$1', [connectionId])
    if (tokenFresh(fresh)) return fresh.access_token
    const cfg = await getGhlConfig()
    const tok = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: cfg.client_id,
      client_secret: cfg.client_secret,
      refresh_token: fresh.refresh_token,
      user_type: 'Location',
    })
    const expiresAt = new Date(Date.now() + ((Number(tok.expires_in) || 3600) - 60) * 1000)
    await q(
      `UPDATE connections SET access_token=$1, refresh_token=COALESCE($2, refresh_token),
       token_expires_at=$3, status='connected', updated_at=now() WHERE id=$4`,
      [tok.access_token, tok.refresh_token || null, expiresAt, connectionId]
    )
    return tok.access_token
  } catch (err) {
    // solo marcar la conexión como rota si GHL rechazó las credenciales — nunca por red, timeout o rate limit (429/408)
    if (err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 408) {
      // si otro proceso ya rotó los tokens con éxito, no pisar su estado
      const { rows: [ahora] } = await q('SELECT access_token, token_expires_at FROM connections WHERE id=$1', [connectionId])
      if (!tokenFresh(ahora)) {
        await q(`UPDATE connections SET status='error', updated_at=now() WHERE id=$1`, [connectionId])
      }
    }
    throw err
  } finally {
    await redis.eval(
      `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end`,
      1, lockKey, lockVal
    )
  }
}

/** Igual que getAccessToken pero partiendo del location_id, que es la clave de tenant de la app. */
export async function getAccessTokenByLocation(locationId) {
  const { rows: [conn] } = await q('SELECT id FROM connections WHERE location_id=$1', [locationId])
  if (!conn) throw new Error('Esa subcuenta no tiene la app conectada')
  return getAccessToken(conn.id)
}

export async function apiCall(connectionId, method, path, { query, body } = {}) {
  let token = await getAccessToken(connectionId)
  for (let intento = 0; intento < 2; intento++) {
    const url = new URL(API + path)
    if (query) {
      for (const [k, v] of Object.entries(query)) if (v !== null && v !== undefined) url.searchParams.set(k, v)
    }
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: VERSION,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    if (res.status === 401 && intento === 0) {
      // token inválido antes de expirar: fuerza refresh y reintenta una vez
      await q('UPDATE connections SET token_expires_at=NULL, updated_at=now() WHERE id=$1', [connectionId])
      token = await getAccessToken(connectionId)
      continue
    }
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }
    if (!res.ok) {
      const raw = data?.message || data?.error || `HTTP ${res.status}`
      const err = new Error(Array.isArray(raw) ? raw.join('; ') : String(raw))
      err.status = res.status
      err.data = data
      throw err
    }
    return data
  }
  throw new Error('GHL sigue devolviendo 401 tras refrescar el token')
}

// ---------------------------------------------------------------------------
// Contactos (sección «Rebotados», SPEC §12.2)
// ---------------------------------------------------------------------------

// Las distintas rutas de contactos devuelven formas distintas: { contact }, { contacts: [...] }
// o el contacto suelto. Se acepta cualquiera con tal de que traiga un id.
function extraerContacto(data) {
  const bruto = data?.contact ?? (Array.isArray(data?.contacts) ? data.contacts[0] : null) ?? data
  return bruto && typeof bruto === 'object' && bruto.id ? bruto : null
}

/**
 * Busca el contacto de una subcuenta por su email. Devuelve el contacto ({ id, ... }) o null si
 * no existe.
 *
 * Primero intenta GET /contacts/search/duplicate (la vía barata y exacta). El SPEC §12.2 pide
 * verificar en el primer despliegue cuál de los dos endpoints responde: si ese contesta 404/400
 * (no existe o no admite esta forma de llamada), se cae a POST /contacts/search filtrando por
 * email. Un "no encontrado" legítimo también acaba en el fallback, que devuelve null igual, así
 * que el resultado es coherente por las dos vías.
 */
export async function buscarContactoPorEmail(connectionId, locationId, email) {
  const loc = String(locationId ?? '').trim()
  const direccion = String(email ?? '').trim().toLowerCase()
  if (!loc || !direccion) return null

  try {
    const data = await apiCall(connectionId, 'GET', '/contacts/search/duplicate', {
      query: { locationId: loc, email: direccion },
    })
    const contacto = extraerContacto(data)
    if (contacto) return contacto
  } catch (err) {
    if (err?.status !== 404 && err?.status !== 400) throw err
  }

  const data = await apiCall(connectionId, 'POST', '/contacts/search', {
    body: {
      locationId: loc,
      page: 1,
      pageLimit: 1,
      filters: [{ field: 'email', operator: 'eq', value: direccion }],
    },
  })
  return extraerContacto(data)
}

/**
 * Activa el DND del CANAL Email de un contacto: PUT /contacts/{id} con
 * dndSettings.Email.status='active'. A propósito NO se toca el `dnd` global (SPEC §12.2): lo que
 * está roto es el correo del contacto, y el cliente tiene que poder seguir mandándole SMS o
 * llamándole. Los demás canales del dndSettings no se envían para no pisar su estado actual.
 */
export async function activarDndEmail(connectionId, contactId) {
  const id = String(contactId ?? '').trim()
  if (!id) throw new Error('Falta el id del contacto para activar su DND')
  return apiCall(connectionId, 'PUT', `/contacts/${encodeURIComponent(id)}`, {
    body: {
      dndSettings: {
        Email: { status: 'active', message: 'Rebote duro: dirección de correo inexistente o inaccesible' },
      },
    },
  })
}

export async function fetchLocationName(connectionId, locationId) {
  try {
    const data = await apiCall(connectionId, 'GET', `/locations/${encodeURIComponent(locationId)}`)
    return data?.location?.name || data?.name || null
  } catch {
    return null
  }
}
