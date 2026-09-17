import { q } from '../db.js'
import { randomCorrelationId } from './crypto.js'
import { rateLimit } from './ratelimit.js'
import { escaparHtml } from './render.js'
import { comprobarEncolado, fallo } from './encolar.js'

// «Enviar prueba» de la pantalla Remitentes (SPEC §5.2, §5.3 y §9), en el panel de subcuenta y en el
// de la agencia: un correo automático que sale por el proveedor del PROPIO remitente y por la cola
// normal (origin='prueba'), sin montar un workflow ni pasar por el Buzón. El panel luego consulta
// GET /api/loc/envios/:id (o /api/admin/envios/:id) y enseña en vivo lo que dijo el proveedor.
//
// Pasa por las mismas puertas que cualquier otro correo (lib/encolar.js): suscripción del
// marketplace, lista de supresión y límite de envíos de la subcuenta. Además lleva un freno propio
// por remitente (MAX_PRUEBAS_HORA) para que el botón no sirva para bombardear una dirección.

export const MAX_PRUEBAS_HORA = 10
const VENTANA_PRUEBAS_S = 3600
const MAX_ASUNTO = 255

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()
// Inyección de cabeceras: el nombre del remitente ya se guardó sin saltos, pero el asunto se
// compone aquí y no se fía de nadie.
const cabecera = (v, max) => texto(v).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').slice(0, max)

// Zona horaria de la fecha que se escribe en el correo. El contenedor no suele tener TZ definida; la
// agencia y sus clientes trabajan en hora de España (mismo criterio que la cita del Buzón).
const ZONA_HORARIA = texto(process.env.TZ) || 'Europe/Madrid'

const TIPO_PROVEEDOR = { smtp: 'SMTP', brevo: 'Brevo' }
const nombreTipo = (tipo) => TIPO_PROVEEDOR[texto(tipo).toLowerCase()] || texto(tipo) || '—'

/** «jueves, 17 de septiembre de 2026, 12:34 (hora de Madrid)». */
function fechaLegible(fecha) {
  let f
  try {
    f = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone: ZONA_HORARIA }).format(fecha)
  } catch {
    // una TZ inválida en el entorno no puede impedir la prueba: se escribe en UTC
    f = new Intl.DateTimeFormat('es-ES', { dateStyle: 'full', timeStyle: 'short', timeZone: 'UTC' }).format(fecha)
    return `${f} (UTC)`
  }
  return `${f} (${ZONA_HORARIA === 'Europe/Madrid' ? 'hora de Madrid' : ZONA_HORARIA})`
}

// ---------------------------------------------------------------------------
// Cuerpo del correo: el look del panel (fondo oscuro, tarjeta, acento dorado), todo con estilos en
// línea porque los clientes de correo ignoran las hojas de estilo. Sin enlaces ni imágenes: no hay
// nada que trackear en una prueba y así no depende del dominio de tracking ni de APP_BASE_URL.
// Sin llaves dobles en el texto: render.js las trataría como variables de plantilla.
// ---------------------------------------------------------------------------

const PALETA = {
  fondo: '#0a0a0c', tarjeta: '#131319', tarjeta2: '#1a1a22', borde: '#26262f',
  tinta: '#f0eee8', tinta2: '#a8adb8', apagado: '#6b7280', oro: '#d9b45b', ok: '#4ade80',
}

function filaDato(etiqueta, valor) {
  return (
    `<tr>` +
    `<td style="padding:8px 12px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:${PALETA.apagado};white-space:nowrap;vertical-align:top">${escaparHtml(etiqueta)}</td>` +
    `<td style="padding:8px 12px;font-size:14px;color:${PALETA.tinta};word-break:break-word">${escaparHtml(valor)}</td>` +
    `</tr>`
  )
}

