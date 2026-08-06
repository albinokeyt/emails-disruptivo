import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api.js'
import { Aviso, Boton, Campo, Interruptor, Select, Spinner } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

// las asignaciones pueden llegar como filas {location_id} o como ids sueltos
const idsDe = (d) =>
  lista(d, 'asignaciones').map((a) => String(typeof a === 'object' ? a.location_id : a))

export default function Asignaciones() {
  const [params, setParams] = useSearchParams()
  const [proveedores, setProveedores] = useState(null)
  const [subcuentas, setSubcuentas] = useState([])
  const [asignadas, setAsignadas] = useState(null)
  const [error, setError] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [ocupada, setOcupada] = useState(null)

  const proveedorId = params.get('proveedor') || ''

  useEffect(() => {
    Promise.all([api.get('/api/admin/proveedores'), api.get('/api/admin/subcuentas')])
      .then(([p, s]) => {
        setProveedores(lista(p, 'proveedores'))
        setSubcuentas(lista(s, 'subcuentas'))
      })
      .catch((e) => {
        setError(e.message)
        setProveedores([])
      })
  }, [])

  const cargarAsignaciones = useCallback(async (id) => {
    if (!id) {
      setAsignadas(null)
      return
    }
    setAsignadas(null)
    try {
      const d = await api.get(`/api/admin/proveedores/${id}/asignaciones`)
      setAsignadas(new Set(idsDe(d)))
      setError('')
    } catch (e) {
      setError(e.message)
      setAsignadas(new Set())
    }
  }, [])

  useEffect(() => {
    cargarAsignaciones(proveedorId)
  }, [cargarAsignaciones, proveedorId])

  const elegir = (e) => {
    const v = e.target.value
    setParams(v ? { proveedor: v } : {}, { replace: true })
  }

  const alternar = async (s, activar) => {
    setOcupada(s.location_id)
    const siguiente = new Set(asignadas)
    if (activar) siguiente.add(String(s.location_id))
    else siguiente.delete(String(s.location_id))
    setAsignadas(siguiente)
    try {
      if (activar) await api.post(`/api/admin/proveedores/${proveedorId}/asignaciones`, { location_id: s.location_id })
      else
        await api.del(
          `/api/admin/proveedores/${proveedorId}/asignaciones/${encodeURIComponent(s.location_id)}`,
        )
      setError('')
    } catch (err) {
      setError(err.message)
      await cargarAsignaciones(proveedorId)
    } finally {
      setOcupada(null)
    }
  }

  const filtradas = useMemo(() => {
    const q = busqueda.trim().toLowerCase()
    if (!q) return subcuentas
    return subcuentas.filter(
      (s) =>
        String(s.name || '').toLowerCase().includes(q) || String(s.location_id || '').toLowerCase().includes(q),
    )
  }, [subcuentas, busqueda])

  if (proveedores === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  const proveedor = proveedores.find((p) => String(p.id) === String(proveedorId))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Asignaciones</h1>
        <p className="text-sm text-ink2 mt-1">
          Elige un proveedor de la agencia y márcale las subcuentas que podrán usarlo. Ellas lo verán en solo lectura.
        </p>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      {proveedores.length === 0 ? (
        <div className={TARJETA}>
          <p className="text-sm text-mut py-8 text-center">
            No hay proveedores de agencia todavía.{' '}
            <Link to="/admin/proveedores" className="text-gold hover:underline">
              Crear el primero
            </Link>
            .
          </p>
        </div>
      ) : (
        <>
          <div className={TARJETA}>
            <Select label="Proveedor" value={proveedorId} onChange={elegir}>
              <option value="">Elige un proveedor…</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type})
                </option>
              ))}
            </Select>
            {proveedor && (
              <p className="text-[11px] text-mut mt-2">
                {proveedor.type === 'smtp'
                  ? `SMTP ${proveedor.config?.host || ''}:${proveedor.config?.port ?? ''}`
                  : 'Brevo (API)'}
                {proveedor.daily_limit ? ` · límite diario ${proveedor.daily_limit}` : ''}
              </p>
            )}
          </div>

          {!proveedorId ? (
            <div className={TARJETA}>
              <p className="text-sm text-mut py-8 text-center">Elige un proveedor para ver y cambiar sus asignaciones.</p>
            </div>
          ) : asignadas === null ? (
            <div className="py-16 grid place-items-center">
              <Spinner />
            </div>
          ) : (
            <div className={TARJETA}>
              <div className="flex items-center justify-between gap-4 mb-4 flex-wrap">
                <div className="text-sm font-semibold">
                  Subcuentas con acceso{' '}
                  <span className="text-mut font-normal">
                    ({asignadas.size} de {subcuentas.length})
                  </span>
                </div>
                <div className="w-56">
                  <Campo placeholder="Buscar subcuenta…" value={busqueda} onChange={(e) => setBusqueda(e.target.value)} />
                </div>
              </div>

              {subcuentas.length === 0 ? (
                <p className="text-sm text-mut py-8 text-center">Todavía no hay subcuentas con la app instalada.</p>
              ) : filtradas.length === 0 ? (
                <p className="text-sm text-mut py-8 text-center">Ninguna subcuenta coincide con la búsqueda.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {filtradas.map((s) => (
                    <li key={s.location_id} className="flex items-center justify-between gap-4 py-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{s.name || 'Sin nombre'}</div>
                        <div className="text-[11px] text-mut font-mono truncate">{s.location_id}</div>
                      </div>
                      <div className={ocupada === s.location_id ? 'opacity-50 pointer-events-none' : ''}>
                        <Interruptor
                          checked={asignadas.has(String(s.location_id))}
                          onChange={(v) => alternar(s, v)}
                          label={asignadas.has(String(s.location_id)) ? 'Cedido' : 'Sin ceder'}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-2">Qué ve la subcuenta</div>
        <p className="text-sm text-ink2">
          El proveedor cedido aparece en su pantalla de Proveedores, en una sección aparte y sin opción de editarlo ni
          eliminarlo. Puede asociarlo a sus remitentes y usarlo en los nodos del workflow y en el relay, pero nunca ve las
          credenciales. Al retirar la asignación, sus remitentes se quedan sin proveedor y dejarán de enviar.
        </p>
      </div>

      <div className="flex justify-end">
        <Boton variant="ghost" onClick={() => cargarAsignaciones(proveedorId)} disabled={!proveedorId}>
          Recargar
        </Boton>
      </div>
    </div>
  )
}
