import { config as configGlobal } from '../config.js'
import { redis as redisGlobal } from '../redis.js'

// ---------------------------------------------------------------------------
// Suscripción en el Marketplace Disruptivo.
//
// Emails Disruptivo se vende POR SUSCRIPCIÓN desde el marketplace. Esta app no cobra nada: solo
// pregunta si la subcuenta tiene acceso y sirve o corta. La única fuente de verdad es
//
//   GET {MD_BASE_URL}/api/v1/access/{locationId}     Authorization: Bearer <MD_API_KEY>
//
//   200 {"access":true, "via":"app"|"plan", "plan"?, "status":"trial"|"active"|"comped",
//        "starts_at"?, "ends_at": ISO|null, "subscription_id"?, "credit": n}
//   200 {"access":false, "credit":0}          ← sin acceso; NO es un error
//   401 clave ausente o revocada · 403 subcuenta fuera del alcance de la clave · 429 límite
//   (600/min, cabecera X-RateLimit-Remaining) · 5xx caída
//
// Se lee por nombre de campo y se toleran campos nuevos. Solo decide `access`: el `status` no
// discrimina (trial, active y comped valen igual). Ninguna subcuenta va escrita en el código.
//
// Reglas de servicio (las de verdad importantes):
//   · Cache por subcuenta de MD_CACHE_SEG (300 s, tope): el admin del marketplace da y quita
//     accesos en caliente y tienen que notarse en 5 minutos como mucho.
//   · Si la llamada falla (red, timeout, 429, 5xx; y también 401/403, que son errores de
//     configuración y se registran como tales) se sigue con el ÚLTIMO RESULTADO BUENO aunque haya
//     vencido, hasta MD_GRACIA_HORAS (24 h) contadas desde el PRIMER fallo consecutivo (fallo_desde):
//     «24 h sin poder comprobar». Pasadas, se corta y se registra el motivo. NUNCA se corta por un
//     fallo reciente, ni siquiera a una subcuenta que llevaba días sin actividad: su último resultado
//     bueno (sea access:true o access:false) se conserva 30 días y es lo que se sirve durante la
//     gracia. Una subcuenta que nunca llegó a comprobarse recibe acceso provisional esa misma gracia.
//   · Sin MD_API_KEY no se corta a nadie (access:true, fuente «sin_clave»): un despliegue sin la
//     variable no puede dejar a los clientes sin servicio. config.js lo avisa en el arranque.
//   · La clave no se registra ni se devuelve jamás: los mensajes de error se filtran por si un
//     error de red la arrastrara (ocultarClave) y ninguna vista la incluye.
//
// El estado vive en Redis (una clave por subcuenta, retenida RETENCION_REGISTRO_S: la frescura la
// gobierna comprobado_en, no el TTL) con un respaldo en memoria del proceso para cuando Redis no
// responda. Las llamadas simultáneas de una misma subcuenta se funden en una sola petición
// (enVuelo): abrir el panel dispara varias a la vez. El listado de la agencia usa soloCache: lee lo
// guardado y no va a la red (N subcuentas no pueden ser N peticiones al marketplace).
// ---------------------------------------------------------------------------

/** Texto LITERAL que ve el usuario cuando no hay suscripción. Sin códigos ni detalles técnicos. */
export const MENSAJE_SIN_ACCESO =
  'Tu suscripción a Emails Disruptivo no está activa. Habla con el Departamento Disruptivo para reactivarla.'

const PREFIJO_CLAVE = 'md:acceso:'
const DIAS_AVISO_VENCIMIENTO = 7
// Tras un fallo no se vuelve a llamar al marketplace hasta pasado este margen: si está caído y GHL
// dispara mil correos de golpe, mil timeouts de 5 s dejarían los nodos sin responder.
const REINTENTO_TRAS_FALLO_MS = 30_000
const REINTENTO_MAXIMO_MS = 5 * 60_000
// Un mismo aviso en el log como mucho una vez por minuto y subcuenta
const SILENCIO_LOG_MS = 60_000
const AVISO_CUOTA_RESTANTE = 30
// El registro de una subcuenta se conserva mucho más que la gracia (y nunca menos del doble): si
// caducara a las 24 h, una subcuenta sin actividad perdería su último resultado bueno y un fallo
// del marketplace la dejaría en «provisional» en vez de servirle lo último que se supo de ella.
const RETENCION_REGISTRO_S = 30 * 86_400

