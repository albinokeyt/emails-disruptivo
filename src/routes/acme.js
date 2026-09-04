import { redis } from '../redis.js'

// ---------------------------------------------------------------------------
// Reto ACME HTTP-01 (SPEC §13.1 y §13.3):
//   GET /.well-known/acme-challenge/:token → text/plain con el keyAuthorization, o 404
//
// Público y sin sesión a propósito: es la CA (Let's Encrypt) quien lo pide, desde varias IPs y
// sin ninguna credencial nuestra. No hay nada que proteger: el keyAuthorization solo demuestra que
// controlamos el host y se borra de Redis en cuanto termina la validación (TTL de 10 min por si
// acaso). Quien lo deja en Redis es src/lib/acme.js (acme:challenge:<token>).
//
// Se registra en src/index.js ANTES del estático y del respaldo de SPA: si el index.html del
// panel contestara a esta URL, la CA leería HTML en vez del reto y la emisión fallaría.
// ---------------------------------------------------------------------------

const PREFIJO_RETO = 'acme:challenge:'

// Los tokens ACME son base64url (RFC 8555 §8.3); cualquier otra cosa no es un reto nuestro.
const RE_TOKEN = /^[A-Za-z0-9_-]{1,128}$/

const CABECERAS = {
  'Content-Type': 'text/plain; charset=utf-8',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
}

export default async function acmeRoutes(app) {
  app.get('/.well-known/acme-challenge/:token', async (req, reply) => {
    reply.headers(CABECERAS)

    const token = String(req.params.token || '')
    if (!RE_TOKEN.test(token)) return reply.code(404).send('No encontrado')

    let keyAuthorization = null
    try {
      keyAuthorization = await redis.get(PREFIJO_RETO + token)
    } catch (err) {
      // sin Redis no hay reto que servir; la CA reintenta y acme.js anota el fallo
      req.log.warn({ motivo: err.message }, 'acme: no se pudo leer el reto HTTP-01 de Redis')
      return reply.code(503).send('Servicio no disponible')
    }

    if (!keyAuthorization) return reply.code(404).send('No encontrado')
    return reply.send(keyAuthorization)
  })
}
