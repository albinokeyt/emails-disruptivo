import { Children, isValidElement, useEffect, useId } from 'react'
import {
  AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, X, XCircle,
} from 'lucide-react'
import { useCopiar } from '../hooks.js'

// Los componentes aceptan sus props en español y también los alias cortos en
// inglés (label, title, variant, checked, value…), porque las pantallas se
// escriben en paralelo y unas y otras conviven.
const elegir = (...valores) => valores.find((v) => v !== undefined)

/* ============================================================
   Botón
   ============================================================ */
const VARIANTES = {
  primario: 'bg-gold text-bg hover:bg-[#e5c470] font-semibold border border-transparent',
  primary: 'bg-gold text-bg hover:bg-[#e5c470] font-semibold border border-transparent',
  secundario: 'bg-card2 text-ink hover:bg-border border border-border',
  ghost: 'bg-card2 text-ink hover:bg-border border border-border',
  peligro: 'bg-bad/10 text-bad border border-bad/30 hover:bg-bad/20',
  danger: 'bg-bad/10 text-bad border border-bad/30 hover:bg-bad/20',
  sutil: 'bg-transparent text-ink2 hover:text-ink hover:bg-card2 border border-transparent',
  contorno: 'bg-transparent text-gold border border-gold/40 hover:bg-gold/10',
}

const TAMANOS = {
  sm: 'px-2.5 py-1.5 text-xs gap-1.5 rounded-lg',
  md: 'px-4 py-2 text-sm gap-2 rounded-xl',
  lg: 'px-5 py-2.5 text-sm gap-2 rounded-xl',
}

// `icono` puede llegar como componente (los de lucide son objetos, no funciones)
// o como elemento ya construido.
function pintarIcono(Icono, medida) {
  if (!Icono) return null
  if (isValidElement(Icono)) return Icono
  const Componente = Icono
  return <Componente size={medida} />
}

export function Boton({
  children,
  variante,
  variant,
  tamano,
  size,
  icono = null,
  cargando,
  loading,
  type = 'button',
  className = '',
  disabled = false,
  ...props
}) {
  const clave = elegir(variante, variant, 'primario')
  const medidaClave = elegir(tamano, size, 'md')
  const ocupado = Boolean(elegir(cargando, loading, false))
  const estilo = VARIANTES[clave] || VARIANTES.primario
  const medida = TAMANOS[medidaClave] || TAMANOS.md
  const px = medidaClave === 'sm' ? 13 : 15
  return (
    <button
      type={type}
      disabled={disabled || ocupado}
      className={`inline-flex items-center justify-center whitespace-nowrap transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${estilo} ${medida} ${className}`}
      {...props}
    >
      {ocupado ? <Loader2 size={px} className="spin" /> : pintarIcono(icono, px)}
      {children}
    </button>
  )
}

/* ============================================================
   Campos de formulario
   ============================================================ */
const BASE_CONTROL =
  'w-full bg-bg border rounded-xl px-3.5 py-2.5 text-sm text-ink placeholder-mut outline-none transition-colors disabled:opacity-50'

const borde = (error) => (error ? 'border-bad/60 focus:border-bad' : 'border-border focus:border-gold/60')

function Envoltura({ etiqueta, ayuda, error, obligatorio, htmlFor, className = '', children }) {
  return (
    <div className={`block ${className}`}>
      {etiqueta && (
        <label htmlFor={htmlFor} className="block text-xs text-ink2 mb-1.5">
          {etiqueta}
          {obligatorio && <span className="text-gold ml-0.5">*</span>}
        </label>
      )}
      {children}
      {error && <span className="block text-[11px] text-bad mt-1">{error}</span>}
      {!error && ayuda && <span className="block text-[11px] text-mut mt-1">{ayuda}</span>}
    </div>
  )
}

export function Campo({
  etiqueta, label, ayuda, hint, error, obligatorio, className = '', id, ...props
}) {
  const auto = useId()
  const idCampo = id || auto
  return (
    <Envoltura
      etiqueta={elegir(etiqueta, label)}
      ayuda={elegir(ayuda, hint)}
      error={error}
      obligatorio={elegir(obligatorio, props.required, false)}
      htmlFor={idCampo}
      className={className}
    >
      <input id={idCampo} className={`${BASE_CONTROL} ${borde(error)}`} {...props} />
    </Envoltura>
  )
}

