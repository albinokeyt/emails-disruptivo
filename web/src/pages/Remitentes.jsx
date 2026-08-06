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

// Los dominios de correo gratuito publican DMARC p=reject: enviar desde ellos es spoofing y rebota.
const GRATUITOS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com']

const ORIGEN = {
  panel: 'Alta manual',
  admin: 'Creado por la agencia',
  auto: 'Detectado por el relay',
}

const VERIFICACION = {
  verificado: { texto: 'Verificado', clase: 'text-ok' },
  no_verificado: { texto: 'No verificado', clase: 'text-bad' },
  desconocido: { texto: 'Sin comprobar', clase: 'text-mut' },
}

const VACIO = { email: '', name: '', reply_to: '', provider_id: '', is_default: false }

const dominioDe = (email) => String(email).split('@')[1]?.toLowerCase() || ''

function validar(f) {
  const errores = []
  if (!CORREO.test(f.email.trim())) errores.push('El correo del remitente no es válido.')
  if (!f.name.trim()) errores.push('El nombre visible es obligatorio.')
  if (/[\r\n]/.test(f.name)) errores.push('El nombre no puede contener saltos de línea.')
  if (f.reply_to && !CORREO.test(f.reply_to.trim())) errores.push('La dirección de respuesta no es válida.')
  if (!f.provider_id) errores.push('Elige el proveedor por el que saldrá este remitente.')
  return errores
}

