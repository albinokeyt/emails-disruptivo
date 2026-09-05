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
import { asegurarCertificado, detenerRenovacion, motivoSinCertificado, programarRenovacion } from './lib/acme.js'
import { detenerVigilanciaTraefik, vigilarCertificadoTraefik } from './lib/traefik.js'
import { arrancarSyncBuzon, pararSyncBuzon } from './lib/buzon-sync.js'

import acmeRoutes from './routes/acme.js'
import oauthRoutes from './routes/oauth.js'
import locationRoutes from './routes/location.js'
import buzonRoutes from './routes/buzon.js'
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
// Buzón IMAP (SPEC §14.3): mismo prefijo /api/loc/* y mismo guarda requireLocation que el panel
await app.register(buzonRoutes)
await app.register(adminRoutes)
await app.register(accionesRoutes)
await app.register(webhooksRoutes)
await app.register(trackingRoutes)
// Baja en un clic (RFC 8058). Va aparte porque la sirve el motor de envío (lib/tracking.js), no
// routes/tracking.js: TODOS los correos salen con List-Unsubscribe-Post apuntando a /t/baja, así que
// sin registrarla Gmail y Yahoo recibirían un 404 en la baja y penalizarían la reputación del envío.
await app.register(rutasBaja)

// Reto ACME HTTP-01 del certificado del relay (SPEC §13.1). Va ANTES del estático y del respaldo
// de SPA: si el index.html contestara a /.well-known/acme-challenge/<token>, Let's Encrypt leería
// HTML en vez del reto y el certificado nunca se emitiría.
await app.register(acmeRoutes)

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

