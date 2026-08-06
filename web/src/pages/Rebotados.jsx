import { useCallback, useEffect, useState } from 'react'
import { BellOff, Download, ExternalLink } from 'lucide-react'
import {
  dndMasivo, dndRebotado, fmtFecha, fmtFechaHora, guardarPreferencias,
  listarRebotados, obtenerPreferencias, urlExportarRebotados,
} from '../api.js'
import { useSesion } from '../hooks.js'
import { Aviso, Badge, Boton, Campo, Interruptor, Select, Spinner, Tabla } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'
const PAGINA = 50

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

// De dónde salió la supresión (SPEC §12.1). Los `source` reales que escribe el backend son
// `brevo:<evento>` (routes/webhooks.js), `verp:dsn` (smtp-relay/handler.js) y `envio`
// (lib/queue.js): se traducen por prefijo a una etiqueta llana.
const MOTIVOS = {
  webhook: ['Webhook del proveedor', 'El proveedor (Brevo) avisó del rebote duro por webhook'],
  envio: ['Rechazado al enviar', 'El servidor del destinatario rechazó la dirección en el momento del envío'],
  dsn: ['Aviso de rebote (DSN)', 'Llegó un aviso de rebote al buzón de retornos (VERP)'],
}

function motivoDe(source) {
  const s = String(source || '')
  if (s === 'envio') return MOTIVOS.envio
  if (s.startsWith('brevo:')) return MOTIVOS.webhook
  if (s.startsWith('verp:')) return MOTIVOS.dsn
  return [s || '—', '']
}

const VACIOS = { q: '', dnd: '' }

// Verde con fecha / gris «pendiente» / rojo con el error en el title (SPEC §12.5).
function BadgeDnd({ fila }) {
  if (fila.dnd_at) {
    return (
      <Badge estado="activo" titulo={`No Molestar activado en el canal Email el ${fmtFechaHora(fila.dnd_at)}`}>
        DND {fmtFecha(fila.dnd_at)}
      </Badge>
    )
  }
  if (fila.dnd_error) return <Badge estado="error" titulo={fila.dnd_error}>Error</Badge>
  return <Badge texto="Pendiente" titulo="Todavía sin marcar como No Molestar en GHL" />
}

