import { redis } from '../redis.js'
import { getLimites } from './settings.js'

// Ventana fija en Redis. INCR + EXPIRE se hacen ATÓMICOS en un solo round-trip vía Lua: la clave
// nunca queda sin TTL (evita claves huérfanas si un EXPIRE separado fallara tras un INCR con éxito).
const SCRIPT_SIMPLE = `local v = redis.call('INCR', KEYS[1]); redis.call('EXPIRE', KEYS[1], ARGV[1]); return v`

/** Limitador genérico: bucketKey identifica al sujeto (ip, subcuenta…), limit por windowS segundos. */
export async function rateLimit(bucketKey, limit, windowS) {
  const slot = Math.floor(Date.now() / 1000 / windowS)
  const key = `rl:${bucketKey}:${slot}`
  let n
  try {
    n = Number(await redis.eval(SCRIPT_SIMPLE, 1, key, windowS + 1))
  } catch {
    // el limitador es una defensa, no la puerta principal: si Redis cae no bloqueamos la app
    return { ok: true, restante: limit, degradado: true }
  }
  return { ok: n <= limit, restante: Math.max(0, limit - n), degradado: false }
}

// ---------------------------------------------------------------------------
// Límite de envíos por subcuenta (minuto y día)
//
// Las dos ventanas se consumen en el MISMO script para que un rechazo por minuto no gaste cuota
// diaria: si el minuto ya está lleno se corta antes de tocar el contador del día.
// ---------------------------------------------------------------------------
const SCRIPT_ENVIO = `
local m = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ARGV[3])
local limMin = tonumber(ARGV[1])
if limMin > 0 and m > limMin then return {0, m, -1} end
local d = redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], ARGV[4])
local limDia = tonumber(ARGV[2])
if limDia > 0 and d > limDia then return {0, m, d} end
return {1, m, d}
`

/**
 * Consume un hueco de envío para la subcuenta. Se llama JUSTO antes de encolar/enviar.
 * Devuelve { ok, motivo, limites, usados }.
 */
export async function consumirLimiteEnvio(locationId, { unidades = 1 } = {}) {
  const limites = await getLimites()
  const ahora = Math.floor(Date.now() / 1000)
  const claveMin = `envio:${locationId}:m:${Math.floor(ahora / 60)}`
  const claveDia = `envio:${locationId}:d:${Math.floor(ahora / 86400)}`

  let res
  try {
    res = await redis.eval(
      SCRIPT_ENVIO, 2, claveMin, claveDia,
      limites.envio_minuto, limites.envio_dia, 120, 172800
    )
  } catch {
    // sin Redis no se puede contar; se deja pasar para no cortar el correo de todos los clientes
    return { ok: true, motivo: null, limites, usados: null, degradado: true }
  }

  const [ok, usadosMinuto, usadosDia] = (res || []).map(Number)
  if (ok === 1) {
    if (unidades > 1) {
      // varios destinatarios en un mismo mensaje: se ajusta el contador sin volver a comprobar
      await redis.incrby(claveMin, unidades - 1).catch(() => {})
      await redis.incrby(claveDia, unidades - 1).catch(() => {})
    }
    return { ok: true, motivo: null, limites, usados: { minuto: usadosMinuto, dia: usadosDia }, degradado: false }
  }

  const motivo = usadosDia === -1
    ? `Límite de ${limites.envio_minuto} envíos por minuto alcanzado en esta subcuenta`
    : `Límite de ${limites.envio_dia} envíos diarios alcanzado en esta subcuenta`
  return { ok: false, motivo, limites, usados: { minuto: usadosMinuto, dia: usadosDia }, degradado: false }
}

/** Consulta sin consumir, para pintar el estado en el panel. */
export async function consultarLimiteEnvio(locationId) {
  const limites = await getLimites()
  const ahora = Math.floor(Date.now() / 1000)
  try {
    const [m, d] = await redis.mget(
      `envio:${locationId}:m:${Math.floor(ahora / 60)}`,
      `envio:${locationId}:d:${Math.floor(ahora / 86400)}`
    )
    return {
      limites,
      usados: { minuto: Number(m) || 0, dia: Number(d) || 0 },
      restante: {
        minuto: Math.max(0, limites.envio_minuto - (Number(m) || 0)),
        dia: Math.max(0, limites.envio_dia - (Number(d) || 0)),
      },
    }
  } catch {
    return { limites, usados: null, restante: null, degradado: true }
  }
}

// ---------------------------------------------------------------------------
// Intentos de login del panel de admin
// ---------------------------------------------------------------------------
export const LOGIN_MAX_FALLOS = 10
export const LOGIN_VENTANA_S = 900

/** ¿Puede intentar login? No consume nada: solo los FALLOS cuentan. */
export async function loginPermitido(clave) {
  try {
    const n = Number(await redis.get(`login:${clave}`)) || 0
    return { ok: n < LOGIN_MAX_FALLOS, fallos: n }
  } catch {
    return { ok: true, fallos: 0, degradado: true }
  }
}

/** Registra un intento fallido y renueva la ventana de bloqueo. */
export async function registrarFalloLogin(clave) {
  try {
    const n = Number(await redis.eval(SCRIPT_SIMPLE, 1, `login:${clave}`, LOGIN_VENTANA_S))
    return { fallos: n, bloqueado: n >= LOGIN_MAX_FALLOS }
  } catch {
    return { fallos: 0, bloqueado: false, degradado: true }
  }
}

/** Login correcto: se limpia el contador. */
export async function limpiarFallosLogin(clave) {
  await redis.del(`login:${clave}`).catch(() => {})
}
