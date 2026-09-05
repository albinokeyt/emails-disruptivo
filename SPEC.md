# SPEC — App de email para el marketplace de GoHighLevel

Fuente única de verdad. Todo el código, la interfaz y la documentación van **en español**.
Stack: Node 22 · Fastify 5 · Postgres · Redis · React 18 + Vite 6 + Tailwind 4 · Docker · EasyPanel.
Repo de referencia para estilo y patrones: `../marketplace-disruptivo`.

---

## 1. Qué hace la app

Una subcuenta de GHL instala la app y le aparece una entrada en el menú lateral. Desde ahí registra
**proveedores** de email saliente (SMTP o Brevo por API), da de alta **remitentes** y crea **plantillas**.
Después envía correo por tres vías distintas, que conviven:

1. **Nodo propio "Enviar email con plantilla"** — en el workflow eliges proveedor, remitente y plantilla.
2. **Nodo propio "Enviar email personalizado"** — en el workflow configuras asunto, preheader, CC, BCC,
   reply-to y cuerpo HTML a mano.
3. **Relay SMTP (sección activable)** — la app te da unos datos SMTP que pegas en
   *Settings › Email Services* de GHL, y usas el **nodo nativo de email de GHL**. La app recibe el correo,
   mira el remitente, deduce el proveedor y lo dispara.

El **admin de la agencia** tiene un panel propio: registra sus propios proveedores, los asigna a las
subcuentas conectadas, y puede crear remitentes y plantillas para cualquiera de ellas.

Las tres vías escriben en la **misma** tabla `messages`, así que el historial de envíos y el estado de
entrega son únicos, vengan de donde vengan.

---

## 2. Hallazgos de la investigación que condicionan el diseño

Estos puntos no son negociables porque vienen de cómo funciona GHL/Brevo de verdad:

- **El menú lateral sale solo.** Se consigue con el módulo **Custom Pages** de la app del marketplace:
  GHL la pinta como iframe y la entrada aparece automáticamente al instalar, solo en las subcuentas que
  la tienen. **No** se usa la API `/custom-menus/`: exige token de agencia y obliga a poner
  "Who can install = Agency Only", perdiendo la instalación por subcuenta.
- **La identidad llega por SSO cifrado.** El iframe hace `postMessage({message:"REQUEST_USER_DATA"})`,
  recibe `{message:"REQUEST_USER_DATA_RESPONSE", payload:<base64>}` y el backend lo descifra con el
  Shared Secret (CryptoJS AES = OpenSSL `Salted__` + EVP_BytesToKey MD5 + AES-256-CBC).
  **El `locationId` NUNCA se lee de la query string.**
- **Los desplegables "External API" de GHL no reciben contexto** (ni `locationId` ni el valor de otros
  campos). No sirven para multi-cliente. El encadenamiento real (elegir proveedor → que se filtren sus
  remitentes) se hace con un **campo de tipo `Dynamic`** y la opción **"Alters Dynamic Field"** en el
  campo padre: GHL hace POST a nuestra URL con `{data, extras, meta}` y devolvemos
  `{"inputs":[{section, fields:[…]}]}` con las opciones ya filtradas.
  **Solo se permite UN campo Dynamic por acción**, así que ese campo genera todo lo dependiente.
- **Body de ejecución de un nodo:** siempre `{data:{…campos…}, extras:{locationId, contactId, workflowId},
  meta:{key, version}}`.
- **La firma del POST de ejecución no está confirmada.** Se implementa la verificación como *opcional*
  (si llega firma, se valida) y la seguridad real se apoya en un **segmento secreto en la URL** más la
  comprobación de que `extras.locationId` corresponde a una instalación viva.
- **Brevo:** el enum de creación de webhooks va en camelCase (`hardBounce`) pero el payload llega en
  snake_case (`hard_bounce`); hay que mapear. Se correlaciona con la cabecera `X-Mailin-custom`, que
  viaja en el envío y vuelve en todos los eventos. El `message-id` a veces trae `<…>` y a veces no:
  **se normaliza siempre**. La API de estadísticas está limitada a ~300 peticiones/hora, así que el
  reconciliador barre por ventana temporal, nunca mensaje a mensaje.
- **SMTP genérico solo confirma el primer salto.** Entrega real, rebotes y quejas son asíncronos.
- **GHL admite SMTP propio por subcuenta** en *Settings › Email Services › SMTP Service*
  (host, puerto, usuario, contraseña, from name/email, TLS/SSL). Precedencia: subcuenta > agencia > LC Email.
- **EasyPanel/Traefik solo enruta HTTP.** El puerto del relay SMTP hay que publicarlo como **TCP** y
  necesita certificado TLS válido. Es la parte con fricción real del despliegue.

---

## 3. Modelo de datos

Todas las tablas llevan `created_at timestamptz NOT NULL DEFAULT now()`.
Multi-tenant: **toda** consulta de datos de subcuenta filtra por `location_id`.

### `connections` — subcuentas con la app instalada
`id bigserial PK` · `location_id text UNIQUE NOT NULL` · `company_id text` · `name text` ·
`access_token text` · `refresh_token text` · `token_expires_at timestamptz` ·
`status text NOT NULL DEFAULT 'connected'` (`connected|error|uninstalled`) · `updated_at`.

### `settings` — configuración global de la app (clave/valor)
`key text PK` · `value jsonb NOT NULL` · `updated_at`.
Claves: `ghl` (client_id, client_secret, app_id, shared_secret, company_id), `limites`, `admins`.

### `providers` — proveedores de email saliente
`id bigserial PK` · `owner_scope text NOT NULL` (`location|admin`) · `location_id text NULL` ·
`name text NOT NULL` · `type text NOT NULL` (`smtp|brevo`) · `credentials_enc text NOT NULL` (AES-256-GCM) ·
`config jsonb NOT NULL DEFAULT '{}'` (no secreto: host, port, secure, pool) ·
`status text NOT NULL DEFAULT 'sin_probar'` (`ok|error|sin_probar`) · `last_check_at` · `last_error text` ·
`daily_limit int` · `updated_at`.
Regla: `owner_scope='location'` ⇒ `location_id NOT NULL`; `owner_scope='admin'` ⇒ `location_id NULL`.
Índice: `(location_id) WHERE owner_scope='location'`.

### `provider_assignments` — proveedores de admin cedidos a subcuentas
`id bigserial PK` · `provider_id bigint FK providers ON DELETE CASCADE` · `location_id text NOT NULL` ·
`UNIQUE(provider_id, location_id)`.

### `sender_domains` — dominios y su propiedad
`id bigserial PK` · `location_id text NOT NULL` · `domain text NOT NULL` (minúsculas) ·
`verified boolean NOT NULL DEFAULT false` · `verify_token text` · `verified_at` ·
`UNIQUE(domain) WHERE verified` — **un dominio verificado pertenece a una sola subcuenta**.
Es el único guardarraíl duro del relay: impide que una subcuenta envíe desde el dominio verificado de otra.

### `senders` — remitentes
`id bigserial PK` · `location_id text NOT NULL` · `provider_id bigint FK providers` ·
`email citext NOT NULL` · `name text NOT NULL` · `reply_to text` ·
`is_default boolean NOT NULL DEFAULT false` ·
`origin text NOT NULL DEFAULT 'panel'` (`panel|admin|auto`) ·
`verified_state text NOT NULL DEFAULT 'desconocido'` (`verificado|no_verificado|desconocido`) · `updated_at` ·
`UNIQUE(location_id, email)`.
`origin='auto'` = creado por el relay al detectar un remitente nuevo (ver §6).
Índice parcial único: un solo `is_default` por `location_id`.

