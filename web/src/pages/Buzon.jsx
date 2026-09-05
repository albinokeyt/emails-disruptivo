import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Download,
  Forward,
  HardDrive,
  Image,
  Inbox,
  Mail,
  MailOpen,
  Paperclip,
  Plus,
  RefreshCw,
  Reply,
  ReplyAll,
  Search,
  Send,
  Settings,
  Trash2,
} from 'lucide-react'
import {
  actualizarCuentaBuzon,
  crearCuentaBuzon,
  eliminarCuentaBuzon,
  eliminarMensajeBuzon,
  emitir,
  fmtBytes,
  fmtFechaHora,
  listarCuentasBuzon,
  listarMensajesBuzon,
  listarRemitentes,
  marcarMensajeBuzon,
  obtenerEspacioBuzon,
  obtenerMensajeBuzon,
  probarCuentaBuzon,
  reenviarMensajeBuzon,
  responderMensajeBuzon,
  sincronizarCuentaBuzon,
  urlAdjuntoBuzon,
} from '../api.js'
import {
  Aviso,
  Badge,
  Boton,
  Campo,
  Confirmar,
  Interruptor,
  Modal,
  Select,
  Spinner,
  Tabla,
  Textarea,
} from '../components/ui.jsx'
import { useDebounce, useIntervalo } from '../hooks.js'
import { Detalle as DetalleEnvio } from './Envios.jsx'

/* ============================================================
   Buzón (SPEC §14.4): tres columnas tipo Gmail — cuentas y carpetas · lista · detalle con hilo.
   El correo lo trae el backend por IMAP; aquí solo se lee, se responde y se borra.
   ============================================================ */

const COLUMNA = 'bg-card border border-border rounded-2xl flex flex-col min-h-0 overflow-hidden'
const PAGINA = 25
const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const HOST = /^[a-z0-9.-]+\.[a-z]{2,}$/i

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])
const numeroONull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
// Los ids son bigserial y llegan como cadena desde la API: se comparan siempre como texto.
const mismoId = (a, b) => a != null && b != null && String(a) === String(b)

const CARPETAS = [
  { clave: 'bandeja', etiqueta: 'Bandeja de entrada', icono: Inbox },
  { clave: 'no_leidos', etiqueta: 'No leídos', icono: Mail },
  { clave: 'enviados', etiqueta: 'Enviados desde el buzón', icono: Send },
]

// Estado de una cuenta IMAP (mailboxes.status). `cuota_llena` no existe en el Badge común: se
// pinta con la clase de «pendiente» (ámbar), que es lo que significa: parada hasta liberar espacio.
const ESTADO_CUENTA = {
  ok: { estado: 'ok', texto: 'Correcta', punto: 'bg-ok' },
  error: { estado: 'error', texto: 'Error', punto: 'bg-bad' },
  sin_probar: { estado: 'sin_probar', texto: 'Sin probar', punto: 'bg-mut' },
  cuota_llena: { estado: 'pendiente', texto: 'Cuota llena', punto: 'bg-warn' },
}

const estadoCuenta = (c) =>
  c?.enabled === false ? { estado: 'inactivo', texto: 'Desactivada', punto: 'bg-border' } : ESTADO_CUENTA[c?.status] || ESTADO_CUENTA.sin_probar

/* ------------------------------------------------------------
   Personas y fechas
   ------------------------------------------------------------ */

// Acepta {email,name}, {address,name}, "Nombre <correo>" o "correo" y devuelve {email, name}.
function persona(v) {
  if (!v) return null
  if (typeof v === 'object') {
    const email = String(v.email || v.address || '').trim()
    const name = String(v.name || '').trim()
    return email || name ? { email, name } : null
  }
  const s = String(v).trim()
  if (!s) return null
  const m = s.match(/^"?([^"<]*?)"?\s*<([^>]+)>$/)
  return m ? { email: m[2].trim(), name: m[1].trim() } : { email: s, name: '' }
}

const remitenteDe = (m) => persona(m?.from) || persona({ email: m?.from_email, name: m?.from_name }) || { email: '', name: '' }

// recipients (jsonb) = [{tipo:'to'|'cc', email, name}]; se admite también `to`/`cc` sueltos.
function destinatariosDe(m, tipo) {
  const r = m?.recipients
  if (Array.isArray(r)) {
    return r.filter((x) => String(x?.tipo || x?.type || 'to').toLowerCase() === tipo).map(persona).filter(Boolean)
  }
  const directo = m?.[tipo]
  if (Array.isArray(directo)) return directo.map(persona).filter(Boolean)
  if (typeof directo === 'string') return directo.split(',').map(persona).filter(Boolean)
  return []
}

const etiquetaPersona = (p) => (p.name && p.email ? `${p.name} <${p.email}>` : p.name || p.email || '—')
const nombreCorto = (p) => p.name || p.email || '—'

// Como Gmail: hora si es de hoy, «12 mar» si es de este año y «12/03/24» si no.
function fechaLista(v) {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const hoy = new Date()
  if (d.toDateString() === hoy.toDateString()) return d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
  if (d.getFullYear() === hoy.getFullYear()) return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' })
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: '2-digit' })
}

