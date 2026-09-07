import { useCallback, useEffect, useRef, useState } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { Lock, Mail, RefreshCw, ShieldAlert } from 'lucide-react'
import { adminSalir, adminYo, obtenerSesion } from './api.js'
import { estamosEmbebidos, iniciarSesionConSso } from './sso.js'
import { SesionContexto } from './hooks.js'
import Layout from './components/Layout.jsx'
import { Aviso, Boton } from './components/ui.jsx'

// Pantallas de la subcuenta (SPEC §9)
import Resumen from './pages/Resumen.jsx'
import Proveedores from './pages/Proveedores.jsx'
import Remitentes from './pages/Remitentes.jsx'
import Plantillas from './pages/Plantillas.jsx'
import Envios from './pages/Envios.jsx'
import Rebotados from './pages/Rebotados.jsx'
import Relay from './pages/Relay.jsx'
import Dominios from './pages/Dominios.jsx'
import Buzon from './pages/Buzon.jsx'

// Pantallas de la agencia (SPEC §9)
import Login from './pages/Login.jsx'
import Subcuentas from './pages/Subcuentas.jsx'
import ProveedoresAdmin from './pages/ProveedoresAdmin.jsx'
import Asignaciones from './pages/Asignaciones.jsx'
import RemitentesAdmin from './pages/RemitentesAdmin.jsx'
import PlantillasAdmin from './pages/PlantillasAdmin.jsx'
import EnviosAdmin from './pages/EnviosAdmin.jsx'
import Ajustes from './pages/Ajustes.jsx'

export default function App() {
  const ubicacion = useLocation()
  // Dos paneles en la misma app: '/' es la Custom Page dentro del iframe de GHL,
  // '/admin/*' es el panel de la agencia con su propio login.
  return ubicacion.pathname.startsWith('/admin') ? <PanelAdmin /> : <PanelSubcuenta />
}

/* ============================================================
   Panel de subcuenta — identidad por SSO de GHL
   ============================================================ */
