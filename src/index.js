import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import fastifyFormbody from '@fastify/formbody'
import fastifyStatic from '@fastify/static'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { config, validarEntorno } from './config.js'
import { migrate, pool, q } from './db.js'
import { redis } from './redis.js'
import { verificarClaveCifrado } from './lib/crypto.js'
import { asegurarActionSecret } from './lib/settings.js'
import { rutasBaja } from './lib/tracking.js'

import oauthRoutes from './routes/oauth.js'
import locationRoutes from './routes/location.js'
import adminRoutes from './routes/admin.js'
import accionesRoutes from './routes/actions.js'
import webhooksRoutes from './routes/webhooks.js'
import trackingRoutes from './routes/tracking.js'

const raiz = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 1. Entorno. Se comprueba antes de abrir nada.
//
// Sin ENCRYPTION_KEY válida la app NO arranca: viva pero sin cifrado, la primera credencial que
// guardara un cliente quedaría en claro en la base de datos y ya no habría vuelta atrás.
// ---------------------------------------------------------------------------
let avisosEntorno = []
try {
  avisosEntorno = validarEntorno()
  verificarClaveCifrado()
} catch (err) {
  console.error(`\n[emails-disruptivo] No se puede arrancar.\n${err.message}\n`)
  process.exit(1)
}

const app = Fastify({
  logger: true,
  // detrás de Traefik/EasyPanel: sin esto req.protocol sería http y las cookies del iframe
  // (SameSite=None; Secure) no llegarían a emitirse como Secure
  trustProxy: true,
  // el nodo "Enviar email personalizado" manda el HTML completo del correo en el body
  bodyLimit: 5 * 1024 * 1024,
})

// ---------------------------------------------------------------------------
// 2. Plugins base. Las cookies van ANTES que las rutas: los guardas de lib/auth.js leen
//    req.cookies y sin el plugin registrado antes serían siempre "sin sesión".
// ---------------------------------------------------------------------------
await app.register(fastifyCookie)
await app.register(fastifyFormbody)

// ---------------------------------------------------------------------------
// 3. Salud. Público y sin sesión: lo consultan el HEALTHCHECK del contenedor y EasyPanel.
//    Las claves son exactamente {ok, db, redis} (DEPLOY.md §B); nada de datos internos.
// ---------------------------------------------------------------------------
app.get('/healthz', async (req, reply) => {
  const salud = { ok: true, db: false, redis: false }
  try {
    await q('SELECT 1')
    salud.db = true
  } catch {
    salud.ok = false
  }
  try {
    await redis.ping()
    salud.redis = true
  } catch {
    salud.ok = false
  }
  return reply.code(salud.ok ? 200 : 503).send(salud)
})

// ---------------------------------------------------------------------------
// 4. Rutas. Cada fichero declara sus prefijos completos (/api/loc, /api/admin, /api/ghl,
//    /api/webhooks, /t), así que se registran sin prefijo.
// ---------------------------------------------------------------------------
await app.register(oauthRoutes)
await app.register(locationRoutes)
await app.register(adminRoutes)
await app.register(accionesRoutes)
await app.register(webhooksRoutes)
await app.register(trackingRoutes)
// Baja en un clic (RFC 8058). Va aparte porque la sirve el motor de envío (lib/tracking.js), no
// routes/tracking.js: TODOS los correos salen con List-Unsubscribe-Post apuntando a /t/baja, así que
// sin registrarla Gmail y Yahoo recibirían un 404 en la baja y penalizarían la reputación del envío.
await app.register(rutasBaja)

// ---------------------------------------------------------------------------
// 5. Panel React compilado (web/dist) con respaldo de SPA.
//
// No se emite X-Frame-Options ni una CSP con frame-ancestors: el panel de subcuenta se pinta
// DENTRO del iframe de GoHighLevel y, con agencias whitelabel, el dominio padre es arbitrario.
// Quien autoriza no es el origen del iframe, es el payload cifrado del SSO (lib/sso.js).
// ---------------------------------------------------------------------------
const dirPanel = path.join(raiz, '..', 'web', 'dist')
const hayPanel = existsSync(path.join(dirPanel, 'index.html'))

