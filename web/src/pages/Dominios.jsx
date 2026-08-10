import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  crearDominio,
  crearDominioTracking,
  eliminarDominio,
  eliminarDominioTracking,
  listarDominios,
  listarDominiosTracking,
  verificarDominio,
  verificarDominioTracking,
} from '../api.js'
import { Aviso, Boton, Campo, Confirmar, Copiar, Spinner, Tabla } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const fecha = (d) => (d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }) : '—')

const DOMINIO = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/

// El nombre y el valor del TXT los monta el backend (location.js → serializarDominio) y son los
// mismos que comprueba /verificar. Reconstruirlos aquí haría que el panel pidiera publicar un
// registro que el verificador nunca busca, y el dominio no se validaría jamás.
const SUBDOMINIO_TXT = '_disruptivo-verify'
const nombreTxt = (d) => d?.registro_txt || `${SUBDOMINIO_TXT}.${d?.domain}`
const valorTxt = (d) => d?.valor_txt || (d?.verify_token ? `disruptivo-verify=${d.verify_token}` : '')

function Chip({ tono, children }) {
  const clases = {
    ok: 'border-ok/40 text-ok bg-ok/10',
    warn: 'border-warn/40 text-warn bg-warn/10',
    mut: 'border-border text-mut bg-card2',
  }
  return <span className={`text-[11px] px-2 py-0.5 rounded-full border whitespace-nowrap ${clases[tono]}`}>{children}</span>
}

// Guía en 3 pasos para publicar el TXT, en cristiano y con botones de copiar.
function PasosTxt({ dominio }) {
  return (
    <div className="mt-4 border-t border-border pt-4">
      <ol className="space-y-2.5 text-sm text-ink2 mb-4">
        <li className="flex gap-3">
          <span className="grid place-items-center w-5 h-5 rounded-full bg-gold/15 text-gold text-[11px] shrink-0">1</span>
          <span>
            Entra donde gestionas <strong className="text-ink">{dominio.domain}</strong> (GoDaddy, Cloudflare, IONOS,
            Hostinger…) y busca el apartado <strong className="text-ink">DNS</strong>.
          </span>
        </li>
        <li className="flex gap-3">
          <span className="grid place-items-center w-5 h-5 rounded-full bg-gold/15 text-gold text-[11px] shrink-0">2</span>
          <span>
            Crea un registro nuevo de tipo <strong className="text-ink">TXT</strong> con este nombre y este valor
            (cópialos con los botones):
          </span>
        </li>
      </ol>
      <Tabla columnas={['Tipo', 'Nombre', 'Valor']}>
        <tr>
          <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono">TXT</td>
          <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
            <span className="inline-flex items-center gap-2">
              {nombreTxt(dominio)}
              <Copiar value={nombreTxt(dominio)} />
            </span>
          </td>
          <td className="px-3 py-2.5 text-sm border-t border-border/60 font-mono break-all">
            <span className="inline-flex items-center gap-2">
              {valorTxt(dominio)}
              <Copiar value={valorTxt(dominio)} />
            </span>
          </td>
        </tr>
      </Tabla>
      <p className="text-[11px] text-mut mt-2">
        Si tu proveedor de DNS añade el dominio solo, escribe únicamente <code className="text-ink2">{SUBDOMINIO_TXT}</code>{' '}
        en el campo «Nombre».
      </p>
      <ol className="space-y-2.5 text-sm text-ink2 mt-3" start={3}>
        <li className="flex gap-3">
          <span className="grid place-items-center w-5 h-5 rounded-full bg-gold/15 text-gold text-[11px] shrink-0">3</span>
          <span>
            Vuelve aquí y pulsa <strong className="text-ink">«Comprobar ahora»</strong>. Los DNS pueden tardar desde unos
            minutos hasta unas horas en propagarse: si no sale a la primera, prueba más tarde.
          </span>
        </li>
      </ol>
    </div>
  )
}

