import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.js'
import { Aviso, Boton, Campo, Spinner } from '../components/ui.jsx'

export default function Login({ onLogin }) {
  const navegar = useNavigate()
  const [comprobando, setComprobando] = useState(true)
  const [usuario, setUsuario] = useState('')
  const [contrasena, setContrasena] = useState('')
  const [error, setError] = useState('')
  const [entrando, setEntrando] = useState(false)

  // si ya hay sesión de admin no tiene sentido pedir las credenciales otra vez
  useEffect(() => {
    let vivo = true
    api
      .get('/api/admin/yo')
      .then((d) => {
        if (!vivo) return
        onLogin?.(d)
        navegar('/admin/subcuentas', { replace: true })
      })
      .catch(() => vivo && setComprobando(false))
    return () => {
      vivo = false
    }
  }, [navegar, onLogin])

  const entrar = async (e) => {
    e.preventDefault()
    if (!usuario.trim() || !contrasena) {
      setError('Escribe el usuario y la contraseña.')
      return
    }
    setError('')
    setEntrando(true)
    try {
      const d = await api.post('/api/admin/login', { usuario: usuario.trim(), contrasena })
      onLogin?.(d)
      navegar('/admin/subcuentas', { replace: true })
    } catch (err) {
      setError(err.status === 401 ? 'Usuario o contraseña incorrectos.' : err.message)
      setContrasena('')
    } finally {
      setEntrando(false)
    }
  }

  if (comprobando) {
    return (
      <div className="min-h-[60vh] grid place-items-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="min-h-[70vh] grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold">Panel de la agencia</h1>
          <p className="text-sm text-ink2 mt-1">Gestión de proveedores, remitentes y envíos de todas las subcuentas.</p>
        </div>

        <form onSubmit={entrar} className="bg-card border border-border rounded-2xl p-6 space-y-4">
          {error && <Aviso variant="error">{error}</Aviso>}

          <Campo
            label="Usuario"
            value={usuario}
            onChange={(e) => setUsuario(e.target.value)}
            autoComplete="username"
            autoFocus
          />
          <Campo
            label="Contraseña"
            type="password"
            value={contrasena}
            onChange={(e) => setContrasena(e.target.value)}
            autoComplete="current-password"
          />

          <Boton type="submit" className="w-full" disabled={entrando}>
            {entrando ? 'Entrando…' : 'Entrar'}
          </Boton>
        </form>

        <p className="text-[11px] text-mut text-center mt-4">
          Acceso reservado a la agencia. Las subcuentas entran desde el menú de su propia cuenta de GHL.
        </p>
      </div>
    </div>
  )
}
