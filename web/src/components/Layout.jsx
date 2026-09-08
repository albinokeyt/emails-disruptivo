import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  AlertTriangle, AtSign, Building2, CalendarClock, FileText, Globe, Inbox, LayoutDashboard, LogOut, Mail, MailX,
  Menu, Send, Server, Settings, Share2, ShieldCheck, Users, X,
} from 'lucide-react'
import { contarNoLeidosBuzon } from '../api.js'

// Fechas del acceso (vence_el) tal y como las lee el cliente: «7 de marzo de 2027»
const fechaLarga = (v) => {
  const d = v ? new Date(v) : null
  return d && Number.isFinite(d.getTime())
    ? d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' })
    : null
}

// Aviso de gracia del marketplace (GET /api/sesion → acceso.aviso_gracia): la renovación falló y
// el acceso se mantiene hasta vence_el (fin de la gracia). Texto fijado por el contrato.
const textoGracia = (acceso) => {
  const fecha = fechaLarga(acceso?.vence_el)
  return fecha
    ? `Tu suscripción está en periodo de gracia hasta el ${fecha}: recarga tu saldo en el marketplace para no perder el acceso`
    : 'Tu suscripción está en periodo de gracia: recarga tu saldo en el marketplace para no perder el acceso'
}

// «Plan: Emails Disruptivo · Pro · prueba hasta 7 de marzo de 2027», discreto, en el pie del menú
const textoPlan = (acceso) => {
  if (!acceso?.plan) return null
  const fecha = fechaLarga(acceso.vence_el)
  const sufijo = acceso.gracia
    ? fecha ? `en gracia hasta ${fecha}` : 'en gracia'
    : acceso.estado === 'trial'
      ? fecha ? `prueba hasta ${fecha}` : 'prueba'
      : fecha ? `hasta ${fecha}` : ''
  return `Plan: ${acceso.plan}${sufijo ? ` · ${sufijo}` : ''}`
}

// La navegación es distinta según quién mira: la subcuenta gestiona lo suyo,
// la agencia gestiona el parque entero.
const NAV_SUBCUENTA = [
  { to: '/', icono: LayoutDashboard, etiqueta: 'Resumen', exacto: true },
  { to: '/proveedores', icono: Server, etiqueta: 'Proveedores' },
  { to: '/remitentes', icono: AtSign, etiqueta: 'Remitentes' },
  { to: '/plantillas', icono: FileText, etiqueta: 'Plantillas' },
  { to: '/envios', icono: Send, etiqueta: 'Envíos' },
  { to: '/buzon', icono: Inbox, etiqueta: 'Buzón', contador: 'buzon' },
  { to: '/rebotados', icono: MailX, etiqueta: 'Rebotados' },
  { to: '/relay', icono: Mail, etiqueta: 'Relay SMTP' },
  { to: '/dominios', icono: Globe, etiqueta: 'Dominios' },
]

// Contador de no leídos del Buzón (SPEC §14.4). Se pide al entrar y cada minuto; la pantalla
// Buzón emite `buzon:cambio` (con `no_leidos` en el detalle si ya lo sabe) al leer, borrar o
// sincronizar para que el número se actualice al momento. Si el endpoint no responde (buzón sin
// configurar, backend sin la sección 14) simplemente no se pinta nada.
function useNoLeidosBuzon(activo) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (!activo) return undefined
    let vivo = true
    const consultar = async () => {
      try {
        const total = await contarNoLeidosBuzon()
        if (vivo) setN(total)
      } catch {
        if (vivo) setN(0)
      }
    }
    const alCambiar = (e) => {
      const dado = Number(e.detail?.no_leidos)
      if (Number.isFinite(dado) && dado >= 0) setN(dado)
      else consultar()
    }
    consultar()
    const temporizador = setInterval(consultar, 60_000)
    window.addEventListener('buzon:cambio', alCambiar)
    return () => {
      vivo = false
      clearInterval(temporizador)
      window.removeEventListener('buzon:cambio', alCambiar)
    }
  }, [activo])
  return n
}

const NAV_ADMIN = [
  { to: '/admin', icono: Building2, etiqueta: 'Subcuentas', exacto: true },
  { to: '/admin/proveedores', icono: Server, etiqueta: 'Proveedores' },
  { to: '/admin/asignaciones', icono: Share2, etiqueta: 'Asignaciones' },
  { to: '/admin/remitentes', icono: AtSign, etiqueta: 'Remitentes' },
  { to: '/admin/plantillas', icono: FileText, etiqueta: 'Plantillas' },
  { to: '/admin/envios', icono: Send, etiqueta: 'Envíos' },
  { to: '/admin/ajustes', icono: Settings, etiqueta: 'Ajustes' },
]

function Marca({ ambito }) {
  const esAdmin = ambito === 'admin'
  return (
    <div className="px-5 py-6 flex items-center gap-2.5">
      <span className="w-9 h-9 rounded-xl bg-gold/15 border border-gold/30 grid place-items-center glow-gold shrink-0">
        {esAdmin ? <ShieldCheck size={18} className="text-gold" /> : <Mail size={18} className="text-gold" />}
      </span>
      <div className="min-w-0">
        <div className="font-bold text-sm leading-tight text-gradient-gold truncate">
          {esAdmin ? 'Emails · Agencia' : 'Emails Disruptivo'}
        </div>
        <div className="text-[11px] text-mut leading-tight truncate">
          {esAdmin ? 'Panel de la agencia' : 'Envío desde tus automatizaciones'}
        </div>
      </div>
    </div>
  )
}

