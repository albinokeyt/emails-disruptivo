import { q } from '../db.js'
import { consumirLimiteEnvio } from './ratelimit.js'
import { filtrarSuprimidos } from './suppression.js'
import { MENSAJE_SIN_ACCESO, tieneAcceso } from './marketplace.js'

// Encolado desde el PANEL: lo que comparten responder/reenviar/redactar desde el Buzón
// (src/routes/buzon.js, SPEC §14) y «Enviar prueba» de Remitentes (src/lib/envio-prueba.js, SPEC
// §5.2) antes de insertar su fila en `messages`. Ninguno abre una conexión propia: el worker
// (src/lib/queue.js) saca el mensaje por el remitente y proveedor de siempre, así que aquí se aplican
// las mismas tres puertas que a un nodo de GHL (src/routes/actions.js): suscripción del marketplace,
// lista de supresión y límite de envíos de la subcuenta.

export const RANGO_ENCOLADO = 0
export const RANGO_SUPRIMIDO = 93 // §4 del SPEC: 'suprimido' es terminal

/** Error con código HTTP para que la ruta responda { error } con ese código. */
export function fallo(codigo, mensaje) {
  const err = new Error(mensaje)
  err.codigo = codigo
  return err
}

/**
 * Proveedor del remitente, comprobando que siga disponible para la subcuenta (propio o cedido por la
 * agencia). Devuelve { id, name, type }. `accion` se intercala en el texto del 400 («…antes de
 * responder», «…antes de enviar la prueba») para que el aviso hable de lo que el usuario intentaba.
 */
export async function proveedorDe(remitente, locationId, { accion = 'enviar' } = {}) {
  if (!remitente.provider_id) {
    throw fallo(400, `El remitente ${remitente.email} no tiene proveedor asignado: asígnale uno en Remitentes antes de ${accion}`)
  }
  const { rows: [p] } = await q(
    `SELECT p.id, p.name, p.type FROM providers p
      WHERE p.id = $1 AND (
            (p.owner_scope = 'location' AND p.location_id = $2)
         OR (p.owner_scope = 'admin' AND EXISTS (
               SELECT 1 FROM provider_assignments a WHERE a.provider_id = p.id AND a.location_id = $2)))`,
    [remitente.provider_id, locationId]
  )
  if (!p) throw fallo(400, `El proveedor del remitente ${remitente.email} ya no está disponible para tu subcuenta`)
  return p
}

/**
 * Las tres puertas previas al INSERT, en este orden:
 *   1. suscripción en el Marketplace Disruptivo → 403 con el texto literal (la sesión sigue valiendo);
 *   2. lista de supresión de TODOS los destinatarios (no solo el principal): si cae el principal el
 *      mensaje nace 'suprimido' (se guarda igualmente para que quede rastro); las copias suprimidas
 *      simplemente se quitan de cc/bcc;
 *   3. límite de envíos de la subcuenta → 429; solo se consume si el mensaje va a salir de verdad.
 * Devuelve { bloqueados, supresion, estado, rango, ultimoError, cc, bcc } (cc/bcc ya sin suprimidos,
 * null si no queda ninguno).
 */
export async function comprobarEncolado({ locationId, log, destino, cc = [], bcc = [] }) {
  const acceso = await tieneAcceso(locationId, { log })
  if (!acceso.access) throw fallo(403, MENSAJE_SIN_ACCESO)

  const bloqueados = await filtrarSuprimidos(locationId, [destino, ...cc, ...bcc])
  const supresion = bloqueados.get(destino.toLowerCase()) ?? null
  const sinSuprimir = (lista) => {
    const quedan = lista.filter((d) => !bloqueados.has(d.toLowerCase()))
    return quedan.length ? quedan : null
  }

  const estado = supresion ? 'suprimido' : 'encolado'
  const rango = supresion ? RANGO_SUPRIMIDO : RANGO_ENCOLADO
  const ultimoError = supresion ? `Destinatario en la lista de supresión (${supresion.reason})` : null

  if (!supresion) {
    const cupo = await consumirLimiteEnvio(locationId)
    if (!cupo.ok) throw fallo(429, cupo.motivo || 'Se ha alcanzado el límite de envíos de esta subcuenta')
  }

  return { bloqueados, supresion, estado, rango, ultimoError, cc: sinSuprimir(cc), bcc: sinSuprimir(bcc) }
}

/**
 * Copias suprimidas: queda escrito en el histórico del mensaje por qué a esa dirección no le llegó
 * nada (mismo evento que dejan el relay y los nodos). Nunca tumba la petición: el mensaje ya está
 * encolado.
 */
export async function registrarCopiasSuprimidas(messageId, bloqueados, dedupeKey, log) {
  await q(
    `INSERT INTO message_events (message_id, event, occurred_at, dedupe_key, data)
     VALUES ($1,'destinatarios_suprimidos', now(), $2, $3::jsonb)
     ON CONFLICT (message_id, dedupe_key) DO NOTHING`,
    [
      messageId,
      dedupeKey,
      JSON.stringify({
        direcciones: Object.fromEntries([...bloqueados].map(([email, f]) => [email, f.reason])),
      }),
    ]
  ).catch((err) => log?.warn?.({ err, mensaje: messageId }, 'no se pudo registrar la supresión parcial'))
}
