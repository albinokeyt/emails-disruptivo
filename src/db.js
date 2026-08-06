import pg from 'pg'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from './config.js'

const { Pool } = pg

// Un único pool por proceso: lo comparten la API, el worker de envío y la pasarela SMTP.
// El techo sube con la concurrencia del worker para que sus consultas (que mantienen la
// transacción abierta mientras dura el SELECT ... FOR UPDATE) no dejen sin conexiones al panel.
export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: Math.max(10, config.worker.concurrencia * 2),
  connectionTimeoutMillis: 10_000,
  idleTimeoutMillis: 30_000,
})

// Una conexión inactiva que el servidor (o un proxy) corta emite 'error' en el pool. Sin este
// manejador Node tumbaría el proceso entero por algo de lo que pg ya se recupera solo.
pool.on('error', (err) => {
  console.error('[postgres] conexión inactiva descartada:', err.message)
})

export const q = (text, params) => pool.query(text, params)

const directorioMigraciones = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations')

// Identificador del lock de asesoramiento. Es constante a propósito: es lo que serializa a varias
// réplicas arrancando a la vez.
const LOCK_MIGRACIONES = 'emails_disruptivo_migrations'

/**
 * Aplica src/migrations/*.sql en orden alfabético, una sola vez cada uno (registro en
 * schema_migrations). Cada fichero va en su propia transacción: si uno falla, no deja el esquema
 * a medias ni se marca como aplicado.
 */
export async function migrate(log = console) {
  const client = await pool.connect()
  try {
    // lock de asesoramiento: dos instancias arrancando a la vez no compiten por las migraciones
    await client.query(`SELECT pg_advisory_lock(hashtext($1::text))`, [LOCK_MIGRACIONES])
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const ficheros = (await readdir(directorioMigraciones)).filter((f) => f.endsWith('.sql')).sort()
    for (const fichero of ficheros) {
      const hecha = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [fichero])
      if (hecha.rowCount) continue
      const sql = await readFile(path.join(directorioMigraciones, fichero), 'utf8')
      try {
        await client.query('BEGIN')
        await client.query(sql)
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [fichero])
        await client.query('COMMIT')
        log.info?.(`migración aplicada: ${fichero}`)
      } catch (err) {
        await client.query('ROLLBACK')
        throw new Error(`la migración ${fichero} falló: ${err.message}`)
      }
    }
  } finally {
    await client.query(`SELECT pg_advisory_unlock(hashtext($1::text))`, [LOCK_MIGRACIONES]).catch(() => {})
    client.release()
  }
}
