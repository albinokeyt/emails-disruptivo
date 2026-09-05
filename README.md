# Emails Disruptivo

App del marketplace de **GoHighLevel** que da a cada subcuenta su propio motor de correo saliente:
registra **proveedores** (SMTP o Brevo por API), da de alta **remitentes**, guarda **plantillas** y
envía desde los workflows por **tres vías distintas que conviven**. Las tres escriben en la misma
tabla `messages`, así que el historial de envíos, los rebotes y el estado de entrega son **uno solo**,
venga el correo de donde venga.

Se instala por subcuenta y aparece sola en el menú lateral (módulo *Custom Pages* de la app del
marketplace). El **admin de la agencia** tiene además su propio panel: registra proveedores de
agencia, se los cede a las subcuentas que quiera, y crea remitentes y plantillas para cualquiera.

> Guías: **[DEPLOY.md](DEPLOY.md)** (EasyPanel paso a paso) · **[GHL-SETUP.md](GHL-SETUP.md)** (crear
> la app y los nodos en el marketplace) · **[SPEC.md](SPEC.md)** (contratos, tablas y rutas: manda
> sobre todo lo demás) · **[INVESTIGACION.md](INVESTIGACION.md)** (detalle literal de las APIs).

---

## Las tres vías de envío

```
   GHL · Workflow de la subcuenta                     Emails Disruptivo
 ─────────────────────────────────────      ───────────────────────────────────────

 (1) Nodo «Enviar email con plantilla»  ──POST──▶  /api/ghl/accion/plantilla/:secreto ─┐
     proveedor + remitente + plantilla                                                 │
                                                                                       │
 (2) Nodo «Enviar email personalizado» ──POST──▶  /api/ghl/accion/personalizado/:secr ─┤
     asunto, preheader, CC/BCC, HTML a mano                                            │
                                                                                       │
 (3) Nodo NATIVO de email de GHL       ──SMTP─▶ relay :587/465 (AUTH ▸ From ▸ sender) ─┤
     con los datos SMTP del relay pegados                                              │
     en Settings › Email Services                                                      ▼
                                                                            ┌──────────────────┐
                                                                            │ messages         │
                                                                            │ (encolado)       │
                                                                            └────────┬─────────┘
                                                                                     │ worker
                                                     Brevo API  /  SMTP saliente ◀────┘
                                                            │
   panel « Envíos »  ◀── message_events ◀── /api/webhooks/brevo/:token  ·  /t/a · /t/c
```

**1. Nodo propio «Enviar email con plantilla».** En el workflow eliges proveedor, remitente y
plantilla de la subcuenta. El asunto y el cuerpo salen de `templates`.

**2. Nodo propio «Enviar email personalizado».** En el workflow escribes asunto, preheader, CC, BCC,
reply-to y cuerpo HTML a mano. Admite los merge fields de GHL (`{{contact.first_name}}`, etc.): GHL
los resuelve **antes** de llamarnos, así que nos llega el texto ya interpolado.

