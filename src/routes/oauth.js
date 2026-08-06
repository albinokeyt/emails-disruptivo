import { randomBytes } from 'node:crypto'
import { q } from '../db.js'
import { redis } from '../redis.js'
import { getGhlConfig } from '../lib/settings.js'
import {
  buildAuthUrl,
  exchangeCode,
  exchangeLocationToken,
  listInstalledLocations,
  fetchLocationName,
} from '../lib/ghl.js'
import { iniciarSesionSso, sesionActual } from '../lib/session.js'

// SPEC §5.1 — Instalación de la app en la subcuenta y sesión del panel.
//   GET  /api/oauth/instalar   → chooselocation con state anti-CSRF de un solo uso
//   GET  /api/oauth/callback   → canje del código + upsert en connections + HTML de resultado
//   POST /api/sesion/sso       → payload cifrado del iframe de GHL → cookie de sesión
//   GET  /api/sesion           → sesión actual

const TTL_STATE = 600 // 10 min: lo que dura el paseo por chooselocation
const MAX_LOCATIONS_BULK = 200

const appBaseUrl = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')
const redirectUri = () => `${appBaseUrl()}/api/oauth/callback`

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const pagina = (mensaje, ok = false) => `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Emails Disruptivo</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0f1117;color:#e8e6e0;display:grid;
place-items:center;min-height:100vh;margin:0;padding:24px}
.tarjeta{background:#181b23;border:1px solid #2a2e3a;border-radius:14px;padding:40px;max-width:480px;text-align:center;line-height:1.55}
.icono{font-size:40px;margin-bottom:12px}b{color:#d9b45b}small{color:#8a8f9e;display:block;margin-top:14px}</style></head>
<body><div class="tarjeta"><div class="icono">${ok ? '✅' : '⚠️'}</div><p>${mensaje}</p>
<small>Emails Disruptivo</small></div></body></html>`

// Limitador simple por IP: INCR + EXPIRE. Si Redis falla no se bloquea (fail-open): esto es una
// defensa contra abuso, no la puerta de seguridad (la puerta es el cifrado del payload SSO).
async function limitar(clave, maximo, ventanaS) {
  try {
    const n = await redis.incr(clave)
    if (n === 1) await redis.expire(clave, ventanaS)
    return n <= maximo
  } catch {
    return true
  }
}

async function guardarConexion({ locationId, companyId, accessToken, refreshToken, expiresIn }) {
  const expiraEn = accessToken ? new Date(Date.now() + ((Number(expiresIn) || 3600) - 60) * 1000) : null
  const { rows: [conn] } = await q(
    `INSERT INTO connections (location_id, company_id, access_token, refresh_token, token_expires_at, status)
     VALUES ($1,$2,$3,$4,$5,'connected')
     ON CONFLICT (location_id) DO UPDATE SET
       company_id       = COALESCE(EXCLUDED.company_id, connections.company_id),
       access_token     = COALESCE(EXCLUDED.access_token, connections.access_token),
       refresh_token    = COALESCE(EXCLUDED.refresh_token, connections.refresh_token),
       token_expires_at = COALESCE(EXCLUDED.token_expires_at, connections.token_expires_at),
       status           = 'connected',
       updated_at       = now()
     RETURNING *`,
    [locationId, companyId || null, accessToken || null, refreshToken || null, expiraEn]
  )
  return conn
}

// El nombre de la subcuenta es cosmético: si la API falla, la conexión sigue siendo válida.
async function ponerNombre(conn, locationId) {
  try {
    const nombre = await fetchLocationName(conn.id, locationId)
    if (nombre) {
      await q('UPDATE connections SET name=$1, updated_at=now() WHERE id=$2', [nombre, conn.id])
      return nombre
    }
  } catch {
    /* sin nombre: se muestra el locationId */
  }
  return conn.name || null
}

