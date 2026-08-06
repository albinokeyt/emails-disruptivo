import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

// ---------------------------------------------------------------------------
// Cifrado simétrico de las credenciales de proveedor (providers.credentials_enc)
//
// Formato: v1$<iv>$<tag>$<ciphertext>, las tres partes en base64url.
// El prefijo de versión permite cambiar de algoritmo sin migrar la tabla, y
// ENCRYPTION_KEY admite VARIAS claves separadas por comas: la primera cifra y
// todas se prueban al descifrar. Así se rota la clave sin parar la app
// (se despliega "nueva,vieja", se re-cifra en segundo plano, y luego se deja
// solo la nueva). El tag GCM hace que probar claves sea inequívoco: solo la
// correcta autentica.
// ---------------------------------------------------------------------------

const VERSION = 'v1'
const IV_BYTES = 12 // 96 bits: tamaño recomendado para GCM
const CLAVE_BYTES = 32 // AES-256

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const deB64u = (txt) => Buffer.from(String(txt), 'base64url')

function decodificarClave(txt) {
  const s = String(txt).trim()
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex')
  const b = Buffer.from(s, 'base64')
  return b.length === CLAVE_BYTES ? b : null
}

let clavesCache = null

/** Claves de cifrado válidas, en orden de preferencia (la primera es la activa). */
export function clavesCifrado() {
  if (clavesCache) return clavesCache
  const partes = String(process.env.ENCRYPTION_KEY || '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean)
  const claves = []
  for (const p of partes) {
    const k = decodificarClave(p)
    if (k) claves.push(k)
  }
  clavesCache = claves
  return claves
}

/** Fail-fast de arranque: sin ENCRYPTION_KEY válida la app no debe levantarse. */
export function verificarClaveCifrado() {
  const claves = clavesCifrado()
  if (!claves.length) {
    throw new Error(
      'ENCRYPTION_KEY no está definida o no es válida: se esperan 32 bytes en base64 o 64 caracteres hex ' +
        '(se admiten varias claves separadas por comas para rotarla).'
    )
  }
  return claves.length
}

/** Cifra una cadena con la clave activa. Devuelve v1$iv$tag$ct (base64url). */
export function encrypt(texto) {
  const [clave] = clavesCifrado()
  if (!clave) verificarClaveCifrado()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', clave, iv)
  const ct = Buffer.concat([cipher.update(String(texto), 'utf8'), cipher.final()])
  return `${VERSION}$${b64u(iv)}$${b64u(cipher.getAuthTag())}$${b64u(ct)}`
}

/** Descifra el formato anterior probando todas las claves configuradas. */
export function decrypt(payload) {
  const partes = String(payload || '').split('$')
  if (partes.length !== 4 || partes[0] !== VERSION) {
    throw new Error('Dato cifrado con formato desconocido')
  }
  const [, ivB64, tagB64, ctB64] = partes
  const iv = deB64u(ivB64)
  const tag = deB64u(tagB64)
  const ct = deB64u(ctB64)
  const claves = clavesCifrado()
  if (!claves.length) verificarClaveCifrado()
  for (const clave of claves) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', clave, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch {
      // clave equivocada: se prueba la siguiente
    }
  }
  throw new Error('No se pudieron descifrar los datos: revisa ENCRYPTION_KEY (¿se cambió sin rotar?)')
}

/** Credenciales de proveedor: objeto → cadena cifrada lista para credentials_enc. */
export const cifrarCredenciales = (obj) => encrypt(JSON.stringify(obj ?? {}))

/** Inversa de cifrarCredenciales. Devuelve siempre un objeto. */
export function descifrarCredenciales(payload) {
  const txt = decrypt(payload)
  try {
    const obj = JSON.parse(txt)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    throw new Error('Las credenciales descifradas no son un JSON válido')
  }
}

// ---------------------------------------------------------------------------
// Contraseñas (relay_accounts.password_hash) y comparaciones seguras
// ---------------------------------------------------------------------------

/** scrypt con sal por registro. Formato: scrypt$<sal hex>$<derivada hex>. */
export function hashPassword(pw) {
  const salt = randomBytes(16)
  const dk = scryptSync(String(pw), salt, 32)
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`
}

/** Verifica una contraseña contra el hash almacenado, en tiempo constante. */
export function verifyPassword(pw, stored) {
  try {
    const [esquema, saltHex, hashHex] = String(stored).split('$')
    if (esquema !== 'scrypt' || !saltHex || !hashHex) return false
    const esperado = Buffer.from(hashHex, 'hex')
    const dk = scryptSync(String(pw), Buffer.from(saltHex, 'hex'), esperado.length)
    return dk.length === esperado.length && timingSafeEqual(dk, esperado)
  } catch {
    return false
  }
}

/** Comparación en tiempo constante (login de admin, secretos en URL, tokens). */
export function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) {
    // se compara contra sí mismo para no filtrar la longitud por timing
    timingSafeEqual(ba, ba)
    return false
  }
  return timingSafeEqual(ba, bb)
}

// ---------------------------------------------------------------------------
// Generadores
// ---------------------------------------------------------------------------

/** Hash estable de un token, para indexar sin guardar el valor en claro. */
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex')

/** Token aleatorio apto para URL (tracking, webhooks, verificación de dominio). */
export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url')

/** Secreto aleatorio para segmentos fijos de URL (settings.ghl.action_secret). */
export const randomSecret = (bytes = 24) => randomBytes(bytes).toString('base64url')

/** Contraseña aleatoria que se enseña UNA sola vez (credenciales del relay SMTP). */
export const randomPassword = (bytes = 18) => randomBytes(bytes).toString('base64url')

/** Identificador de correlación de un mensaje (viaja en X-Mailin-custom). */
export const randomCorrelationId = () => `ed_${randomBytes(16).toString('hex')}`