**3. Relay SMTP (sección activable).** La app te da un host, dos puertos (`587` con TLS/STARTTLS y
`465` con SSL), un usuario y una contraseña que pegas en *Settings › Email Services › SMTP Service*
de la subcuenta. A partir de ahí usas el **nodo nativo de email de GHL** y el correo entra por
nuestro servidor SMTP, que lo enruta y lo envía por el proveedor que corresponda. El certificado
TLS de ese host lo lee la app del `acme.json` de Traefik, que ya lo emite y renueva (sin Traefik
delante, lo pide ella misma a Let's Encrypt por ACME HTTP-01): encender el relay son unos pocos
pasos ([DEPLOY.md](DEPLOY.md), sección D).

### El enrutado del relay va por el remitente, no por lo que configuraste en GHL

Da igual qué dirección pusieras en los ajustes SMTP de GHL: manda el `From` real del mensaje.

1. Se autentica la conexión SMTP y se obtiene el `location_id` de `relay_accounts`.
2. Se busca el `From` en `senders` por `(location_id, email)`. Si está, se usa su `provider_id`.
   Este es el caso normal.
3. Si no está, se mira el **dominio**. Si ese dominio está **verificado por otra subcuenta**, se
   responde **550**. Es el único rechazo duro que hay, y existe para que un cliente no pueda enviar
   desde el dominio verificado de otro.
4. Si el dominio es de esta subcuenta o de nadie, y `accept_unknown_senders` está activo (por
   defecto **sí**), se **da de alta el remitente automáticamente** (`origin='auto'`,
   `verified_state='desconocido'`) apuntando al `default_provider_id` de la subcuenta, y se envía.
   Aparece luego en el panel para que el usuario le cambie el proveedor si quiere.
5. Si no hay proveedor por defecto configurado, se responde **451** (temporal) con un mensaje claro.
6. Antes de encolar se comprueban la lista de supresión y los límites de envío de la subcuenta.

Es decir: **nunca se rechaza por usar un remitente distinto al configurado**; se detecta y se enruta.
Lo que sí se mantiene siempre: límite de tamaño del mensaje, límite de destinatarios, límites por
minuto y por día, lista de supresión y cabeceras `List-Unsubscribe` + `List-Unsubscribe-Post`.

---

## Buzón: correo entrante por IMAP

Las tres vías de arriba son de **salida**. El **Buzón** es la de entrada: la subcuenta conecta una o
varias cuentas de correo (Gmail, Outlook, el buzón de su dominio…) y la app se trae los mensajes por
IMAP, los guarda, los enseña en hilos tipo Gmail dentro del panel (entrada «Buzón» del menú, con
contador de no leídos) y permite responderlos con los remitentes y proveedores que ya existen. No
hay que configurar nada en GHL: vive dentro de la misma Custom Page.

### Qué hace

- **Sincroniza sola.** Un bucle dentro del worker (`src/lib/buzon-sync.js`) revisa cada minuto qué
  cuentas tocan según su intervalo (5 min por defecto) y trae solo lo nuevo (`uid > last_uid`, con
  reinicio si cambia `UIDVALIDITY`), con un lock por cuenta en Redis para que dos instancias no
  sincronicen la misma. Dedupe por `(mailbox_id, uid)` y por `Message-ID`. «Sincronizar ahora»
  fuerza una pasada. Los errores se quedan en `mailboxes.status='error'` + `last_error`, visibles
  en el engranaje de la pantalla, sin tumbar el worker.
- **Guarda cuerpo parseado + adjuntos, no el mensaje crudo.** El HTML se sanea en el servidor
  (`sanitize-html`: sin scripts, formularios ni estilos peligrosos) y el panel lo pinta en un
  `<iframe sandbox>` con las **imágenes remotas bloqueadas** hasta que el usuario pulsa «Cargar
  imágenes» (así el remitente no sabe que se ha abierto). Los adjuntos viven en Postgres
  (`inbox_attachments.content`) y se descargan con `Content-Disposition: attachment` y
  `X-Content-Type-Options: nosniff`. Un mensaje que supere `BUZON_MAX_MENSAJE_MB` (25) se guarda sin
  adjuntos y el panel lo avisa.
- **Hilos.** `thread_key` = primer id de `References` o el propio `Message-ID`. El detalle enseña
  los recibidos del hilo y nuestras respuestas con su estado de entrega (`encolado` → `entregado`…).
- **Responder / responder a todos / reenviar** = una fila más en `messages` con `origin='buzon'`,
  `In-Reply-To` y `References` en `extra_headers`, `thread_key` e `inbox_reply_to_id`. Sale por el
  remitente configurado en la cuenta (`reply_sender_id`) o por el remitente por defecto de la
  subcuenta; pasa por la lista de supresión y por los límites como cualquier otro correo, y aparece
  en *Envíos* y en la carpeta «Enviados desde el buzón». El original se cita al final. Reenviar no
  lleva los adjuntos del original (v1): el panel lo avisa.

### IMAP, no POP3

POP3 descarga y, normalmente, borra: el correo deja de estar en la cuenta original y no hay forma de
saber qué es nuevo sin bajarlo todo otra vez. IMAP mantiene el correo en el servidor, tiene UIDs
estables para traer solo lo que falta, avisa cuando el buzón se ha reconstruido (`UIDVALIDITY`) y
permite borrar en remoto un mensaje concreto. Por eso el buzón habla solo IMAP: `993` con TLS
(recomendado) o `143` con STARTTLS.

### Dejar copia o borrar del servidor

Al configurar cada cuenta se elige qué hacer con cada mensaje después de traerlo:

| Opción | Qué pasa | Cuándo usarla |
|---|---|---|
| **Dejar una copia en el servidor** (por defecto) | El correo sigue en la cuenta original y aquí se guarda una copia. Ocupa espacio en los dos sitios. | Casi siempre: el buzón de la app es una vista cómoda, no el único sitio donde está el correo. |
| **Borrar del servidor una vez traído** (`delete_after_import`) | Se marca `\Deleted` y se hace `EXPUNGE` nada más importarlo. Solo queda en la app. | Cuentas dedicadas (`soporte@…`) cuyo buzón original se llena o nadie mira. Si luego se borra en el panel, se pierde de verdad. |

Al borrar un mensaje desde el panel se puede marcar «también del servidor»: si su UID sigue
existiendo en la cuenta, se borra también allí. Sin marcarlo, allí se queda.

### Cuota de espacio

Cada subcuenta tiene una cuota (`location_settings.buzon_quota_mb`; si es `NULL` manda el valor por
defecto de *Ajustes → límites → «Cuota de buzón por defecto»*, 200 MB). `buzon_used_bytes` es un
contador cacheado (mensajes + adjuntos) que se actualiza al insertar y al borrar. Si un mensaje no
cabe, la sincronización de esa cuenta se detiene, el buzón pasa a `cuota_llena` y el panel lo avisa
(barra «X de Y MB» en ámbar a partir del 70 % y en rojo a partir del 90 %); al borrar correo vuelve a
arrancar sola. El admin ve el uso de todas las subcuentas en *Subcuentas* (columna «Buzón») y sube o
baja la cuota de cada una desde ahí.

**Credenciales.** La contraseña IMAP se cifra con AES-256-GCM (`ENCRYPTION_KEY`, igual que las de los
proveedores), nunca vuelve a mostrarse y nunca se escribe en logs. Gmail y Outlook exigen una
*contraseña de aplicación* con la verificación en dos pasos activada: la contraseña normal de la
cuenta no vale, y el propio formulario lo recuerda.

---

## Arquitectura de un vistazo

Un solo contenedor con tres cosas dentro, y dos almacenes.

| Pieza | Qué hace | Se apaga con |
|---|---|---|
| **Servidor HTTP (Fastify 5)** | Panel React, API de subcuenta y de admin, endpoints de los nodos de GHL, webhooks de Brevo y tracking (`/t/*`) | — |
| **Worker de envío** | Reclama mensajes de `messages` con `FOR UPDATE SKIP LOCKED`, inserta el pixel, reescribe enlaces, llama al proveedor y aplica reintentos | `WORKER_HABILITADO=false` |
| **Relay SMTP** | Servidor `smtp-server` con dos escuchas (STARTTLS y SSL) que recibe el correo del nodo nativo de GHL y lo mete en la misma cola. Su certificado TLS lo lee del `acme.json` de Traefik (que ya lo renueva) o, sin Traefik delante, lo emite la app por ACME HTTP-01; en ambos casos se aplica en caliente | `SMTP_RELAY_ENABLED=false` (por defecto) |
| **Sincronizador del buzón** | Bucle dentro del worker que trae por IMAP (`imapflow`) el correo de las cuentas configuradas, lo parsea, lo sanea y lo guarda respetando la cuota de cada subcuenta; lock por cuenta en Redis | con el worker (`WORKER_HABILITADO=false`) |
| **Postgres** | Fuente única de verdad **y** cola de envío. Las migraciones corren solas al arrancar | — |
| **Redis** | Sesiones, locks (refresco de token OAuth, worker) y límites de envío por subcuenta | — |

Detalles que condicionan todo el diseño y que conviene tener presentes:

- **La identidad llega cifrada por SSO**, nunca por la query string. El iframe hace
  `postMessage({message:"REQUEST_USER_DATA"})` y el backend descifra el payload con el *Shared
  Secret* de la app. El `locationId` **jamás** se lee de la URL.
- **Toda consulta de datos de subcuenta filtra por `location_id`.** Sin excepción.
- **Las credenciales de los proveedores se cifran con AES-256-GCM** (`ENCRYPTION_KEY`) y no salen
  nunca de la API: se devuelven como `{configurado:true}`.
- **La contraseña del relay se guarda con scrypt** y solo se enseña una vez, al generarla o rotarla.
- `status_rank` impide que un webhook que llega tarde haga retroceder el estado de un mensaje.

### Estados de un mensaje

| Estado | Rango | Significado |
|---|---|---|
| `encolado` | 0 | en cola, esperando worker |
| `reintento` | 5 | falló temporalmente, reintento programado |
| `enviando` | 10 | bloqueado por un worker |
| `enviado` | 20 | el proveedor lo aceptó (250 de SMTP / 201 de Brevo) |
| `diferido` | 25 | `deferred` del proveedor |
| `entregado` | 30 | confirmado por webhook |
| `rebotado` | 90 | rebote duro o blando definitivo (terminal) |
| `spam` | 91 | marcado como spam (terminal) |
| `fallido` | 92 | error permanente al enviar (terminal) |
| `suprimido` | 93 | bloqueado antes de enviar por la lista de supresión (terminal) |

`opened_at` y `clicked_at` son marcas, **no** estados: no tocan `status`. Los terminales (rango ≥ 90)
no se reintentan nunca.

---

## Árbol de carpetas

El SPEC fija los ficheros de `src/routes/` (§5), la interfaz de `src/lib/providers/` (§7) y el
esquema de `src/migrations/`. El resto sigue el mismo reparto de módulos que el repo de referencia.

```
emails-disruptivo/
├─ README.md · DEPLOY.md · GHL-SETUP.md      esta documentación
├─ SPEC.md · INVESTIGACION.md                contratos y detalle de las APIs externas
├─ Dockerfile · docker-compose.yml           imagen y autohospedaje/local
├─ .env.example · package.json
├─ src/
│  ├─ index.js            arranque de Fastify, montaje de rutas, worker y relay
│  ├─ config.js           lectura y validación de las variables de entorno
│  ├─ db.js               pool de Postgres + migrador con pg_advisory_lock
│  ├─ redis.js            cliente de Redis (sesiones, locks, rate limit)
│  ├─ migrations/
│  │  ├─ 001_init.sql     esquema base (idempotente, cada una se aplica una sola vez)
│  │  ├─ 002_tracking.sql · 003_rebotados.sql
│  │  ├─ 004_tls.sql      tabla tls_certificates (certificado del relay, clave cifrada)
│  │  └─ 005_buzon.sql    mailboxes, inbox_messages, inbox_attachments, cuota y origen 'buzon'
│  ├─ lib/
│  │  ├─ crypto.js        AES-256-GCM para credenciales · scrypt para el relay
│  │  ├─ buzon.js         buzón: saneado del HTML, thread_key, cuota y borrado con descuento
│  │  ├─ buzon-sync.js    bucle IMAP del buzón: sincronizar, probar, borrar en el servidor
│  │  ├─ acme.js          certificado Let's Encrypt del relay: emisión, estado y renovación
│  │  ├─ sso.js           descifrado del contexto de usuario de GHL
│  │  ├─ ghl.js           OAuth, refresco de token con lock, llamadas a la API
│  │  ├─ auth.js          guardas de sesión (admin, subcuenta y secreto de nodo)
│  │  ├─ session.js       sesiones de subcuenta y de admin
│  │  ├─ settings.js      tabla settings (clave/valor)
│  │  ├─ ratelimit.js     cubos en Redis: límites de envío y de login
│  │  ├─ red.js           destinos de red admisibles del SMTP saliente (anti-SSRF)
│  │  ├─ queue.js         worker de envío, máquina de estados y reintentos
│  │  ├─ render.js        composición del correo: variables, pixel, enlaces, cabeceras
│  │  ├─ suppression.js   lista de supresión (rebotes, spam, bajas)
│  │  ├─ tracking.js      tokens firmados de seguimiento + rutas de baja (/t/baja)
│  │  └─ providers/
│  │     ├─ index.js      registro de proveedores por tipo
│  │     ├─ brevo.js      API transaccional de Brevo
│  │     └─ smtp.js       SMTP genérico con nodemailer
│  ├─ smtp-relay/
│  │  ├─ index.js         servidor SMTP entrante (dos escuchas, TLS en caliente, límites)
│  │  ├─ auth.js          AUTH PLAIN/LOGIN contra relay_accounts
│  │  ├─ routing.js       enrutado por el From y carga de la cuenta de relay
│  │  └─ handler.js       RCPT TO y DATA: parseo del mensaje y alta en la cola
│  └─ routes/
│     ├─ oauth.js         instalación, callback y sesión por SSO
│     ├─ acme.js          /.well-known/acme-challenge/:token — reto HTTP-01
│     ├─ location.js      /api/loc/*  — panel de subcuenta
│     ├─ buzon.js         /api/loc/buzon/* — cuentas IMAP, mensajes, adjuntos, respuestas, espacio
│     ├─ admin.js         /api/admin/* — panel de la agencia
│     ├─ actions.js       /api/ghl/*  — nodos y campos Dynamic
│     ├─ webhooks.js      /api/webhooks/brevo/:token
│     └─ tracking.js      /t/a/:token.gif · /t/c/:token
└─ web/                   panel React 18 + Vite 6 + Tailwind 4
   └─ src/
      ├─ App.jsx · api.js · sso.js
      ├─ components/ui.jsx    Boton, Campo, Select, Textarea, Interruptor, Modal,
      │                       Tabla, Badge, Aviso, Spinner, Confirmar, Copiar
      └─ pages/               Resumen, Proveedores, Remitentes, Plantillas, Envios,
                              Buzon, Relay, Dominios + las de /admin/*
```

---

## Variables de entorno

| Variable | Obligatoria | Def. | Para qué |
|---|---|---|---|
| `PORT` | no | `8080` | puerto HTTP |
| `DATABASE_URL` | **sí** | — | Postgres |
| `REDIS_URL` | **sí** | — | sesiones, locks y rate limit |
| `APP_BASE_URL` | **sí** | — | URL pública **sin barra final** (OAuth, tracking, webhooks) |
| `ENCRYPTION_KEY` | **sí** | — | 32 bytes en base64 o hex; cifra las credenciales. Sin ella no arranca |
| `ADMIN_USER` / `ADMIN_PASS` | **sí** | — | login del panel de admin |
| `SMTP_RELAY_ENABLED` | no | `false` | levanta el servidor SMTP del relay |
| `SMTP_RELAY_PORT` | no | `2525` | escucha TLS/STARTTLS dentro del contenedor |
| `SMTP_RELAY_PORT_SSL` | no | `2465` | escucha SSL (TLS implícito) dentro del contenedor; vacía = no se levanta |
| `SMTP_RELAY_PUBLIC_PORT` | no | `587` | puerto público que EasyPanel publica hacia `SMTP_RELAY_PORT` y que el panel enseña a la subcuenta |
| `SMTP_RELAY_PUBLIC_PORT_SSL` | no | `465` | ídem para la escucha SSL |
| `SMTP_RELAY_HOST` | no | host de `APP_BASE_URL` | host del relay: el que pega el cliente en GHL y cuyo certificado se usa. Si es otro, dalo de alta con HTTPS en *Domains* para que Traefik tenga su certificado |
| `SMTP_RELAY_TRAEFIK_ACME` | no | — | **modo recomendado en EasyPanel**: ruta, dentro del contenedor, del `acme.json` de Traefik (p. ej. `/certs/acme.json`, con el directorio de Traefik montado en `/certs`). La app lee de ahí el certificado que Traefik ya renueva y no llama a Let's Encrypt |
| `SMTP_RELAY_TLS_AUTO` | no | `true` | sin `SMTP_RELAY_TRAEFIK_ACME`: emite y renueva solo el certificado con Let's Encrypt (ACME HTTP-01 desde la app). No funciona detrás de Traefik con ACME |
| `ACME_EMAIL` | no | — | contacto opcional de la cuenta ACME (modo HTTP-01 propio) |
| `ACME_DIRECTORY` | no | LE producción | URL del directorio ACME o `staging` para pruebas (modo HTTP-01 propio) |
| `SMTP_RELAY_TLS_CERT` / `SMTP_RELAY_TLS_KEY` | no | — | certificado manual en ficheros; tiene prioridad sobre Traefik y sobre el automático. Sin nada de lo anterior: autofirmado provisional |
| `SMTP_RELAY_MAX_SIZE` | no | `26214400` | tamaño máximo de mensaje (25 MB) |
| `SMTP_BOUNCE_DOMAIN` | no | — | activa VERP y la captura de rebotes por el relay (puerto 25) |
| `ENVIO_LIMITE_MINUTO` | no | `60` | tope de envíos por subcuenta y minuto |
| `ENVIO_LIMITE_DIA` | no | `5000` | tope de envíos por subcuenta y día |
| `BUZON_MAX_MENSAJE_MB` | no | `25` | tamaño máximo de un correo entrante del buzón; los que lo superan se guardan sin adjuntos y con aviso |
| `WORKER_CONCURRENCIA` | no | `5` | mensajes en paralelo |
| `WORKER_HABILITADO` | no | `true` | ponlo a `false` para escalar workers en un servicio aparte |

**`ENCRYPTION_KEY` no se cambia a la ligera.** Si la cambias, las credenciales ya guardadas dejan de
poder descifrarse y hay que volver a introducirlas proveedor a proveedor.

---

## Levantarlo en local con docker-compose

```bash
cp .env.example .env
```

Rellena en `.env` al menos `ADMIN_PASS`, `POSTGRES_PASSWORD` y `ENCRYPTION_KEY`. Para generar la
clave de cifrado:

```bash
openssl rand -base64 32
# o, sin openssl:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Y levanta los tres servicios (Postgres, Redis y la app):

```bash
docker compose up -d
docker compose logs -f app
```

- Panel en `http://localhost:8080` · salud en `http://localhost:8080/healthz`.
- Las migraciones corren solas al arrancar; no hay que ejecutar nada a mano.
- El relay SMTP viene **apagado**. Para probarlo en local pon `SMTP_RELAY_ENABLED=true`; el
  compose publica `SMTP_RELAY_PUBLIC_PORT` (587) hacia la escucha `2525` y
  `SMTP_RELAY_PUBLIC_PORT_SSL` (465) hacia `2465`. En local no hay Let's Encrypt (el host no es
  público): el relay usa el autofirmado provisional y el panel lo enseña como «certificado en
  emisión». En producción el certificado se lee del `acme.json` de Traefik
  (`SMTP_RELAY_TRAEFIK_ACME`, DEPLOY.md §D).