function htmlPrueba({ remitente, proveedor, fecha }) {
  const nombreRemitente = `${remitente.name} <${remitente.email}>`
  const nombreProveedor = `${proveedor.name} (${nombreTipo(proveedor.type)})`
  const fuente = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"
  return (
    `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
    `<title>Prueba de Emails Disruptivo</title></head>` +
    `<body style="margin:0;padding:24px 12px;background:${PALETA.fondo};font-family:${fuente};color:${PALETA.tinta}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:${PALETA.tarjeta};border:1px solid ${PALETA.borde};border-radius:16px">` +
    `<tr><td style="padding:28px 32px">` +
    `<p style="margin:0 0 6px;font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:${PALETA.oro}">Emails Disruptivo</p>` +
    `<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:${PALETA.tinta}">Correo de prueba</h1>` +
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.55;color:${PALETA.tinta2}">` +
    `<span style="color:${PALETA.ok};font-weight:600">Si estás leyendo esto, el remitente funciona.</span> ` +
    `El proveedor aceptó el envío y el correo ha llegado hasta tu bandeja tal y como lo verán tus contactos.` +
    `</p>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PALETA.tarjeta2};border:1px solid ${PALETA.borde};border-radius:12px">` +
    filaDato('Remitente', nombreRemitente) +
    filaDato('Proveedor', nombreProveedor) +
    filaDato('Fecha', fecha) +
    `</table>` +
    `<p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:${PALETA.apagado}">` +
    `Este mensaje se generó automáticamente desde la pantalla Remitentes de Emails Disruptivo. No hace falta responderlo.` +
    `</p>` +
    `</td></tr></table></body></html>`
  )
}

function textoPrueba({ remitente, proveedor, fecha }) {
  return [
    'EMAILS DISRUPTIVO · Correo de prueba',
    '',
    'Si estás leyendo esto, el remitente funciona. El proveedor aceptó el envío y el correo ha llegado hasta tu bandeja tal y como lo verán tus contactos.',
    '',
    `Remitente: ${remitente.name} <${remitente.email}>`,
    `Proveedor: ${proveedor.name} (${nombreTipo(proveedor.type)})`,
    `Fecha: ${fecha}`,
    '',
    'Este mensaje se generó automáticamente desde la pantalla Remitentes de Emails Disruptivo. No hace falta responderlo.',
  ].join('\n')
}

/** Asunto, HTML y texto plano de la prueba (sin tocar la base de datos). */
export function componerPrueba({ remitente, proveedor, ahora = new Date() }) {
  const fecha = fechaLegible(ahora)
  return {
    asunto: cabecera(`Prueba de Emails Disruptivo · ${remitente.name} <${remitente.email}>`, MAX_ASUNTO),
    html: htmlPrueba({ remitente, proveedor, fecha }),
    text: textoPrueba({ remitente, proveedor, fecha }),
  }
}

// ---------------------------------------------------------------------------

/**
 * Encola la prueba de un remitente. `remitente` es la fila de senders (ya comprobada por la ruta:
 * de la subcuenta, o la que sea para la agencia) y `proveedor` lo que devolvió proveedorDe().
 * Lanza fallo(403|429) como el resto del panel. Devuelve la respuesta del 201.
 */
export async function encolarPrueba({ locationId, log, remitente, proveedor, destino }) {
  // Freno por remitente ANTES de tocar la cuota de la subcuenta: si Redis no responde, rateLimit
  // deja pasar (es una defensa, no la puerta principal).
  const freno = await rateLimit(`prueba:remitente:${remitente.id}`, MAX_PRUEBAS_HORA, VENTANA_PRUEBAS_S)
  if (!freno.ok) {
    throw fallo(429, `Máximo ${MAX_PRUEBAS_HORA} pruebas por remitente y hora: espera un poco antes de volver a probar ${remitente.email}`)
  }

  const { supresion, estado, rango, ultimoError } = await comprobarEncolado({ locationId, log, destino })

  const { asunto, html, text } = componerPrueba({ remitente, proveedor })
  const replyTo = remitente.reply_to ? cabecera(remitente.reply_to, 320) : null

  const { rows: [insertado] } = await q(
    `INSERT INTO messages (location_id, provider_id, sender_id, template_id, origin, status, status_rank,
                           to_email, to_name, cc, bcc, reply_to, subject, preheader, html, text,
                           correlation_id, last_error)
     VALUES ($1,$2,$3,NULL,'prueba',$4,$5,$6,NULL,NULL,NULL,$7,$8,NULL,$9,$10,$11,$12)
     RETURNING id, status, created_at`,
    [locationId, proveedor.id, remitente.id, estado, rango, destino, replyTo, asunto, html, text, randomCorrelationId(), ultimoError]
  )

  return {
    ok: true,
    message_id: String(insertado.id),
    estado: insertado.status,
    to_email: destino,
    subject: asunto,
    remitente: { id: remitente.id, email: remitente.email, name: remitente.name },
    proveedor: { id: proveedor.id, name: proveedor.name, type: proveedor.type },
    created_at: insertado.created_at,
    aviso: supresion
      ? `La dirección ${destino} está en la lista de supresión (${supresion.reason}): la prueba se ha guardado pero no saldrá`
      : null,
  }
}
