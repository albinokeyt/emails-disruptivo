import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const sinMovimiento = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

/* ------------------------------------------------------------------
   Sesión: App.jsx envuelve el panel con este contexto.
   Subcuenta → { ambito:'location', locationId, nombre, esAdminAgencia }
   Admin     → { ambito:'admin', ...lo que devuelva /api/admin/yo }
   ------------------------------------------------------------------ */
export const SesionContexto = createContext(null)

export function useSesion() {
  return useContext(SesionContexto)
}

/* ------------------------------------------------------------------
   Carga de datos: el patrón que usan todas las pantallas.
   const { datos, cargando, error, recargar } = useCargar(() => listarProveedores(), [])
   ------------------------------------------------------------------ */
export function useCargar(cargador, deps = []) {
  const [datos, setDatos] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [error, setError] = useState(null)
  const [ticket, setTicket] = useState(0)
  const refCargador = useRef(cargador)
  refCargador.current = cargador

  useEffect(() => {
    let vivo = true
    setCargando(true)
    setError(null)
    Promise.resolve()
      .then(() => refCargador.current())
      .then((r) => { if (vivo) setDatos(r) })
      .catch((e) => { if (vivo) setError(e) })
      .finally(() => { if (vivo) setCargando(false) })
    return () => { vivo = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, ticket])

  const recargar = useCallback(() => setTicket((t) => t + 1), [])
  return { datos, cargando, error, recargar, setDatos }
}

/* ------------------------------------------------------------------
   Acciones (guardar, borrar, probar…). No lanza: devuelve el resultado
   para que la pantalla decida qué enseñar.
   const { ejecutar, ocupado, error } = useAccion(guardar)
   const r = await ejecutar(datos)  →  { ok:true, datos } | { ok:false, error }
   ------------------------------------------------------------------ */
export function useAccion(accion) {
  const [ocupado, setOcupado] = useState(false)
  const [error, setError] = useState(null)
  const refAccion = useRef(accion)
  refAccion.current = accion

  const ejecutar = useCallback(async (...args) => {
    setOcupado(true)
    setError(null)
    try {
      const datos = await refAccion.current(...args)
      return { ok: true, datos }
    } catch (e) {
      setError(e)
      return { ok: false, error: e }
    } finally {
      setOcupado(false)
    }
  }, [])

  return { ejecutar, ocupado, error, setError }
}

/* ------------------------------------------------------------------
   Copiar al portapapeles (datos del relay, tokens DNS, IDs).
   ------------------------------------------------------------------ */
export function useCopiar(msVisible = 1600) {
  const [copiado, setCopiado] = useState(false)
  const refTemporizador = useRef(null)

  useEffect(() => () => clearTimeout(refTemporizador.current), [])

  const copiar = useCallback(async (texto) => {
    const valor = String(texto ?? '')
    let ok = false
    try {
      await navigator.clipboard.writeText(valor)
      ok = true
    } catch {
      // navegadores sin permiso de portapapeles dentro del iframe: respaldo clásico
      try {
        const area = document.createElement('textarea')
        area.value = valor
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        ok = document.execCommand('copy')
        document.body.removeChild(area)
      } catch { ok = false }
    }
    if (ok) {
      setCopiado(true)
      clearTimeout(refTemporizador.current)
      refTemporizador.current = setTimeout(() => setCopiado(false), msVisible)
    }
    return ok
  }, [msVisible])

  return { copiar, copiado }
}

/* ------------------------------------------------------------------
   Utilidades varias
   ------------------------------------------------------------------ */

// Retrasa un valor: para los buscadores de las tablas de envíos.
export function useDebounce(valor, ms = 350) {
  const [retrasado, setRetrasado] = useState(valor)
  useEffect(() => {
    const t = setTimeout(() => setRetrasado(valor), ms)
    return () => clearTimeout(t)
  }, [valor, ms])
  return retrasado
}

// Repite una función cada `ms`. ms = null lo detiene.
export function useIntervalo(fn, ms) {
  const refFn = useRef(fn)
  refFn.current = fn
  useEffect(() => {
    if (ms === null || ms === undefined) return undefined
    const id = setInterval(() => refFn.current(), ms)
    return () => clearInterval(id)
  }, [ms])
}

// Anima un número desde su valor previo hasta `objetivo`. Respeta "reducir movimiento".
export function useCuenta(objetivo, duracion = 900) {
  const destino = Number(objetivo) || 0
  const [valor, setValor] = useState(sinMovimiento ? destino : 0)
  const refOrigen = useRef(sinMovimiento ? destino : 0)

  useEffect(() => {
    if (sinMovimiento) { setValor(destino); refOrigen.current = destino; return undefined }
    const origen = refOrigen.current
    let inicio = null
    let raf
    const suavizado = (t) => 1 - Math.pow(1 - t, 3)
    const paso = (ts) => {
      if (inicio === null) inicio = ts
      const p = Math.min(1, (ts - inicio) / duracion)
      setValor(origen + (destino - origen) * suavizado(p))
      if (p < 1) raf = requestAnimationFrame(paso)
      else refOrigen.current = destino
    }
    raf = requestAnimationFrame(paso)
    return () => cancelAnimationFrame(raf)
  }, [destino, duracion])

  return valor
}