En local, GHL no puede llamar a `http://localhost`. Para probar los nodos y los webhooks de Brevo
necesitas un túnel HTTPS y poner esa URL en `APP_BASE_URL`.

### Sin Docker

```bash
npm install && cd web && npm install && cd ..
npm run dev            # API en :8080 (necesita Postgres y Redis accesibles)
cd web && npm run dev  # panel en :5173 con proxy a /api
```

---

## Recorrido completo de un envío

Lo que ocurre entre que un contacto entra en el nodo del workflow y el evento de entrega aparece en
el panel.

### Por un nodo propio

1. **GHL ejecuta el nodo** y hace `POST` a `/api/ghl/accion/plantilla/:secreto` (o
   `/personalizado/:secreto`) con el cuerpo estándar
   `{data:{…campos…}, extras:{locationId, contactId, workflowId}, meta:{key, version}}`.
2. **La app autentica la llamada.** El `:secreto` de la URL es un segmento aleatorio fijo de la
   instalación (`settings.ghl.action_secret`). Si además llega firma (`x-ghl-signature` /
   `x-wh-signature`) se verifica; si no llega, no se bloquea. Después se comprueba que
   `extras.locationId` corresponde a una **instalación viva** en `connections`.
3. **Se resuelve la configuración**, siempre filtrada por `location_id`: proveedor, remitente y —en
   el nodo 1— plantilla. Cualquier fallo aquí es un error de configuración → **400** con
   `{"ok":false,"error":"…"}` en español, que se lee en el log del workflow. Un fallo temporal
   (base de datos caída, por ejemplo) devuelve **503** para que GHL reintente.