if (hayPanel) {
  await app.register(fastifyStatic, {
    root: dirPanel,
    index: ['index.html'],
    // la cabecera de caché la pone setHeaders; sin esto el plugin escribiría su propia
    // Cache-Control por encima y el index quedaría cacheado
    cacheControl: false,
    setHeaders(res, ruta) {
      // el index no se cachea nunca (apunta a los assets con hash); los assets, para siempre
      if (ruta.endsWith('.html')) res.setHeader('Cache-Control', 'no-store')
      else if (ruta.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      }
    },
  })
} else {
  app.log.warn('web/dist no existe: el panel no se sirve. Compílalo con "npm run build:web".')
}

// El respaldo de SPA solo puede tragarse rutas del panel: /api/* y /t/* tienen que seguir dando
// 404 de verdad, o un webhook mal escrito recibiría un 200 con HTML y lo daría por bueno.
app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || ''
  const esApi = url.startsWith('/api/') || url === '/api' || url.startsWith('/t/')
  const esNavegacion = req.method === 'GET' || req.method === 'HEAD'
  if (esApi || !esNavegacion) {
    return reply.code(404).send({ error: 'Ruta no encontrada' })
  }
  if (!hayPanel) {
    return reply.code(503).send({ error: 'El panel todavía no está compilado (falta web/dist).' })
  }
  return reply.sendFile('index.html')
})

// ---------------------------------------------------------------------------
// 6. Errores. Hacia fuera solo sale el mensaje de los errores esperados (4xx); el 500 se registra
//    entero pero se responde en genérico para no filtrar consultas ni credenciales.
// ---------------------------------------------------------------------------
app.setErrorHandler((err, req, reply) => {
  const status = Number(err.statusCode || err.status || 500)
  if (status >= 500) req.log.error({ err }, 'error no controlado')
  else req.log.warn({ err: err.message, url: req.raw.url }, 'petición rechazada')
  return reply.code(status >= 400 && status <= 599 ? status : 500).send({
    error: status >= 500 || status < 400 ? 'Error interno' : err.message,
  })
})

// ---------------------------------------------------------------------------
// 7. Procesos en segundo plano: worker de la cola y pasarela SMTP.
//
// Se cargan con import dinámico y solo si su fichero existe: así la API y el panel siguen en pie
// aunque uno de los dos no esté disponible (el correo se queda en la cola de `messages`, que es
// persistente, y sale en cuanto arranque un worker).
// ---------------------------------------------------------------------------
const paradas = []

async function cargarModulo(candidatos) {
  for (const relativa of candidatos) {
    const absoluta = path.join(raiz, relativa)
    if (!existsSync(absoluta)) continue
    return { ruta: relativa, mod: await import(pathToFileURL(absoluta).href) }
  }
  return null
}

// El nombre exacto que exporta cada módulo puede variar; se acepta cualquiera de los habituales
// tanto en las exportaciones sueltas como dentro de un export default con forma de objeto.
function resolverFuncion(origen, nombres) {
  const fuentes = [origen, origen?.default].filter((o) => o && (typeof o === 'object' || typeof o === 'function'))
  for (const nombre of nombres) {
    for (const fuente of fuentes) {
      if (typeof fuente[nombre] === 'function') return fuente[nombre].bind(fuente)
    }
  }
  return null
}

async function arrancarServicio({ etiqueta, candidatos, inicio, parada }) {
  try {
    const cargado = await cargarModulo(candidatos)
    if (!cargado) {
      app.log.error(`${etiqueta}: no se encontró su módulo (${candidatos.join(' | ')}); no se arranca`)
      return
    }
    const iniciar = resolverFuncion(cargado.mod, inicio)
    if (!iniciar) {
      app.log.error(`${etiqueta}: ${cargado.ruta} no exporta ninguna función de arranque (${inicio.join(', ')})`)
      return
    }
    const resultado = await iniciar(app.log, { log: app.log, config })
    const parar = resolverFuncion(cargado.mod, parada) || resolverFuncion(resultado, parada)
    if (parar) paradas.push({ etiqueta, parar })
    else app.log.warn(`${etiqueta}: sin función de parada; el cierre ordenado no podrá esperarlo`)
    app.log.info(`${etiqueta}: en marcha (${cargado.ruta})`)
  } catch (err) {
    // que no arranque un proceso de fondo NO tumba la API: los mensajes esperan en la cola de
    // `messages`, que es persistente, y salen en cuanto vuelva a haber un worker vivo
    app.log.error({ err }, `${etiqueta}: no se pudo arrancar`)
  }
}

