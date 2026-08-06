import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'
import { Aviso, Boton, Campo, Copiar, Interruptor, Spinner } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

// Un secreto puede llegar como {configurado:true}, como cadena enmascarada o como booleano.
function estaConfigurado(v) {
  if (v == null) return false
  if (typeof v === 'object') return Boolean(v.configurado)
  if (typeof v === 'boolean') return v
  return String(v).length > 0
}

// Solo es utilizable si el backend devuelve el valor en claro (no enmascarado).
const enClaro = (v) => (typeof v === 'string' && v && !/^[•*]+$/.test(v) && !v.includes('…') ? v : '')

const Url = ({ etiqueta, valor, nota }) => (
  <div className="bg-card2 border border-border rounded-xl px-3.5 py-2.5">
    <div className="text-[11px] text-mut uppercase tracking-wide mb-1">{etiqueta}</div>
    <div className="flex items-center gap-2">
      <span className="text-xs text-ink font-mono break-all">{valor}</span>
      <span className="ml-auto shrink-0">
        <Copiar value={valor} />
      </span>
    </div>
    {nota && <div className="text-[11px] text-mut mt-1">{nota}</div>}
  </div>
)

export default function Ajustes() {
  const [ajustes, setAjustes] = useState(null)
  const [error, setError] = useState('')
  const [ok, setOk] = useState('')
  const [guardando, setGuardando] = useState(false)
  const [errores, setErrores] = useState([])

  const [ghl, setGhl] = useState({ client_id: '', app_id: '', company_id: '' })
  const [secretos, setSecretos] = useState({ client_secret: '', shared_secret: '' })
  const [reemplazar, setReemplazar] = useState({ client_secret: false, shared_secret: false })
  // Los nombres son los del backend (lib/settings.js → getLimites): envio_minuto / envio_dia.
  const [limites, setLimites] = useState({ envio_minuto: '', envio_dia: '' })

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/ajustes')
      setAjustes(d || {})
      setGhl({
        client_id: d?.ghl?.client_id || '',
        app_id: d?.ghl?.app_id || '',
        company_id: d?.ghl?.company_id || '',
      })
      setLimites({
        envio_minuto: d?.limites?.envio_minuto == null ? '' : String(d.limites.envio_minuto),
        envio_dia: d?.limites?.envio_dia == null ? '' : String(d.limites.envio_dia),
      })
      setSecretos({ client_secret: '', shared_secret: '' })
      setReemplazar({
        client_secret: !estaConfigurado(d?.ghl?.client_secret),
        shared_secret: !estaConfigurado(d?.ghl?.shared_secret),
      })
      setError('')
    } catch (e) {
      setError(e.message)
      setAjustes({})
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const guardar = async (e) => {
    e.preventDefault()
    const fallos = []
    for (const [clave, etiqueta] of [
      ['envio_minuto', 'por minuto'],
      ['envio_dia', 'por día'],
    ]) {
      const v = limites[clave]
      if (v && (!/^\d+$/.test(v) || Number(v) < 1)) fallos.push(`El límite ${etiqueta} tiene que ser un entero mayor que cero.`)
    }
    if (reemplazar.client_secret && !secretos.client_secret.trim() && estaConfigurado(ajustes?.ghl?.client_secret)) {
      fallos.push('Has marcado reemplazar el Client Secret pero no has escrito ninguno.')
    }
    if (reemplazar.shared_secret && !secretos.shared_secret.trim() && estaConfigurado(ajustes?.ghl?.shared_secret)) {
      fallos.push('Has marcado reemplazar el Shared Secret pero no has escrito ninguno.')
    }
    setErrores(fallos)
    if (fallos.length) return

    const cuerpo = {
      ghl: {
        client_id: ghl.client_id.trim(),
        app_id: ghl.app_id.trim(),
        company_id: ghl.company_id.trim(),
      },
      limites: {},
    }
    // un límite vacío se OMITE: el backend rechaza cualquier valor menor que 1, así que
    // mandar null devolvería un 400 en vez de dejar el valor por defecto del entorno
    if (limites.envio_minuto) cuerpo.limites.envio_minuto = Number(limites.envio_minuto)
    if (limites.envio_dia) cuerpo.limites.envio_dia = Number(limites.envio_dia)
    // los secretos solo viajan si el usuario ha escrito uno nuevo
    if (secretos.client_secret.trim()) cuerpo.ghl.client_secret = secretos.client_secret.trim()
    if (secretos.shared_secret.trim()) cuerpo.ghl.shared_secret = secretos.shared_secret.trim()

    setGuardando(true)
    setOk('')
    try {
      await api.put('/api/admin/ajustes', cuerpo)
      setOk('Ajustes guardados.')
      await cargar()
    } catch (err) {
      setErrores([err.message])
    } finally {
      setGuardando(false)
    }
  }

  if (ajustes === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  const base = ajustes?.app_base_url || window.location.origin
  // GET /api/admin/ajustes ya devuelve las URLs montadas con el action_secret real (admin.js →
  // vistaAjustes). Solo se reconstruyen a mano si esa clave no llegara, y entonces sin secreto.
  const urls = ajustes?.urls || {}
  const secreto = enClaro(ajustes?.ghl?.action_secret)
  const seg = secreto || '<secreto-de-acciones>'
  const urlNodo = (clave, respaldo) => urls[clave] || `${base}${respaldo}`
  const faltanUrls = !urls.accion_plantilla && !secreto

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Ajustes</h1>
        <p className="text-sm text-ink2 mt-1">
          Credenciales de la app del marketplace y límites de envío. Los secretos guardados no se muestran nunca.
        </p>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}
      {ok && <Aviso variant="ok">{ok}</Aviso>}
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

      <form onSubmit={guardar} className="space-y-6">
        <div className={`${TARJETA} space-y-4`}>
          <div>
            <div className="text-sm font-semibold">Credenciales de GoHighLevel</div>
            <p className="text-[11px] text-mut mt-0.5">
              Marketplace › tu app › Settings. El Shared Secret es el que descifra la identidad del usuario dentro del
              iframe: sin él, las subcuentas no pueden entrar.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            <Campo
              label="Client ID"
              value={ghl.client_id}
              onChange={(e) => setGhl((g) => ({ ...g, client_id: e.target.value }))}
              autoComplete="off"
            />
            <Campo
              label="App ID"
              value={ghl.app_id}
              onChange={(e) => setGhl((g) => ({ ...g, app_id: e.target.value }))}
              autoComplete="off"
            />
            <Campo
              className="sm:col-span-2"
              label="Company ID de la agencia"
              value={ghl.company_id}
              onChange={(e) => setGhl((g) => ({ ...g, company_id: e.target.value }))}
              autoComplete="off"
              hint="Se usa para distinguir las instalaciones de tu agencia."
            />
          </div>

          {[
            ['client_secret', 'Client Secret', 'Se usa para canjear el código de OAuth.'],
            ['shared_secret', 'Shared Secret', 'Advanced Settings › Auth › Shared Secret.'],
          ].map(([clave, etiqueta, ayuda]) => {
            const configurado = estaConfigurado(ajustes?.ghl?.[clave])
            return (
              <div key={clave} className="bg-card2 border border-border rounded-xl p-3.5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="text-sm">{etiqueta}</div>
                    <div className="text-[11px] text-mut">
                      {configurado ? 'Guardado · no se puede mostrar' : 'Sin configurar'}
                    </div>
                  </div>
                  {configurado && (
                    <Interruptor
                      checked={reemplazar[clave]}
                      onChange={(v) => {
                        setReemplazar((r) => ({ ...r, [clave]: v }))
                        if (!v) setSecretos((s) => ({ ...s, [clave]: '' }))
                      }}
                      label="Reemplazar"
                    />
                  )}
                </div>
                {(!configurado || reemplazar[clave]) && (
                  <Campo
                    type="password"
                    value={secretos[clave]}
                    onChange={(e) => setSecretos((s) => ({ ...s, [clave]: e.target.value }))}
                    autoComplete="new-password"
                    hint={ayuda}
                  />
                )}
              </div>
            )
          })}
        </div>

        <div className={`${TARJETA} space-y-4`}>
          <div>
            <div className="text-sm font-semibold">Límites de envío por subcuenta</div>
            <p className="text-[11px] text-mut mt-0.5">
              GHL dispara todos los correos de un workflow de golpe, sin freno propio. Estos límites son lo que evita
              quemar la reputación del dominio. Vacío = se usa el valor de las variables de entorno.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Campo
              label="Máximo por minuto"
              inputMode="numeric"
              placeholder="60"
              value={limites.envio_minuto}
              onChange={(e) => setLimites((l) => ({ ...l, envio_minuto: e.target.value }))}
            />
            <Campo
              label="Máximo por día"
              inputMode="numeric"
              placeholder="5000"
              value={limites.envio_dia}
              onChange={(e) => setLimites((l) => ({ ...l, envio_dia: e.target.value }))}
            />
          </div>
        </div>

        <div className="flex justify-end">
          <Boton type="submit" disabled={guardando}>
            {guardando ? 'Guardando…' : 'Guardar ajustes'}
          </Boton>
        </div>
      </form>

      <div className={`${TARJETA} space-y-3`}>
        <div>
          <div className="text-sm font-semibold">URLs para el marketplace</div>
          <p className="text-[11px] text-mut mt-0.5">
            Pega estas direcciones en la ficha de la app. Las de los nodos llevan un segmento secreto: no las publiques
            fuera del marketplace.
          </p>
        </div>

        <Url etiqueta="Redirect URL (OAuth)" valor={urlNodo('redirect_uri', '/api/oauth/callback')} />
        <Url etiqueta="Enlace de instalación" valor={urlNodo('instalar', '/api/oauth/instalar')} />
        <Url
          etiqueta="Acción · Enviar email con plantilla"
          valor={urlNodo('accion_plantilla', `/api/ghl/accion/plantilla/${seg}`)}
          nota="Execution URL del nodo 1."
        />
        <Url
          etiqueta="Campo dinámico · plantilla"
          valor={urlNodo('dinamico_plantilla', `/api/ghl/dinamico/plantilla/${seg}`)}
          nota="Dynamic Field URL del nodo 1."
        />
        <Url
          etiqueta="Acción · Enviar email personalizado"
          valor={urlNodo('accion_personalizado', `/api/ghl/accion/personalizado/${seg}`)}
          nota="Execution URL del nodo 2."
        />
        <Url
          etiqueta="Campo dinámico · personalizado"
          valor={urlNodo('dinamico_personalizado', `/api/ghl/dinamico/personalizado/${seg}`)}
          nota="Dynamic Field URL del nodo 2."
        />

        {faltanUrls && (
          <Aviso variant="info">
            Sustituye <code className="text-gold">&lt;secreto-de-acciones&gt;</code> por el segmento secreto de la
            instalación. Está guardado en los ajustes de la app y no se muestra aquí por seguridad.
          </Aviso>
        )}
      </div>
    </div>
  )
}