4. **Se comprueban supresión y límites.** Si el destinatario está en `suppressions` de esa subcuenta,
   el mensaje se guarda directamente como `suprimido` y no se envía.
5. **Se inserta la fila en `messages`** con `status='encolado'`, `origin='nodo_plantilla'` (o
   `nodo_personalizado`), los identificadores de GHL (`ghl_contact_id`, `ghl_workflow_id`) y un
   `correlation_id` único.
6. **Se responde 200 al instante**: `{"ok":true,"message_id":"1042","estado":"encolado"}`. Esos tres
   campos son los que se registran como *Response Data* en el marketplace, así que quedan
   disponibles como variables en los pasos siguientes del workflow. El envío real todavía no ha
   ocurrido: el nodo no se queda esperando.
7. **El worker reclama el mensaje** (`SELECT … FOR UPDATE SKIP LOCKED` sobre `status IN
   ('encolado','reintento')`), lo pone en `enviando` y anota `locked_at`/`locked_by`.
8. **Se prepara el cuerpo**: se inserta el pixel `/t/a/<token>.gif` al principio del HTML y se
   reescriben los `href` http(s) a `/t/c/<token>`, guardando cada destino en `message_links` — el
   redirector solo redirige a URLs que estén en esa tabla, nunca a una URL suelta.
