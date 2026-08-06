import crypto from 'node:crypto'

// GHL cifra el contexto de usuario de las Custom Pages con CryptoJS AES.encrypt(json, sharedSecret),
// que produce el formato OpenSSL "Salted__": base64( "Salted__" + salt(8) + ciphertext ).
// La clave/iv se derivan con EVP_BytesToKey (MD5) a partir del passphrase (Shared Secret) + salt.
// Identidad CERTIFICADA por GHL: no viaja por la URL, así que no se puede falsificar como los menu-links.
export function decryptGhlSso(encryptedBase64, sharedSecret) {
  if (!encryptedBase64 || !sharedSecret) throw new Error('faltan datos para descifrar el SSO')
  const data = Buffer.from(String(encryptedBase64), 'base64')
  if (data.length < 16 || data.subarray(0, 8).toString('utf8') !== 'Salted__') {
    throw new Error('payload SSO con formato inesperado')
  }
  const salt = data.subarray(8, 16)
  const ciphertext = data.subarray(16)
  const { key, iv } = evpBytesToKey(Buffer.from(String(sharedSecret), 'utf8'), salt, 32, 16)
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  const out = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  const obj = JSON.parse(out.toString('utf8'))
  if (!obj || typeof obj !== 'object') throw new Error('payload SSO no es un objeto')
  return obj
}

// EVP_BytesToKey (OpenSSL) con MD5, tal y como lo hace CryptoJS por defecto.
function evpBytesToKey(pass, salt, keyLen, ivLen) {
  let d = Buffer.alloc(0)
  let prev = Buffer.alloc(0)
  while (d.length < keyLen + ivLen) {
    prev = crypto.createHash('md5').update(Buffer.concat([prev, pass, salt])).digest()
    d = Buffer.concat([d, prev])
  }
  return { key: d.subarray(0, keyLen), iv: d.subarray(keyLen, keyLen + ivLen) }
}

// ¿Está autorizada esta identidad de GHL a entrar como admin del panel? FAIL-CLOSED.
// OJO: el companyId de la agencia viaja en el token de CUALQUIER usuario bajo ella (incluidos usuarios
// de subcuenta y roles restringidos), así que la autorización por empresa se limita a admins A NIVEL
// AGENCIA (type='agency' + role='admin'). La lista blanca de correos es el mecanismo preciso.
export function ssoAuthorized(identity, admins = {}, ghlCfg = {}) {
  const email = String(identity?.email || '').trim().toLowerCase()
  const companyId = String(identity?.companyId || '').trim()
  const type = String(identity?.type || '').toLowerCase()
  const role = String(identity?.role || '').toLowerCase()
  // `type` vale "agency" TAMBIÉN en el contexto de subcuenta (quirk documentado abajo), así que
  // por sí solo no distingue a un admin de agencia de un admin de la subcuenta de un cliente:
  // ese cliente comparte companyId con la agencia y entraría al panel de TODAS las subcuentas.
  // El contexto de agencia es el único sin activeLocation.
  const enContextoAgencia = !String(identity?.activeLocation || '').trim()
  const emails = (admins.emails || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean)
  const companies = (admins.company_ids || []).map((c) => String(c).trim()).filter(Boolean)
  const ownerCompany = String(ghlCfg.company_id || '').trim()

  // 1) correo explícitamente autorizado: lo nombraste tú → sin chequeo de rol
  if (email && emails.includes(email)) return true
  // 2) por empresa: SOLO admin a nivel agencia (nunca usuarios de subcuenta ni roles 'user')
  if (enContextoAgencia && type === 'agency' && role === 'admin' && companyId) {
    if (ownerCompany && companyId === ownerCompany) return true
    if (companies.includes(companyId)) return true
  }
  return false // sin coincidencia = denegado (nunca "cualquiera que abra la página")
}

// Normaliza el JSON descifrado a los campos que usa la app.
// QUIRK de GHL: en el contexto de subcuenta el campo `type` sigue valiendo "agency", así que la
// subcuenta se detecta por la PRESENCIA de `activeLocation`, nunca por `type`.
export function normalizarIdentidadSso(identity) {
  const txt = (v) => {
    const s = String(v ?? '').trim()
    return s || null
  }
  const locationId = txt(identity?.activeLocation)
  return {
    userId: txt(identity?.userId),
    companyId: txt(identity?.companyId),
    role: String(identity?.role || '').toLowerCase() || null,
    type: String(identity?.type || '').toLowerCase() || null,
    userName: txt(identity?.userName),
    email: txt(identity?.email)?.toLowerCase() || null,
    esPropietarioAgencia: Boolean(identity?.isAgencyOwner),
    locationId,
    esSubcuenta: Boolean(locationId),
  }
}