export default function Dominios() {
  const [datos, setDatos] = useState(null) // { dominios: [], remitentes: [] }
  const [error, setError] = useState('')
  const [aviso, setAviso] = useState(null) // { ok, detalle }
  const [ocupado, setOcupado] = useState(null) // domain o id en curso
  const [aBorrar, setABorrar] = useState(null) // fila de sender_domains a confirmar
  const [borrando, setBorrando] = useState(false)

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
      const d = await listarDominios()
      setDatos({ dominios: lista(d, 'dominios'), remitentes: lista(d?.dominios_remitentes, 'dominios_remitentes') })
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos({ dominios: [], remitentes: [] })
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

  // La pantalla se monta desde los dominios de los remitentes: nada de campos libres.
  const filas = useMemo(() => {
    if (!datos) return { propios: [], huerfanos: [] }
    const porDominio = new Map(datos.dominios.map((d) => [d.domain, d]))
    const propios = datos.remitentes.map((r) => ({ ...r, registro: porDominio.get(r.domain) || null }))
    const conRemitente = new Set(datos.remitentes.map((r) => r.domain))
    const huerfanos = datos.dominios.filter((d) => !conRemitente.has(d.domain))
    return { propios, huerfanos }
  }, [datos])

  const proteger = async (domain) => {
    setOcupado(domain)
    setAviso(null)
    try {
      await crearDominio({ domain })
      await cargar()
    } catch (err) {
      setAviso({ ok: false, detalle: err.message })
    } finally {
      setOcupado(null)
    }
  }

  const comprobar = async (d) => {
    setOcupado(d.id)
    setAviso(null)
    try {
      // el backend solo responde 200 cuando verifica (el TXT ausente llega como 409 → ErrorApi,
      // con el mensaje detallado del servidor en err.message)
      await verificarDominio(d.id)
      setAviso({ ok: true, detalle: `${d.domain} verificado: ya es tuyo y ninguna otra subcuenta puede usarlo.` })
      await cargar()
    } catch (err) {
      setAviso({ ok: false, detalle: err.message })
    } finally {
      setOcupado(null)
    }
  }

  const quitar = async () => {
    if (!aBorrar) return
    setBorrando(true)
    try {
      await eliminarDominio(aBorrar.id)
      setABorrar(null)
      setAviso(null)
      await cargar()
    } catch (err) {
      setAviso({ ok: false, detalle: err.message })
      setABorrar(null)
    } finally {
      setBorrando(false)
    }
  }

  const dtrack = tracking?.dominios?.[0] || null
  const destinoCname = dtrack?.destino_cname || tracking?.destino || ''

  const anadirTracking = async (e) => {
    e.preventDefault()
    const dominio = nuevoTracking.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
    if (!DOMINIO.test(dominio)) {
      setErrorTracking('Escribe un subdominio válido, por ejemplo link.tudominio.com (sin http:// ni barras).')
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
      // igual que en comprobar(): un 200 siempre es verificado; los fallos llegan como 409 al catch
      await verificarDominioTracking(d.id)
      setResultadoTracking({
        ok: true,
        detalle: `${d.domain} verificado: los enlaces y el pixel de tus correos ya salen por tu dominio.`,
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
          Estos son los dominios de tus remitentes: no tienes que escribir nada, aparecen aquí solos. Verificar un
          dominio es <strong className="text-ink">opcional</strong> (tus correos salen igual sin hacerlo), pero al
          verificarlo queda registrado como tuyo y ninguna otra subcuenta podrá enviar con direcciones de ese dominio.
        </p>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}
      {aviso && <Aviso variant={aviso.ok ? 'ok' : 'warn'}>{aviso.detalle}</Aviso>}

      {filas.propios.length === 0 && filas.huerfanos.length === 0 ? (
        <div className={TARJETA}>
          <p className="text-sm text-mut py-8 text-center">
            Aquí no hay nada que hacer todavía. Cuando crees tu primer remitente en{' '}
            <Link to="/remitentes" className="text-gold hover:underline">
              Remitentes
            </Link>
            , su dominio aparecerá aquí solo.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {filas.propios.map((f) => {
            const d = f.registro
            return (
              <div key={f.domain} className={TARJETA}>
                <div className="flex items-center justify-between gap-4 flex-wrap">
                  <div>
                    <div className="font-semibold">{f.domain}</div>
                    <div className="text-[11px] text-mut">
                      {f.remitentes === 1 ? '1 remitente' : `${f.remitentes} remitentes`}
                      {d?.verified ? ` · verificado el ${fecha(d.verified_at)}` : ''}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    {f.gratuito ? (
                      <Chip tono="mut">Correo gratuito · no aplica</Chip>
                    ) : d?.verified ? (
                      <Chip tono="ok">Verificado · es tuyo</Chip>
                    ) : d ? (
                      <Chip tono="warn">Falta el registro DNS</Chip>
                    ) : (
                      <Chip tono="mut">Sin verificar</Chip>
                    )}
                    {!f.gratuito && d && !d.verified && (
                      <Boton variant="ghost" disabled={ocupado === d.id} onClick={() => comprobar(d)}>
                        {ocupado === d.id ? 'Comprobando…' : 'Comprobar ahora'}
                      </Boton>
                    )}
                    {!f.gratuito && !d && (
                      <Boton disabled={ocupado === f.domain} onClick={() => proteger(f.domain)}>
                        {ocupado === f.domain ? 'Preparando…' : 'Verificar este dominio'}
                      </Boton>
                    )}
                    {d && (
                      <Boton variant="ghost" onClick={() => setABorrar(d)}>
                        Quitar
                      </Boton>
                    )}
                  </div>
                </div>

                {f.gratuito && (
                  <p className="text-[11px] text-mut mt-2">
                    Los dominios como Gmail, Outlook o Yahoo no son de nadie en particular, así que no se pueden
                    verificar. No pasa nada: tus envíos funcionan igual.
                  </p>
                )}

                {!f.gratuito && !d && (
                  <p className="text-[11px] text-mut mt-2">
                    Al pulsar «Verificar este dominio» te damos un pequeño registro para pegar en tu DNS. Es la manera de
                    demostrar que el dominio es tuyo.
                  </p>
                )}

                {!f.gratuito && d && !d.verified && valorTxt(d) && <PasosTxt dominio={d} />}
              </div>
            )
          })}

          {filas.huerfanos.length > 0 && (
            <div className={TARJETA}>
              <div className="text-sm font-semibold mb-1">Dominios sin remitente</div>
              <p className="text-[11px] text-mut mb-3">
                Se añadieron en su día pero ya no corresponden a ningún remitente tuyo. Los que están sin verificar
                puedes quitarlos sin miedo; uno verificado sigue reservando el dominio para ti mientras exista.
              </p>
              <div className="space-y-2">
                {filas.huerfanos.map((d) => (
                  <div
                    key={d.id}
                    className="flex items-center justify-between gap-3 bg-card2 border border-border rounded-xl px-3.5 py-2.5"
                  >
                    <div className="min-w-0">
                      <span className="text-sm text-ink break-all">{d.domain}</span>
                    </div>
                    <div className="flex items-center gap-3 shrink-0">
                      {d.verified ? <Chip tono="ok">Verificado</Chip> : <Chip tono="mut">Sin verificar</Chip>}
                      <Boton variant="ghost" onClick={() => setABorrar({ ...d, huerfano: true })}>
                        Quitar
                      </Boton>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-2">Para qué sirve esto</div>
        <p className="text-sm text-ink2">
          Al verificar un dominio demuestras que es tuyo, y a partir de ahí ninguna otra subcuenta de esta plataforma
          puede enviar correos con direcciones de ese dominio: nadie puede hacerse pasar por ti. Solo puedes verificar
          dominios que ya uses en tus remitentes, y la verificación exige tocar el DNS del dominio — por eso nadie puede
          «reclamar» un dominio que no controla. Ojo: esto no sustituye a la entregabilidad (SPF, DKIM y DMARC van en tu
          proveedor de envío, como siempre).
        </p>
      </div>

      {/* ------------------------------------------------------------------
          Dominio de tracking (SPEC §11.3): CNAME del cliente → host de la app
          ------------------------------------------------------------------ */}
      <div className="pt-2">
        <h2 className="text-lg font-bold">Enlaces con tu marca (opcional)</h2>
        <p className="text-sm text-ink2 mt-1">
          Los enlaces y el pixel de apertura de tus correos usan el dominio de la app. Si prefieres que lleven tu marca,
          apunta aquí un subdominio tuyo (por ejemplo <code className="text-ink2">link.tudominio.com</code>): mejora la
          imagen de tus correos y la reputación pasa a ser solo tuya.
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
              label="Subdominio para tus enlaces"
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
            de tracking por subcuenta, y quitarlo después no rompe nada.
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
              {dtrack.verified ? <Chip tono="ok">Verificado</Chip> : <Chip tono="warn">Falta el registro DNS</Chip>}
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
                En el DNS de tu dominio crea estos dos registros y pulsa «Comprobar ahora». El CNAME dirige los enlaces
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

      {aBorrar && (
        <Confirmar
          titulo="Quitar dominio"
          mensaje={
            aBorrar.verified
              ? `${aBorrar.domain} dejará de estar registrado como tuyo: cualquier otra subcuenta podría verificarlo a partir de ahora. Tus remitentes y envíos no se tocan.`
              : aBorrar.huerfano
                ? `Se quita ${aBorrar.domain} de la lista. Para volver a añadirlo tendrías que crear antes un remitente con un correo de ese dominio.`
                : `Se quita ${aBorrar.domain} de la lista. Puedes volver a añadirlo cuando quieras con el botón «Verificar este dominio».`
          }
          peligro={Boolean(aBorrar.verified)}
          ocupado={borrando}
          textoConfirmar="Quitar"
          onConfirmar={quitar}
          onCancelar={() => setABorrar(null)}
        />
      )}

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
