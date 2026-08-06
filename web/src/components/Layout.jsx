import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  AtSign, Building2, FileText, Globe, LayoutDashboard, LogOut, Mail, MailX, Menu,
  Send, Server, Settings, Share2, ShieldCheck, Users, X,
} from 'lucide-react'

// La navegación es distinta según quién mira: la subcuenta gestiona lo suyo,
// la agencia gestiona el parque entero.
const NAV_SUBCUENTA = [
  { to: '/', icono: LayoutDashboard, etiqueta: 'Resumen', exacto: true },
  { to: '/proveedores', icono: Server, etiqueta: 'Proveedores' },
  { to: '/remitentes', icono: AtSign, etiqueta: 'Remitentes' },
  { to: '/plantillas', icono: FileText, etiqueta: 'Plantillas' },
  { to: '/envios', icono: Send, etiqueta: 'Envíos' },
  { to: '/rebotados', icono: MailX, etiqueta: 'Rebotados' },
  { to: '/relay', icono: Mail, etiqueta: 'Relay SMTP' },
  { to: '/dominios', icono: Globe, etiqueta: 'Dominios' },
]

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

function Enlaces({ items, onNavegar }) {
  return (
    <nav className="flex-1 px-3 space-y-1 overflow-y-auto">
      {items.map(({ to, icono: Icono, etiqueta, exacto }) => (
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
        </NavLink>
      ))}
    </nav>
  )
}

function PieSubcuenta({ sesion }) {
  return (
    <div className="m-3 rounded-xl border border-border bg-card2/60 px-3 py-2.5">
      <div className="text-[11px] text-mut">Subcuenta</div>
      <div className="text-sm text-ink truncate" title={sesion?.nombre || ''}>
        {sesion?.nombre || 'Sin nombre'}
      </div>
      <code className="block text-[10px] text-mut truncate">{sesion?.locationId}</code>
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

          <Enlaces items={items} onNavegar={() => setAbierto(false)} />

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
            <div key={ubicacion.pathname} className="animate-in">{children}</div>
          </main>
        </div>
      </div>
    </div>
  )
}