function Enlaces({ items, contadores = {}, onNavegar }) {
  return (
    <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
      {items.map(({ to, icono: Icono, etiqueta, exacto, contador }) => {
        const n = contador ? Number(contadores[contador]) || 0 : 0
        return (
          <NavLink
            key={to}
            to={to}
            end={exacto}
            onClick={onNavegar}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-colors ${
                isActive ? 'bg-gold/10 text-gold' : 'text-ink2 hover:bg-card2 hover:text-ink'
              }`
            }
          >
            <Icono size={16} />
            {etiqueta}
            {n > 0 && (
              <span
                className="ml-auto min-w-5 px-1.5 py-0.5 rounded-full bg-gold text-bg text-[10px] font-semibold text-center tabular-nums"
                title={`${n} sin leer`}
              >
                {n > 99 ? '99+' : n}
              </span>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}

function PieSubcuenta({ sesion }) {
  const plan = textoPlan(sesion?.acceso)
  return (
    <div className="m-3 rounded-xl border border-border bg-card2/60 px-3 py-2.5">
      <div className="text-[11px] text-mut">Subcuenta</div>
      <div className="text-sm text-ink truncate" title={sesion?.nombre || ''}>
        {sesion?.nombre || 'Sin nombre'}
      </div>
      <code className="block text-[10px] text-mut truncate">{sesion?.locationId}</code>
      {plan && (
        <div className={`mt-1 text-[10px] truncate ${sesion.acceso.gracia ? 'text-warn' : 'text-mut'}`} title={plan}>
          {plan}
        </div>
      )}
      {sesion?.esAdminAgencia && (
        <a
          href="/admin"
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-gold/90 hover:text-gold"
        >
          <ShieldCheck size={13} /> Panel de la agencia
        </a>
      )}
    </div>
  )
}

function PieAdmin({ sesion, onSalir }) {
  return (
    <div className="m-3 space-y-2">
      <div className="rounded-xl border border-border bg-card2/60 px-3 py-2.5">
        <div className="text-[11px] text-mut">Sesión</div>
        <div className="text-sm text-ink truncate flex items-center gap-1.5">
          <Users size={13} className="text-gold shrink-0" />
          {sesion?.usuario || sesion?.nombre || 'Administrador'}
        </div>
      </div>
      <button
        type="button"
        onClick={onSalir}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm text-ink2 hover:bg-card2 hover:text-ink"
      >
        <LogOut size={16} />
        Salir
      </button>
    </div>
  )
}

export default function Layout({ ambito = 'location', sesion = null, onSalir, children }) {
  const esAdmin = ambito === 'admin'
  const items = esAdmin ? NAV_ADMIN : NAV_SUBCUENTA
  const ubicacion = useLocation()
  const [abierto, setAbierto] = useState(false)
  const noLeidos = useNoLeidosBuzon(!esAdmin)

  // el menú lateral se cierra solo al cambiar de pantalla en móvil
  useEffect(() => { setAbierto(false) }, [ubicacion.pathname])

  return (
    <div className="min-h-screen relative">
      <div className="app-bg" aria-hidden="true" />

      <div className="min-h-screen flex relative z-10">
        {abierto && (
          <div
            className="fixed inset-0 bg-black/60 z-30 lg:hidden"
            onClick={() => setAbierto(false)}
            role="presentation"
          />
        )}

        <aside
          className={`fixed lg:static inset-y-0 left-0 z-40 w-60 shrink-0 border-r border-border bg-card/95 lg:bg-card/40 backdrop-blur-sm flex flex-col transition-transform duration-200 ${
            abierto ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
          }`}
        >
          <div className="flex items-start justify-between">
            <Marca ambito={ambito} />
            <button
              type="button"
              onClick={() => setAbierto(false)}
              className="lg:hidden m-5 text-mut hover:text-ink"
              aria-label="Cerrar menú"
            >
              <X size={18} />
            </button>
          </div>

          <Enlaces items={items} contadores={{ buzon: noLeidos }} onNavegar={() => setAbierto(false)} />

          {esAdmin ? <PieAdmin sesion={sesion} onSalir={onSalir} /> : <PieSubcuenta sesion={sesion} />}
        </aside>

        <div className="flex-1 min-w-0 flex flex-col">
          <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-card/60 backdrop-blur-sm">
            <button type="button" onClick={() => setAbierto(true)} className="text-ink2 hover:text-ink" aria-label="Abrir menú">
              <Menu size={20} />
            </button>
            <span className="text-sm font-semibold text-gradient-gold">
              {esAdmin ? 'Emails · Agencia' : 'Emails Disruptivo'}
            </span>
          </header>

          <main className="flex-1 min-w-0 p-5 lg:p-8 overflow-x-hidden">
            {/* Gracia del marketplace (acceso.aviso_gracia): renovación fallida, el acceso sigue hasta vence_el.
                Ámbar y más visible que el de vencimiento porque aquí hay algo que hacer (recargar saldo). */}
            {!esAdmin && sesion?.acceso?.aviso_gracia && (
              <div
                className="mb-4 flex items-center gap-2 rounded-xl border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-sm text-ink"
                role="alert"
              >
                <AlertTriangle size={16} className="text-warn shrink-0" />
                <span>{textoGracia(sesion.acceso)}</span>
              </div>
            )}
            {/* Aviso discreto de vencimiento de la suscripción (GET /api/sesion → acceso.aviso): no bloquea nada */}
            {!esAdmin && sesion?.acceso?.aviso && (
              <div className="mb-4 flex items-center gap-2 rounded-xl border border-warn/25 bg-warn/5 px-3.5 py-2 text-xs text-ink2">
                <CalendarClock size={14} className="text-warn shrink-0" />
                <span>{sesion.acceso.aviso}</span>
              </div>
            )}
            <div key={ubicacion.pathname} className="animate-in">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}
