import { q } from '../db.js'
import { activarDndEmail, buscarContactoPorEmail } from './ghl.js'

// ---------------------------------------------------------------------------
// Núcleo del DND de la sección «Rebotados» (SPEC §12).
//
// Un rebote duro dice que esa dirección no existe o no recibe: mantenerla "contactable" en GHL solo
// produce más rebotes. Aquí vive la lógica compartida entre el panel (botón por fila y botón masivo,
// src/routes/location.js) y el disparo automático (auto-DND, SPEC §12.4) que sale de cada alta de
// supresión `rebote_duro` en lib/suppression.js.
//
// Se activa el DND del CANAL Email (dndSettings.Email), nunca el DND global: el cliente puede seguir
// mandando SMS o llamando al contacto; lo único roto es el correo (SPEC §12.2).
// ---------------------------------------------------------------------------

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
// Normalizador mínimo local: no se importa el de suppression.js para no cerrar un ciclo de imports
// (suppression.js ya importa dispararAutoDnd de este fichero).
const normalizar = (v) => texto(v).toLowerCase()
const limpiarError = (v) =>
  texto(v).replace(/[\r\n\t]+/g, ' ').slice(0, 500) || 'Error desconocido activando el DND'

/** Conexión OAuth utilizable de la subcuenta. Lanza con un mensaje claro si no la hay. */
async function conexionViva(locationId) {
  const { rows: [conn] } = await q('SELECT id, status FROM connections WHERE location_id = $1', [texto(locationId)])
  if (!conn) {
    // La palabra «conexión» es contractual: el filtro anti-machaque del DND masivo
    // (routes/location.js, dnd_error NOT ILIKE '%conexi%') aparta estas filas por ella.
    throw new Error('Esta subcuenta no tiene conexión OAuth con la app: reinstálala para poder tocar sus contactos')
  }
  if (conn.status !== 'connected') {
    throw new Error(`La conexión OAuth de esta subcuenta no está operativa (estado «${conn.status}»): reconecta la app`)
  }
  return conn
}

/** ¿Tiene la subcuenta el auto-DND activado en sus preferencias (location_settings)? */
export async function autoDndActivo(locationId) {
  const { rows: [fila] } = await q(
    'SELECT auto_dnd FROM location_settings WHERE location_id = $1',
    [texto(locationId)]
  )
  return Boolean(fila?.auto_dnd)
}

/** Último mensaje enviado a esa dirección: es donde se anota el resultado del DND en el histórico. */
async function ultimoMensajeDe(locationId, email) {
  const { rows: [m] } = await q(
    'SELECT id FROM messages WHERE location_id = $1 AND to_email = $2 ORDER BY id DESC LIMIT 1',
    [texto(locationId), normalizar(email)]
  )
  return m?.id ?? null
}

