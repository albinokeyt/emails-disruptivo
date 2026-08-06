import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import {
  Aviso,
  Boton,
  Campo,
  Confirmar,
  Copiar,
  Spinner,
  Tabla,
  Textarea,
} from '../components/ui.jsx'

const TARJETA = 'bg-card border border-border rounded-2xl p-5'

const lista = (d, clave) => (Array.isArray(d) ? d : Array.isArray(d?.[clave]) ? d[clave] : [])

const fecha = (d) =>
  d ? new Date(d).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'

// Variables que sustituye la app al componer el mensaje.
const VARIABLES = [
  { clave: '{{destinatario.email}}', que: 'Correo del destinatario (campo «Para» del nodo).' },
  { clave: '{{destinatario.nombre}}', que: 'Nombre del destinatario (campo «Nombre» del nodo).' },
  { clave: '{{remitente.nombre}}', que: 'Nombre visible del remitente elegido.' },
  { clave: '{{remitente.email}}', que: 'Correo del remitente elegido.' },
  { clave: '{{asunto}}', que: 'El asunto de esta misma plantilla.' },
  { clave: '{{preheader}}', que: 'El texto de vista previa de esta plantilla.' },
  { clave: '{{baja_url}}', que: 'Enlace de baja. Obligatorio en envíos comerciales.' },
]

const VACIO = { name: '', subject: '', preheader: '', html: '', text: '' }

const HTML_EJEMPLO = `<div style="font-family:Arial,sans-serif;font-size:16px;color:#222">
  <p>Hola {{destinatario.nombre}},</p>
  <p>Gracias por escribirnos.</p>
  <p>Un saludo,<br>{{remitente.nombre}}</p>
  <p style="font-size:12px;color:#888"><a href="{{baja_url}}">Darse de baja</a></p>
</div>`

// Las variables declaradas se deducen del contenido: es lo que se guarda en templates.variables.
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