9. **Se llama al proveedor** por la interfaz común `enviar(ctx)`. El `correlation_id` viaja en la
   cabecera `X-Mailin-custom` (Brevo) o en una cabecera propia (SMTP).
10. **Aceptado** → `status='enviado'` (rango 20), `sent_at`, y `provider_message_id` con el id del
    proveedor **normalizado** (Brevo lo devuelve entre `<>` y en los webhooks a veces sin ellos: se
    quitan siempre). **Rechazado** → si el error es temporal (4xx de SMTP, 429, red) pasa a
    `reintento` con `next_attempt_at` y backoff; si es permanente (5xx, credenciales, remitente no
    verificado) va directo a `fallido` con el motivo en `last_error`.
11. **Llegan los eventos.** Brevo hace `POST` a `/api/webhooks/brevo/:token` (token propio por
    proveedor). El endpoint acepta un evento suelto o un lote, mapea el nombre del evento de
    snake_case (`hard_bounce`) al vocabulario interno, localiza el mensaje por el `X-Mailin-custom`
    que le devolvimos —o por `message-id` normalizado— y **escribe en `message_events`** con una
    `dedupe_key`: los webhooks llegan repetidos y desordenados, y el `UNIQUE(message_id, dedupe_key)`
    es lo que da la idempotencia.
