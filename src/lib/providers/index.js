import brevo from './brevo.js'
import smtp from './smtp.js'

// Registro de proveedores de email saliente (SPEC §7).
//
// Todos exportan el mismo objeto —tipo, camposCredenciales, validar, enviar, listarRemitentes— así
// que son intercambiables: añadir uno nuevo es crear el fichero y meterlo en este mapa, sin tocar
// el worker ni las rutas.
//
// Lo cargan src/routes/location.js (botón «Probar conexión», con import dinámico) y
// src/lib/queue.js (el worker).

/** Mapa tipo → integración. Las claves son los valores admitidos por providers.type. */
export const proveedores = Object.freeze({
  [brevo.tipo]: brevo,
  [smtp.tipo]: smtp,
})

/** Tipos disponibles, en el orden en que se ofrecen en el panel. */
export const tiposProveedor = Object.freeze(Object.keys(proveedores))

/**
 * Integración de un tipo. Devuelve null si el tipo no existe: quien la llama decide qué hacer
 * (el panel responde 501 y el worker marca el mensaje como fallido). Nunca lanza, porque
 * src/routes/location.js la invoca sin envolverla en try/catch.
 */
export function obtenerProveedor(tipo) {
  const clave = (tipo === undefined || tipo === null ? '' : String(tipo)).trim().toLowerCase()
  return Object.prototype.hasOwnProperty.call(proveedores, clave) ? proveedores[clave] : null
}

/** Descriptor de los campos de credenciales de un tipo, para pintar el formulario del panel. */
export function camposCredenciales(tipo) {
  return obtenerProveedor(tipo)?.camposCredenciales ?? []
}

/** Descriptor de los campos NO secretos (host, puerto…) de un tipo. */
export function camposConfig(tipo) {
  return obtenerProveedor(tipo)?.camposConfig ?? []
}

/** Cierre ordenado: los proveedores que mantienen conexiones abiertas (SMTP) las sueltan aquí. */
export async function cerrarProveedores() {
  await Promise.all(
    Object.values(proveedores).map(async (proveedor) => {
      if (typeof proveedor.cerrar !== 'function') return
      try {
        await proveedor.cerrar()
      } catch {
        // cerrar es best-effort: nunca puede impedir que el proceso termine
      }
    })
  )
}

export default { proveedores, tiposProveedor, obtenerProveedor, camposCredenciales, camposConfig, cerrarProveedores }
