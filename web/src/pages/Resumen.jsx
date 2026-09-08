import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api.js'
import { Aviso, Spinner } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const ESTADOS = [
  ['encolado', 'En cola'],
  ['reintento', 'Reintento'],
  ['enviando', 'Enviando'],
  ['enviado', 'Enviado'],
  ['diferido', 'Diferido'],
  ['entregado', 'Entregado'],
  ['rebotado', 'Rebotado'],
  ['spam', 'Spam'],
  ['fallido', 'Fallido'],
  ['suprimido', 'Suprimido'],
]

const COLOR = {
  entregado: 'text-ok',
  enviado: 'text-ok',
  encolado: 'text-ink2',
  reintento: 'text-warn',
  enviando: 'text-ink2',
  diferido: 'text-warn',
  rebotado: 'text-bad',
  spam: 'text-bad',
  fallido: 'text-bad',
  suprimido: 'text-mut',
}

const numero = (n) => new Intl.NumberFormat('es-ES').format(Number(n) || 0)

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

// El backend puede agregar por estado como objeto {enviado: 3} o como filas [{estado, total}].
function porEstado(valor) {
  if (Array.isArray(valor)) {
    return Object.fromEntries(valor.map((f) => [f.estado ?? f.status, Number(f.total ?? f.count ?? 0)]))
  }
  return valor && typeof valor === 'object' ? valor : {}
}

// Aperturas/clics REALES agregados por el backend (SPEC §11.1: el resumen excluye lo automático).
// Se aceptan varios nombres de campo para no acoplarse a la forma exacta de la respuesta.
function metricaReal(datos, claves) {
  // el backend (location.js → /api/loc/resumen) las devuelve bajo `seguimiento`
  for (const origen of [datos, datos?.seguimiento, datos?.metricas, datos?.tracking]) {
    if (!origen || typeof origen !== 'object') continue
    for (const clave of claves) {
      const v = Number(origen[clave])
      if (Number.isFinite(v)) return v
    }
  }
  return null
}

const Tile = ({ titulo, valor, tono = 'text-ink', pie }) => (
  <div className={TARJETA}>
    <div className="text-xs text-mut uppercase tracking-wide">{titulo}</div>
    <div className={`text-3xl font-bold mt-2 tabular-nums ${tono}`}>{valor}</div>
    {pie && <div className="text-[11px] text-mut mt-1">{pie}</div>}
  </div>
)