### `templates` — plantillas
`id bigserial PK` · `location_id text NULL` (NULL = global del admin) · `name text NOT NULL` ·
`subject text NOT NULL` · `preheader text` · `html text NOT NULL` · `text text` ·
`variables jsonb NOT NULL DEFAULT '[]'` · `updated_at`.
Una subcuenta ve las suyas **y** las globales.

### `messages` — cola de envío e historial (fuente única de verdad)
`id bigserial PK` · `location_id text NOT NULL` · `provider_id bigint FK providers` ·
`sender_id bigint FK senders` · `template_id bigint NULL FK templates` ·
`origin text NOT NULL` (`nodo_plantilla|nodo_personalizado|relay`) ·
`status text NOT NULL DEFAULT 'encolado'` · `status_rank int NOT NULL DEFAULT 0` ·
`to_email citext NOT NULL` · `to_name text` · `cc text[]` · `bcc text[]` · `reply_to text` ·
`subject text NOT NULL` · `preheader text` · `html text` · `text text` ·
`ghl_contact_id text` · `ghl_workflow_id text` ·
`provider_message_id text` · `correlation_id text NOT NULL UNIQUE` (el que viaja en `X-Mailin-custom`) ·
`attempts int NOT NULL DEFAULT 0` · `next_attempt_at timestamptz NOT NULL DEFAULT now()` ·
`locked_at timestamptz` · `locked_by text` · `last_error text` ·
`opened_at` · `clicked_at` · `sent_at` · `updated_at`.
Índices: `(status, next_attempt_at) WHERE status IN ('encolado','reintento')`,
`(location_id, created_at DESC)`, `(provider_message_id)`, `(correlation_id)`.

### `message_events` — histórico append-only
`id bigserial PK` · `message_id bigint FK messages ON DELETE CASCADE` · `event text NOT NULL` ·
`occurred_at timestamptz NOT NULL` · `dedupe_key text NOT NULL` · `data jsonb` ·
`UNIQUE(message_id, dedupe_key)` — la idempotencia de los webhooks vive aquí.

### `message_links` — reescritura de enlaces para clics
`id bigserial PK` · `message_id bigint FK messages ON DELETE CASCADE` · `token text UNIQUE NOT NULL` ·
`url text NOT NULL`. El redirector **solo** redirige a una URL que esté en esta tabla.

### `suppressions` — lista de supresión
`id bigserial PK` · `location_id text NOT NULL` · `email citext NOT NULL` ·
`reason text NOT NULL` (`rebote_duro|spam|baja|manual`) · `source text` · `UNIQUE(location_id, email)`.

### `relay_accounts` — credenciales del relay SMTP por subcuenta
`id bigserial PK` · `location_id text NOT NULL UNIQUE` · `username text UNIQUE NOT NULL` ·
`password_hash text NOT NULL` (scrypt) · `enabled boolean NOT NULL DEFAULT false` ·
`default_provider_id bigint FK providers` · `accept_unknown_senders boolean NOT NULL DEFAULT true` ·
`last_used_at` · `rotated_at` · `updated_at`.

---

## 4. Máquina de estados de un mensaje

`status_rank` impide que un webhook desordenado haga retroceder el estado. **Nunca** se aplica un evento
con rango menor al actual (salvo los terminales negativos, que siempre ganan).

| estado | rango | significado |
|---|---|---|
| `encolado` | 0 | en cola, esperando worker |
| `reintento` | 5 | falló temporalmente, reintento programado |
| `enviando` | 10 | bloqueado por un worker |
| `enviado` | 20 | el proveedor lo aceptó (250 / 201) |
| `entregado` | 30 | confirmado por webhook |
| `diferido` | 25 | `deferred` del proveedor |
| `rebotado` | 90 | rebote duro o blando definitivo (terminal) |
| `spam` | 91 | marcado como spam (terminal) |
| `fallido` | 92 | error permanente al enviar (terminal) |
| `suprimido` | 93 | bloqueado antes de enviar por la lista de supresión (terminal) |

`opened_at` y `clicked_at` son marcas, **no** estados: no alteran `status`.
Terminales (≥90) no se reintentan nunca.

---

## 5. Contrato HTTP

Prefijos: `/api/loc/*` (sesión de subcuenta), `/api/admin/*` (sesión de admin),
`/api/ghl/*` (llamadas de GHL, autenticadas por secreto en la URL), `/api/webhooks/*`, `/t/*` (tracking).
Errores: `{ "error": "mensaje en español" }` con el código HTTP adecuado.

### 5.1 Sesión — `src/routes/oauth.js`
| Método | Ruta | Auth | Entrada / Salida |
|---|---|---|---|
| GET | `/api/oauth/instalar` | — | Redirige a `chooselocation` con `state` anti-CSRF |
| GET | `/api/oauth/callback` | — | Canjea el código, hace upsert en `connections`, devuelve HTML |
| POST | `/api/sesion/sso` | — | `{payload}` cifrado de GHL → cookie de sesión + `{locationId, nombre, esAdminAgencia}` |
| GET | `/api/sesion` | cualquiera | Devuelve la sesión actual o 401 |