const arrancarWorker = () =>
  arrancarServicio({
    etiqueta: 'worker de envío',
    candidatos: ['lib/queue.js', 'lib/worker.js'],
    inicio: ['iniciarWorker', 'arrancarWorker', 'startWorker', 'iniciarCola', 'arrancarCola', 'iniciar', 'arrancar', 'start'],
    parada: ['pararWorker', 'detenerWorker', 'stopWorker', 'pararCola', 'detenerCola', 'parar', 'detener', 'stop', 'cerrar'],
  })

const arrancarRelay = () =>
  arrancarServicio({
    etiqueta: 'pasarela SMTP',
    candidatos: ['smtp-relay/index.js', 'lib/relay.js'],
    inicio: ['iniciarRelay', 'arrancarRelay', 'startRelay', 'iniciarPasarela', 'arrancarPasarela', 'iniciar', 'arrancar', 'start'],
    parada: ['pararRelay', 'detenerRelay', 'stopRelay', 'pararPasarela', 'detenerPasarela', 'parar', 'detener', 'stop', 'cerrar'],
  })

// ---------------------------------------------------------------------------
// 8. Cierre ordenado. Node es PID 1 en el contenedor: sin manejador ignoraría el SIGTERM de cada
//    redespliegue y el orquestador acabaría matándolo a mitad de un envío.
//    Orden: primero worker y pasarela (dejan de aceptar trabajo nuevo), luego el HTTP en vuelo,
//    y solo al final se cierran el pool y Redis, que los tres necesitan hasta el último momento.
// ---------------------------------------------------------------------------
const PLAZO_CIERRE_MS = 20_000
let cerrando = false

async function apagar(senal) {
  if (cerrando) return
  cerrando = true
  app.log.info({ senal }, 'cerrando ordenadamente')

  // red de seguridad: si algo se queda colgado, el contenedor no puede quedarse a medio cerrar
  const plazo = setTimeout(() => {
    app.log.error('el cierre ordenado no terminó a tiempo: se fuerza la salida')
    process.exit(1)
  }, PLAZO_CIERRE_MS)
  plazo.unref()

  for (const { etiqueta, parar } of paradas.splice(0)) {
    try {
      await parar()
      app.log.info(`${etiqueta}: parado`)
    } catch (err) {
      app.log.error({ err }, `${etiqueta}: fallo al pararlo`)
    }
  }
  try {
    await app.close()
  } catch (err) {
    app.log.error({ err }, 'fallo cerrando el servidor HTTP')
  }
  try {
    await pool.end()
  } catch (err) {
    app.log.error({ err }, 'fallo cerrando el pool de Postgres')
  }
  try {
    await redis.quit()
  } catch {
    redis.disconnect()
  }

  clearTimeout(plazo)
  process.exit(0)
}

process.on('SIGTERM', () => apagar('SIGTERM'))
process.on('SIGINT', () => apagar('SIGINT'))
process.on('unhandledRejection', (motivo) => {
  app.log.error({ err: motivo }, 'promesa rechazada sin capturar')
})

// ---------------------------------------------------------------------------
// 9. Arranque
// ---------------------------------------------------------------------------

// REDIS_URL puede llevar usuario y contraseña: para los logs se queda solo en host:puerto
const destinoRedis = (() => {
  try {
    const u = new URL(config.redisUrl)
    return `${u.hostname}:${u.port || 6379}`
  } catch {
    return 'el destino de REDIS_URL'
  }
})()

try {
  for (const aviso of avisosEntorno) app.log.warn(aviso)

  await migrate(app.log)

  // fail-fast: sin Redis no hay sesiones, ni locks de refresco de token, ni límites de envío.
  // En el mensaje va solo host:puerto: REDIS_URL puede llevar contraseña y esto acaba en los logs.
  await redis.ping().catch((err) => {
    throw new Error(`No se pudo conectar a Redis (${destinoRedis}): ${err.message}`)
  })

  // tras las migraciones: el segmento secreto de las URLs de los nodos de GHL tiene que existir
  // antes de la primera llamada, y es idempotente entre réplicas
  await asegurarActionSecret()

  await app.listen({ port: config.port, host: '0.0.0.0' })

  if (config.worker.habilitado) await arrancarWorker()
  if (config.relay.habilitado) await arrancarRelay()
  else app.log.info('pasarela SMTP desactivada (SMTP_RELAY_ENABLED=false)')
} catch (err) {
  app.log.error({ err }, 'fallo en el arranque')
  process.exit(1)
}