12. **Se actualiza el estado con la regla del rango**: `delivered` sube a `entregado` (30), `deferred`
    a `diferido` (25), `hard_bounce` a `rebotado` (90) y además da de alta el correo en
    `suppressions` con `reason='rebote_duro'`, `spam` a `spam` (91). Un evento con rango menor al
    actual se registra en el histórico pero **no** cambia `status`; los terminales negativos siempre
    ganan. Las aperturas y los clics solo rellenan `opened_at` / `clicked_at`.
13. **Se ve en el panel** en *Envíos*: la lista con filtros por estado, fecha, origen y texto, y el
    detalle de cada mensaje con su histórico completo de eventos.

Con **SMTP genérico** el recorrido es el mismo hasta el paso 10, pero ahí se acaba la información
fiable: un `250` significa solo *"acepto la responsabilidad de la entrega"*. No hay confirmación de
entrega real, ni rebotes, ni quejas por esa vía; el mensaje se queda en `enviado` salvo que el propio
servidor rechace en el momento.

### Aperturas y clics: reales frente a automáticos, y la entrega inferida

No toda apertura la hace una persona: Apple Mail Privacy Protection descarga el pixel de todos los
correos, y los escáneres de seguridad corporativos (SafeLinks, Barracuda, Mimecast…) visitan los
enlaces antes de entregar el mensaje. La app clasifica cada evento al registrarlo
(`message_events.automatico`): user-agent de proxy o de bot, apertura casi instantánea tras el envío
o ráfaga de clics sobre varios enlaces son señales de evento automático. **El Resumen y los
contadores de Envíos agregan solo los reales**; los automáticos quedan en el detalle del envío con la
etiqueta gris «automático», para auditoría. Un clic real convalida la apertura (aunque el pixel se
bloquee), y cualquier evento real es además prueba de entrega: si el mensaje seguía en `enviado`, se
promociona a `entregado`.