export default function Plantillas() {
  const [datos, setDatos] = useState(null)
  const [error, setError] = useState('')
  const [editando, setEditando] = useState(null) // {id|null}
  const [form, setForm] = useState(VACIO)
  const [errores, setErrores] = useState([])
  const [guardando, setGuardando] = useState(false)
  const [vista, setVista] = useState('codigo')
  const [aBorrar, setABorrar] = useState(null)

  const cargar = useCallback(async () => {
    try {
      const d = await api.get('/api/loc/plantillas')
      setDatos(lista(d, 'plantillas'))
      setError('')
    } catch (e) {
      setError(e.message)
      setDatos([])
    }
  }, [])

  useEffect(() => {
    cargar()
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
      name: form.name.trim(),
      subject: form.subject.trim(),
      preheader: form.preheader.trim() || null,
      html: form.html,
      text: form.text.trim() || null,
      variables,
    }

    setGuardando(true)
    try {
      if (editando.id) await api.patch(`/api/loc/plantillas/${editando.id}`, cuerpo)
      else await api.post('/api/loc/plantillas', cuerpo)
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
      await api.del(`/api/loc/plantillas/${t.id}`)
      await cargar()
    } catch (err) {
      setError(err.message)
    }
  }

  if (error && datos === null) return <Aviso variant="error">{error}</Aviso>
  if (datos === null) {
    return (
      <div className="py-16 grid place-items-center">
        <Spinner />
      </div>
    )
  }

  const panelVariables = (
    <div className={TARJETA}>
      <div className="text-sm font-semibold mb-1">Variables disponibles</div>
      <p className="text-xs text-mut mb-4">
        Escríbelas tal cual dentro del asunto, el preheader o el HTML. Se sustituyen al componer cada correo; si una
        variable no tiene valor, se queda vacía.
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
      <div className="border-t border-border mt-4 pt-4 text-xs text-ink2 space-y-2">
        <p>
          <strong className="text-ink">Cómo se usa desde el nodo.</strong> En el workflow, el nodo «Enviar email con
          plantilla» solo pide proveedor, remitente, plantilla y destinatario. Todo lo demás sale de aquí.
        </p>
        <p>
          En los campos del nodo (Para, Nombre, CC…) puedes escribir los merge fields propios de GHL, por ejemplo{' '}
          <code className="text-gold">{'{{contact.email}}'}</code>: GHL los resuelve antes de llamar a la app, así que
          llegan ya con el valor puesto. Dentro del HTML de la plantilla, en cambio, GHL no interviene: ahí solo funcionan
          las variables de esta lista.
        </p>
      </div>
    </div>
  )

  if (editando) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">{editando.id ? 'Editar plantilla' : 'Nueva plantilla'}</h1>
            <p className="text-sm text-ink2 mt-1">El asunto y el preheader también admiten variables.</p>
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
                placeholder="Texto de vista previa que se ve en la bandeja de entrada"
                value={form.preheader}
                onChange={set('preheader')}
                maxLength={200}
                hint="Aparece junto al asunto en Gmail y Outlook."
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

          <div className="space-y-4">
            {panelVariables}
            <div className={TARJETA}>
              <div className="text-sm font-semibold mb-2">Variables usadas en esta plantilla</div>
              {variables.length === 0 ? (
                <p className="text-xs text-mut">Ninguna todavía.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {variables.map((v) => {
                    const conocida = VARIABLES.some((x) => x.clave === `{{${v}}}`)
                    return (
                      <code
                        key={v}
                        title={conocida ? 'Variable reconocida' : 'La app no rellena esta variable: se quedará vacía'}
                        className={`text-[11px] border rounded px-1.5 py-0.5 ${
                          conocida ? 'border-ok/40 text-ok bg-ok/10' : 'border-warn/40 text-warn bg-warn/10'
                        }`}
                      >
                        {`{{${v}}}`}
                      </code>
                    )
                  })}
                </div>
              )}
              {variables.some((v) => !VARIABLES.some((x) => x.clave === `{{${v}}}`)) && (
                <p className="text-[11px] text-warn mt-3">
                  Las marcadas en ámbar no las rellena la app y saldrán vacías en el correo.
                </p>
              )}
            </div>
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
            Las que crees aquí aparecen en el nodo «Enviar email con plantilla» de tus workflows.
          </p>
        </div>
        <Boton onClick={abrirNueva}>Nueva plantilla</Boton>
      </div>

      {error && <Aviso variant="error">{error}</Aviso>}

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <div className={`lg:col-span-2 ${TARJETA}`}>
          {datos.length === 0 ? (
            <p className="text-sm text-mut py-10 text-center">
              Todavía no hay plantillas. Crea la primera para poder usar el nodo del workflow.
            </p>
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
                      {t.preheader && (
                        <div className="text-[11px] text-mut max-w-80 truncate" title={t.preheader}>
                          {t.preheader}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded-full border ${
                          global ? 'border-gold/40 text-gold' : 'border-border text-ink2'
                        }`}
                      >
                        {global ? 'De la agencia' : 'Tuya'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 text-ink2 whitespace-nowrap">
                      {fecha(t.updated_at || t.created_at)}
                    </td>
                    <td className="px-3 py-2.5 text-sm border-t border-border/60 text-right whitespace-nowrap">
                      {global ? (
                        <span className="text-xs text-mut">Solo lectura</span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="text-xs text-ink2 hover:text-ink mr-3"
                            onClick={() => abrirEditar(t)}
                          >
                            Editar
                          </button>
                          <button
                            type="button"
                            className="text-xs text-bad/80 hover:text-bad"
                            onClick={() => setABorrar(t)}
                          >
                            Eliminar
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )
              })}
            </Tabla>
          )}
        </div>

        {panelVariables}
      </div>

      {aBorrar && (
        <Confirmar
          title="Eliminar plantilla"
          message={`¿Seguro que quieres eliminar «${aBorrar.name}»? Los workflows que la usen dejarán de enviar.`}
          onConfirm={borrar}
          onCancel={() => setABorrar(null)}
        />
      )}
    </div>
  )
}
