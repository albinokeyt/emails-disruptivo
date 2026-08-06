import Redis from 'ioredis'
import { config } from './config.js'

// lazyConnect: importar este módulo no abre sockets (el worker y la pasarela lo importan de
// rebote). La primera orden conecta, y el arranque hace redis.ping() para fallar pronto si no está.
export const redis = new Redis(config.redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  // reconexión con espera creciente y tope de 5 s. Redis aquí guarda sesiones y contadores de
  // límite: si se cae, la app NO muere (session/ratelimit degradan solos) y reengancha al volver.
  retryStrategy: (intentos) => Math.min(intentos * 200, 5000),
  // en un failover la réplica responde READONLY: se reconecta y se reintenta la orden
  reconnectOnError: (err) => /READONLY/.test(err.message),
})

// ioredis emite un 'error' por cada intento de reconexión: sin límite llenaría los logs de líneas
// idénticas. Se registra el primero y luego como mucho uno cada 30 s.
const SILENCIO_MS = 30_000
let ultimoError = 0

redis.on('error', (err) => {
  const ahora = Date.now()
  if (ahora - ultimoError < SILENCIO_MS) return
  ultimoError = ahora
  console.error('[redis]', err.message)
})

redis.on('end', () => {
  // 'end' también se emite en el cierre ordenado; solo es un dato de diagnóstico
  console.warn('[redis] conexión cerrada')
})