### 5.2 Panel de subcuenta — `src/routes/location.js` (todas con `requireLocation`)
| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/loc/resumen` | contadores de envíos por estado, últimos 7 días |
| GET | `/api/loc/proveedores` | propios + asignados por el admin (marcados con `asignado:true`, no editables) |
| POST | `/api/loc/proveedores` | `{name, type, credentials:{…}, config:{…}}` — credenciales se cifran, nunca se devuelven |
| PATCH | `/api/loc/proveedores/:id` | idem; `credentials` opcional (si falta, se conservan) |
| DELETE | `/api/loc/proveedores/:id` | 409 si tiene remitentes o mensajes en cola |
| POST | `/api/loc/proveedores/:id/probar` | valida credenciales contra el proveedor → `{ok, detalle}` |
| GET/POST/PATCH/DELETE | `/api/loc/remitentes[/:id]` | `{email, name, reply_to, provider_id, is_default}` |
| GET/POST/PATCH/DELETE | `/api/loc/plantillas[/:id]` | globales visibles en GET, no editables |
| GET | `/api/loc/envios` | filtros `estado`, `desde`, `hasta`, `q`, `origen`; paginado |
| GET | `/api/loc/envios/:id` | mensaje + su `message_events` |
| GET/POST/DELETE | `/api/loc/supresiones[/:id]` | alta y baja manual |
| GET/POST/DELETE | `/api/loc/dominios[/:id]` | GET incluye `dominios_remitentes` (dominios reales de los remitentes, con `gratuito`); el POST solo admite dominios presentes en los remitentes de la subcuenta (y nunca de correo gratuito); `POST /:id/verificar` comprueba el TXT; DELETE renuncia a la exclusividad |
| GET | `/api/loc/relay` | `{enabled, host, port, username, tiene_password, default_provider_id, accept_unknown_senders, servidor_activo, last_used_at, rotated_at}` — `servidor_activo` refleja `SMTP_RELAY_ENABLED` (solo el flag: NO comprueba que el puerto TCP esté publicado); el panel avisa cuando es `false` |
| POST | `/api/loc/relay/activar` | activa la sección y genera credenciales; devuelve la contraseña **una sola vez** |
| POST | `/api/loc/relay/rotar` | regenera la contraseña; devuelve la nueva **una sola vez** |
| PATCH | `/api/loc/relay` | `{enabled, default_provider_id, accept_unknown_senders}`; responde como el GET |

### 5.3 Panel de admin — `src/routes/admin.js` (todas con `requireAdmin`)
| Método | Ruta | Notas |
|---|---|---|
| POST | `/api/admin/login` · `/api/admin/logout` | usuario/contraseña de env |
| GET | `/api/admin/yo` | sesión actual |
| GET | `/api/admin/subcuentas` | conexiones + nº de proveedores, remitentes y envíos |
| GET/POST/PATCH/DELETE | `/api/admin/proveedores[/:id]` | proveedores de ámbito admin |
| GET/POST/DELETE | `/api/admin/proveedores/:id/asignaciones[/:locationId]` | ceder a subcuentas |
| GET/POST/PATCH/DELETE | `/api/admin/remitentes[/:id]` | con `location_id` obligatorio en POST |
| GET/POST/PATCH/DELETE | `/api/admin/plantillas[/:id]` | `location_id` null = global |
| GET | `/api/admin/envios` | vista global con filtro por subcuenta |
| POST | `/api/admin/subcuentas/:locationId/relay` | activa el relay a una subcuenta y devuelve sus datos (misma forma que `GET /api/loc/relay`, incluido `servidor_activo`; contraseña en `contrasena` **una sola vez**) |
| GET/PUT | `/api/admin/ajustes` | credenciales GHL, shared secret, límites (secretos enmascarados al leer) |

### 5.4 Nodos de GHL — `src/routes/actions.js`
El `:secreto` es un segmento aleatorio fijo de la instalación (`settings.ghl.action_secret`).

| Método | Ruta | Uso |
|---|---|---|
| POST | `/api/ghl/accion/plantilla/:secreto` | ejecución del nodo 1 |
| POST | `/api/ghl/accion/personalizado/:secreto` | ejecución del nodo 2 |
| POST | `/api/ghl/dinamico/plantilla/:secreto` | campo Dynamic del nodo 1 |
| POST | `/api/ghl/dinamico/personalizado/:secreto` | campo Dynamic del nodo 2 |

**Campo Dynamic — respuesta.** Se recibe `{data, extras:{locationId}, meta}` y se devuelve:
```json
{ "inputs": [ { "section": "Envío", "fields": [
  { "key": "sender_id", "label": "Remitente", "type": "select", "required": true,
    "options": [ { "label": "Bibi <hola@bibi.com>", "value": "12" } ] },
  { "key": "template_id", "label": "Plantilla", "type": "select", "required": true,
    "options": [ { "label": "Bienvenida", "value": "4" } ] }
] } ] }
```
Las opciones se filtran **siempre** por `extras.locationId`. Si la subcuenta no existe o no tiene nada
configurado, se devuelve una opción informativa (`value:""`, label explicativo) en vez de un array vacío.

**Ejecución — nodo 1 (plantilla).** Campos: `provider_id` (select, *Alters Dynamic Field*),
`dynamic` (Dynamic → `sender_id` + `template_id`), `to_email`, `to_name`, `cc`, `bcc`, `reply_to`.
**Ejecución — nodo 2 (personalizado).** Campos: `provider_id` (select, *Alters Dynamic Field*),
`dynamic` (Dynamic → `sender_id`), `to_email`, `to_name`, `subject`, `preheader`, `cc`, `bcc`,
`reply_to`, `html` (textarea).

**Respuesta de ejecución** (se registra como *Response Data* en el marketplace para exponer variables):
```json
{ "ok": true, "message_id": "1042", "estado": "encolado" }
```
Errores de configuración → **400** con `{"ok":false,"error":"…"}` en español, para que se lea en el log
del workflow. Errores temporales → **503**, para que GHL reintente.

### 5.5 Webhooks y tracking — `src/routes/webhooks.js`, `src/routes/tracking.js`
| Método | Ruta | Notas |
|---|---|---|
| POST | `/api/webhooks/brevo/:token` | token por proveedor; acepta evento suelto **o** lote (array o objeto con un array) |
| GET | `/t/a/:token.gif` | pixel 1×1, `Cache-Control: no-store` |
| GET | `/t/c/:token` | redirige solo a la URL registrada en `message_links` |

---

## 6. El relay SMTP (la sección activable)

**Objetivo:** que el usuario pegue unos datos SMTP en GHL y use el **nodo nativo de email**, sin renunciar
a nada de lo anterior.

**Enrutado por remitente — es la regla central.** Da igual qué correo se configurara en los ajustes SMTP
de GHL: lo que manda es el `From` real del mensaje que llega. Al recibir un correo:

1. Se autentica la conexión SMTP → se obtiene el `location_id` de `relay_accounts`.
2. Se extrae el `From` y se busca en `senders` por `(location_id, email)`.
   - **Encontrado** → se usa `sender.provider_id`. Este es el caso normal.
3. Si no existe ese remitente exacto, se mira su **dominio**:
   - Si el dominio está verificado por **otra** subcuenta → **550** (único rechazo duro; protege a tus
     clientes entre sí).
   - Si el dominio es de esta subcuenta o de nadie → se sigue.
4. Si `accept_unknown_senders` está activo (por defecto **sí**): se **da de alta el remitente
   automáticamente** (`origin='auto'`, `verified_state='desconocido'`) apuntando al
   `default_provider_id` de la subcuenta, y se envía. Aparecerá en el panel para que el usuario le
   cambie el proveedor si quiere.
5. Si no hay proveedor por defecto configurado → **451** temporal con mensaje claro.
6. Antes de encolar: lista de supresión y límite de envíos de la subcuenta.

Es decir: **nunca se rechaza por usar un remitente distinto al configurado**. Se detecta y se enruta.

**Salvaguardas que sí se mantienen** (sin ellas el relay quema la IP y el dominio):
límite de tamaño de mensaje, límite de destinatarios, límite de envíos por subcuenta y minuto/día,
lista de supresión, cabeceras `List-Unsubscribe` + `List-Unsubscribe-Post`, y el rechazo del punto 3.
Además, el proveedor final (Brevo) rechazará por su cuenta los remitentes que no tenga verificados: ese
error se registra en `last_error` y se ve en el panel.

---

## 7. Interfaz de un proveedor — `src/lib/providers/`

Cada proveedor exporta el mismo objeto. Así son intercambiables y añadir uno nuevo no toca el worker.

```js
export default {
  tipo: 'brevo',                        // 'brevo' | 'smtp'
  camposCredenciales: [ … ],            // descriptor para pintar el formulario en el panel
  async validar(credenciales, config),  // → { ok, detalle, cuenta? }
  async enviar(ctx),                    // → { providerMessageId, aceptado }
  async listarRemitentes(cred),         // → [{email, name, verificado}] (opcional; null si no aplica)
}
```
`ctx` = `{ credenciales, config, de:{email,name}, para:[{email,name}], cc, bcc, replyTo, asunto,
html, texto, cabeceras, correlationId }`.
Los errores se normalizan a `Error` con `err.permanente = true|false`. El worker solo reintenta los
temporales (4xx SMTP, 429, red); los permanentes (5xx SMTP, credenciales, remitente rechazado) van
directos a `fallido`.

---

## 8. Variables de entorno

| Variable | Obligatoria | Def. | Para qué |
|---|---|---|---|
| `PORT` | no | `8080` | puerto HTTP |
| `DATABASE_URL` | **sí** | — | Postgres |
| `REDIS_URL` | **sí** | — | sesiones, locks y rate limit |
| `APP_BASE_URL` | **sí** | — | URL pública sin barra final (OAuth, tracking, webhooks) |
| `ENCRYPTION_KEY` | **sí** | — | 32 bytes en base64 o hex: cifra credenciales. Sin ella no arranca |
| `ADMIN_USER` / `ADMIN_PASS` | **sí** | — | login del panel de admin |
| `SMTP_RELAY_ENABLED` | no | `false` | levanta el servidor SMTP |
| `SMTP_RELAY_PORT` | no | `2525` | puerto del relay |
| `SMTP_RELAY_HOST` | no | `APP_BASE_URL` | host que se muestra al usuario para pegar en GHL |
| `SMTP_RELAY_TLS_CERT` / `_KEY` | no | — | rutas al certificado (si no, solo STARTTLS oportunista) |
| `SMTP_RELAY_MAX_SIZE` | no | `26214400` | tamaño máximo de mensaje |
| `ENVIO_LIMITE_MINUTO` / `_DIA` | no | `60` / `5000` | límites por subcuenta |
| `WORKER_CONCURRENCIA` | no | `5` | mensajes en paralelo |
| `WORKER_HABILITADO` | no | `true` | permite escalar workers aparte |

---

## 9. Pantallas del panel React

Ruta base `/` = panel de subcuenta (dentro del iframe), `/admin/*` = panel de admin.

**Subcuenta:** `Resumen` · `Proveedores` (alta SMTP/Brevo con formulario según `camposCredenciales`,
botón *Probar conexión*, sección de proveedores cedidos por el admin en solo lectura) ·
`Remitentes` (alta con correo y nombre, elección de proveedor, aviso de verificación de dominio) ·
`Plantillas` (asunto, preheader, editor HTML, vista previa y lista de variables) ·
`Envios` (tabla con filtros y detalle con el histórico de eventos) ·
`Relay` (interruptor de activación, datos SMTP para pegar en GHL con botón de copiar, contraseña
visible una sola vez, proveedor por defecto y explicación del enrutado por remitente) ·
`Dominios` (sin campo libre: la lista sale de los dominios de los remitentes — `dominios_remitentes`
del GET —, con estado por dominio [gratuito «no aplica» / sin verificar / pendiente con guía TXT en
3 pasos / verificado], botón de verificar/comprobar/quitar y sección de huérfanos sin remitente).

**Admin:** `Login` · `Subcuentas` · `ProveedoresAdmin` · `Asignaciones` · `RemitentesAdmin` ·
`PlantillasAdmin` · `EnviosAdmin` · `Ajustes`.

Componentes compartidos en `web/src/components/ui.jsx`:
`Boton, Campo, Select, Textarea, Interruptor, Modal, Tabla, Badge, Aviso, Spinner, Confirmar, Copiar`.

---

## 10. Convenciones

ESM en todo. Comentarios en español **solo** cuando explican una restricción no evidente (por qué el
lock, por qué el rango de estado, por qué el 550). Nada de secretos en logs ni en respuestas de la API:
las credenciales solo se devuelven como `{configurado:true}`. Toda entrada se valida (correo bien
formado, longitudes máximas, cabeceras sin saltos de línea — la inyección de cabeceras de correo se
corta escapando `\r` y `\n` en asunto, nombre y reply-to). SQL siempre parametrizado.

---

## 11. Tracking universal (independiente del proveedor)

Objetivo: saber entrega, apertura y clic de **todo** correo que salga por cualquiera de las tres vías,
sin depender de los webhooks/APIs de cada proveedor, sin dañar la entregabilidad y separando los
eventos reales de los automáticos (Apple MPP, proxys de Gmail, escáneres de seguridad). Los webhooks
de Brevo se mantienen como confirmación extra cuando existen, no como requisito.

### 11.1 Clasificación de eventos (reales vs automáticos)

Ya existe la base en `src/routes/tracking.js` (`esMaquinal`: user-agent + tiempo desde el envío).
Se completa así:

- **Columna nueva** `message_events.automatico boolean NOT NULL DEFAULT false` (migración 002).
  El dato deja de vivir solo en `data` jsonb para poder agregarse en SQL.
- Señales de evento automático (cualquiera basta): user-agent de proxy/escáner conocido
  (Apple MPP/CFNetwork, GoogleImageProxy solo para CLICS no para aperturas — el proxy de imágenes de
  Gmail descarga el pixel cuando el usuario abre de verdad, así que como apertura cuenta REAL con IP
  oculta —, SafeLinks/Defender, Barracuda, Mimecast, ahrefs/curl/python/bots), apertura a menos de
  `TRACKING_SEGUNDOS_MINIMOS` (def. 10 s) del envío, clic por HEAD, y ráfaga de clics sobre varios
  enlaces distintos del mismo mensaje en menos de 5 s.
- **Un clic real convalida la apertura**: al registrar un clic no automático, si el mensaje no tiene
  apertura real, se inserta también el evento de apertura con `data.fuente='clic'`.
- `messages.opened_at` y `clicked_at` pasan a reflejar **solo eventos reales**. Los automáticos quedan
  en `message_events` para auditoría.
- **Todo evento real (apertura o clic) es prueba de entrega**: si `status_rank < 30` se promociona el
  mensaje a `entregado` con un evento `entrega_confirmada` (`data.fuente='pixel'|'clic'`).
- Panel: `Envios` muestra aperturas/clics reales y, en el detalle, los automáticos marcados con badge
  gris «automático». `Resumen` agrega solo los reales.

### 11.2 Entrega sin proveedor: VERP + captura de rebotes

Con SMTP genérico la única vía independiente del proveedor es capturar los rebotes uno mismo:

- Variable nueva `SMTP_BOUNCE_DOMAIN` (ej. `rebotes.tudominio.com`). Si está definida y el proveedor
  es de tipo `smtp`, el envío sale con **Return-Path propio (VERP)**:
  `envelope.from = b.<correlation_id>@<SMTP_BOUNCE_DOMAIN>`. El `From` visible no cambia.
  (Con Brevo no aplica: gestiona sus rebotes y los manda por webhook.)
- El **mismo servidor SMTP del relay** acepta esos avisos: se admite conexión **sin autenticar** SOLO
  cuando TODOS los RCPT casan con `b.<correlation_id>@<SMTP_BOUNCE_DOMAIN>` y el `correlation_id`
  existe; cualquier otro RCPT sin autenticar se rechaza con 550 (el servidor no se convierte en
  buzón abierto ni en relay). Requiere publicar el **MX** del subdominio de rebotes apuntando al host
  del relay y el puerto 25 accesible (documentar en DEPLOY.md con honestidad: muchos hostings
  bloquean el 25; si no se puede, esta pieza queda apagada y no pasa nada).
- El DSN entrante (RFC 3464) se parsea con mailparser: `Status: 5.x.x` = rebote duro →
  `rebotado` + alta en `suppressions`; `4.x.x` = blando → evento `rebote_blando` (el estado no
  retrocede; si el mensaje estaba `enviado` pasa a `diferido`). Un correo a `b.<corr>@…` que no sea un
  DSN válido se registra como `rebote_desconocido` sin tocar el estado.
- **Entrega inferida**: el reconciliador del worker promociona `enviado` → `entregado` con evento
  `entrega_inferida` (`data.inferido=true`) cuando pasan `INFERENCIA_ENTREGA_HORAS` (def. 48) sin
  rebote ni spam. El panel la muestra como «entregado (inferido)» — nunca se vende como confirmada.

### 11.3 Dominio de tracking por subcuenta (CNAME)

El riesgo real de entregabilidad no es el pixel: es que todos los clientes compartan el dominio de
los enlaces. Solución estándar (branded tracking domain):

- Tabla nueva `tracking_domains` (migración 002): `id`, `location_id UNIQUE`, `domain UNIQUE`,
  `verified`, `verify_token`, `verified_at`, `created_at`. Un dominio por subcuenta.
- Verificación por **CNAME**: el cliente crea `link.sudominio.com → <host de la app>`; la app lo
  comprueba con `dns.resolveCname` y marca `verified`.
- `urlPixel`/`urlClic`/`urlBaja` de `src/lib/tracking.js` aceptan un dominio opcional; el worker
  resuelve el dominio verificado de la subcuenta (una consulta cacheada) y lo pasa a
  `componerMensaje` en `opciones.dominioTracking`. Sin dominio verificado → `APP_BASE_URL` como hasta
  ahora. Las rutas `/t/*` responden igual llegue el host que llegue.
- Endpoints en 5.2 (`requireLocation`): `GET/POST /api/loc/dominios-tracking`,
  `POST /api/loc/dominios-tracking/:id/verificar`, `DELETE /api/loc/dominios-tracking/:id`.
  Pantalla: sección nueva en `Dominios` con el CNAME a crear y el botón de verificar.
- DEPLOY.md documenta el alta del dominio del cliente en EasyPanel (necesario para que Traefik emita
  su certificado) y GHL-SETUP/README avisan de **desactivar el tracking propio de Brevo** para no
  reescribir los enlaces dos veces.

### 11.4 Reglas que protegen la entregabilidad

No se reescriben `mailto:` ni los enlaces de baja (ya excluidos en `render.js`). Siempre se genera
versión en texto plano. El pixel va al final del cuerpo, uno solo. Nada de acortadores externos. El
texto visible de un enlace nunca se sustituye por la URL de tracking (solo cambia el `href`). Estas
reglas ya están en `render.js`; esta sección existe para que nadie las "optimice" quitándolas.

### 11.5 Variables de entorno nuevas

| Variable | Obligatoria | Def. | Para qué |
|---|---|---|---|
| `SMTP_BOUNCE_DOMAIN` | no | — | activa VERP y la captura de rebotes |
| `INFERENCIA_ENTREGA_HORAS` | no | `48` | horas sin rebote para marcar entrega inferida |
| `TRACKING_SEGUNDOS_MINIMOS` | no | `10` | apertura antes de este umbral = automática |

---

## 12. Sección «Rebotados» (limpieza de la base de datos en GHL)

Los rebotes duros capturados (§11.2) dejan de ser solo un estado: se convierten en acciones sobre el
contacto de GHL. Pantalla nueva del panel de subcuenta: **Rebotados**.

### 12.1 Origen de los datos

La sección lee `suppressions` con `reason='rebote_duro'` (migración 003 añade `ghl_contact_id`,
`dnd_at`, `dnd_error` y la tabla `location_settings` con `auto_dnd`). Ahí cae todo correo inexistente
o no conseguido por cualquiera de las vías: webhook `hard_bounce` de Brevo, DSN duro por VERP, y
**además** (pieza nueva) el rechazo permanente del destinatario en el momento del envío: cuando el
worker recibe un error permanente cuyo detalle indica rechazo del RCPT (5xx sobre el destinatario,
`err.rejected` de nodemailer), da de alta la supresión `rebote_duro` con `source='envio'`.
Al crear la supresión se guarda `ghl_contact_id` si el mensaje lo traía (`messages.ghl_contact_id`).

### 12.2 Integración con contactos de GHL

- **Scopes**: `DEFAULT_SCOPES` de `src/lib/ghl.js` pasa a incluir `contacts.readonly` y
  `contacts.write`. GHL-SETUP.md lo refleja y avisa: si la app ya estaba instalada, hay que
  reinstalarla para que el token traiga los scopes nuevos.
- **Resolución del contacto**: si la supresión no tiene `ghl_contact_id` (p. ej. vino del relay), se
  resuelve por email contra la API de contactos usando la conexión de la subcuenta
  (`GET /contacts/search/duplicate?locationId=…&email=…`; si ese endpoint no estuviera disponible,
  `POST /contacts/search` filtrando por email — verificar en el primer despliegue cuál responde).
  El id resuelto se guarda en la supresión para no volver a buscarlo.
- **DND**: se activa el DND del **canal Email** (`PUT /contacts/{id}` con
  `dndSettings.Email.status='active'`), **no** el DND global: el cliente puede seguir mandándole SMS
  o llamándole; lo que está roto es el correo. La pantalla lo explica. Éxito → `dnd_at=now()`,
  `dnd_error=NULL`; fallo → `dnd_error` con el motivo.
- **Ficha**: enlace `https://app.gohighlevel.com/v2/location/<locationId>/contacts/detail/<contactId>`
  abierto en pestaña nueva.

### 12.3 Contrato HTTP (todas bajo `requireLocation`, en `src/routes/location.js`)

| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/loc/rebotados` | filtros `q`, `dnd` (`todos\|con\|sin`), `desde`, `hasta`; paginado. Cada fila: `{id, email, created_at, source, ghl_contact_id, dnd_at, dnd_error, ultimo_mensaje:{id, subject, sent_at}}` |
| POST | `/api/loc/rebotados/:id/dnd` | activa el DND de ese contacto (resolviendo el id por email si falta) → `{ok, dnd_at}` o `{ok:false, error}` |
| POST | `/api/loc/rebotados/dnd-masivo` | procesa hasta 100 supresiones sin `dnd_at` por llamada, con pausa entre llamadas a GHL para respetar su rate limit → `{procesados, correctos, fallidos, restantes}`; el panel repite mientras `restantes > 0` |
| GET | `/api/loc/rebotados/exportar` | CSV UTF-8 **con BOM** (Excel lo abre con acentos bien): `email, motivo, fecha, contacto_ghl, dnd, ultimo_asunto`. Pensado para reimportar en GHL |
| GET/PATCH | `/api/loc/preferencias` | `{auto_dnd}` |

### 12.4 Auto-DND

Con `location_settings.auto_dnd` activo, cada alta de supresión `rebote_duro` dispara el DND del
contacto **de forma asíncrona después de responder** (el webhook/DSN nunca espera a GHL). El
resultado queda en `dnd_at`/`dnd_error` y como evento en el histórico del mensaje. Si la subcuenta
no tiene conexión OAuth viva, se registra el error y la fila queda pendiente para el botón masivo.

### 12.5 Pantalla

`Rebotados.jsx` (ruta `/rebotados`, entrada en el menú de subcuenta): interruptor de auto-DND arriba
con explicación llana; botón «Activar DND a todos los pendientes» (muestra progreso con `restantes`);
botón «Descargar CSV»; tabla con email, fecha, motivo (`source`), badge de DND (verde con fecha /
gris pendiente / rojo con error), botón «Ficha en GHL» y botón «Activar DND» por fila.
`App.jsx` y `Layout.jsx` añaden la ruta y la entrada de menú. `api.js` añade las funciones.

---

## 13. Relay sin fricción: certificado TLS automático y doble puerto

Contexto real: la app ya está desplegada en `https://ddemail.escaladoacelerado.es` y funciona dentro
de GHL. El relay estaba apagado porque la guía exigía conseguir un certificado a mano (DNS-01,
volúmenes, sidecar). Esta sección elimina esa fricción: **el relay obtiene y renueva solo su
certificado Let's Encrypt** para el host del relay, sin tocar nada a mano.

**Hecho comprobado en el despliegue real (EasyPanel):** el reto ACME HTTP-01 lanzado desde la app
**no funciona** detrás de Traefik con ACME. Traefik atiende el puerto 80 y su propio manejador ACME
captura `/.well-known/acme-challenge/` para **todos** los hosts (responde `404` vacío, sin
`Content-Type`) con prioridad máxima, antes de enrutar nada a la app; dar de alta el host en
*Domains* no lo cambia. Let's Encrypt valida HTTP-01 por el 80, así que la validación falla siempre.
Por eso el modo principal es **leer el certificado que Traefik ya tiene** para ese host; el HTTP-01
propio queda como ruta genérica para despliegues sin un proxy con ACME delante.

### 13.1 Origen del certificado: ficheros > Traefik > ACME propio > autofirmado

**Modo `traefik` (el de EasyPanel, recomendado).** Traefik emite y renueva solo el certificado de
cada dominio dado de alta en *Domains* y lo guarda en su `acme.json` (en el VPS, normalmente
`/etc/easypanel/traefik/acme.json`; se comprueba en D). Con ese fichero montado en el contenedor en
solo lectura y `SMTP_RELAY_TRAEFIK_ACME=/certs/acme.json`, la app lee de ahí el certificado del host
del relay y **nunca llama a la CA**.

- Módulo `src/lib/traefik.js`:
  - `leerCertificadoTraefik(ruta, hostname)` → `{ key, cert, expiresAt, resolver, origen: 'traefik' }`.
    Parsea el JSON (Traefik v2/v3: `<resolver>.Certificates[].domain.main/sans`, `certificate` y
    `key` en base64; se admite también la forma v1), casa el host (incluidos comodines de una
    etiqueta), valida clave+certificado y se queda con el que más dura. Lanza con un mensaje apto
    para el panel (fichero ausente = revisar el Mount, host ausente = darlo de alta en *Domains*,
    JSON roto, certificado caducado…). Jamás registra el contenido del fichero (lleva la clave de
    la cuenta ACME de Traefik).
  - `vigilarCertificadoTraefik({ log, alCambiar })`: lectura inmediata, relectura cuando el fichero
    cambia (`fs.watch` sobre el directorio, con espera de 3 s) y comprobación cada 12 h (cada 5 min
    mientras no haya certificado utilizable). Llama a `alCambiar(certificado)` solo cuando cambia
    la huella; si quien aplica devuelve `{ aplicado:false }` lo reintenta en la siguiente vuelta.
    Exporta también `comprobarCertificadoTraefik({ forzar })`, `detenerVigilanciaTraefik()` y
    `estadoTraefik()` → `{ configurado, ruta, hostname, ultima_lectura, ultimo_error, valido_hasta, resolver }`.

**Modo `acme` (HTTP-01 desde la app).** Solo para despliegues en los que el puerto 80 del host
entrega la petición del reto a la app (proxy sin ACME, o sin proxy).

- Dependencia: `acme-client`.
- Host del certificado: `SMTP_RELAY_HOST` (por defecto el hostname de `APP_BASE_URL`).
- Ruta HTTP `GET /.well-known/acme-challenge/:token` en `src/routes/acme.js`, registrada en
  `index.js` **antes** del estático y del fallback SPA. Lee el `keyAuthorization` de Redis
  (`acme:challenge:<token>`, TTL 10 min); 404 **con texto y `Content-Type`** si no existe (esa firma
  es la que distingue a la app de un proxy que captura la ruta).
- Módulo `src/lib/acme.js`:
  - `asegurarCertificado(hostname, { log, forzar })` → `{ key, cert, expiresAt, origen }`. Si en
    `tls_certificates` hay un certificado con más de 30 días de vida, lo devuelve; si no, emite o
    renueva contra Let's Encrypt (directorio de producción; `ACME_DIRECTORY` permite staging para
    pruebas; `ACME_EMAIL` opcional como contacto). Serializado con lock Redis `acme:lock:<host>`
    (TTL 5 min) para que dos instancias no emitan a la vez. Guarda claves cifradas con `lib/crypto`,
    `issued_at`, `expires_at`; ante fallo guarda `last_error` + `last_attempt_at` y **no** lanza:
    devuelve `null` para que el relay arranque igualmente con autofirmado.
    `motivoSinCertificado(hostname)` → `'host'|'cuota'|'lock'|'error'|'fallo'|null` explica el
    último `null`.
  - **Autocomprobación del reto antes de pedir la validación:** la app pide su propia URL del reto.
    Si obtiene la firma del ACME de Traefik (404 vacío sin `Content-Type`) **aborta antes de
    `completeChallenge`** (no gasta validaciones fallidas de LE) y deja en `last_error` el motivo
    real («el puerto 80 de `<host>` lo atiende el ACME de Traefik: usa el modo traefik»). Cualquier
    otro fallo de la autocomprobación (timeout, DNS) es solo informativo, porque puede ser del
    contenedor y no de lo que verá la CA.
  - Clave de cuenta ACME: se reutiliza siempre; si la guardada no se puede descifrar
    (`ENCRYPTION_KEY` rotada sin la vieja) se **reemplaza** en vez de conservarla, para no crear una
    cuenta nueva en LE en cada emisión.
  - `estadoCertificado(hostname)` → `{ hostname, valido: bool, issued_at, expires_at, last_error,
    last_attempt_at, dias_restantes, emitiendo }`.
  - `programarRenovacion({ log, alRenovar })`: comprobación cada 12 h; renueva si quedan < 30 días
    y llama a `alRenovar({ key, cert })`. Sin certificado se comprueba cada hora, salvo que el
    motivo sea el lock de otra instancia (o uno huérfano de un redespliegue a mitad de emisión):
    entonces en cuanto el lock caduca (5 min + 30 s). Exporta también `detenerRenovacion()`.
  - Anti-abuso de Let's Encrypt: no reintentar más de una vez por hora tras un error
    (`last_attempt_at`), para no agotar las cuotas de LE en bucle.

**Común a los dos modos.**

- Precedencia en el relay: ficheros `SMTP_RELAY_TLS_CERT/_KEY` (manual) > Traefik
  (`SMTP_RELAY_TRAEFIK_ACME`) > ACME propio (`SMTP_RELAY_TLS_AUTO`, **por defecto true**) >
  autofirmado de smtp-server. Con `SMTP_RELAY_TRAEFIK_ACME` definido no se intenta ACME aunque
  `SMTP_RELAY_TLS_AUTO` sea true. Toda la configuración del relay sale de `config.relay`
  (`src/config.js`): la pasarela y el panel leen el mismo objeto y no pueden discrepar.
- Arranque **no bloqueante**: el relay levanta al instante con lo que tenga (ficheros o
  autofirmado); `src/index.js` lanza en segundo plano la vigilancia de Traefik o
  `asegurarCertificado`, y cuando llega el certificado lo aplica en caliente con
  `actualizarCertificado({ key, cert, expiresAt, origen })` → `server.updateSecureContext` de
  smtp-server en **todas** las escuchas. El log lo dice claro: `relay: certificado de Traefik
  aplicado, válido hasta …` / `relay: certificado ACME aplicado, válido hasta …`. Solo se gestiona
  el certificado si la pasarela abrió al menos un puerto.
- Un certificado rechazado (inválido, caducado) **no** pisa el estado del que ya está en servicio:
  queda en `tls.ultimo_rechazo` y `tls.error` sigue en `null` mientras sirva uno real.

### 13.2 Doble puerto y puertos públicos

GHL documenta 587 (TLS/STARTTLS) y 465 (SSL). Se ofrecen los dos:

| Variable | Def. | Para qué |
|---|---|---|
| `SMTP_RELAY_PORT` | `2525` | escucha STARTTLS dentro del contenedor |
| `SMTP_RELAY_PORT_SSL` | `2465` | escucha TLS implícito (secure) dentro del contenedor; sin definir = 2465; vacía o `0/false/no/off` = no se levanta |
| `SMTP_RELAY_PUBLIC_PORT` | `587` | puerto que EasyPanel publica hacia `SMTP_RELAY_PORT` y que el panel enseña al cliente |
| `SMTP_RELAY_PUBLIC_PORT_SSL` | `465` | idem para el SSL |
| `SMTP_RELAY_TRAEFIK_ACME` | — | modo traefik: ruta del `acme.json` de Traefik dentro del contenedor (`/certs/acme.json`) |
| `SMTP_RELAY_TLS_AUTO` | `true` | emitir certificado por ACME HTTP-01 desde la app (solo sin modo traefik) |
| `ACME_EMAIL` | — | contacto opcional de la cuenta ACME |
| `ACME_DIRECTORY` | LE producción | URL del directorio ACME (staging para pruebas) |

Las escuchas internas son puertos altos a propósito: el contenedor no necesita privilegios para
abrirlos y EasyPanel los publica como `587 → 2525` y `465 → 2465` (TCP). Ambas escuchas comparten
auth, handler, límites y certificado. `estadoRelay()` del relay devuelve
`{ activo, host, puertos: { starttls, ssl }, tls: { modo: 'acme'|'traefik'|'ficheros'|'autofirmado',
valido_hasta, error, ultimo_rechazo, hostname } }`; los puertos son los **públicos**, y `ssl` es
`null` si la escucha SSL no está configurada o no llegó a abrirse. `SMTP_RELAY_ENABLED` admite los
mismos verdaderos que el resto de booleanos (`1/true/si/yes/on`).

### 13.3 Contrato HTTP nuevo

| Método | Ruta | Auth | Notas |
|---|---|---|---|
| GET | `/.well-known/acme-challenge/:token` | — | reto HTTP-01 |
| GET | `/api/admin/relay` | admin | `{ relay, certificado, traefik }`: `estadoRelay()` + `puertos_internos { starttls, ssl }` + `origen_certificado` (`'ficheros'|'traefik'|'acme'|'ninguno'`); `certificado` = `estadoCertificado()` solo con ACME propio; `traefik` = `estadoTraefik()` solo en modo traefik. `relay.tls.error` se completa con el motivo del módulo que obtiene el certificado |
| POST | `/api/admin/relay/certificado` | admin | modo traefik: relee el `acme.json` y aplica → `{ ok, aplicado, detalle, mensaje, traefik, relay }`. ACME propio: fuerza emisión/renovación (respeta lock y cuota de 1/h; la renovación forzada de un certificado con ≥ 30 días exige 48 h desde su emisión y un freno `acme:forzado:<host>` de 1 h en Redis, por el límite de 5 duplicados/semana de LE) → `{ ok, estado, aplicado, detalle, relay }`. Con ficheros o sin origen → `{ ok:false, error }` sin tocar la CA. `aplicado:false` + `detalle` cuando se obtuvo pero la pasarela de esta instancia no lo aplicó |

`GET /api/loc/relay` añade `puerto_ssl`, `tls_ok` (bool), `tls_valido_hasta`, `tls_modo` y
`tls_error`; `port` pasa a ser el **público** (`SMTP_RELAY_PUBLIC_PORT`), nunca el interno.
`servidor_activo` refleja si la pasarela de esta instancia tiene escuchas abiertas de verdad (un
relay habilitado que no pudo abrir puertos se enseña como apagado); solo sin pasarela cargada se
recurre a la configuración.

### 13.4 Pantallas

- `Relay.jsx`: enseña host, **dos** puertos con su etiqueta («587 · TLS/STARTTLS» y «465 · SSL», el
  segundo solo si está configurado), usuario y contraseña como hasta ahora, y un badge de
  certificado: verde «TLS válido hasta …», ámbar «certificado en emisión, espera un minuto», rojo
  con el error. El aviso superior distingue: relay apagado a nivel de plataforma / encendido pero
  certificado pendiente / todo correcto. Las instrucciones para GHL ya con los puertos públicos.
- `Ajustes.jsx` (admin): tarjeta «Relay SMTP y certificado» con el estado completo: origen del
  certificado, modo TLS en servicio, puertos públicos y escuchas internas por separado, último
  error (y, aparte, el último certificado rechazado si el que sirve sigue bien), y el botón
  «Emitir / renovar ahora» («Releer de Traefik ahora» en modo traefik; deshabilitado con ficheros).
  Si la respuesta trae `aplicado:false`, aviso ámbar con `detalle` en vez del verde.

### 13.5 Guía de despliegue (sección D de DEPLOY.md, reescrita)

Sigue siendo corta: (1) comprobar en el VPS la ruta del `acme.json` de Traefik y que contiene el
host de la app; (2) EasyPanel → servicio `emails` → **Mounts**: bind mount de solo lectura de ese
directorio a `/certs`; (3) variables `SMTP_RELAY_ENABLED=true`, `SMTP_RELAY_TRAEFIK_ACME=/certs/acme.json`,
`SMTP_RELAY_PORT_SSL=2465`; (4) **Ports**: `587 → 2525` TCP y `465 → 2465` TCP; (5) comprobar con el
proveedor del VPS que 587/465 no están bloqueados; (6) redesplegar y ver en Ajustes cómo el
certificado pasa a «válido»; (7) verificar desde fuera con `openssl s_client -starttls smtp -connect
host:587` y `Verify return code: 0 (ok)`. El HTTP-01 propio queda documentado como alternativa para
despliegues sin Traefik/ACME delante; el DNS-01 con ficheros, para un host que no enrute a este
servidor. **No se activa `SMTP_RELAY_ENABLED` en EasyPanel sin `SMTP_RELAY_TRAEFIK_ACME`** (o
ficheros): con ACME propio el relay se quedaría con el autofirmado que GHL rechaza.


---

## 14. Buzón (correo entrante por IMAP)

Sección nueva del panel de subcuenta, **Buzón**, tipo Gmail: la app trae por IMAP el correo de una o
varias cuentas del cliente, lo guarda, lo muestra en hilos y permite responder desde ahí usando los
remitentes/proveedores que ya existen. Con cuota de espacio por subcuenta para no saturar el VPS.

### 14.1 Decisiones
- **IMAP, no POP3**: mantiene el correo en el servidor y sincroniza estado. Al configurar se elige
  «dejar copia en el servidor» (por defecto) o «borrar del servidor tras traerlo» (`delete_after_import`).
- **Adjuntos en Postgres** (`inbox_attachments.content bytea`) para no depender de volúmenes; la cuota
  lo hace sostenible. El mensaje crudo NO se guarda: solo cuerpo parseado + adjuntos + `size_bytes`.
- **Responder** = encolar en `messages` con `origin='buzon'`, `In-Reply-To`/`References` en
  `extra_headers`, `thread_key` e `inbox_reply_to_id`; sale por `mailboxes.reply_sender_id` (o el
  remitente por defecto de la subcuenta). Sin configuración SMTP aparte. `render.js`/proveedores
  deben propagar `extra_headers` como cabeceras del correo.
- **Cuota**: `location_settings.buzon_quota_mb` (NULL = `settings.limites.buzon_quota_mb`, def. 200).
  `buzon_used_bytes` es un contador cacheado (suma de `size_bytes` de mensajes + adjuntos) que se
  actualiza al insertar/borrar. Si un mensaje no cabe, la sincronización se detiene, el buzón pasa a
  `cuota_llena` y el panel lo avisa; al borrar correo vuelve a arrancar sola.
- Dependencias nuevas: `imapflow` (cliente IMAP) y `sanitize-html` (sin scripts/formularios;
  imágenes remotas bloqueadas hasta que el usuario pulse «cargar imágenes»).

### 14.2 Sincronización — `src/lib/buzon-sync.js`
Bucle en el worker (cada 60 s revisa buzones `enabled` cuyo `last_sync_at` sea más antiguo que su
`sync_interval_min`). Por buzón: conectar (TLS según `secure`), abrir `folder`; si cambia
`UIDVALIDITY` → `last_uid=0`; buscar `uid > last_uid`; para cada UID: descargar el mensaje crudo,
`simpleParser`, calcular `size_bytes`, comprobar cuota, insertar mensaje + adjuntos (dedupe por
`(mailbox_id, uid)` y por `message_id` dentro de la subcuenta), `thread_key` = primer id de
`References` o el propio `Message-ID`, actualizar `last_uid`; si `delete_after_import` → marcar
`\Deleted` + expunge. Errores → `status='error'` + `last_error` sin tumbar el worker. Lock por buzón
en Redis para que dos instancias no sincronicen el mismo. Un botón «Sincronizar ahora» fuerza una
pasada. Exporta `arrancarSyncBuzon(log)` / `pararSyncBuzon()` y `sincronizarBuzon(id, {log})`.

### 14.3 Contrato HTTP (todas bajo `requireLocation`, `src/routes/buzon.js`)
| Método | Ruta | Notas |
|---|---|---|
| GET/POST/PATCH/DELETE | `/api/loc/buzon/cuentas[/:id]` | CRUD de `mailboxes`; la contraseña nunca se devuelve (`configurado:true`) |
| POST | `/api/loc/buzon/cuentas/:id/probar` | conecta y abre la carpeta → `{ok, detalle, mensajes_en_servidor}` |
| POST | `/api/loc/buzon/cuentas/:id/sincronizar` | fuerza sincronización → `{ok, nuevos, detalle}` |
| GET | `/api/loc/buzon/mensajes` | filtros `cuenta`, `q`, `no_leidos`, `desde`, `hasta`; paginado; cada fila: id, from, subject, date, snippet, size_bytes, has_attachments, is_read, thread_key, respuestas (nº de envíos nuestros en el hilo) |
| GET | `/api/loc/buzon/mensajes/:id` | mensaje completo + adjuntos (metadatos) + hilo: recibidos y enviados (`messages` con el mismo `thread_key`) ordenados por fecha; marca `is_read=true` |
| PATCH | `/api/loc/buzon/mensajes/:id` | `{is_read}` |
| DELETE | `/api/loc/buzon/mensajes/:id?servidor=1` | borra en la app (y adjuntos, descontando cuota); con `servidor=1` también en IMAP si el UID sigue existiendo |
| GET | `/api/loc/buzon/adjuntos/:id` | descarga con `Content-Disposition`; comprueba que el mensaje es de la subcuenta |
| POST | `/api/loc/buzon/mensajes/:id/responder` | `{html, text, sender_id?, todos:boolean, cc, bcc}` → encola con cabeceras de hilo, asunto `Re: …`, cita del original al final |
| POST | `/api/loc/buzon/mensajes/:id/reenviar` | `{to, html, text, sender_id?}` → asunto `Fwd: …` (sin adjuntos en v1: se avisa en la UI) |
| GET | `/api/loc/buzon/espacio` | `{usado_bytes, cuota_mb, porcentaje, por_cuenta:[…]}` |

Admin (`requireAdmin`, en `src/routes/admin.js`): `GET /api/admin/buzon/espacio` (uso y cuota de todas
las subcuentas), `PATCH /api/admin/subcuentas/:locationId/buzon` `{quota_mb|null}`, y el valor por
defecto `buzon_quota_mb` dentro de `PUT /api/admin/ajustes` (`limites`).

### 14.4 Pantallas
- `Buzon.jsx` (ruta `/buzon`, entrada de menú «Buzón» con contador de no leídos): tres columnas —
  cuentas/carpetas (Bandeja, No leídos, Enviados desde el buzón) · lista (remitente, asunto, snippet,
  fecha, **tamaño**, clip si hay adjuntos, negrita si no leído; búsqueda y paginación) · detalle con
  el hilo (recibidos y nuestras respuestas con su estado de entrega), HTML en `<iframe sandbox>` con
  imágenes bloqueadas por defecto, adjuntos descargables, botones Responder / Responder a todos /
  Reenviar / Borrar (con opción «también del servidor»). Barra superior de espacio «X MB de Y MB».
- **Engranaje** ⚙ en la cabecera de Buzón: modal con la lista de cuentas y el formulario
  (nombre, correo, servidor IMAP, puerto, TLS, usuario, contraseña, carpeta, «Qué hacer tras traer el
  correo: dejar copia / borrar del servidor», cada cuántos minutos, remitente para responder),
  botones Probar conexión y Sincronizar ahora, estado y último error. Ayuda corta: Gmail y Outlook
  exigen «contraseña de aplicación» con verificación en dos pasos.
- Admin: en `Subcuentas.jsx` columna «Buzón: usado / cuota» con edición de la cuota; en `Ajustes.jsx`
  el valor por defecto.

### 14.5 Seguridad y límites
Credenciales IMAP cifradas como las de proveedores; nunca en logs. Tamaño máximo por mensaje
`BUZON_MAX_MENSAJE_MB` (def. 25): los que lo superen se guardan sin adjuntos y con aviso. Los
adjuntos se sirven con `Content-Type` real pero `X-Content-Type-Options: nosniff` y como descarga.
El HTML se sanea en servidor antes de guardarlo. Las respuestas pasan por la lista de supresión y los
límites de envío como cualquier otro correo.
