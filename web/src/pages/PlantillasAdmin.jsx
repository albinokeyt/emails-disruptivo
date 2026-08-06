import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import { Aviso, Boton, Campo, Confirmar, Copiar, Select, Spinner, Tabla, Textarea } from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const fecha = (d) =>
  d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

const VARIABLES = [
  { clave: '{{destinatario.email}}', que: 'Correo del destinatario (campo «Para» del nodo).' },
  { clave: '{{destinatario.nombre}}', que: 'Nombre del destinatario (campo «Nombre» del nodo).' },
  { clave: '{{remitente.nombre}}', que: 'Nombre visible del remitente elegido.' },
  { clave: '{{remitente.email}}', que: 'Correo del remitente elegido.' },
  { clave: '{{asunto}}', que: 'El asunto de esta misma plantilla.' },
  { clave: '{{preheader}}', que: 'El texto de vista previa de esta plantilla.' },
  { clave: '{{baja_url}}', que: 'Enlace de baja. Obligatorio en envíos comerciales.' },
]

const VACIO = { location_id: '', name: '', subject: '', preheader: '', html: '', text: '' }

const HTML_EJEMPLO = `<div style="font-family:Arial,sans-serif;font-size:16px;color:#222">
  <p>Hola {{destinatario.nombre}},</p>
  <p>Gracias por escribirnos.</p>
  <p>Un saludo,<br>{{remitente.nombre}}</p>
  <p style="font-size:12px;color:#888"><a href="{{baja_url}}">Darse de baja</a></p>
</div>`