const texto = (v) => (v === undefined || v === null ? '' : String(v)).trim()

function fechaIso(v) {
  if (v === null || v === undefined || v === '') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// `plan` puede llegar como nombre suelto o como objeto; se queda con algo legible o con nada
function nombrePlan(v) {
  if (typeof v === 'string' || typeof v === 'number') return texto(v) || null
  if (v && typeof v === 'object') return texto(v.name ?? v.nombre ?? v.slug ?? v.id) || null
  return null
}

/** Lee por nombre de campo la respuesta del marketplace. null si no trae un `access` booleano. */
export function normalizarRespuestaAcceso(cuerpo) {
  if (!cuerpo || typeof cuerpo !== 'object' || typeof cuerpo.access !== 'boolean') return null
  const credito = Number(cuerpo.credit)
  return {
    access: cuerpo.access,
    via: texto(cuerpo.via) || null,
    plan: nombrePlan(cuerpo.plan),
    status: texto(cuerpo.status) || null,
    starts_at: fechaIso(cuerpo.starts_at),
    ends_at: fechaIso(cuerpo.ends_at),
    subscription_id: texto(cuerpo.subscription_id) || null,
    credit: Number.isFinite(credito) ? credito : 0,
  }
}

const DATOS_VACIOS = {
  via: null, plan: null, status: null, starts_at: null, ends_at: null, subscription_id: null, credit: 0,
}

const formatoFecha = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid',
})

/**
 * «Tu plan vence el {fecha}» cuando ends_at existe y FALTAN menos de 7 días. null en cualquier otro
 * caso: sin caducidad, lejos todavía, sin acceso (ahí manda MENSAJE_SIN_ACCESO) o ends_at ya
 * pasado con access:true (comped o gracia del propio marketplace: no hay nada que avisar, el corte
 * depende solo de access).
 */
export function avisoVencimiento(acceso, ahora = Date.now()) {
  if (!acceso || acceso.access !== true || !acceso.ends_at) return null
  const fin = new Date(acceso.ends_at).getTime()
  if (!Number.isFinite(fin)) return null
  const faltan = fin - ahora
  if (faltan < 0 || faltan >= DIAS_AVISO_VENCIMIENTO * 86_400_000) return null
  return `Tu plan vence el ${formatoFecha.format(new Date(fin))}`
}

/** Lo que ve la SUBCUENTA en su sesión: sin motivos técnicos. */
export function resumenAcceso(acceso, ahora = Date.now()) {
  const activo = acceso?.access === true
  // access:null solo sale de soloCache sin registro (fuente sin_datos): no es un veredicto
  const conocido = typeof acceso?.access === 'boolean'
  return {
    activo,
    fuente: acceso?.fuente ?? null,
    mensaje: activo || !conocido ? null : MENSAJE_SIN_ACCESO,
    aviso: activo ? avisoVencimiento(acceso, ahora) : null,
    vence_el: acceso?.ends_at ?? null,
    plan: acceso?.plan ?? null,
    estado: acceso?.status ?? null,
    via: acceso?.via ?? null,
  }
}

/** Lo que ve la AGENCIA por subcuenta: añade el motivo del último fallo. Nunca la clave. */
export function resumenAccesoAdmin(acceso, ahora = Date.now()) {
  return {
    ...resumenAcceso(acceso, ahora),
    comprobado_en: acceso?.comprobado_en ?? null,
    motivo: acceso?.motivo ?? null,
    credito: Number.isFinite(Number(acceso?.credit)) ? Number(acceso.credit) : 0,
  }
}

function logConsola() {
  const emitir = (nivel) => (datos, mensaje) => {
    if (typeof datos === 'string') console[nivel]('[marketplace]', datos)
    else console[nivel]('[marketplace]', mensaje ?? '', datos ?? '')
  }
  return { info: emitir('info'), warn: emitir('warn'), error: emitir('error') }
}

/**
 * Construye un cliente con sus dependencias inyectables (las pruebas pasan un Redis simulado, un
 * fetch propio y un reloj controlado). La app usa el que se exporta abajo con las reales.
 */
