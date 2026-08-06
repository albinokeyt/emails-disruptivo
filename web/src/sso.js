// SSO de GHL para Custom Pages.
// GHL pinta el panel dentro de un iframe. La identidad NO viaja por la query string:
// se pide a la ventana padre con postMessage y llega cifrada con el Shared Secret de la app.
// El backend la descifra en POST /api/sesion/sso y nos deja la cookie de sesión.

import { iniciarSesionSso, ErrorApi } from './api.js'

const ESPERA_MS = 10000     // GHL puede tardar en responder al primer mensaje
const REINTENTO_MS = 1200   // se vuelve a preguntar mientras no llegue respuesta

export function estamosEmbebidos() {
  try { return window.self !== window.top } catch { return true } // cross-origin ⇒ embebidos
}

// Pide a GHL el paquete cifrado del usuario. Resuelve el string cifrado o null si no llega.
export function pedirContextoGhl(esperaMs = ESPERA_MS) {
  return new Promise((resolve) => {
    let terminado = false
    let temporizador = null
    let intervalo = null

    const terminar = (valor) => {
      if (terminado) return
      terminado = true
      window.removeEventListener('message', alRecibir)
      clearTimeout(temporizador)
      clearInterval(intervalo)
      resolve(valor || null)
    }

    // Se aceptan las dos formas observadas: el objeto documentado y el payload suelto.
    const alRecibir = (e) => {
      const d = e.data
      if (!d) return
      if (typeof d === 'string' && d.length > 24) return terminar(d)
      if (d.message === 'REQUEST_USER_DATA_RESPONSE') return terminar(d.payload || d.data || null)
    }

    const preguntar = () => {
      try { window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*') } catch { /* sin padre */ }
    }

    window.addEventListener('message', alRecibir)
    preguntar()
    intervalo = setInterval(preguntar, REINTENTO_MS)
    temporizador = setTimeout(() => terminar(null), esperaMs)
  })
}

// Intenta dejar la sesión de subcuenta iniciada.
// → { ok: true, sesion } | { ok: false, motivo, mensaje }
export async function iniciarSesionConSso() {
  if (!estamosEmbebidos()) {
    return {
      ok: false,
      motivo: 'sin_iframe',
      mensaje: 'Esta página tiene que abrirse desde el menú de tu subcuenta en GoHighLevel.',
    }
  }

  const payload = await pedirContextoGhl()
  if (!payload) {
    return {
      ok: false,
      motivo: 'sin_respuesta',
      mensaje: 'GoHighLevel no ha devuelto el contexto del usuario. Recarga la página desde el menú de la subcuenta.',
    }
  }

  try {
    const sesion = await iniciarSesionSso(payload)
    return { ok: true, sesion }
  } catch (err) {
    return {
      ok: false,
      motivo: 'rechazado',
      mensaje: err instanceof ErrorApi ? err.message : 'No se ha podido validar la sesión con GoHighLevel.',
    }
  }
}
