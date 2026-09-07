import { q } from '../db.js'
import { redis } from '../redis.js'
import { rateLimit } from '../lib/ratelimit.js'
import { crearSesionAdmin, destruirSesionAdmin } from '../lib/session.js'
import { requireAdmin } from '../lib/auth.js'
import { cifrarCredenciales, descifrarCredenciales, safeEqual } from '../lib/crypto.js'
import {
  asegurarActionSecret,
  enmascararSecreto,
  getGhlConfig,
  getLimites,
  getSetting,
  setSetting,
} from '../lib/settings.js'
// Las validaciones y las consultas de envíos se comparten con el panel de subcuenta: si la agencia
// pudiera guardar datos que el otro panel rechaza, el worker acabaría con filas imposibles de editar.
import {
  COLUMNAS_ENVIO,
  JOINS_ENVIO,
  activarCuentaRelay,
  cabecera,
  cargarProveedor,
  datosRelay,
  esEmail,
  filtrosEnvios,
  idDe,
  paginar,
  registrarWebhookProveedor,
  respuestaWebhook,
  serializarRelay,
  texto,
  urlWebhookDe,
  validarConfig,
  validarCredenciales,
  validarLimiteDiario,
} from './location.js'
// SPEC §13: estado de la pasarela (puertos públicos y certificado en uso), emisión ACME y modo traefik.
import { config } from '../config.js'
import { actualizarCertificado, estadoRelay, hostRelay } from '../smtp-relay/index.js'
import { asegurarCertificado, estadoCertificado, motivoSinCertificado } from '../lib/acme.js'
import { comprobarCertificadoTraefik, estadoTraefik } from '../lib/traefik.js'
// SPEC §14: espacio del buzón de todas las subcuentas y cuota por subcuenta.
import { tamanoLegible } from '../lib/buzon.js'
// Suscripción de cada subcuenta en el Marketplace Disruptivo (solo lectura y recomprobación).
import { estadoMarketplace, invalidarAcceso, resumenAccesoAdmin, tieneAcceso } from '../lib/marketplace.js'

// SPEC §5.3 — API del panel de la agencia. Todo bajo requireAdmin salvo el propio login.
// Los secretos guardados (client_secret, shared_secret, credenciales de proveedor) NUNCA se
// devuelven: como mucho salen enmascarados.

const LOGIN_MAX_FALLOS = 10
const LOGIN_VENTANA_S = 900
const TIPOS_PROVEEDOR = new Set(['smtp', 'brevo'])
const MAX_NOMBRE = 200
const MAX_ASUNTO = 500
const MAX_HTML = 1_000_000
const MAX_SECRETO = 500
// Cuota del buzón en MB (SPEC §14): tope generoso pero finito, el disco del VPS no es infinito.
const MAX_CUOTA_BUZON_MB = 1_000_000

const appBaseUrl = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '')
const malo = (reply, mensaje) => reply.code(400).send({ error: mensaje })

// Cuota efectiva de una subcuenta: la suya (location_settings.buzon_quota_mb) o la global.
const cuotaEfectivaMb = (propia, defecto) => (Number.isInteger(propia) && propia > 0 ? propia : defecto)
// Porcentaje de uso con un decimal; puede pasar de 100 si la cuota se bajó por debajo de lo usado.
const porcentajeUso = (usadoBytes, cuotaMb) => {
  const total = Number(cuotaMb) * 1024 * 1024
  if (!(total > 0)) return 0
  return Math.round((Number(usadoBytes) / total) * 1000) / 10
}

// La guarda vive en src/lib/auth.js (y allí corta también las peticiones cruzadas).
// Se reexporta para no romper a quien la importe desde aquí.
export { requireAdmin }