export function crearClienteMarketplace({
  config: cfg = configGlobal.marketplace,
  redis = redisGlobal,
  fetch: pedir = globalThis.fetch,
  log: logDefecto = logConsola(),
  ahora = () => Date.now(),
} = {}) {
  const memoria = new Map()
  const enVuelo = new Map()
  const ultimoAviso = new Map()

  const cacheMs = () => cfg.cacheSeg * 1000
  const graciaMs = () => cfg.graciaHoras * 3_600_000
  const clave = (locationId) => `${PREFIJO_CLAVE}${locationId}`

  // por si un error de red arrastrara la cabecera: la clave no sale jamás en un mensaje
  const ocultarClave = (mensaje) => {
    const s = texto(mensaje)
    return cfg.apiKey ? s.split(cfg.apiKey).join('[clave oculta]') : s
  }

  function registrar(log, nivel, etiqueta, datos, mensaje) {
    const l = log && typeof log[nivel] === 'function' ? log : logDefecto
    const marca = `${nivel}:${etiqueta}:${datos?.locationId ?? ''}`
    const t = ahora()
    if (t - (ultimoAviso.get(marca) ?? -Infinity) < SILENCIO_LOG_MS) return
    ultimoAviso.set(marca, t)
    try {
      l[nivel]({ ...datos, motivo: datos?.motivo ? ocultarClave(datos.motivo) : undefined }, ocultarClave(mensaje))
    } catch {
      /* el log nunca puede tumbar la comprobación */
    }
  }

  // --- almacenamiento ---------------------------------------------------------

  function registroValido(r) {
    return (
      r && typeof r === 'object' && typeof r.access === 'boolean' &&
      (r.comprobado_en === null || Number.isFinite(r.comprobado_en))
    )
  }

  async function leerGuardado(locationId, log) {
    try {
      const bruto = await redis.get(clave(locationId))
      if (bruto) {
        const r = JSON.parse(bruto)
        if (registroValido(r)) {
          memoria.set(locationId, r)
          return r
        }
      } else {
        // Redis responde y no tiene nada: lo de memoria es más viejo que su TTL, no vale
        memoria.delete(locationId)
        return null
      }
    } catch (err) {
      registrar(log, 'warn', 'redis', { locationId, motivo: err?.message }, 'marketplace: Redis no responde; se usa el respaldo en memoria')
    }
    return memoria.get(locationId) ?? null
  }

  async function guardar(locationId, registro, log) {
    memoria.set(locationId, registro)
    try {
      const retencionS = Math.max(RETENCION_REGISTRO_S, 2 * cfg.graciaHoras * 3600)
      await redis.set(clave(locationId), JSON.stringify(registro), 'EX', retencionS)
    } catch (err) {
      registrar(log, 'warn', 'redis', { locationId, motivo: err?.message }, 'marketplace: no se pudo guardar el acceso en Redis; queda en memoria')
    }
  }

  // --- la llamada ---------------------------------------------------------------

  function retryAfterMs(res) {
    const s = Number(texto(res?.headers?.get?.('retry-after')))
    if (!Number.isFinite(s) || s <= 0) return REINTENTO_TRAS_FALLO_MS
    return Math.min(REINTENTO_MAXIMO_MS, Math.max(REINTENTO_TRAS_FALLO_MS, s * 1000))
  }

  /** { ok:true, datos, cuota } | { ok:false, motivo, configuracion, status, reintentoMs } */
  async function llamarApi(locationId) {
    const controlador = new AbortController()
    const temporizador = setTimeout(() => controlador.abort(), cfg.timeoutMs)
    const fallo = (motivo, extra = {}) => ({
      ok: false, motivo, configuracion: false, status: null, reintentoMs: REINTENTO_TRAS_FALLO_MS, ...extra,
    })
    try {
      const res = await pedir(`${cfg.baseUrl}/api/v1/access/${encodeURIComponent(locationId)}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
        signal: controlador.signal,
        // una redirección reenviaría la cabecera a otro sitio: se trata como fallo
        redirect: 'manual',
      })
      const status = Number(res.status)
      const cuota = Number(texto(res.headers?.get?.('x-ratelimit-remaining')))

      if (status === 200) {
        let cuerpo
        try {
          cuerpo = await res.json()
        } catch {
          return fallo('el marketplace devolvió una respuesta ilegible (200 sin JSON)', { status })
        }
        const datos = normalizarRespuestaAcceso(cuerpo)
        if (!datos) return fallo('el marketplace devolvió un 200 sin el campo access', { status })
        return { ok: true, datos, cuota: Number.isFinite(cuota) ? cuota : null }
      }
      if (status === 401) {
        return fallo('la clave de la API del marketplace (MD_API_KEY) falta o está revocada (401)', { status, configuracion: true })
      }
      if (status === 403) {
        return fallo('la subcuenta está fuera del alcance de la clave de la API del marketplace (403)', { status, configuracion: true })
      }
      if (status === 429) {
        return fallo('límite de peticiones del marketplace alcanzado (429)', { status, reintentoMs: retryAfterMs(res) })
      }
      if (status >= 500) return fallo(`el marketplace no está disponible (HTTP ${status})`, { status })
      if (status >= 300 && status < 400) return fallo(`el marketplace respondió con una redirección inesperada (HTTP ${status})`, { status })
      return fallo(`respuesta inesperada del marketplace (HTTP ${status})`, { status })
    } catch (err) {
      if (err?.name === 'AbortError' || controlador.signal.aborted) {
        return fallo(`el marketplace no respondió en ${cfg.timeoutMs} ms`)
      }
      const detalle = texto(err?.cause?.code) || texto(err?.code) || texto(err?.message) || 'error desconocido'
      return fallo(`fallo de red con el marketplace: ${ocultarClave(detalle)}`)
    } finally {
      clearTimeout(temporizador)
    }
  }

  // --- presentación --------------------------------------------------------------

  const presentar = (registro, fuente, motivo = null) => ({
    access: typeof registro.access === 'boolean' ? registro.access : null,
    via: registro.via ?? null,
    plan: registro.plan ?? null,
    status: registro.status ?? null,
    starts_at: registro.starts_at ?? null,
    ends_at: registro.ends_at ?? null,
    subscription_id: registro.subscription_id ?? null,
    credit: Number.isFinite(Number(registro.credit)) ? Number(registro.credit) : 0,
    fuente,
    comprobado_en: Number.isFinite(registro.comprobado_en) ? new Date(registro.comprobado_en).toISOString() : null,
    motivo,
  })

  /**
   * Sin poder preguntar: último resultado bueno mientras dure la gracia; pasada, corte.
   * La gracia se cuenta desde el PRIMER fallo consecutivo (fallo_desde, que cada éxito pone a
   * null): son «24 h sin poder comprobar», no 24 h desde la última comprobación. Contarla desde
   * comprobado_en cortaría en el acto a una subcuenta sin actividad desde hace días por un fallo
   * de red de hace un segundo, que es justo lo que prohíbe el encargo.
   */
  function resolverSinApi(locationId, guardado, motivo, log) {
    const t = ahora()
    const referencia = guardado.fallo_desde ?? t
    if (t - referencia < graciaMs()) {
      return presentar(guardado, guardado.provisional ? 'provisional' : 'gracia', motivo)
    }
    const horas = Math.round((t - referencia) / 3_600_000)
    registrar(log, 'error', 'corte', { locationId, motivo, horas_sin_comprobar: horas },
      `marketplace: ${horas} h sin poder comprobar la suscripción (gracia de ${cfg.graciaHoras} h agotada): se corta el acceso`)
    return presentar({ ...guardado, access: false }, 'sin_comprobar', motivo)
  }

  async function consultar(locationId, guardado, log) {
    const t = ahora()
    const resultado = await llamarApi(locationId)

    if (resultado.ok) {
      const registro = {
        ...resultado.datos,
        comprobado_en: t,
        intentado_en: t,
        reintentar_en: null,
        fallo_desde: null,
        provisional: false,
        ultimo_motivo: null,
      }
      await guardar(locationId, registro, log)
      if (resultado.cuota !== null && resultado.cuota < AVISO_CUOTA_RESTANTE) {
        registrar(log, 'warn', 'cuota', { locationId, restante: resultado.cuota },
          'marketplace: quedan pocas peticiones en el minuto (X-RateLimit-Remaining)')
      }
      return presentar(registro, 'api')
    }

    // Fallo. Se anota el intento para no insistir durante REINTENTO_TRAS_FALLO_MS y se conserva
    // TODO lo demás del registro (el último resultado bueno es justo lo que hay que proteger).
    const base = guardado ?? { ...DATOS_VACIOS, access: true, comprobado_en: null, provisional: true }
    const registro = {
      ...base,
      intentado_en: t,
      reintentar_en: t + resultado.reintentoMs,
      fallo_desde: base.fallo_desde ?? t,
      ultimo_motivo: resultado.motivo,
    }
    await guardar(locationId, registro, log)

    const datos = { locationId, motivo: resultado.motivo, http: resultado.status ?? undefined }
    if (resultado.configuracion) {
      registrar(log, 'error', 'configuracion', datos,
        'marketplace: error de configuración al comprobar la suscripción; se mantiene el último resultado conocido')
    } else {
      registrar(log, 'warn', 'fallo', datos,
        guardado
          ? 'marketplace: no se pudo comprobar la suscripción; se mantiene el último resultado conocido'
          : 'marketplace: no se pudo comprobar la suscripción de una subcuenta nunca comprobada; acceso provisional')
    }
    return resolverSinApi(locationId, registro, resultado.motivo, log)
  }

  /**
   * ¿Tiene acceso esta subcuenta? Devuelve siempre un objeto y nunca lanza:
   *   { access, via, plan, status, starts_at, ends_at, subscription_id, credit,
   *     fuente: 'api'|'cache'|'gracia'|'provisional'|'sin_comprobar'|'sin_clave'|'sin_subcuenta'|'error_interno'
   *             |'sin_datos',
   *     comprobado_en: ISO|null, motivo: string|null }
   *
   * `soloCache: true` (listados): responde con lo guardado en Redis/memoria y NO va a la red. Si no
   * hay registro devuelve access:null con fuente 'sin_datos' («sin datos», no «sin acceso»). Es solo
   * para pintar: un corte se decide siempre con la llamada normal.
   */
  async function tieneAcceso(locationId, { log, soloCache = false } = {}) {
    if (!cfg.configurado) {
      return presentar({ ...DATOS_VACIOS, access: true, comprobado_en: null }, 'sin_clave')
    }
    const id = texto(locationId)
    if (!id) {
      return presentar({ ...DATOS_VACIOS, access: false, comprobado_en: null }, 'sin_subcuenta', 'la petición no trae subcuenta')
    }
    try {
      const guardado = await leerGuardado(id, log)
      const t = ahora()
      if (guardado && guardado.comprobado_en !== null && t - guardado.comprobado_en < cacheMs()) {
        return presentar(guardado, 'cache')
      }
      if (guardado && Number.isFinite(guardado.reintentar_en) && t < guardado.reintentar_en) {
        return resolverSinApi(id, guardado, guardado.ultimo_motivo ?? 'fallo reciente al comprobar', log)
      }
      if (soloCache) {
        if (!guardado) {
          return presentar({ ...DATOS_VACIOS, access: null, comprobado_en: null }, 'sin_datos', 'todavía no se ha comprobado esta subcuenta')
        }
        // con un fallo pendiente se enseña el mismo estado (gracia o corte) que vería la subcuenta;
        // si lo último fue un éxito, el último resultado bueno tal cual, con su comprobado_en
        return guardado.fallo_desde !== null && guardado.fallo_desde !== undefined
          ? resolverSinApi(id, guardado, guardado.ultimo_motivo ?? 'fallo reciente al comprobar', log)
          : presentar(guardado, 'cache')
      }
      if (enVuelo.has(id)) return await enVuelo.get(id)
      const promesa = consultar(id, guardado, log).finally(() => enVuelo.delete(id))
      enVuelo.set(id, promesa)
      return await promesa
    } catch (err) {
      // Un fallo interno (bug, JSON corrupto…) no puede dejar a un cliente sin servicio
      registrar(log, 'error', 'interno', { locationId: id, motivo: err?.message }, 'marketplace: fallo interno comprobando la suscripción; no se corta')
      return presentar({ ...DATOS_VACIOS, access: true, comprobado_en: null }, 'error_interno', ocultarClave(err?.message))
    }
  }

  /** Olvida lo guardado de una subcuenta: la siguiente comprobación va al marketplace. */
  async function invalidarAcceso(locationId) {
    const id = texto(locationId)
    if (!id) return
    memoria.delete(id)
    try {
      await redis.del(clave(id))
    } catch {
      /* sin Redis basta con el respaldo en memoria */
    }
  }

  /** Estado de la integración para el panel de la agencia. Sin la clave. */
  function estadoMarketplace() {
    return {
      configurado: Boolean(cfg.configurado),
      base_url: cfg.baseUrl,
      cache_seg: cfg.cacheSeg,
      gracia_horas: cfg.graciaHoras,
      timeout_ms: cfg.timeoutMs,
    }
  }

  return { tieneAcceso, invalidarAcceso, estadoMarketplace }
}

const cliente = crearClienteMarketplace()

export const tieneAcceso = cliente.tieneAcceso
export const invalidarAcceso = cliente.invalidarAcceso
export const estadoMarketplace = cliente.estadoMarketplace
