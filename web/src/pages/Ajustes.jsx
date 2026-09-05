import { useCallback, useEffect, useState } from 'react'
import { api, emitirCertificadoRelay, fmtFecha, fmtFechaHora, obtenerEstadoRelayAdmin } from '../api.js'
import { Aviso, Badge, Boton, Campo, Copiar, Interruptor, Spinner } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

/* ============================================================
   Relay SMTP y certificado TLS (SPEC §13)
   ============================================================ */

const MODOS_TLS = {
  acme: 'Let’s Encrypt (automático, ACME HTTP-01 desde la app)',
  traefik: 'Let’s Encrypt vía Traefik (leído de su acme.json)',
  ficheros: 'Ficheros (SMTP_RELAY_TLS_CERT / _KEY)',
  autofirmado: 'Autofirmado (provisional, hasta que llegue el de Let’s Encrypt)',
}

// De dónde va a salir el certificado según la configuración (relay.origen_certificado del backend).
const ORIGENES = {
  traefik: 'del acme.json de Traefik (SMTP_RELAY_TRAEFIK_ACME)',
  acme: 'de Let’s Encrypt por ACME HTTP-01 desde la propia app',
  ficheros: 'de los ficheros SMTP_RELAY_TLS_CERT / _KEY',
  ninguno: 'de ningún sitio: SMTP_RELAY_TLS_AUTO=false sin ficheros ni Traefik',
}

// GET /api/admin/relay = estadoRelay() + estadoCertificado() (+ estadoTraefik() en modo traefik)
// (SPEC §13.2 y §13.3). Se aceptan las dos maneras razonables de mezclarlos: los campos del relay
// al nivel raíz o anidados en `relay`, el certificado en `certificado` y Traefik en `traefik`.
// Así la tarjeta no se queda en blanco por un detalle de forma.
function normalizarRelay(d) {
  const raiz = d && typeof d === 'object' ? d : {}
  const r = raiz.relay && typeof raiz.relay === 'object' ? raiz.relay : raiz
  const c = raiz.certificado && typeof raiz.certificado === 'object' ? raiz.certificado : {}
  const t = raiz.traefik && typeof raiz.traefik === 'object' ? raiz.traefik : {}
  const tls = r.tls && typeof r.tls === 'object' ? r.tls : {}
  const puertos = r.puertos && typeof r.puertos === 'object' ? r.puertos : {}
  const internos = r.puertos_internos && typeof r.puertos_internos === 'object' ? r.puertos_internos : null
  const error = tls.error || c.last_error || t.ultimo_error || null
  const validoHasta = tls.valido_hasta || c.expires_at || t.valido_hasta || null
  const modo = tls.modo || null
  const valido =
    typeof c.valido === 'boolean'
      ? c.valido
      : modo === 'ficheros' || ((modo === 'acme' || modo === 'traefik') && Boolean(validoHasta))
  return {
    activo: Boolean(r.activo ?? raiz.activo),
    host: r.host || tls.hostname || c.hostname || t.hostname || '',
    hostnameCert: c.hostname || tls.hostname || '',
    puertos: { starttls: puertos.starttls ?? null, ssl: puertos.ssl ?? null },
    puertosInternos: internos ? { starttls: internos.starttls ?? null, ssl: internos.ssl ?? null } : null,
    origen: r.origen_certificado || null,
    modo,
    valido,
    validoHasta,
    error: error ? String(error) : null,
    // último certificado que la pasarela no pudo aplicar aunque el que sirve siga bien
    ultimoRechazo: tls.ultimo_rechazo ? String(tls.ultimo_rechazo) : null,
    emitidoEl: c.issued_at || null,
    ultimoIntento: c.last_attempt_at || t.ultima_lectura || null,
    diasRestantes: typeof c.dias_restantes === 'number' ? c.dias_restantes : null,
    traefikRuta: t.ruta || null,
    traefikResolver: t.resolver || null,
  }
}

function BadgeCertificadoAdmin({ relay }) {
  if (!relay.activo) return <Badge estado="inactivo">Relay apagado</Badge>
  if (relay.modo === 'ficheros') return <Badge estado="ok">Certificado manual en ficheros</Badge>
  if (relay.valido) {
    return (
      <Badge estado="ok">
        Válido{relay.validoHasta ? ` hasta ${fmtFecha(relay.validoHasta)}` : ''}
        {relay.diasRestantes != null ? ` · ${relay.diasRestantes} días` : ''}
      </Badge>
    )
  }
  if (relay.error) {
    return (
      <Badge estado="error" titulo={relay.error}>
        Error en la emisión
      </Badge>
    )
  }
  return <Badge estado="pendiente">En emisión</Badge>
}

const Fila = ({ etiqueta, children, mono = false }) => (
  <div className="bg-card2 border border-border rounded-xl px-3.5 py-2.5">
    <div className="text-[11px] text-mut uppercase tracking-wide mb-1">{etiqueta}</div>
    <div className={`text-sm text-ink break-all ${mono ? 'font-mono' : ''}`}>{children}</div>
  </div>
)