// El histórico nunca tumba la operación principal: aquí se traga cualquier fallo a propósito.
async function anotarHistorico(supresion, evento, datos, opciones = {}) {
  try {
    const messageId = opciones.messageId ?? (await ultimoMensajeDe(supresion.location_id, supresion.email))
    if (!messageId) return
    const dedupe = evento === 'dnd_activado' ? 'dnd:activado' : `dnd:error:${new Date().toISOString().slice(0, 10)}`
    await q(
      `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
       VALUES ($1,$2,now(),$3,$4::jsonb)
       ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
      [messageId, evento, dedupe, JSON.stringify({ fuente: 'rebotados', ...datos })]
    )
  } catch {
    // sin histórico se sigue igual: dnd_at/dnd_error ya cuentan la verdad en la supresión
  }
}

async function marcarFalloDnd(supresion, motivo, opciones = {}) {
  await q('UPDATE suppressions SET dnd_error = $2 WHERE id = $1', [supresion.id, motivo]).catch(() => {})
  await anotarHistorico(supresion, 'dnd_error', { error: motivo }, opciones)
  return { ok: false, error: motivo }
}

/**
 * Resuelve el contacto de GHL de una supresión (SPEC §12.2): usa el `ghl_contact_id` guardado y,
 * si falta (p. ej. el mensaje vino del relay), busca por email con la conexión de la subcuenta y
 * PERSISTE el id en la fila para no volver a buscarlo. Devuelve el id o null si el contacto no
 * existe en GHL. Lanza si no hay conexión viva o si la API falla.
 */
export async function resolverContacto(supresion, conexion = null) {
  const guardado = texto(supresion?.ghl_contact_id)
  if (guardado) return guardado

  const locationId = texto(supresion?.location_id)
  const email = normalizar(supresion?.email)
  if (!locationId || !email) {
    throw new Error('La supresión no tiene subcuenta o correo: no se puede resolver el contacto')
  }

  const viva = conexion ?? (await conexionViva(locationId))
  const contacto = await buscarContactoPorEmail(viva.id, locationId, email)
  const contactId = texto(contacto?.id)
  if (!contactId) return null

  if (supresion?.id) {
    // el AND IS NULL respeta lo que otro proceso haya podido resolver entre medias
    await q(
      'UPDATE suppressions SET ghl_contact_id = $2 WHERE id = $1 AND ghl_contact_id IS NULL',
      [supresion.id, contactId]
    ).catch(() => {})
  }
  return contactId
}

/**
 * Activa el DND del canal Email para el contacto de una supresión y deja el resultado en la fila:
 * éxito → dnd_at=now() y dnd_error=NULL; fallo → dnd_error con el motivo (la fila queda pendiente
 * para el botón masivo del panel). Nunca lanza: siempre devuelve
 * `{ ok:true, dnd_at, ghl_contact_id }` o `{ ok:false, error }`.
 */
export async function aplicarDnd(supresion, opciones = {}) {
  if (!supresion?.id) return { ok: false, error: 'Supresión desconocida' }
  if (supresion.dnd_at) return { ok: true, dnd_at: supresion.dnd_at, ghl_contact_id: supresion.ghl_contact_id ?? null, repetido: true }

  try {
    const conexion = await conexionViva(supresion.location_id)
    const contactId = await resolverContacto(supresion, conexion)
    if (!contactId) {
      return await marcarFalloDnd(supresion, 'No existe ningún contacto en GHL con ese correo', opciones)
    }
    await activarDndEmail(conexion.id, contactId)
    const { rows: [fila] } = await q(
      `UPDATE suppressions
          SET ghl_contact_id = COALESCE(ghl_contact_id, $2), dnd_at = now(), dnd_error = NULL
        WHERE id = $1
      RETURNING dnd_at`,
      [supresion.id, contactId]
    )
    await anotarHistorico(supresion, 'dnd_activado', { contacto: contactId }, opciones)
    return { ok: true, dnd_at: fila?.dnd_at ?? new Date(), ghl_contact_id: contactId }
  } catch (err) {
    return marcarFalloDnd(supresion, limpiarError(err?.message), opciones)
  }
}

/**
 * Disparo del auto-DND (SPEC §12.4). Se llama desde el alta de una supresión `rebote_duro`
 * (lib/suppression.js) y TODO su trabajo ocurre en segundo plano con setImmediate: la respuesta del
 * webhook de Brevo, del DSN VERP o del worker jamás espera a GHL. La función es síncrona y no
 * devuelve nada a propósito: no hay promesa que un llamante pueda bloquear con un await.
 *
 * Dentro: comprueba location_settings.auto_dnd, relee la supresión (tiene que seguir existiendo,
 * ser `rebote_duro` y no tener ya el DND puesto) y aplica el DND. Sin conexión OAuth viva,
 * aplicarDnd deja `dnd_error` claro y la fila queda pendiente para el botón masivo del panel.
 *
 * Opciones: { messageId, log } — messageId ancla el resultado al histórico del mensaje que rebotó.
 */
export function dispararAutoDnd(locationId, email, opciones = {}) {
  const loc = texto(locationId)
  const direccion = normalizar(email)
  if (!loc || !direccion) return

  const log = opciones.log && typeof opciones.log.error === 'function' ? opciones.log : console
  setImmediate(async () => {
    try {
      if (!(await autoDndActivo(loc))) return
      const { rows: [supresion] } = await q(
        `SELECT id, location_id, email, reason, ghl_contact_id, dnd_at, dnd_error
           FROM suppressions
          WHERE location_id = $1 AND email = $2 AND reason = 'rebote_duro'`,
        [loc, direccion]
      )
      if (!supresion || supresion.dnd_at) return
      const resultado = await aplicarDnd(supresion, { messageId: opciones.messageId ?? null })
      if (!resultado.ok) {
        // sin el email en el log: el motivo y la subcuenta bastan para diagnosticar
        log.warn?.({ location: loc, motivo: resultado.error }, 'auto-DND: no se pudo activar (queda pendiente para el botón masivo)')
      }
    } catch (err) {
      log.error?.({ err, location: loc }, 'auto-DND: fallo inesperado en segundo plano')
    }
  })
}