export default function Remitentes() {
  const [datos, setDatos] = useState(null)
  const [proveedores, setProveedores] = useState([])
  const [dominios, setDominios] = useState([])
  const [error, setError] = useState('')
  const [modal, setModal] = useState(null) // {id|null}
  const [form, setForm] = useState(VACIO)
  const [errores, setErrores] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [aBorrar, setABorrar] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/loc/remitentes')
      setDatos(lista(d, 'remitentes'))
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
    }
  }, [])

  useEffect(() => {
    cargar()
    api
      .get('/api/loc/proveedores')
      .then((d) => setProveedores(lista(d, 'proveedores')))
      .catch(() => setProveedores([]))
    api
      .get('/api/loc/dominios')
      .then((d) => setDominios(lista(d, 'dominios')))
      .catch(() => setDominios([]))
  }, [cargar])

  const abrirNuevo = () => {
    setForm({ ...VACIO, provider_id: proveedores[0]?.id ? String(proveedores[0].id) : '' })
    setErrores([])
    setModal({ id: null })
  }

  const abrirEditar = (s) => {
    setForm({
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
      if (modal.id) await api.patch(`/api/loc/remitentes/${modal.id}`, cuerpo)
      else await api.post('/api/loc/remitentes', cuerpo)
      setModal(null)
      await cargar()
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
      await api.del(`/api/loc/remitentes/${s.id}`)
      await cargar()
    } catch (err) {
      setError(err.message)
    }
  }

  if (error && datos === null) return <Aviso variant="error">{error}</Aviso>
  if (datos === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  const verificados = new Set(dominios.filter((d) => d.verified).map((d) => String(d.domain).toLowerCase()))
  const nombreProveedor = (id) => proveedores.find((p) => String(p.id) === String(id))?.name || '—'
  const dominioForm = dominioDe(form.email)
  const autoDetectados = datos.filter((s) => s.origin === 'auto').length

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Remitentes</h1>
          <p className="text-sm text-ink2 mt-1">
            Direcciones desde las que se envía. Cada remitente decide por qué proveedor sale el correo.
          </p>
        </div>
        <Boton onClick={abrirNuevo} disabled={proveedores.length === 0}>
          Nuevo remitente
        </Boton>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      {proveedores.length === 0 && (
        <Aviso variant="warn">
          Antes de dar de alta un remitente necesitas al menos un proveedor.{' '}
          <Link to="/proveedores" className="text-gold hover:underline">
            Crear proveedor
          </Link>
          .
        </Aviso>
      )}

      {autoDetectados > 0 && (
        <Aviso variant="info">
          {autoDetectados === 1
            ? 'Hay 1 remitente detectado automáticamente por el relay.'
            : `Hay ${autoDetectados} remitentes detectados automáticamente por el relay.`}{' '}
          Revisa que su proveedor sea el correcto.
        </Aviso>
      )}

      <div className={TARJETA}>
        {datos.length === 0 ? (
          <p className="text-sm text-mut py-10 text-center">Todavía no hay remitentes dados de alta.</p>
        ) : (
          <Tabla columnas={['Correo', 'Nombre visible', 'Proveedor', 'Responder a', 'Dominio', 'Origen', '']}>
            {datos.map((s) => {
              const dom = dominioDe(s.email)
              const propio = verificados.has(dom)
              const v = VERIFICACION[s.verified_state] || VERIFICACION.desconocido
              return (
                <tr key={s.id}>
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
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">{s.reply_to || '—'}</td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60">
                    <span className={`text-xs ${propio ? 'text-ok' : 'text-warn'}`}>
                      {propio ? 'Dominio verificado' : 'Dominio sin verificar'}
                    </span>
                    <div className={`text-[11px] ${v.clase}`}>En el proveedor: {v.texto.toLowerCase()}</div>
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
              )
            })}
          </Tabla>
        )}
      </div>

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-2">Sobre la verificación</div>
        <p className="text-sm text-ink2">
          Para que un correo llegue a la bandeja de entrada, el dominio del remitente tiene que estar verificado en dos
          sitios: en esta app (
          <Link to="/dominios" className="text-gold hover:underline">
            Dominios
          </Link>
          , publicando un registro TXT) y en el proveedor de envío (Brevo, o el SMTP que uses). Sin lo primero, el relay
          rechaza los correos de dominios que pertenecen a otra subcuenta. Sin lo segundo, el proveedor rechaza el envío y
          verás el motivo en el detalle del mensaje.
        </p>
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

            <Campo
              label="Correo del remitente"
              type="email"
              placeholder="hola@tudominio.com"
              value={form.email}
              onChange={set('email')}
              autoComplete="off"
            />

            {dominioForm && GRATUITOS.includes(dominioForm) && (
              <Aviso variant="warn">
                {dominioForm} bloquea el envío desde servicios externos (DMARC p=reject). Usa un dominio propio o el correo
                rebotará.
              </Aviso>
            )}
            {dominioForm && !GRATUITOS.includes(dominioForm) && !verificados.has(dominioForm) && (
              <Aviso variant="info">
                El dominio {dominioForm} todavía no está verificado en esta app.{' '}
                <Link to="/dominios" className="text-gold hover:underline">
                  Verificarlo ahora
                </Link>
                .
              </Aviso>
            )}

            <Campo
              label="Nombre visible"
              placeholder="Bibi Hairdresser"
              value={form.name}
              onChange={set('name')}
              maxLength={120}
              hint="Es lo que ve el destinatario junto al correo."
            />

            <Select label="Proveedor" value={form.provider_id} onChange={set('provider_id')}>
              <option value="">Elige un proveedor…</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type}){p.asignado ? ' · de la agencia' : ''}
                </option>
              ))}
            </Select>

            <Campo
              label="Responder a (opcional)"
              type="email"
              placeholder="respuestas@tudominio.com"
              value={form.reply_to}
              onChange={set('reply_to')}
              autoComplete="off"
            />

            <div className="bg-card2 border border-border rounded-xl p-3.5">
              <Interruptor
                checked={form.is_default}
                onChange={(v) => setForm((f) => ({ ...f, is_default: v }))}
                label="Usar como remitente por defecto"
              />
              <p className="text-[11px] text-mut mt-1.5">
                Solo puede haber uno por subcuenta. Es el que se propone en los nodos del workflow.
              </p>
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
          message={`¿Seguro que quieres eliminar «${aBorrar.email}»? Los workflows que lo usen dejarán de enviar.`}
          onConfirm={borrar}
          onCancel={() => setABorrar(null)}
        />
      )}
    </div>
  )
}