function TarjetaRelay() {
  const [relay, setRelay] = useState(null) // null = cargando
  const [error, setError] = useState('')
  const [emitiendo, setEmitiendo] = useState(false)
  const [refrescando, setRefrescando] = useState(false)
  const [resultado, setResultado] = useState(null) // { tipo: 'ok'|'error', texto }

  const cargar = useCallback(async () => {
    try {
      const d = await obtenerEstadoRelayAdmin()
      setRelay(normalizarRelay(d))
      setError('')
    } catch (e) {
      setError(e.message)
      setRelay(normalizarRelay(null))
    }
  }, [])

  useEffect(() => {
    cargar()
  }, [cargar])

  const refrescar = async () => {
    setRefrescando(true)
    try {
      await cargar()
    } finally {
      setRefrescando(false)
    }
  }

  const emitir = async () => {
    setEmitiendo(true)
    setResultado(null)
    try {
      const r = await emitirCertificadoRelay()
      const estado = r?.estado && typeof r.estado === 'object' ? r.estado : null
      const validoHasta = estado?.expires_at || r?.traefik?.valido_hasta || null
      if (r?.ok === false) {
        setResultado({ tipo: 'error', texto: r.error || 'No se ha podido emitir el certificado.' })
      } else if (estado && estado.valido === false && estado.last_error) {
        setResultado({ tipo: 'error', texto: String(estado.last_error) })
      } else if (r?.aplicado === false) {
        // emitido (o leído) y guardado, pero la pasarela de esta instancia no lo ha aplicado:
        // relay con certificado de ficheros, relay no arrancado aquí, updateSecureContext fallido…
        setResultado({
          tipo: 'warn',
          texto:
            `Certificado obtenido${validoHasta ? ` (válido hasta el ${fmtFecha(validoHasta)})` : ''}, pero NO aplicado al relay de esta instancia` +
            `${r.detalle ? `: ${r.detalle}` : '.'}`,
        })
      } else if (r?.mensaje) {
        setResultado({ tipo: 'ok', texto: `${r.mensaje} Aplicado en caliente.` })
      } else if (validoHasta) {
        setResultado({ tipo: 'ok', texto: `Certificado emitido y aplicado en caliente. Válido hasta el ${fmtFecha(validoHasta)}.` })
      } else {
        setResultado({
          tipo: 'ok',
          texto: 'Petición aceptada. El certificado se aplica solo en cuanto responde Let’s Encrypt; pulsa «Actualizar» en unos segundos.',
        })
      }
    } catch (e) {
      setResultado({ tipo: 'error', texto: e.message })
    } finally {
      setEmitiendo(false)
      await cargar()
    }
  }

  if (relay === null) {
    return (
      <div className={`${TARJETA} space-y-3`}>
        <div className="text-sm font-semibold">Relay SMTP y certificado</div>
        <Spinner texto="Consultando el relay…" />
      </div>
    )
  }

  const puertoStarttls = relay.puertos.starttls
  const puertoSsl = relay.puertos.ssl
  const internos = relay.puertosInternos
  const esTraefik = relay.origen === 'traefik'
  const esFicheros = relay.origen === 'ficheros'

  return (
    <div className={`${TARJETA} space-y-4`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-sm font-semibold">Relay SMTP y certificado</div>
          <p className="text-[11px] text-mut mt-0.5">
            Estado del servidor SMTP que reciben las subcuentas y de su certificado TLS. Precedencia: ficheros &gt; Traefik
            (se lee el certificado que Traefik ya renueva) &gt; Let&rsquo;s Encrypt desde la app (ACME HTTP-01) &gt;
            autofirmado provisional. En EasyPanel el modo que funciona es el de Traefik (DEPLOY.md, sección D).
          </p>
        </div>
        <BadgeCertificadoAdmin relay={relay} />
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      {!relay.activo && (
        <Aviso variant="warn">
          El relay está apagado: <code className="text-ink">SMTP_RELAY_ENABLED</code> no es <code className="text-ink">true</code>{' '}
          o la pasarela no pudo abrir ninguna escucha (mira el log del servicio). Las subcuentas ven el aviso de «servidor
          apagado» en su pantalla Relay. Para encenderlo: DEPLOY.md, sección D.
        </Aviso>
      )}

      {relay.activo && relay.origen === 'acme' && (
        <Aviso variant="info">
          El certificado se pide a Let&rsquo;s Encrypt desde la propia app (reto HTTP-01). Detrás de Traefik con ACME (EasyPanel)
          ese reto no llega a la app: define <code className="text-ink">SMTP_RELAY_TRAEFIK_ACME</code> y monta el acme.json de
          Traefik (DEPLOY.md, sección D).
        </Aviso>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <Fila etiqueta="Host del relay" mono>
          {relay.host || '—'}
        </Fila>
        <Fila etiqueta="Puertos públicos (los que ven las subcuentas)" mono>
          {puertoStarttls != null ? `${puertoStarttls} · TLS/STARTTLS` : '—'}
          {puertoSsl != null ? ` / ${puertoSsl} · SSL` : ' / SSL no publicado'}
        </Fila>
        {internos && (
          <Fila etiqueta="Escuchas internas del contenedor" mono>
            {internos.starttls != null ? `${internos.starttls} · STARTTLS` : '—'}
            {internos.ssl != null ? ` / ${internos.ssl} · SSL` : ' / SSL no levantado'}
          </Fila>
        )}
        <Fila etiqueta="Origen del certificado">{relay.origen ? ORIGENES[relay.origen] || relay.origen : '—'}</Fila>
        <Fila etiqueta="Modo TLS en servicio">{relay.modo ? MODOS_TLS[relay.modo] || relay.modo : '—'}</Fila>
        <Fila etiqueta="Válido hasta">
          {relay.validoHasta ? fmtFechaHora(relay.validoHasta) : '—'}
          {relay.emitidoEl ? <span className="text-mut"> · emitido el {fmtFecha(relay.emitidoEl)}</span> : null}
        </Fila>
        <Fila etiqueta="Último error" mono>
          {relay.error ? <span className="text-bad">{relay.error}</span> : <span className="text-mut">Ninguno</span>}
          {!relay.error && relay.ultimoRechazo ? (
            <span className="text-mut"> · último certificado rechazado (el que sirve sigue bien): {relay.ultimoRechazo}</span>
          ) : null}
        </Fila>
        <Fila etiqueta={esTraefik ? 'Última lectura del acme.json' : 'Último intento de emisión'}>
          {relay.ultimoIntento ? fmtFechaHora(relay.ultimoIntento) : '—'}
          {esTraefik && relay.traefikRuta ? <span className="text-mut"> · {relay.traefikRuta}</span> : null}
          {esTraefik && relay.traefikResolver ? <span className="text-mut"> · resolver {relay.traefikResolver}</span> : null}
          {relay.hostnameCert && relay.hostnameCert !== relay.host ? (
            <span className="text-mut"> · certificado de {relay.hostnameCert}</span>
          ) : null}
        </Fila>
      </div>

      <p className="text-[11px] text-mut">
        Los puertos públicos son los que se pegan en GHL. Las escuchas internas son puertos altos a propósito (el contenedor
        los abre sin privilegios): EasyPanel las publica en <em>Ports</em> como <code className="text-ink">587 → 2525</code>{' '}
        y <code className="text-ink">465 → 2465</code>.
      </p>

      {resultado && (
        <Aviso variant={resultado.tipo === 'ok' ? 'ok' : resultado.tipo === 'warn' ? 'warn' : 'error'}>{resultado.texto}</Aviso>
      )}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Boton variant="ghost" onClick={refrescar} cargando={refrescando} disabled={emitiendo}>
          Actualizar
        </Boton>
        <Boton onClick={emitir} cargando={emitiendo} disabled={refrescando || esFicheros}>
          {emitiendo
            ? esTraefik
              ? 'Leyendo el acme.json…'
              : 'Pidiendo a Let’s Encrypt…'
            : esTraefik
              ? 'Releer de Traefik ahora'
              : 'Emitir / renovar ahora'}
        </Boton>
      </div>
      <p className="text-[11px] text-mut text-right">
        {esTraefik
          ? 'La app relee el acme.json cuando Traefik lo cambia y, además, cada 12 h. Este botón lo relee ahora mismo; no llama a Let’s Encrypt.'
          : esFicheros
            ? 'Con certificado de ficheros no hay nada que pedir: renueva los ficheros en el volumen y reinicia el servicio.'
            : 'Tras un error, la app no vuelve a llamar a Let’s Encrypt hasta pasada una hora (cuota anti-abuso), y la renovación forzada de un certificado que aún vale solo se admite pasadas 48 h desde su emisión; si acabas de intentarlo, el botón te lo dirá.'}
      </p>
    </div>
  )
}

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
  // Los nombres son los del backend (lib/settings.js → getLimites): envio_minuto / envio_dia, y la
  // cuota por defecto del buzón (SPEC §14.1: buzon_quota_mb, 200 MB si no se indica).
  const [limites, setLimites] = useState({ envio_minuto: '', envio_dia: '', buzon_quota_mb: '' })

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
        buzon_quota_mb: d?.limites?.buzon_quota_mb == null ? '' : String(d.limites.buzon_quota_mb),
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
      ['buzon_quota_mb', 'de cuota del buzón'],
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
    if (limites.buzon_quota_mb) cuerpo.limites.buzon_quota_mb = Number(limites.buzon_quota_mb)
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
          <div className="border-t border-border/70 pt-4">
            <Campo
              className="sm:w-1/2 sm:pr-1.5"
              label="Cuota de buzón por defecto (MB)"
              inputMode="numeric"
              placeholder="200"
              value={limites.buzon_quota_mb}
              onChange={(e) => setLimites((l) => ({ ...l, buzon_quota_mb: e.target.value }))}
              hint="Espacio para el correo entrante (mensajes y adjuntos) de cada subcuenta que no tenga cuota propia. Al llenarse, su buzón deja de sincronizar hasta que borren correo. La cuota de una subcuenta concreta se cambia en Subcuentas."
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

      <TarjetaRelay />
    </div>
  )
}