// `opciones` = [{ valor, etiqueta }] o strings. También admite <option> como children.
export function Select({
  etiqueta, label, ayuda, hint, error, obligatorio, opciones, placeholder,
  className = '', id, children, ...props
}) {
  const auto = useId()
  const idCampo = id || auto
  const lista = (opciones || []).map((o) =>
    (typeof o === 'object' && o !== null ? o : { valor: o, etiqueta: String(o) }))
  return (
    <Envoltura
      etiqueta={elegir(etiqueta, label)}
      ayuda={elegir(ayuda, hint)}
      error={error}
      obligatorio={elegir(obligatorio, props.required, false)}
      htmlFor={idCampo}
      className={className}
    >
      <select id={idCampo} className={`${BASE_CONTROL} ${borde(error)}`} {...props}>
        {placeholder && <option value="">{placeholder}</option>}
        {lista.map((o) => (
          <option key={String(elegir(o.valor, o.value))} value={elegir(o.valor, o.value)} disabled={o.deshabilitada}>
            {elegir(o.etiqueta, o.label)}
          </option>
        ))}
        {children}
      </select>
    </Envoltura>
  )
}

export function Textarea({
  etiqueta, label, ayuda, hint, error, obligatorio, filas, rows, mono = false,
  className = '', id, ...props
}) {
  const auto = useId()
  const idCampo = id || auto
  return (
    <Envoltura
      etiqueta={elegir(etiqueta, label)}
      ayuda={elegir(ayuda, hint)}
      error={error}
      obligatorio={elegir(obligatorio, props.required, false)}
      htmlFor={idCampo}
      className={className}
    >
      <textarea
        id={idCampo}
        rows={elegir(filas, rows, 6)}
        className={`${BASE_CONTROL} leading-relaxed resize-y ${mono ? 'font-mono text-[12px]' : ''} ${borde(error)}`}
        {...props}
      />
    </Envoltura>
  )
}

export function Interruptor({
  activo, checked, onChange, etiqueta, label, ayuda, hint, disabled = false, className = '',
}) {
  const encendido = Boolean(elegir(activo, checked, false))
  const texto = elegir(etiqueta, label)
  const pie = elegir(ayuda, hint)
  return (
    <div className={className}>
      <button
        type="button"
        role="switch"
        aria-checked={encendido}
        disabled={disabled}
        onClick={() => onChange?.(!encendido)}
        className="flex items-center gap-2.5 text-sm text-ink2 disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <span
          className={`shrink-0 rounded-full p-0.5 transition-colors ${encendido ? 'bg-gold' : 'bg-border'}`}
          style={{ height: 22, width: 40 }}
        >
          <span
            className="block h-full aspect-square rounded-full bg-bg transition-transform"
            style={{ transform: encendido ? 'translateX(18px)' : 'translateX(0)' }}
          />
        </span>
        {texto}
      </button>
      {pie && <span className="block text-[11px] text-mut mt-1">{pie}</span>}
    </div>
  )
}

/* ============================================================
   Modal
   ============================================================ */