function detectarVariables(...textos) {
  const encontradas = new Set()
  for (const t of textos) {
    for (const m of String(t || '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) encontradas.add(m[1])
  }
  return [...encontradas]
}

function validar(f) {
  const errores = []
  if (!f.name.trim()) errores.push('El nombre de la plantilla es obligatorio.')
  if (!f.subject.trim()) errores.push('El asunto es obligatorio.')
  if (/[\r\n]/.test(f.subject)) errores.push('El asunto no puede contener saltos de línea.')
  if (f.subject.length > 200) errores.push('El asunto no puede pasar de 200 caracteres.')
  if (f.preheader.length > 200) errores.push('El preheader no puede pasar de 200 caracteres.')
  if (!f.html.trim()) errores.push('El contenido HTML es obligatorio.')
  return errores
}

export default function PlantillasAdmin() {
  const [datos, setDatos] = useState(null)
  const [subcuentas, setSubcuentas] = useState([])
  const [error, setError] = useState('')
  const [editando, setEditando] = useState(null)
  const [form, setForm] = useState(VACIO)
  const [errores, setErrores] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [vista, setVista] = useState('codigo')
  const [aBorrar, setABorrar] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/admin/plantillas')
      setDatos(lista(d, 'plantillas'))
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
    }
  }, [])

  useEffect(() => {
    cargar()
    api
      .get('/api/admin/subcuentas')
      .then((d) => setSubcuentas(lista(d, 'subcuentas')))
      .catch(() => setSubcuentas([]))
  }, [cargar])

  const variables = useMemo(
    () => detectarVariables(form.subject, form.preheader, form.html, form.text),
    [form.subject, form.preheader, form.html, form.text],
  )

  const abrirNueva = () => {
    setForm({ ...VACIO, html: HTML_EJEMPLO })
    setErrores([])
    setVista('codigo')
    setEditando({ id: null })
  }

  const abrirEditar = (t) => {
    setForm({
      location_id: t.location_id || '',
      name: t.name || '',
      subject: t.subject || '',
      preheader: t.preheader || '',
      html: t.html || '',
      text: t.text || '',
    })
    setErrores([])
    setVista('codigo')
    setEditando({ id: t.id })
  }

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const guardar = async (e) => {
    e.preventDefault()
    const fallos = validar(form)
    setErrores(fallos)
    if (fallos.length) return

    const cuerpo = {
      location_id: form.location_id || null,
      name: form.name.trim(),
      subject: form.subject.trim(),
      preheader: form.preheader.trim() || null,
      html: form.html,
      text: form.text.trim() || null,
      variables,
    }

    setGuardando(true)
    try {
      if (editando.id) await api.patch(`/api/admin/plantillas/${editando.id}`, cuerpo)
      else await api.post('/api/admin/plantillas', cuerpo)
      setEditando(null)
      await cargar()
    } catch (err) {
      setErrores([err.message])
    } finally {
      setGuardando(false)
    }
  }

  const borrar = async () => {
    const t = aBorrar
    setABorrar(null)
    try {
      await api.del(`/api/admin/plantillas/${t.id}`)
      await cargar()
    } catch (err) {
      setError(err.message)
    }
  }

  const nombreSubcuenta = (id) =>
    subcuentas.find((s) => String(s.location_id) === String(id))?.name || id

  if (datos === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  if (editando) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{editando.id ? 'Editar plantilla' : 'Nueva plantilla'}</h1>
            <p className="text-sm text-ink2 mt-1">
              Una plantilla global la ven todas las subcuentas, en solo lectura.
            </p>
          </div>
          <Boton variant="ghost" onClick={() => setEditando(null)}>
            Volver
          </Boton>
        </div>

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

        <form onSubmit={guardar} className="grid lg:grid-cols-3 gap-6 items-start">
          <div className="lg:col-span-2 space-y-4">
            <div className={`${TARJETA} space-y-4`}>
              <Select label="Ámbito" value={form.location_id} onChange={set('location_id')}>
                <option value="">Global · todas las subcuentas</option>
                {subcuentas.map((s) => (
                  <option key={s.location_id} value={s.location_id}>
                    Solo {s.name || s.location_id}
                  </option>
                ))}
              </Select>
              <Campo label="Nombre" placeholder="Bienvenida" value={form.name} onChange={set('name')} maxLength={120} />
              <Campo
                label="Asunto"
                placeholder="Hola {{destinatario.nombre}}, ya estás dentro"
                value={form.subject}
                onChange={set('subject')}
                maxLength={200}
              />
              <Campo
                label="Preheader (opcional)"
                value={form.preheader}
                onChange={set('preheader')}
                maxLength={200}
                hint="Aparece junto al asunto en la bandeja de entrada."
              />
            </div>

            <div className={TARJETA}>
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold">Contenido</div>
                <div className="flex gap-1 bg-card2 border border-border rounded-xl p-1">
                  {[
                    ['codigo', 'HTML'],
                    ['previa', 'Vista previa'],
                  ].map(([v, etiqueta]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVista(v)}
                      className={`text-xs px-3 py-1.5 rounded-lg transition-colors ${
                        vista === v ? 'bg-gold text-bg font-semibold' : 'text-ink2 hover:text-ink'
                      }`}
                    >
                      {etiqueta}
                    </button>
                  ))}
                </div>
              </div>

              {vista === 'codigo' ? (
                <Textarea
                  label="HTML"
                  rows={18}
                  spellCheck={false}
                  className="font-mono"
                  value={form.html}
                  onChange={set('html')}
                />
              ) : (
                <div className="bg-white rounded-xl overflow-hidden border border-border">
                  {/* sandbox vacío: la vista previa nunca ejecuta scripts ni navega */}
                  <iframe
                    title="Vista previa de la plantilla"
                    sandbox=""
                    className="w-full h-[460px] bg-white"
                    srcDoc={form.html}
                  />
                </div>
              )}
            </div>

            <div className={TARJETA}>
              <Textarea
                label="Versión en texto plano (opcional)"
                rows={6}
                value={form.text}
                onChange={set('text')}
                hint="Mejora la entregabilidad. Si se deja vacía, se genera a partir del HTML."
              />
            </div>

            <div className="flex justify-end gap-2">
              <Boton type="button" variant="ghost" onClick={() => setEditando(null)}>
                Cancelar
              </Boton>
              <Boton type="submit" disabled={guardando}>
                {guardando ? 'Guardando…' : 'Guardar plantilla'}
              </Boton>
            </div>
          </div>

          <div className={TARJETA}>
            <div className="text-sm font-semibold mb-1">Variables disponibles</div>
            <p className="text-xs text-mut mb-4">
              Se sustituyen al componer cada correo. Las que no reconoce la app se quedan vacías.
            </p>
            <ul className="space-y-2">
              {VARIABLES.map((v) => (
                <li key={v.clave} className="flex items-start gap-2">
                  <code className="text-[11px] bg-card2 border border-border rounded px-1.5 py-0.5 text-gold whitespace-nowrap">
                    {v.clave}
                  </code>
                  <span className="text-[11px] text-ink2 flex-1">{v.que}</span>
                  <Copiar value={v.clave} />
                </li>
              ))}
            </ul>
            {variables.length > 0 && (
              <div className="border-t border-border mt-4 pt-4">
                <div className="text-xs text-ink2 mb-2">Usadas en esta plantilla</div>
                <div className="flex flex-wrap gap-1.5">
                  {variables.map((v) => {
                    const conocida = VARIABLES.some((x) => x.clave === `{{${v}}}`)
                    return (
                      <code
                        key={v}
                        className={`text-[11px] border rounded px-1.5 py-0.5 ${
                          conocida ? 'border-ok/40 text-ok bg-ok/10' : 'border-warn/40 text-warn bg-warn/10'
                        }`}
                      >
                        {`{{${v}}}`}
                      </code>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">Plantillas</h1>
          <p className="text-sm text-ink2 mt-1">
            Globales para todas las subcuentas, o específicas de una sola.
          </p>
        </div>
        <Boton onClick={abrirNueva}>Nueva plantilla</Boton>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      <div className={TARJETA}>
        {datos.length === 0 ? (
          <p className="text-sm text-mut py-10 text-center">Todavía no hay plantillas.</p>
        ) : (
          <Tabla columnas={['Nombre', 'Asunto', 'Ámbito', 'Actualizada', '']}>
            {datos.map((t) => {
              const global = t.location_id == null
              return (
                <tr key={t.id}>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 font-medium">{t.name}</td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2">
                    <div className="max-w-80 truncate" title={t.subject}>
                      {t.subject}
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60">
                    <span
                      className={`text-[11px] px-2 py-0.5 rounded-full border ${
                        global ? 'border-gold/40 text-gold' : 'border-border text-ink2'
                      }`}
                    >
                      {global ? 'Global' : nombreSubcuenta(t.location_id)}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 whitespace-nowrap">
                    {fecha(t.updated_at || t.created_at)}
                  </td>
                  <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                    <button type="button" className="text-xs text-ink2 hover:text-ink mr-3" onClick={() => abrirEditar(t)}>
                      Editar
                    </button>
                    <button type="button" className="text-xs text-bad/80 hover:text-bad" onClick={() => setABorrar(t)}>
                      Eliminar
                    </button>
                  </td>
                </tr>
              )
            })}
          </Tabla>
        )}
      </div>

      {aBorrar && (
        <Confirmar
          title="Eliminar plantilla"
          message={`¿Seguro que quieres eliminar «${aBorrar.name}»? Si alguna subcuenta la usa en un workflow, ese envío dejará de funcionar.`}
          onConfirm={borrar}
          onCancel={() => setABorrar(null)}
        />
      )}
    </div>
  )
}