export default async function oauthRoutes(app) {
  // ---------------------------------------------------------------------------
  // Instalación
  // ---------------------------------------------------------------------------
  app.get('/api/oauth/instalar', async (req, reply) => {
    if (!appBaseUrl()) {
      return reply.code(503).type('text/html').send(pagina('Falta la variable APP_BASE_URL: la app no puede construir la URL de retorno.'))
    }
    const cfg = await getGhlConfig()
    if (!cfg.client_id) {
      return reply
        .code(503)
        .type('text/html')
        .send(pagina('La app todavía no está configurada: falta el <b>Client ID</b> de GoHighLevel en Ajustes.'))
    }
    // state anti-CSRF de un solo uso: se consume con DEL en el callback
    const state = randomBytes(16).toString('hex')
    await redis.set(`oauthstate:${state}`, '1', 'EX', TTL_STATE)
    const opciones = { state }
    if (Array.isArray(cfg.scopes) && cfg.scopes.length) opciones.scopes = cfg.scopes.map(String)
    return reply.redirect(buildAuthUrl(cfg, redirectUri(), opciones))
  })

  app.get('/api/oauth/callback', async (req, reply) => {
    const { code, state } = req.query || {}
    if (!code) return reply.code(400).type('text/html').send(pagina('Falta el código de autorización.'))
    try {
      // válido si: (a) trae un state emitido por esta app (consumido atómicamente), o
      // (b) es una instalación directa desde GHL y el companyId coincide con la agencia configurada
      const stateOk = state ? (await redis.del(`oauthstate:${String(state)}`)) === 1 : false
      const tok = await exchangeCode(code, redirectUri())
      const cfg = await getGhlConfig()
      if (!stateOk) {
        if (!cfg.company_id || tok.companyId !== cfg.company_id) {
          throw new Error(
            'Instalación no autorizada: entra por el enlace de instalación de la app, o guarda el Company ID de tu agencia en Ajustes para permitir instalaciones directas desde GoHighLevel.'
          )
        }
      }

      // Caso normal: instala un usuario de subcuenta y el token ya trae locationId
      if (tok.locationId) {
        const conn = await guardarConexion({
          locationId: tok.locationId,
          companyId: tok.companyId,
          accessToken: tok.access_token,
          refreshToken: tok.refresh_token,
          expiresIn: tok.expires_in,
        })
        const nombre = await ponerNombre(conn, tok.locationId)
        return reply
          .type('text/html')
          .send(
            pagina(
              `Subcuenta conectada correctamente${
                nombre ? `: <b>${escapeHtml(nombre)}</b>` : ` (<b>${escapeHtml(tok.locationId)}</b>)`
              }.<br>Ya puedes cerrar esta pestaña y abrir <b>Emails Disruptivo</b> desde el menú lateral.`,
              true
            )
          )
      }

      // Instalación desde la agencia (o bulk): el token es de tipo Company y NO trae locationId.
      // Hay que listar las subcuentas con la app instalada y canjear un token por cada una.
      if (!tok.companyId) {
        throw new Error('GoHighLevel no devolvió ni locationId ni companyId. Revisa la configuración de distribución de la app.')
      }
      const locations = (await listInstalledLocations(tok.access_token, tok.companyId, cfg.app_id, { limit: MAX_LOCATIONS_BULK }))
        .slice(0, MAX_LOCATIONS_BULK)
      if (!locations.length) {
        throw new Error('La agencia autorizó la app pero GoHighLevel no devuelve ninguna subcuenta con la app instalada.')
      }
      let conectadas = 0
      const fallidas = []
      for (const l of locations) {
        const locationId = String(l._id || l.id || '').trim()
        if (!locationId) continue
        try {
          // OJO: el token de subcuenta NO trae refresh_token y caduca en ~24 h; se guarda igual
          // porque solo se usa para leer el nombre de la subcuenta.
          const sub = await exchangeLocationToken(tok.access_token, tok.companyId, locationId)
          const conn = await guardarConexion({
            locationId,
            companyId: tok.companyId,
            accessToken: sub.access_token,
            expiresIn: sub.expires_in,
          })
          if (l.name) await q('UPDATE connections SET name=$1, updated_at=now() WHERE id=$2', [String(l.name).slice(0, 200), conn.id])
          conectadas++
        } catch (err) {
          req.log.warn({ locationId, err: err.message }, 'no se pudo canjear el token de subcuenta')
          // sin token la subcuenta sigue siendo válida para el panel (el SSO no depende del token)
          await guardarConexion({ locationId, companyId: tok.companyId }).catch(() => {})
          fallidas.push(l.name || locationId)
        }
      }
      return reply
        .type('text/html')
        .send(
          pagina(
            `Instalación de agencia completada: <b>${conectadas}</b> de <b>${locations.length}</b> subcuentas conectadas.` +
              (fallidas.length
                ? `<br>Sin token de API (funcionan igual en el panel): ${escapeHtml(fallidas.slice(0, 5).join(', '))}${
                    fallidas.length > 5 ? '…' : ''
                  }`
                : ''),
            true
          )
        )
    } catch (err) {
      req.log.error({ err: err.message }, 'fallo en el callback de OAuth')
      return reply.code(500).type('text/html').send(pagina(`No se pudo completar la instalación: ${escapeHtml(err.message)}`))
    }
  })

  // ---------------------------------------------------------------------------
  // Sesión del panel
  // ---------------------------------------------------------------------------

  // El iframe de GHL manda aquí el payload cifrado que recibe por postMessage. Es la ÚNICA
  // fuente del location_id de la sesión: nunca se lee de la query string, que sí es falsificable.
  app.post('/api/sesion/sso', async (req, reply) => {
    if (!(await limitar(`ssorl:${req.ip}`, 60, 60))) {
      return reply.code(429).send({ error: 'Demasiados intentos de identificación. Espera un momento.' })
    }
    const cuerpo = req.body || {}
    // `payload` es el nombre del contrato; `encryptedData` es como lo llama la plantilla oficial de GHL
    const payload = cuerpo.payload || cuerpo.encryptedData || cuerpo.encrypted || cuerpo.key
    if (!payload || typeof payload !== 'string') {
      return reply.code(400).send({ error: 'Falta el contexto cifrado de GoHighLevel' })
    }
    if (payload.length > 20_000) {
      return reply.code(413).send({ error: 'El contexto recibido de GoHighLevel es demasiado grande' })
    }
    try {
      const sesion = await iniciarSesionSso(req, reply, payload)
      if (sesion.locationId) {
        // Deja constancia de la subcuenta aunque la instalación OAuth no llegara a registrarse:
        // sin esta fila la subcuenta sería invisible en el panel de la agencia.
        await q(
          `INSERT INTO connections (location_id, status) VALUES ($1,'connected') ON CONFLICT (location_id) DO NOTHING`,
          [sesion.locationId]
        ).catch(() => {})
      }
      return {
        locationId: sesion.locationId,
        nombre: sesion.nombre,
        esAdminAgencia: Boolean(sesion.esAdminAgencia),
      }
    } catch (err) {
      const estado = Number(err.status || err.statusCode) || 500
      if (estado >= 500) req.log.error({ err: err.message }, 'fallo al iniciar sesión por SSO')
      return reply.code(estado).send({ error: estado >= 500 ? 'No se pudo iniciar la sesión' : err.message })
    }
  })

  app.get('/api/sesion', async (req, reply) => {
    const sesion = await sesionActual(req)
    if (!sesion) return reply.code(401).send({ error: 'No hay ninguna sesión iniciada' })
    return { ambito: sesion.locationId ? 'location' : 'admin', ...sesion }
  })
}
