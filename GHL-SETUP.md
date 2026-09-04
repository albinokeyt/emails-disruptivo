# Alta de la app en el marketplace de GoHighLevel

Todo lo que hay que configurar **dentro de GHL** para que Emails Disruptivo funcione: la app, el menú
lateral, los dos nodos de workflow y el SMTP del relay.

Antes de empezar necesitas la app ya desplegada y con dominio HTTPS (ver [DEPLOY.md](DEPLOY.md)). En
esta guía se usa `https://emails.tudominio.com` como ejemplo; sustitúyelo por el tuyo, que es lo que
tengas en `APP_BASE_URL`.

Orden: **1** app y distribución → **2** scopes → **3** OAuth → **4** SSO → **5** menú lateral →
**6** credenciales en el panel → **7 y 8** los dos nodos → **9** publicar → **10** relay SMTP.

---

## 1. Crear la app y elegir la distribución

En [marketplace.gohighlevel.com](https://marketplace.gohighlevel.com) → **My Apps → Create App**.

| Campo | Valor | Por qué |
|---|---|---|
| **Who is the target user of the app?** | **Sub-account** | Es una app por subcuenta. **Este campo no se puede cambiar después.** |
| **Who can install the app?** | Both Agency and Sub-account | Deja que instale tanto la agencia como cada subcuenta |
| **Can this app be bulk-installed by agencies?** | Yes | GHL lo pone obligatoriamente en `Yes` en las apps nuevas y no se puede volver atrás |

Apunta el **Client ID**, el **Client Secret** y el **App ID**: van al panel de admin en el paso 6.

---

## 2. Scopes

Los scopes **solo se pueden tocar mientras la app está en draft**. Una vez publicada quedan
bloqueados hasta que crees una nueva versión.

| Scope | ¿Hace falta? | Para qué |
|---|---|---|
| `workflows.readonly` | **Obligatorio** | La documentación lo dice literal: *"workflows.readonly scope should be turned on to enable actions and triggers"*. Sin él los nodos no existen |
| `locations.readonly` | Recomendado | Leer el nombre de la subcuenta (`GET /locations/:locationId`) para mostrarlo en el panel en vez de un id suelto |
| `oauth.readonly` | Recomendado | Solo se usa si una agencia instala en bloque: `GET /oauth/installedLocations` |
| `oauth.write` | Recomendado | Igual: canjear el token de agencia por uno de subcuenta con `POST /oauth/locationToken` |
| `contacts.readonly` | **Obligatorio para «Rebotados»** | Resolver el contacto por su email cuando la supresión no trae el id (`GET /contacts/search/duplicate`) |
| `contacts.write` | **Obligatorio para «Rebotados»** | Activar el No Molestar del canal Email del contacto (`PUT /contacts/{id}` con `dndSettings`) |

Los dos de `oauth.*` hacen falta porque, con **bulk install** activado (que es obligatorio), cuando
instala una agencia el token que sale es de tipo `Company` y **no trae `locationId`**: hay que
canjearlo subcuenta a subcuenta. Si instala un usuario de subcuenta, el token ya viene con
`userType: "Location"` y `locationId`, y no se usa nada de esto.

> **Si la app ya estaba instalada en alguna subcuenta**, añadir `contacts.readonly` y
> `contacts.write` a la lista no basta: el token que esa subcuenta tiene guardado se emitió sin esos
> permisos y **no los adquiere solo** (ni siquiera al refrescarse). Hay que **reinstalar la app en
> esa subcuenta** —desinstalar y volver a instalar, o repetir el Install Link— para que el token
> nuevo llegue con los scopes de contactos. Hasta entonces, la pantalla «Rebotados» podrá listar los
> rebotes pero fallará al resolver contactos o activar su DND.

### Lo que NO debes pedir

**No añadas `custom-menu-link.readonly` ni `custom-menu-link.write`.** La documentación de
distribución de GHL enumera los scopes de nivel agencia que impiden la instalación por subcuenta, y
esos dos están en la lista, junto con `companies.readonly`, `companies.write`, `location.write`,
`saas/location.write`, `snapshots.*` y los módulos **Snapshots** y **CustomJS**.

Si pides cualquiera de ellos, la app pasa a *"Who can install: **Agency Only**"* y pierdes la
instalación por subcuenta, que es justo el modelo de esta app. El menú lateral se consigue de otra
forma (paso 5), sin ningún scope.

---

## 3. OAuth: Redirect URL

En **Advanced Settings → Auth**:

```
https://emails.tudominio.com/api/oauth/callback
```

La ruta no lleva la palabra `ghl` ni `highlevel` a propósito: el marketplace rechaza las redirect
URLs que referencian a HighLevel.

En esa misma pantalla verás el **Install Link** (el `chooselocation`), que puedes usar para instalar
a mano. La app también lo construye ella misma en `https://emails.tudominio.com/api/oauth/instalar`,
que además añade un `state` anti-CSRF; usa ese siempre que puedas.

**Webhook URL: déjala vacía.** Esta versión no expone ningún endpoint para los webhooks de
`INSTALL`/`UNINSTALL` de la app, así que no hay nada que apuntar ahí. Consecuencia práctica: cuando
una subcuenta desinstala la app, la fila de `connections` no se marca sola como `uninstalled`.

---

## 4. Shared Secret del SSO

Es lo que permite que el panel sepa **quién** entra sin que el `locationId` viaje por la URL (donde
sería trivial de falsificar).

1. En la app → **Advanced Settings → Auth → Shared Secret → Generate**. En las versiones nuevas de la
   interfaz del marketplace está en **Manage → Secrets → Shared Secret Key** — las dos rutas conviven
   según la versión que te toque.
2. Cópialo y pégalo en el panel de admin → **Ajustes** (paso 6). Solo vive en el backend, nunca en el
   navegador.

Cómo funciona, para que sepas qué estás mirando si algo falla: el panel se carga dentro de un iframe
de GHL, hace `postMessage({message:"REQUEST_USER_DATA"})` al padre, recibe
`{message:"REQUEST_USER_DATA_RESPONSE", payload:<base64>}` y manda ese payload a
`POST /api/sesion/sso`. El backend lo descifra con el Shared Secret (AES-256-CBC con la derivación
`Salted__` + EVP_BytesToKey MD5, el formato de CryptoJS) y de ahí saca `activeLocation`, `companyId`,
`userId`, `role` y `email`.

Detalle que confunde a todo el mundo: en el contexto de subcuenta el campo `type` del payload
**sigue valiendo `"agency"`**. La subcuenta se detecta por la presencia de **`activeLocation`**, no
por `type`.

---

## 5. El menú lateral: módulo Custom Pages

Aquí es donde se decide que la app aparezca sola en la barra izquierda de cada subcuenta.

En la app → **Modules → Custom Pages**, y configura una página con:

| Campo | Valor |
|---|---|
| Nombre / etiqueta del menú | `Emails` (lo que quieras que se lea en la barra lateral) |
| URL | `https://emails.tudominio.com/` — la raíz del panel, **sin parámetros** |
| Placement | Menú de navegación izquierdo |

Con distribución *Sub-account*, la documentación dice que la página aparece *"in the installed
sub-account's left navigation"* y que *"once the app is installed, the custom page becomes visible to
the customer in the configured placement"*. Es decir: **la entrada del menú se crea sola, solo en las
subcuentas donde la app está instalada, y no consume ningún scope**.

No pongas `?location_id={{location.id}}` ni ninguna otra variable en la URL. El `locationId` llega
por el SSO cifrado; un parámetro de URL es falsificable y la app lo ignora.

> **Sin confirmar.** La documentación de Custom Pages no enumera los campos exactos del formulario
> (etiqueta, icono, selector de placement) ni dice cuántas páginas admite una app — una fuente de
> terceros afirma que solo se puede tener **una**. **Cómo verificarlo:** abre *Modules → Custom Pages*
> en tu app y mira los campos que te ofrece de verdad. Tampoco está desglosado si la página colocada
> en el menú lateral responde igual al `REQUEST_USER_DATA` que la que vive dentro de la ficha de la
> app: pruébalo instalando en una subcuenta de pruebas y mirando si el panel entra solo o te pide
> login.

### Por qué NO se usa la API `/custom-menus/`

Existe, crea un *Custom Menu Link* clásico y permite elegir subcuentas concretas con el array
`locations`. Pero tiene tres problemas que la descartan para esta app:

1. **Exige token de agencia** en los cinco endpoints (`Agency-Access`).
2. **Obliga a pedir `custom-menu-link.*`**, que deja la app como *Agency Only* (ver paso 2).
3. **No hay SSO en un Custom Menu Link.** La propia plantilla oficial de GHL dice que el SSO por
   `postMessage` *"currently supports integration exclusively with custom pages"*. En un menu link el
   padre no responde a `REQUEST_USER_DATA`, así que el panel no podría autenticar a nadie.

Un menu link puede servir como **atajo** dentro de un snapshot, pero la entrada buena —la que además
autentica— es la Custom Page del módulo.

---

## 6. Pegar las credenciales en el panel

Entra en `https://emails.tudominio.com/admin` con `ADMIN_USER` / `ADMIN_PASS` → **Ajustes**, y rellena:

| Campo | De dónde sale |
|---|---|
| `client_id` | Paso 1 |
| `client_secret` | Paso 1 |
| `app_id` | Paso 1 |
| `shared_secret` | Paso 4 |
| `company_id` | El id de tu agencia |

Todo esto vive en la tabla `settings` bajo la clave `ghl`, y los secretos se devuelven enmascarados
al leerlos.

En esa misma pantalla está el **`action_secret`**: el segmento aleatorio y fijo que llevan las cuatro
URLs de los nodos. Cópialo (o copia directamente las URLs completas si el panel te las da hechas);
lo necesitas en los pasos 7 y 8. Si tu versión del panel no lo muestra, está en `settings`, clave
`ghl`, campo `action_secret`.

Las cuatro URLs, con `<secreto>` = ese valor:

| Para qué | URL |
|---|---|
| Ejecución del nodo 1 | `https://emails.tudominio.com/api/ghl/accion/plantilla/<secreto>` |
| Ejecución del nodo 2 | `https://emails.tudominio.com/api/ghl/accion/personalizado/<secreto>` |
| Campo Dynamic del nodo 1 | `https://emails.tudominio.com/api/ghl/dinamico/plantilla/<secreto>` |
| Campo Dynamic del nodo 2 | `https://emails.tudominio.com/api/ghl/dinamico/personalizado/<secreto>` |

Ese segmento **es la contraseña de esos endpoints**. Trátalo como tal: no lo pegues en un ticket ni
en una captura.

---

## 7. Nodo 1 — «Enviar email con plantilla»

En la app → **Modules → Workflow → Create Action**.

### 7.1 Action Information

| Campo | Valor |
|---|---|
| **Name** | `Enviar email con plantilla` |
| **Key** | `enviar_email_plantilla` — **no se puede cambiar nunca más** |
| **Icon** | el que prefieras (un sobre) |
| **Short description** | `Envía un email con una plantilla guardada de la subcuenta` |
| **Summary** | `Elige proveedor, remitente y plantilla. El asunto y el cuerpo salen de la plantilla; el envío queda registrado con su estado de entrega, aperturas, clics y rebotes.` |

### 7.2 Campos (Action Configuration → Manage Fields)

Créalos en este orden. La columna **Reference** es literal: es la clave que nos llega en `data`, y si
la escribes distinta el nodo no funcionará.

| # | Name (etiqueta visible) | Type | Reference | Required | Alters Dynamic Field |
|---|---|---|---|---|---|
| 1 | Proveedor | `Select` | `provider_id` | No | **Sí** |
| 2 | Configuración del envío | `Dynamic` | `dynamic` | Sí | No |
| 3 | Para (email) | `String` | `to_email` | **Sí** | No |
| 4 | Nombre del destinatario | `String` | `to_name` | No | No |
| 5 | CC | `String` | `cc` | No | No |
| 6 | BCC | `String` | `bcc` | No | No |
| 7 | Responder a | `String` | `reply_to` | No | No |

Ajustes por campo:

- **1 · Proveedor** — *Option Type*: **Constants**. Ver 7.3, que es el punto delicado. Es el **único**
  campo con **Alters Dynamic Field** activado.
- **2 · Configuración del envío** — es el campo de tipo **Dynamic**. Su **URL (POST)** es
  `https://emails.tudominio.com/api/ghl/dinamico/plantilla/<secreto>`. De aquí salen, ya pintados por
  nosotros, los desplegables **Remitente** (`sender_id`) y **Plantilla** (`template_id`), filtrados
  por la subcuenta.
- **3 · Para (email)** — *Default Value*: `{{contact.email}}`. *Validation Rules*: regla predefinida
  **email**, con un mensaje de error propio en español.
- **4 · Nombre del destinatario** — *Default Value*: `{{contact.first_name}} {{contact.last_name}}`.
- **5 y 6 · CC / BCC** — texto libre, varias direcciones separadas por comas.
- **7 · Responder a** — *Validation Rules*: regla predefinida **email**. Si se deja vacío se usa el
  `reply_to` del remitente.

Deja **Pause Execution** y **Show Branches Section** desactivados: el envío es asíncrono por dentro
(va a una cola) pero la respuesta al nodo es inmediata, así que no hace falta ninguna de las dos.

### 7.3 El campo Proveedor y el encadenamiento de desplegables

Esta parte merece explicación porque es la única forma soportada de encadenar desplegables en GHL, y
tiene una limitación real.

**Cómo funciona.** Marcar **Alters Dynamic Field** en un campo hace que, cada vez que el usuario lo
cambia, GHL vuelva a hacer `POST` a la URL del campo Dynamic mandando el estado actual del
formulario:

```json
{ "data": { "provider_id": "12" },
  "extras": { "locationId": "xyz", "contactId": "abc", "workflowId": "def" },
  "meta": { "key": "enviar_email_plantilla", "version": "1.0" } }
```

Ese `extras.locationId` es **el único sitio de toda la configuración donde sabemos qué subcuenta es**.
La app responde con los campos ya filtrados:

```json
{ "inputs": [ { "section": "Envío", "fields": [
  { "key": "sender_id", "label": "Remitente", "type": "select", "required": true,
    "options": [ { "label": "Bibi <hola@bibi.com>", "value": "12" } ] },
  { "key": "template_id", "label": "Plantilla", "type": "select", "required": true,
    "options": [ { "label": "Bienvenida", "value": "4" } ] }
] } ] }
```

Si la subcuenta no tiene nada configurado todavía, en vez de un array vacío devolvemos una opción
informativa (`value: ""`) explicando qué le falta, para que el usuario lo entienda dentro del propio
constructor de workflows.

**Solo se admite UN campo Dynamic por acción.** Por eso todo lo que dependa de la elección del
usuario —remitente y plantilla— sale de ese mismo bloque, en la misma respuesta.

> **Sin confirmar, y es lo más importante de esta página.** El *Option Type* → **External API** de un
> `Select` existe (un `GET` que devuelve `{"options":[{"label","value"}]}`), pero **la documentación
> de GHL no describe ningún parámetro, cabecera ni contexto que se envíe a ese GET**: ni `locationId`,
> ni el valor de otros campos. Si eso es cierto, ese endpoint **no puede saber de qué subcuenta es la
> lista**, y por tanto no sirve para listar los proveedores de cada cliente.
>
> **Qué hacer mientras tanto:** deja *Option Type* en **Constants** con una única opción
> `Automático (el del remitente)` y **value vacío**. El campo existe solo para forzar la recarga del
> bloque Dynamic; el proveedor real sale del remitente elegido (`senders.provider_id`), que ya viene
> filtrado por subcuenta. Funciona para todos los clientes y no filtra datos de unos a otros.
>
> **Cómo verificarlo tú mismo:** crea temporalmente el campo con *Option Type* → **External API** y
> apunta la URL a un `https://webhook.site/…` propio. Abre el nodo dentro de un workflow real y mira
> en webhook.site qué te llegó: query string y cabeceras. Si ahí viaja el `locationId`, entonces sí
> puedes servir la lista de proveedores por API y sustituir la opción constante. Si no viaja nada,
> quédate con **Constants**.
>
> La otra alternativa, solo válida si gestionas la app para un único cliente, es escribir a mano en
> **Constants** los ids de sus proveedores (`label` = nombre, `value` = id de `providers`).

### 7.4 Action Execution

| Campo | Valor |
|---|---|
| Tipo | **API** |
| **URL (POST)** | `https://emails.tudominio.com/api/ghl/accion/plantilla/<secreto>` |
| **Headers** | Vacío |

Las cabeceras se dejan vacías a propósito: la autenticación de estos endpoints es el **segmento
secreto de la URL** más la comprobación de que `extras.locationId` corresponde a una instalación viva.

> **Sin confirmar.** La documentación de Custom Actions **no menciona ninguna cabecera de firma** para
> el POST de ejecución. La guía de webhooks de GHL sí describe `X-GHL-Signature` (Ed25519) y la legacy
> `X-WH-Signature` (RSA-SHA256, que se retira el 1 de septiembre de 2026), y un changelog afirma que
> los cambios aplican a *"All Webhooks"*, pero no lo confirma para las acciones de marketplace. La app
> verifica la firma **si llega** y no bloquea si no llega.
> **Cómo verificarlo:** apunta temporalmente la URL de ejecución a un `https://webhook.site/…`, ejecuta
> el nodo una vez y mira las cabeceras reales de la petición.

### 7.5 Response Data y variables de salida

En **Response Data**, pega este JSON de muestra (es exactamente lo que devuelve la app):

```json
{ "ok": true, "message_id": "1042", "estado": "encolado" }
```

Y en **Manage Custom Variables** crea tres:

| Name | Reference |
|---|---|
| Enviado | `ok` |
| ID de mensaje | `message_id` |
| Estado | `estado` |

Quedan disponibles en los pasos siguientes del workflow. La documentación de GHL muestra dos formas
de escribirlas (`{{mycustomaction.data.name}}` y `{{action_a.custom_variable}}`) y se contradice, así
que **usa el selector de variables del constructor de workflows** en vez de teclearlas a mano.

Qué devuelve la app y cómo reacciona GHL:

| Situación | HTTP | Cuerpo | Efecto |
|---|---|---|---|
| Aceptado y encolado | 200 | `{"ok":true,"message_id":"1042","estado":"encolado"}` | El contacto sigue al paso siguiente |
| Error de configuración (falta remitente, plantilla borrada, email inválido…) | 400 | `{"ok":false,"error":"…"}` | Mensaje en español, legible en el log del workflow |
| Error temporal nuestro | 503 | — | GHL reintenta |

---

## 8. Nodo 2 — «Enviar email personalizado»

Repite **Create Action**. Es el mismo esquema con el contenido escrito a mano en el nodo.

### 8.1 Action Information

| Campo | Valor |
|---|---|
| **Name** | `Enviar email personalizado` |
| **Key** | `enviar_email_personalizado` — inmutable |
| **Short description** | `Envía un email escribiendo aquí el asunto y el cuerpo` |
| **Summary** | `Configura asunto, preheader, CC, BCC, reply-to y cuerpo HTML directamente en el workflow, usando los merge fields del contacto.` |

### 8.2 Campos

| # | Name (etiqueta visible) | Type | Reference | Required | Alters Dynamic Field |
|---|---|---|---|---|---|
| 1 | Proveedor | `Select` | `provider_id` | No | **Sí** |
| 2 | Configuración del envío | `Dynamic` | `dynamic` | Sí | No |
| 3 | Para (email) | `String` | `to_email` | **Sí** | No |
| 4 | Nombre del destinatario | `String` | `to_name` | No | No |
| 5 | Asunto | `String` | `subject` | **Sí** | No |
| 6 | Preheader | `String` | `preheader` | No | No |
| 7 | CC | `String` | `cc` | No | No |
| 8 | BCC | `String` | `bcc` | No | No |
| 9 | Responder a | `String` | `reply_to` | No | No |
| 10 | Cuerpo HTML | `Textarea` | `html` | **Sí** | No |

Diferencias respecto al nodo 1:

- El campo **Dynamic** apunta a
  `https://emails.tudominio.com/api/ghl/dinamico/personalizado/<secreto>` y devuelve **solo**
  `sender_id`: aquí no hay plantilla que elegir.
- El **Proveedor** vuelve a ser el único campo con *Alters Dynamic Field*, con la misma advertencia
  de 7.3.
- El **Cuerpo HTML** es `Textarea`. Admite merge fields de GHL: `{{contact.first_name}}`,
  `{{custom_values.…}}`, salidas de pasos anteriores… **GHL los resuelve antes de llamarnos**, así
  que en `data.html` nos llega el texto ya interpolado.

### 8.3 Ejecución y respuesta

| Campo | Valor |
|---|---|
| **URL (POST)** | `https://emails.tudominio.com/api/ghl/accion/personalizado/<secreto>` |
| **Headers** | Vacío |
| **Response Data** | El mismo JSON del apartado 7.5 |
| **Custom Variables** | Las mismas tres |

---

## 9. Publicar

1. Cada acción nace en **draft**. Cuando la tengas, **Submit for review** con su changelog.
2. Al aprobarse *"will be published live to all Sub-accounts"*.
3. **+ New Version** clona la última publicada en un draft nuevo para seguir tocando.
4. **Borrar una acción es permanente**, y si estaba dentro de un workflow, *"the action execution will
   be skipped"*. Ojo con eso.

Dos cosas que hay que saber antes de vender esto a un cliente:

- Las Marketplace Workflow Actions son parte de **LC Premium Triggers & Actions** y **se cobran por
  ejecución**. Si una subcuenta no tiene esa función activada, **el nodo no le aparece en la lista**
  aunque tenga la app instalada.
- El importe que circula en el soporte de GHL es de **$0,01 por ejecución**, pero sale de un artículo
  sobre un experimento de exención que ya cerró inscripciones. **Confírmalo en tu propia cuenta de
  agencia** antes de dar un número al cliente.

---

## 10. El SMTP del relay dentro de GHL

Este paso es **por subcuenta** y solo tiene sentido con el relay encendido (sección D de
[DEPLOY.md](DEPLOY.md): unos pocos pasos, el certificado TLS lo lee la app del de Traefik). Es lo que permite
seguir usando el **nodo nativo de email de GHL** sin perder el historial ni el estado de entrega.

### 10.1 Sacar las credenciales

En el panel de la subcuenta (dentro de GHL) → **Relay** → **Activar**. La app genera un usuario y una
contraseña. **La contraseña se muestra una sola vez**: cópiala ahora. Si se pierde, se rota desde esa
misma pantalla y hay que volver a pegarla en GHL.

La misma pantalla enseña el **host**, los **dos puertos públicos** (`587` TLS/STARTTLS y `465` SSL)
y un badge con el estado del **certificado TLS** del servidor. El aviso de arriba te dice en qué
punto está la plataforma: servidor apagado (avisa a la agencia), encendido pero certificado en
emisión (espera un minuto y recarga: es lo normal justo después de un despliegue), o todo correcto.
**Pega los datos en GHL solo cuando el badge esté en verde**; si no, GHL puede rechazar la conexión
segura al guardar y hay que volver a intentarlo.

Ahí mismo se configura el **proveedor por defecto** de la subcuenta, que es el que se usará con los
remitentes nuevos que detecte el relay.

### 10.2 Pegarlas en GHL

Subcuenta → **Settings → Email Services → pestaña SMTP Service → + Add Service** (arriba a la
derecha). Proveedor: **Other**.

| Campo (nombre literal en GHL) | Qué poner |
|---|---|
| **SMTP Host** | El host que enseña la pantalla *Relay*: por defecto el dominio de la app (p. ej. `ddemail.escaladoacelerado.es`), o el `SMTP_RELAY_HOST` que haya definido la agencia |
| **Port** | **`587` con TLS/STARTTLS** (recomendado). También vale `465` con SSL. Son los puertos públicos que muestra la pantalla; nunca `2525`/`2465`, que son las escuchas internas del contenedor |
| **Username** | El usuario que generó la app |
| **Password / API Key** | La contraseña que se mostró una sola vez |
| **From Name** | El nombre que quieras que se vea |
| **From Email** | Una dirección de la subcuenta — **da igual cuál**, ver 10.3 |

Y marca:

- **Default Provider**, para que la subcuenta use este servicio por defecto.
- **Enable reply** si quieres que las respuestas se registren en *Conversations*.

> **Sin confirmar.** El artículo oficial de GHL lista esos seis campos, pero **no hay captura que
> confirme el nombre exacto del selector de seguridad** (¿"Secure"? ¿"Encryption"? ¿"TLS/SSL"? ¿un
> checkbox "Use SSL"?). **Cómo verificarlo:** ábrelo en una subcuenta real y mira la etiqueta.
> Tampoco hay ninguna fuente oficial que diga que **GHL valide las credenciales al guardar**: asume
> que **no** lo hace. **Cómo verificarlo:** guarda y envía un correo de prueba desde *Conversations*;
> los errores salen al pinchar el triángulo rojo del mensaje.

Si al guardar o al enviar aparece un error que habla del **certificado** (`CERT`, `SELF_SIGNED`,
`unable to verify`), el relay todavía está con el certificado autofirmado provisional: la emisión
del de Let's Encrypt no ha terminado (espera un minuto y recarga la pantalla *Relay*) o ha fallado
(la agencia lo ve en su panel → *Ajustes* → «Relay SMTP y certificado» y lo relanza desde ahí). Un
`ETIMEDOUT` o `CONN`, en cambio, es que el puerto no está accesible: no es nada del certificado.

**Orden de precedencia** que aplica GHL, por si el correo sale por otro sitio del que esperabas:

1. Default Provider de la subcuenta
2. *Email Settings for Locations* (vista de agencia)
3. Default provider de la agencia
4. LeadConnector Email (respaldo)

### 10.3 Cómo queda el enrutado por remitente

Esta es la parte que sorprende, y es intencionada: **el `From Email` que pongas en la ficha de GHL no
decide nada**. Lo que manda es el `From` real del mensaje que llega al relay, que puede ser distinto
en cada workflow.

Al recibir un correo, el relay:

1. Autentica la conexión y saca el `location_id` de esas credenciales.
2. Busca el `From` en los remitentes de esa subcuenta. Si está, usa **su** proveedor. Caso normal.
3. Si no está, mira el dominio del `From`:
   - Verificado por **otra** subcuenta → **550**, rechazo duro. Es el único que hay, y protege a tus
     clientes entre sí.
   - De esta subcuenta o de nadie → sigue.
4. Con `accept_unknown_senders` activo (por defecto **sí**), **da de alta el remitente
   automáticamente** apuntando al proveedor por defecto, y envía. Aparece en el panel marcado como
   creado por el relay, para que le cambies el proveedor si quieres.
5. Sin proveedor por defecto configurado → **451** temporal con un mensaje claro.
6. Antes de encolar: lista de supresión y límites por minuto y por día.

| Respuesta del relay | Qué significa | Qué hacer |
|---|---|---|
| `250` | Aceptado y encolado | Nada; sigue en *Envíos* del panel |
| `451` | Falta el proveedor por defecto de esa subcuenta | Configúralo en la pantalla *Relay* |
| `550` | El dominio del `From` está verificado por otra subcuenta | Verifica el dominio en la subcuenta correcta, o usa otro remitente |
| `552` | Mensaje más grande que `SMTP_RELAY_MAX_SIZE` | Quita adjuntos |

Además, el proveedor final rechazará por su cuenta los remitentes que no tenga verificados (Brevo
devuelve un `400 invalid_parameter`). Ese error se guarda en `last_error` y se ve en el detalle del
envío.

### 10.4 Qué esperar del estado dentro de GHL

Con un SMTP propio, **GHL solo registra aperturas y clics** (con su propio pixel y su propia
reescritura de enlaces). `Delivered`, `Bounced` y `Deferred` **no se actualizan** en GHL: el mensaje
se queda en `Sent` para siempre. Tampoco sincroniza de vuelta las supresiones por rebote.

Eso no es un fallo de la configuración: es cómo funciona GHL. **La verdad sobre el estado de entrega
está en el panel de la app**, en *Envíos*, alimentada por los webhooks del proveedor. Es justamente
el hueco que esta app viene a tapar.

---

## 11. Si usas Brevo: desactiva su tracking de aperturas y clics

La app ya inserta su propio pixel de apertura y reescribe los enlaces para medir los clics (y, con un
dominio de tracking verificado en el panel → *Dominios*, lo hace con el dominio del propio cliente).
Si Brevo también lo hace, cada enlace acaba **envuelto dos veces**: URLs más largas y sospechosas
para los filtros de spam, aperturas y clics contados por duplicado, y el dominio de tracking del
cliente tapado por el de Brevo.

En Brevo → **Transactional → Settings**, desactiva el **Open tracking** y el **Click tracking** (el
nombre exacto varía según la versión de su panel; búscalo como "tracking" en los ajustes
transaccionales). Los webhooks de entrega, rebote y spam no se ven afectados: siguen llegando igual.

---

## Comprobación final

- [ ] Distribución en **Sub-account** y `workflows.readonly` activado.
- [ ] `contacts.readonly` y `contacts.write` en la lista de scopes (los necesita «Rebotados») y, en
      las subcuentas que ya tenían la app instalada, **app reinstalada** para que el token nuevo
      traiga esos dos permisos (ver paso 2).
- [ ] Ningún scope de nivel agencia (`custom-menu-link.*`, `companies.*`, `snapshots.*`, CustomJS).
- [ ] Redirect URL `…/api/oauth/callback` guardada en GHL y coincidiendo con `APP_BASE_URL`.
- [ ] Shared Secret generado y pegado en el panel → Ajustes.
- [ ] Custom Page apuntando a la raíz del panel, colocada en el menú izquierdo, **sin parámetros**.
- [ ] `client_id`, `client_secret`, `app_id` y `company_id` en Ajustes.
- [ ] Los dos nodos creados, cada uno con su campo `provider_id` marcado *Alters Dynamic Field* y su
      campo `Dynamic` apuntando a la URL correcta.
- [ ] *Response Data* pegado y las tres variables creadas en ambos nodos.
- [ ] Acciones enviadas a revisión y publicadas.
- [ ] Con proveedores Brevo: su tracking de aperturas y clics **desactivado** (lo hace la app, ver
      paso 11).
- [ ] App instalada en una subcuenta de pruebas: entra el menú lateral, entra sola por SSO, y un
      workflow de prueba deja una fila en *Envíos* que llega a `entregado`.
- [ ] *(Solo si usas el relay)* En admin → Ajustes el certificado está en «Válido hasta …»,
      `openssl s_client -starttls smtp -connect <host>:587` devuelve `Verify return code: 0 (ok)`, y
      el servicio SMTP guardado en la subcuenta de pruebas con el puerto `587` envía un correo desde
      *Conversations* que aparece en *Envíos* con origen «Relay SMTP».
