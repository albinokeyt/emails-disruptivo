import { useCallback, useEffect, useState } from 'react'
import {
  api,
  crearDominioTracking,
  eliminarDominioTracking,
  listarDominiosTracking,
  verificarDominioTracking,
} from '../api.js'
import { Aviso, Boton, Campo, Confirmar, Copiar, Spinner, Tabla } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const fecha = (d) => (d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

const DOMINIO = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

const GRATUITOS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com']

// El nombre y el valor del TXT los monta el backend (location.js → serializarDominio) y son los
// mismos que comprueba /verificar. Reconstruirlos aquí haría que el panel pidiera publicar un
// registro que el verificador nunca busca, y el dominio no se validaría jamás.
const SUBDOMINIO_TXT = '_disruptivo-verify'
const nombreTxt = (d) => d?.registro_txt || `${SUBDOMINIO_TXT}.${d?.domain}`
const valorTxt = (d) => d?.valor_txt || (d?.verify_token ? `disruptivo-verify=${d.verify_token}` : '')

export default function Dominios() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')
  const [nuevo, setNuevo] = useState('')
  const [errorAlta, setErrorAlta] = useState('')
  const [creando, setCreando] = useState(false)
  const [verificando, setVerificando] = useState(null)
  const [resultado, setResultado] = useState(null) // {id, ok, detalle}

  // Dominio de tracking (SPEC §11.3): como mucho uno por subcuenta
  const [tracking, setTracking] = useState(null) // { dominios: [], destino: '' }
  const [nuevoTracking, setNuevoTracking] = useState('')
  const [errorTracking, setErrorTracking] = useState('')
  const [creandoTracking, setCreandoTracking] = useState(false)
  const [verificandoTracking, setVerificandoTracking] = useState(false)
  const [resultadoTracking, setResultadoTracking] = useState(null) // {ok, detalle}
  const [borrarTracking, setBorrarTracking] = useState(null) // dominio a confirmar
  const [borrandoTracking, setBorrandoTracking] = useState(false)

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/loc/dominios')
      setDatos(lista(d, 'dominios'))
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
    }
  }, [])

  const cargarTracking = useCallback(async () => {
    try {
      const d = await listarDominiosTracking()
      setTracking({ dominios: lista(d, 'dominios'), destino: d?.destino_cname || '' })
      setErrorTracking('')
    } catch (e) {
      setTracking({ dominios: [], destino: '' })
      setErrorTracking(e.message)
    }
  }, [])

  useEffect(() => {
    cargar()
    cargarTracking()
  }, [cargar, cargarTracking])

  const dtrack = tracking?.dominios?.[0] || null
  const destinoCname = dtrack?.destino_cname || tracking?.destino || ''

  const anadirTracking = async (e) => {
    e.preventDefault()
    const dominio = nuevoTracking.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!DOMINIO.test(dominio)) {
      setErrorTracking('Escribe un dominio válido, por ejemplo link.tudominio.com (sin http:// ni barras).')
      return
    }
    setErrorTracking('')
    setResultadoTracking(null)
    setCreandoTracking(true)
    try {
      await crearDominioTracking({ domain: dominio })
      setNuevoTracking('')
      await cargarTracking()
    } catch (err) {
      setErrorTracking(err.message)
    } finally {
      setCreandoTracking(false)
    }
  }

  const verificarTracking = async (d) => {
    setVerificandoTracking(true)
    setResultadoTracking(null)
    try {
      const r = await verificarDominioTracking(d.id)
      const ok = r?.verificado ?? r?.ok ?? false
      setResultadoTracking({
        ok,
        detalle: ok
          ? `${d.domain} verificado: los enlaces y el pixel de tus correos ya salen por tu dominio.`
          : r?.detalle || r?.error || 'Todavía no se ve el CNAME. Los DNS pueden tardar unos minutos.',
      })
      await cargarTracking()
    } catch (err) {
      setResultadoTracking({ ok: false, detalle: err.message })
      // se recarga también tras un fallo: a los dominios antiguos el backend les genera el token
      // TXT en la primera comprobación, y así la fila TXT aparece sin refrescar la página
      await cargarTracking().catch(() => {})
    } finally {
      setVerificandoTracking(false)
    }
  }

  const eliminarTracking = async () => {
    if (!borrarTracking) return
    setBorrandoTracking(true)
    try {
      await eliminarDominioTracking(borrarTracking.id)
      setResultadoTracking(null)
      setBorrarTracking(null)
      await cargarTracking()
    } catch (err) {
      setResultadoTracking({ ok: false, detalle: err.message })
      setBorrarTracking(null)
    } finally {
      setBorrandoTracking(false)
    }
  }

  const anadir = async (e) => {
    e.preventDefault()
    const dominio = nuevo.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!DOMINIO.test(dominio)) {
      setErrorAlta('Escribe un dominio válido, por ejemplo tudominio.com (sin http:// ni barras).')
      return
    }
    if (GRATUITOS.includes(dominio)) {
      setErrorAlta('No se puede verificar un dominio de correo gratuito: usa un dominio propio.')
      return
    }
    setErrorAlta('')
    setCreando(true)
    try {
      await api.post('/api/loc/dominios', { domain: dominio })
      setNuevo('')
      await cargar()
    } catch (err) {
      setErrorAlta(err.message)
    } finally {
      setCreando(false)
    }
  }

  const verificar = async (d) => {
    setVerificando(d.id)
    setResultado(null)
    try {
      const r = await api.post(`/api/loc/dominios/${d.id}/verificar`)
      // el backend responde {ok, verificado, detalle} (location.js): «verified» no existe ahí
      const ok = r?.verificado ?? r?.verified ?? r?.ok ?? false
      setResultado({
        id: d.id,
        ok,
        detalle: ok
          ? `${d.domain} verificado correctamente.`
          : r?.detalle || r?.error || 'Todavía no se ve el registro TXT. Los DNS pueden tardar unos minutos.',
      })
      await cargar()
    } catch (err) {
      setResultado({ id: d.id, ok: false, detalle: err.message })
    } finally {
      setVerificando(null)
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
      <div>
        <h1 className="text-xl font-bold">Dominios</h1>
        <p className="text-sm text-ink2 mt-1">
          Demuestra que un dominio es tuyo para poder enviar desde él. Es lo que impide que otra subcuenta use tus
          direcciones.
        </p>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}
      {resultado && <Aviso variant={resultado.ok ? 'ok' : 'warn'}>{resultado.detalle}</Aviso>}

      <form onSubmit={anadir} className={TARJETA}>
        <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
          <Campo
            className="flex-1"
            label="Añadir dominio"
            placeholder="tudominio.com"
            value={nuevo}
            onChange={(e) => setNuevo(e.target.value)}
            autoComplete="off"
          />
          <Boton type="submit" disabled={creando}>
            {creando ? 'Añadiendo…' : 'Añadir'}
          </Boton>
        </div>
        {errorAlta && (
          <div className="mt-3">
            <Aviso variant="error">{errorAlta}</Aviso>
          </div>
        )}
      </form>

      {datos.length === 0 ? (
        <div className={TARJETA}>
          <p className="text-sm text-mut py-10 text-center">
            Todavía no has añadido ningún dominio. Añade el dominio de tus remitentes para verificarlo.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {datos.map((d) => (
            <div key={d.id} className={TARJETA}>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <div>
                  <div className="font-semibold">{d.domain}</div>
                  <div className="text-[11px] text-mut">
                    {d.verified ? `Verificado el ${fecha(d.verified_at)}` : `Añadido el ${fecha(d.created_at)}`}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={`text-[11px] px-2 py-0.5 rounded-full border ${
                      d.verified ? 'border-ok/40 text-ok bg-ok/10' : 'border-warn/40 text-warn bg-warn/10'
                    }`}
                  >
                    {d.verified ? 'Verificado' : 'Pendiente'}
                  </span>
                  {!d.verified && (
                    <Boton variant="ghost" disabled={verificando === d.id} onClick={() => verificar(d)}>
                      {verificando === d.id ? 'Comprobando…' : 'Comprobar ahora'}
                    </Boton>
                  )}
                </div>
              </div>

              {!d.verified && valorTxt(d) && (
                <div className="mt-4 border-t border-border pt-4">
                  <p className="text-sm text-ink2 mb-3">
                    Publica este registro TXT en el DNS de <strong className="text-ink">{d.domain}</strong> y pulsa
                    «Comprobar ahora». Suele tardar entre unos minutos y una hora en propagarse.
                  </p>
                  <Tabla columnas={['Tipo', 'Nombre', 'Valor', '']}>
                    <tr>
                      <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono">TXT</td>
                      <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
                        {nombreTxt(d)}
                      </td>
                      <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
                        {valorTxt(d)}
                      </td>
                      <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                        <Copiar value={valorTxt(d)} />
                      </td>
                    </tr>
                  </Tabla>
                  <p className="text-[11px] text-mut mt-2">
                    Si tu proveedor de DNS añade el dominio solo, escribe únicamente{' '}
                    <code className="text-ink2">{SUBDOMINIO_TXT}</code> en el campo «Nombre».
                  </p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-2">Por qué hace falta</div>
        <p className="text-sm text-ink2">
          Un dominio verificado pertenece a una sola subcuenta. Con eso, el relay puede rechazar cualquier intento de
          enviar desde tus direcciones desde otra cuenta. Verificar el dominio aquí no sustituye a la configuración de
          entregabilidad: para que el correo llegue a la bandeja de entrada necesitas además SPF, DKIM y DMARC publicados,
          y el dominio dado de alta en tu proveedor de envío.
        </p>
      </div>

      {/* ------------------------------------------------------------------
          Dominio de tracking (SPEC §11.3): CNAME del cliente → host de la app
          ------------------------------------------------------------------ */}
      <div className="pt-2">
        <h2 className="text-lg font-bold">Dominio de tracking</h2>
        <p className="text-sm text-ink2 mt-1">
          Haz que el pixel de apertura y los enlaces medidos de tus correos salgan por un subdominio tuyo en vez del
          dominio compartido de la app.
        </p>
      </div>

      {errorTracking && <Aviso variant="error">{errorTracking}</Aviso>}
      {resultadoTracking && <Aviso variant={resultadoTracking.ok ? 'ok' : 'warn'}>{resultadoTracking.detalle}</Aviso>}

      {tracking === null ? (
        <div className={TARJETA}>
          <div className="py-6 grid place-items-center">
            <Spinner />
          </div>
        </div>
      ) : !dtrack ? (
        <form onSubmit={anadirTracking} className={TARJETA}>
          <div className="flex flex-col sm:flex-row gap-3 sm:items-end">
            <Campo
              className="flex-1"
              label="Añadir dominio de tracking"
              placeholder="link.tudominio.com"
              value={nuevoTracking}
              onChange={(e) => setNuevoTracking(e.target.value)}
              autoComplete="off"
            />
            <Boton type="submit" disabled={creandoTracking}>
              {creandoTracking ? 'Añadiendo…' : 'Añadir'}
            </Boton>
          </div>
          <p className="text-[11px] text-mut mt-2">
            Usa un subdominio dedicado (por ejemplo <code className="text-ink2">link.</code> o{' '}
            <code className="text-ink2">click.</code>) que no tenga ya otros registros DNS. Solo puede haber un dominio
            de tracking por subcuenta.
          </p>
        </form>
      ) : (
        <div className={TARJETA}>
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <div className="font-semibold">{dtrack.domain}</div>
              <div className="text-[11px] text-mut">
                {dtrack.verified
                  ? `Verificado el ${fecha(dtrack.verified_at)}`
                  : `Añadido el ${fecha(dtrack.created_at)}`}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span
                className={`text-[11px] px-2 py-0.5 rounded-full border ${
                  dtrack.verified ? 'border-ok/40 text-ok bg-ok/10' : 'border-warn/40 text-warn bg-warn/10'
                }`}
              >
                {dtrack.verified ? 'Verificado' : 'Pendiente'}
              </span>
              {!dtrack.verified && (
                <Boton variant="ghost" disabled={verificandoTracking} onClick={() => verificarTracking(dtrack)}>
                  {verificandoTracking ? 'Comprobando…' : 'Comprobar ahora'}
                </Boton>
              )}
              <Boton variant="ghost" onClick={() => setBorrarTracking(dtrack)}>
                Eliminar
              </Boton>
            </div>
          </div>

          {!dtrack.verified && (
            <div className="mt-4 border-t border-border pt-4">
              <p className="text-sm text-ink2 mb-3">
                Crea estos dos registros en el DNS de tu dominio y pulsa «Comprobar ahora». El CNAME dirige los enlaces
                y el TXT demuestra que el dominio es tuyo. Suelen tardar entre unos minutos y una hora en propagarse.
              </p>
              <Tabla columnas={['Tipo', 'Nombre', 'Valor', '']}>
                <tr>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono">CNAME</td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
                    {dtrack.registro_cname || dtrack.domain}
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
                    {destinoCname || '—'}
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                    {destinoCname && <Copiar value={destinoCname} />}
                  </td>
                </tr>
                {valorTxt(dtrack) && (
                  <tr>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono">TXT</td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
                      {nombreTxt(dtrack)}
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
                      {valorTxt(dtrack)}
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                      <Copiar value={valorTxt(dtrack)} />
                    </td>
                  </tr>
                )}
              </Tabla>
              <p className="text-[11px] text-mut mt-2">
                Si tu proveedor de DNS añade el dominio solo, escribe únicamente la parte izquierda (por ejemplo{' '}
                <code className="text-ink2">link</code>) en el campo «Nombre».
              </p>
            </div>
          )}

          {dtrack.verified && (
            <p className="text-sm text-ink2 mt-3">
              Mantén el CNAME publicado: si lo quitas, los enlaces de los correos ya enviados dejarán de responder.
            </p>
          )}
        </div>
      )}

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-2">Por qué conviene</div>
        <p className="text-sm text-ink2">
          Sin dominio propio, los enlaces de todos los correos comparten el dominio de la app entre todas las
          subcuentas, y la reputación de unos arrastra a los demás. Con el CNAME verificado, los enlaces y el pixel de
          tus correos llevan tu dominio: la reputación pasa a ser tuya y los filtros de spam ven un enlace alineado con
          tu marca. Activarlo o quitarlo no rompe nada de lo ya enviado.
        </p>
      </div>

      {borrarTracking && (
        <Confirmar
          titulo="Eliminar dominio de tracking"
          mensaje={`Los próximos correos volverán a usar el dominio de la app. Los enlaces ya enviados seguirán funcionando mientras el CNAME de ${borrarTracking.domain} siga publicado.`}
          peligro
          ocupado={borrandoTracking}
          textoConfirmar="Eliminar"
          onConfirmar={eliminarTracking}
          onCancelar={() => setBorrarTracking(null)}
        />
      )}
    </div>
  )
}
