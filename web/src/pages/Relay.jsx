import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, fmtFecha } from '../api.js'
import { Aviso, Badge, Boton, Confirmar, Copiar, Interruptor, Select, Spinner } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const Dato = ({ etiqueta, valor, mono = true }) => (
  <div className="bg-card2 border border-border rounded-xl px-3.5 py-2.5">
    <div className="text-[11px] text-mut uppercase tracking-wide mb-1">{etiqueta}</div>
    <div className="flex items-center gap-2">
      <span className={`text-sm text-ink break-all ${mono ? 'font-mono' : ''}`}>{valor}</span>
      <span className="ml-auto shrink-0">
        <Copiar value={String(valor)} />
      </span>
    </div>
  </div>
)

// Estado del servidor y de su certificado a partir de GET /api/loc/relay (SPEC §13.3).
// `tls_ok` ausente = backend sin la sección 13 desplegada: no se pinta badge ni aviso de TLS.
// `tls_error` es opcional: sin él, un certificado no válido se enseña como «en emisión», que es
// lo que pasa nada más arrancar (el relay levanta con autofirmado y pide el de Let's Encrypt).
function estadoCertificado(datos) {
  if (datos.servidor_activo === false) return { clave: 'apagado' }
  if (datos.tls_ok == null) return { clave: 'desconocido' }
  if (datos.tls_ok) return { clave: 'ok', validoHasta: datos.tls_valido_hasta || null }
  if (datos.tls_error) return { clave: 'error', error: String(datos.tls_error) }
  return { clave: 'pendiente' }
}

function BadgeCertificado({ estado }) {
  switch (estado.clave) {
    case 'ok':
      return (
        <Badge estado="ok" titulo="Certificado del servidor emitido por Let's Encrypt">
          TLS válido{estado.validoHasta ? ` hasta ${fmtFecha(estado.validoHasta)}` : ''}
        </Badge>
      )
    case 'pendiente':
      return (
        <Badge estado="pendiente" titulo="La app está pidiendo el certificado a Let's Encrypt">
          Certificado en emisión · espera un minuto
        </Badge>
      )
    case 'error':
      return (
        <Badge estado="error" titulo={estado.error}>
          Certificado con error
        </Badge>
      )
    case 'apagado':
      return <Badge estado="inactivo">Servidor apagado</Badge>
    default:
      return null
  }
}

function AvisoServidor({ estado, host, activado, onRecargar, recargando }) {
  switch (estado.clave) {
    case 'apagado':
      return (
        <Aviso variant="warn">
          El servidor del relay está apagado ahora mismo a nivel de plataforma: si pegas estos datos en GHL te dará un
          error de conexión. Escríbele a tu agencia para que lo active; tus datos seguirán siendo los mismos.
        </Aviso>
      )
    case 'pendiente':
      return (
        <Aviso variant="warn" titulo="Servidor encendido · certificado pendiente">
          La app está emitiendo el certificado TLS de <code className="text-ink">{host}</code>. Suele tardar menos de un
          minuto: recarga en un momento. Si pegas los datos en GHL antes de que termine, la conexión segura puede
          fallar la primera vez; vuelve a guardar cuando el certificado esté en verde.
          <div className="mt-2">
            <Boton variant="ghost" size="sm" onClick={onRecargar} cargando={recargando}>
              Recargar
            </Boton>
          </div>
        </Aviso>
      )
    case 'error':
      return (
        <Aviso variant="error" titulo="Servidor encendido · el certificado TLS ha fallado">
          No se ha podido emitir el certificado de <code className="text-ink">{host}</code>
          {estado.error ? (
            <>
              : <span className="font-mono text-xs break-all">{estado.error}</span>
            </>
          ) : (
            '.'
          )}{' '}
          Avisa a tu agencia: lo ve y lo relanza desde su panel. Mientras tanto, GHL puede rechazar la conexión
          segura al guardar el servicio.
          <div className="mt-2">
            <Boton variant="ghost" size="sm" onClick={onRecargar} cargando={recargando}>
              Recargar
            </Boton>
          </div>
        </Aviso>
      )
    case 'ok':
      return (
        <Aviso variant="ok">
          Todo correcto: el servidor del relay está encendido y su certificado TLS es válido
          {estado.validoHasta ? ` hasta el ${fmtFecha(estado.validoHasta)}` : ''}.{' '}
          {activado ? 'Puedes pegar los datos de abajo en GHL.' : 'Activa el relay para obtener tus datos SMTP.'}
        </Aviso>
      )
    default:
      return null
  }
}