export default function Rebotados() {
  const sesion = useSesion()

  // ---- preferencias (auto-DND) ----
  const [pref, setPref] = useState(null) // null = cargando
  const [guardandoPref, setGuardandoPref] = useState(false)
  const [errorPref, setErrorPref] = useState('')

  // ---- tabla ----
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')
  const [filtros, setFiltros] = useState(VACIOS)
  const [aplicados, setAplicados] = useState(VACIOS)
  const [offset, setOffset] = useState(0)
  const [total, setTotal] = useState(null)

  // ---- acciones DND ----
  const [dndEnCurso, setDndEnCurso] = useState({}) // { [id]: true } mientras la fila llama a GHL
  const [masivo, setMasivo] = useState(null) // { activo, procesados, correctos, fallidos, restantes, error }

  useEffect(() => {
    let vivo = true
    obtenerPreferencias()
      .then((d) => { if (vivo) setPref({ auto_dnd: Boolean(d?.auto_dnd) }) })
      .catch((e) => {
        if (vivo) {
          setPref({ auto_dnd: false })
          setErrorPref(e.message)
        }
      })
    return () => { vivo = false }
  }, [])

  const cargar = useCallback(async (off, f) => {
    setDatos(null)
    try {
      const d = await listarRebotados({ ...f, limite: PAGINA, pagina: Math.floor(off / PAGINA) + 1 })
      setDatos(lista(d, 'rebotados'))
      setTotal(Number.isFinite(Number(d?.total)) ? Number(d.total) : null)
      setOffset(off)
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
      setTotal(null)
    }
  }, [])

  useEffect(() => {
    cargar(0, aplicados)
  }, [cargar, aplicados])

  const cambiarAutoDnd = async (valor) => {
    const previo = pref
    setGuardandoPref(true)
    setPref({ auto_dnd: valor })
    try {
      const d = await guardarPreferencias({ auto_dnd: valor })
      if (d && typeof d === 'object' && 'auto_dnd' in d) setPref({ auto_dnd: Boolean(d.auto_dnd) })
      setErrorPref('')
    } catch (e) {
      setPref(previo)
      setErrorPref(e.message)
    } finally {
      setGuardandoPref(false)
    }
  }

  const actualizarFila = (id, cambios) => {
    setDatos((ds) => (Array.isArray(ds) ? ds.map((f) => (f.id === id ? { ...f, ...cambios } : f)) : ds))
  }

  const activarFila = async (fila) => {
    setDndEnCurso((m) => ({ ...m, [fila.id]: true }))
    try {
      const r = await dndRebotado(fila.id)
      if (r?.ok) {
        actualizarFila(fila.id, {
          dnd_at: r.dnd_at || new Date().toISOString(),
          dnd_error: null,
          ghl_contact_id: r.ghl_contact_id || fila.ghl_contact_id,
        })
      } else {
        actualizarFila(fila.id, { dnd_error: r?.error || 'No se pudo activar el DND' })
      }
    } catch (e) {
      actualizarFila(fila.id, { dnd_error: e.message })
    } finally {
      setDndEnCurso((m) => {
        const { [fila.id]: _hecha, ...resto } = m
        return resto
      })
    }
  }

  // Repite dnd-masivo mientras queden pendientes (SPEC §12.3). Si los restantes dejan
  // de bajar (todos los que quedan fallan), se corta: si no, esto no acabaría nunca.
  const activarTodos = async () => {
    let procesados = 0
    let correctos = 0
    let fallidos = 0
    let restantes = null
    let restantesPrevios = Infinity
    setMasivo({ activo: true, procesados, correctos, fallidos, restantes })
    try {
      for (;;) {
        const r = await dndMasivo()
        const tanda = Number(r?.procesados) || 0
        procesados += tanda
        correctos += Number(r?.correctos) || 0
        fallidos += Number(r?.fallidos) || 0
        restantes = Number(r?.restantes) || 0
        setMasivo({ activo: true, procesados, correctos, fallidos, restantes })
        if (restantes <= 0) break
        if (tanda === 0 || restantes >= restantesPrevios) break
        restantesPrevios = restantes
      }
      setMasivo({ activo: false, procesados, correctos, fallidos, restantes })
    } catch (e) {
      setMasivo({ activo: false, procesados, correctos, fallidos, restantes, error: e.message })
    }
    cargar(0, aplicados)
  }

  const urlFicha = (fila) =>
    `https://app.gohighlevel.com/v2/location/${sesion?.locationId}/contacts/detail/${fila.ghl_contact_id}`

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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Rebotados</h1>
          <p className="text-sm text-ink2 mt-1">
            Correos que rebotaron de forma definitiva. Desde aquí se marcan como No Molestar en GHL para que dejen de
            ensuciar tu base de datos.
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <a
            href={urlExportarRebotados(aplicados)}
            download="rebotados.csv"
            className="inline-flex items-center justify-center gap-2 px-4 py-2 text-sm rounded-xl bg-card2 text-ink hover:bg-border border border-border transition-colors"
          >
            <Download size={15} />
            Descargar CSV
          </a>
          <Boton icono={BellOff} cargando={masivo?.activo} onClick={activarTodos}>
            Activar DND a todos los pendientes
          </Boton>
        </div>
      </div>

      <div className={TARJETA}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <div className="text-sm font-semibold">DND automático</div>
            <p className="text-[11px] text-mut mt-1 leading-relaxed">
              Cuando un correo rebote, el contacto quedará marcado como No Molestar en el canal Email de GHL
              automáticamente; SMS y llamadas no se tocan. Solo se corta el correo, que es lo que está roto.
            </p>
          </div>
          {pref === null ? (
            <Spinner />
          ) : (
            <Interruptor
              checked={pref.auto_dnd}
              onChange={cambiarAutoDnd}
              disabled={guardandoPref}
              label={pref.auto_dnd ? 'Activado' : 'Desactivado'}
            />
          )}
        </div>
        {errorPref && (
          <div className="mt-3">
            <Aviso variant="error" onCerrar={() => setErrorPref('')}>{errorPref}</Aviso>
          </div>
        )}
      </div>

      {masivo?.activo && (
        <Aviso variant="info">
          <span className="inline-flex items-center gap-2">
            <Spinner />
            Activando DND… {masivo.procesados} procesados · {masivo.correctos} correctos · {masivo.fallidos} con error
            {masivo.restantes !== null && ` · quedan ${masivo.restantes}`}
          </span>
        </Aviso>
      )}
      {masivo && !masivo.activo && (
        <Aviso
          variant={masivo.error ? 'error' : masivo.fallidos > 0 || (masivo.restantes ?? 0) > 0 ? 'warn' : 'ok'}
          onCerrar={() => setMasivo(null)}
        >
          {masivo.error
            ? `Se cortó a mitad: ${masivo.error}. Antes del fallo, ${masivo.correctos} contactos quedaron con DND activado.`
            : masivo.procesados === 0
              ? 'No había ningún rebotado pendiente de DND.'
              : `Terminado: DND activado en ${masivo.correctos} contactos.${
                  masivo.fallidos > 0
                    ? ` ${masivo.fallidos} fallaron; el motivo queda en rojo en su fila y puedes reintentarlos uno a uno.`
                    : ''
                }${(masivo.restantes ?? 0) > 0 ? ` Quedan ${masivo.restantes} pendientes.` : ''}`}
        </Aviso>
      )}

      <form onSubmit={buscar} className={TARJETA}>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Campo label="Buscar" placeholder="Correo del destinatario" value={filtros.q} onChange={set('q')} />
          <Select label="DND" value={filtros.dnd} onChange={set('dnd')}>
            <option value="">Todos</option>
            <option value="con">Con DND</option>
            <option value="sin">Sin DND</option>
          </Select>
          <div className="col-span-2 flex items-end justify-end gap-2">
            {hayFiltros && (
              <Boton type="button" variant="ghost" onClick={limpiar}>
                Limpiar
              </Boton>
            )}
            <Boton type="submit">Filtrar</Boton>
          </div>
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
            {hayFiltros
              ? 'Ningún rebotado coincide con esos filtros.'
              : 'Todavía no hay ningún rebote duro registrado. Buena señal: tu lista está limpia.'}
          </p>
        </div>
      ) : (
        <div className={TARJETA}>
          <Tabla columnas={['Correo', 'Fecha', 'Motivo', 'Último asunto', 'DND', '']}>
            {datos.map((fila) => {
              const [motivo, detalleMotivo] = motivoDe(fila.source)
              const asunto = fila.ultimo_mensaje?.subject
              return (
                <tr key={fila.id}>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60">{fila.email}</td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 whitespace-nowrap">
                    {fmtFechaHora(fila.created_at)}
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                    <span title={detalleMotivo || undefined}>{motivo}</span>
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                    <div className="max-w-64 truncate" title={asunto || undefined}>
                      {asunto || '—'}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60">
                    <BadgeDnd fila={fila} />
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                    <div className="inline-flex items-center gap-2">
                      {fila.ghl_contact_id ? (
                        <a
                          href={urlFicha(fila)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg bg-card2 text-ink hover:bg-border border border-border transition-colors"
                        >
                          <ExternalLink size={13} />
                          Ficha en GHL
                        </a>
                      ) : (
                        <span title="El contacto aún no está resuelto en GHL: al activar el DND se busca por su correo y se guarda su ficha.">
                          <Boton tamano="sm" variante="secundario" icono={ExternalLink} disabled>
                            Ficha en GHL
                          </Boton>
                        </span>
                      )}
                      {!fila.dnd_at && (
                        <Boton
                          tamano="sm"
                          variante="contorno"
                          icono={BellOff}
                          cargando={Boolean(dndEnCurso[fila.id])}
                          disabled={Boolean(masivo?.activo)}
                          onClick={() => activarFila(fila)}
                        >
                          Activar DND
                        </Boton>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
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
    </div>
  )
}