const fechaLarga = (v) =>
  v
    ? new Date(v).toLocaleString('es-ES', {
        weekday: 'short', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—'

const sinPrefijo = (s) => String(s || '').replace(/^\s*((re|fwd?|rv|tr|aw|wg)\s*:\s*)+/i, '').trim()

const separarCorreos = (s) => String(s || '').split(/[,;\n]/).map((x) => x.trim().toLowerCase()).filter(Boolean)

/* ------------------------------------------------------------
   HTML del correo: texto → HTML del composer y bloqueo de imágenes remotas del visor
   ------------------------------------------------------------ */

const escapar = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const enlazar = (s) => s.replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)"'])/g, '<a href="$1">$1</a>')

// El composer escribe texto plano: párrafos separados por línea en blanco, saltos simples = <br>.
function textoAHtml(texto) {
  return String(texto)
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em">${enlazar(escapar(p)).replace(/\n/g, '<br>')}</p>`)
    .join('')
}

// Las imágenes remotas delatan la apertura y pueden rastrear: se bloquean hasta que el usuario
// pulse «Cargar imágenes». El backend puede guardarlas ya como data-src; aquí se cubren las dos
// formas. Las imágenes embebidas (data:) no se tocan. Defensa en profundidad del saneado del
// servidor: dentro de los style="…" también se anulan las demás funciones de imagen de CSS
// (image-set(), image(), src(), cross-fade(), paint(), element()), que cargarían un píxel de
// seguimiento en un background sin pasar por src ni url(); con el nombre alterado la declaración
// deja de ser válida y el navegador la ignora.
const RE_SRC_REMOTO = /(\s)src(\s*=\s*)(["']?)((?:https?:)?\/\/)/gi
const RE_FUNCION_IMAGEN_CSS = /(?:-webkit-|-moz-)?(?:image-set|image|src|cross-fade|paint|element)\s*\(/gi

function bloquearImagenes(html) {
  return String(html)
    .replace(/<img\b[^>]*>/gi, (tag) => tag.replace(RE_SRC_REMOTO, '$1data-src$2$3$4'))
    .replace(/(\s)background(\s*=\s*)(["']?)((?:https?:)?\/\/)/gi, '$1data-background$2$3$4')
    .replace(/url\(\s*(["']?)\s*(?:https?:)?\/\//gi, 'url($1about:blank#')
    .replace(/\sstyle\s*=\s*(?:"[^"]*"|'[^']*')/gi, (attr) => attr.replace(RE_FUNCION_IMAGEN_CSS, (f) => `sin-${f}`))
}

function activarImagenes(html) {
  return String(html).replace(/(\s)data-src(\s*=)/gi, '$1src$2').replace(/(\s)data-background(\s*=)/gi, '$1background$2')
}

const tieneImagenesRemotas = (html) =>
  /<img\b[^>]*\s(?:data-)?src\s*=\s*["']?(?:https?:)?\/\//i.test(html) || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(html)

const ESTILO_CORREO =
  'body{margin:16px;font:14px/1.55 -apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;background:#fff;overflow-wrap:anywhere}' +
  'img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}table{max-width:100%}' +
  'blockquote{border-left:3px solid #d1d5db;margin:8px 0;padding-left:12px;color:#4b5563}a{color:#1d4ed8}'

// Documento completo para el <iframe sandbox>: sin scripts, formularios ni navegación del panel.
// Los enlaces abren SIEMPRE fuera (base target=_blank; el saneado ya pone target y rel=noopener en
// los <a> del correo), por eso el iframe lleva allow-popups + allow-popups-to-escape-sandbox: sin
// ellos el navegador bloquea la apertura y los enlaces del correo no funcionan.
const SANDBOX_CORREO = 'allow-popups allow-popups-to-escape-sandbox'

function documentoCorreo(html, conImagenes) {
  const cuerpo = conImagenes ? activarImagenes(html) : bloquearImagenes(html)
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><base target="_blank"><style>${ESTILO_CORREO}</style></head><body>${cuerpo}</body></html>`
}

const documentoTexto = (texto) => documentoCorreo(`<pre>${enlazar(escapar(texto || ''))}</pre>`, true)

/* ------------------------------------------------------------
   Hilo: mezcla de recibidos (inbox_messages) y enviados (messages con el mismo thread_key)
   ------------------------------------------------------------ */

const esEnviado = (h) =>
  h?.tipo === 'enviado' ||
  h?.direccion === 'enviado' ||
  h?.origen === 'enviado' ||
  (h?.status != null && h?.to_email != null && h?.uid == null)

const fechaDe = (h) => h?.date || h?.sent_at || h?.created_at || null

function normalizarDetalle(d) {
  const mensaje = d?.mensaje && typeof d.mensaje === 'object' ? d.mensaje : d && typeof d === 'object' ? d : {}
  const adjuntos = lista(d?.adjuntos ?? mensaje.adjuntos, 'adjuntos')
  const hilo = lista(d?.hilo ?? mensaje.hilo, 'hilo')
    .slice()
    .sort((a, b) => new Date(fechaDe(a) || 0) - new Date(fechaDe(b) || 0))
  return { mensaje, adjuntos, hilo }
}

/* ------------------------------------------------------------
   Barra de espacio «X de Y MB»
   ------------------------------------------------------------ */

const colorCuota = (pct) => (pct >= 90 ? 'bg-bad' : pct >= 70 ? 'bg-warn' : 'bg-gold')

function porcentajeDe(espacio) {
  const dado = numeroONull(espacio?.porcentaje)
  if (dado !== null) return Math.max(0, dado)
  const usado = numeroONull(espacio?.usado_bytes) || 0
  const cuota = numeroONull(espacio?.cuota_mb)
  return cuota ? (usado / (cuota * 1024 * 1024)) * 100 : 0
}

function BarraEspacio({ espacio, compacta = false }) {
  if (!espacio) return null
  const pct = porcentajeDe(espacio)
  const usado = fmtBytes(numeroONull(espacio.usado_bytes) || 0)
  const cuota = numeroONull(espacio.cuota_mb)
  const texto = cuota ? `${usado} de ${cuota} MB` : usado
  return (
    <div className={compacta ? 'w-44' : ''} title={`Espacio del buzón: ${texto} (${Math.round(pct)} %)`}>
      <div className="flex items-center justify-between gap-2 text-[11px] text-mut mb-1">
        <span className="inline-flex items-center gap-1">
          <HardDrive size={11} /> {compacta ? texto : 'Espacio'}
        </span>
        {!compacta && <span className="tabular-nums">{texto}</span>}
      </div>
      <div className="h-1.5 rounded-full bg-border overflow-hidden">
        <div className={`h-full rounded-full transition-all ${colorCuota(pct)}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  )
}

/* ============================================================
   Pantalla
   ============================================================ */
export default function Buzon() {
  const navigate = useNavigate()
  const { id: idParam } = useParams()
  const seleccion = idParam && /^\d+$/.test(idParam) ? idParam : null

  const [cuentas, setCuentas] = useState(null)
  const [remitentes, setRemitentes] = useState([])
  const [espacio, setEspacio] = useState(null)
  const [error, setError] = useState('')
  const [aviso, setAviso] = useState(null) // { tipo, texto }

  const [carpeta, setCarpeta] = useState('bandeja')
  const [cuentaId, setCuentaId] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const q = useDebounce(busqueda.trim(), 350)

  const [filas, setFilas] = useState(null)
  const [total, setTotal] = useState(null)
  const [pagina, setPagina] = useState(1)
  const filasRef = useRef(null)
  filasRef.current = filas

  const [composer, setComposer] = useState(null) // { modo, mensaje }
  const [aBorrar, setABorrar] = useState(null) // mensaje
  const [borrarServidor, setBorrarServidor] = useState(false)
  const [borrando, setBorrando] = useState(false)
  const [ajustes, setAjustes] = useState(false)
  const [sincronizando, setSincronizando] = useState(false)
  const [detalleEnvio, setDetalleEnvio] = useState(null)
  const [versionDetalle, setVersionDetalle] = useState(0)

  const cargarCuentas = useCallback(async () => {
    const d = await listarCuentasBuzon()
    setCuentas(lista(d, 'cuentas'))
  }, [])

  const cargarEspacio = useCallback(async () => {
    try {
      const d = await obtenerEspacioBuzon()
      setEspacio(d && typeof d === 'object' ? d : {})
    } catch {
      setEspacio(null)
    }
  }, [])

  useEffect(() => {
    cargarCuentas().catch((e) => {
      setError(e.message)
      setCuentas([])
    })
    cargarEspacio()
    listarRemitentes()
      .then((d) => setRemitentes(lista(d, 'remitentes')))
      .catch(() => setRemitentes([]))
  }, [cargarCuentas, cargarEspacio])

  // La lista depende de carpeta, cuenta y búsqueda; `silencioso` refresca sin vaciar la pantalla.
  const cargarLista = useCallback(
    async (pag, silencioso = false) => {
      if (!silencioso) setFilas(null)
      try {
        // «Enviados desde el buzón» son filas de `messages` con origin 'buzon': el mismo endpoint las
        // sirve con carpeta=enviados (respeta el filtro de cuenta y busca por destinatario/asunto)
        const d = await listarMensajesBuzon({
          carpeta: carpeta === 'enviados' ? 'enviados' : undefined,
          no_leidos: carpeta === 'no_leidos' ? 1 : undefined,
          cuenta: cuentaId || undefined,
          q,
          limite: PAGINA,
          pagina: pag,
        })
        setFilas(lista(d, 'mensajes'))
        setTotal(numeroONull(d?.total))
        setPagina(pag)
        setError('')
        // la respuesta trae el total de no leídos de la subcuenta: el menú se actualiza sin otra llamada
        const noLeidos = numeroONull(d?.no_leidos)
        if (noLeidos !== null) emitir('buzon:cambio', { no_leidos: noLeidos })
      } catch (e) {
        setError(e.message)
        setFilas([])
        setTotal(null)
      }
    },
    [carpeta, cuentaId, q],
  )

  useEffect(() => {
    cargarLista(1)
  }, [cargarLista])

  // refresco suave cada minuto en la primera página, salvo mientras se escribe o se configura
  useIntervalo(() => {
    if (pagina === 1 && !composer && !ajustes && !aBorrar) {
      cargarLista(1, true)
      cargarEspacio()
    }
  }, 60_000)

  const abrir = (id) => navigate(`/buzon/${id}`)
  const cerrarDetalle = () => navigate('/buzon')

  // Al abrir un mensaje el backend lo marca como leído: se refleja en la lista y en el menú.
  const alCargarDetalle = useCallback((m) => {
    const fila = filasRef.current?.find((f) => mismoId(f.id, m.id))
    if (fila && !fila.is_read) {
      setFilas((fs) => (fs ? fs.map((f) => (mismoId(f.id, m.id) ? { ...f, is_read: true } : f)) : fs))
      emitir('buzon:cambio')
    }
  }, [])

  const marcarNoLeido = async (m) => {
    try {
      await marcarMensajeBuzon(m.id, false)
      setFilas((fs) => (fs ? fs.map((f) => (mismoId(f.id, m.id) ? { ...f, is_read: false } : f)) : fs))
      emitir('buzon:cambio')
      cerrarDetalle()
    } catch (e) {
      setAviso({ tipo: 'error', texto: e.message })
    }
  }

  const borrar = async () => {
    const m = aBorrar
    setBorrando(true)
    try {
      await eliminarMensajeBuzon(m.id, borrarServidor)
      setABorrar(null)
      setBorrarServidor(false)
      if (mismoId(seleccion, m.id)) cerrarDetalle()
      setAviso({ tipo: 'ok', texto: borrarServidor ? 'Mensaje borrado aquí y en el servidor de correo.' : 'Mensaje borrado.' })
      const restantes = (filasRef.current?.length || 1) - 1
      await Promise.all([cargarLista(restantes === 0 && pagina > 1 ? pagina - 1 : pagina, true), cargarEspacio()])
      emitir('buzon:cambio')
    } catch (e) {
      setAviso({ tipo: 'error', texto: e.message })
    } finally {
      setBorrando(false)
    }
  }

  const sincronizar = async () => {
    if (!cuentas?.length) return
    setSincronizando(true)
    setAviso(null)
    const objetivo = cuentaId ? cuentas.filter((c) => String(c.id) === cuentaId) : cuentas.filter((c) => c.enabled !== false)
    let nuevos = 0
    const fallos = []
    // cuentas cuya pasada sigue en el servidor (el IMAP tardó más de lo que espera la petición)
    const enCurso = []
    for (const c of objetivo) {
      try {
        const r = await sincronizarCuentaBuzon(c.id)
        if (r?.ok === false) fallos.push(`${c.name || c.email}: ${r.detalle || 'no se ha podido sincronizar'}`)
        else if (r?.en_curso) enCurso.push(c.name || c.email)
        else nuevos += Number(r?.nuevos) || 0
      } catch (e) {
        fallos.push(`${c.name || c.email}: ${e.message}`)
      }
    }
    setSincronizando(false)
    if (fallos.length) setAviso({ tipo: 'error', texto: fallos.join(' · ') })
    else if (objetivo.length === 0) setAviso({ tipo: 'aviso', texto: 'No hay ninguna cuenta activa que sincronizar.' })
    else if (enCurso.length) {
      setAviso({
        tipo: 'aviso',
        texto: `${enCurso.join(', ')}: el servidor de correo está tardando y la sincronización sigue en segundo plano. Vuelve a cargar la bandeja en un momento.`,
      })
    } else setAviso({ tipo: 'ok', texto: nuevos === 1 ? 'Ha entrado 1 correo nuevo.' : `Han entrado ${nuevos} correos nuevos.` })
    await Promise.all([cargarLista(1, true), cargarEspacio(), cargarCuentas().catch(() => {})])
    emitir('buzon:cambio')
  }

  const alEnviado = () => {
    setComposer(null)
    setAviso({ tipo: 'ok', texto: 'Respuesta encolada: la verás en el hilo con su estado de entrega, y en Envíos como el resto.' })
    setVersionDetalle((v) => v + 1)
    cargarLista(pagina, true)
  }

  const alCambiarCuentas = async () => {
    await Promise.all([cargarCuentas().catch((e) => setError(e.message)), cargarEspacio()])
    cargarLista(1, true)
    emitir('buzon:cambio')
  }

  const porCuenta = useMemo(() => new Map((cuentas || []).map((c) => [String(c.id), c])), [cuentas])
  const cuentaActiva = cuentaId ? porCuenta.get(cuentaId) : null
  const cuotaLlena =
    espacio?.cuota_llena === true || porcentajeDe(espacio) >= 100 || (cuentas || []).some((c) => c.status === 'cuota_llena')

  if (cuentas === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner texto="Abriendo el buzón…" />
      </div>
    )
  }

  const sinCuentas = cuentas.length === 0

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Buzón</h1>
          <p className="text-sm text-ink2 mt-1">
            El correo que entra en tus cuentas, traído por IMAP. Responde desde aquí con tus remitentes de siempre.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <BarraEspacio espacio={espacio} compacta />
          <Boton variant="ghost" icono={RefreshCw} onClick={sincronizar} cargando={sincronizando} disabled={sinCuentas}>
            {cuentaActiva ? 'Sincronizar esta cuenta' : 'Sincronizar'}
          </Boton>
          <Boton variant="ghost" icono={Settings} onClick={() => setAjustes(true)} title="Cuentas de correo" aria-label="Cuentas de correo">
            Cuentas
          </Boton>
        </div>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}
      {aviso && (
        <Aviso variant={aviso.tipo} onCerrar={() => setAviso(null)}>
          {aviso.texto}
        </Aviso>
      )}
      {cuotaLlena && (
        <Aviso variant="error" titulo="El buzón está lleno">
          Has llegado a la cuota de espacio
          {espacio?.cuota_mb ? ` (${fmtBytes(espacio.usado_bytes)} de ${espacio.cuota_mb} MB)` : ''}: la sincronización se ha
          parado y no entra correo nuevo. Borra mensajes —los adjuntos son lo que más pesa— y volverá a arrancar sola. Si
          necesitas más espacio, pídeselo a tu agencia.
        </Aviso>
      )}

      {sinCuentas ? (
        <div className={`${COLUMNA} p-8 items-center text-center`}>
          <span className="w-12 h-12 rounded-2xl bg-gold/15 border border-gold/30 grid place-items-center mb-4">
            <Inbox size={22} className="text-gold" />
          </span>
          <div className="text-sm font-semibold">Todavía no hay ninguna cuenta de correo conectada</div>
          <p className="text-sm text-ink2 mt-2 max-w-md">
            Conecta una cuenta por IMAP (Gmail, Outlook, tu dominio…) y el correo que reciba aparecerá aquí, en hilos, para
            leerlo y responderlo sin salir de GHL.
          </p>
          <Boton className="mt-5" icono={Plus} onClick={() => setAjustes(true)}>
            Conectar una cuenta
          </Boton>
        </div>
      ) : (
        <>
          {/* por debajo de xl (el iframe de GHL quita anchura) las carpetas y cuentas van en dos
              desplegables; en pantallas anchas, en la primera columna */}
          {!seleccion && (
            <div className="grid grid-cols-2 gap-3 xl:hidden">
              <Select value={carpeta} onChange={(e) => setCarpeta(e.target.value)} aria-label="Carpeta">
                {CARPETAS.map((c) => (
                  <option key={c.clave} value={c.clave}>
                    {c.etiqueta}
                  </option>
                ))}
              </Select>
              <Select value={cuentaId} onChange={(e) => setCuentaId(e.target.value)} aria-label="Cuenta">
                <option value="">Todas las cuentas</option>
                {cuentas.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name || c.email}
                  </option>
                ))}
              </Select>
            </div>
          )}

          <div className="lg:grid lg:grid-cols-[minmax(280px,340px)_1fr] xl:grid-cols-[210px_minmax(280px,340px)_1fr] lg:gap-4 lg:h-[calc(100vh-11rem)] lg:min-h-[540px]">
            {/* Columna 1 · cuentas y carpetas */}
            <aside className={`${COLUMNA} hidden xl:flex`}>
              <div className="p-3 space-y-0.5">
                {CARPETAS.map(({ clave, etiqueta, icono: Icono }) => (
                  <button
                    key={clave}
                    type="button"
                    onClick={() => setCarpeta(clave)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-left transition-colors ${
                      carpeta === clave ? 'bg-gold/10 text-gold' : 'text-ink2 hover:bg-card2 hover:text-ink'
                    }`}
                  >
                    <Icono size={15} />
                    <span className="truncate">{etiqueta}</span>
                  </button>
                ))}
              </div>
              <div className="border-t border-border/70 mx-3" />
              <div className="p-3 space-y-0.5 overflow-y-auto flex-1 min-h-0">
                <div className="text-[11px] text-mut uppercase tracking-wide px-3 pt-1 pb-1.5">Cuentas</div>
                {cuentas.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setCuentaId('')}
                    className={`w-full px-3 py-2 rounded-xl text-sm text-left transition-colors ${
                      !cuentaId ? 'bg-gold/10 text-gold' : 'text-ink2 hover:bg-card2 hover:text-ink'
                    }`}
                  >
                    Todas las cuentas
                  </button>
                )}
                {cuentas.map((c) => {
                  const est = estadoCuenta(c)
                  const activa = cuentaId === String(c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCuentaId(String(c.id))}
                      title={`${c.email} · ${est.texto}${c.last_error ? `: ${c.last_error}` : ''}`}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-sm text-left transition-colors ${
                        activa ? 'bg-gold/10 text-gold' : 'text-ink2 hover:bg-card2 hover:text-ink'
                      }`}
                    >
                      <span className={`w-2 h-2 rounded-full shrink-0 ${est.punto}`} />
                      <span className="min-w-0">
                        <span className="block truncate">{c.name || c.email}</span>
                        {c.name && <span className="block text-[11px] text-mut truncate">{c.email}</span>}
                      </span>
                    </button>
                  )
                })}
              </div>
              <div className="p-4 border-t border-border/70">
                <BarraEspacio espacio={espacio} />
                {espacio?.cuota_mb ? (
                  <p className="text-[10px] text-mut mt-1.5">Cuota de {espacio.cuota_mb} MB entre mensajes y adjuntos.</p>
                ) : null}
              </div>
            </aside>

            {/* Columna 2 · lista */}
            <section className={`${COLUMNA} ${seleccion ? 'hidden lg:flex' : 'flex'}`}>
              <div className="p-3 border-b border-border/70">
                <div className="relative">
                  <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-mut" />
                  <input
                    type="search"
                    value={busqueda}
                    onChange={(e) => setBusqueda(e.target.value)}
                    placeholder={carpeta === 'enviados' ? 'Buscar por destinatario o asunto' : 'Buscar por remitente o asunto'}
                    className="w-full bg-bg border border-border focus:border-gold/60 rounded-xl pl-9 pr-3 py-2 text-sm text-ink placeholder-mut outline-none transition-colors"
                    aria-label="Buscar en el buzón"
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto max-h-[70vh] lg:max-h-none">
                {filas === null ? (
                  <div className="py-16 grid place-items-center">
                    <Spinner />
                  </div>
                ) : filas.length === 0 ? (
                  <p className="text-sm text-mut py-14 px-6 text-center">
                    {q
                      ? 'Nada coincide con esa búsqueda.'
                      : carpeta === 'enviados'
                        ? 'Todavía no has respondido ni reenviado nada desde el buzón.'
                        : carpeta === 'no_leidos'
                          ? 'No tienes correo sin leer.'
                          : 'Todavía no hay correo. Pulsa «Sincronizar» para traerlo ahora.'}
                  </p>
                ) : carpeta === 'enviados' ? (
                  filas.map((m) => <FilaEnviado key={m.id} m={m} onClick={() => setDetalleEnvio(m.id)} />)
                ) : (
                  filas.map((m) => (
                    <FilaMensaje
                      key={m.id}
                      m={m}
                      activo={mismoId(seleccion, m.id)}
                      cuenta={!cuentaId && cuentas.length > 1 ? porCuenta.get(String(m.mailbox_id)) : null}
                      onClick={() => abrir(m.id)}
                    />
                  ))
                )}
              </div>

              {filas && filas.length > 0 && (
                <div className="flex justify-between items-center gap-2 px-3 py-2 border-t border-border/70">
                  <Boton variant="sutil" size="sm" disabled={pagina <= 1} onClick={() => cargarLista(pagina - 1)}>
                    ← Anteriores
                  </Boton>
                  <span className="text-[11px] text-mut tabular-nums">
                    {(pagina - 1) * PAGINA + 1}–{(pagina - 1) * PAGINA + filas.length}
                    {total !== null && ` de ${total}`}
                  </span>
                  <Boton
                    variant="sutil"
                    size="sm"
                    disabled={filas.length < PAGINA || (total !== null && (pagina - 1) * PAGINA + filas.length >= total)}
                    onClick={() => cargarLista(pagina + 1)}
                  >
                    Siguientes →
                  </Boton>
                </div>
              )}
            </section>

            {/* Columna 3 · detalle */}
            <section className={`${COLUMNA} ${seleccion ? 'flex' : 'hidden lg:flex'}`}>
              {seleccion ? (
                <DetalleMensaje
                  id={seleccion}
                  version={versionDetalle}
                  porCuenta={porCuenta}
                  onCargado={alCargarDetalle}
                  onVolver={cerrarDetalle}
                  onResponder={(m, todos) => setComposer({ modo: todos ? 'responder_todos' : 'responder', mensaje: m })}
                  onReenviar={(m) => setComposer({ modo: 'reenviar', mensaje: m })}
                  onBorrar={(m) => {
                    setBorrarServidor(false)
                    setABorrar(m)
                  }}
                  onNoLeido={marcarNoLeido}
                  onAbrir={abrir}
                  onVerEnvio={setDetalleEnvio}
                />
              ) : (
                <div className="flex-1 grid place-items-center p-8 text-center">
                  <div>
                    <MailOpen size={28} className="text-mut mx-auto mb-3" />
                    <p className="text-sm text-mut">Elige un mensaje de la lista para leerlo aquí.</p>
                  </div>
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {composer && (
        <Composer
          modo={composer.modo}
          mensaje={composer.mensaje}
          cuenta={porCuenta.get(String(composer.mensaje.mailbox_id))}
          remitentes={remitentes}
          onCerrar={() => setComposer(null)}
          onEnviado={alEnviado}
        />
      )}

      {ajustes && (
        <AjustesBuzon
          cuentas={cuentas}
          remitentes={remitentes}
          maxMensajeMb={numeroONull(espacio?.max_mensaje_mb)}
          onCerrar={() => setAjustes(false)}
          onCambio={alCambiarCuentas}
        />
      )}

      {detalleEnvio && <DetalleEnvio id={detalleEnvio} ruta="/api/loc/envios" onClose={() => setDetalleEnvio(null)} />}

      {aBorrar && (
        <Confirmar
          titulo="Borrar mensaje"
          mensaje={`¿Seguro que quieres borrar «${aBorrar.subject || '(sin asunto)'}»? Se eliminan también sus adjuntos y se libera el espacio que ocupaban.`}
          textoConfirmar="Borrar"
          peligro
          ocupado={borrando}
          onConfirmar={borrar}
          onCancelar={() => setABorrar(null)}
        >
          <label className="flex items-start gap-2.5 mt-4 text-sm text-ink2 cursor-pointer">
            <input
              type="checkbox"
              checked={borrarServidor}
              onChange={(e) => setBorrarServidor(e.target.checked)}
              className="mt-0.5 accent-[#d9b45b]"
            />
            <span>
              También borrarlo del servidor de correo
              <span className="block text-[11px] text-mut mt-0.5">
                {porCuenta.get(String(aBorrar.mailbox_id))?.delete_after_import
                  ? 'Esta cuenta ya borra del servidor al importar: seguramente allí ya no está.'
                  : 'Si el mensaje sigue en la cuenta original, desaparecerá también de allí. Sin marcarlo, allí se queda.'}
              </span>
            </span>
          </label>
        </Confirmar>
      )}
    </div>
  )
}

/* ============================================================
   Filas de la lista
   ============================================================ */
function FilaMensaje({ m, activo, cuenta, onClick }) {
  const de = remitenteDe(m)
  const leido = m.is_read !== false
  const fuerte = leido ? 'text-ink2' : 'text-ink font-semibold'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-border/60 transition-colors ${
        activo ? 'bg-gold/10' : 'hover:bg-card2/70'
      }`}
    >
      <div className="flex items-center gap-2">
        {!leido && <span className="w-2 h-2 rounded-full bg-gold shrink-0" aria-label="Sin leer" />}
        <span className={`text-sm truncate flex-1 ${fuerte}`} title={etiquetaPersona(de)}>
          {nombreCorto(de)}
        </span>
        <span className="text-[11px] text-mut shrink-0 tabular-nums">{fechaLista(m.date)}</span>
      </div>
      <div className={`text-sm truncate mt-0.5 ${fuerte}`}>{m.subject || '(sin asunto)'}</div>
      <div className="flex items-center gap-2 mt-0.5">
        <span className="text-xs text-mut truncate flex-1">{m.snippet || ''}</span>
        {cuenta && (
          <span className="text-[10px] text-mut truncate max-w-24 shrink-0" title={cuenta.email}>
            {cuenta.name || cuenta.email}
          </span>
        )}
        {Number(m.respuestas) > 0 && (
          <span className="inline-flex items-center gap-0.5 text-[10px] text-mut shrink-0" title="Respuestas enviadas desde el buzón">
            <Reply size={11} />
            {m.respuestas}
          </span>
        )}
        {m.has_attachments && <Paperclip size={12} className="text-mut shrink-0" aria-label="Con adjuntos" />}
        <span className="text-[10px] text-mut tabular-nums shrink-0">{fmtBytes(m.size_bytes)}</span>
      </div>
    </button>
  )
}

function FilaEnviado({ m, onClick }) {
  return (
    <button type="button" onClick={onClick} className="w-full text-left px-4 py-3 border-b border-border/60 hover:bg-card2/70 transition-colors">
      <div className="flex items-center gap-2">
        <span className="text-sm text-ink2 truncate flex-1" title={m.to_email}>
          Para: {m.to_name ? `${m.to_name} <${m.to_email}>` : m.to_email}
        </span>
        <span className="text-[11px] text-mut shrink-0 tabular-nums">{fechaLista(fechaDe(m))}</span>
      </div>
      <div className="text-sm text-ink2 truncate mt-0.5">{m.subject || '(sin asunto)'}</div>
      <div className="flex items-center gap-2 mt-1">
        <Badge status={m.status} />
        {m.last_error && (
          <span className="text-[11px] text-bad truncate" title={m.last_error}>
            {m.last_error}
          </span>
        )}
      </div>
    </button>
  )
}

/* ============================================================
   Detalle con hilo
   ============================================================ */
function DetalleMensaje({ id, version, porCuenta, onCargado, onVolver, onResponder, onReenviar, onBorrar, onNoLeido, onAbrir, onVerEnvio }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')
  const [imagenes, setImagenes] = useState(false)
  const refCargado = useRef(onCargado)
  refCargado.current = onCargado

  useEffect(() => {
    let vivo = true
    setDatos(null)
    setError('')
    setImagenes(false)
    obtenerMensajeBuzon(id)
      .then((d) => {
        if (!vivo) return
        const n = normalizarDetalle(d)
        setDatos(n)
        refCargado.current?.(n.mensaje)
      })
      .catch((e) => vivo && setError(e.message))
    return () => {
      vivo = false
    }
  }, [id, version])

  if (error) {
    return (
      <div className="p-5 space-y-3">
        <button type="button" onClick={onVolver} className="lg:hidden inline-flex items-center gap-1.5 text-xs text-ink2 hover:text-ink">
          <ArrowLeft size={14} /> Volver
        </button>
        <Aviso variant="error">{error}</Aviso>
      </div>
    )
  }
  if (!datos) {
    return (
      <div className="flex-1 grid place-items-center py-16">
        <Spinner />
      </div>
    )
  }

  const { mensaje: m, adjuntos, hilo } = datos
  const de = remitenteDe(m)
  const para = destinatariosDe(m, 'to')
  const cc = destinatariosDe(m, 'cc')
  const cuenta = porCuenta.get(String(m.mailbox_id))
  const propio = String(cuenta?.email || '').toLowerCase()
  const otros = [...para, ...cc].filter((p) => p.email && p.email.toLowerCase() !== propio && p.email.toLowerCase() !== de.email.toLowerCase())
  const html = typeof m.html === 'string' && m.html.trim() ? m.html : ''
  const conRemotas = html ? tieneImagenesRemotas(html) : false
  const documento = html ? documentoCorreo(html, imagenes) : documentoTexto(m.text || '')
  const otrosDelHilo = hilo.filter((h) => esEnviado(h) || !mismoId(h.id, m.id))

  return (
    <>
      <div className="p-4 lg:p-5 border-b border-border/70 space-y-3">
        <div className="flex items-start gap-3">
          <button type="button" onClick={onVolver} className="lg:hidden mt-0.5 text-ink2 hover:text-ink shrink-0" aria-label="Volver a la lista">
            <ArrowLeft size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold break-words">{m.subject || '(sin asunto)'}</h2>
            <div className="text-[11px] text-mut mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
              <span>{fechaLarga(m.date)}</span>
              <span>{fmtBytes(m.size_bytes)}</span>
              {cuenta && <span title={cuenta.email}>en {cuenta.name || cuenta.email}</span>}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Boton size="sm" icono={Reply} onClick={() => onResponder(m, false)}>
            Responder
          </Boton>
          {otros.length > 0 && (
            <Boton size="sm" variant="ghost" icono={ReplyAll} onClick={() => onResponder(m, true)}>
              Responder a todos
            </Boton>
          )}
          <Boton size="sm" variant="ghost" icono={Forward} onClick={() => onReenviar(m)}>
            Reenviar
          </Boton>
          <Boton size="sm" variant="sutil" icono={Mail} onClick={() => onNoLeido(m)} title="Marcar como no leído">
            No leído
          </Boton>
          <Boton size="sm" variant="peligro" icono={Trash2} onClick={() => onBorrar(m)} className="ml-auto">
            Borrar
          </Boton>
        </div>

        <div className="text-sm space-y-0.5">
          <div className="flex gap-2">
            <span className="text-mut w-10 shrink-0">De</span>
            <span className="text-ink break-all">{etiquetaPersona(de)}</span>
          </div>
          {para.length > 0 && (
            <div className="flex gap-2">
              <span className="text-mut w-10 shrink-0">Para</span>
              <span className="text-ink2 break-all">{para.map(etiquetaPersona).join(', ')}</span>
            </div>
          )}
          {cc.length > 0 && (
            <div className="flex gap-2">
              <span className="text-mut w-10 shrink-0">CC</span>
              <span className="text-ink2 break-all">{cc.map(etiquetaPersona).join(', ')}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {html && conRemotas && (
          <div className="flex items-center gap-3 px-4 py-2 text-xs text-ink2 bg-card2/60 border-b border-border/70">
            <Image size={14} className="text-mut shrink-0" />
            <span className="flex-1">
              {imagenes ? 'Imágenes remotas cargadas.' : 'Las imágenes remotas están bloqueadas para que el remitente no sepa que lo has abierto.'}
            </span>
            <button type="button" className="text-gold hover:underline shrink-0" onClick={() => setImagenes((v) => !v)}>
              {imagenes ? 'Ocultar imágenes' : 'Cargar imágenes'}
            </button>
          </div>
        )}

        <div className="p-4 lg:p-5 space-y-4">
          <div className="bg-white rounded-xl overflow-hidden border border-border">
            {/* sandbox sin scripts ni navegación del panel: solo puede abrir enlaces en otra pestaña; las imágenes remotas van aparte */}
            <iframe key={`${m.id}-${imagenes ? 'img' : 'sin'}`} title="Contenido del mensaje" sandbox={SANDBOX_CORREO} className="w-full h-[480px] bg-white" srcDoc={documento} />
          </div>

          {adjuntos.length > 0 && (
            <div>
              <div className="text-[11px] text-mut uppercase tracking-wide mb-2 inline-flex items-center gap-1.5">
                <Paperclip size={12} /> {adjuntos.length === 1 ? '1 adjunto' : `${adjuntos.length} adjuntos`}
              </div>
              <div className="flex flex-wrap gap-2">
                {adjuntos.map((a) => (
                  <a
                    key={a.id}
                    href={urlAdjuntoBuzon(a.id)}
                    download={a.filename || undefined}
                    className="inline-flex items-center gap-2 max-w-full bg-card2 border border-border hover:border-gold/40 rounded-xl px-3 py-2 text-xs text-ink transition-colors"
                    title={`${a.filename || 'adjunto'} · ${a.content_type || ''}`}
                  >
                    <Download size={13} className="text-gold shrink-0" />
                    <span className="truncate max-w-56">{a.filename || 'adjunto'}</span>
                    <span className="text-mut tabular-nums shrink-0">{fmtBytes(a.size_bytes)}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {m.has_attachments && adjuntos.length === 0 && (
            <Aviso variant="aviso">
              Este mensaje traía adjuntos, pero superaba el tamaño máximo permitido y se guardó sin ellos. Siguen en tu
              cuenta de correo si no la tienes configurada para borrar al importar.
            </Aviso>
          )}

          {otrosDelHilo.length > 0 && (
            <div>
              <div className="text-[11px] text-mut uppercase tracking-wide mb-2">Hilo · {hilo.length} mensajes</div>
              <ol className="space-y-2">
                {hilo.map((h) => {
                  const clave = `${esEnviado(h) ? 'env' : 'rec'}-${h.id}`
                  if (esEnviado(h)) {
                    return (
                      <li key={clave} className="bg-card2/70 border border-gold/20 rounded-xl px-3.5 py-2.5">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Send size={12} className="text-gold shrink-0" />
                          <span className="text-sm text-ink truncate">
                            Tú → {h.to_name ? `${h.to_name} <${h.to_email}>` : h.to_email}
                          </span>
                          <Badge status={h.status} />
                          <span className="text-[11px] text-mut ml-auto">{fmtFechaHora(fechaDe(h))}</span>
                        </div>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="text-xs text-ink2 truncate flex-1">{h.subject}</span>
                          <button type="button" className="text-[11px] text-gold hover:underline shrink-0" onClick={() => onVerEnvio(h.id)}>
                            Ver estado de entrega
                          </button>
                        </div>
                        {h.last_error && (
                          <div className="text-[11px] text-bad truncate mt-0.5" title={h.last_error}>
                            {h.last_error}
                          </div>
                        )}
                      </li>
                    )
                  }
                  const actual = mismoId(h.id, m.id)
                  const quien = remitenteDe(h)
                  return (
                    <li key={clave}>
                      <button
                        type="button"
                        disabled={actual}
                        onClick={() => onAbrir(h.id)}
                        className={`w-full text-left rounded-xl px-3.5 py-2.5 border transition-colors ${
                          actual ? 'bg-gold/10 border-gold/30 cursor-default' : 'bg-card2/40 border-border hover:border-gold/40'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`text-sm truncate flex-1 ${h.is_read === false ? 'text-ink font-semibold' : 'text-ink'}`} title={etiquetaPersona(quien)}>
                            {nombreCorto(quien)}
                          </span>
                          {actual && <span className="text-[10px] text-gold uppercase tracking-wide">Este mensaje</span>}
                          <span className="text-[11px] text-mut">{fmtFechaHora(fechaDe(h))}</span>
                        </div>
                        <div className="text-xs text-ink2 truncate mt-0.5">{h.snippet || h.subject || ''}</div>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </div>
          )}
        </div>
      </div>
    </>
  )
}

/* ============================================================
   Composer: responder, responder a todos y reenviar
   ============================================================ */
const TITULOS = {
  responder: 'Responder',
  responder_todos: 'Responder a todos',
  reenviar: 'Reenviar',
}

function Composer({ modo, mensaje, cuenta, remitentes, onCerrar, onEnviado }) {
  const esReenvio = modo === 'reenviar'
  const todos = modo === 'responder_todos'
  const de = remitenteDe(mensaje)
  const propio = String(cuenta?.email || '').toLowerCase()
  const enCopia = [...destinatariosDe(mensaje, 'to'), ...destinatariosDe(mensaje, 'cc')].filter(
    (p) => p.email && p.email.toLowerCase() !== propio && p.email.toLowerCase() !== de.email.toLowerCase(),
  )
  const asunto = `${esReenvio ? 'Fwd' : 'Re'}: ${sinPrefijo(mensaje.subject) || '(sin asunto)'}`

  const remitenteInicial =
    String(cuenta?.reply_sender_id || '') ||
    String(remitentes.find((r) => r.is_default)?.id || '') ||
    String(remitentes[0]?.id || '')
  const [form, setForm] = useState({ sender_id: remitenteInicial, to: '', cc: '', bcc: '', texto: '' })
  const [vista, setVista] = useState('escribir')
  const [errores, setErrores] = useState([])
  const [enviando, setEnviando] = useState(false)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const enviar = async (e) => {
    e.preventDefault()
    const fallos = []
    if (remitentes.length === 0) fallos.push('No tienes ningún remitente dado de alta: crea uno en Remitentes para poder enviar.')
    if (!form.sender_id) fallos.push('Elige desde qué remitente sale el correo.')
    if (!form.texto.trim()) fallos.push('Escribe algo antes de enviar.')
    const to = separarCorreos(form.to)
    const ccLista = separarCorreos(form.cc)
    const bccLista = separarCorreos(form.bcc)
    if (esReenvio) {
      if (to.length === 0) fallos.push('Indica a quién quieres reenviarlo.')
      if (to.length > 1) fallos.push('Reenvía a una sola dirección cada vez.')
    }
    for (const [etiqueta, l] of [['Para', to], ['CC', ccLista], ['CCO', bccLista]]) {
      const malos = l.filter((x) => !CORREO.test(x))
      if (malos.length) fallos.push(`En ${etiqueta} hay direcciones no válidas: ${malos.join(', ')}.`)
    }
    setErrores(fallos)
    if (fallos.length) return

    const cuerpo = { html: textoAHtml(form.texto), text: form.texto.replace(/\r\n?/g, '\n').trim(), sender_id: Number(form.sender_id) }
    setEnviando(true)
    try {
      if (esReenvio) {
        await reenviarMensajeBuzon(mensaje.id, { ...cuerpo, to: to[0] })
      } else {
        await responderMensajeBuzon(mensaje.id, {
          ...cuerpo,
          todos,
          cc: ccLista.length ? ccLista : undefined,
          bcc: bccLista.length ? bccLista : undefined,
        })
      }
      onEnviado()
    } catch (err) {
      setErrores([err.message])
    } finally {
      setEnviando(false)
    }
  }

  const pestana = (clave, texto) => (
    <button
      type="button"
      onClick={() => setVista(clave)}
      className={`px-2.5 py-1 rounded-lg text-xs transition-colors ${vista === clave ? 'bg-gold/15 text-gold' : 'text-ink2 hover:text-ink hover:bg-card2'}`}
    >
      {texto}
    </button>
  )

  return (
    <Modal titulo={TITULOS[modo]} descripcion={asunto} onCerrar={onCerrar} ancho="max-w-2xl">
      <form onSubmit={enviar} className="space-y-4">
        {errores.length > 0 && (
          <Aviso variant="error">
            {errores.length === 1 ? (
              errores[0]
            ) : (
              <ul className="list-disc pl-4 space-y-0.5">
                {errores.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
          </Aviso>
        )}

        {remitentes.length === 0 ? (
          <Aviso variant="error">
            No tienes ningún remitente dado de alta. Crea uno en{' '}
            <Link to="/remitentes" className="text-gold hover:underline">
              Remitentes
            </Link>{' '}
            (con su proveedor) y vuelve aquí.
          </Aviso>
        ) : (
          <Select
            label="Enviar desde"
            value={form.sender_id}
            onChange={set('sender_id')}
            hint={
              cuenta?.reply_sender_id
                ? 'Remitente configurado para responder desde esta cuenta. Puedes cambiarlo solo para este correo.'
                : 'El correo sale por el proveedor de este remitente, como cualquier otro envío.'
            }
          >
            {remitentes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name ? `${r.name} <${r.email}>` : r.email}
                {r.proveedor_nombre ? ` · ${r.proveedor_nombre}` : ''}
              </option>
            ))}
          </Select>
        )}

        {esReenvio ? (
          <Campo
            label="Para"
            type="email"
            placeholder="persona@dominio.com"
            value={form.to}
            onChange={set('to')}
            autoComplete="off"
            autoFocus
          />
        ) : (
          <div className="bg-card2 border border-border rounded-xl px-3.5 py-2.5 text-sm space-y-0.5">
            <div className="flex gap-2">
              <span className="text-mut w-10 shrink-0">Para</span>
              <span className="text-ink break-all">{etiquetaPersona(de)}</span>
            </div>
            {todos && enCopia.length > 0 && (
              <div className="flex gap-2">
                <span className="text-mut w-10 shrink-0">CC</span>
                <span className="text-ink2 break-all">{enCopia.map(etiquetaPersona).join(', ')}</span>
              </div>
            )}
          </div>
        )}

        {!esReenvio && (
          <div className="grid sm:grid-cols-2 gap-3">
            <Campo label="CC (opcional)" placeholder="uno@dominio.com, otro@dominio.com" value={form.cc} onChange={set('cc')} autoComplete="off" />
            <Campo label="CCO (opcional)" placeholder="copia oculta" value={form.bcc} onChange={set('bcc')} autoComplete="off" />
          </div>
        )}

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-xs text-ink2">Mensaje</span>
            <div className="flex gap-1">
              {pestana('escribir', 'Escribir')}
              {pestana('previa', 'Vista previa')}
            </div>
          </div>
          {vista === 'escribir' ? (
            <Textarea rows={10} value={form.texto} onChange={set('texto')} placeholder="Escribe tu respuesta…" autoFocus={!esReenvio} />
          ) : (
            <div className="bg-white rounded-xl overflow-hidden border border-border">
              <iframe title="Vista previa de la respuesta" sandbox={SANDBOX_CORREO} className="w-full h-64 bg-white" srcDoc={documentoCorreo(textoAHtml(form.texto) || '<p style="color:#9ca3af">Nada que mostrar todavía.</p>', true)} />
            </div>
          )}
          <p className="text-[11px] text-mut mt-1">
            Texto plano: los párrafos y los enlaces se convierten solos a HTML.
            {esReenvio ? ' El mensaje original va citado a continuación.' : ' El mensaje original se cita al final, como en cualquier cliente de correo.'}
          </p>
        </div>

        {esReenvio && (
          <Aviso variant="aviso">
            Los adjuntos del original no se reenvían en esta versión: solo el texto. Si hacen falta, descárgalos del
            mensaje y adjúntalos desde tu programa de correo.
          </Aviso>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Boton type="button" variant="ghost" onClick={onCerrar} disabled={enviando}>
            Cancelar
          </Boton>
          <Boton type="submit" icono={Send} cargando={enviando} disabled={remitentes.length === 0}>
            {esReenvio ? 'Reenviar' : 'Enviar respuesta'}
          </Boton>
        </div>
      </form>
    </Modal>
  )
}

/* ============================================================
   Engranaje: cuentas IMAP (lista + formulario)
   ============================================================ */
const CUENTA_VACIA = {
  name: '',
  email: '',
  host: '',
  port: '993',
  secure: 'tls',
  username: '',
  password: '',
  folder: 'INBOX',
  delete_after_import: false,
  sync_interval_min: '5',
  reply_sender_id: '',
  enabled: true,
  reemplazar: true,
}

// Ajustes conocidos de los dos proveedores que más se conectan. Los dos exigen «contraseña de
// aplicación» con la verificación en dos pasos activada; la de la cuenta no vale.
const PRESETS = {
  gmail: { host: 'imap.gmail.com', port: '993', secure: 'tls' },
  outlook: { host: 'outlook.office365.com', port: '993', secure: 'tls' },
}

function validarCuenta(f, esNueva) {
  const errores = []
  if (!f.name.trim()) errores.push('Ponle un nombre a la cuenta (solo se ve en el panel).')
  if (f.name.length > 120) errores.push('El nombre no puede pasar de 120 caracteres.')
  if (!CORREO.test(f.email.trim())) errores.push('El correo de la cuenta no es válido.')
  if (!f.host.trim()) errores.push('El servidor IMAP es obligatorio.')
  else if (!HOST.test(f.host.trim())) errores.push('El servidor IMAP no parece un nombre de host válido.')
  const puerto = Number(f.port)
  if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) errores.push('El puerto tiene que estar entre 1 y 65535.')
  if (!f.username.trim()) errores.push('El usuario es obligatorio (normalmente, el correo completo).')
  if ((esNueva || f.reemplazar) && !f.password) errores.push('La contraseña es obligatoria.')
  if (!f.folder.trim()) errores.push('Indica la carpeta que hay que leer (normalmente INBOX).')
  const intervalo = Number(f.sync_interval_min)
  if (!Number.isInteger(intervalo) || intervalo < 1 || intervalo > 1440) {
    errores.push('El intervalo de sincronización tiene que ser un número entero de minutos entre 1 y 1440.')
  }
  return errores
}

function AjustesBuzon({ cuentas, remitentes, maxMensajeMb, onCerrar, onCambio }) {
  const [vista, setVista] = useState(cuentas.length === 0 ? 'form' : 'lista')
  const [editando, setEditando] = useState(null) // id | null
  const [form, setForm] = useState(CUENTA_VACIA)
  const [errores, setErrores] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [probando, setProbando] = useState(null)
  const [sincronizando, setSincronizando] = useState(null)
  const [resultado, setResultado] = useState(null) // { id, ok, texto }
  const [aBorrar, setABorrar] = useState(null)
  const [borrando, setBorrando] = useState(false)

  const abrirNueva = () => {
    setForm(CUENTA_VACIA)
    setEditando(null)
    setErrores([])
    setVista('form')
  }

  const abrirEditar = (c) => {
    setForm({
      ...CUENTA_VACIA,
      name: c.name || '',
      email: c.email || '',
      host: c.host || '',
      port: String(c.port ?? 993),
      secure: c.secure === false ? 'starttls' : 'tls',
      username: c.username || '',
      folder: c.folder || 'INBOX',
      delete_after_import: Boolean(c.delete_after_import),
      sync_interval_min: String(c.sync_interval_min ?? 5),
      reply_sender_id: c.reply_sender_id ? String(c.reply_sender_id) : '',
      enabled: c.enabled !== false,
      reemplazar: false,
    })
    setEditando(c.id)
    setErrores([])
    setVista('form')
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const aplicarPreset = (clave) =>
    setForm((f) => ({ ...f, ...PRESETS[clave], username: f.username || f.email }))

  const guardar = async (e) => {
    e.preventDefault()
    const esNueva = editando === null
    const fallos = validarCuenta(form, esNueva)
    setErrores(fallos)
    if (fallos.length) return

    const cuerpo = {
      name: form.name.trim(),
      email: form.email.trim().toLowerCase(),
      host: form.host.trim(),
      port: Number(form.port),
      secure: form.secure === 'tls',
      username: form.username.trim(),
      folder: form.folder.trim(),
      delete_after_import: Boolean(form.delete_after_import),
      sync_interval_min: Number(form.sync_interval_min),
      reply_sender_id: form.reply_sender_id ? Number(form.reply_sender_id) : null,
      enabled: Boolean(form.enabled),
    }
    if (esNueva || form.reemplazar) cuerpo.password = form.password

    setGuardando(true)
    try {
      if (esNueva) await crearCuentaBuzon(cuerpo)
      else await actualizarCuentaBuzon(editando, cuerpo)
      setForm(CUENTA_VACIA)
      setVista('lista')
      setResultado(null)
      await onCambio()
    } catch (err) {
      setErrores([err.message])
    } finally {
      setGuardando(false)
    }
  }

  const probar = async (c) => {
    setProbando(c.id)
    setResultado(null)
    try {
      const r = await probarCuentaBuzon(c.id)
      const n = numeroONull(r?.mensajes_en_servidor)
      setResultado({
        id: c.id,
        ok: r?.ok !== false,
        texto:
          r?.ok !== false
            ? `${r?.detalle || 'Conexión correcta.'}${n !== null ? ` ${n === 1 ? 'Hay 1 mensaje' : `Hay ${n} mensajes`} en la carpeta.` : ''}`
            : r?.detalle || 'No se ha podido conectar.',
      })
      await onCambio()
    } catch (err) {
      setResultado({ id: c.id, ok: false, texto: err.message })
    } finally {
      setProbando(null)
    }
  }

  const sincronizar = async (c) => {
    setSincronizando(c.id)
    setResultado(null)
    try {
      const r = await sincronizarCuentaBuzon(c.id)
      const n = Number(r?.nuevos) || 0
      let textoResultado
      if (r?.ok === false) textoResultado = r?.detalle || 'No se ha podido sincronizar.'
      else if (r?.en_curso) textoResultado = r?.detalle || 'La sincronización sigue en segundo plano.'
      else textoResultado = `${n === 1 ? '1 correo nuevo' : `${n} correos nuevos`}.${r?.detalle ? ` ${r.detalle}` : ''}`
      setResultado({ id: c.id, ok: r?.ok !== false, texto: textoResultado })
      await onCambio()
    } catch (err) {
      setResultado({ id: c.id, ok: false, texto: err.message })
    } finally {
      setSincronizando(null)
    }
  }

  const borrar = async () => {
    setBorrando(true)
    try {
      await eliminarCuentaBuzon(aBorrar.id)
      setABorrar(null)
      setResultado(null)
      await onCambio()
    } catch (err) {
      setResultado({ id: aBorrar.id, ok: false, texto: err.message })
      setABorrar(null)
    } finally {
      setBorrando(false)
    }
  }

  const ayuda = (
    <div className="bg-card2 border border-border rounded-xl p-3.5 text-xs text-ink2 space-y-1.5">
      <div className="text-sm text-ink">Gmail y Outlook piden una «contraseña de aplicación»</div>
      <p>
        La contraseña normal de la cuenta no vale: los dos exigen activar la <strong className="text-ink">verificación en dos pasos</strong>{' '}
        y crear una contraseña de aplicación de 16 caracteres, que es la que se pega aquí.
      </p>
      <ul className="list-disc pl-4 space-y-1">
        <li>
          <strong className="text-ink">Gmail:</strong> Cuenta de Google › Seguridad › Verificación en dos pasos › Contraseñas de
          aplicaciones. Servidor <code className="text-ink">imap.gmail.com</code>, puerto 993, TLS. IMAP tiene que estar
          habilitado en los ajustes de Gmail.
        </li>
        <li>
          <strong className="text-ink">Outlook / Microsoft 365:</strong> Cuenta Microsoft › Seguridad › Opciones de seguridad
          avanzadas › Contraseñas de aplicación. Servidor <code className="text-ink">outlook.office365.com</code>, puerto 993,
          TLS.
        </li>
        <li>
          <strong className="text-ink">Correo de tu dominio:</strong> el servidor IMAP y el puerto te los da tu hosting (casi
          siempre 993 con TLS).
        </li>
      </ul>
    </div>
  )

  return (
    <Modal
      titulo={vista === 'form' ? (editando ? 'Editar cuenta de correo' : 'Conectar una cuenta de correo') : 'Cuentas de correo'}
      descripcion={vista === 'form' ? 'La contraseña se guarda cifrada y no vuelve a mostrarse.' : 'Cuentas IMAP de las que se trae el correo del buzón.'}
      onCerrar={onCerrar}
      ancho="max-w-4xl"
    >
      {vista === 'lista' ? (
        <div className="space-y-4">
          {resultado && (
            <Aviso variant={resultado.ok ? 'ok' : 'error'} onCerrar={() => setResultado(null)}>
              {resultado.texto}
            </Aviso>
          )}

          {cuentas.length === 0 ? (
            <p className="text-sm text-mut py-8 text-center">Todavía no hay ninguna cuenta conectada.</p>
          ) : (
            <Tabla columnas={['Cuenta', 'Servidor', 'Estado', 'Última sincronización', '']}>
              {cuentas.map((c) => {
                const est = estadoCuenta(c)
                return (
                  <tr key={c.id}>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60">
                      <div className="font-medium">{c.name || c.email}</div>
                      <div className="text-[11px] text-mut">{c.email}</div>
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                      <div className="text-xs">
                        {c.host}:{c.port} <span className="text-mut">({c.secure === false ? 'STARTTLS' : 'TLS'})</span>
                      </div>
                      <div className="text-[11px] text-mut">
                        {c.folder || 'INBOX'} · cada {c.sync_interval_min ?? 5} min ·{' '}
                        {c.delete_after_import ? 'borra del servidor' : 'deja copia'}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60">
                      <Badge estado={est.estado} texto={est.texto} titulo={c.last_error || undefined} />
                      {c.last_error && (
                        <div className="text-[11px] text-bad max-w-56 truncate" title={c.last_error}>
                          {c.last_error}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 whitespace-nowrap text-xs">
                      {c.last_sync_at ? fmtFechaHora(c.last_sync_at) : 'Nunca'}
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                      {/* dos líneas de acciones para que la tabla quepa en el modal sin scroll */}
                      <div className="flex flex-col items-end gap-1">
                        <div>
                          <button
                            type="button"
                            className="text-xs text-gold hover:underline mr-3 disabled:opacity-40"
                            disabled={probando === c.id || sincronizando === c.id}
                            onClick={() => probar(c)}
                          >
                            {probando === c.id ? 'Probando…' : 'Probar conexión'}
                          </button>
                          <button
                            type="button"
                            className="text-xs text-gold hover:underline disabled:opacity-40"
                            disabled={probando === c.id || sincronizando === c.id || c.enabled === false}
                            onClick={() => sincronizar(c)}
                          >
                            {sincronizando === c.id ? 'Sincronizando…' : 'Sincronizar ahora'}
                          </button>
                        </div>
                        <div>
                          <button type="button" className="text-xs text-ink2 hover:text-ink mr-3" onClick={() => abrirEditar(c)}>
                            Editar
                          </button>
                          <button type="button" className="text-xs text-bad/80 hover:text-bad" onClick={() => setABorrar(c)}>
                            Eliminar
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </Tabla>
          )}

          <div className="flex justify-between items-center gap-3 flex-wrap">
            <p className="text-[11px] text-mut">
              El correo se trae solo según el intervalo de cada cuenta; «Sincronizar ahora» fuerza una pasada.
            </p>
            <Boton icono={Plus} onClick={abrirNueva}>
              Añadir cuenta
            </Boton>
          </div>

          {ayuda}
        </div>
      ) : (
        <form onSubmit={guardar} className="space-y-4">
          {errores.length > 0 && (
            <Aviso variant="error">
              {errores.length === 1 ? (
                errores[0]
              ) : (
                <ul className="list-disc pl-4 space-y-0.5">
                  {errores.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              )}
            </Aviso>
          )}

          <div className="grid sm:grid-cols-2 gap-3">
            <Campo label="Nombre" placeholder="Soporte" value={form.name} onChange={set('name')} maxLength={120} hint="Solo para identificarla en el panel." />
            <Campo
              label="Correo de la cuenta"
              type="email"
              placeholder="soporte@tudominio.com"
              value={form.email}
              onChange={set('email')}
              autoComplete="off"
              disabled={editando !== null}
              hint={editando !== null ? 'El correo no se cambia: crea otra cuenta si hace falta.' : undefined}
            />
          </div>

          <div className="bg-card2 border border-border rounded-xl p-3.5 space-y-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm">Servidor IMAP</div>
              <div className="flex gap-2">
                <button type="button" className="text-[11px] text-gold hover:underline" onClick={() => aplicarPreset('gmail')}>
                  Rellenar para Gmail
                </button>
                <button type="button" className="text-[11px] text-gold hover:underline" onClick={() => aplicarPreset('outlook')}>
                  Rellenar para Outlook
                </button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Campo className="col-span-2" label="Servidor" placeholder="imap.tudominio.com" value={form.host} onChange={set('host')} autoComplete="off" />
              <Select
                label="Cifrado"
                value={form.secure}
                onChange={(e) => {
                  const secure = e.target.value
                  setForm((f) => ({
                    ...f,
                    secure,
                    // solo se reajusta el puerto si el usuario no lo había cambiado a mano
                    port: ['993', '143'].includes(f.port) ? (secure === 'tls' ? '993' : '143') : f.port,
                  }))
                }}
              >
                <option value="tls">TLS (993, recomendado)</option>
                <option value="starttls">STARTTLS (143)</option>
              </Select>
              <Campo label="Puerto" inputMode="numeric" value={form.port} onChange={set('port')} />
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <Campo label="Usuario" placeholder="normalmente, el correo completo" value={form.username} onChange={set('username')} autoComplete="off" />
              {editando !== null && !form.reemplazar ? (
                <div>
                  <div className="text-xs text-ink2 mb-1.5">Contraseña</div>
                  <div className="flex items-center justify-between gap-3 bg-bg border border-border rounded-xl px-3.5 py-2">
                    <span className="text-sm text-ink2">Guardada · no se puede mostrar</span>
                    <Interruptor checked={form.reemplazar} onChange={(v) => setForm((f) => ({ ...f, reemplazar: v, password: '' }))} label="Reemplazar" />
                  </div>
                </div>
              ) : (
                <Campo
                  label={editando !== null ? 'Contraseña nueva' : 'Contraseña'}
                  type="password"
                  value={form.password}
                  onChange={set('password')}
                  autoComplete="new-password"
                  hint="En Gmail y Outlook, la contraseña de aplicación."
                />
              )}
            </div>
            <Campo label="Carpeta" value={form.folder} onChange={set('folder')} autoComplete="off" hint="La carpeta del servidor que se lee. INBOX es la bandeja de entrada." />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-xs text-ink2 mb-1.5">Qué hacer tras traer el correo</legend>
            {[
              [
                false,
                'Dejar una copia en el servidor',
                'Recomendado. El correo sigue en tu cuenta de siempre y aquí se guarda una copia para leerlo y responderlo. Ocupa espacio en los dos sitios.',
              ],
              [
                true,
                'Borrar del servidor una vez traído',
                'El mensaje desaparece de la cuenta original nada más importarse y solo queda aquí. Libera espacio allí, pero si lo borras en este panel se pierde de verdad. ' +
                  `Los correos que superen el máximo por mensaje${maxMensajeMb ? ` (${maxMensajeMb} MB)` : ''} se guardan aquí solo con sus cabeceras y se conservan en el servidor.`,
              ],
            ].map(([valor, titulo, texto]) => {
              const marcado = form.delete_after_import === valor
              return (
                <label
                  key={String(valor)}
                  className={`flex items-start gap-3 rounded-xl border px-3.5 py-3 cursor-pointer transition-colors ${
                    marcado ? 'border-gold/50 bg-gold/5' : 'border-border hover:border-gold/30'
                  }`}
                >
                  <input
                    type="radio"
                    name="delete_after_import"
                    className="mt-1 accent-[#d9b45b]"
                    checked={marcado}
                    onChange={() => setForm((f) => ({ ...f, delete_after_import: valor }))}
                  />
                  <span>
                    <span className="block text-sm text-ink">{titulo}</span>
                    <span className="block text-[11px] text-mut mt-0.5">{texto}</span>
                  </span>
                </label>
              )
            })}
          </fieldset>

          <div className="grid sm:grid-cols-2 gap-3">
            <Campo
              label="Cada cuántos minutos se sincroniza"
              inputMode="numeric"
              value={form.sync_interval_min}
              onChange={set('sync_interval_min')}
              hint="Entre 1 y 1440. Con 5 basta para casi todo."
            />
            <Select
              label="Remitente para responder"
              value={form.reply_sender_id}
              onChange={set('reply_sender_id')}
              hint="Desde qué remitente (y proveedor) salen las respuestas. Vacío = el remitente por defecto de la subcuenta."
            >
              <option value="">Remitente por defecto</option>
              {remitentes.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name ? `${r.name} <${r.email}>` : r.email}
                </option>
              ))}
            </Select>
          </div>

          {editando !== null && (
            <div className="bg-card2 border border-border rounded-xl p-3.5">
              <Interruptor
                checked={form.enabled}
                onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
                label={form.enabled ? 'Cuenta activa' : 'Cuenta desactivada'}
                hint="Desactivada no se sincroniza; lo ya importado se conserva."
              />
            </div>
          )}

          {ayuda}

          <div className="flex justify-between gap-2 pt-1">
            <Boton type="button" variant="ghost" onClick={() => (cuentas.length ? setVista('lista') : onCerrar())} disabled={guardando}>
              {cuentas.length ? 'Volver a la lista' : 'Cancelar'}
            </Boton>
            <Boton type="submit" cargando={guardando}>
              {editando !== null ? 'Guardar cambios' : 'Conectar cuenta'}
            </Boton>
          </div>
        </form>
      )}

      {aBorrar && (
        <Confirmar
          titulo="Eliminar cuenta de correo"
          mensaje={`¿Seguro que quieres eliminar «${aBorrar.name || aBorrar.email}»? Se borran también todos los correos y adjuntos que se habían traído de ella (se libera su espacio). En el servidor de correo no se toca nada.`}
          textoConfirmar="Eliminar"
          peligro
          ocupado={borrando}
          onConfirmar={borrar}
          onCancelar={() => setABorrar(null)}
        />
      )}
    </Modal>
  )
}
