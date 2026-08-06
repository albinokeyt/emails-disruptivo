import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
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
} from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

const ORIGEN = { panel: 'Alta manual', admin: 'Creado por la agencia', auto: 'Detectado por el relay' }

const VACIO = { location_id: '', email: '', name: '', reply_to: '', provider_id: '', is_default: false }

function validar(f) {
  const errores = []
  if (!f.location_id) errores.push('Elige la subcuenta a la que pertenece el remitente.')
  if (!CORREO.test(f.email.trim())) errores.push('El correo del remitente no es válido.')
  if (!f.name.trim()) errores.push('El nombre visible es obligatorio.')
  if (/[\r\n]/.test(f.name)) errores.push('El nombre no puede contener saltos de línea.')
  if (f.reply_to && !CORREO.test(f.reply_to.trim())) errores.push('La dirección de respuesta no es válida.')
  if (!f.provider_id) errores.push('Elige el proveedor por el que saldrá este remitente.')
  return errores
}

export default function RemitentesAdmin() {
  const [datos, setDatos] = useState(null)
  const [subcuentas, setSubcuentas] = useState([])
  const [proveedores, setProveedores] = useState([])
  const [filtro, setFiltro] = useState('')
  const [error, setError] = useState('')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(VACIO)
  const [errores, setErrores] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [aBorrar, setABorrar] = useState(null)

  const cargar = useCallback(async (locationId) => {
    setDatos(null)
    try {
      const q = locationId ? `?location_id=${encodeURIComponent(locationId)}` : ''
      const d = await api.get(`/api/admin/remitentes${q}`)
      setDatos(lista(d, 'remitentes'))
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
    }
  }, [])

  useEffect(() => {
    cargar(filtro)
  }, [cargar, filtro])

  useEffect(() => {
    api
      .get('/api/admin/subcuentas')
      .then((d) => setSubcuentas(lista(d, 'subcuentas')))
      .catch(() => setSubcuentas([]))
    api
      .get('/api/admin/proveedores')
      .then((d) => setProveedores(lista(d, 'proveedores')))
      .catch(() => setProveedores([]))
  }, [])

  const abrirNuevo = () => {
    setForm({ ...VACIO, location_id: filtro || '' })
    setErrores([])
    setModal({ id: null })
  }

  const abrirEditar = (s) => {
    setForm({
      location_id: s.location_id || '',
      email: s.email || '',
      name: s.name || '',
      reply_to: s.reply_to || '',
      provider_id: s.provider_id ? String(s.provider_id) : '',
      is_default: Boolean(s.is_default),
    })
    setErrores([])
    setModal({ id: s.id })
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const guardar = async (e) => {
    e.preventDefault()
    const fallos = validar(form)
    setErrores(fallos)
    if (fallos.length) return

    const cuerpo = {
      email: form.email.trim().toLowerCase(),
      name: form.name.trim(),
      reply_to: form.reply_to.trim() || null,
      provider_id: Number(form.provider_id),
      is_default: form.is_default,
    }

    setGuardando(true)
    try {
      if (modal.id) await api.patch(`/api/admin/remitentes/${modal.id}`, cuerpo)
      else await api.post('/api/admin/remitentes', { ...cuerpo, location_id: form.location_id })
      setModal(null)
      await cargar(filtro)
    } catch (err) {
      setErrores([err.message])
    } finally {
      setGuardando(false)
    }
  }

  const borrar = async () => {
    const s = aBorrar
    setABorrar(null)
    try {
      await api.del(`/api/admin/remitentes/${s.id}`)
      await cargar(filtro)
    } catch (err) {
      setError(err.message)
    }
  }

  const nombreSubcuenta = (id) =>
    subcuentas.find((s) => String(s.location_id) === String(id))?.name || id || '—'
  const nombreProveedor = (id) => proveedores.find((p) => String(p.id) === String(id))?.name || `#${id ?? '—'}`

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Remitentes de las subcuentas</h1>
          <p className="text-sm text-ink2 mt-1">
            Alta y mantenimiento de remitentes en nombre de cualquier subcuenta conectada.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <div className="w-64">
            <Select label="Subcuenta" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              <option value="">Todas</option>
              {subcuentas.map((s) => (
                <option key={s.location_id} value={s.location_id}>
                  {s.name || s.location_id}
                </option>
              ))}
            </Select>
          </div>
          <Boton onClick={abrirNuevo} disabled={subcuentas.length === 0}>
            Nuevo remitente
          </Boton>
        </div>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      <div className={TARJETA}>
        {datos === null ? (
          <div className="py-12 grid place-items-center">
            <Spinner />
          </div>
        ) : datos.length === 0 ? (
          <p className="text-sm text-mut py-10 text-center">
            {filtro ? 'Esta subcuenta no tiene remitentes.' : 'Todavía no hay remitentes en ninguna subcuenta.'}
          </p>
        ) : (
          <Tabla columnas={['Subcuenta', 'Correo', 'Nombre visible', 'Proveedor', 'Origen', '']}>
            {datos.map((s) => (
              <tr key={s.id}>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <div className="text-ink2">{nombreSubcuenta(s.location_id)}</div>
                  <div className="text-[11px] text-mut font-mono">{s.location_id}</div>
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <span className="font-medium">{s.email}</span>
                  {s.is_default && (
                    <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded-full border border-gold/40 text-gold">
                      Por defecto
                    </span>
                  )}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">{s.name}</td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                  {nombreProveedor(s.provider_id)}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <Badge status={s.origin} />
                  <div className="text-[11px] text-mut">{ORIGEN[s.origin] || s.origin}</div>
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                  <button type="button" className="text-xs text-ink2 hover:text-ink mr-3" onClick={() => abrirEditar(s)}>
                    Editar
                  </button>
                  <button type="button" className="text-xs text-bad/80 hover:text-bad" onClick={() => setABorrar(s)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </Tabla>
        )}
      </div>

      {modal && (
        <Modal title={modal.id ? 'Editar remitente' : 'Nuevo remitente'} onClose={() => setModal(null)}>
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

            <Select label="Subcuenta" value={form.location_id} onChange={set('location_id')} disabled={Boolean(modal.id)}>
              <option value="">Elige una subcuenta…</option>
              {subcuentas.map((s) => (
                <option key={s.location_id} value={s.location_id}>
                  {s.name || s.location_id}
                </option>
              ))}
            </Select>

            <Campo
              label="Correo del remitente"
              type="email"
              placeholder="hola@dominiodelcliente.com"
              value={form.email}
              onChange={set('email')}
              autoComplete="off"
            />
            <Campo label="Nombre visible" value={form.name} onChange={set('name')} maxLength={120} />

            <Select label="Proveedor" value={form.provider_id} onChange={set('provider_id')}>
              <option value="">Elige un proveedor…</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type})
                </option>
              ))}
            </Select>
            <Aviso variant="info">
              Aquí solo se listan los proveedores de la agencia. Asegúrate de haberlo cedido antes a esa subcuenta desde{' '}
              <Link to="/admin/asignaciones" className="text-gold hover:underline">
                Asignaciones
              </Link>
              , o el envío fallará.
            </Aviso>

            <Campo
              label="Responder a (opcional)"
              type="email"
              value={form.reply_to}
              onChange={set('reply_to')}
              autoComplete="off"
            />

            <div className="bg-card2 border border-border rounded-xl p-3.5">
              <Interruptor
                checked={form.is_default}
                onChange={(v) => setForm((f) => ({ ...f, is_default: v }))}
                label="Usar como remitente por defecto de la subcuenta"
              />
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Boton type="button" variant="ghost" onClick={() => setModal(null)}>
                Cancelar
              </Boton>
              <Boton type="submit" disabled={guardando}>
                {guardando ? 'Guardando…' : 'Guardar'}
              </Boton>
            </div>
          </form>
        </Modal>
      )}

      {aBorrar && (
        <Confirmar
          title="Eliminar remitente"
          message={`¿Seguro que quieres eliminar «${aBorrar.email}» de ${nombreSubcuenta(aBorrar.location_id)}? Los workflows que lo usen dejarán de enviar.`}
          onConfirm={borrar}
          onCancel={() => setABorrar(null)}
        />
      )}
    </div>
  )
}