export default async function adminRoutes(app) {
  const guard = { preHandler: requireAdmin }

  // ---------------------------------------------------------------------------
  // Sesión
  // ---------------------------------------------------------------------------
  app.post('/api/admin/login', async (req, reply) => {
    const b = req.body || {}
    const usuario = texto(b.usuario ?? b.user ?? b.email).toLowerCase()
    const contrasena = String(b.contrasena ?? b.pass ?? b.password ?? '')

    const usuarioEnv = String(process.env.ADMIN_USER || 'admin').trim().toLowerCase()
    const contrasenaEnv = String(process.env.ADMIN_PASS || '')
    if (!contrasenaEnv) {
      return reply.code(503).send({ error: 'El panel de agencia no tiene contraseña configurada (ADMIN_PASS)' })
    }

    // anti fuerza bruta por IP; con trustProxy req.ip ya es la IP real del cliente
    const claveFallos = `admin:login:fallos:${req.ip}`
    let fallos = 0
    try {
      fallos = Number(await redis.get(claveFallos)) || 0
    } catch {
      fallos = 0 // si Redis no responde no se bloquea el acceso legítimo
    }
    if (fallos >= LOGIN_MAX_FALLOS) {
      return reply.code(429).send({ error: 'Demasiados intentos fallidos. Espera 15 minutos.' })
    }

    if (!safeEqual(usuario, usuarioEnv) || !safeEqual(contrasena, contrasenaEnv)) {
      try {
        const n = await redis.incr(claveFallos)
        if (n === 1) await redis.expire(claveFallos, LOGIN_VENTANA_S)
      } catch {
        /* el contador es una defensa extra, no la puerta */
      }
      return reply.code(401).send({ error: 'Usuario o contraseña incorrectos' })
    }

    await redis.del(claveFallos).catch(() => {})
    // si el panel se abre dentro del iframe de GHL la cookie tiene que ser cross-site
    const crossSite = String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site'
    await crearSesionAdmin(req, reply, { usuario: usuarioEnv, via: 'password' }, { crossSite })
    return { ok: true, usuario: usuarioEnv }
  })

  app.post('/api/admin/logout', async (req, reply) => {
    await destruirSesionAdmin(req, reply)
    return { ok: true }
  })

  app.get('/api/admin/yo', guard, async (req) => ({
    ok: true,
    ambito: 'admin',
    usuario: req.sesion.usuario || null,
    email: req.sesion.email || null,
    via: req.sesion.via || 'password',
  }))

  // ---------------------------------------------------------------------------
  // Subcuentas
  // ---------------------------------------------------------------------------
  app.get('/api/admin/subcuentas', guard, async (req) => {
    const { rows } = await q(
      `SELECT c.id, c.location_id, c.name, c.company_id, c.status, c.created_at, c.updated_at,
              (c.access_token IS NOT NULL) AS con_token,
              (SELECT COUNT(*)::int FROM providers p
                 WHERE p.owner_scope='location' AND p.location_id = c.location_id) AS proveedores,
              (SELECT COUNT(*)::int FROM provider_assignments a
                 WHERE a.location_id = c.location_id) AS proveedores_cedidos,
              (SELECT COUNT(*)::int FROM senders s WHERE s.location_id = c.location_id) AS remitentes,
              (SELECT COUNT(*)::int FROM templates t WHERE t.location_id = c.location_id) AS plantillas,
              (SELECT COUNT(*)::int FROM messages m WHERE m.location_id = c.location_id) AS envios,
              (SELECT COUNT(*)::int FROM messages m
                 WHERE m.location_id = c.location_id AND m.created_at >= now() - interval '30 days') AS envios_30d,
              (SELECT COALESCE(r.enabled, false) FROM relay_accounts r
                 WHERE r.location_id = c.location_id) AS relay_activo
         FROM connections c
        ORDER BY c.name NULLS LAST, c.created_at DESC`
    )
    // Suscripción en el marketplace: SOLO lo guardado (soloCache: Redis/memoria, sin ir a la red).
    // Con N subcuentas y la cache fría, N llamadas en paralelo al marketplace se comerían su límite
    // (600/min) y la página tardaría lo que la más lenta; aquí se pinta lo que ya se sabe (la
    // subcuenta lo refresca al abrir su panel o enviar) y «Recomprobar» es la única llamada en vivo.
    // Las desinstaladas no se consultan. tieneAcceso nunca lanza.
    const accesos = await Promise.all(
      rows.map((s) =>
        s.status === 'uninstalled' ? null : tieneAcceso(s.location_id, { log: req.log, soloCache: true })
      )
    )
    return {
      subcuentas: rows.map((s, i) => ({
        ...s,
        relay_activo: Boolean(s.relay_activo),
        acceso: accesos[i] ? resumenAccesoAdmin(accesos[i]) : null,
      })),
      marketplace: estadoMarketplace(),
    }
  })

  const subcuentaExiste = async (locationId) => {
    const { rows } = await q('SELECT 1 FROM connections WHERE location_id=$1', [locationId])
    return rows.length > 0
  }

  // Olvida la cache y vuelve a preguntar al marketplace por una subcuenta (tras dar o quitar un
  // acceso a mano, sin esperar los 5 minutos). Es la única llamada en vivo que dispara la agencia,
  // así que va limitada por admin: 60 por minuto, muy por debajo del límite del marketplace.
  const RECOMPROBAR_MAX_MIN = 60
  app.post('/api/admin/subcuentas/:locationId/acceso/recomprobar', guard, async (req, reply) => {
    const locationId = texto(req.params.locationId)
    if (!locationId || !(await subcuentaExiste(locationId))) {
      return reply.code(404).send({ error: 'Subcuenta no encontrada' })
    }
    const quien = texto(req.sesion?.email || req.sesion?.usuario) || req.ip
    const limite = await rateLimit(`admin:md:recomprobar:${quien}`, RECOMPROBAR_MAX_MIN, 60)
    if (!limite.ok) {
      return reply.code(429).send({ error: 'Demasiadas recomprobaciones seguidas. Espera un minuto.' })
    }
    await invalidarAcceso(locationId)
    const acceso = resumenAccesoAdmin(await tieneAcceso(locationId, { log: req.log }))
    return { ok: true, location_id: locationId, acceso }
  })

  // ---------------------------------------------------------------------------
  // Proveedores de la agencia (owner_scope='admin', sin location_id)
  // ---------------------------------------------------------------------------
  app.get('/api/admin/proveedores', guard, async () => {
    const { rows } = await q(
      `SELECT p.id, p.name, p.type, p.config, p.status, p.last_check_at, p.last_error, p.daily_limit,
              p.created_at, p.updated_at,
              (SELECT COUNT(*)::int FROM provider_assignments a WHERE a.provider_id = p.id) AS asignaciones
         FROM providers p WHERE p.owner_scope='admin' ORDER BY p.name`
    )
    return {
      proveedores: rows.map((p) => ({
        ...p,
        credenciales: { configurado: true },
        webhook_url: urlWebhookDe(p),
      })),
    }
  })

  app.post('/api/admin/proveedores', guard, async (req, reply) => {
    const b = req.body || {}
    const nombre = cabecera(b.name, 120)
    if (!nombre) return malo(reply, 'El nombre del proveedor es obligatorio')
    const tipo = texto(b.type)
    if (!TIPOS_PROVEEDOR.has(tipo)) return malo(reply, 'El tipo de proveedor tiene que ser «smtp» o «brevo»')
    const errCred = validarCredenciales(tipo, b.credentials)
    if (errCred) return malo(reply, errCred)
    const cfg = validarConfig(tipo, b.config)
    if (cfg.error) return malo(reply, cfg.error)
    const limite = validarLimiteDiario(b.daily_limit)
    if (limite.error) return malo(reply, limite.error)

    const credencialesEnc = cifrarCredenciales(b.credentials)
    const { rows: [p] } = await q(
      `INSERT INTO providers (owner_scope, location_id, name, type, credentials_enc, config, daily_limit)
       VALUES ('admin', NULL, $1,$2,$3,$4::jsonb,$5)
       RETURNING id, name, type, config, status, last_check_at, last_error, daily_limit, created_at, updated_at`,
      [nombre, tipo, credencialesEnc, JSON.stringify(cfg.valor), limite.valor]
    )
    // Brevo: el webhook se registra solo. Si falla, el proveedor queda creado y se devuelve el aviso.
    const webhook = tipo === 'brevo' ? await registrarWebhookProveedor({ ...p, credentials_enc: credencialesEnc }) : null
    if (webhook) p.config = webhook.config
    return reply.code(201).send({
      proveedor: { ...p, asignaciones: 0, credenciales: { configurado: true } },
      ...respuestaWebhook(webhook),
    })
  })

  const proveedorAdmin = async (id) => {
    const { rows: [p] } = await q(`SELECT * FROM providers WHERE id=$1 AND owner_scope='admin'`, [id])
    return p || null
  }

  app.patch('/api/admin/proveedores/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    const actual = await proveedorAdmin(id)
    if (!actual) return reply.code(404).send({ error: 'Proveedor no encontrado' })
    const b = req.body || {}
    if (b.type !== undefined && texto(b.type) !== actual.type) {
      return malo(reply, 'No se puede cambiar el tipo de un proveedor: crea uno nuevo')
    }

    const campos = []
    const params = []
    let credencialesEnc = null
    const set = (columna, valor) => {
      params.push(valor)
      campos.push(`${columna} = $${params.length}`)
    }

    if (b.name !== undefined) {
      const nombre = cabecera(b.name, 120)
      if (!nombre) return malo(reply, 'El nombre del proveedor es obligatorio')
      set('name', nombre)
    }
    if (b.config !== undefined) {
      const cfg = validarConfig(actual.type, b.config)
      if (cfg.error) return malo(reply, cfg.error)
      // el estado del webhook lo escribe la app, no el panel: se conserva al reemplazar la config
      if (actual.config?.webhook) cfg.valor.webhook = actual.config.webhook
      params.push(JSON.stringify(cfg.valor))
      campos.push(`config = $${params.length}::jsonb`)
    }
    if (b.daily_limit !== undefined) {
      const limite = validarLimiteDiario(b.daily_limit)
      if (limite.error) return malo(reply, limite.error)
      set('daily_limit', limite.valor)
    }
    if (b.credentials !== undefined && b.credentials !== null) {
      const errCred = validarCredenciales(actual.type, b.credentials)
      if (errCred) return malo(reply, errCred)
      credencialesEnc = cifrarCredenciales(b.credentials)
      set('credentials_enc', credencialesEnc)
      campos.push(`status = 'sin_probar'`, `last_error = NULL`, `last_check_at = NULL`)
    }
    if (!campos.length) return malo(reply, 'No hay nada que actualizar')

    params.push(id)
    const { rows: [p] } = await q(
      `UPDATE providers SET ${campos.join(', ')}, updated_at=now()
        WHERE id=$${params.length} AND owner_scope='admin'
       RETURNING id, name, type, config, status, last_check_at, last_error, daily_limit, created_at, updated_at`,
      params
    )
    // Brevo: con clave nueva (o si aún no constaba registrado) se vuelve a asegurar el webhook.
    const webhook =
      actual.type === 'brevo' && (credencialesEnc || actual.config?.webhook?.registrado !== true)
        ? await registrarWebhookProveedor({ ...p, credentials_enc: credencialesEnc || actual.credentials_enc })
        : null
    if (webhook) p.config = webhook.config
    return { proveedor: { ...p, credenciales: { configurado: true } }, ...respuestaWebhook(webhook) }
  })

  app.delete('/api/admin/proveedores/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    if (!(await proveedorAdmin(id))) return reply.code(404).send({ error: 'Proveedor no encontrado' })
    const { rows: [uso] } = await q(
      `SELECT (SELECT COUNT(*)::int FROM provider_assignments WHERE provider_id=$1) AS asignaciones,
              (SELECT COUNT(*)::int FROM senders WHERE provider_id=$1) AS remitentes,
              (SELECT COUNT(*)::int FROM messages WHERE provider_id=$1
                 AND status IN ('encolado','reintento','enviando')) AS en_cola`,
      [id]
    )
    if (uso.asignaciones > 0) {
      return reply.code(409).send({
        error: `No se puede eliminar: está cedido a ${uso.asignaciones} subcuenta(s). Quita las asignaciones primero.`,
      })
    }
    if (uso.remitentes > 0) {
      return reply.code(409).send({ error: `No se puede eliminar: hay ${uso.remitentes} remitente(s) usándolo.` })
    }
    if (uso.en_cola > 0) {
      return reply.code(409).send({ error: `No se puede eliminar: hay ${uso.en_cola} mensaje(s) en cola con este proveedor.` })
    }
    await q(`DELETE FROM providers WHERE id=$1 AND owner_scope='admin'`, [id])
    return { ok: true }
  })

  // Vuelve a intentar el registro del webhook en Brevo de un proveedor de la agencia.
  app.post('/api/admin/proveedores/:id/webhook', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    const prov = await proveedorAdmin(id)
    if (!prov) return reply.code(404).send({ error: 'Proveedor no encontrado' })
    if (prov.type !== 'brevo') return malo(reply, 'Solo los proveedores de Brevo usan webhook')
    const r = await registrarWebhookProveedor(prov)
    return { ok: r.ok, creado: r.creado, detalle: r.detalle, webhook: r.webhook }
  })

  app.post('/api/admin/proveedores/:id/probar', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    const prov = await proveedorAdmin(id)
    if (!prov) return reply.code(404).send({ error: 'Proveedor no encontrado' })

    const integracion = await cargarProveedor(prov.type)
    if (!integracion) {
      return reply.code(501).send({ error: `Todavía no hay integración disponible para el tipo «${prov.type}»` })
    }
    let resultado
    try {
      const credenciales = descifrarCredenciales(prov.credentials_enc)
      const r = await integracion.validar(credenciales, prov.config || {})
      resultado = { ok: r?.ok !== false, detalle: texto(r?.detalle) || 'Conexión correcta', cuenta: r?.cuenta ?? null }
    } catch (err) {
      resultado = { ok: false, detalle: texto(err?.message) || 'No se pudo conectar con el proveedor', cuenta: null }
    }
    await q(
      `UPDATE providers SET status=$1, last_check_at=now(), last_error=$2, updated_at=now() WHERE id=$3`,
      [resultado.ok ? 'ok' : 'error', resultado.ok ? null : resultado.detalle.slice(0, 500), id]
    )
    return resultado
  })

  // ---------------------------------------------------------------------------
  // Asignación de proveedores de la agencia a subcuentas
  // ---------------------------------------------------------------------------
  app.get('/api/admin/proveedores/:id/asignaciones', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    if (!(await proveedorAdmin(id))) return reply.code(404).send({ error: 'Proveedor no encontrado' })
    const { rows } = await q(
      `SELECT a.id, a.location_id, a.created_at, c.name AS subcuenta_nombre
         FROM provider_assignments a
         LEFT JOIN connections c ON c.location_id = a.location_id
        WHERE a.provider_id=$1 ORDER BY c.name NULLS LAST, a.location_id`,
      [id]
    )
    return { asignaciones: rows }
  })

  app.post('/api/admin/proveedores/:id/asignaciones', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    if (!(await proveedorAdmin(id))) return reply.code(404).send({ error: 'Proveedor no encontrado' })
    const locationId = texto((req.body || {}).location_id ?? (req.body || {}).locationId)
    if (!locationId || locationId.length > 100) return malo(reply, 'Falta la subcuenta a la que ceder el proveedor')
    if (!(await subcuentaExiste(locationId))) {
      return malo(reply, 'Esa subcuenta no tiene la app instalada')
    }
    const { rows: [a] } = await q(
      `INSERT INTO provider_assignments (provider_id, location_id) VALUES ($1,$2)
       ON CONFLICT (provider_id, location_id) DO UPDATE SET location_id = EXCLUDED.location_id
       RETURNING id, provider_id, location_id, created_at`,
      [id, locationId]
    )
    return reply.code(201).send({ asignacion: a })
  })

  app.delete('/api/admin/proveedores/:id/asignaciones/:locationId', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de proveedor no válido')
    const locationId = texto(req.params.locationId)
    const { rows: [asignacion] } = await q(
      'SELECT id FROM provider_assignments WHERE provider_id=$1 AND location_id=$2',
      [id, locationId]
    )
    if (!asignacion) return reply.code(404).send({ error: 'Esa asignación no existe' })

    // Quitar la cesión tiene que quitar también el USO: los remitentes y el relay de esa subcuenta
    // siguen apuntando al proveedor de la agencia, y como messages.provider_id se fija al encolar,
    // la subcuenta seguiría enviando por un proveedor que ya no tiene autorizado.
    // Se sueltan las referencias ANTES de borrar la fila: si algo fallara a mitad, la cesión sigue
    // en pie (recuperable) en vez de quedar un proveedor revocado pero todavía en uso.
    const { rowCount: remitentesAfectados } = await q(
      'UPDATE senders SET provider_id=NULL, updated_at=now() WHERE location_id=$1 AND provider_id=$2',
      [locationId, id]
    )
    const { rowCount: relayAfectado } = await q(
      'UPDATE relay_accounts SET default_provider_id=NULL, updated_at=now() WHERE location_id=$1 AND default_provider_id=$2',
      [locationId, id]
    )
    await q('DELETE FROM provider_assignments WHERE provider_id=$1 AND location_id=$2', [id, locationId])

    return {
      ok: true,
      remitentes_afectados: remitentesAfectados,
      relay_afectado: relayAfectado > 0,
    }
  })

  // ---------------------------------------------------------------------------
  // Remitentes de cualquier subcuenta
  // ---------------------------------------------------------------------------
  const proveedorUsablePor = async (providerId, locationId) => {
    const { rows: [p] } = await q(
      `SELECT p.id FROM providers p
        WHERE p.id=$1 AND (
          (p.owner_scope='location' AND p.location_id=$2)
          OR EXISTS (SELECT 1 FROM provider_assignments a WHERE a.provider_id=p.id AND a.location_id=$2)
        )`,
      [providerId, locationId]
    )
    return Boolean(p)
  }

  app.get('/api/admin/remitentes', guard, async (req, reply) => {
    const where = ['1=1']
    const params = []
    const locationId = texto(req.query?.location_id)
    if (locationId) {
      params.push(locationId)
      where.push(`s.location_id = $${params.length}`)
    }
    const busqueda = texto(req.query?.q)
    if (busqueda) {
      if (busqueda.length > 200) return malo(reply, 'La búsqueda es demasiado larga')
      params.push(`%${busqueda.replace(/[%_\\]/g, (c) => `\\${c}`)}%`)
      where.push(`(s.email::text ILIKE $${params.length} ESCAPE '\\' OR s.name ILIKE $${params.length} ESCAPE '\\')`)
    }
    const { limite, pagina, offset } = paginar(req.query)
    const filtro = where.join(' AND ')
    const [filas, total] = await Promise.all([
      q(
        `SELECT s.*, p.name AS proveedor_nombre, p.type AS proveedor_tipo, c.name AS subcuenta_nombre
           FROM senders s
           LEFT JOIN providers p ON p.id = s.provider_id
           LEFT JOIN connections c ON c.location_id = s.location_id
          WHERE ${filtro} ORDER BY s.location_id, s.email LIMIT ${limite} OFFSET ${offset}`,
        params
      ),
      q(`SELECT COUNT(*)::int AS n FROM senders s WHERE ${filtro}`, params),
    ])
    return { remitentes: filas.rows, total: total.rows[0].n, pagina, limite }
  })

  app.post('/api/admin/remitentes', guard, async (req, reply) => {
    const b = req.body || {}
    const locationId = texto(b.location_id ?? b.locationId)
    if (!locationId) return malo(reply, 'Indica la subcuenta del remitente')
    if (!(await subcuentaExiste(locationId))) return malo(reply, 'Esa subcuenta no tiene la app instalada')
    const email = texto(b.email).toLowerCase()
    if (!esEmail(email)) return malo(reply, 'El correo del remitente no es válido')
    const nombre = cabecera(b.name, MAX_NOMBRE)
    if (!nombre) return malo(reply, 'El nombre visible del remitente es obligatorio')
    const replyTo = b.reply_to ? cabecera(b.reply_to, 320) : null
    if (replyTo && !esEmail(replyTo)) return malo(reply, 'La dirección de respuesta no es válida')
    const providerId = idDe(b.provider_id)
    if (!providerId) return malo(reply, 'Elige el proveedor por el que saldrá este remitente')
    if (!(await proveedorUsablePor(providerId, locationId))) {
      return malo(reply, 'Ese proveedor no está disponible para esa subcuenta: cédeselo antes')
    }
    const porDefecto = Boolean(b.is_default)

    try {
      if (porDefecto) {
        await q('UPDATE senders SET is_default=false, updated_at=now() WHERE location_id=$1 AND is_default', [locationId])
      }
      const { rows: [s] } = await q(
        `INSERT INTO senders (location_id, provider_id, email, name, reply_to, is_default, origin)
         VALUES ($1,$2,$3,$4,$5,$6,'admin') RETURNING *`,
        [locationId, providerId, email, nombre, replyTo, porDefecto]
      )
      return reply.code(201).send({ remitente: s })
    } catch (err) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Esa subcuenta ya tiene un remitente con ese correo' })
      throw err
    }
  })

  app.patch('/api/admin/remitentes/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de remitente no válido')
    const { rows: [actual] } = await q('SELECT * FROM senders WHERE id=$1', [id])
    if (!actual) return reply.code(404).send({ error: 'Remitente no encontrado' })

    const b = req.body || {}
    const campos = []
    const params = []
    const set = (columna, valor) => {
      params.push(valor)
      campos.push(`${columna} = $${params.length}`)
    }

    if (b.email !== undefined) {
      const email = texto(b.email).toLowerCase()
      if (!esEmail(email)) return malo(reply, 'El correo del remitente no es válido')
      set('email', email)
    }
    if (b.name !== undefined) {
      const nombre = cabecera(b.name, MAX_NOMBRE)
      if (!nombre) return malo(reply, 'El nombre visible del remitente es obligatorio')
      set('name', nombre)
    }
    if (b.reply_to !== undefined) {
      const replyTo = b.reply_to ? cabecera(b.reply_to, 320) : null
      if (replyTo && !esEmail(replyTo)) return malo(reply, 'La dirección de respuesta no es válida')
      set('reply_to', replyTo)
    }
    if (b.provider_id !== undefined) {
      const providerId = idDe(b.provider_id)
      if (!providerId) return malo(reply, 'El proveedor indicado no es válido')
      if (!(await proveedorUsablePor(providerId, actual.location_id))) {
        return malo(reply, 'Ese proveedor no está disponible para esa subcuenta: cédeselo antes')
      }
      set('provider_id', providerId)
    }
    if (b.verified_state !== undefined) {
      const estado = texto(b.verified_state)
      if (!['verificado', 'no_verificado', 'desconocido'].includes(estado)) {
        return malo(reply, 'El estado de verificación no es válido')
      }
      set('verified_state', estado)
    }
    if (b.is_default !== undefined) {
      if (b.is_default) {
        await q(
          'UPDATE senders SET is_default=false, updated_at=now() WHERE location_id=$1 AND is_default AND id<>$2',
          [actual.location_id, id]
        )
      }
      set('is_default', Boolean(b.is_default))
    }
    if (!campos.length) return malo(reply, 'No hay nada que actualizar')

    params.push(id)
    try {
      const { rows: [s] } = await q(
        `UPDATE senders SET ${campos.join(', ')}, updated_at=now() WHERE id=$${params.length} RETURNING *`,
        params
      )
      return { remitente: s }
    } catch (err) {
      if (err?.code === '23505') return reply.code(409).send({ error: 'Esa subcuenta ya tiene un remitente con ese correo' })
      throw err
    }
  })

  app.delete('/api/admin/remitentes/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de remitente no válido')
    const { rowCount } = await q('DELETE FROM senders WHERE id=$1', [id])
    if (!rowCount) return reply.code(404).send({ error: 'Remitente no encontrado' })
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // Plantillas (location_id null = global, visible por todas las subcuentas)
  // ---------------------------------------------------------------------------
  const leerPlantilla = (b, { parcial = false } = {}) => {
    const datos = {}
    if (!parcial || b.name !== undefined) {
      const nombre = cabecera(b.name, 120)
      if (!nombre) return { error: 'El nombre de la plantilla es obligatorio' }
      datos.name = nombre
    }
    if (!parcial || b.subject !== undefined) {
      const asunto = cabecera(b.subject, MAX_ASUNTO)
      if (!asunto) return { error: 'El asunto es obligatorio' }
      datos.subject = asunto
    }
    if (!parcial || b.preheader !== undefined) {
      datos.preheader = b.preheader ? cabecera(b.preheader, MAX_ASUNTO) : null
    }
    if (!parcial || b.html !== undefined) {
      const html = String(b.html ?? '')
      if (!html.trim()) return { error: 'El cuerpo HTML es obligatorio' }
      if (html.length > MAX_HTML) return { error: 'El cuerpo HTML es demasiado grande' }
      datos.html = html
    }
    if (!parcial || b.text !== undefined) {
      const plano = b.text === null || b.text === undefined ? null : String(b.text)
      if (plano && plano.length > MAX_HTML) return { error: 'La versión en texto es demasiado grande' }
      datos.text = plano
    }
    if (!parcial || b.variables !== undefined) {
      const vars = b.variables ?? []
      if (!Array.isArray(vars) || vars.length > 100) return { error: 'La lista de variables no es válida' }
      datos.variables = vars.map((v) => texto(v).slice(0, 80)).filter(Boolean)
    }
    return { datos }
  }

  app.get('/api/admin/plantillas', guard, async (req) => {
    const where = []
    const params = []
    const locationId = texto(req.query?.location_id)
    if (locationId === 'global') {
      where.push('t.location_id IS NULL')
    } else if (locationId) {
      params.push(locationId)
      where.push(`t.location_id = $${params.length}`)
    }
    const filtro = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await q(
      `SELECT t.*, (t.location_id IS NULL) AS global, c.name AS subcuenta_nombre
         FROM templates t LEFT JOIN connections c ON c.location_id = t.location_id
         ${filtro} ORDER BY global DESC, c.name NULLS FIRST, t.name`,
      params
    )
    return { plantillas: rows }
  })

  app.post('/api/admin/plantillas', guard, async (req, reply) => {
    const b = req.body || {}
    const locationId = texto(b.location_id ?? b.locationId) || null
    if (locationId && !(await subcuentaExiste(locationId))) {
      return malo(reply, 'Esa subcuenta no tiene la app instalada')
    }
    const r = leerPlantilla(b)
    if (r.error) return malo(reply, r.error)
    const d = r.datos
    const { rows: [t] } = await q(
      `INSERT INTO templates (location_id, name, subject, preheader, html, text, variables)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING *, (location_id IS NULL) AS global`,
      [locationId, d.name, d.subject, d.preheader, d.html, d.text, JSON.stringify(d.variables)]
    )
    return reply.code(201).send({ plantilla: t })
  })

  app.patch('/api/admin/plantillas/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de plantilla no válido')
    const { rows: [actual] } = await q('SELECT id FROM templates WHERE id=$1', [id])
    if (!actual) return reply.code(404).send({ error: 'Plantilla no encontrada' })

    const b = req.body || {}
    const r = leerPlantilla(b, { parcial: true })
    if (r.error) return malo(reply, r.error)
    const params = []
    const campos = Object.keys(r.datos).map((k) => {
      params.push(k === 'variables' ? JSON.stringify(r.datos[k]) : r.datos[k])
      return `${k} = $${params.length}${k === 'variables' ? '::jsonb' : ''}`
    })
    // la agencia sí puede mover una plantilla entre subcuentas (o hacerla global con null)
    if (b.location_id !== undefined || b.locationId !== undefined) {
      const locationId = texto(b.location_id ?? b.locationId) || null
      if (locationId && !(await subcuentaExiste(locationId))) {
        return malo(reply, 'Esa subcuenta no tiene la app instalada')
      }
      params.push(locationId)
      campos.push(`location_id = $${params.length}`)
    }
    if (!campos.length) return malo(reply, 'No hay nada que actualizar')

    params.push(id)
    const { rows: [t] } = await q(
      `UPDATE templates SET ${campos.join(', ')}, updated_at=now() WHERE id=$${params.length}
       RETURNING *, (location_id IS NULL) AS global`,
      params
    )
    return { plantilla: t }
  })

  app.delete('/api/admin/plantillas/:id', guard, async (req, reply) => {
    const id = idDe(req.params.id)
    if (!id) return malo(reply, 'Identificador de plantilla no válido')
    const { rowCount } = await q('DELETE FROM templates WHERE id=$1', [id])
    if (!rowCount) return reply.code(404).send({ error: 'Plantilla no encontrada' })
    return { ok: true }
  })

  // ---------------------------------------------------------------------------
  // Envíos de todas las subcuentas
  // ---------------------------------------------------------------------------
  app.get('/api/admin/envios', guard, async (req, reply) => {
    const where = ['1=1']
    const params = []
    const locationId = texto(req.query?.location_id)
    if (locationId) {
      params.push(locationId)
      where.push(`m.location_id = $${params.length}`)
    }
    const err = filtrosEnvios(req.query, where, params)
    if (err) return malo(reply, err)

    const { limite, pagina, offset } = paginar(req.query)
    const filtro = where.join(' AND ')
    const [filas, total] = await Promise.all([
      q(
        `SELECT ${COLUMNAS_ENVIO}, c.name AS subcuenta_nombre
         ${JOINS_ENVIO}
         LEFT JOIN connections c ON c.location_id = m.location_id
         WHERE ${filtro} ORDER BY m.created_at DESC, m.id DESC LIMIT ${limite} OFFSET ${offset}`,
        params
      ),
      q(`SELECT COUNT(*)::int AS n FROM messages m WHERE ${filtro}`, params),
    ])
    return {
      envios: filas.rows,
      total: total.rows[0].n,
      pagina,
      limite,
      paginas: Math.max(1, Math.ceil(total.rows[0].n / limite)),
    }
  })

  // ---------------------------------------------------------------------------
  // Relay de una subcuenta
  // ---------------------------------------------------------------------------
  app.post('/api/admin/subcuentas/:locationId/relay', guard, async (req, reply) => {
    const locationId = texto(req.params.locationId)
    if (!locationId) return malo(reply, 'Falta la subcuenta')
    if (!(await subcuentaExiste(locationId))) {
      return reply.code(404).send({ error: 'Esa subcuenta no tiene la app instalada' })
    }
    const { cuenta, contrasena } = await activarCuentaRelay(locationId)
    // la contraseña solo viaja en esta respuesta: si no se copia ahora, hay que rotarla
    return { location_id: locationId, ...(await serializarRelay(cuenta)), contrasena }
  })

  // ---------------------------------------------------------------------------
  // Buzón (SPEC §14): espacio usado por cada subcuenta y cuota individual
  // ---------------------------------------------------------------------------
  const filaEspacio = (f, porDefectoMb) => {
    const usado = Number(f.usado_bytes) || 0
    const propia = f.buzon_quota_mb === null || f.buzon_quota_mb === undefined ? null : Number(f.buzon_quota_mb)
    const efectiva = cuotaEfectivaMb(propia, porDefectoMb)
    return {
      location_id: f.location_id,
      nombre: f.name || null,
      estado_app: f.status,
      usado_bytes: usado,
      usado_legible: tamanoLegible(usado),
      quota_mb: propia,
      cuota_efectiva_mb: efectiva,
      cuota_legible: tamanoLegible(efectiva * 1024 * 1024),
      porcentaje: porcentajeUso(usado, efectiva),
      cuentas: f.cuentas,
      cuentas_llenas: f.cuentas_llenas,
      mensajes: f.mensajes,
    }
  }

  app.get('/api/admin/buzon/espacio', guard, async () => {
    const [limites, { rows }] = await Promise.all([
      getLimites(),
      q(
        `SELECT c.location_id, c.name, c.status,
                ls.buzon_quota_mb,
                COALESCE(ls.buzon_used_bytes, 0)::bigint AS usado_bytes,
                (SELECT COUNT(*)::int FROM mailboxes b WHERE b.location_id = c.location_id) AS cuentas,
                (SELECT COUNT(*)::int FROM mailboxes b
                   WHERE b.location_id = c.location_id AND b.status = 'cuota_llena') AS cuentas_llenas,
                (SELECT COUNT(*)::int FROM inbox_messages m WHERE m.location_id = c.location_id) AS mensajes
           FROM connections c
           LEFT JOIN location_settings ls ON ls.location_id = c.location_id
          ORDER BY COALESCE(ls.buzon_used_bytes, 0) DESC, c.name NULLS LAST, c.location_id`
      ),
    ])
    const subcuentas = rows.map((f) => filaEspacio(f, limites.buzon_quota_mb))
    const totalBytes = subcuentas.reduce((acc, s) => acc + s.usado_bytes, 0)
    return {
      por_defecto_mb: limites.buzon_quota_mb,
      total_usado_bytes: totalBytes,
      total_usado_legible: tamanoLegible(totalBytes),
      subcuentas,
    }
  })

  // {quota_mb: n} fija una cuota propia; {quota_mb: null} vuelve al valor por defecto de Ajustes.
  app.patch('/api/admin/subcuentas/:locationId/buzon', guard, async (req, reply) => {
    const locationId = texto(req.params.locationId)
    if (!locationId || locationId.length > 100) return malo(reply, 'Falta la subcuenta')
    if (!(await subcuentaExiste(locationId))) {
      return reply.code(404).send({ error: 'Esa subcuenta no tiene la app instalada' })
    }
    const b = req.body || {}
    const bruto = b.quota_mb !== undefined ? b.quota_mb : b.buzon_quota_mb
    if (bruto === undefined) return malo(reply, 'Indica «quota_mb» (un número de MB, o null para usar la cuota por defecto)')
    let cuota = null
    if (bruto !== null && bruto !== '') {
      const n = Number(bruto)
      if (!Number.isInteger(n) || n < 1 || n > MAX_CUOTA_BUZON_MB) {
        return malo(reply, `La cuota del buzón tiene que ser un número entero de MB entre 1 y ${MAX_CUOTA_BUZON_MB.toLocaleString('es-ES')}, o null para la cuota por defecto`)
      }
      cuota = n
    }
    const [limites, { rows: [fila] }] = await Promise.all([
      getLimites(),
      q(
        `INSERT INTO location_settings (location_id, buzon_quota_mb) VALUES ($1, $2)
         ON CONFLICT (location_id) DO UPDATE SET buzon_quota_mb = EXCLUDED.buzon_quota_mb, updated_at = now()
         RETURNING buzon_quota_mb, buzon_used_bytes`,
        [locationId, cuota]
      ),
    ])
    const usado = Number(fila.buzon_used_bytes) || 0
    const efectiva = cuotaEfectivaMb(cuota, limites.buzon_quota_mb)
    // Si la cuota nueva vuelve a dar aire a un buzón que se paró por espacio, la sincronización
    // lo retoma sola: el estado 'cuota_llena' lo reevalúa el bucle en la siguiente pasada.
    return {
      location_id: locationId,
      quota_mb: cuota,
      cuota_efectiva_mb: efectiva,
      usado_bytes: usado,
      usado_legible: tamanoLegible(usado),
      porcentaje: porcentajeUso(usado, efectiva),
    }
  })

  // ---------------------------------------------------------------------------
  // Relay de la plataforma y certificado TLS (SPEC §13.3)
  // ---------------------------------------------------------------------------

  // estadoCertificado lee tls_certificates; si la consulta falla, el estado del relay se devuelve
  // igualmente y el fallo viaja como last_error para que la tarjeta del admin lo enseñe.
  const estadoDelCertificado = async (host) => {
    if (!host) return null
    try {
      return (await estadoCertificado(host)) ?? null
    } catch (err) {
      return {
        hostname: host,
        valido: false,
        issued_at: null,
        expires_at: null,
        last_error: `No se pudo consultar el certificado guardado: ${texto(err?.message) || 'error desconocido'}`,
        last_attempt_at: null,
        dias_restantes: null,
      }
    }
  }

  // Origen del certificado según la precedencia del SPEC §13.1 (ficheros > traefik > acme > ninguno).
  const origenCertificado = () => {
    if (config.relay.tlsCert && config.relay.tlsKey) return 'ficheros'
    if (config.relay.traefikAcme) return 'traefik'
    if (config.relay.tlsAuto) return 'acme'
    return 'ninguno'
  }

  app.get('/api/admin/relay', guard, async () => {
    const relay = estadoRelay()
    const origen = origenCertificado()
    // escuchas internas del contenedor, aparte de los puertos públicos que devuelve estadoRelay()
    relay.puertos_internos = { starttls: config.relay.puerto, ssl: config.relay.puertoSsl }
    relay.origen_certificado = origen

    const traefik = origen === 'traefik' ? estadoTraefik() : null
    const certificado = origen === 'acme' ? await estadoDelCertificado(relay.tls.hostname) : null

    // La pasarela solo conoce sus propios fallos (ficheros, certificado rechazado); el motivo real
    // está en el módulo que obtiene el certificado: estadoTraefik() en modo traefik, o
    // tls_certificates (src/lib/acme.js) con ACME propio. Se completa aquí para que la tarjeta
    // del admin pinte el rojo con el error sin tener que cruzar los objetos.
    if (relay.tls.modo === 'autofirmado' && !relay.tls.error) {
      if (traefik && texto(traefik.ultimo_error)) relay.tls.error = texto(traefik.ultimo_error)
      else if (certificado && !certificado.emitiendo && texto(certificado.last_error)) relay.tls.error = texto(certificado.last_error)
    }
    return { relay, certificado, traefik }
  })

  // Renovación forzada de un certificado ACME que aún vale: Let's Encrypt limita a 5 certificados
  // idénticos por semana, así que cinco pulsaciones del botón dejarían al host sin poder renovar
  // durante una semana. Solo se admite pasadas 48 h desde la emisión y con un freno de 1 h en Redis.
  const HORAS_MIN_ENTRE_FORZADAS = 48
  const FRENO_FORZADA_S = 3600
  const claveFreno = (host) => `acme:forzado:${host}`

  // Fuerza la emisión o renovación ahora (o, en modo traefik, relee el acme.json de Traefik).
  // asegurarCertificado ya respeta el lock entre instancias y la cuota de un intento por hora tras
  // un error (anti-abuso de Let's Encrypt), y nunca lanza por un fallo de emisión: devuelve null y
  // deja el motivo en last_error.
  app.post('/api/admin/relay/certificado', guard, async (req) => {
    const host = hostRelay()
    if (!host) {
      return { ok: false, error: 'No hay host para el certificado: define SMTP_RELAY_HOST o una APP_BASE_URL válida', estado: null }
    }
    const origen = origenCertificado()
    const tls = estadoRelay().tls

    if (origen === 'ficheros' || tls.modo === 'ficheros') {
      return {
        ok: false,
        error: 'El relay usa el certificado de ficheros (SMTP_RELAY_TLS_CERT/_KEY): renuévalo en el volumen y reinicia el servicio; no hay nada que pedir a Let’s Encrypt.',
        estado: null,
      }
    }

    if (origen === 'traefik') {
      // sin CA de por medio: se relee el fichero y se aplica a las escuchas de esta instancia
      let aplicacion = null
      const leido = await comprobarCertificadoTraefik({
        log: req.log,
        forzar: true,
        alCambiar: (certificado) => {
          aplicacion = actualizarCertificado(certificado, req.log)
          return aplicacion
        },
      })
      const traefik = estadoTraefik()
      if (!leido) {
        return { ok: false, error: texto(traefik.ultimo_error) || 'No se pudo leer el certificado del acme.json de Traefik', estado: null, traefik }
      }
      return {
        ok: true,
        estado: null,
        traefik,
        aplicado: aplicacion?.aplicado === true,
        detalle: aplicacion?.error || null,
        mensaje: `Certificado leído del acme.json de Traefik (resolver ${traefik.resolver || '?'}), válido hasta ${leido.expiresAt.toISOString()}.`,
        relay: estadoRelay(),
      }
    }

    if (origen !== 'acme') {
      return {
        ok: false,
        error: 'La emisión automática está desactivada (SMTP_RELAY_TLS_AUTO=false) y no hay SMTP_RELAY_TRAEFIK_ACME ni ficheros: no hay de dónde sacar un certificado.',
        estado: null,
      }
    }

    // Con un certificado ACME ya aplicado y con más de 30 días de vida, el botón significa
    // «renovar a la fuerza»; con menos de 30 días, asegurarCertificado renueva de todos modos; y
    // con el autofirmado significa «consíguelo»: si en tls_certificates ya hay uno válido se aplica
    // sin gastar cuota de la CA, y si no, se emite.
    const previo = await estadoDelCertificado(host)
    const forzar = tls.modo === 'acme' && previo?.valido === true && Number(previo.dias_restantes) >= 30
    if (forzar) {
      const emitidoHace = previo.issued_at ? Date.now() - new Date(previo.issued_at).getTime() : Infinity
      if (emitidoHace < HORAS_MIN_ENTRE_FORZADAS * 3_600_000) {
        return {
          ok: false,
          error:
            `El certificado actual se emitió hace ${Math.max(1, Math.round(emitidoHace / 3_600_000))} h y aún le quedan ${previo.dias_restantes} días. ` +
            `Let’s Encrypt limita a 5 certificados idénticos por semana, así que la renovación forzada solo se admite pasadas ${HORAS_MIN_ENTRE_FORZADAS} h desde la emisión; la automática llegará sola cuando queden menos de 30 días.`,
          estado: previo,
        }
      }
      let frenado = false
      try {
        frenado = (await redis.set(claveFreno(host), '1', 'EX', FRENO_FORZADA_S, 'NX')) !== 'OK'
      } catch {
        frenado = false
      }
      if (frenado) {
        return {
          ok: false,
          error: 'Ya se forzó una renovación hace menos de una hora. Espera a que pase para volver a intentarlo (cuota de Let’s Encrypt).',
          estado: previo,
        }
      }
    }

    let certificado
    try {
      certificado = await asegurarCertificado(host, { log: req.log, forzar })
    } catch (err) {
      // solo el mensaje: ni tokens ACME ni claves acaban en el log ni en la respuesta
      req.log.error({ host, motivo: texto(err?.message) }, 'relay: fallo forzando la emision del certificado')
      return {
        ok: false,
        error: texto(err?.message) || 'No se pudo emitir el certificado',
        estado: await estadoDelCertificado(host),
      }
    }

    const estado = await estadoDelCertificado(host)
    if (!certificado?.cert || !certificado?.key) {
      const motivo = motivoSinCertificado(host)
      const explicaciones = {
        lock: 'Hay otra emisión en curso (o quedó un lock de un redespliegue a mitad de emisión; caduca en 5 minutos). Vuelve a probar en unos minutos.',
        cuota: 'El último intento falló hace menos de una hora y la app no vuelve a llamar a Let’s Encrypt hasta que pase (cuota anti-abuso).',
        host: 'El host del relay no puede tener un certificado público (localhost, IP o dominio de ejemplo).',
        fallo: 'Fallo inesperado consultando el certificado (Postgres, Redis o clave de cifrado). Mira el log del servicio.',
      }
      return {
        ok: false,
        error:
          (motivo === 'error' && texto(estado?.last_error)) ||
          explicaciones[motivo] ||
          texto(estado?.last_error) ||
          'No se pudo emitir el certificado ahora mismo. Vuelve a probar más tarde.',
        estado,
      }
    }

    // Se aplica en caliente a las escuchas de ESTA instancia; si el relay corre en otra, la
    // renovación periódica de esa instancia lo recogerá de tls_certificates.
    const aplicacion = actualizarCertificado({ ...certificado, origen: 'acme' }, req.log)
    return {
      ok: true,
      estado,
      aplicado: aplicacion.aplicado,
      detalle: aplicacion.error || null,
      relay: estadoRelay(),
    }
  })

  // ---------------------------------------------------------------------------
  // Ajustes de la app (credenciales de GHL, límites y admins del SSO)
  // ---------------------------------------------------------------------------
  // Vista de ajustes con los secretos enmascarados. La usan igual el GET y la respuesta del PUT.
  async function vistaAjustes() {
    const [cfg, limites, adminsGuardados, relay] = await Promise.all([
      getGhlConfig(),
      getLimites(),
      getSetting('admins'),
      datosRelay(),
    ])
    const admins = adminsGuardados || {}
    // el secreto de las URLs de los nodos se genera la primera vez que se abren los ajustes
    const actionSecret = await asegurarActionSecret()
    const base = appBaseUrl()
    return {
      ghl: {
        client_id: cfg.client_id || '',
        app_id: cfg.app_id || '',
        company_id: cfg.company_id || '',
        scopes: Array.isArray(cfg.scopes) ? cfg.scopes : null,
        // los secretos NO se devuelven: solo si están puestos y una pista de 4 caracteres
        client_secret: { configurado: Boolean(cfg.client_secret), pista: enmascararSecreto(cfg.client_secret) },
        shared_secret: { configurado: Boolean(cfg.shared_secret), pista: enmascararSecreto(cfg.shared_secret) },
      },
      urls: {
        instalar: `${base}/api/oauth/instalar`,
        redirect_uri: `${base}/api/oauth/callback`,
        pagina_personalizada: base,
        accion_plantilla: `${base}/api/ghl/accion/plantilla/${actionSecret}`,
        accion_personalizado: `${base}/api/ghl/accion/personalizado/${actionSecret}`,
        dinamico_plantilla: `${base}/api/ghl/dinamico/plantilla/${actionSecret}`,
        dinamico_personalizado: `${base}/api/ghl/dinamico/personalizado/${actionSecret}`,
      },
      limites: {
        envio_minuto: limites.envio_minuto,
        envio_dia: limites.envio_dia,
        // cuota de buzón por defecto (SPEC §14): se aplica a toda subcuenta sin cuota propia
        buzon_quota_mb: limites.buzon_quota_mb,
      },
      admins: {
        emails: Array.isArray(admins.emails) ? admins.emails : [],
        company_ids: Array.isArray(admins.company_ids) ? admins.company_ids : [],
      },
      // mismos datos (puertos PÚBLICOS y estado TLS) que ve la subcuenta en GET /api/loc/relay
      relay,
      // integración con el Marketplace Disruptivo (suscripción): estado sin la clave
      marketplace: estadoMarketplace(),
    }
  }

  app.get('/api/admin/ajustes', guard, async () => vistaAjustes())

  app.put('/api/admin/ajustes', guard, async (req, reply) => {
    const b = req.body || {}
    const cfgActual = await getGhlConfig()
    const ghl = { ...cfgActual }

    if (b.ghl && typeof b.ghl === 'object') {
      const g = b.ghl
      for (const campo of ['client_id', 'app_id', 'company_id']) {
        if (g[campo] === undefined) continue
        const valor = texto(g[campo])
        if (valor.length > MAX_SECRETO) return malo(reply, `El campo «${campo}» es demasiado largo`)
        ghl[campo] = valor
      }
      // los secretos solo se tocan si llega una cadena nueva: el panel los recibe enmascarados
      // (como objeto) y devolverlos tal cual NO puede borrarlos
      for (const campo of ['client_secret', 'shared_secret']) {
        const valor = g[campo]
        if (typeof valor !== 'string') continue
        const limpio = valor.trim()
        if (!limpio) continue
        if (limpio.length > MAX_SECRETO) return malo(reply, `El campo «${campo}» es demasiado largo`)
        ghl[campo] = limpio
      }
      if (g.scopes !== undefined) {
        if (g.scopes === null || (Array.isArray(g.scopes) && g.scopes.length === 0)) {
          delete ghl.scopes
        } else if (Array.isArray(g.scopes)) {
          if (g.scopes.length > 40) return malo(reply, 'Demasiados scopes')
          const limpios = g.scopes.map((s) => texto(s).slice(0, 100)).filter(Boolean)
          if (limpios.some((s) => !/^[a-z0-9._/-]+$/i.test(s))) return malo(reply, 'Algún scope tiene caracteres no válidos')
          ghl.scopes = limpios
        } else {
          return malo(reply, 'Los scopes tienen que ser una lista')
        }
      }
      await setSetting('ghl', ghl)
    }

    if (b.limites && typeof b.limites === 'object') {
      const guardados = (await getSetting('limites')) || {}
      const limites = { ...guardados }
      for (const campo of ['envio_minuto', 'envio_dia']) {
        if (b.limites[campo] === undefined) continue
        const n = Number(b.limites[campo])
        if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
          return malo(reply, `El límite «${campo}» tiene que ser un número entero entre 1 y 1.000.000`)
        }
        limites[campo] = n
      }
      if (b.limites.buzon_quota_mb !== undefined) {
        const n = Number(b.limites.buzon_quota_mb)
        if (!Number.isInteger(n) || n < 1 || n > MAX_CUOTA_BUZON_MB) {
          return malo(reply, `La cuota de buzón por defecto tiene que ser un número entero de MB entre 1 y ${MAX_CUOTA_BUZON_MB.toLocaleString('es-ES')}`)
        }
        limites.buzon_quota_mb = n
      }
      await setSetting('limites', limites)
    }

    if (b.admins && typeof b.admins === 'object') {
      const emails = Array.isArray(b.admins.emails) ? b.admins.emails : []
      const companies = Array.isArray(b.admins.company_ids) ? b.admins.company_ids : []
      if (emails.length > 50 || companies.length > 50) return malo(reply, 'La lista de administradores es demasiado larga')
      const limpiosEmails = []
      for (const e of emails) {
        const correo = texto(e).toLowerCase()
        if (!correo) continue
        if (!esEmail(correo)) return malo(reply, `El correo «${correo}» no es válido`)
        limpiosEmails.push(correo)
      }
      const limpiasCompanies = companies.map((c) => texto(c).slice(0, 100)).filter(Boolean)
      await setSetting('admins', { emails: limpiosEmails, company_ids: limpiasCompanies })
    }

    // se responde con la misma vista enmascarada del GET: el panel se refresca sin otra llamada
    return vistaAjustes()
  })
}