export default function Relay() {
  const [datos, setDatos] = useState(null)
  const [proveedores, setProveedores] = useState([])
  const [error, setError] = useState('')
  const [ocupado, setOcupado] = useState(false)
  const [recargando, setRecargando] = useState(false)
  const [password, setPassword] = useState('') // solo en memoria: se muestra una única vez
  const [aRotar, setARotar] = useState(false)

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/loc/relay')
      setDatos(d || {})
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos({})
    }
  }, [])

  const recargar = useCallback(async () => {
    setRecargando(true)
    try {
      await cargar()
    } finally {
      setRecargando(false)
    }
  }, [cargar])

  useEffect(() => {
    cargar()
    api
      .get('/api/loc/proveedores')
      .then((d) => setProveedores(lista(d, 'proveedores')))
      .catch(() => setProveedores([]))
  }, [cargar])

  const guardar = async (cambios) => {
    setOcupado(true)
    setDatos((d) => ({ ...d, ...cambios }))
    try {
      const d = await api.patch('/api/loc/relay', cambios)
      if (d && typeof d === 'object') setDatos((prev) => ({ ...prev, ...d }))
      setError('')
    } catch (err) {
      setError(err.message)
      await cargar()
    } finally {
      setOcupado(false)
    }
  }

  const activar = async () => {
    setOcupado(true)
    try {
      const d = await api.post('/api/loc/relay/activar')
      // el backend devuelve la contraseña UNA sola vez en el campo «contrasena» (location.js)
      if (d?.contrasena || d?.password) setPassword(d.contrasena || d.password)
      setDatos((prev) => ({ ...prev, ...d, contrasena: undefined, password: undefined, enabled: d?.enabled ?? true }))
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setOcupado(false)
    }
  }

  const rotar = async () => {
    setARotar(false)
    setOcupado(true)
    try {
      const d = await api.post('/api/loc/relay/rotar')
      if (d?.contrasena || d?.password) setPassword(d.contrasena || d.password)
      setDatos((prev) => ({ ...prev, ...d, contrasena: undefined, password: undefined }))
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setOcupado(false)
    }
  }

  if (datos === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  const activado = Boolean(datos.username)
  const host = datos.host || '—'
  // `port` es el puerto PÚBLICO (587 por defecto); `puerto_ssl` solo llega si la escucha SSL existe.
  const puerto = datos.port ?? '—'
  const puertoSsl = datos.puerto_ssl ?? null
  const estadoTls = estadoCertificado(datos)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Relay SMTP</h1>
        <p className="text-sm text-ink2 mt-1">
          Unos datos SMTP propios para pegar en GHL y poder usar su nodo de email de siempre, pero enviando por tus
          proveedores.
        </p>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      <AvisoServidor estado={estadoTls} host={host} activado={activado} onRecargar={recargar} recargando={recargando} />

      {!activado ? (
        <div className={TARJETA}>
          <div className="text-sm font-semibold mb-2">Todavía no está activado</div>
          <p className="text-sm text-ink2 mb-4">
            Al activarlo se generan un usuario y una contraseña exclusivos de esta subcuenta. La contraseña se muestra{' '}
            <strong className="text-ink">una sola vez</strong>: cópiala en ese momento, porque después ya no se puede
            recuperar (solo generar una nueva).
          </p>
          <Boton onClick={activar} disabled={ocupado}>
            {ocupado ? 'Activando…' : 'Activar relay'}
          </Boton>
        </div>
      ) : (
        <>
          {password && (
            <div className="bg-card border border-gold/40 rounded-2xl p-5">
              <Aviso variant="warn">
                Esta contraseña no se volverá a mostrar. Cópiala ahora y pégala en GHL. Si la pierdes, tendrás que generar
                otra y volver a configurarlo.
              </Aviso>
              <div className="mt-4">
                <Dato etiqueta="Contraseña" valor={password} />
              </div>
              <div className="flex justify-end mt-3">
                <Boton variant="ghost" onClick={() => setPassword('')}>
                  Ya la he guardado
                </Boton>
              </div>
            </div>
          )}

          <div className={TARJETA}>
            <div className="flex items-start justify-between gap-4 mb-4">
              <div>
                <div className="text-sm font-semibold">Estado del relay</div>
                <p className="text-[11px] text-mut mt-0.5">
                  Si lo desactivas, GHL dejará de poder enviar por aquí y sus correos fallarán.
                </p>
              </div>
              <Interruptor
                checked={Boolean(datos.enabled)}
                onChange={(v) => guardar({ enabled: v })}
                label={datos.enabled ? 'Activado' : 'Desactivado'}
              />
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <Dato etiqueta="Servidor SMTP (host)" valor={host} />
              <Dato etiqueta={puertoSsl != null ? 'Puerto · TLS/STARTTLS · recomendado' : 'Puerto · TLS/STARTTLS'} valor={puerto} />
              {puertoSsl != null && <Dato etiqueta="Puerto · SSL" valor={puertoSsl} />}
              <Dato etiqueta="Usuario" valor={datos.username} />
              <div className="bg-card2 border border-border rounded-xl px-3.5 py-2.5">
                <div className="text-[11px] text-mut uppercase tracking-wide mb-1">Contraseña</div>
                <div className="flex items-center gap-2">
                  <span className="text-sm text-ink2">
                    {datos.tiene_password === false ? 'Sin generar' : 'Guardada · no se puede mostrar'}
                  </span>
                  <button
                    type="button"
                    className="ml-auto text-xs text-gold hover:underline disabled:opacity-40"
                    disabled={ocupado}
                    onClick={() => setARotar(true)}
                  >
                    Generar nueva
                  </button>
                </div>
              </div>
            </div>

            {estadoTls.clave !== 'desconocido' && (
              <div className="flex flex-wrap items-center gap-2 mt-3 text-[11px] text-mut">
                <span>Certificado TLS del servidor:</span>
                <BadgeCertificado estado={estadoTls} />
                {estadoTls.clave === 'ok' && (
                  <span>Se renueva solo. Con {puerto} usa TLS/STARTTLS{puertoSsl != null ? `; con ${puertoSsl}, SSL` : ''}.</span>
                )}
              </div>
            )}
          </div>

          <div className={TARJETA}>
            <div className="text-sm font-semibold mb-4">Enrutado</div>

            <Select
              label="Proveedor por defecto"
              value={datos.default_provider_id ? String(datos.default_provider_id) : ''}
              onChange={(e) => guardar({ default_provider_id: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">Sin proveedor por defecto</option>
              {proveedores.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.type})
                </option>
              ))}
            </Select>
            <p className="text-[11px] text-mut mt-1.5">
              Se usa cuando llega un correo de un remitente que todavía no está dado de alta. Sin proveedor por defecto,
              esos correos se rechazan temporalmente.
            </p>

            {!datos.default_provider_id && (
              <div className="mt-3">
                <Aviso variant="warn">
                  No hay proveedor por defecto. Elige uno o los remitentes nuevos no podrán enviar.{' '}
                  <Link to="/proveedores" className="text-gold hover:underline">
                    Ver proveedores
                  </Link>
                  .
                </Aviso>
              </div>
            )}

            <div className="bg-card2 border border-border rounded-xl p-3.5 mt-4">
              <Interruptor
                checked={datos.accept_unknown_senders !== false}
                onChange={(v) => guardar({ accept_unknown_senders: v })}
                label="Aceptar remitentes desconocidos"
              />
              <p className="text-[11px] text-mut mt-1.5">
                Recomendado. Si llega un correo desde una dirección que no tienes dada de alta, se crea el remitente solo
                (apuntando al proveedor por defecto) y el correo sale. Lo verás luego en{' '}
                <Link to="/remitentes" className="text-gold hover:underline">
                  Remitentes
                </Link>{' '}
                marcado como detectado por el relay. Si lo desactivas, esos correos se rechazan.
              </p>
            </div>
          </div>
        </>
      )}

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-3">Cómo se usa esto en GHL</div>
        <ol className="space-y-3 text-sm text-ink2">
          <li className="flex gap-3">
            <span className="grid place-items-center w-5 h-5 rounded-full bg-gold/15 text-gold text-[11px] shrink-0">1</span>
            <span>
              En tu subcuenta de GHL entra en <strong className="text-ink">Settings › Email Services</strong>, pestaña{' '}
              <strong className="text-ink">SMTP Service</strong>, y pulsa <strong className="text-ink">+ Add Service</strong>.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid place-items-center w-5 h-5 rounded-full bg-gold/15 text-gold text-[11px] shrink-0">2</span>
            <span>
              En «Proveedor SMTP» elige <strong className="text-ink">Otro</strong> (Other). En{' '}
              <strong className="text-ink">«Nombre del proveedor»</strong> pon lo que quieras — es solo la etiqueta con la
              que lo verás en GHL (por ejemplo «Emails Disruptivo»). En{' '}
              <strong className="text-ink">«Correo electrónico»</strong> pon un correo tuyo real (por ejemplo{' '}
              <code className="text-ink">hola@tudominio.com</code>): será el remitente por defecto, y luego puedes
              cambiarlo en cada correo.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid place-items-center w-5 h-5 rounded-full bg-gold/15 text-gold text-[11px] shrink-0">3</span>
            <span>
              En <strong className="text-ink">«Servidor SMTP»</strong> pega el host de arriba y en{' '}
              <strong className="text-ink">«Puerto»</strong> el <code className="text-ink">{puerto}</code> con{' '}
              <strong className="text-ink">TLS/STARTTLS</strong> — es el recomendado
              {puertoSsl != null ? (
                <>
                  ; si tu GHL te ofrece SSL, también vale el <code className="text-ink">{puertoSsl}</code> con SSL
                </>
              ) : null}
              . Usuario y contraseña, los de arriba tal cual.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="grid place-items-center w-5 h-5 rounded-full bg-gold/15 text-gold text-[11px] shrink-0">4</span>
            <span>
              Marca <strong className="text-ink">Default Provider</strong> para que la subcuenta envíe por aquí, y guarda.
              Ya puedes usar el <strong className="text-ink">nodo de email de siempre</strong> en tus workflows; no tienes
              que cambiar nada más.
            </span>
          </li>
        </ol>

        <p className="text-[11px] text-mut mt-3">
          Al guardar, GHL prueba la conexión con el servidor. Si te sale un error tipo{' '}
          <code className="text-ink2">ETIMEDOUT</code> o «CONN», el servidor del relay no está accesible en ese momento:
          no es nada que hayas escrito mal — avisa a tu agencia para que lo encienda. Si el error habla del{' '}
          <em>certificado</em> (<code className="text-ink2">CERT</code>, <code className="text-ink2">SELF_SIGNED</code>…),
          es que todavía se está emitiendo: espera un minuto, recarga esta página y vuelve a guardar cuando el
          certificado esté en verde.
        </p>

        <div className="border-t border-border mt-5 pt-5">
          <div className="text-sm font-semibold mb-2">Lo importante: manda el remitente</div>
          <p className="text-sm text-ink2">
            Cuando GHL nos entrega un correo, miramos la dirección del{' '}
            <strong className="text-ink">remitente</strong> (el «From» real del mensaje, no lo que pusieras en la
            configuración) y buscamos ese correo en tu lista de remitentes. El proveedor asociado a ese remitente es el que
            envía. Así, cambiando el remitente en el nodo del workflow cambias el proveedor por el que sale, sin tocar nada
            en GHL.
          </p>
          <p className="text-sm text-ink2 mt-2">
            Si el remitente no está dado de alta, se crea solo con el proveedor por defecto (mientras «aceptar remitentes
            desconocidos» esté activo). Lo único que se rechaza siempre es enviar desde un dominio que otra subcuenta ya ha
            verificado como suyo.
          </p>
        </div>
      </div>

      {aRotar && (
        <Confirmar
          title="Generar contraseña nueva"
          message="La contraseña actual dejará de funcionar al instante y GHL no podrá enviar hasta que pegues la nueva en Settings › Email Services. ¿Continuar?"
          onConfirm={rotar}
          onCancel={() => setARotar(false)}
        />
      )}
    </div>
  )
}
