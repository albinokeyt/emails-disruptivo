import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { obtenerSesion } from '../api.js'
import { useSesion } from '../hooks.js'
import { Aviso, Badge, Boton, Campo, Modal, Spinner } from './ui.jsx'

// Modal «Enviar correo de prueba» de la pantalla Remitentes, compartido por el panel de subcuenta y
// el de la agencia: la pantalla le pasa las dos llamadas a la API (probar y obtenerEnvio) y la ruta
// de Envíos, y el modal hace el resto — pide (o confirma) la dirección de destino, encola la prueba
// y, tras el 201, consulta el envío cada 2 s hasta que el estado deja de ser de cola (o pasan 45 s)
// para enseñar lo que dijo el proveedor. El sondeo se cancela al cerrar (cleanup del efecto).

const CADA_MS = 2_000
const MAXIMO_MS = 45_000
// Mientras el mensaje esté en uno de estos estados se sigue preguntando (SPEC §4)
const EN_COLA = new Set(['encolado', 'enviando', 'reintento'])
const ACEPTADO = new Set(['enviado', 'entregado'])

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export default function PruebaRemitente({
  remitente,
  nombreProveedor,
  probar,
  obtenerEnvio,
  rutaEnvios = '/envios',
  onCerrar,
}) {
  const sesion = useSesion()
  const [para, setPara] = useState(sesion?.email || '')
  const [enviando, setEnviando] = useState(false)
  const [error, setError] = useState('')
  const [resultado, setResultado] = useState(null) // respuesta del 201
  const [envio, setEnvio] = useState(null) // última lectura de GET …/envios/:id
  const [agotado, setAgotado] = useState(false)
  const paraInicial = useRef(Boolean(sesion?.email))

  // Si el contexto no traía el email (sesión de admin con usuario y contraseña, o contexto viejo),
  // se pide a GET /api/sesion al abrir; si tampoco lo hay, el campo se queda vacío y el usuario lo escribe.
  useEffect(() => {
    if (paraInicial.current) return undefined
    let vivo = true
    obtenerSesion()
      .then((s) => {
        if (vivo && s?.email) setPara((actual) => actual || s.email)
      })
      .catch(() => {})
    return () => {
      vivo = false
    }
  }, [])

  // Sondeo del envío tras el 201. Se detiene solo cuando el estado sale de la cola o al agotar el
  // plazo, y siempre al desmontar el modal.
  const mensajeId = resultado?.message_id
  const estadoInicial = resultado?.estado
  useEffect(() => {
    if (!mensajeId || !EN_COLA.has(estadoInicial)) return undefined
    let vivo = true
    let consultando = false
    const inicio = Date.now()
    const consultar = async () => {
      if (consultando) return
      consultando = true
      try {
        const d = await obtenerEnvio(mensajeId)
        if (!vivo) return
        const e = d?.envio ?? d?.mensaje ?? d
        if (e?.status) {
          setEnvio(e)
          if (!EN_COLA.has(e.status)) {
            clearInterval(temporizador)
            return
          }
        }
      } catch {
        // un fallo puntual de red no corta el sondeo: se vuelve a intentar en el siguiente tick
      } finally {
        consultando = false
      }
      if (vivo && Date.now() - inicio >= MAXIMO_MS) {
        clearInterval(temporizador)
        setAgotado(true)
      }
    }
    const temporizador = setInterval(consultar, CADA_MS)
    consultar()
    return () => {
      vivo = false
      clearInterval(temporizador)
    }
  }, [mensajeId, estadoInicial, obtenerEnvio])

  const enviar = async (e) => {
    e.preventDefault()
    const destino = para.trim().toLowerCase()
    if (!destino) return setError('Indica a qué dirección enviar la prueba.')
    if (!CORREO.test(destino)) return setError('La dirección de destino no es válida.')
    setError('')
    setEnviando(true)
    try {
      const r = await probar(remitente.id, destino)
      setResultado(r)
    } catch (err) {
      // 400 sin proveedor · 403 sin suscripción · 429 límite: el texto lo pone el servidor
      setError(err.message)
    } finally {
      setEnviando(false)
    }
  }

  // Estado que se pinta: la última lectura del sondeo o, hasta que llegue, la del propio 201.
  const estado = envio?.status || estadoInicial || ''
  const sondeando = Boolean(resultado) && EN_COLA.has(estado) && !agotado
  const proveedor = resultado?.proveedor?.name || envio?.proveedor_nombre || nombreProveedor || 'el proveedor'
  const ultimoError = envio?.last_error || (estado === 'suprimido' ? resultado?.aviso : '') || ''

  const textoResultado = () => {
    if (ACEPTADO.has(estado)) {
      return (
        <Aviso variant="ok">
          Aceptado por <strong className="text-ink">{proveedor}</strong>. Revisa la bandeja de{' '}
          <span className="text-ink">{resultado.to_email}</span> (y la carpeta de spam, por si acaso).
        </Aviso>
      )
    }
    if (estado && !EN_COLA.has(estado)) {
      return (
        <Aviso variant="error">
          {ultimoError || `El envío terminó en estado «${estado}» sin más detalle. Míralo en Envíos.`}
        </Aviso>
      )
    }
    if (agotado) {
      return (
        <Aviso variant="warn">
          Sigue en cola. El worker lo sacará en cuanto pueda: míralo en{' '}
          <Link to={rutaEnvios} className="text-gold hover:underline">
            Envíos
          </Link>
          .
        </Aviso>
      )
    }
    return (
      <p className="text-sm text-ink2">
        Prueba encolada para <span className="text-ink">{resultado.to_email}</span>. Esperando a que el proveedor la
        acepte…
      </p>
    )
  }

  return (
    <Modal
      title="Enviar correo de prueba"
      description="Un correo automático desde este remitente, por su proveedor, para comprobar que funciona."
      onClose={onCerrar}
    >
      <div className="space-y-4">
        {error && (
          <Aviso variant="error" onCerrar={() => setError('')}>
            {error}
          </Aviso>
        )}

        <div className="bg-card2 border border-border rounded-xl p-3.5 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <div className="text-[11px] text-mut uppercase tracking-wide">Remitente</div>
            <div className="text-sm text-ink break-words">{remitente.name}</div>
            <div className="text-xs text-ink2 break-words">{remitente.email}</div>
          </div>
          <div>
            <div className="text-[11px] text-mut uppercase tracking-wide">Proveedor</div>
            <div className="text-sm text-ink break-words">{nombreProveedor || '—'}</div>
            {remitente.reply_to && <div className="text-xs text-ink2 break-words">Responder a: {remitente.reply_to}</div>}
          </div>
        </div>

        {!resultado ? (
          <form onSubmit={enviar} className="space-y-4">
            <Campo
              label="Enviar a"
              type="email"
              placeholder="tu@correo.com"
              value={para}
              onChange={(e) => setPara(e.target.value)}
              autoComplete="off"
              autoFocus
              hint="Por defecto, el correo con el que abriste el panel. Máximo 10 pruebas por remitente y hora."
            />
            <div className="flex justify-end gap-2 pt-1">
              <Boton type="button" variant="ghost" onClick={onCerrar}>
                Cancelar
              </Boton>
              <Boton type="submit" cargando={enviando}>
                {enviando ? 'Enviando…' : 'Enviar prueba'}
              </Boton>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3 flex-wrap">
              <Badge status={estado} />
              <span className="text-xs text-mut">#{resultado.message_id}</span>
              {sondeando && <Spinner texto="Esperando al proveedor…" size={14} />}
            </div>

            {textoResultado()}

            <div className="flex items-center justify-between gap-2 pt-1">
              <Link to={rutaEnvios} className="text-xs text-gold hover:underline">
                Ver en Envíos
              </Link>
              <Boton type="button" onClick={onCerrar}>
                Cerrar
              </Boton>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