export function Modal({
  titulo, title, descripcion, description, onCerrar, onClose,
  ancho = 'max-w-lg', pie = null, footer = null, children,
}) {
  const cerrar = elegir(onCerrar, onClose)
  const encabezado = elegir(titulo, title)
  const bajada = elegir(descripcion, description)
  const zocalo = elegir(pie, footer)

  useEffect(() => {
    const alPulsar = (e) => { if (e.key === 'Escape') cerrar?.() }
    const previo = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', alPulsar)
    return () => {
      document.body.style.overflow = previo
      window.removeEventListener('keydown', alPulsar)
    }
  }, [cerrar])

  return (
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 grid place-items-center p-4 animate-fade"
      onClick={() => cerrar?.()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`bg-card border border-border rounded-2xl w-full ${ancho} max-h-[88vh] flex flex-col animate-in`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-6 pt-5 pb-4 border-b border-border/70">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">{encabezado}</h2>
            {bajada && <p className="text-xs text-mut mt-1">{bajada}</p>}
          </div>
          <button type="button" onClick={() => cerrar?.()} className="text-mut hover:text-ink shrink-0" aria-label="Cerrar">
            <X size={18} />
          </button>
        </div>
        <div className="px-6 py-5 overflow-y-auto">{children}</div>
        {zocalo && <div className="px-6 py-4 border-t border-border/70 flex justify-end gap-2">{zocalo}</div>}
      </div>
    </div>
  )
}

/* ============================================================
   Confirmación
   ============================================================ */
export function Confirmar({
  titulo, title, mensaje, message,
  textoConfirmar, confirmText, textoCancelar, cancelText,
  peligro, danger, ocupado, loading,
  onConfirmar, onConfirm, onCancelar, onCancel,
  children,
}) {
  const confirmar = elegir(onConfirmar, onConfirm)
  const cancelar = elegir(onCancelar, onCancel)
  const texto = elegir(mensaje, message)
  const esPeligro = Boolean(elegir(peligro, danger, false))
  const trabajando = Boolean(elegir(ocupado, loading, false))
  return (
    <Modal
      titulo={elegir(titulo, title, '¿Seguro?')}
      ancho="max-w-md"
      onCerrar={cancelar}
      pie={
        <>
          <Boton variante="secundario" onClick={cancelar} disabled={trabajando}>
            {elegir(textoCancelar, cancelText, 'Cancelar')}
          </Boton>
          <Boton variante={esPeligro ? 'peligro' : 'primario'} onClick={confirmar} cargando={trabajando}>
            {elegir(textoConfirmar, confirmText, 'Confirmar')}
          </Boton>
        </>
      }
    >
      {texto && <p className="text-sm text-ink2 leading-relaxed">{texto}</p>}
      {children}
    </Modal>
  )
}

/* ============================================================
   Tabla
   ============================================================ */
const CLASE_TH = 'text-left text-[11px] uppercase tracking-wide text-mut font-medium px-3 py-2 whitespace-nowrap'
const CLASE_TD = 'px-3 py-2.5 text-sm border-t border-border/60 align-middle'

// Dos formas de usarla:
//   1) datos: <Tabla columnas={[{ titulo:'Correo', clave:'email' }]} filas={lista} claveFila={(f)=>f.id} />
//   2) libre: <Tabla columnas={['Fecha','Para']}>{filas.map(f => <tr key={f.id}>…</tr>)}</Tabla>
export function Tabla({
  columnas = [],
  columns,
  filas = null,
  datos = null,
  claveFila,
  onFila,
  cargando = false,
  vacio = 'No hay nada que mostrar',
  className = '',
  children,
}) {
  const cols = (columnas.length ? columnas : (columns || []))
    .map((c) => (typeof c === 'object' && c !== null ? c : { titulo: String(c) }))

  const cabecera = cols.length > 0 && (
    <thead>
      <tr>
        {cols.map((c, j) => (
          <th key={c.clave || c.titulo || j} className={`${CLASE_TH} ${c.claseCabecera || c.className || ''}`}>
            {c.titulo}
          </th>
        ))}
      </tr>
    </thead>
  )

  // Si las filas vienen como children hay que respetar la estructura de la tabla:
  // <tr> suelto dentro de <table> no es HTML válido y React se queja.
  if (children) {
    const hijos = Children.toArray(children)
    const traeEstructura = hijos.some(
      (h) => isValidElement(h) && ['thead', 'tbody', 'tfoot'].includes(h.type))
    return (
      <div className={`overflow-x-auto rounded-2xl border border-border bg-card ${className}`}>
        <table className="w-full">
          {!traeEstructura && cabecera}
          {traeEstructura ? children : <tbody>{children}</tbody>}
        </table>
      </div>
    )
  }

  const lista = filas || datos || []

  const celda = (fila, col, j) => {
    if (col.render) return col.render(fila, j)
    if (Array.isArray(fila)) return fila[j]
    if (col.clave) return fila[col.clave]
    return null
  }

  return (
    <div className={`overflow-x-auto rounded-2xl border border-border bg-card ${className}`}>
      <table className="w-full">
        {cabecera}
        <tbody>
          {cargando && (
            <tr>
              <td colSpan={cols.length || 1} className={`${CLASE_TD} text-center`}>
                <Spinner texto="Cargando…" />
              </td>
            </tr>
          )}
          {!cargando && lista.length === 0 && (
            <tr>
              <td colSpan={cols.length || 1} className={`${CLASE_TD} text-center text-mut py-10`}>
                {vacio}
              </td>
            </tr>
          )}
          {!cargando && lista.map((fila, i) => (
            <tr
              key={claveFila ? claveFila(fila, i) : (fila?.id ?? i)}
              onClick={onFila ? () => onFila(fila, i) : undefined}
              className={onFila ? 'cursor-pointer hover:bg-card2/70 transition-colors' : ''}
            >
              {cols.map((c, j) => (
                <td key={c.clave || c.titulo || j} className={`${CLASE_TD} ${c.className || ''}`}>
                  {celda(fila, c, j)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/* ============================================================
   Badge — cubre los estados del SPEC §4 y los demás del modelo
   ============================================================ */
const NEUTRO = 'bg-mut/10 text-ink2 border-border'
const OK = 'bg-ok/10 text-ok border-ok/30'
const AVISO = 'bg-warn/10 text-warn border-warn/30'
const MALO = 'bg-bad/10 text-bad border-bad/30'
const ORO = 'bg-gold/10 text-gold border-gold/30'
const INFO = 'bg-info/10 text-info border-info/30'

const ESTADOS = {
  // §4 — ciclo de vida del mensaje
  encolado: { etiqueta: 'En cola', clase: NEUTRO },
  reintento: { etiqueta: 'Reintento', clase: AVISO },
  enviando: { etiqueta: 'Enviando', clase: ORO },
  enviado: { etiqueta: 'Enviado', clase: INFO },
  diferido: { etiqueta: 'Diferido', clase: AVISO },
  entregado: { etiqueta: 'Entregado', clase: OK },
  rebotado: { etiqueta: 'Rebotado', clase: MALO },
  spam: { etiqueta: 'Spam', clase: MALO },
  fallido: { etiqueta: 'Fallido', clase: MALO },
  suprimido: { etiqueta: 'Suprimido', clase: NEUTRO },

  // marcas de seguimiento (no son estados, pero se pintan igual)
  abierto: { etiqueta: 'Abierto', clase: INFO },
  clicado: { etiqueta: 'Con clic', clase: INFO },

  // proveedores
  ok: { etiqueta: 'Correcto', clase: OK },
  error: { etiqueta: 'Error', clase: MALO },
  sin_probar: { etiqueta: 'Sin probar', clase: NEUTRO },
  smtp: { etiqueta: 'SMTP', clase: NEUTRO },
  brevo: { etiqueta: 'Brevo', clase: ORO },

  // conexiones
  connected: { etiqueta: 'Conectada', clase: OK },
  uninstalled: { etiqueta: 'Desinstalada', clase: NEUTRO },

  // remitentes y dominios
  verificado: { etiqueta: 'Verificado', clase: OK },
  no_verificado: { etiqueta: 'No verificado', clase: AVISO },
  desconocido: { etiqueta: 'Sin comprobar', clase: NEUTRO },
  pendiente: { etiqueta: 'Pendiente', clase: AVISO },

  // origen del mensaje
  nodo_plantilla: { etiqueta: 'Nodo plantilla', clase: ORO },
  nodo_personalizado: { etiqueta: 'Nodo personalizado', clase: ORO },
  relay: { etiqueta: 'Relay SMTP', clase: INFO },

  // origen del remitente
  panel: { etiqueta: 'Panel', clase: NEUTRO },
  admin: { etiqueta: 'Agencia', clase: ORO },
  auto: { etiqueta: 'Automático', clase: INFO },

  // motivos de supresión
  rebote_duro: { etiqueta: 'Rebote duro', clase: MALO },
  baja: { etiqueta: 'Baja', clase: NEUTRO },
  manual: { etiqueta: 'Manual', clase: NEUTRO },

  // varios
  activo: { etiqueta: 'Activo', clase: OK },
  inactivo: { etiqueta: 'Inactivo', clase: NEUTRO },
  asignado: { etiqueta: 'Cedido por la agencia', clase: ORO },
  global: { etiqueta: 'Global', clase: ORO },
  defecto: { etiqueta: 'Por defecto', clase: ORO },
}

export function Badge({ estado, status, texto, label, titulo, title, className = '', children }) {
  const clave = String(elegir(estado, status, '') || '')
  const def = ESTADOS[clave] || { etiqueta: elegir(texto, label, clave) || '—', clase: NEUTRO }
  return (
    <span
      title={elegir(titulo, title) || undefined}
      className={`inline-block text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${def.clase} ${className}`}
    >
      {children || elegir(texto, label) || def.etiqueta}
    </span>
  )
}

/* ============================================================
   Aviso
   ============================================================ */
const AVISOS = {
  info: { clase: 'bg-card2 border-border text-ink2', icono: Info, color: 'text-info' },
  ok: { clase: 'bg-ok/5 border-ok/25 text-ink2', icono: CheckCircle2, color: 'text-ok' },
  aviso: { clase: 'bg-warn/5 border-warn/25 text-ink2', icono: AlertTriangle, color: 'text-warn' },
  warn: { clase: 'bg-warn/5 border-warn/25 text-ink2', icono: AlertTriangle, color: 'text-warn' },
  error: { clase: 'bg-bad/5 border-bad/25 text-ink2', icono: XCircle, color: 'text-bad' },
}

export function Aviso({ tipo, variant, type, titulo, title, onCerrar, onClose, className = '', children }) {
  const def = AVISOS[elegir(tipo, variant, type, 'info')] || AVISOS.info
  const Icono = def.icono
  const encabezado = elegir(titulo, title)
  const cerrar = elegir(onCerrar, onClose)
  return (
    <div className={`flex items-start gap-3 border rounded-xl px-4 py-3 text-sm ${def.clase} ${className}`}>
      <Icono size={16} className={`${def.color} shrink-0 mt-0.5`} />
      <div className="min-w-0 flex-1">
        {encabezado && <div className="font-medium text-ink mb-0.5">{encabezado}</div>}
        <div className="leading-relaxed break-words">{children}</div>
      </div>
      {cerrar && (
        <button type="button" onClick={cerrar} className="text-mut hover:text-ink shrink-0" aria-label="Cerrar aviso">
          <X size={15} />
        </button>
      )}
    </div>
  )
}

/* ============================================================
   Spinner
   ============================================================ */
export function Spinner({ texto, label, tamano, size, centrado = false, className = '' }) {
  const medida = elegir(tamano, size, 16)
  const contenido = (
    <span className={`inline-flex items-center gap-2 text-sm text-mut ${className}`}>
      <Loader2 size={medida} className="spin text-gold" />
      {elegir(texto, label)}
    </span>
  )
  if (!centrado) return contenido
  return <div className="w-full grid place-items-center py-10">{contenido}</div>
}

/* ============================================================
   Copiar al portapapeles
   ============================================================ */
export function Copiar({ texto, value, etiqueta, label, soloIcono = false, className = '' }) {
  const { copiar, copiado } = useCopiar()
  const contenido = elegir(texto, value, '')
  const Icono = copiado ? Check : Copy
  return (
    <button
      type="button"
      onClick={() => copiar(contenido)}
      title={copiado ? 'Copiado' : 'Copiar'}
      aria-label={copiado ? 'Copiado' : 'Copiar'}
      className={`inline-flex items-center gap-1.5 text-xs rounded-lg px-2 py-1 border transition-colors ${
        copiado ? 'border-ok/40 text-ok bg-ok/10' : 'border-border text-ink2 hover:text-gold hover:border-gold/40'
      } ${className}`}
    >
      <Icono size={13} />
      {!soloIcono && (copiado ? 'Copiado' : elegir(etiqueta, label, 'Copiar'))}
    </button>
  )
}
