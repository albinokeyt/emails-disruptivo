import { q } from '../db.js'
import { hashPassword, randomPassword, verifyPassword } from '../lib/crypto.js'
import { limpiarFallosLogin, loginPermitido, registrarFalloLogin } from '../lib/ratelimit.js'
import { errorSmtp } from './routing.js'

// ---------------------------------------------------------------------------
// AUTH PLAIN y LOGIN de la pasarela contra relay_accounts.
//
// Esta pasarela NO es un servidor abierto: cada subcuenta de la agencia tiene su propio usuario y
// su propia contraseña (generados en el panel, guardados con scrypt) y sin credenciales válidas no
// se acepta ni un byte. smtp-server se configura con authOptional:false y allowInsecureAuth:false:
// el AUTH se anuncia en el EHLO, pero en claro se rechaza con «538 Must issue a STARTTLS command
// first» hasta que la sesión sube a TLS, así que ninguna credencial viaja sin cifrar.
// ---------------------------------------------------------------------------

// Un único mensaje para TODOS los fallos de credenciales: si el texto cambiara según el usuario
// exista o no, la pasarela se convertiría en un oráculo para enumerar las cuentas de la agencia.
const MENSAJE_GENERICO = 'Usuario o contrasena incorrectos'

// Hash señuelo: cuando el usuario no existe se verifica igualmente contra él. scrypt tarda decenas
// de milisegundos, así que salir antes delataría por tiempo qué usuarios existen.
// Se genera de forma perezosa para no gastar un scrypt en el arranque de la app cuando el relay
// está apagado, que es lo habitual.
let hashSenuelo = null
const senuelo = () => (hashSenuelo ??= hashPassword(randomPassword(18)))

// Bloqueo por usuario: es el umbral de src/lib/ratelimit.js (10 fallos por ventana de 15 min).
// Bloqueo por IP: MUY alto a propósito. Todo el correo de GHL sale de un puñado de IPs compartidas
// por miles de cuentas ajenas a la agencia; un umbral bajo por IP dejaría sin servicio a todos los
// clientes por culpa de uno solo que se equivoque de contraseña. El freno real es el del usuario,
// porque el usuario es lo que un atacante tendría que adivinar y son 5 bytes aleatorios.
const MAX_FALLOS_IP = 100

// last_used_at es informativo (se pinta en el panel): no merece un UPDATE por cada mensaje cuando
// GHL reutiliza la conexión. Se escribe como mucho una vez por minuto y por subcuenta.
const REFRESCO_USO_MS = 60_000
const ultimoUso = new Map()

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

const ipDe = (session) => texto(session?.remoteAddress).replace(/^::ffff:/, '') || 'desconocida'

function marcarUso(cuenta) {
  const ahora = Date.now()
  if ((ultimoUso.get(cuenta.id) ?? 0) + REFRESCO_USO_MS > ahora) return
  ultimoUso.set(cuenta.id, ahora)
  // fuera del camino crítico: que falle no puede tumbar una autenticación válida
  q('UPDATE relay_accounts SET last_used_at = now() WHERE id = $1', [cuenta.id]).catch(() => {})
}

/**
 * Comprueba las credenciales de una sesión SMTP.
 *
 * @returns {Promise<{ok:true, usuario:{locationId:string, relayAccountId:number, username:string}}
 *                 | {ok:false, codigo:number, mensaje:string}>}
 */
export async function autenticar(auth, session) {
  const usuario = texto(auth?.username)
  const clave = String(auth?.password ?? '')
  const ip = ipDe(session)
  const claveIp = `relay:ip:${ip}`
  const claveUsuario = `relay:u:${usuario.toLowerCase()}`

  if (!usuario || !clave || usuario.length > 200 || clave.length > 1000) {
    return { ok: false, codigo: 535, mensaje: MENSAJE_GENERICO }
  }

  // Los contadores se consultan ANTES de tocar la base y antes de gastar un scrypt: así un ataque
  // por fuerza bruta tampoco sirve para consumir CPU del servidor.
  const [porIp, porUsuario] = await Promise.all([
    loginPermitido(claveIp),
    loginPermitido(claveUsuario),
  ])
  if (porIp.fallos >= MAX_FALLOS_IP || !porUsuario.ok) {
    return { ok: false, codigo: 454, mensaje: 'Demasiados intentos fallidos seguidos. Espera unos minutos.' }
  }

  const { rows: [cuenta] } = await q(
    `SELECT id, location_id, username, password_hash, enabled
       FROM relay_accounts WHERE lower(username) = lower($1)`,
    [usuario]
  )

  // verifyPassword compara en tiempo constante; el señuelo mantiene el mismo coste cuando no hay
  // cuenta. Se evalúa SIEMPRE, antes de mirar `enabled`.
  const claveCorrecta = verifyPassword(clave, cuenta?.password_hash || senuelo())

  if (!cuenta || !claveCorrecta) {
    const fallo = await registrarFalloLogin(claveUsuario)
    await registrarFalloLogin(claveIp)
    return {
      ok: false,
      codigo: 535,
      mensaje: MENSAJE_GENERICO,
      fallos: fallo.fallos,
    }
  }

  // A partir de aquí quien llama ha demostrado conocer la contraseña, así que ya se le puede decir
  // exactamente qué pasa sin revelar nada a un tercero.
  if (!cuenta.enabled) {
    return {
      ok: false,
      codigo: 535,
      mensaje: 'El relay SMTP esta desactivado: activalo en la seccion Relay de la app de email',
    }
  }

  // Un envío bueno desde esta IP limpia su contador: es lo que impide que un cliente despistado
  // deje bloqueada la IP compartida de GHL para los demás.
  await Promise.all([limpiarFallosLogin(claveUsuario), limpiarFallosLogin(claveIp)])
  marcarUso(cuenta)

  return {
    ok: true,
    usuario: {
      locationId: cuenta.location_id,
      relayAccountId: Number(cuenta.id),
      username: cuenta.username,
    },
  }
}

/**
 * Construye el `onAuth` que espera smtp-server.
 * Solo se admiten PLAIN y LOGIN, que son los métodos que usa GHL.
 */
export function crearOnAuth(log) {
  return function onAuth(auth, session, callback) {
    const metodo = texto(auth?.method).toUpperCase()
    if (metodo && !['PLAIN', 'LOGIN'].includes(metodo)) {
      return callback(errorSmtp(504, 'Metodo de autenticacion no soportado: usa AUTH PLAIN o AUTH LOGIN'))
    }

    autenticar(auth, session).then(
      (res) => {
        if (!res.ok) {
          // Se registra el intento, jamás la contraseña ni el hash.
          log?.warn?.(
            { sesion: session?.id, ip: ipDe(session), usuario: texto(auth?.username), codigo: res.codigo },
            'relay: autenticacion rechazada'
          )
          return callback(errorSmtp(res.codigo, res.mensaje))
        }
        log?.info?.(
          { sesion: session?.id, ip: ipDe(session), usuario: res.usuario.username, location: res.usuario.locationId },
          'relay: sesion autenticada'
        )
        return callback(null, { user: res.usuario })
      },
      (err) => {
        // Un fallo de Postgres o de Redis no es culpa del cliente: 454 temporal para que reintente.
        log?.error?.({ err, sesion: session?.id, ip: ipDe(session) }, 'relay: error autenticando')
        return callback(errorSmtp(454, 'No se pudo comprobar las credenciales ahora mismo, reintentalo'))
      }
    )
  }
}
