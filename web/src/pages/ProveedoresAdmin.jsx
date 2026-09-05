import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, registrarWebhookProveedorAdmin } from '../api.js'
import { WebhookBrevo } from './Proveedores.jsx'
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

const fecha = (d) =>
  d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

const TIPOS = { smtp: 'SMTP', brevo: 'Brevo' }

const PUERTOS = { ssl: '465', starttls: '587', ninguna: '25' }

const VACIO = {
  name: '',
  type: 'smtp',
  host: '',
  port: '587',
  seguridad: 'starttls',
  user: '',
  pass: '',
  api_key: '',
  daily_limit: '',
  reemplazar: true,
}

function seguridadDe(config) {
  if (config?.secure) return 'ssl'
  if (config?.requireTLS === false) return 'ninguna'
  return 'starttls'
}

function validar(f, esNuevo) {
  const errores = []
  if (!f.name.trim()) errores.push('El nombre es obligatorio.')
  if (f.name.length > 120) errores.push('El nombre no puede pasar de 120 caracteres.')
  if (f.daily_limit && (!/^\d+$/.test(f.daily_limit) || Number(f.daily_limit) < 1)) {
    errores.push('El límite diario tiene que ser un número entero mayor que cero.')
  }
  if (f.type === 'smtp') {
    if (!f.host.trim()) errores.push('El servidor SMTP es obligatorio.')
    else if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(f.host.trim())) errores.push('El servidor SMTP no parece un nombre de host válido.')
    const puerto = Number(f.port)
    if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) errores.push('El puerto tiene que estar entre 1 y 65535.')
    if (esNuevo || f.reemplazar) {
      if (!f.user.trim()) errores.push('El usuario SMTP es obligatorio.')
      if (!f.pass) errores.push('La contraseña SMTP es obligatoria.')
    }
  } else if (esNuevo || f.reemplazar) {
    if (!f.api_key.trim()) errores.push('La clave de API de Brevo es obligatoria.')
  }
  return errores
}