function PanelSubcuenta() {
  const [sesion, setSesion] = useState(null)
  const [cargando, setCargando] = useState(true)
  const [fallo, setFallo] = useState(null)
  const arrancando = useRef(false)

  const arrancar = useCallback(async () => {
    if (arrancando.current) return
    arrancando.current = true
    setCargando(true)
    setFallo(null)
    try {
      let actual = null
      try { actual = await obtenerSesion() } catch { actual = null }

      if (!actual) {
        const intento = await iniciarSesionConSso()
        if (intento.ok) {
          actual = intento.sesion
          // el backend puede devolver solo la cookie: se relee para tener el contexto completo
          if (!actual?.locationId) {
            try { actual = await obtenerSesion() } catch { /* se trata abajo */ }
          }
        } else {
          setFallo(intento)
        }
      }

      if (actual?.locationId) {
        setSesion({ ambito: 'location', ...actual })
        setFallo(null)
      } else {
        setSesion(null)
      }
    } finally {
      setCargando(false)
      arrancando.current = false
    }
  }, [])

  useEffect(() => { arrancar() }, [arrancar])

  useEffect(() => {
    const alCaducar = (e) => {
      if (e.detail?.ambito && e.detail.ambito !== 'location') return
      setSesion(null)
      arrancar()
    }
    window.addEventListener('sesion:caducada', alCaducar)
    return () => window.removeEventListener('sesion:caducada', alCaducar)
  }, [arrancar])

  if (cargando) return <PantallaCarga texto="Identificando tu subcuenta…" />

  if (!sesion) {
    return (
      <PantallaError
        titulo="No hemos podido abrir tu panel"
        mensaje={fallo?.mensaje || 'No hay una sesión válida para esta subcuenta.'}
        motivo={fallo?.motivo}
        onReintentar={arrancar}
      />
    )
  }

  // Suscripción en el Marketplace Disruptivo: el backend lo decide (GET /api/sesion → acceso).
  // Sin acceso no se pinta el panel, solo el mensaje literal del encargo.
  if (sesion.acceso && sesion.acceso.activo === false) {
    return <PantallaSinAcceso mensaje={sesion.acceso.mensaje} onReintentar={arrancar} />
  }

  return (
    <SesionContexto.Provider value={sesion}>
      <Layout ambito="location" sesion={sesion}>
        <Routes>
          <Route path="/" element={<Resumen />} />
          <Route path="/proveedores" element={<Proveedores />} />
          <Route path="/remitentes" element={<Remitentes />} />
          <Route path="/plantillas" element={<Plantillas />} />
          <Route path="/envios" element={<Envios />} />
          <Route path="/envios/:id" element={<Envios />} />
          <Route path="/rebotados" element={<Rebotados />} />
          <Route path="/buzon" element={<Buzon />} />
          <Route path="/buzon/:id" element={<Buzon />} />
          <Route path="/relay" element={<Relay />} />
          <Route path="/dominios" element={<Dominios />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Layout>
    </SesionContexto.Provider>
  )
}

/* ============================================================
   Panel de la agencia — usuario y contraseña propios
   ============================================================ */
function PanelAdmin() {
  const [sesion, setSesion] = useState(null)   // null = cargando · false = sin sesión
  const comprobando = useRef(false)

  const comprobar = useCallback(async () => {
    if (comprobando.current) return
    comprobando.current = true
    try {
      let yo = null
      try { yo = await adminYo() } catch { yo = null }
      // si el panel de agencia se abre embebido en GHL, el SSO puede valer como login
      if (!yo && estamosEmbebidos()) {
        const intento = await iniciarSesionConSso()
        if (intento.ok) { try { yo = await adminYo() } catch { yo = null } }
      }
      setSesion(yo ? { ambito: 'admin', ...yo } : false)
    } finally {
      comprobando.current = false
    }
  }, [])

  useEffect(() => { comprobar() }, [comprobar])

  useEffect(() => {
    const alIniciar = (e) => {
      if (e.detail?.ambito && e.detail.ambito !== 'admin') return
      setSesion(null)
      comprobar()
    }
    const alCerrar = (e) => {
      if (e.detail?.ambito && e.detail.ambito !== 'admin') return
      setSesion(false)
    }
    const alCaducar = (e) => {
      if (e.detail?.ambito !== 'admin') return
      setSesion(false)
    }
    window.addEventListener('sesion:iniciada', alIniciar)
    window.addEventListener('sesion:cerrada', alCerrar)
    window.addEventListener('sesion:caducada', alCaducar)
    return () => {
      window.removeEventListener('sesion:iniciada', alIniciar)
      window.removeEventListener('sesion:cerrada', alCerrar)
      window.removeEventListener('sesion:caducada', alCaducar)
    }
  }, [comprobar])

  const salir = useCallback(async () => {
    await adminSalir()
    setSesion(false)
  }, [])

  if (sesion === null) return <PantallaCarga texto="Comprobando la sesión…" />
  if (!sesion) return <Login onEntrar={comprobar} onLogin={comprobar} />

  return (
    <SesionContexto.Provider value={sesion}>
      <Layout ambito="admin" sesion={sesion} onSalir={salir}>
        <Routes>
          <Route path="/admin" element={<Subcuentas />} />
          <Route path="/admin/subcuentas" element={<Subcuentas />} />
          <Route path="/admin/proveedores" element={<ProveedoresAdmin />} />
          <Route path="/admin/asignaciones" element={<Asignaciones />} />
          <Route path="/admin/remitentes" element={<RemitentesAdmin />} />
          <Route path="/admin/plantillas" element={<PlantillasAdmin />} />
          <Route path="/admin/envios" element={<EnviosAdmin />} />
          <Route path="/admin/ajustes" element={<Ajustes />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </Layout>
    </SesionContexto.Provider>
  )
}

/* ============================================================
   Pantallas de estado
   ============================================================ */
function PantallaCarga({ texto }) {
  return (
    <div className="min-h-screen grid place-items-center relative">
      <div className="app-bg" aria-hidden="true" />
      <div className="relative z-10 flex flex-col items-center gap-4">
        <span className="w-12 h-12 rounded-2xl bg-gold/15 border border-gold/30 grid place-items-center glow-gold">
          <Mail size={22} className="text-gold" />
        </span>
        <div className="flex items-center gap-2.5 text-sm text-mut">
          <span className="w-4 h-4 rounded-full border-2 border-border border-t-gold spin" />
          {texto}
        </div>
      </div>
    </div>
  )
}

function PantallaSinAcceso({ mensaje, onReintentar }) {
  return (
    <div className="min-h-screen grid place-items-center relative p-6">
      <div className="app-bg" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md bg-card border border-border rounded-2xl p-6 space-y-4 animate-in">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-gold/15 border border-gold/30 grid place-items-center shrink-0">
            <Lock size={18} className="text-gold" />
          </span>
          <h1 className="text-base font-semibold">Suscripción no activa</h1>
        </div>
        <Aviso tipo="aviso">
          {mensaje || 'Tu suscripción a Emails Disruptivo no está activa. Habla con el Departamento Disruptivo para reactivarla.'}
        </Aviso>
        <div className="flex gap-2 pt-1">
          <Boton icono={RefreshCw} onClick={onReintentar}>Volver a comprobar</Boton>
        </div>
      </div>
    </div>
  )
}

function PantallaError({ titulo, mensaje, motivo, onReintentar }) {
  return (
    <div className="min-h-screen grid place-items-center relative p-6">
      <div className="app-bg" aria-hidden="true" />
      <div className="relative z-10 w-full max-w-md bg-card border border-border rounded-2xl p-6 space-y-4 animate-in">
        <div className="flex items-center gap-3">
          <span className="w-10 h-10 rounded-xl bg-bad/10 border border-bad/30 grid place-items-center shrink-0">
            <ShieldAlert size={18} className="text-bad" />
          </span>
          <h1 className="text-base font-semibold">{titulo}</h1>
        </div>

        <Aviso tipo="aviso">{mensaje}</Aviso>

        {motivo === 'sin_iframe' && (
          <p className="text-sm text-ink2 leading-relaxed">
            Entra en tu subcuenta de GoHighLevel y abre la app desde el menú lateral. Este panel necesita el
            contexto que GoHighLevel envía a la página, y fuera de ese menú no existe.
          </p>
        )}
        {motivo === 'sin_respuesta' && (
          <p className="text-sm text-ink2 leading-relaxed">
            GoHighLevel no ha respondido con los datos del usuario. Suele arreglarse recargando la página desde el
            menú de la subcuenta. Si se repite, cierra sesión en GoHighLevel y vuelve a entrar.
          </p>
        )}
        {motivo === 'rechazado' && (
          <p className="text-sm text-ink2 leading-relaxed">
            La app está instalada pero el servidor no ha podido validar la sesión. Revisa en el panel de la agencia
            que el <em>Shared Secret</em> de la app sea el correcto.
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <Boton icono={RefreshCw} onClick={onReintentar}>Reintentar</Boton>
          <Boton variante="secundario" onClick={() => window.open('/admin', '_blank', 'noreferrer')}>
            Panel de la agencia
          </Boton>
        </div>
      </div>
    </div>
  )
}
