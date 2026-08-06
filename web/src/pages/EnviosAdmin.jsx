import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Aviso, Badge, Boton, Campo, Modal, Select, Spinner, Tabla } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'
const PAGINA = 50

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const fecha = (d) =>
  d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

const ESTADOS = [
  ['encolado', 'En cola'],
  ['reintento', 'Reintento'],
  ['enviando', 'Enviando'],
  ['enviado', 'Enviado'],
  ['diferido', 'Diferido'],
  ['entregado', 'Entregado'],
  ['rebotado', 'Rebotado'],
  ['spam', 'Spam'],
  ['fallido', 'Fallido'],
  ['suprimido', 'Suprimido'],
]

const ORIGENES = [
  ['nodo_plantilla', 'Nodo con plantilla'],
  ['nodo_personalizado', 'Nodo personalizado'],
  ['relay', 'Relay SMTP'],
]

const VACIOS = { location_id: '', estado: '', origen: '', desde: '', hasta: '', q: '' }

export default function EnviosAdmin() {
  const [datos, setDatos] = useState(null)
  const [subcuentas, setSubcuentas] = useState([])
  const [error, setError] = useState('')
  const [filtros, setFiltros] = useState(VACIOS)
  const [aplicados, setAplicados] = useState(VACIOS)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(null)
  const [detalle, setDetalle] = useState(null)

  const cargar = useCallback(async (off, f) => {
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(f)) if (v) params.set(k, v)
    // el backend pagina con «limite» y «pagina» (location.js → paginar), no con limit/offset
    params.set('limite', String(PAGINA))
    params.set('pagina', String(Math.floor(off / PAGINA) + 1))
    setDatos(null)
    try {
      const d = await api.get(`/api/admin/envios?${params}`)
      setDatos(lista(d, 'envios'))
      setTotal(Number.isFinite(Number(d?.total)) ? Number(d.total) : null)
      setOffset(off)
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
      setTotal(null)
    }
  }, [])

  useEffect(() => {
    cargar(0, aplicados)
  }, [cargar, aplicados])

  useEffect(() => {
    api
      .get('/api/admin/subcuentas')
      .then((d) => setSubcuentas(lista(d, 'subcuentas')))
      .catch(() => setSubcuentas([]))
  }, [])

  const set = (k) => (e) => setFiltros((f) => ({ ...f, [k]: e.target.value }))

  const buscar = (e) => {
    e.preventDefault()
    setAplicados(filtros)
  }

  const limpiar = () => {
    setFiltros(VACIOS)
    setAplicados(VACIOS)
  }

  const hayFiltros = Object.values(aplicados).some(Boolean)
  const nombreSubcuenta = (id) =>
    subcuentas.find((s) => String(s.location_id) === String(id))?.name || id || '—'

  const dato = (etiqueta, valor) => (
    <div>
      <div className="text-[11px] text-mut uppercase tracking-wide">{etiqueta}</div>
      <div className="text-sm text-ink2 break-words">{valor || '—'}</div>
    </div>
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Envíos</h1>
        <p className="text-sm text-ink2 mt-1">Todo el correo de todas las subcuentas, sea cual sea su origen.</p>
      </div>

      <form onSubmit={buscar} className={TARJETA}>
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
          <Select label="Subcuenta" value={filtros.location_id} onChange={set('location_id')}>
            <option value="">Todas</option>
            {subcuentas.map((s) => (
              <option key={s.location_id} value={s.location_id}>
                {s.name || s.location_id}
              </option>
            ))}
          </Select>
          <Select label="Estado" value={filtros.estado} onChange={set('estado')}>
            <option value="">Todos</option>
            {ESTADOS.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </Select>
          <Select label="Origen" value={filtros.origen} onChange={set('origen')}>
            <option value="">Todos</option>
            {ORIGENES.map(([v, t]) => (
              <option key={v} value={v}>
                {t}
              </option>
            ))}
          </Select>
          <Campo label="Desde" type="date" value={filtros.desde} onChange={set('desde')} />
          <Campo label="Hasta" type="date" value={filtros.hasta} onChange={set('hasta')} />
          <Campo label="Buscar" placeholder="Correo o asunto" value={filtros.q} onChange={set('q')} />
        </div>
        <div className="flex justify-end gap-2 mt-4">
          {hayFiltros && (
            <Boton type="button" variant="ghost" onClick={limpiar}>
              Limpiar
            </Boton>
          )}
          <Boton type="submit">Filtrar</Boton>
        </div>
      </form>

      {error && <Aviso variant="error">{error}</Aviso>}

      {datos === null ? (
        <div className="py-16 grid place-items-center">
          <Spinner />
        </div>
      ) : datos.length === 0 ? (
        <div className={TARJETA}>
          <p className="text-sm text-mut py-10 text-center">
            {hayFiltros ? 'Ningún envío coincide con esos filtros.' : 'Todavía no hay envíos registrados.'}
          </p>
        </div>
      ) : (
        <div className={TARJETA}>
          <Tabla columnas={['Fecha', 'Subcuenta', 'Para', 'Asunto', 'Origen', 'Estado', '']}>
            {datos.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 whitespace-nowrap">
                  {fecha(m.created_at)}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                  <div className="max-w-40 truncate">{nombreSubcuenta(m.location_id)}</div>
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">{m.to_email}</td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                  <div className="max-w-64 truncate" title={m.subject}>
                    {m.subject}
                  </div>
                  {m.last_error && (
                    <div className="text-[11px] text-bad max-w-64 truncate" title={m.last_error}>
                      {m.last_error}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 text-xs">
                  {ORIGENES.find(([v]) => v === m.origin)?.[1] || m.origin}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <Badge status={m.status} />
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right">
                  <button type="button" className="text-xs text-gold hover:underline" onClick={() => setDetalle(m)}>
                    Ver detalle
                  </button>
                </td>
              </tr>
            ))}
          </Tabla>

          <div className="flex justify-between items-center mt-4">
            <Boton
              variant="ghost"
              disabled={offset === 0}
              onClick={() => cargar(Math.max(0, offset - PAGINA), aplicados)}
            >
              ← Anteriores
            </Boton>
            <span className="text-xs text-mut">
              {offset + 1} – {offset + datos.length}
              {total !== null && ` de ${total}`}
            </span>
            <Boton
              variant="ghost"
              disabled={datos.length < PAGINA || (total !== null && offset + datos.length >= total)}
              onClick={() => cargar(offset + PAGINA, aplicados)}
            >
              Siguientes →
            </Boton>
          </div>
        </div>
      )}

      {detalle && (
        <Modal title="Detalle del envío" onClose={() => setDetalle(null)}>
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              <Badge status={detalle.status} />
              <span className="text-xs text-mut">#{detalle.id}</span>
              <span className="text-xs text-mut">{fecha(detalle.created_at)}</span>
            </div>

            <div className="grid grid-cols-2 gap-4">
              {dato('Subcuenta', nombreSubcuenta(detalle.location_id))}
              {dato('Location ID', detalle.location_id)}
              {dato('Para', detalle.to_name ? `${detalle.to_name} <${detalle.to_email}>` : detalle.to_email)}
              {dato('Origen', ORIGENES.find(([v]) => v === detalle.origin)?.[1] || detalle.origin)}
              {dato('Asunto', detalle.subject)}
              {dato('Responder a', detalle.reply_to)}
              {dato('Enviado', fecha(detalle.sent_at))}
              {dato('Intentos', detalle.attempts)}
              {dato('Primera apertura', fecha(detalle.opened_at))}
              {dato('Primer clic', fecha(detalle.clicked_at))}
              {dato('ID en el proveedor', detalle.provider_message_id)}
              {dato('Correlación', detalle.correlation_id)}
            </div>

            {detalle.last_error && <Aviso variant="error">{detalle.last_error}</Aviso>}

            <p className="text-[11px] text-mut">
              El histórico completo de eventos de este mensaje se ve desde el panel de la propia subcuenta.
            </p>

            <div className="flex justify-end">
              <Boton onClick={() => setDetalle(null)}>Cerrar</Boton>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
