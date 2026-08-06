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
| GET/POST | `/api/loc/dominios` | alta de dominio + token DNS; `POST /:id/verificar` comprueba el TXT |
| GET | `/api/loc/relay` | `{enabled, host, port, username, tiene_password, default_provider_id, accept_unknown_senders}` |
| POST | `/api/loc/relay/activar` | activa la sección y genera credenciales; devuelve la contraseña **una sola vez** |
| POST | `/api/loc/relay/rotar` | regenera la contraseña; devuelve la nueva **una sola vez** |
| PATCH | `/api/loc/relay` | `{enabled, default_provider_id, accept_unknown_senders}` |

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
| POST | `/api/admin/subcuentas/:locationId/relay` | activa el relay a una subcuenta y devuelve sus datos |
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
`Dominios` (alta, TXT a publicar, botón de verificar).

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
