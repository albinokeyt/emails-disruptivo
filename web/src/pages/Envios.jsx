import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Aviso, Badge, Boton, Campo, Modal, Select, Spinner, Tabla } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'
const PAGINA = 50

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const fecha = (d) =>
  d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

export const ESTADOS = [
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

export const ORIGENES = [
  ['nodo_plantilla', 'Nodo con plantilla'],
  ['nodo_personalizado', 'Nodo personalizado'],
  ['relay', 'Relay SMTP'],
]

// Nombres legibles de los eventos del histórico; si llega uno nuevo se muestra tal cual.
const EVENTOS = {
  encolado: 'Encolado',
  enviando: 'Enviando',
  enviado: 'Aceptado por el proveedor',
  entregado: 'Entregado',
  entrega_confirmada: 'Entrega confirmada por actividad',
  entrega_inferida: 'Entregado (inferido)',
  diferido: 'Diferido por el destinatario',
  apertura: 'Abierto',
  clic: 'Clic en un enlace',
  rebote: 'Rebote duro', // así llama el DSN capturado por VERP a su rebote duro (handler.js)
  rebote_duro: 'Rebote duro',
  rebote_blando: 'Rebote blando',
  rebote_desconocido: 'Aviso de rebote no reconocido',
  spam: 'Marcado como spam',
  baja: 'Baja del destinatario',
  fallido: 'Fallo permanente',
  suprimido: 'Bloqueado por la lista de supresión',
  reintento: 'Reintento programado',
  error: 'Error',
}

// Eventos automáticos (Apple MPP, proxys, escáneres): la columna `automatico` viene del backend;
// el fallback a data cubre los eventos guardados antes de la migración 002.
const esAutomatico = (ev) => ev?.automatico === true || ev?.data?.automatico === true || ev?.data?.maquinal === true

const VACIOS = { estado: '', origen: '', desde: '', hasta: '', q: '' }

export function Detalle({ id, ruta, onClose }) {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let vivo = true
    api
      .get(`${ruta}/${id}`)
      .then((d) => vivo && setDatos(d))
      .catch((e) => vivo && setError(e.message))
    return () => {
      vivo = false
    }
  }, [id, ruta])

  const m = datos?.mensaje ?? datos?.envio ?? datos
  const eventos = lista(datos?.eventos ?? datos?.events, 'eventos')

  // «Entregado (inferido)»: pasaron las horas de inferencia sin rebote, pero nadie lo confirmó
  // (ni webhook del proveedor ni actividad real). Se distingue del confirmado en el panel.
  const entregaInferida =
    m?.status === 'entregado' &&
    eventos.some((ev) => ev.event === 'entrega_inferida') &&
    !eventos.some((ev) => ev.event === 'entregado' || ev.event === 'entrega_confirmada')

  const dato = (etiqueta, valor) => (
    <div>
      <div className="text-[11px] text-mut uppercase tracking-wide">{etiqueta}</div>
      <div className="text-sm text-ink2 break-words">{valor || '—'}</div>
    </div>
  )

  return (
    <Modal title="Detalle del envío" onClose={onClose}>
      {error && <Aviso variant="error">{error}</Aviso>}
      {!datos && !error && (
        <div className="py-10 grid place-items-center">
          <Spinner />
        </div>
      )}
      {m && (
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <Badge status={m.status} />
            {entregaInferida && (
              <Badge
                texto="inferido"
                titulo="Entrega inferida: pasó el plazo sin rebote ni spam. No es una confirmación del proveedor."
              />
            )}
            <span className="text-xs text-mut">#{m.id}</span>
            <span className="text-xs text-mut">{fecha(m.created_at)}</span>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {dato('Para', m.to_name ? `${m.to_name} <${m.to_email}>` : m.to_email)}
            {dato('Origen', ORIGENES.find(([v]) => v === m.origin)?.[1] || m.origin)}
            {dato('Asunto', m.subject)}
            {dato('Responder a', m.reply_to)}
            {dato('CC', Array.isArray(m.cc) ? m.cc.join(', ') : m.cc)}
            {dato('CCO', Array.isArray(m.bcc) ? m.bcc.join(', ') : m.bcc)}
            {dato('Enviado', fecha(m.sent_at))}
            {dato('Intentos', m.attempts)}
            {dato('Primera apertura real', fecha(m.opened_at))}
            {dato('Primer clic real', fecha(m.clicked_at))}
            {dato('ID en el proveedor', m.provider_message_id)}
            {dato('Correlación', m.correlation_id)}
          </div>

          {m.last_error && <Aviso variant="error">{m.last_error}</Aviso>}

          <div>
            <div className="text-sm font-semibold mb-2">Histórico</div>
            {eventos.length === 0 ? (
              <p className="text-xs text-mut">Todavía no hay eventos registrados para este mensaje.</p>
            ) : (
              <ol className="space-y-2.5 border-l border-border pl-4">
                {eventos.map((ev) => {
                  const auto = esAutomatico(ev)
                  return (
                    <li key={ev.id ?? `${ev.event}-${ev.occurred_at}`} className="relative">
                      <span className={`absolute -left-[21px] top-1.5 w-2 h-2 rounded-full ${auto ? 'bg-mut/40' : 'bg-gold'}`} />
                      <div className={`text-sm flex items-center gap-2 ${auto ? 'text-mut' : ''}`}>
                        {EVENTOS[ev.event] || ev.event}
                        {auto && (
                          <Badge
                            texto="automático"
                            titulo="Evento de un proxy o escáner (Apple MPP, filtros de seguridad…), no de una persona. No cuenta en las métricas."
                            className="text-[10px]"
                          />
                        )}
                      </div>
                      <div className="text-[11px] text-mut">{fecha(ev.occurred_at)}</div>
                      {ev.data?.reason && <div className="text-[11px] text-bad">{ev.data.reason}</div>}
                      {ev.data?.url && (
                        <div className="text-[11px] text-ink2 truncate" title={ev.data.url}>
                          {ev.data.url}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ol>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}

export default function Envios() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')
  const [filtros, setFiltros] = useState(VACIOS)
  const [aplicados, setAplicados] = useState(VACIOS)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(null)
  const [detalle, setDetalle] = useState(null)

  const cargar = useCallback(
    async (off, f) => {
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(f)) if (v) params.set(k, v)
      // el backend pagina con «limite» y «pagina» (location.js → paginar), no con limit/offset:
      // con los nombres de antes caía siempre a la página 1 y «Siguientes» no avanzaba nada
      params.set('limite', String(PAGINA))
      params.set('pagina', String(Math.floor(off / PAGINA) + 1))
      setDatos(null)
      try {
        const d = await api.get(`/api/loc/envios?${params}`)
        setDatos(lista(d, 'envios'))
        setTotal(Number.isFinite(Number(d?.total)) ? Number(d.total) : null)
        setOffset(off)
        setError('')
      } catch (e) {
        setError(e.message)
        setDatos([])
        setTotal(null)
      }
    },
    [],
  )

  useEffect(() => {
    cargar(0, aplicados)
  }, [cargar, aplicados])

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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Envíos</h1>
        <p className="text-sm text-ink2 mt-1">
          Todo el correo de esta subcuenta, venga de un nodo del workflow o del relay SMTP.
        </p>
      </div>

      <form onSubmit={buscar} className={TARJETA}>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
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
            {hayFiltros ? 'Ningún envío coincide con esos filtros.' : 'Todavía no se ha enviado ningún correo.'}
          </p>
        </div>
      ) : (
        <div className={TARJETA}>
          <Tabla columnas={['Fecha', 'Para', 'Asunto', 'Origen', 'Estado', '']}>
            {datos.map((m) => (
              <tr key={m.id}>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 whitespace-nowrap">
                  {fecha(m.created_at)}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  {m.to_email}
                  {m.to_name && <div className="text-[11px] text-mut">{m.to_name}</div>}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                  <div className="max-w-72 truncate" title={m.subject}>
                    {m.subject}
                  </div>
                  {m.last_error && (
                    <div className="text-[11px] text-bad max-w-72 truncate" title={m.last_error}>
                      {m.last_error}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 text-xs">
                  {ORIGENES.find(([v]) => v === m.origin)?.[1] || m.origin}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <Badge status={m.status} />
                  {/* opened_at/clicked_at solo se marcan con eventos REALES (SPEC §11.1): los
                      automáticos (proxys, escáneres) quedan en el detalle con su badge */}
                  {(m.opened_at || m.clicked_at) && (
                    <div className="text-[11px] text-mut" title="Solo actividad real: sin proxys ni escáneres">
                      {m.clicked_at ? 'Con clic' : 'Abierto'}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right">
                  <button type="button" className="text-xs text-gold hover:underline" onClick={() => setDetalle(m.id)}>
                    Ver detalle
                  </button>
                </td>
              </tr>
            ))}
          </Tabla>

          <div className="flex justify-between items-center mt-4">
            <Boton variant="ghost" disabled={offset === 0} onClick={() => cargar(Math.max(0, offset - PAGINA), aplicados)}>
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

      {detalle && <Detalle id={detalle} ruta="/api/loc/envios" onClose={() => setDetalle(null)} />}
    </div>
  )
}