export default function Resumen() {
  const [datos, setDatos] = useState(null)
  const [config, setConfig] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let vivo = true
    api
      .get('/api/loc/resumen')
      .then((d) => vivo && setDatos(d || {}))
      .catch((e) => vivo && setError(e.message))

    Promise.allSettled([
      api.get('/api/loc/proveedores'),
      api.get('/api/loc/remitentes'),
      api.get('/api/loc/plantillas'),
      api.get('/api/loc/relay'),
    ]).then(([pr, re, pl, rl]) => {
      if (!vivo) return
      setConfig({
        proveedores: pr.status === 'fulfilled' ? lista(pr.value, 'proveedores').length : 0,
        remitentes: re.status === 'fulfilled' ? lista(re.value, 'remitentes').length : 0,
        plantillas: pl.status === 'fulfilled' ? lista(pl.value, 'plantillas').length : 0,
        relay: rl.status === 'fulfilled' ? Boolean(rl.value?.enabled) : false,
      })
    })

    return () => {
      vivo = false
    }
  }, [])

  if (error) return <Aviso variant="error">No se ha podido cargar el resumen: {error}</Aviso>
  if (!datos) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  const estados = porEstado(datos.por_estado ?? datos.estados)
  const suma = (...claves) => claves.reduce((t, k) => t + (Number(estados[k]) || 0), 0)
  const total = Number(datos.total) || ESTADOS.reduce((t, [k]) => t + (Number(estados[k]) || 0), 0)
  // solo eventos reales: el backend ya filtra los automáticos (Apple MPP, proxys, escáneres)
  const aperturasReales = metricaReal(datos, ['aperturas_reales', 'aperturas', 'abiertos'])
  const clicsReales = metricaReal(datos, ['clics_reales', 'clics', 'con_clic'])
  const dias = Array.isArray(datos.por_dia) ? datos.por_dia : []
  const maxDia = dias.reduce((m, d) => Math.max(m, Number(d.total) || 0), 0)
  const sinDatos = total === 0

  const pasos = config && [
    { hecho: config.proveedores > 0, texto: 'Registra un proveedor de envío (SMTP o Brevo)', a: '/proveedores', enlace: 'Proveedores' },
    { hecho: config.remitentes > 0, texto: 'Da de alta al menos un remitente', a: '/remitentes', enlace: 'Remitentes' },
    { hecho: config.plantillas > 0, texto: 'Crea una plantilla para el nodo del workflow', a: '/plantillas', enlace: 'Plantillas' },
    { hecho: config.relay, texto: 'Activa el relay si quieres usar el nodo de email nativo de GHL', a: '/relay', enlace: 'Relay' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold">Resumen</h1>
        <p className="text-sm text-ink2 mt-1">Actividad de envío de los últimos 7 días.</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Tile titulo="Enviados" valor={numero(total)} pie="Últimos 7 días" />
        <Tile titulo="Entregados" valor={numero(suma('entregado'))} tono="text-ok" pie="Confirmados o inferidos" />
        <Tile titulo="Con problemas" valor={numero(suma('rebotado', 'spam', 'fallido', 'suprimido'))} tono="text-bad" pie="Rebotes, spam, fallos y supresiones" />
        <Tile titulo="Pendientes" valor={numero(suma('encolado', 'reintento', 'enviando'))} tono="text-warn" pie="En cola o reintentando" />
      </div>

      {/* Aperturas y clics REALES: los eventos automáticos (Apple MPP, proxys de Gmail, escáneres
          de seguridad) no cuentan aquí; quedan visibles en el detalle de cada envío */}
      {(aperturasReales !== null || clicsReales !== null) && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {aperturasReales !== null && (
            <Tile titulo="Aperturas reales" valor={numero(aperturasReales)} pie="Sin proxys ni escáneres" />
          )}
          {clicsReales !== null && (
            <Tile titulo="Clics reales" valor={numero(clicsReales)} pie="Sin proxys ni escáneres" />
          )}
        </div>
      )}

      {dias.length > 0 && maxDia > 0 && (
        <div className={TARJETA}>
          <div className="text-sm font-semibold mb-4">Envíos por día</div>
          {/* sin items-end en la fila: las columnas deben estirarse a los 128 px para que la
              altura en % de cada barra tenga contra qué resolverse (si no, mide 0) */}
          <div className="flex gap-2 h-32">
            {dias.map((d) => {
              const v = Number(d.total) || 0
              return (
                <div key={d.fecha ?? d.dia} className="flex-1 h-full flex flex-col items-center gap-2">
                  <div className="w-full flex-1 flex items-end">
                    <div
                      className="w-full bg-gold/70 rounded-t"
                      style={{ height: `${Math.max(3, (v / maxDia) * 100)}%` }}
                      title={`${numero(v)} envíos`}
                    />
                  </div>
                  <span className="text-[10px] text-mut whitespace-nowrap">
                    {new Date(d.fecha ?? d.dia).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className={TARJETA}>
        <div className="flex items-center justify-between mb-4">
          <div className="text-sm font-semibold">Desglose por estado</div>
          <Link to="/envios" className="text-xs text-gold hover:underline">
            Ver todos los envíos →
          </Link>
        </div>
        {sinDatos ? (
          <p className="text-sm text-mut py-6 text-center">
            Todavía no se ha enviado ningún correo desde esta subcuenta.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {ESTADOS.map(([clave, etiqueta]) => (
              <div key={clave} className="bg-card2 border border-border rounded-xl px-3 py-2.5">
                <div className="text-[11px] text-mut">{etiqueta}</div>
                <div className={`text-lg font-semibold tabular-nums ${COLOR[clave] || 'text-ink'}`}>
                  {numero(estados[clave])}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={TARJETA}>
        <div className="text-sm font-semibold mb-3">Primeros pasos</div>
        {!pasos ? (
          <div className="py-4 grid place-items-center">
            <Spinner />
          </div>
        ) : (
          <ul className="space-y-2.5">
            {pasos.map((p) => (
              <li key={p.a} className="flex items-center gap-3 text-sm">
                <span
                  className={`grid place-items-center w-5 h-5 rounded-full border text-[11px] shrink-0 ${
                    p.hecho ? 'border-ok/40 bg-ok/10 text-ok' : 'border-border bg-card2 text-mut'
                  }`}
                >
                  {p.hecho ? '✓' : '·'}
                </span>
                <span className={p.hecho ? 'text-mut line-through' : 'text-ink2'}>{p.texto}</span>
                {!p.hecho && (
                  <Link to={p.a} className="text-xs text-gold hover:underline ml-auto whitespace-nowrap">
                    {p.enlace} →
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