Para el SMTP genérico existe además la **entrega inferida**: si pasan `INFERENCIA_ENTREGA_HORAS`
(48 por defecto) sin rebote ni queja, el reconciliador marca el mensaje como «entregado (inferido)».
Es una inferencia honesta —el correo salió y nadie lo devolvió—, no una confirmación del buzón de
destino, y el panel lo muestra siempre con ese matiz. Y si tu proveedor es Brevo, desactiva su
tracking de aperturas y clics en su panel: la app ya pone el pixel y reescribe los enlaces, y con los
dos activos cada enlace queda envuelto dos veces (ver [GHL-SETUP.md](GHL-SETUP.md)).

### Por el relay

Los pasos 4 a 13 son idénticos. Lo único que cambia es la entrada:

1. GHL abre una conexión SMTP contra el relay (`587` con STARTTLS o `465` con SSL; las dos escuchas
   comparten certificado, auth y límites) y autentica (`AUTH LOGIN`/`PLAIN`) con el usuario y la
   contraseña que copiaste del panel. De ahí sale el `location_id`.
2. Se lee el `From` del mensaje y se aplica el enrutado por remitente descrito arriba, que resuelve
   el `sender_id` y el `provider_id`.
3. Se parsea el MIME (asunto, destinatarios, HTML, texto) y se inserta en `messages` con
   `origin='relay'`.
