import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Aviso, Badge, Boton, Campo, Copiar, Modal, Spinner, Tabla } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const fecha = (d) => (d ? new Date(d).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

const numero = (n) => new Intl.NumberFormat('es-ES').format(Number(n) || 0)

const Dato = ({ etiqueta, valor }) => (
  <div className="bg-card2 border border-border rounded-xl px-3.5 py-2.5">
    <div className="text-[11px] text-mut uppercase tracking-wide mb-1">{etiqueta}</div>
    <div className="flex items-center gap-2">
      <span className="text-sm text-ink font-mono break-all">{valor}</span>
      <span className="ml-auto shrink-0">
        <Copiar value={String(valor)} />
      </span>
    </div>
  </div>
)

export default function Subcuentas() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')
  const [busqueda, setBusqueda] = useState('')
  const [relay, setRelay] = useState(null) // {subcuenta, datos, password}
  const [activando, setActivando] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/subcuentas')
      setDatos(lista(d, 'subcuentas'))
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const activarRelay = async (s) => {
    setActivando(s.location_id)
    try {
      const d = await api.post(`/api/admin/subcuentas/${encodeURIComponent(s.location_id)}/relay`)
      // la contraseña llega en «contrasena» y solo en esta respuesta (admin.js → serializarRelay)
      setRelay({ subcuenta: s, datos: d || {}, password: d?.contrasena || d?.password || '' })
      setError('')
      await cargar()
    } catch (err) {
      setError(err.message)
    } finally {
      setActivando(null)
    }
  }

  const filtradas = useMemo(() => {
    if (!datos) return []
    const q = busqueda.trim().toLowerCase()
    if (!q) return datos
    return datos.filter(
      (s) =>
        String(s.name || '').toLowerCase().includes(q) ||
        String(s.location_id || '').toLowerCase().includes(q) ||
        String(s.company_id || '').toLowerCase().includes(q),
    )
  }, [datos, busqueda])

  if (datos === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold">Subcuentas</h1>
          <p className="text-sm text-ink2 mt-1">Subcuentas de GHL que tienen la app instalada.</p>
        </div>
        <div className="w-64">
          <Campo
            placeholder="Buscar por nombre o ID…"
            value={busqueda}
            onChange={(e) => setBusqueda(e.target.value)}
          />
        </div>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      <div className={TARJETA}>
        {datos.length === 0 ? (
          <p className="text-sm text-mut py-10 text-center">
            Todavía no hay ninguna subcuenta con la app instalada.
          </p>
        ) : filtradas.length === 0 ? (
          <p className="text-sm text-mut py-10 text-center">Ninguna subcuenta coincide con la búsqueda.</p>
        ) : (
          <Tabla columnas={['Subcuenta', 'Estado', 'Proveedores', 'Remitentes', 'Envíos', 'Instalada', '']}>
            {filtradas.map((s) => (
              <tr key={s.location_id}>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <div className="font-medium">{s.name || 'Sin nombre'}</div>
                  <div className="text-[11px] text-mut font-mono">{s.location_id}</div>
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60">
                  <Badge status={s.status} />
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right tabular-nums text-ink2">
                  {numero(s.proveedores)}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right tabular-nums text-ink2">
                  {numero(s.remitentes)}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right tabular-nums text-ink2">
                  {numero(s.envios)}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 whitespace-nowrap">
                  {fecha(s.created_at)}
                </td>
                <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                  <button
                    type="button"
                    className="text-xs text-gold hover:underline disabled:opacity-40"
                    disabled={activando === s.location_id}
                    onClick={() => activarRelay(s)}
                  >
                    {activando === s.location_id ? 'Activando…' : 'Activar relay'}
                  </button>
                </td>
              </tr>
            ))}
          </Tabla>
        )}
      </div>

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-2">Qué puedes hacer desde aquí</div>
        <ul className="text-sm text-ink2 space-y-1.5 list-disc pl-4">
          <li>
            Cederles proveedores propios desde{' '}
            <Link to="/admin/asignaciones" className="text-gold hover:underline">
              Asignaciones
            </Link>{' '}
            para que envíen sin configurar nada.
          </li>
          <li>
            Crearles remitentes y plantillas desde{' '}
            <Link to="/admin/remitentes" className="text-gold hover:underline">
              Remitentes
            </Link>{' '}
            y{' '}
            <Link to="/admin/plantillas" className="text-gold hover:underline">
              Plantillas
            </Link>
            .
          </li>
          <li>Activarles el relay SMTP y entregarles tú mismo las credenciales.</li>
        </ul>
      </div>

      {relay && (
        <Modal title={`Relay de ${relay.subcuenta.name || relay.subcuenta.location_id}`} onClose={() => setRelay(null)}>
          <div className="space-y-4">
            {relay.password ? (
              <Aviso variant="warn">
                Esta contraseña no se volverá a mostrar. Cópiala ahora y entrégasela al cliente para que la pegue en
                Settings › Email Services de su subcuenta.
              </Aviso>
            ) : (
              <Aviso variant="info">
                El relay ya estaba activado, así que no se genera contraseña nueva. Si el cliente la ha perdido, tendrá que
                generar otra desde su propio panel.
              </Aviso>
            )}

            {relay.datos.servidor_activo === false && (
              <Aviso variant="error">
                El servidor del relay está apagado (<code className="text-ink">SMTP_RELAY_ENABLED</code> no está en{' '}
                <code className="text-ink">true</code>): si el cliente pega estos datos ahora, GHL dará un error de
                conexión (ETIMEDOUT). Enciéndelo en EasyPanel antes de entregárselos.
              </Aviso>
            )}

            <div className="grid sm:grid-cols-2 gap-3">
              <Dato etiqueta="Servidor SMTP" valor={relay.datos.host || '—'} />
              <Dato etiqueta="Puerto" valor={relay.datos.port ?? '—'} />
              <Dato etiqueta="Usuario" valor={relay.datos.username || '—'} />
              {relay.password && <Dato etiqueta="Contraseña" valor={relay.password} />}
            </div>

            <div className="bg-card2 border border-border rounded-xl p-3.5">
              <div className="text-[11px] text-mut uppercase tracking-wide mb-2">
                Qué poner en cada campo del formulario de GHL
              </div>
              <ul className="text-xs text-ink2 space-y-1.5">
                <li>
                  <strong className="text-ink">Proveedor SMTP:</strong> «Otro» (Other).
                </li>
                <li>
                  <strong className="text-ink">Nombre del proveedor:</strong> el que quiera el cliente — es solo la
                  etiqueta con la que lo verá en GHL (por ejemplo «Emails Disruptivo»).
                </li>
                <li>
                  <strong className="text-ink">Correo electrónico:</strong> un correo real del cliente (por ejemplo{' '}
                  <code className="text-ink">hola@su-dominio.com</code>): será el remitente por defecto de lo que envíe
                  por aquí.
                </li>
                <li>
                  <strong className="text-ink">Servidor, puerto, usuario y contraseña:</strong> los de arriba, tal cual.
                </li>
              </ul>
              <p className="text-[11px] text-mut mt-2.5">
                Recuerda: el flag de arriba solo indica si el proceso está encendido — nadie comprueba el puerto. El
                puerto <code className="text-ink2">{relay.datos.port ?? 2525}</code> tiene que estar publicado como{' '}
                <strong className="text-ink2">TCP</strong> en EasyPanel (sección <em>Ports</em>; los <em>Domains</em> de
                Traefik no enrutan SMTP). Si GHL da ETIMEDOUT al guardar, revisa eso primero (DEPLOY.md, sección D).
              </p>
            </div>

            <p className="text-xs text-ink2">
              El correo sale por el proveedor del remitente que se use en cada mensaje. Si el remitente no existe todavía,
              se crea solo con el proveedor por defecto de la subcuenta.
            </p>

            <div className="flex justify-end">
              <Boton onClick={() => setRelay(null)}>Hecho</Boton>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