export default function ProveedoresAdmin() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')
  const [modal, setModal] = useState(null)
  const [form, setForm] = useState(VACIO)
  const [errores, setErrores] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [aBorrar, setABorrar] = useState(null)
  const [registrando, setRegistrando] = useState(null)
  const [avisoWebhook, setAvisoWebhook] = useState(null) // {ok, detalle}

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/proveedores')
      setDatos(lista(d, 'proveedores'))
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const abrirNuevo = () => {
    setForm(VACIO)
    setErrores([])
    setModal({ id: null })
  }

  const abrirEditar = (p) => {
    setForm({
      ...VACIO,
      name: p.name || '',
      type: p.type || 'smtp',
      host: p.config?.host || '',
      port: String(p.config?.port ?? PUERTOS[seguridadDe(p.config)]),
      seguridad: seguridadDe(p.config),
      daily_limit: p.daily_limit == null ? '' : String(p.daily_limit),
      reemplazar: false,
    })
    setErrores([])
    setModal({ id: p.id })
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const cambiarSeguridad = (e) => {
    const seguridad = e.target.value
    setForm((f) => ({
      ...f,
      seguridad,
      port: Object.values(PUERTOS).includes(f.port) ? PUERTOS[seguridad] : f.port,
    }))
  }

  const guardar = async (e) => {
    e.preventDefault()
    const esNuevo = modal.id === null
    const fallos = validar(form, esNuevo)
    setErrores(fallos)
    if (fallos.length) return

    const cuerpo = {
      name: form.name.trim(),
      type: form.type,
      config:
        form.type === 'smtp'
          ? {
              host: form.host.trim(),
              port: Number(form.port),
              secure: form.seguridad === 'ssl',
              requireTLS: form.seguridad === 'starttls',
            }
          : {},
      daily_limit: form.daily_limit ? Number(form.daily_limit) : null,
    }
    if (esNuevo || form.reemplazar) {
      cuerpo.credentials =
        form.type === 'smtp' ? { user: form.user.trim(), pass: form.pass } : { api_key: form.api_key.trim() }
    }

    setGuardando(true)
    try {
      const r = esNuevo
        ? await api.post('/api/admin/proveedores', cuerpo)
        : await api.patch(`/api/admin/proveedores/${modal.id}`, cuerpo)
      // el proveedor se guarda aunque Brevo no acepte el webhook: el aviso se enseña aparte
      setAvisoWebhook(r?.aviso ? { ok: false, detalle: r.aviso } : null)
      setModal(null)
      await cargar()
    } catch (err) {
      setErrores([err.message])
    } finally {
      setGuardando(false)
    }
  }

  const registrarWebhook = async (p) => {
    setRegistrando(p.id)
    setAvisoWebhook(null)
    try {
      const d = await registrarWebhookProveedorAdmin(p.id)
      setAvisoWebhook({ ok: d?.ok !== false, detalle: d?.detalle || 'Webhook registrado en Brevo.' })
      await cargar()
    } catch (err) {
      setAvisoWebhook({ ok: false, detalle: err.message })
    } finally {
      setRegistrando(null)
    }
  }

  const borrar = async () => {
    const p = aBorrar
    setABorrar(null)
    try {
      await api.del(`/api/admin/proveedores/${p.id}`)
      await cargar()
    } catch (err) {
      setError(err.message)
    }
  }

  if (datos === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Proveedores de la agencia</h1>
          <p className="text-sm text-ink2 mt-1">
            Los que puedes ceder a las subcuentas para que envíen sin configurar nada suyo.
          </p>
        </div>
        <Boton onClick={abrirNuevo}>Nuevo proveedor</Boton>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}
      {avisoWebhook && (
        <Aviso variant={avisoWebhook.ok ? 'ok' : 'aviso'} onCerrar={() => setAvisoWebhook(null)}>
          {avisoWebhook.detalle}
        </Aviso>
      )}

      <div className={TARJETA}>
        {datos.length === 0 ? (
          <p className="text-sm text-mut py-10 text-center">
            Todavía no hay proveedores de agencia. Crea uno para poder cederlo a tus subcuentas.
          </p>
        ) : (
          <Tabla columnas={['Nombre', 'Tipo', 'Configuración', 'Estado', 'Cedido a', 'Límite diario', '']}>
            {datos.map((p) => (
              <tr key={p.id}>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 font-medium">{p.name}</td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">{TIPOS[p.type] || p.type}</td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 text-xs">
                  {p.type === 'smtp' ? (
                    `${p.config?.host || '—'}:${p.config?.port ?? '—'}`
                  ) : (
                    <>
                      Brevo (API)
                      <WebhookBrevo proveedor={p} registrando={registrando === p.id} onRegistrar={() => registrarWebhook(p)} />
                    </>
                  )}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <Badge status={p.status} />
                  {p.last_error && (
                    <div className="text-[11px] text-bad max-w-56 truncate" title={p.last_error}>
                      {p.last_error}
                    </div>
                  )}
                  {p.last_check_at && <div className="text-[11px] text-mut">Comprobado {fecha(p.last_check_at)}</div>}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                  <Link to={`/admin/asignaciones?proveedor=${p.id}`} className="text-xs text-gold hover:underline">
                    {p.asignaciones ? `${p.asignaciones} subcuentas` : 'Asignar'}
                  </Link>
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right tabular-nums text-ink2">
                  {p.daily_limit ?? 'Sin límite'}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                  <button type="button" className="text-xs text-ink2 hover:text-ink mr-3" onClick={() => abrirEditar(p)}>
                    Editar
                  </button>
                  <button type="button" className="text-xs text-bad/80 hover:text-bad" onClick={() => setABorrar(p)}>
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
          </Tabla>
        )}
      </div>

      {modal && (
        <Modal title={modal.id ? 'Editar proveedor' : 'Nuevo proveedor de agencia'} onClose={() => setModal(null)}>
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

            <Campo label="Nombre" placeholder="Brevo de la agencia" value={form.name} onChange={set('name')} maxLength={120} />

            <Select label="Tipo" value={form.type} onChange={set('type')} disabled={Boolean(modal.id)}>
              <option value="smtp">SMTP</option>
              <option value="brevo">Brevo (API)</option>
            </Select>

            {form.type === 'smtp' && (
              <div className="grid grid-cols-2 gap-3">
                <Campo
                  className="col-span-2"
                  label="Servidor SMTP"
                  placeholder="smtp-relay.brevo.com"
                  value={form.host}
                  onChange={set('host')}
                  autoComplete="off"
                />
                <Select label="Seguridad" value={form.seguridad} onChange={cambiarSeguridad}>
                  <option value="starttls">STARTTLS (recomendado)</option>
                  <option value="ssl">SSL/TLS implícito</option>
                  <option value="ninguna">Sin cifrado (no recomendado)</option>
                </Select>
                <Campo label="Puerto" inputMode="numeric" value={form.port} onChange={set('port')} />
              </div>
            )}

            {modal.id && (
              <div className="bg-card2 border border-border rounded-xl p-3.5 flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm">Credenciales guardadas</div>
                  <div className="text-[11px] text-mut">Por seguridad no se muestran nunca.</div>
                </div>
                <Interruptor
                  checked={form.reemplazar}
                  onChange={(v) => setForm((f) => ({ ...f, reemplazar: v, user: '', pass: '', api_key: '' }))}
                  label="Reemplazar"
                />
              </div>
            )}

            {(!modal.id || form.reemplazar) &&
              (form.type === 'smtp' ? (
                <div className="grid grid-cols-2 gap-3">
                  <Campo label="Usuario" value={form.user} onChange={set('user')} autoComplete="off" />
                  <Campo
                    label="Contraseña"
                    type="password"
                    value={form.pass}
                    onChange={set('pass')}
                    autoComplete="new-password"
                  />
                </div>
              ) : (
                <Campo
                  label="Clave de API"
                  type="password"
                  placeholder="xkeysib-…"
                  value={form.api_key}
                  onChange={set('api_key')}
                  autoComplete="new-password"
                  hint="Brevo › Settings › SMTP & API › API Keys."
                />
              ))}

            <Campo
              label="Límite diario (opcional)"
              inputMode="numeric"
              placeholder="Sin límite"
              value={form.daily_limit}
              onChange={set('daily_limit')}
            />

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
          title="Eliminar proveedor"
          message={`¿Seguro que quieres eliminar «${aBorrar.name}»? Se retirará de todas las subcuentas a las que se lo hayas cedido.`}
          onConfirm={borrar}
          onCancel={() => setABorrar(null)}
        />
      )}
    </div>
  )
}