// El respaldo de SPA solo puede tragarse rutas del panel: /api/*, /t/* y /.well-known/* tienen que
// seguir dando 404 de verdad, o un webhook mal escrito recibiría un 200 con HTML y lo daría por
// bueno (y una CA que pidiera un reto ACME inexistente leería el index del panel).
app.setNotFoundHandler((req, reply) => {
  const url = req.raw.url || ''
  const esApi =
    url.startsWith('/api/') || url === '/api' || url.startsWith('/t/') ||
    url.startsWith('/.well-known/') || url === '/.well-known'
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

/** Devuelve { mod, resultado } si el servicio arrancó, o null. Nunca lanza. */
async function arrancarServicio({ etiqueta, candidatos, inicio, parada }) {
  try {
    const cargado = await cargarModulo(candidatos)
    if (!cargado) {
      app.log.error(`${etiqueta}: no se encontró su módulo (${candidatos.join(' | ')}); no se arranca`)
      return null
    }
    const iniciar = resolverFuncion(cargado.mod, inicio)
    if (!iniciar) {
      app.log.error(`${etiqueta}: ${cargado.ruta} no exporta ninguna función de arranque (${inicio.join(', ')})`)
      return null
    }
    const resultado = await iniciar(app.log, { log: app.log, config })
    const parar = resolverFuncion(cargado.mod, parada) || resolverFuncion(resultado, parada)
    if (parar) paradas.push({ etiqueta, parar })
    else app.log.warn(`${etiqueta}: sin función de parada; el cierre ordenado no podrá esperarlo`)
    app.log.info(`${etiqueta}: en marcha (${cargado.ruta})`)
    return { mod: cargado.mod, resultado }
  } catch (err) {
    // que no arranque un proceso de fondo NO tumba la API: los mensajes esperan en la cola de
    // `messages`, que es persistente, y salen en cuanto vuelva a haber un worker vivo
    app.log.error({ err }, `${etiqueta}: no se pudo arrancar`)
    return null
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

// Sincronización del buzón IMAP (SPEC §14.2). Vive junto al worker: solo la instancia que envía
// correo trae correo, así una réplica «solo API» (WORKER_HABILITADO=false) no abre conexiones IMAP.
// Que no arranque NO tumba la API: el panel sigue sirviendo lo ya guardado.
function arrancarBuzon() {
  try {
    arrancarSyncBuzon(app.log)
    paradas.push({ etiqueta: 'sincronización del buzón', parar: () => pararSyncBuzon() })
    app.log.info('sincronización del buzón: en marcha (lib/buzon-sync.js)')
  } catch (err) {
    app.log.error({ err }, 'sincronización del buzón: no se pudo arrancar')
  }
}

// ---------------------------------------------------------------------------
// 7b. Certificado TLS automático del relay (SPEC §13.1).
//
// El relay ya está escuchando con lo que tenga (ficheros o autofirmado). Aquí, SIN esperar a nada
// y con la precedencia ficheros > traefik > ACME > autofirmado:
//   · modo traefik (SMTP_RELAY_TRAEFIK_ACME): src/lib/traefik.js lee el certificado que Traefik ya
//     tiene y renueva para el host, y vigila el fichero para recoger sus renovaciones. Es el modo
//     de EasyPanel, donde el reto HTTP-01 propio no llega a la app. Cero llamadas a la CA.
//   · ACME propio: src/lib/acme.js devuelve el guardado en tls_certificates al instante o lo emite
//     por HTTP-01 y tarda lo que tarde Let's Encrypt; después renueva cada 12 h.
// Cuando el certificado llega se aplica en caliente con actualizarCertificado({ key, cert, origen })
// del relay, sin reiniciar nada. Nada de esto bloquea el listen HTTP ni el arranque de la pasarela.
// Solo se llama cuando la pasarela ha abierto al menos un puerto: un certificado para un relay que
// no escucha es gastar cuota de la CA para nada.
// ---------------------------------------------------------------------------
function arrancarCertificadoRelay(relay) {
  const { tlsAuto, tlsCert, tlsKey, traefikAcme, host } = config.relay
  if (tlsCert && tlsKey) {
    app.log.info('relay: certificado TLS de ficheros (SMTP_RELAY_TLS_CERT/_KEY); no se usa Traefik ni ACME')
    return
  }
  if (!traefikAcme && !tlsAuto) {
    app.log.warn('relay: SMTP_RELAY_TLS_AUTO=false, sin SMTP_RELAY_TRAEFIK_ACME y sin ficheros de certificado: se queda con el autofirmado')
    return
  }
  const aplicar = resolverFuncion(relay?.mod, ['actualizarCertificado', 'updateCertificate', 'aplicarCertificado'])
  if (!aplicar) {
    app.log.error('relay: el módulo de la pasarela no exporta actualizarCertificado(); el certificado no se podrá aplicar en caliente')
    return
  }

  // actualizarCertificado del relay no lanza: devuelve { aplicado, error }. Se comprueba para no
  // anunciar como aplicado un certificado que la pasarela rechazó, y se devuelve tal cual para que
  // quien lo llama (la vigilancia de Traefik) sepa si tiene que reintentar.
  const origen = traefikAcme ? 'traefik' : 'acme'
  const etiqueta = traefikAcme ? 'de Traefik' : 'ACME'
  const aplicarCertificado = async ({ key, cert, expiresAt }) => {
    const resultado = await aplicar({ key, cert, expiresAt, origen }, app.log)
    if (resultado && resultado.aplicado === false) {
      app.log.warn({ motivo: resultado.error || null }, `relay: el certificado ${etiqueta} no se pudo aplicar en caliente`)
      return resultado
    }
    // la pasarela ya escribe «certificado … aplicado, válido hasta …» cuando devuelve aplicado:true;
    // solo se repite aquí si la función no informa de nada
    if (resultado?.aplicado === true) return resultado
    const hasta = expiresAt instanceof Date ? expiresAt.toISOString() : String(expiresAt || '')
    app.log.info(`relay: certificado ${etiqueta} aplicado, válido hasta ${hasta}`)
    return resultado ?? { aplicado: true, error: null }
  }

  if (traefikAcme) {
    app.log.info({ ruta: traefikAcme, host }, 'relay: certificado en modo traefik: se lee del acme.json de Traefik y se sigue su renovación; no se llama a la CA')
    vigilarCertificadoTraefik({ log: app.log, alCambiar: aplicarCertificado })
    return
  }

  // en segundo plano: asegurarCertificado nunca lanza; el catch cubre solo a actualizarCertificado
  asegurarCertificado(host, { log: app.log })
    .then(async (certificado) => {
      if (!certificado) {
        const motivo = motivoSinCertificado(host)
        app.log.warn(
          { motivo },
          motivo === 'lock'
            ? 'relay: sin certificado ACME por ahora (lock de emisión ocupado, quizá de un redespliegue); se reintenta en cuanto caduque'
            : 'relay: sin certificado ACME por ahora; sigue con el autofirmado y se reintentará (ver Ajustes › Relay SMTP)'
        )
        return
      }
      await aplicarCertificado(certificado)
    })
    .catch((err) => app.log.error({ err }, 'relay: no se pudo aplicar el certificado ACME en caliente'))
    .finally(() => {
      programarRenovacion({ log: app.log, alRenovar: aplicarCertificado })
    })
}

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

  // la comprobación periódica del certificado no debe arrancar una emisión a mitad del apagado
  detenerRenovacion()
  detenerVigilanciaTraefik()

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

  if (config.worker.habilitado) {
    await arrancarWorker()
    arrancarBuzon()
  }
  if (config.relay.habilitado) {
    const relay = await arrancarRelay()
    // resultado null = la pasarela no abrió ningún puerto (ocupado, sin permisos…): sin escuchas no
    // hay a qué aplicar un certificado, y pedirlo a la CA sería gastar cuota para nada
    if (relay?.resultado) arrancarCertificadoRelay(relay)
    else if (relay) app.log.warn('relay: sin escuchas abiertas; no se gestiona el certificado TLS hasta el próximo arranque')
  } else {
    app.log.info('pasarela SMTP desactivada (SMTP_RELAY_ENABLED=false)')
  }
} catch (err) {
  app.log.error({ err }, 'fallo en el arranque')
  process.exit(1)
}
