import { q } from '../db.js'
import { dispararAutoDnd } from './dnd.js'

// ---------------------------------------------------------------------------
// Lista de supresión (tabla suppressions).
//
// Se consulta ANTES de cada envío, venga de un nodo, del relay o del worker: enviar a una dirección
// que ya rebotó de forma dura o que pidió la baja es lo que quema la reputación del dominio y de la
// IP del proveedor. La clave única es (location_id, email) y la columna es citext, así que la
// comparación NO distingue mayúsculas.
//
// Desde la sección «Rebotados» (SPEC §12) el alta de un rebote duro además vincula el contacto de
// GHL (ghl_contact_id, si el mensaje lo traía) y dispara el auto-DND en segundo plano. Ese disparo
// vive AQUÍ y no en cada receptor (webhook de Brevo, DSN VERP, rechazo al enviar) para que ninguna
// vía pueda olvidárselo.
// ---------------------------------------------------------------------------

/** Motivos admitidos por el CHECK de la tabla. */
export const MOTIVOS = Object.freeze(['rebote_duro', 'spam', 'baja', 'manual'])

const MOTIVOS_VALIDOS = new Set(MOTIVOS)

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

/** Normaliza una dirección para comparar: recorta, quita el nombre visible y baja a minúsculas. */
export function normalizarEmail(valor) {
  const bruto = texto(valor)
  const entre = bruto.match(/<([^>]+)>/)
  return (entre ? entre[1] : bruto).trim().toLowerCase()
}

const motivoValido = (motivo) => (MOTIVOS_VALIDOS.has(texto(motivo)) ? texto(motivo) : 'manual')

const COLUMNAS = 'id, location_id, email, reason, source, ghl_contact_id, dnd_at, dnd_error, created_at'

/**
 * ¿Está suprimida esta dirección en esta subcuenta?
 * Devuelve la fila (con el motivo, que se enseña en el historial) o null.
 */
export async function estaSuprimido(locationId, email) {
  const direccion = normalizarEmail(email)
  const loc = texto(locationId)
  if (!direccion || !loc) return null
  const { rows: [fila] } = await q(
    `SELECT ${COLUMNAS} FROM suppressions WHERE location_id = $1 AND email = $2`,
    [loc, direccion]
  )
  return fila ?? null
}

/**
 * Versión en lote para comprobar varias direcciones de una vez (destinatario + CC + BCC).
 * Devuelve un Map dirección→fila con SOLO las que están suprimidas.
 */
export async function filtrarSuprimidos(locationId, emails) {
  const loc = texto(locationId)
  const direcciones = [...new Set((Array.isArray(emails) ? emails : [emails]).map(normalizarEmail).filter(Boolean))]
  if (!loc || !direcciones.length) return new Map()
  const { rows } = await q(
    `SELECT ${COLUMNAS} FROM suppressions WHERE location_id = $1 AND email = ANY($2::citext[])`,
    [loc, direcciones]
  )
  return new Map(rows.map((f) => [normalizarEmail(f.email), f]))
}

/**
 * Da de alta una supresión. Es idempotente: si la dirección ya estaba, se conserva el motivo
 * original (el primero que la suprimió es el que explica de verdad por qué) y se devuelve
 * `creada: false`.
 *
 * Opciones (SPEC §12):
 *   · ghlContactId — contacto de GHL del DESTINATARIO PRINCIPAL del mensaje que provocó el alta.
 *     Se guarda para que la sección «Rebotados» no tenga que resolverlo por email. Si la fila ya
 *     existía sin contacto, se completa ahora.
 *   · messageId — mensaje que provocó el alta: ancla el resultado del auto-DND a su histórico.
 *
 * Auto-DND (SPEC §12.4): SOLO cuando la supresión resultante es un `rebote_duro` se dispara la
 * activación del DND en segundo plano (dispararAutoDnd nunca bloquea: todo su trabajo va en un
 * setImmediate). Las altas por spam, baja o manual NO tocan el contacto: que alguien se dé de baja
 * no significa que su correo esté roto.
 */
export async function suprimir(locationId, email, motivo = 'manual', fuente = null, opciones = {}) {
  const direccion = normalizarEmail(email)
  const loc = texto(locationId)
  if (!direccion || !loc) return { creada: false, supresion: null }

  const ghlContactId = texto(opciones.ghlContactId).slice(0, 120) || null
  const messageId = opciones.messageId ?? null

  const { rows: [nueva] } = await q(
    `INSERT INTO suppressions (location_id, email, reason, source, ghl_contact_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (location_id, email) DO NOTHING
     RETURNING ${COLUMNAS}`,
    [loc, direccion, motivoValido(motivo), texto(fuente).slice(0, 200) || null, ghlContactId]
  )

  let supresion = nueva ?? null
  if (!supresion) {
    supresion = await estaSuprimido(loc, direccion)
    if (supresion && ghlContactId && !supresion.ghl_contact_id) {
      // el AND IS NULL respeta lo que otro proceso haya podido escribir entre la lectura y aquí
      await q(
        'UPDATE suppressions SET ghl_contact_id = $2 WHERE id = $1 AND ghl_contact_id IS NULL',
        [supresion.id, ghlContactId]
      )
      supresion = { ...supresion, ghl_contact_id: ghlContactId }
    }
  }

  // Se dispara también sobre una fila que ya existía sin dnd_at: un rebote repetido reintenta un
  // DND que en su día falló (p. ej. la conexión OAuth estaba caída) y la fila se autorrepara.
  if (supresion?.reason === 'rebote_duro' && !supresion.dnd_at) {
    dispararAutoDnd(loc, direccion, { messageId })
  }

  return { creada: Boolean(nueva), supresion }
}

/** Quita una supresión (baja manual desde el panel). Devuelve true si existía. */
export async function levantarSupresion(locationId, email) {
  const direccion = normalizarEmail(email)
  const loc = texto(locationId)
  if (!direccion || !loc) return false
  const { rowCount } = await q(
    'DELETE FROM suppressions WHERE location_id = $1 AND email = $2',
    [loc, direccion]
  )
  return rowCount > 0
}

/** Contadores por motivo, para el resumen del panel. */
export async function resumenSupresiones(locationId) {
  const { rows } = await q(
    'SELECT reason, COUNT(*)::int AS total FROM suppressions WHERE location_id = $1 GROUP BY reason',
    [texto(locationId)]
  )
  const resumen = { total: 0 }
  for (const motivo of MOTIVOS) resumen[motivo] = 0
  for (const fila of rows) {
    resumen[fila.reason] = fila.total
    resumen.total += fila.total
  }
  return resumen
}
