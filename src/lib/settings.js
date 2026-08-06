import { q } from '../db.js'
import { randomSecret } from './crypto.js'

// Tabla settings (clave/valor jsonb). Claves usadas por la app:
//   ghl      → { client_id, client_secret, app_id, shared_secret, company_id, action_secret }
//   limites  → { envio_minuto, envio_dia, ... }
//   admins   → { emails: [], company_ids: [] }
//
// Cache muy corta en memoria: estos valores se leen en casi cada petición (secreto de acción,
// límites) pero cambian a mano desde el panel. 10 s acota la incoherencia entre instancias sin
// castigar a Postgres.

const cache = new Map()
const TTL = 10_000

export async function getSetting(key) {
  const hit = cache.get(key)
  if (hit && hit.at > Date.now() - TTL) return hit.value
  const { rows } = await q('SELECT value FROM settings WHERE key=$1', [key])
  const value = rows[0]?.value ?? null
  cache.set(key, { value, at: Date.now() })
  return value
}

export async function setSetting(key, value) {
  await q(
    `INSERT INTO settings(key, value, updated_at) VALUES($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value ?? {})]
  )
  cache.delete(key)
}

/** Escritura parcial: fusiona el parche sobre el valor guardado (nivel raíz). */
export async function mergeSetting(key, patch) {
  const { rows } = await q(
    `INSERT INTO settings(key, value, updated_at) VALUES($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = settings.value || EXCLUDED.value, updated_at = now()
     RETURNING value`,
    [key, JSON.stringify(patch ?? {})]
  )
  cache.delete(key)
  return rows[0]?.value ?? {}
}

/** Invalida la cache (llamar tras escribir por fuera de estos helpers). */
export function invalidarCacheSettings(key) {
  if (key) cache.delete(key)
  else cache.clear()
}

/** Credenciales de la app del marketplace de GHL. Nunca se devuelven tal cual por la API. */
export const getGhlConfig = async () => (await getSetting('ghl')) || {}

const entero = (v, def) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def
}

/**
 * Límites de envío por subcuenta. Los de la tabla mandan sobre las variables de entorno,
 * y estas sobre los valores por defecto del SPEC (60/min, 5000/día).
 */
export async function getLimites() {
  const guardados = (await getSetting('limites')) || {}
  return {
    ...guardados,
    envio_minuto: entero(guardados.envio_minuto, entero(process.env.ENVIO_LIMITE_MINUTO, 60)),
    envio_dia: entero(guardados.envio_dia, entero(process.env.ENVIO_LIMITE_DIA, 5000)),
  }
}

/** Lista blanca de admins de agencia para el SSO: { emails, company_ids }. */
export async function getAdmins() {
  const a = (await getSetting('admins')) || {}
  return {
    emails: Array.isArray(a.emails) ? a.emails : [],
    company_ids: Array.isArray(a.company_ids) ? a.company_ids : [],
  }
}

/**
 * Secreto fijo que va como segmento de las URLs de los nodos de GHL
 * (/api/ghl/accion/... y /api/ghl/dinamico/...). Solo LEE: si no existe devuelve null
 * para que el preHandler responda 503 en vez de escribir en BD en la ruta caliente.
 */
export async function getActionSecret() {
  const cfg = await getGhlConfig()
  const s = String(cfg.action_secret || '').trim()
  return s || null
}

/**
 * Genera el secreto de acción si aún no existe y lo devuelve. Es idempotente y a prueba de
 * carreras: el COALESCE dentro del UPDATE hace que dos instancias arrancando a la vez acaben
 * con el MISMO secreto (si se pisaran, las URLs ya pegadas en el marketplace dejarían de valer).
 */
export async function asegurarActionSecret() {
  const actual = await getActionSecret()
  if (actual) return actual
  const candidato = randomSecret(24)
  const { rows } = await q(
    `INSERT INTO settings(key, value, updated_at)
     VALUES ('ghl', jsonb_build_object('action_secret', $1::text), now())
     ON CONFLICT (key) DO UPDATE SET
       value = settings.value || jsonb_build_object(
         'action_secret', COALESCE(NULLIF(settings.value->>'action_secret', ''), $1::text)
       ),
       updated_at = now()
     RETURNING value->>'action_secret' AS secreto`,
    [candidato]
  )
  cache.delete('ghl')
  return rows[0]?.secreto || candidato
}

/** Enmascara un secreto para poder enseñarlo en el panel sin exponerlo. */
export function enmascararSecreto(valor) {
  const s = String(valor ?? '')
  if (!s) return null
  if (s.length <= 8) return '••••••••'
  return `${s.slice(0, 4)}••••${s.slice(-4)}`
}