4. Se responde `250` a GHL y el worker sigue desde el paso 7.

---

## Seguridad

- Nada de secretos en logs ni en respuestas de la API. Las credenciales se devuelven como
  `{configurado:true}` y la contraseña del relay solo se muestra en el momento de crearla o rotarla.
- Toda entrada se valida: correo bien formado, longitudes máximas y **escapado de `\r` y `\n`** en
  asunto, nombre y reply-to, que es como se corta la inyección de cabeceras de correo.
- SQL siempre parametrizado y filtrado por `location_id`.
- Un dominio verificado pertenece a **una sola** subcuenta (índice único parcial sobre
  `sender_domains`). Es el guardarraíl que impide que un cliente envíe desde el dominio de otro.
- El redirector de clics solo acepta tokens que estén en `message_links`: no es un redirector abierto.
- Los tokens de OAuth de GHL viven en tu Postgres. Mantén el repo y las copias de seguridad privados.
- El buzón trata el correo entrante como hostil: HTML saneado en el servidor antes de guardarlo,
  pintado en un `<iframe sandbox>` sin scripts ni navegación, imágenes remotas bloqueadas por
  defecto y adjuntos servidos solo como descarga (`nosniff`). La contraseña IMAP va cifrada como
  las credenciales de los proveedores y nunca se devuelve ni se registra en logs.
