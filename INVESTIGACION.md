# Investigacion de campo (generada por el pipeline)
Detalle literal de las APIs. El SPEC.md manda sobre cualquier discrepancia.


---

## BREVO (API, webhooks, remitentes)
### Resumen
Brevo cubre todo lo que necesita la app: POST /v3/smtp/email (header `api-key`, respuesta 201 con `messageId`), webhooks transaccionales creables por API (POST /v3/webhooks) y dos endpoints de reconciliación (GET /v3/smtp/statistics/events y GET /v3/smtp/emails). Dos hallazgos críticos para el diseño: (a) los nombres de evento del enum de creación del webhook son camelCase (`hardBounce`, `uniqueOpened`, `invalid`) pero el campo `event` del payload llega en snake_case (`hard_bounce`, `unique_opened`, `invalid_email`), hay que mapear; (b) el reconciliador GET /v3/smtp/statistics/events cae en el comodín "All /v3/smtp/{…}" con solo 300 peticiones/hora en cuentas generales (5/min), mientras que POST /v3/smtp/email tiene 1.000 RPS — es decir, se puede enviar muchísimo pero consultar muy poco, así que el reconciliador debe barrer por ventana temporal global (limit=5000) y nunca mensaje a mensaje. La política de reintentos de webhooks documentada descarta el evento ante cualquier 4xx (salvo 429) o 5xx tras los reintentos, por lo que el reconciliador es obligatorio, no opcional. Para correlacionar envíos usa la cabecera `X-Mailin-custom` (viaja en el envío y vuelve en TODOS los payloads de webhook) más `tags` por cliente. La verificación de remitente NO se puede leer de forma fiable en GET /v3/senders (`active` significa activado/desactivado, no verificado): hay que cruzar con GET /v3/senders/domains/{dominio} que sí expone `verified` y `authenticated`.
### Detalle
> Base URL: `https://api.brevo.com/v3/` — Autenticación: cabecera `api-key: xkeysib-…`
> Doc raíz: https://developers.brevo.com/ · Conceptos: https://developers.brevo.com/docs/how-it-works

---

## 1) POST /v3/smtp/email — envío transaccional

Ref: https://developers.brevo.com/reference/sendtransacemail · Guía: https://developers.brevo.com/docs/send-a-transactional-email

### Cabeceras
```
api-key: xkeysib-xxxxxxxxxxxxxxxx
Content-Type: application/json
Accept: application/json
```

### Cuerpo completo

| Campo | Tipo | Obligatorio | Notas |
|---|---|---|---|
| `sender` | objeto `{email?, id?, name?}` | Sí, salvo que lo aporte el `templateId` | Se indica **o** `email` **o** `id` (id del remitente registrado). Si se pasa `id`, `name` se ignora. `name` máx **70 caracteres** |
| `to` | array `[{email, name?, contactPixelTrackingConsent?}]` | Sí (salvo si usas `messageVersions`) | `name` máx 70 |
| `cc` | array igual que `to` | No | |
| `bcc` | array igual que `to` | No | |
| `replyTo` | objeto `{email (req), name?}` | No | |
| `subject` | string | Sí, salvo `templateId` | |
| `htmlContent` | string | Sí, salvo `templateId` | |
| `textContent` | string | No | |
| `templateId` | integer (int64) | No | Si se usa, sobreescribe subject/sender/contenido de la plantilla |
| `params` | objeto clave-valor | No | Sustitución `{{params.nombre}}`. Máx **100 KB** por versión y **1.000 KB** acumulados |
| `headers` | objeto | No | Cabeceras personalizadas en **Title-Case-Format**. Claves especiales: `sender.ip` (IP dedicada), `X-Mailin-custom`, `X-Mailin-Tag`. Charset por defecto UTF-8 |
| `tags` | array de strings | No | Etiquetado; vuelve en los webhooks y filtra en las estadísticas |
| `attachment` | array `[{url?} \| {content(base64), name}]` | No | `name` obligatorio si se manda `content`. Se ignora en plantillas de Old Template Language |
| `messageVersions` | array `[{to(req), subject?, htmlContent?, textContent?, params?, cc?, bcc?, replyTo?}]` | No | Batch personalizado |
| `scheduledAt` | string ISO 8601 (UTC) | No | Retardo real de hasta 5 min |
| `batchId` | string UUIDv4 | No | Se autogenera si se omite; permite cancelar el lote |

**Extensiones de adjunto admitidas (literal de la doc):** `xlsx, xls, ods, docx, docm, doc, csv, pdf, txt, gif, jpg, jpeg, png, tif, tiff, rtf, bmp, cgm, css, shtml, html, htm, zip, xml, ppt, pptx, tar, ez, ics, mobi, msg, pub, eps, odt, mp3, m4a, m4v, wma, ogg, flac, wav, aif, aifc, aiff, mp4, mov, avi, mkv, mpeg, mpg, wmv, pkpass, xlsm`

### Ejemplo literal de petición
```bash
curl --request POST \
  --url https://api.brevo.com/v3/smtp/email \
  --header 'api-key:YOUR_API_KEY' \
  --header 'content-type: application/json' \
  --data '{
    "sender":{"name":"Alex from Brevo","email":"hello@brevo.com"},
    "to":[{"email":"johndoe@example.com","name":"John Doe"}],
    "subject":"Hello from Brevo!",
    "htmlContent":"<html><body>Your delivery is expected {{params.estimatedArrival}}.</body></html>",
    "params":{"estimatedArrival":"Tomorrow"}
  }'
```

### Respuesta 201
```json
{ "messageId": "<201798300811.5787683@relay.domain.com>" }
```
Con múltiples versiones/destinatarios devuelve además:
```json
{ "messageIds": ["<...@relay.domain.com>", "<...@relay.domain.com>"] }
```

> **Ojo de integración:** el `messageId` de la respuesta viene **entre ángulos** `<…>`, igual que en GET /v3/smtp/emails, pero los ejemplos de payload de webhook muestran `message-id` **sin ángulos**. Normaliza siempre (`trim` de `<` y `>`) antes de indexar/cruzar en Postgres.

### Límites de tamaño y destinatarios
- **2.000 destinatarios totales** por petición (sumando todas las `messageVersions`).
- **99 destinatarios máximo por `messageVersion`**.
- `params`: 100 KB individuales / 1.000 KB acumulados.
- Tamaño total del email (contenido + adjuntos): **20 MB** (fuente: help center, ver incertidumbres).
- Con adjunto, el máximo baja a **99 destinatarios**.
- Nombre visible (`name`): 70 caracteres.

### Errores documentados
- **201** OK · **400** Bad Request con `{"code":"…","message":"…"}`.
- Cadenas de `code`: `invalid_parameter`, `missing_parameter`, `out_of_range`, `campaign_processing`, `campaign_sent`, `document_not_found`, `not_enough_credits`, `permission_denied`, `duplicate_parameter`, `duplicate_request`, `method_not_allowed`, `unauthorized`, `account_under_validation`, `not_acceptable`, `bad_request`, `unprocessable_entity`, y errores de dominio/DNS/autenticación.

---

## 2) Remitentes y verificación

Guía: https://developers.brevo.com/docs/sender-creation-and-management · https://developers.brevo.com/docs/domain-authentication-and-verification

### GET /v3/senders
Ref: https://developers.brevo.com/reference/getsenders-1 · Query opcional: `ip`, `domain`
```json
{
  "senders": [
    { "id": 1, "name": "Support Team", "email": "support@example.com", "active": true, "ips": [] }
  ]
}
```
Descripciones literales de la doc:
- `active`: *"Status of sender (true=activated, false=deactivated)"*
- `ips`: *"List of dedicated IP(s)… For standard accounts, this will be an empty array."*

> **No existe un campo `verified` en GET /v3/senders.** `active` es activado/desactivado, no verificado. Para saber si un remitente es realmente usable hay que cruzar con el estado del dominio.

### POST /v3/senders
Ref: https://developers.brevo.com/reference/createsender
```json
{ "name": "Newsletter", "email": "newsletter@mycompany.com",
  "ips": [{"ip":"123.98.689.7","domain":"mycompany.com","weight":50}] }
```
Respuesta **201**: `{ "id": 12, "spfError": false, "dkimError": false }`
(`spfError`/`dkimError` = `true` significa mal configurado). Al crearlo, Brevo envía un email de verificación con **OTP de 6 dígitos** a esa dirección.

### PUT /v3/senders/{senderId}/validate — validar por OTP
Ref: https://developers.brevo.com/reference/validate-sender-by-otp
```bash
curl -X PUT https://api.brevo.com/v3/senders/1/validate \
  -H "api-key: YOUR_API_KEY" -H "Content-Type: application/json" \
  -d '{"otp": 123456}'
```
**204** = remitente verificado. **400** `invalid_parameter` / `out_of_range` ("OTP code has expired"). **404** `document_not_found`.

Otros: `PUT /v3/senders/{senderId}` (204), `DELETE /v3/senders/{senderId}` (204).

### Dominios — aquí SÍ está el estado de verificación
`GET /v3/senders/domains` · `GET /v3/senders/domains/{domainName}`
```json
{
  "domain": "mycompany.com",
  "verified": false,
  "authenticated": false,
  "dns_records": {
    "dkim_record": { "type": "TXT", "value": "k=rsa;p=MIGfMA0GCSqGSIb3...",
                     "host_name": "mail._domainkey.", "status": false },
    "brevo_code":  { "type": "TXT", "value": "brevo-code:e760f020e6d438149540cfc757e99b5a",
                     "host_name": "", "status": false }
  }
}
```
`PUT /v3/senders/domains/{domainName}/authenticate` →
```json
{ "domain_name": "mycompany.com", "message": "Domain has been authenticated successfully." }
```

### Qué pasa con un remitente no verificado
- Regla de Brevo: **si el dominio está autenticado, los remitentes individuales de ese dominio NO necesitan verificación por OTP.** Si el dominio no lo está, el remitente debe validarse con el código de 6 dígitos antes de poder enviar.
- Enviar desde un remitente no verificado devuelve **HTTP 400** con `code: invalid_parameter` (mensaje del tipo "Sender not valid" — texto exacto sin confirmar, ver incertidumbres). No se genera `messageId`.

**Patrón recomendado para la app:** al dar de alta un cliente, `GET /v3/senders` + `GET /v3/senders/domains`; marcar el remitente como *usable* solo si (`domains[dominio].authenticated === true`) **o** el remitente pasó OTP; guardar `spfError`/`dkimError` para avisar en el panel.

---

## 3) Webhooks transaccionales

Guía: https://developers.brevo.com/docs/how-to-use-webhooks · Payloads: https://developers.brevo.com/docs/transactional-webhooks
Ref crear: https://developers.brevo.com/reference/createwebhook · Ref listar: https://developers.brevo.com/reference/get-webhooks

### POST /v3/webhooks
```json
{
  "url": "https://emails.disruptivo.app/webhooks/brevo/<clienteId>",
  "description": "Eventos transaccionales cliente X",
  "type": "transactional",
  "channel": "email",
  "events": ["request","delivered","hardBounce","softBounce","blocked","spam","invalid","deferred","opened","uniqueOpened","click","unsubscribed"],
  "batched": false,
  "auth": { "type": "bearer", "token": "<token-propio-por-cliente>" },
  "headers": [ { "key": "x-dd-cliente", "value": "cliente-123" } ]
}
```
Respuesta **201**: `{ "id": 9864 }`

Otros verbos: `GET /v3/webhooks?type=transactional&sort=desc`, `PUT /v3/webhooks/{id}`, `DELETE /v3/webhooks/{id}`.
`GET /v3/webhooks` devuelve:
```json
{ "webhooks": [ {
  "id": 9864,
  "url": "https://example.domain.com/webhook/events/kzfxxxxxxxx0uyo1",
  "description": "Webhook triggered on campaign openings",
  "events": ["opened"], "type": "transactional",
  "createdAt": "2016-07-18T12:30:09Z", "modifiedAt": "2016-07-18T16:00:50Z",
  "auth": { "token": "test-auth-token1234", "type": "bearer" },
  "headers": [ { "key": "cf-secret", "value": "test-header-value" } ],
  "batched": true } ] }
```

### Eventos aceptados al CREAR (enum de la API)
- **transactional**: `sent`, `request`, `delivered`, `hardBounce`, `softBounce`, `blocked`, `spam`, `invalid`, `deferred`, `click`, `opened`, `uniqueOpened`, `unsubscribed`
- **marketing**: `spam`, `opened`, `click`, `hardBounce`, `softBounce`, `unsubscribed`, `listAddition`, `delivered`, `contactUpdated`, `contactDeleted`
- **inbound**: `inboundEmailProcessed`

### ⚠️ Mapa camelCase (creación) → snake_case (campo `event` del payload)

| Evento al crear | `event` que llega en el JSON |
|---|---|
| `sent` / `request` | `request` |
| `delivered` | `delivered` |
| `hardBounce` | `hard_bounce` |
| `softBounce` | `soft_bounce` |
| `blocked` | `blocked` |
| `spam` | `spam` |
| `invalid` | `invalid_email` |
| `deferred` | `deferred` |
| `click` | `click` |
| `opened` | `opened` |
| `uniqueOpened` | `unique_opened` |
| `unsubscribed` | `unsubscribed` |
| (no listado en creación) | `error` |
| (no listado en creación) | `proxy_open`, `unique_proxy_open` |

### Payloads EXACTOS (literales de la doc)

**request (envío aceptado)**
```json
{
  "event": "request", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "subject": "My first Transactional",
  "X-Mailin-custom": "some_custom_header", "sending_ip": "xxx.xxx.xxx.xxx",
  "ts_epoch": 1604933654, "template_id": 22, "tags": ["transac_messages"],
  "mirror_link": "https://app-smtp.brevo.com/log/preview/...", "contact_id": 8
}
```

**delivered**
```json
{
  "event": "delivered", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "subject": "My first Transactional",
  "X-Mailin-custom": "some_custom_header", "sending_ip": "xxx.xxx.xxx.xxx",
  "template_id": 22, "tags": ["transac_messages"]
}
```

**hard_bounce** (idéntico + `reason` + `ts_epoch`)
```json
{
  "event": "hard_bounce", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "subject": "My first Transactional",
  "X-Mailin-custom": "some_custom_header", "sending_ip": "xxx.xxx.xxx.xxx",
  "template_id": 22, "tags": ["transac_messages"],
  "reason": "server is down", "ts_epoch": 1604933653
}
```

**soft_bounce**: mismo esquema, `"event":"soft_bounce"`, `"reason":"server is down"`.
**deferred**: mismo esquema, `"event":"deferred"`, `"reason":"spam"`.

**blocked / invalid_email / error** (esquema común, sin `sending_ip`)
```json
{
  "event": "blocked", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "subject": "My first Transactional",
  "X-Mailin-custom": "some_custom_header", "template_id": 22,
  "tags": ["transac_messages"], "ts_epoch": 1604933623
}
```
(`"event":"invalid_email"` y `"event":"error"` usan exactamente el mismo conjunto de campos.)

**spam** (payload reducido: sin `subject`, sin `sending_ip`, sin `template_id`)
```json
{
  "event": "spam", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "X-Mailin-custom": "some_custom_header",
  "tags": ["transac_messages"]
}
```

**opened / unique_opened** (añaden `user_agent`, `device_used`, `mirror_link`, `contact_id`)
```json
{
  "event": "unique_opened", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "subject": "My first Transactional",
  "X-Mailin-custom": "some_custom_header", "sending_ip": "xxx.xxx.xxx.xxx",
  "template_id": 22, "tags": ["transac_messages"],
  "user_agent": "Mozilla/5.0...", "device_used": "DESKTOP",
  "mirror_link": "https://app-smtp.brevo.com/log/preview/...",
  "contact_id": 8, "ts_epoch": 1604933623
}
```

**click** (= opened + `link`)
```json
{
  "event": "click", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "subject": "My first Transactional",
  "X-Mailin-custom": "some_custom_header", "sending_ip": "xxx.xxx.xxx.xxx",
  "ts_epoch": 1604933654, "template_id": 22, "tags": ["transac_messages"],
  "user_agent": "Mozilla/5.0...", "device_used": "DESKTOP",
  "mirror_link": "https://app-smtp.brevo.com/log/preview/...",
  "contact_id": 8, "link": "https://domain.com/product"
}
```

**unsubscribed** (⚠️ usa `tag` como **string con JSON serializado dentro**, no `tags` array)
```json
{
  "event": "unsubscribed", "email": "example@domain.com", "id": 12345,
  "date": "2020-10-09 00:00:00", "ts": 1604933619,
  "message-id": "201798300811.5787683@relay.domain.com",
  "ts_event": 1604933654, "subject": "My first Transactional",
  "X-Mailin-custom": "some_custom_header", "template_id": 22,
  "tag": "[\"transactionalTag\"]",
  "user_agent": "Mozilla/5.0...", "device_used": "MOBILE",
  "mirror_link": "https://app-smtp.brevo.com/log/preview/...",
  "contact_id": 8, "ts_epoch": 1604933623, "sending_ip": "xxx.xxx.xxx.xxx"
}
```

**unique_proxy_open** (ejemplo real más reciente de la doc; nótese que trae `tags` **y** `tag`, `sender_email`, y `ts_epoch` en **milisegundos**)
```json
{
  "id": 25290, "email": "", "message-id": "an#2705147202202651768",
  "date": "2024-08-22 16:03:29",
  "tags": ["this_tag","tag_thos"], "tag": "[\"this_tag\", \"tag_thos\"]",
  "event": "unique_proxy_open", "subject": "this is required subject",
  "sending_ip": "::", "ts": 1724322809, "template_id": 660,
  "ts_epoch": 1724322809710, "ts_event": 1724322809, "link": "",
  "sender_email": "abc@sendinblue.com",
  "mirror_link": "https://app-smtp.brevo.com/log/preview/...",
  "user_agent": "Mozilla/5.0", "device_used": "DESKTOP",
  "contact_id": 4816445214646337536
}
```

### Semántica de campos (tabla de la doc)
| Campo | Significado |
|---|---|
| `event` | Tipo de evento (snake_case) |
| `email` | Destinatario |
| `id` | Identificador (ver incertidumbres: la doc lo describe ambiguamente) |
| `date` | Timestamp en **CET/CEST** (¡no UTC!) |
| `ts`, `ts_event` | Unix **UTC en segundos** |
| `ts_epoch` | Unix **UTC en milisegundos** (aunque en varios ejemplos aparece en segundos) |
| `message-id` | Referencia interna del mensaje |
| `subject`, `template_id`, `sending_ip` | Del envío |
| `tags` (array) / `tag` (string JSON) | Etiquetas |
| `contact_id` | Contacto en Brevo |
| `X-Mailin-custom` | **Cabecera propia que enviaste tú** — vuelve en todos los eventos |
| `reason` | Motivo de bounce/deferral |
| `link` | URL clicada |
| `user_agent`, `device_used` | `DESKTOP`/`MOBILE` |
| `mirror_link` | Vista previa en el panel de Brevo |

> **Clave de correlación:** manda en el envío `headers: {"X-Mailin-custom": "{\"envio_id\":\"…\",\"cliente_id\":\"…\",\"location_id\":\"…\"}"}` y te vuelve íntegro en cada webhook. Es más robusto que depender solo de `message-id`. Complementa con `tags: ["cli:<clienteId>"]`.

### Reintentos y fiabilidad
Doc: https://developers.brevo.com/docs/retry-mechanism
- **4 reintentos** además de la petición original (5 intentos totales).
- Backoff: **10 min → 1 h → 2 h → 8 h**.
- Códigos **4xx (salvo 429) y 5xx detienen los reintentos y descartan el webhook**.
- Si tu servidor no responde, las peticiones se **pausan 10 minutos** y se reanudan.
- Límite de **40 webhooks por cuenta**.

### Batched
Doc: https://developers.brevo.com/docs/batch-webhooks
```json
{ "description":"…", "url":"https://user:pass@host/hook",
  "events":["sent"], "batched": true, "type":"transactional" }
```
- Ventana de acumulación: **5 minutos**.
- **Hasta 500 eventos por lote**; si hay más, se envían varios lotes de 500 al cerrar la ventana; si hay menos, se envían igual.

### Seguridad del webhook
Doc: https://developers.brevo.com/docs/username-and-password-authentication
1. Basic auth embebida en la URL: `https://usuario:password@host/ruta`
2. Bearer: `"auth": { "type": "bearer", "token": "client-token" }`
3. Cabeceras personalizadas: `"headers": [{"key":"client-id","value":"…"},{"key":"client-secret","value":"…"}]`
4. Whitelist de IPs de Brevo (rango citado: `1.179.112.0/20`) — https://developers.brevo.com/docs/ip-security
**No hay firma HMAC ni cabecera de firma.** La autenticación del webhook es por token/headers/basic auth, así que genera un secreto distinto por cliente y compáralo en tiempo constante.

---

## 4) Reconciliación por API

### GET /v3/smtp/statistics/events (eventos sin agregar) — el reconciliador principal
Ref: https://developers.brevo.com/reference/getemaileventreport-1

| Param | Tipo | Default | Notas |
|---|---|---|---|
| `limit` | int **0–5000** | 2500 | |
| `offset` | int | 0 | |
| `startDate` | `YYYY-MM-DD` | — | obligatorio si usas `endDate` |
| `endDate` | `YYYY-MM-DD` | — | obligatorio si usas `startDate`; **rango máx 90 días** |
| `days` | int 1–90 | 30 | incompatible con startDate/endDate |
| `email` | string | — | filtro por destinatario |
| `event` | enum | — | `bounces`, `hardBounces`, `softBounces`, `delivered`, `spam`, `requests`, `opened`, `clicks`, `invalid`, `deferred`, `blocked`, `unsubscribed`, `error`, `loadedByProxy` |
| `tags` | string | — | array serializado y URL-encoded |
| `messageId` | string | — | filtro por mensaje |
| `templateId` | int | — | |
| `sort` | `asc`/`desc` | `desc` | |

Respuesta:
```json
{ "events": [ {
  "date": "2017-03-12T12:30:00Z",
  "email": "john.smith@example.com",
  "event": "delivered",
  "messageId": "<201798300811.5787683@example.domain.com>",
  "from": "john@example.com",
  "subject": "Order Confirmation",
  "tag": "OrderConfirmation",
  "templateId": 4,
  "reason": "Error connection timeout",
  "ip": "192.168.1.1",
  "link": "https://example.com"
} ] }
```
Obligatorios: `date`, `email`, `event`, `messageId`. Condicionales: `reason` (bounces), `ip`/`link` (aperturas/clics), `templateId`.
⚠️ Aquí `event` viene en un **tercer vocabulario** (el del enum de filtro, p.ej. `delivered`), distinto del enum de creación de webhook y del snake_case del payload. Normaliza a un único enum interno.

### GET /v3/smtp/emails (log de envíos)
Ref: https://developers.brevo.com/reference/gettransacemailslist

| Param | Default | Notas |
|---|---|---|
| `email`, `templateId`, `messageId` | — | **uno de los tres es obligatorio** |
| `startDate`, `endDate` | — | mutuamente obligatorios; **rango máx 1 mes** |
| `sort` | `desc` | |
| `limit` | 500 | |
| `offset` | 0 | |

```json
{ "count": 120,
  "transactionalEmails": [ {
    "date": "2019-05-25T11:53:26Z", "email": "abc@xyz.com",
    "from": "sender@domain.com",
    "messageId": "<201798300811.5787683@relay.domain.com>",
    "subject": "summer camp", "tags": ["tag1","tag2"],
    "templateId": 15, "uuid": "5a78c-209ok98262910-std2341"
  } ] }
```

### GET /v3/smtp/emails/{uuid} — historial de un mensaje concreto
Ref: https://developers.brevo.com/reference/get-transac-email-content
```json
{ "date": "2016-02-25T11:53:26Z", "email": "abc@example.com",
  "subject": "Summer Camps", "templateId": 12,
  "body": "<!DOCTYPE html>...", "attachmentCount": 0,
  "events": [ {"name":"sent","time":"2016-02-25T11:53:26Z"},
              {"name":"delivered","time":"2016-02-25T11:55:26Z"} ] }
```

### Agregados (para el dashboard, no para reconciliar)
- `GET /v3/smtp/statistics/reports` (por día, `days` máx 30, `limit` def. 10) — https://developers.brevo.com/reference/getsmtpreport-1
  `{"reports":[{"date":"2017-04-30","requests":10756,"delivered":10103,"hardBounces":21,"softBounces":137,"clicks":1026,"uniqueClicks":720,"opens":5091,"uniqueOpens":2318,"spamReports":0,"blocked":519,"invalid":1,"unsubscribed":0}]}`
- `GET /v3/smtp/statistics/aggregatedReport` — https://developers.brevo.com/reference/getaggregatedsmtpreport

### Retención
- Los logs transaccionales se guardan **indefinidamente por defecto**; el usuario puede configurar retención de **1 mes a 5 años** (mínimo 1 mes exigido por Brevo).
- Desde el **1 de enero de 2025**, cuentas con **más de 10 millones de eventos** borran automáticamente los anteriores a **24 meses**.
- Independientemente de la retención, **la API solo permite consultar rangos de 90 días** (`statistics/events`) o **1 mes** (`smtp/emails`).
- Doc: https://help.brevo.com/hc/en-us/articles/4415743225746 y https://help.brevo.com/hc/en-us/articles/19317424653586

### ¿Sirve como reconciliador? Sí, con esta estrategia
Sí sirve, pero **no consultando mensaje a mensaje**: `GET /v3/smtp/statistics/events` cae en el comodín `All /v3/smtp/{…}` = **300 RPH** (≈5 req/min) en cuentas generales. Diseño recomendado:
1. Webhooks como vía primaria (tiempo real), con idempotencia.
2. Job de reconciliación por cliente cada N minutos: **barrido por ventana temporal global**, no por `messageId`. `GET /v3/smtp/statistics/events?startDate=…&endDate=…&limit=5000&offset=…&sort=asc`, paginando con `offset`, con solape de seguridad (p.ej. últimas 24–72 h) para capturar eventos tardíos (deferred/soft bounce pueden llegar horas después).
3. Marcar como cerrados los envíos que sigan en `request` sin desenlace pasado el SLA; solo para esos casos residuales usar `GET /v3/smtp/emails?messageId=…` (bucket propio de 7.200 RPH / 2 RPS, mucho más holgado) o `GET /v3/smtp/emails/{uuid}`.
4. Presupuesto por cliente: con 300 RPH compartidos entre todos los `/v3/smtp/*` que no sean el envío, hay que **encolar y limitar** (el proyecto ya usa BullMQ/Redis en el repo de referencia; mismo patrón).

---

## 5) Rate limits y códigos de error

Doc: https://developers.brevo.com/docs/api-limits · Cabeceras: https://developers.brevo.com/docs/limit-headers

### General (todas las cuentas)
| Endpoint | RPH | RPS |
|---|---|---|
| `POST /v3/smtp/email` y `GET /v3/smtp/blockedContacts` | 3.600.000 | 1.000 |
| `GET /v3/smtp/emails` | 7.200 | 2 |
| `POST /v3/transactionalSMS/send` | 540.000 | 150 |
| `POST /v3/events` | 36.000 | 10 |
| `POST /v3/orders/status` | 18.000 | 5 |
| `POST /v3/products` | 7.200 | 2 |
| **Todos los `/v3/smtp/{…}`** (excluidos los dos dedicados de arriba) | **300** | — |
| Todos los `/v3/contacts/{…}` | 36.000 | 10 |
| `/v3/loyalty/{…}` | 600 | — |
| **Todos los demás endpoints** | **100** | — |

### Advanced (Professional/Enterprise)
`POST /v3/smtp/email`: 7.200.000 RPH / 2.000 RPS · `GET /v3/smtp/emails`: 10.800 RPH / 3 RPS · comodín `/v3/smtp/{…}`: 600 RPH · contacts: 72.000 RPH / 20 RPS · resto: 200 RPH.

### Extended (solo Enterprise)
`POST /v3/smtp/email`: 6.000 RPS · `GET /v3/smtp/emails`: 18.000 RPH · comodín `/v3/smtp/{…}`: 1.800 RPH · contacts: 60 RPS · resto: 600 RPH.

> **Implicación crítica:** `GET /v3/account`, `GET /v3/senders`, `GET/POST /v3/webhooks` caen en "todos los demás" = **100 peticiones/hora** en el plan general. Cachea agresivamente en Postgres/Redis (validación de key, lista de remitentes, estado de webhooks) y no las llames en cada request del panel.

### Cabeceras de rate limit
- `x-sib-ratelimit-limit` — máximo de la ventana actual
- `x-sib-ratelimit-remaining` — peticiones restantes
- `x-sib-ratelimit-reset` — tiempo restante hasta el reset (en la unidad de granularidad del límite, normalmente segundos)
- **No documenta `Retry-After`**: usa `x-sib-ratelimit-reset` + backoff exponencial.

### Códigos HTTP
`400` Bad Request · `401` Unauthorized · `402` Payment Required · `403` Forbidden · `404` Not Found · `405` Method Not Allowed · `406` Not Acceptable · `429` Too Many Requests.

### Cadenas `code` en el cuerpo del error
`invalid_parameter`, `missing_parameter`, `out_of_range`, `unauthorized`, `document_not_found`, `method_not_allowed`, `not_enough_credits`, `duplicate_parameter`, `duplicate_request`, `account_under_validation`, `permission_denied`, `campaign_processing`, `campaign_sent`, `not_acceptable`, `bad_request`, `unprocessable_entity`.

Manejo recomendado en la app: reintentar solo `429` (respetando `x-sib-ratelimit-reset`) y `5xx`; **no** reintentar `400`/`401`/`402`/`403` (marcar la conexión del cliente como "en error" y avisar en el panel). `402`/`not_enough_credits` y `account_under_validation` son estados de cuenta del cliente, no bugs de la app.

---

## 6) Validar una API key al registrarla

Doc: https://developers.brevo.com/docs/api-key-authentication · Ref: https://developers.brevo.com/reference/getaccount

**Endpoint barato y oficialmente recomendado:** `GET https://api.brevo.com/v3/account` — la doc dice literalmente que *"valida tu clave API y devuelve los detalles de la cuenta"* y ofrece un "Try your API key". Formato de clave: prefijo `xkeysib-`.

```bash
curl --request GET --url https://api.brevo.com/v3/account \
  --header 'api-key: xkeysib-xxxx' --header 'accept: application/json'
```

Respuesta 200:
```json
{
  "organization_id": "5fa2b8c123456789abcdef01",
  "user_id": 1234567,
  "enterprise": false,
  "companyName": "Acme Marketing Corp",
  "email": "michael.davis@example.com",
  "firstName": "Michael",
  "lastName": "Davis",
  "plan": [
    { "credits": "250", "creditsType": "sendLimit", "type": "free" }
  ],
  "relay": {
    "enabled": true,
    "data": { "port": 587, "relay": "smtp-relay.brevo.com", "userName": "michael.davis@example.com" }
  },
  "address": { "city": "New York", "country": "United States", "street": "456 Business Ave", "zipCode": "10001" },
  "marketingAutomation": { "enabled": true, "key": "ma8k2x9v4h7p3d6f1c5e8b2a" }
}
```

### Qué datos de cuota/estado devuelve
- `plan[]`: `type` (`free` | `subscription` | `payAsYouGo` | `sms`), `creditsType` (`sendLimit`), `credits` (**créditos restantes**), `startDate`, `endDate` (unix), `userLimit`.
- `relay.enabled`: si el **transaccional está habilitado** en esa cuenta → úsalo como pre-check antes de permitir envíos.
- `relay.data`: `relay` (host SMTP), `port`, `userName` — útil si algún día ofreces fallback SMTP.
- `enterprise` (bool) y `planVerticals[]` (desglose por Marketing/Chat/CRM con fechas, asientos y créditos) → sirven para inferir el **tier de rate limit** aplicable.
- `marketingAutomation.key`: tracker id (no relevante para transaccional).

**Flujo de alta de cliente sugerido:** (1) `GET /v3/account` → si 401 rechaza la key; si 200 guarda `organization_id`, `plan[].credits`, `relay.enabled` y el tier; (2) `GET /v3/senders` + `GET /v3/senders/domains` → precargar remitentes usables; (3) `POST /v3/webhooks` con URL única por cliente y `auth.token` propio; guardar el `id` devuelto para poder actualizar/borrar; (4) refrescar créditos en background (recuerda: 100 RPH para este bucket).

### Extra multi-cliente (modelo agencia)
Si la agencia usa cuentas **corporate/master**, existe `POST /v3/corporate/subAccount/key` (`{"id": <organizationId>, "name": "<nombre>"}` → `{"key":"…","status":"success"}`) para emitir claves de subcuenta desde la key maestra. Ref: https://developers.brevo.com/reference/create-an-api-key-for-a-sub-account. Requiere cuenta master/corporate.
### Incertidumbres (verificar a mano)
**1. Estructura exacta del payload de webhook batched (`batched: true`).** La página oficial https://developers.brevo.com/docs/batch-webhooks documenta la ventana (5 min) y el tamaño (500 eventos) pero **no publica un ejemplo del cuerpo que recibe tu endpoint** — no se puede confirmar si llega como array JSON desnudo (`[{...},{...}]`) o envuelto en un objeto (`{"items":[…]}` / `{"events":[…]}`). Ninguna fuente de terceros lo documenta tampoco. **Recomendación:** implementar el receptor tolerante (si `Array.isArray(body)` iterar; si es objeto con una única propiedad array, iterar esa; si no, tratar como evento único) y arrancar con `batched:false` hasta verificarlo empíricamente con un webhook de prueba.

**2. Ángulos `<>` en `message-id`.** La respuesta de POST /v3/smtp/email y GET /v3/smtp/emails muestran el id **con** ángulos (`<201798300811.5787683@relay.domain.com>`); los ejemplos de payload de webhook lo muestran **sin** ángulos. No he encontrado una nota oficial que aclare si es una inconsistencia de la documentación o del producto. **Deja la normalización obligatoria** (`replace(/^<|>$/g,'')`) en ambos sentidos e indexa la forma normalizada.

**3. Semántica del campo `id` en el payload del webhook.** La tabla de campos de la doc lo describe como "Webhook configuration identifier", pero los ejemplos muestran valores distintos por evento (12345, 25290, 26570) y guías de terceros lo usan como clave de deduplicación del evento. No confirmado. **Recomendación:** deduplicar por la tupla `(message-id normalizado, event, ts_event)` y guardar `id` como columna auxiliar, no como PK.

**4. `ts_epoch`: segundos o milisegundos.** La tabla de campos dice milisegundos, pero varios ejemplos oficiales lo muestran en segundos (1604933654) y otro en milisegundos (1724322809710). **Usa `ts_event` (segundos UTC, consistente en todos los ejemplos)** y trata `ts_epoch` defensivamente por magnitud.

**5. `error` y `proxy_open`/`unique_proxy_open` como eventos suscribibles.** La doc de payloads los documenta, pero **no aparecen en el enum de `events` de POST /v3/webhooks** para `type=transactional` (que sí incluye `sent` además de `request`). El filtro de statistics/events sí tiene `error` y `loadedByProxy`. No confirmado si se aceptan al crear el webhook. **Probar en el alta y capturar el 400 si el enum los rechaza.**

**6. Texto exacto del error al enviar desde remitente no verificado.** Confirmado que devuelve 400 con `invalid_parameter`, pero **no he encontrado la cadena `message` literal en documentación oficial** (las referencias a "Sender not valid" vienen de foros/help center, no de la API reference). No hardcodees el string: clasifica por `code` y guarda el `message` crudo para el panel.

**7. Límites de tamaño (20 MB total / 4 MB por adjunto).** Vienen del help center (https://help.brevo.com/hc/en-us/articles/4402811730962), **no de la API reference**, y ese artículo devolvió 403 al intentar leerlo directamente (los números proceden del extracto del buscador). La API reference solo confirma los 2.000/99 destinatarios y los 100 KB/1.000 KB de `params`. **Valida tú el tamaño antes de enviar con un umbral conservador (p.ej. 15 MB de payload total) y deja el límite en variable de entorno.**

**8. Número máximo de adjuntos por email.** No documentado en ninguna fuente consultada.

**9. Rango de IPs para whitelist de webhooks (`1.179.112.0/20`).** Procede del resumen de un artículo del help center, no verificado en la fuente primaria (https://help.brevo.com/hc/en-us/articles/15127404548498). Brevo puede cambiar rangos sin aviso. **No bases la seguridad del webhook solo en IP**: usa el `auth.token` bearer o una cabecera secreta por cliente, y la IP como refuerzo opcional configurable.

**10. Timeout que aplica Brevo al llamar tu webhook.** No documentado. **Responde 2xx inmediatamente y procesa en cola** (patrón BullMQ del repo de referencia), asumiendo un timeout corto (2–5 s).

**11. Política de reintentos contradictoria.** La doc de retry-mechanism dice que hay 4 reintentos, y a la vez que "4xx (salvo 429) y cualquier 5xx detienen todos los reintentos y descartan el webhook" — lo que dejaría a los reintentos sin caso de uso claro salvo timeouts/conexión. No se puede resolver desde la documentación. **Diseña asumiendo el peor caso: un evento puede perderse tras un único fallo → el reconciliador por API es obligatorio.**

**12. Rate limits específicos de `/v3/senders`, `/v3/webhooks`, `/v3/account` y `/v3/senders/domains`.** No aparecen como filas propias en la tabla; caen en "All other endpoints" (100 RPH general). No está explícitamente confirmado que `/v3/senders/domains` no tenga bucket propio. **Trátalos todos como 100 RPH y cachea.**

**13. Cuál es el bucket exacto de `GET /v3/smtp/statistics/events`.** Por el patrón de la URL debería caer en el comodín `All /v3/smtp/{…}` (300 RPH), ya que la nota solo excluye `POST /v3/smtp/email` y `GET /v3/smtp/blockedContacts` (y `GET /v3/smtp/emails` tiene fila propia). **No verificado empíricamente**; mide `x-sib-ratelimit-limit` en la primera llamada real y ajusta el limitador dinámicamente a partir de esa cabecera en lugar de hardcodear 300.

**14. Si `active: false` en GET /v3/senders puede significar "no verificado".** La doc solo dice "activated/deactivated". **No lo uses como proxy de verificación**: cruza siempre con `GET /v3/senders/domains/{dominio}` (`verified` / `authenticated`).

**15. Comportamiento de `contactPixelTrackingConsent` y de los eventos `proxy_open`** respecto a la privacidad de Apple MPP. Documentados como campos/eventos pero sin explicación de su efecto. Si el panel muestra tasas de apertura, avisa de que `proxy_open` infla los datos.

**16. Prerrequisitos de plan para `POST /v3/corporate/subAccount/key`.** La referencia no indica si exige Enterprise; solo se infiere que requiere cuenta master/corporate. Verificar con la cuenta real de la agencia antes de construir el flujo multi-subcuenta.


---

## SMTP saliente, tracking, rebotes y SMTP propio de GHL
### Resumen
Con nodemailer contra un SMTP generico solo se obtiene la confirmacion del PRIMER salto (respuesta 250 + accepted/rejected/response/messageId): nunca entrega real, ni bandeja, ni apertura. Todo lo demas (rebotes, quejas, bajas) es asincrono y hay que montarlo: Return-Path propio con VERP sobre un subdominio (bounces.dominio) capturado por buzon IMAP o webhook inbound, y parseo del DSN RFC 3464 (Action + Status + Diagnostic-Code) para clasificar hard/soft. El tracking propio (pixel 1x1 + reescritura de enlaces firmados sobre subdominio propio con HTTPS) es facil de implementar pero las aperturas estan infladas por Apple MPP y el proxy de Gmail, asi que el clic es la unica metrica seria. Las salvaguardas no son opcionales: verificacion DNS de propiedad del dominio antes de permitir un From, firma DKIM alineada, List-Unsubscribe + List-Unsubscribe-Post (RFC 8058) honrado en <48h, lista de supresion propia y limites por subcuenta. En GHL, Settings > Email Services > SMTP Service permite un proveedor propio por subcuenta (host, puerto, usuario, password, from name/email, TLS/SSL, checkbox "Enable reply" y "Default provider"), con precedencia subcuenta > agencia > LC Email; y la restriccion documentada mas importante es que el From debe coincidir con la cuenta SMTP o estar verificado. Montar una pasarela propia con smtp-server (AUTH LOGIN/PLAIN por subcuenta, TLS valido, limite de tamano, reenvio con nodemailer + mailparser) es tecnicamente viable y es el mismo patron que Mailgun/SendGrid, pero el punto duro no es el codigo sino el certificado TLS y el puerto TCP publicado en EasyPanel (Traefik solo enruta HTTP).
### Detalle
## A) ENVIO SMTP SALIENTE Y ESTADO DE ENTREGA

### A.1 Que se sabe REALMENTE en el momento del envio

`transporter.sendMail()` devuelve un objeto `info` cuyos campos son (transporte SMTP):

| Campo | Contenido | Que significa de verdad |
|---|---|---|
| `accepted` | array de direcciones aceptadas en `RCPT TO` | el servidor del siguiente salto se hace cargo, nada mas |
| `rejected` | array de direcciones rechazadas | rechazo en `RCPT TO` (esto SI es informacion util e inmediata) |
| `rejectedErrors` | errores asociados a cada rechazo | contiene `responseCode` por destinatario |
| `pending` | solo transporte Direct: rechazos temporales | irrelevante con SMTP generico |
| `response` | ultima linea de respuesta literal del servidor | p.ej. `250 2.0.0 Ok: queued as E8ABB3AD5C` |
| `envelope` | `{ from, to }` realmente usados en el sobre | el `from` de aqui es el Return-Path |
| `messageId` | valor de la cabecera `Message-ID` generada | clave de correlacion propia |

Reglas practicas:

- Con varios destinatarios, **la promesa se resuelve si al menos uno fue aceptado**: hay que inspeccionar `rejected` siempre, no basta con `try/catch`. Fuente: https://nodemailer.com/
- De `info.response` se puede extraer el **id de cola del proveedor** con un regex sobre `queued as ([A-Za-z0-9\-]+)` o `queued on \S+ as (\S+)`; guardarlo permite cruzar despues con los logs del proveedor. Discusiones: https://github.com/nodemailer/nodemailer/issues/422 y https://github.com/nodemailer/smtp-server/issues/130
- Guardar SIEMPRE los tres identificadores en la fila del envio: `message_id` (cabecera), `remote_queue_id` (parseado de la respuesta) y `verp_token` (ver A.2).

**Lo que NO se puede saber en ese momento** (limite duro del protocolo):
- si el mensaje llego a la bandeja, a spam o fue descartado silenciosamente;
- si la direccion existe (salvo rechazo explicito en `RCPT TO`; muchos servidores aceptan todo y rebotan despues → "backscatter"/rebote asincrono);
- si se abrio o se leyo;
- si el destinatario lo marco como spam (eso solo llega por FBL/ARF, no por SMTP);
- si el proveedor lo puso en cuarentena o lo diferio horas.

Un `250` significa exclusivamente **"acepto la responsabilidad de la entrega"**. Es una entrega "en cola", no una entrega.

Opcion adicional (limitada): nodemailer soporta DSN RFC 3461 por mensaje, pero **solo funciona si el servidor SMTP anuncia DSN en su EHLO** (la mayoria de ESPs comerciales no lo hacen):
```js
await transporter.sendMail({
  from: "sender@example.com", to: "recipient@example.com",
  subject: "Message", text: "...",
  dsn: { id: "msg-123", return: "headers", notify: ["failure","delay"], recipient: "bounces@midominio.com" }
});
```
Valores de `notify`: `success` / `failure` / `delay` / `never` (never no se combina). Fuente: https://nodemailer.com/message/dsn

### A.2 Rebotes asincronos: DSN, Return-Path y VERP

**Formato DSN (RFC 3464)** — https://www.rfc-editor.org/rfc/rfc3464.html · https://datatracker.ietf.org/doc/html/rfc3464

Un rebote bien formado es un `multipart/report; report-type=delivery-status` con 3 partes:
1. `text/plain` legible por humanos (inutil para maquinas, formato libre);
2. `message/delivery-status` → **la parte que se parsea**;
3. `message/rfc822` o `text/rfc822-headers` con el mensaje original (aqui vuelve tu `Message-ID`).

Campos de la parte 2, por destinatario:
```
Reporting-MTA: dns; mx.proveedor.com
Final-Recipient: rfc822; usuario@ejemplo.com
Original-Recipient: rfc822; usuario@ejemplo.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 <usuario@ejemplo.com> User unknown
Remote-MTA: dns; mx.ejemplo.com
```
- `Action` es vocabulario cerrado de 5 valores: `failed` (permanente, hard bounce), `delayed` (temporal, soft), `delivered`, `relayed`, `expanded`. Es obligatorio por destinatario.
- `Status` sigue RFC 3463 `X.Y.Z`: clase X = 2 exito / 4 transitorio / 5 permanente; Y = subject (1 addressing, 2 mailbox, 3 mail system, 4 network, 5 protocol, 6 media, 7 security).
- Regla de clasificacion: `Action: failed` + `5.x.x` → **suprimir la direccion**. `Action: delayed` + `4.x.x` → reintentar con backoff y suprimir tras N fallos. Casos tipicos: `5.1.1` usuario desconocido → borrar; `4.2.2` buzon lleno → reintentar. Guias: https://smtpedia.com/dsn-parsing-guide/ · https://smtpedia.com/rfc-3464/ · https://www.mailertogo.com/rfc/3464

**Return-Path / envelope sender**

El rebote NO va al `From:` visible, va al `MAIL FROM` (envelope sender = Return-Path). En nodemailer se controla con `envelope`:
```js
await transporter.sendMail({
  from: '"Mi Cliente" <hola@cliente.com>',        // cabecera From visible
  to: 'usuario@ejemplo.com',
  envelope: {
    from: 'rebote+9f3c1a2b@bounces.midominio.com', // MAIL FROM (VERP)
    to:   'usuario@ejemplo.com'
  },
  html: '...'
});
```
Ojo con DMARC: SPF se comprueba **contra el dominio del Return-Path**, no contra el From. Con alineacion relajada (por defecto) basta que compartan dominio organizacional: `bounces.cliente.com` alinea con `cliente.com`; pero `bounces.midominio.com` con `From: @cliente.com` **NO alinea SPF** → hay que apoyarse en DKIM alineado (`d=cliente.com`) para pasar DMARC. Fuentes: https://mxtoolbox.com/dmarc/dmarc/spf/custom-return-path-domain · https://www.suped.com/learn/spf/how-to-configure-spf-when-sending-from-a-subdomain-with-a-different-from-email-domain · https://powerdmarc.com/dmarc-alignment/

**VERP (Variable Envelope Return Path)** — https://en.wikipedia.org/wiki/Variable_envelope_return_path · https://www.sweego.io/channel/email/blog-verp-email-bounce-management-complete-guide · https://help.socketlabs.com/docs/variable-envelope-return-path

Idea: un `MAIL FROM` distinto por envio, con el id del envio codificado en la parte local. Asi el rebote se atribuye por la **direccion a la que llega**, sin parsear texto libre:
```
MAIL FROM: <rebote+ZW52aW8xMjM0@bounces.midominio.com>
```
Recomendaciones de implementacion:
- prefijo fijo (`rebote-`/`bounce-`) para distinguir VERP de correo normal;
- token opaco firmado (HMAC truncado) en vez del email del destinatario en claro (privacidad + evita cosecha);
- dominio de MAIL FROM constante y buzon catch-all en ese subdominio;
- longitud: dejar margen, la parte local no deberia pasar de ~64 caracteres.

**Que hay que montar para capturarlos** (tres opciones, de menos a mas trabajo):

1. **Buzon IMAP + polling** (`imapflow` + `mailparser`): un buzon catch-all en `bounces.midominio.com`, worker que lee no leidos, parsea, clasifica y marca. Es la opcion mas barata y no requiere abrir puertos. Docs: https://imapflow.com/docs/
2. **Webhook inbound de un proveedor**: Mailgun Routes (https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/routes) o SendGrid Inbound Parse (https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/setting-up-the-inbound-parse-webhook) reciben el MIME y hacen POST a tu endpoint. Si ya se usa uno de esos proveedores para el envio saliente, esto es casi gratis y ademas ellos ya normalizan los eventos `bounced`/`complained` (con firma HMAC-SHA256 que hay que **validar antes de deserializar el JSON**: si no, cualquiera puede POSTear rebotes falsos y suprimir direcciones legitimas).
3. **MX propio con `smtp-server` en el 25**: control total, pero el 25 entrante/saliente suele estar bloqueado en VPS y exige PTR y reputacion. No recomendable como primera version.

**Subdominio propio: obligatorio.** Un subdominio dedicado (`bounces.` o `rp.`) con su MX/SPF, separado del dominio corporativo, y que no tenga ya MX/CNAME de otro proveedor. Patrones y advertencias: https://help.socketlabs.com/docs/custom-bounce-domains · https://postmarkapp.com/support/article/910-how-do-i-add-a-custom-return-path · https://knowledge.hubspot.com/marketing-email/set-a-custom-return-path-for-an-email-sending-domain

### A.3 Tracking propio: pixel de apertura y clics

**Pixel 1x1**
```html
<img src="https://track.midominio.com/a/AbC123...xyz.gif" width="1" height="1" alt="" style="display:block;border:0" />
```
- Servir un GIF transparente 1x1 real (unos 43 bytes) con `Content-Type: image/gif`.
- Cabeceras anti-cache obligatorias: `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`, `Pragma: no-cache`, `Expires: 0`. Sin esto el proxy de Gmail cachea y las reaperturas se pierden.
- Token **opaco y firmado** (HMAC del id de envio) en la ruta, no query string con datos personales. Nunca poner el email en la URL.
- Colocarlo **al principio del HTML**: Gmail recorta el mensaje a partir de ~102 KB y el pixel al final no se carga.
- Registrar servidor-side: timestamp, IP, User-Agent, id de envio. Sirve tanto para metricas como para deteccion de abuso.
- Referencias: https://www.suped.com/knowledge/email-deliverability/technical/how-do-i-create-an-image-pixel-for-tracking-email-opens-and-clicks · https://varnan.tech/blog/email-tracking-pixels-engineering-guide

**Limites reales de las aperturas (importante decirselo al cliente en la UI):**
- **Apple Mail Privacy Protection** (desde sept-2021) precarga TODAS las imagenes en los servidores de Apple, se abra o no el correo → el pixel dispara igual. En listas con mucho Apple Mail las aperturas salen **15-40% infladas**. Aplica a Apple Mail aunque la cuenta sea de Gmail. https://postmarkapp.com/blog/how-apples-mail-privacy-changes-affect-email-open-tracking · https://www.beehiiv.com/blog/apple-mpp-open-rate
- **Proxy de imagenes de Gmail**: descarga y cachea la imagen en servidores de Google; ademas puede bloquear pixeles de remitentes desconocidos → aperturas duplicadas o infracontadas.
- Muchos clientes bloquean imagenes por defecto → infracontadas.
- Conclusion de la industria: la apertura ya no es metrica fiable (segun Litmus 2025 solo ~15% de marketers la usa como metrica principal); **el clic es la senal solida**. https://instantly.ai/blog/email-open-tracking-how-it-works-accuracy-rates-and-why-your-open-metrics-may-be-wrong/
- Mitigacion practica: marcar la apertura como `maquinal` cuando el UA/IP es de rango de proxy conocido o cuando ocurre < 2 s despues del envio, y mostrar dos columnas en el panel: "aperturas brutas" y "aperturas humanas estimadas".

**Clics (reescritura de enlaces)**
- Reescribir solo `href` `http(s)`. NUNCA reescribir `mailto:`, `tel:`, anclas, ni el endpoint de baja one-click (romperia RFC 8058).
- Endpoint `GET /c/<token>` → 302 al destino. El destino debe estar **guardado en BD indexado por token** o firmado con HMAC; jamas aceptar `?url=` sin firmar → seria un open redirect y ademas un imán para phishing.
- **Dominio de tracking propio y alineado**: subdominio del mismo dominio de envio (`track.cliente.com`), no un dominio compartido. Un dominio de tracking compartido hereda la reputacion de todos los demas remitentes. https://www.suped.com/knowledge/email-deliverability/technical/what-are-the-best-practices-for-email-link-cloaking-and-click-tracking
- **HTTPS obligatorio**: los enlaces HTTP suben el spam score; Gmail favorece HTTPS. https://www.suped.com/knowledge/email-deliverability/technical/do-http-tracking-links-affect-email-deliverability
- Riesgo asumido: un redirect `track.x/xyz` es indistinguible de un redirect de phishing para los gateways de seguridad (SEG), que pueden poner el correo en cuarentena. https://instantly.ai/blog/email-tracking-and-deliverability-why-tracking-pixels-can-hurt-your-inbox-placement/
- Los escaneres de seguridad corporativos **pre-visitan todos los enlaces** → clics falsos. Filtrar por UA/IP y deduplicar por (envio, enlace) en ventana corta.
- **Orden critico**: pixel y reescritura se aplican ANTES de firmar DKIM. Si se toca el cuerpo despues de firmar, la firma se rompe.

### A.4 Buenas practicas obligatorias (anti-spam y anti-abuso)

**Autenticacion y alineacion**
- SPF (TXT en el dominio del Return-Path), DKIM (clave por dominio de cliente) y DMARC. DMARC pasa si **SPF o DKIM** pasan Y estan alineados con el dominio del `From:`. https://powerdmarc.com/dmarc-alignment/ · https://redsift.com/guides/email-protocol-configuration-guide/all-you-need-to-know-about-spf-dkim-and-dmarc
- **DKIM alineado es el camino resiliente** (sobrevive a reenvios; SPF no, porque el Return-Path se reescribe). El `d=` de la firma debe ser el dominio del From (o su dominio organizacional con alineacion relajada).
- Cuidado con el limite de **10 lookups DNS de SPF**: cada `include:` de cada herramienta cuenta; si se pasa, SPF falla en silencio.
- Firmar con nodemailer (a nivel transporte o por mensaje; el de mensaje gana):
```js
const transporter = nodemailer.createTransport({
  host: "smtp.example.com", port: 465, secure: true,
  dkim: { domainName: "cliente.com", keySelector: "dd2026", privateKey: fs.readFileSync("./dkim.pem","utf8"), hashAlgo: "sha256" }
});
```
  Opciones: `domainName`, `keySelector`, `privateKey`, `keys[]` (rotacion/multidominio), `hashAlgo` (sha256 por defecto), `headerFieldNames`, `skipFields`, `cacheDir`, `cacheTreshold` (2 MB). https://nodemailer.com/dkim

**Requisitos de remitentes masivos (ya en vigor)**
- Gmail y Yahoo desde feb-2024 para >=5.000 mensajes/dia a cuentas personales: autenticacion completa, baja en un clic, y **tasa de spam < 0,3%** (por debajo de 0,1% como objetivo). Microsoft aplico reglas equivalentes a Outlook/Hotmail/Live en may-2025. Incumplir = rechazos temporales y permanentes. https://support.google.com/a/answer/14229414 · https://redsift.com/guides/bulk-email-sender-requirements

**List-Unsubscribe y RFC 8058**
```
List-Unsubscribe: <https://midominio.com/u/AbC123>, <mailto:baja@midominio.com?subject=unsubscribe>
List-Unsubscribe-Post: List-Unsubscribe=One-Click
```
- La URL **debe ser HTTPS** y el endpoint debe aceptar un `POST` con cuerpo `List-Unsubscribe=One-Click` (`application/x-www-form-urlencoded` o `multipart/form-data`). El proveedor NO abre el navegador: hace el POST directo.
- Sin landing, sin login, sin confirmacion. Procesar la baja en **menos de 48 h** (Gmail/Yahoo: 2 dias).
- La firma DKIM **debe cubrir** `List-Unsubscribe` y `List-Unsubscribe-Post`.
- El endpoint debe ser idempotente y tolerar POSTs repetidos; el token debe ser opaco y no adivinable (HMAC), porque cualquiera con la URL puede dar de baja.
- Con nodemailer se puede usar el helper `list` (genera `List-*` de RFC 2369) pero `List-Unsubscribe-Post` hay que anadirlo por `headers` porque no es una URL:
```js
list: { unsubscribe: [ "https://midominio.com/u/AbC123", "mailto:baja@midominio.com?subject=unsubscribe" ] },
headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
```
  https://nodemailer.com/message/list-headers · https://www.mailgun.com/blog/deliverability/what-is-rfc-8058/ · https://docs.customer.io/messaging/channels/email/deliverability/custom-unsubscribe-links/

**Lista de supresion propia (no negociable)**
- Tres tipos: **rebotes duros**, **quejas** (FBL/ARF) y **bajas**. Consultar SIEMPRE antes de encolar cada destinatario, con indice unico por `(location_id, email_normalizado)` y ademas una tabla global de la agencia.
- Hard bounce → supresion inmediata y permanente. Soft bounce → contador con reintentos limitados y escalado a supresion.
- La supresion debe ser **irreversible desde la UI del cliente** salvo accion explicita y auditada; si no, la app se convierte en un vector para reenviar a direcciones muertas.
- https://help.mailgun.com/hc/en-us/articles/360012287493-Suppressions-Bounces-Complaints-Unsubscribes-Allowlists · https://senderreputation.org/blog/automated-bounce-handling-pipeline-guide

**Limites por subcuenta**
- Cuota diaria y horaria por `location_id`, concurrencia maxima, tamano de rafaga, y limite de destinatarios por mensaje. Es imprescindible porque **GHL dispara todos los envios de un workflow a la vez sin throttling propio** (https://mailflowauthority.com/gohighlevel-email/gohighlevel-smtp-setup).
- Umbral automatico de corte: si la tasa de rebote duro supera ~2-5% o hay quejas, pausar la subcuenta y avisar.
- Reutilizar el patron de planes/avisos ya existente en `marketplace-disruptivo`.

**Por que hay que impedir enviar desde dominios que el usuario no controla**
- Sin esa comprobacion la app es literalmente un **open relay autenticado**: cualquier cliente podria poner `From: soporte@banco.com` y hacer phishing con la IP y la reputacion de la agencia. El resultado es blacklisting de la IP, cierre de cuenta en el proveedor upstream y responsabilidad legal.
- Control minimo: verificacion de propiedad por **TXT DNS con token unico** (`_dd-verify.cliente.com = dd-verify=<token>`) antes de habilitar cualquier `From` en ese dominio; publicacion del selector DKIM; y rechazo en el momento del envio si `From.domain ∉ dominios_verificados[location_id]`.
- Rechazar tambien `From` en dominios de correo gratuito (gmail.com, yahoo.com, hotmail.com): tienen DMARC `p=reject` y el envio fallara ademas de ser spoofing.
- Referencias: https://oneuptime.com/blog/post/2026-01-28-dns-txt-records-verification/view · https://support.mailchannels.com/hc/en-us/articles/16918954360845-Secure-your-domain-name-against-spoofing-with-Domain-Lockdown · https://www.duocircle.com/blog/email-security/smtp-open-relay-vulnerabilities-how-to-prevent-security-breaches/

### A.5 Configuracion practica de nodemailer

**Pool y rate limiting** (https://nodemailer.com/smtp/pooled)

| Opcion | Defecto | Nota |
|---|---|---|
| `pool` | `false` | poner `true` para envio continuo |
| `maxConnections` | `5` | subir a 10-20 si el proveedor lo permite; nunca `Infinity` |
| `maxMessages` | `100` | mensajes por conexion antes de reciclarla |
| `maxRequeues` | ilimitado | reintentos si la conexion cae a media |
| `rateDelta` | `1000` (ms) | ventana de medicion |
| `rateLimit` | `0` (sin limite) | mensajes maximos por ventana |

- Metodos/eventos: `transporter.isIdle()`, evento `idle` (patron pull: sacar de la cola solo cuando hay hueco), evento `clear`, `transporter.close()` en el `SIGTERM` (encaja con el cierre ordenado que ya hace `src/index.js` del repo de referencia).
- Con BullMQ (ya en el stack del ticket-system) lo natural es: worker con concurrencia = `maxConnections`, `rateLimit` de nodemailer como red de seguridad y `limiter` de BullMQ como control real por subcuenta.
- Aviso conocido: el `rateLimit` del pool se ha comportado de forma discutible en algunas versiones (https://github.com/nodemailer/nodemailer/issues/768, https://github.com/nodemailer/nodemailer/issues/827) → no confiar solo en el.

**Timeouts** (https://nodemailer.com/smtp) — los defectos son altisimos, hay que bajarlos:

| Opcion | Defecto | Recomendado |
|---|---|---|
| `connectionTimeout` | `120000` (2 min) | 10.000-15.000 |
| `greetingTimeout` | `30000` | 10.000 |
| `socketTimeout` | `600000` (10 min) | 60.000-120.000 |
| `dnsTimeout` | `30000` | 10.000 |

**STARTTLS (587) vs SSL implicito (465)**
```js
// 587 - STARTTLS (recomendado por defecto)
{ host, port: 587, secure: false, requireTLS: true,
  tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, servername: host },
  auth: { user, pass } }

// 465 - TLS implicito
{ host, port: 465, secure: true,
  tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  auth: { user, pass } }
```
- `secure: false` NO significa sin cifrado: significa "empieza en claro y sube a TLS con STARTTLS". Por eso `requireTLS: true` es obligatorio: sin el, si el servidor no anuncia STARTTLS el mensaje sale en claro.
- `port` por defecto `587` (o `465` si `secure: true`). `ignoreTLS: true` no se debe usar nunca en produccion. `rejectUnauthorized: false` solo en desarrollo, y hay que dejarlo fuera de la configuracion que puede tocar el cliente.
- `transporter.verify()` al guardar credenciales en el panel: valida conexion + AUTH sin enviar nada.

**Errores y politica de reintentos** (https://nodemailer.com/errors)

Codigos de nodemailer: `EAUTH` (credenciales), `ECONNECTION`, `ETIMEDOUT`, `EENVELOPE` (MAIL FROM/RCPT TO rechazado), `EMESSAGE` (contenido/tamano/politica), `ESOCKET`, `EDNS`, `ESTREAM`. Forma del error:
```js
{ message: 'Invalid login: 535 5.7.8 Authentication failed',
  code: 'EAUTH', command: 'AUTH PLAIN',
  response: '535 5.7.8 Authentication failed', responseCode: 535 }
```
Clasificacion por `err.responseCode`:
- **4xx = temporal → reintentar** con backoff exponencial + jitter (p.ej. 1m, 5m, 30m, 2h, 6h; max 5 intentos). `421` servicio no disponible, `450`/`451`/`452` buzon/sistema/almacenamiento temporal, `454` fallo temporal de TLS/AUTH. Tambien greylisting (el servidor difiere el primer intento a proposito y acepta el segundo).
- **5xx = permanente → NO reintentar**, marcar fallido y, si es de destinatario, suprimir. `535` credenciales invalidas (pausar la subcuenta y avisar, no reintentar en bucle), `550` buzon no disponible / no verificado, `552` mensaje demasiado grande, `553` sintaxis de buzon invalida, `554` rechazo por politica.
- Excepcion importante: `EAUTH`/`535` NO se debe reintentar automaticamente; a los pocos intentos el proveedor bloquea la cuenta.
- Errores de red (`ECONNECTION`, `ESOCKET`, `ETIMEDOUT`, `EDNS`) → tratar como temporales.

---

## B) SMTP PERSONALIZADO EN GHL

### B.1 Que ofrece exactamente y que campos pide

**Ruta**: subcuenta → `Settings` → `Email Services` → pestana `SMTP Service` → boton `+ Add Service` (arriba a la derecha). Fuente oficial: https://help.gohighlevel.com/support/solutions/articles/155000007765-how-to-add-your-own-email-service-smtp-

**Opciones del selector de proveedor** (segun el articulo oficial): `Gmail`, `Yahoo`, `SendGrid`, `Other` (que cubre Mailgun, Amazon SES, Postmark, Zoho y cualquier servicio compatible SMTP), ademas del sistema por defecto `LeadConnector Email` (LC Email) y la integracion dedicada de `Mailgun` por API key privada.

**Campos para SMTP generico** (nombres literales del articulo oficial):
1. `SMTP Host` — "The outgoing mail server address (e.g., smtp.sendgrid.net)"
2. `Port` — "Usually 587 (TLS) or 465 (SSL)"
3. `Username` — "Your SMTP login username or API key identifier"
4. `Password / API Key` — "Your SMTP password or API key from the provider"
5. `From Name` — "The display name that recipients will see"
6. `From Email` — "The email address emails will be sent from"

Ademas, en la ficha del servicio hay dos checkboxes relevantes:
- `Default Provider` — marca ese servicio como el que se usa por defecto en la subcuenta.
- `Enable reply` — si esta marcado, las respuestas entrantes a los correos enviados por ese SMTP se reciben y se registran dentro de Conversations. (Nota: GHL **no** soporta IMAP/POP como tal; los buzones no estan alojados en GHL.) https://mailflowauthority.com/gohighlevel-email/gohighlevel-smtp-setup

**Caso SendGrid** (integracion con campos reducidos, sin host/puerto): `Username` = la cadena literal `apikey`, `Email` = el email de login de SendGrid, `Password` = la API key. Requiere 2FA activo en SendGrid y un **sender identity verificado**; si el From no esta verificado el envio devuelve `550`. https://help.gohighlevel.com/support/solutions/articles/48001166110-using-sendgrid-as-the-smtp-provider

**Caso Mailgun**: no es SMTP sino API — se pega la **Private API Key** de Mailgun; con eso GHL accede a los dominios verificados, envia y **procesa respuestas**. Es el unico proveedor con visibilidad completa de metricas (delivered, bounced, unsubscribed, spam complaints). https://help.gohighlevel.com/support/solutions/articles/48000981682-mailgun-api-key-where-to-find-in-mailgun-put-in-highlevel

**Orden de precedencia del proveedor** (literal del soporte de GHL, https://help.gohighlevel.com/support/solutions/articles/48001209681-what-will-be-the-order-of-smtp-mailgun-integration-we-will-use-to-send-emails-):
1. Sub-account Default Provider (vista de subcuenta)
2. Email Settings for Locations (vista de agencia)
3. Agency Default provider
4. LeadConnector Email (fallback)

**Limitaciones documentadas al usar SMTP propio** (criticas para el diseno de la app):
- GHL **solo registra opens y clicks** (con su propio pixel y su reescritura de enlaces). `Delivered`, `Bounced` y `Deferred` no se actualizan: el estado se queda en `Sent`. "Always trust your ESP for delivery confirmation". https://mailflowauthority.com/gohighlevel-email/gohighlevel-email-statuses-explained
- La supresion por rebote **no se sincroniza de vuelta**: GHL sigue intentando enviar a direcciones que el ESP ya sabe muertas.
- Se pierden las herramientas nativas: dominios/IPs gestionadas, Postmaster Tools, Risk Assessment, Bounce Classification, Inbox Placement, Spam Score Checker, Blacklist Monitor.
- **No hay throttling**: GHL intenta enviar todo el lote de golpe contra tu SMTP.
- → Esto es exactamente el hueco que justifica la app: la app se convierte en la fuente de verdad de estado de entrega, rebotes y supresiones, y devuelve el estado a GHL por API/tags/custom fields.

### B.2 Puertos, modos TLS y validacion del remitente

- Puertos documentados: **587 con TLS/STARTTLS** (recomendado) y **465 con SSL** (TLS implicito). El formulario incluye un selector de tipo de seguridad (TLS/SSL). https://help.gohighlevel.com/support/solutions/articles/48001173743-using-zoho-as-your-smtp-provider ("465 with SSL — or — 587 with TLS")
- **Validacion del remitente**: si. Dos capas distintas:
  1. **Enhanced Email Verification for Campaigns** (GHL): antes de enviar una campana hay que verificar el From con un **OTP de 6 digitos** enviado a esa direccion; aparece un boton `Verify Now` junto a la direccion no verificada. Excepciones: dominios personalizados emitidos bajo LC Email (propiedad ya verificada) y el email de admin de la Location. https://help.gohighlevel.com/support/solutions/articles/155000003090-enhanced-email-verification-for-campaigns-
  2. **Coincidencia From ↔ cuenta SMTP**: la causa numero uno de fallo documentada por GHL es "the sender email doesn't match the SMTP email you've configured". Si se usa sender masking, la direccion enmascarada debe coincidir con el email del SMTP integrado o estar verificada en el proveedor. https://help.gohighlevel.com/support/solutions/articles/48001203144-limitation-of-using-smtp-when-emails-are-not-sending
- Los errores de envio se ven pinchando el icono de triangulo rojo dentro de Conversations.

### B.3 Viabilidad de una pasarela SMTP propia con `smtp-server`

**Veredicto: viable.** Es exactamente el patron de Mailgun/SendGrid/Postmark y usa una integracion soportada por GHL (SMTP generico). Lo dificil no es el codigo, es el TLS y el puerto.

**Opciones de `SMTPServer`** (https://nodemailer.com/extras/smtp-server) con los valores que interesan para la pasarela:

| Opcion | Defecto | Valor para la pasarela |
|---|---|---|
| `secure` | `false` | `true` en el listener 465; `false` + STARTTLS en el 587 |
| `key` / `cert` / `ca` | — | certificado valido de `smtp.midominio.com` |
| `name` | hostname | `smtp.midominio.com` (aparece en el banner y en Received) |
| `banner` | — | texto propio |
| `size` | `0` (ilimitado) | `26214400` (25 MB) o `31457280` |
| `hideSize` | `false` | dejar `false`: anunciar SIZE en EHLO |
| `authMethods` | `['LOGIN','PLAIN']` | dejarlo asi (es justo lo que usa GHL) |
| `authOptional` | `false` | `false` — auth obligatoria |
| `allowInsecureAuth` | `false` | `false` — nunca AUTH sin TLS |
| `hideSTARTTLS` | `false` | `false` en el 587 |
| `disabledCommands` | — | `['VRFY','EXPN']` no aplican (no soportados/no exponer) |
| `maxClients` | `Infinity` | poner un limite real (p.ej. 200) |
| `socketTimeout` | `60000` | ok |
| `closeTimeout` | `30000` | ok, para el cierre ordenado |
| `disableReverseLookup` | `false` | `true` si el DNS inverso ralentiza |
| `sniOptions` | — | util si se ofrecen varios hostnames |
| `logger` | `false` | logger compatible bunyan |

Extensiones soportadas: PIPELINING, 8BITMIME, SMTPUTF8, SIZE, DSN, ENHANCEDSTATUSCODES, REQUIRETLS. **CHUNKING/BDAT NO estan soportados** (irrelevante si el cliente es nodemailer, que usa DATA).

**Esqueleto de la pasarela**
```js
const { SMTPServer } = require('smtp-server');
const { simpleParser } = require('mailparser');

const server = new SMTPServer({
  name: 'smtp.midominio.com',
  secure: false,              // 587 + STARTTLS
  key: fs.readFileSync(process.env.TLS_KEY),
  cert: fs.readFileSync(process.env.TLS_CERT),
  authMethods: ['PLAIN', 'LOGIN'],
  authOptional: false,
  allowInsecureAuth: false,
  size: 25 * 1024 * 1024,
  maxClients: 200,

  // 1) credenciales por subcuenta
  async onAuth(auth, session, callback) {
    const cred = await buscarCredencial(auth.username);          // usuario = dd_<locationId>
    if (!cred || !(await verificarHash(auth.password, cred.hash))) {
      const err = new Error('Credenciales invalidas');
      err.responseCode = 535;                                     // 535 5.7.8
      return callback(err);
    }
    callback(null, { user: { locationId: cred.location_id, planId: cred.plan_id } });
  },

  // 2) el sobre solo puede salir de un dominio verificado por ese tenant
  async onMailFrom(address, session, callback) {
    const dominio = address.address.split('@')[1].toLowerCase();
    if (!(await dominioVerificado(session.user.locationId, dominio))) {
      const err = new Error('Dominio remitente no verificado para esta cuenta');
      err.responseCode = 553;
      return callback(err);
    }
    if (await cuotaAgotada(session.user.locationId)) {
      const err = new Error('Cuota de envio agotada');
      err.responseCode = 452;                                     // temporal: GHL reintentara
      return callback(err);
    }
    callback();
  },

  async onRcptTo(address, session, callback) {
    if (session.envelope.rcptTo.length >= 50) {                    // limite por transaccion
      const err = new Error('Demasiados destinatarios'); err.responseCode = 452; return callback(err);
    }
    if (await estaSuprimido(session.user.locationId, address.address)) {
      const err = new Error('Direccion suprimida'); err.responseCode = 550; return callback(err);
    }
    callback();
  },

  // 3) recibir, parsear, encolar
  onData(stream, session, callback) {
    const trozos = [];
    stream.on('data', c => trozos.push(c));
    stream.on('end', async () => {
      if (stream.sizeExceeded) {
        const err = new Error('Mensaje demasiado grande');
        err.responseCode = 552;
        return callback(err);
      }
      const crudo = Buffer.concat(trozos);
      try {
        const id = await encolarEnvio(session, crudo);             // BullMQ
        callback(null, `250 2.0.0 Aceptado id=${id}`);             // el id vuelve a GHL en info.response
      } catch (e) {
        const err = new Error('Error temporal'); err.responseCode = 451; callback(err);
      }
    });
  },

  onClose(session) { /* metricas */ }
});
server.listen(587);
```
Notas del objeto `session`: `id`, `remoteAddress`, `clientHostname`, `hostNameAppearsAs`, `envelope` (`mailFrom`, `rcptTo`, `bodyType`, `smtpUtf8`, `requireTLS`, `dsn`), `user` (lo que devuelve `onAuth`), `transaction`, `transmissionType`, `secure`, `servername`. El objeto `auth` en PLAIN/LOGIN trae `method`, `username`, `password`.

**Requisitos de infraestructura**
- **Certificado TLS valido** para el hostname que se ponga en `SMTP Host` (`smtp.midominio.com`). Let's Encrypt sirve, pero **no se puede usar el reto HTTP-01 gestionado por Traefik**: Traefik/EasyPanel solo enruta HTTP y el certificado tiene que estar dentro del contenedor de la app. Opciones: (a) reto **DNS-01** con certbot/lego y volumen compartido, montando `fullchain.pem`/`privkey.pem`; (b) sidecar certbot que renueva en un volumen y la app recarga el contexto TLS. El PTR/DNS inverso no es requisito para que TLS funcione, pero sí ayuda a la reputacion si algun dia se envia directo. https://community.letsencrypt.org/t/certificate-for-smtp-tls/143920 · https://www.hostmycode.com/tutorials/smtp-tls-troubleshooting-tutorial-2026-fix-starttls-certificate-port-587-hosting-vps
- **Puerto expuesto en EasyPanel**: en el servicio de tipo App hay una seccion `Ports`: "Ports publish non-HTTP TCP or UDP traffic directly from the server", con `Published` = "the port on the server" y `Target` = "the port inside the App container", protocolo TCP/UDP. "Published ports must not conflict with another service". Los `Domains` solo valen para HTTP/HTTPS. https://easypanel.io/docs/services/app
- **Bloqueo de puertos del VPS**: muchos proveedores bloquean por defecto 25/465/587 (al menos salientes) para frenar spam; hay que pedir el desbloqueo al hosting. Publicar el 587 y/o el 465 entrantes suele ser posible, pero conviene confirmarlo con el proveedor antes de prometer nada.
- **AUTH LOGIN/PLAIN**: es el defecto de `smtp-server` y coincide con lo que espera GHL. Nunca con `allowInsecureAuth: true`.
- **Limite de tamano**: 25 MB es el estandar de facto (Gmail/Yahoo 25 MB, Outlook.com 20 MB). Ojo: base64 anade ~33-37% → un adjunto de 18 MB ocupa 25 MB en el cable; anunciar SIZE con margen y devolver `552` si se pasa. https://www.suped.com/knowledge/email-deliverability/technical/what-are-the-attachment-and-message-size-limits-for-different-mailbox-providers

**Salvaguardas anti-abuso de la pasarela (obligatorias, no opcionales)**
1. `authOptional: false` + `allowInsecureAuth: false` → nunca relay anonimo ni credenciales en claro.
2. Credenciales **por subcuenta**, generadas por la app, almacenadas con scrypt (reutilizar `src/lib/crypto.js` del repo de referencia) y **rotables/revocables** desde el panel.
3. Enforcement del dominio en `onMailFrom` **y** del `From:` de cabecera en `onData` (un cliente puede poner un MAIL FROM valido y un From falso). Rechazo `553`/`550`.
4. Verificacion previa de propiedad del dominio por TXT DNS antes de habilitarlo.
5. Cuotas por subcuenta (hora/dia), maximo de destinatarios por transaccion, `maxClients` y rate limit por IP de origen.
6. Lista de supresion consultada en `onRcptTo` (rechazo temprano = no se transfieren megas inutiles).
7. Logging integro: sesion, IP, usuario, MAIL FROM, RCPT TO, tamano, resultado. Alertas por picos y por tasa de rebote.
8. Rechazar dominios de correo gratuito como From y dominios de terceros no verificados.
9. Deshabilitar cualquier forma de enumeracion de usuarios (no dar respuestas distintas segun si el destinatario existe).

**Alternativa mas barata si el TLS/puerto se atasca**: no montar servidor SMTP. Configurar en GHL directamente el SMTP del proveedor real (Brevo/SES) y hacer que la app consuma los **webhooks de eventos del proveedor** + la API de GHL para escribir estado, tags y supresiones. Se pierde el control del cuerpo (pixel/enlaces propios) pero se gana toda la fiabilidad operativa.

### B.4 Parseo del correo entrante y reescritura/validacion del From

**mailparser** (https://nodemailer.com/extras/mailparser):
```js
const { simpleParser } = require('mailparser');
const mail = await simpleParser(crudo);   // Buffer | String | stream
```
El objeto devuelto trae: `headers` (Map con claves en minusculas), `headerLines` (array de lineas crudas), `subject`, `from`, `to`, `cc`, `bcc`, `replyTo` (objetos de direccion con `value[]`, `text`, `html`), `date`, `messageId`, `inReplyTo`, `references`, `html`, `text`, `textAsHtml`, `attachments`.

Forma de un objeto de direccion:
```js
{ value: [ { name: "Jane Doe", address: "jane@example.com" } ],
  text: "\"Jane Doe\" <jane@example.com>", html: "..." }
```
- `simpleParser` **bufferiza todo en memoria**, adjuntos incluidos. Para la pasarela con limite de 25 MB es aceptable, pero conviene usar la clase `MailParser` (Transform stream, emite los adjuntos como streams y requiere `attachment.release()`) si se sube el limite.
- Que registrar en la fila del envio: `message_id` original de GHL, `from`, destinatarios, `subject`, tamano, `date`, y guardar el MIME crudo en almacenamiento (o al menos las cabeceras) durante N dias para reenvios y auditoria.

**Validacion y reescritura del From**
- Regla: **validar y rechazar, no reescribir en silencio**. Si `mail.from.value[0].address` no pertenece a un dominio verificado del tenant → responder `550` en `onData`. Reescribir el From de otro sin avisar rompe la trazabilidad y es indistinguible de spoofing.
- Reescritura legitima permitida: 
  - `Return-Path`/`MAIL FROM` → sustituirlo por el VERP propio (esto es lo normal y lo que hacen todos los ESP);
  - `Reply-To` → fijarlo al From original si el envio sale con un From de subdominio propio;
  - anadir `List-Unsubscribe`, `List-Unsubscribe-Post` y cabeceras de correlacion (`X-DD-Envio-Id`);
  - insertar pixel y reescribir enlaces en el `html`.
- **Orden obligatorio**: (1) parsear, (2) validar From, (3) modificar cuerpo y cabeceras, (4) **firmar DKIM al final** con la clave del dominio del cliente, (5) entregar al proveedor real con `envelope.from` = VERP. Si se firma antes de tocar el cuerpo, la firma queda invalidada.
- Al reenviar con nodemailer se puede pasar el MIME ya construido con `raw`, pero entonces hay que anadir uno mismo las cabeceras; suele ser mas limpio reconstruir el mensaje desde el objeto parseado y dejar que nodemailer firme con su opcion `dkim`.
- Reenvio y DMARC: al reenviar se reescribe el Return-Path (SPF deja de alinear), por eso **DKIM alineado con el dominio del From es el unico camino robusto**.
### Incertidumbres (verificar a mano)
**A) Envio SMTP**

1. **Tamano exacto del GIF 1x1**: las fuentes dan cifras contradictorias (34 bytes en base64 vs ~43 bytes binarios). Irrelevante funcionalmente, pero no lo doy por confirmado; generar el GIF y medirlo.
2. **Comportamiento real de `rateLimit`/`rateDelta` en el pool**: hay issues abiertas/cerradas (nodemailer #768 y #827) sugiriendo que el limite no siempre se comparte bien entre conexiones. No confiar solo en nodemailer: poner el limitador autoritativo en BullMQ y verificarlo con una prueba de carga.
3. **Deteccion fiable de Apple MPP**: no existe una lista publica y estable de rangos IP/User-Agent de los proxys de Apple/Gmail. La heuristica (apertura < N segundos, UA conocido) hay que calibrarla con datos propios; no hay fuente autoritativa.
4. **Version exacta del RFC de alineacion DMARC**: una fuente cita "RFC 9989" para la comparacion por dominio organizacional. No he verificado ese numero de RFC (DMARC se estandarizo como RFC 7489 y hay trabajo posterior en DMARCbis). Verificar antes de citarlo en documentacion del cliente.
5. **Formato exacto de las cabeceras que Gmail/Yahoo exigen firmar con DKIM** mas alla de `List-Unsubscribe` y `List-Unsubscribe-Post`: confirmar con la guia oficial de Google antes de cerrar el generador de cabeceras.

**B) GHL**

6. **Etiquetas literales exactas del formulario de "Other"/SMTP generico**: el articulo oficial lista los seis campos (SMTP Host, Port, Username, Password/API Key, From Name, From Email) pero **no he podido confirmar con captura el nombre exacto del selector de seguridad** (¿"Secure", "Encryption", "TLS/SSL", o un checkbox "Use SSL"?). Hay que abrir una subcuenta real y mirarlo. Dejarlo configurable.
7. **Puertos aceptados mas alla de 587 y 465**: la documentacion solo menciona esos dos. **No esta confirmado si GHL acepta 2525, 25 o un puerto arbitrario** (relevante si el hosting bloquea 587/465). Probar con un puerto no estandar en un entorno de pruebas.
8. **Si GHL valida las credenciales al guardar**: ninguna fuente oficial dice que se haga un `verify()`/envio de prueba al pulsar Guardar. El metodo de comprobacion documentado es indirecto (enviar un correo desde Conversations y mirar el icono de error). Asumir que **no** valida al guardar y disenar la pasarela para devolver errores SMTP claros y legibles.
9. **Si GHL usa nodemailer u otro cliente SMTP**, y por tanto si usa DATA o podria intentar CHUNKING/BDAT (que `smtp-server` NO soporta), si hace PIPELINING, y si reutiliza conexiones o abre una por mensaje. Sin confirmar. Impacta directamente en el dimensionado de `maxClients` y en el riesgo de fallo. Hay que capturarlo con un servidor de pruebas y logging completo.
10. **Limite de tamano de mensaje que impone GHL** al construir el correo (adjuntos de workflows): no documentado. Anunciar SIZE generoso (25-30 MB) y medir en real.
11. **Comportamiento de GHL ante un `4xx` temporal**: si reintenta, cuantas veces y con que espaciado. No documentado. Es critico porque el diseno propuesto devuelve `452` cuando se agota la cuota de la subcuenta; si GHL no reintenta, ese envio se pierde. Probar antes de usar `4xx` como mecanismo de throttling; alternativa segura: aceptar con `250` y hacer el throttling en la cola propia.
12. **Alcance real del checkbox "Enable reply"** con un SMTP generico: se documenta que las respuestas entrantes se registran en Conversations, pero no como llegan a GHL si el buzon no esta alojado alli (¿Reply-To reescrito a un dominio de LeadConnector?). Si es asi, el `Reply-To` que ponga nuestra pasarela podria entrar en conflicto. Verificar con un envio real y leer las cabeceras del mensaje que sale.
13. **Bloqueo de puertos SMTP en el VPS/EasyPanel concreto del usuario**: una fuente indica que 25/24/2525/387/465/587 estan bloqueados por defecto en muchos VPS. No se ha comprobado el proveedor concreto. Confirmar entrante y saliente con el hosting antes de comprometerse con la pasarela.
14. **Estrategia de certificado dentro del contenedor de EasyPanel**: la documentacion confirma que `Ports` publica TCP directo y que `Domains` es solo HTTP, pero **no hay documentacion oficial sobre como obtener/renovar un certificado Let's Encrypt para un servicio TCP en EasyPanel**. La ruta DNS-01 + volumen es una inferencia razonable, no un procedimiento documentado. Es el mayor riesgo de la opcion B.3.
15. **Ruta de la carpeta destino**: no he creado nada en `C:/Users/keytb/OneDrive/Escritorio/PROYECTOS IA/CLAUDE/emails-disruptivo`; esta investigacion es solo documental.


---

## NODOS de workflow de GHL (custom actions)
### Resumen
Las Custom Workflow Actions de GHL se declaran íntegramente en el panel del Marketplace (Modules > Workflow > Create Action), no por API ni por manifiesto: se define Name/Key/Icon/Descripción, una lista de campos tipados, y una URL de ejecución (POST por defecto) con cabeceras fijas que pone el desarrollador. Los dropdowns con opciones desde nuestro servidor SÍ existen (Option Type "External API", GET que devuelve {"options":[{"label","value"}]}), pero ese GET NO recibe contexto documentado (ni locationId ni el valor de otros campos), así que NO sirve para encadenar; el encadenamiento real (elegir proveedor y que el segundo desplegable dependa de él) se hace con un campo de tipo Dynamic + la opción "Alters Dynamic Field" en el campo padre: GHL hace POST a nuestra URL con {data, extras, meta} y nosotros devolvemos {"inputs":[{section, fields:[...]}]} con las options ya filtradas. Solo se permite UN campo Dynamic por acción, así que ese campo debe generar todo lo dependiente. El body de ejecución es siempre {data:{...campos...}, extras:{locationId, contactId, workflowId}, meta:{key, version}}, y la respuesta se mapea a Custom Variables usables en pasos posteriores ({{mi_accion.mi_variable}}) mediante un JSON de muestra que se registra en "Response Data". Se pueden declarar varias acciones en la misma app (límite reportado por la comunidad: 20), y la firma Ed25519 X-GHL-Signature está documentada para los webhooks de eventos pero NO confirmada para el POST de ejecución de la acción: hay que protegerse con un secreto propio en cabecera/URL.
### Detalle
> Fuentes principales (todo verificado sobre el HTML servido, no de memoria):
> - https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomActions
> - https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomTriggers
> - https://marketplace.gohighlevel.com/docs/marketplace-modules/WorkflowActionsAndTriggers
> - https://help.gohighlevel.com/support/solutions/articles/155000000571-marketplace-workflow-actions
> - https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide
> - https://marketplace.gohighlevel.com/docs/oauth/ExternalAuthentication y .../docs/oauth/external-auth/OAuth2 , .../external-auth/BasicAuth
> - https://ideas.gohighlevel.com/changelog/marketplace-action-enhancements
> - https://ideas.gohighlevel.com/changelog/introducing-branches-and-pause-execution-for-marketplace-actions
> - https://ideas.gohighlevel.com/changelog/allow-custom-fields-in-marketplace-actions-and-triggers
> - https://ideas.gohighlevel.com/app-marketplace/p/increase-limit-for-custom-actions

---

## 1) Cómo se declara una accion personalizada

**No hay manifiesto ni endpoint de registro.** Todo se declara a mano en el panel del Developer Marketplace y se versiona con revisión humana de HighLevel.

**Ruta UI:** Developer Marketplace > My Apps > (tu app) > menú izquierdo "Modules" > **Workflow** > **Create Action**.

**Prerrequisito obligatorio (literal de la doc):** *"workflows.readonly scope should be turned on to enable actions and triggers."* Los scopes solo se pueden tocar mientras la app está en draft; una vez live quedan bloqueados hasta crear un nuevo draft.

### Pantalla "Action Information"
| Campo | Descripción (literal) |
|---|---|
| **Name** | "Provide a descriptive name for your action." |
| **Key** | "A unique identifier for this action, used to reference the action inside the workflow. This value cannot be changed later. Example: `{{mycustomaction.data.name}}`" — también citado como `{{action_a.custom_variable}}`. **Inmutable.** |
| **Icon** | Icono mostrado en el constructor de workflows. |
| **Short description** | Subtítulo dentro del nodo en el workflow. |
| **Summary** | Descripción larga de la funcionalidad. |

### Pantalla "Action Configuration" > Manage Fields > Create New Field
| Propiedad | Descripción (literal) |
|---|---|
| **Name** | "Enter Field Name" (etiqueta visible). |
| **Type** | Tipo de campo (lista abajo). |
| **Required** | "Enable if this is a required field in workflow." |
| **Reference** | "Enter unique reference key. The value of this field will be bind to the provided key. Example: `action_a_name`" → **esta es la clave que llega en `data`**. |
| **Default Value** | "Enter or map a value. The value provided will be used as default value for this field when loaded in workflow." (acepta valor fijo o mapeo/custom value). |
| **Alters Dynamic Field** | "If enabled, any changes made to this field value will trigger/re-trigger loading the dynamic fields to the workflow action configuration UI." → **clave para dropdowns encadenados**. |
| **Validation Rules** | Ver abajo. |

### Lista COMPLETA de tipos de campo

Documentados en el portal de desarrollador y en el artículo de soporte (idénticos en ambos):

```
String, Numerical, Textarea, Select, Multiple Select, Radio,
Toggle, Checkbox, Attachment, Rich Text Editor, Hidden, Dynamic
```

Añadidos posteriormente y **no reflejados en esa lista** (changelog "Marketplace - Action Enhancements", https://ideas.gohighlevel.com/changelog/marketplace-action-enhancements):

```
Date (date input), Date Time (date-time input), Phone (phone input)
```

Ese mismo changelog añade además:
- **Métodos HTTP:** "incorporating GET, PUT, and DELETE alongside the existing POST method for action execution".
- **Payload personalizable:** "Customize your action payloads with ease. Choose between default configurations or define your own custom settings to receive data in the most meaningful way for your processes."

**Identificadores `fieldType` reales** (los que se usan en el JSON de campos dinámicos, ojo a las incoherencias de la propia doc):

| Tipo UI | `fieldType` en JSON |
|---|---|
| String | `string` |
| Numerical | `numerical` (en el ejemplo de sección) / `numeric` (en el ejemplo suelto) — **la doc se contradice** |
| Textarea | `textarea` |
| Select | `select` |
| Multiple Select | `multiselect` |
| Radio | `radio` |
| Toggle | `toggle` |
| Checkbox | `checkbox` |

### Semántica de los tipos especiales
- **Hidden:** "It will be hidden in the action configuration and the mapped data will be sent in the payload. Used to collect essential information such as `company_id`, `customerid`, etc., from system data or from your custom triggers." → ideal para meter `locationId` o un tenant id sin que el usuario lo vea.
- **Dynamic:** "Dynamic fields are used to build custom fields from an API call... **Only one Dynamic type can be created per action.**"

### Validation Rules
Tres métodos, todos con mensaje de error personalizado obligatorio:
1. **Pre-defined Rules:** email, phone number, URL, numerical values y **handlebar syntax checks**.
2. **Regex Support.**
3. **Arrow Function:** función flecha que recibe el valor y devuelve `true`/`false`.

Caso de uso citado literalmente: *"Custom action parameter | Block users from entering Handlebar syntax in a plain-text field"* — confirma que los usuarios escriben handlebars `{{...}}` en estos inputs.

### Multi-branch (ramas)
Configurable por acción: Branch Section, Branch Section Description, Branch Name Label, Branch Name Helptext, Delete Branch Title, Delete Branch Description; y opciones **Allow New Branches**, **Is Predefined Branches Editable**, **Show Branches Section**.

### Ciclo de vida
- La versión nace en **draft** → **Submit for review** con changelog → una vez aprobada "will be published live to all Sub-accounts".
- **+ New Version** clona la última publicada en un nuevo draft.
- Borrar es **permanente**: "If a deleted action is part of any workflow the action execution will be skipped."

### Coste y visibilidad
- "Marketplace Workflow Actions are part of **LC Premium Triggers & Actions and are chargeable per execution**."
- La subcuenta debe tener **Workflow LC Premium Triggers & Actions habilitado** y **la app instalada** desde el Marketplace, si no la acción no aparece en el listado del workflow.
- Cargo estándar de HighLevel citado en soporte: **$0.01 por ejecución** (https://help.gohighlevel.com/support/solutions/articles/155000004719-experiment-waiving-premium-action-trigger-charges-for-selected-marketplace-apps). El programa de exención ya cerró inscripciones.

---

## 2) DROPDOWNS DINAMICOS (punto critico)

### 2.a Opciones desde nuestro servidor: SI existe, es un GET

Para los tipos **Select / Multiple Select / Radio** aparece un "Option Type" con tres modos:

1. **Constants** — pares Label/Value fijos escritos a mano.
2. **Internal Reference** — "Load options from HighLevel Internal Modules" (la lista de módulos soportados en la doc es **solo una imagen**, no hay texto).
3. **External API** — "Load option from external API endpoint":
   - **URL (GET)**: "Provide a URL to support GET method and send a valid response as per the sample response structure shared below."
   - **Headers**: "Add headers as per your requirement" (aquí es donde metemos nuestro secreto).

**Formato de respuesta EXACTO que espera GHL (literal de la doc):**

```json
{
   "options": [
      { "label": "Afghanistan", "value": "AF" },
      { "label": "Åland Islands", "value": "AX" },
      { "label": "Albania", "value": "AL" },
      { "label": "Algeria", "value": "DZ" },
      { "label": "American Samoa", "value": "AS" }
   ]
}
```

Es un objeto con la clave `options` y un array de `{label, value}`. Nada más está documentado (ni paginación, ni grupos, ni `disabled`, ni valores por defecto).

### 2.b Encadenar dropdowns: NO por el GET de options. SI por el campo Dynamic

**Lo que NO existe:** la doc **no describe ningún parámetro, query string, cabecera ni body que GHL envíe al GET de opciones**. No hay `locationId`, no hay valores de otros campos, no hay contexto. Por tanto **es imposible encadenar dos `select` de tipo External API** de forma documentada: el segundo GET no sabría qué proveedor eligió el usuario.

**La alternativa real y soportada** (es literalmente para lo que existe la combinación "Alters Dynamic Field" + tipo "Dynamic"):

1. Campo 1 = `select` "Proveedor" (Constants o External API), con **"Alters Dynamic Field" = ON**.
2. Campo 2 = campo de tipo **Dynamic** con su **URL (POST)** apuntando a nuestro servidor.
3. Cada vez que el usuario cambia el Proveedor, GHL vuelve a hacer POST a esa URL enviando el estado actual del formulario; nosotros devolvemos la definición de los campos dependientes (incluido el `select` de remitentes ya filtrado por proveedor).

**Petición que manda GHL al endpoint del campo Dynamic (POST, literal de la doc):**

```json
{
   "data": {
        "name": "John Doe",
        "age": "29",
        "gender": "male",
        "hobbies": ["sports", "music"],
        "address": "My Address",
        "country": "US",
        "profileType": "public",
        "dataShare": true,
        "tems": true
   },
   "extras": {
        "locationId": "xyz",
        "contactId": "abc",
        "workflowId": "def"
   },
   "meta": {
        "key": "custom_action_key",
        "version": "1.0"
   }
}
```

Nota clave: **`data` trae los valores ya introducidos en el formulario** ("The form data is sent as payload to the dynamic field API") y **`extras.locationId` viaja aquí**, así que en este endpoint sí sabemos la subcuenta y el proveedor elegido. Es el único punto de la configuración donde tenemos contexto.

**Respuesta EXACTA que debemos devolver (literal de la doc):**

```json
{
   "inputs": [
      {
         "section": "Personal Info",
         "fields": [
            { "field": "name", "title": "Name", "fieldType": "string", "required": true },
            { "field": "age", "title": "Age", "fieldType": "numerical", "required": true },
            {
               "field": "gender",
               "title": "Gender",
               "fieldType": "select",
               "required": true,
               "options": [
                  { "label": "Male", "value": "male" },
                  { "label": "Female", "value": "female" }
               ]
            }
         ]
      },
      {
         "section": "Location Info",
         "fields": [
            { "field": "village", "title": "Village", "fieldType": "string", "required": true },
            { "field": "city",    "title": "City",    "fieldType": "string", "required": true },
            { "field": "fullAddress", "title": "Your Full Address", "fieldType": "textarea", "required": true }
         ]
      }
   ]
}
```

`section` agrupa visualmente los campos en la UI. Estructura por tipo (literal):

```json
{ "field": "name", "title": "Name", "fieldType": "string", "required": true }
{ "field": "name", "title": "Name", "fieldType": "numeric", "required": true }
{ "field": "description", "title": "Description", "fieldType": "textarea", "required": true }
{ "field": "gender", "title": "Gender", "fieldType": "select", "required": true,
  "options": [ { "label": "Male", "value": "male" }, { "label": "Female", "value": "female" } ] }
{ "field": "hobbies", "title": "Hobbies", "fieldType": "multiselect", "required": true,
  "options": [ { "label": "Sport", "value": "sport" }, { "label": "Music", "value": "music" } ] }
{ "field": "profileType", "title": "Profile Type", "fieldType": "radio", "required": true,
  "options": [ { "label": "Public", "value": "public" }, { "label": "Private", "value": "private" } ] }
{ "field": "dataShare", "title": "Allow my data to be stored", "fieldType": "toggle", "required": true }
{ "field": "terms", "title": "Terms & conditions", "fieldType": "checkbox", "required": true }
```

**Restricción dura:** *"Only one Dynamic type can be created per action."* Es decir, todo lo que dependa de la elección del usuario (remitente, plantilla, dominio verificado...) tiene que salir de ese **único** bloque Dynamic, devolviendo varios `fields` y varias `sections` en la misma respuesta.

**Recomendación de diseño para emails-disruptivo:** dejar el campo "Proveedor" como `select` con Constants (BREVO / SMTP / etc.), marcarlo "Alters Dynamic Field", y que el endpoint Dynamic devuelva en una sección "Remitente" un `select` con los remitentes verificados de esa `locationId` para ese proveedor, más el `select` de plantillas. Un solo endpoint, un solo Dynamic.

---

## 3) El WEBHOOK de ejecucion

### Configuración
En "Action Execution" se elige entre **API** y **Custom code**:
- **API > URL (POST)**: "Enter your API endpoint URL. When this action is executed data is sent to this API endpoint via POST method in the below mentioned payload format." (el changelog añade GET/PUT/DELETE como métodos alternativos).
- **Headers**: "Add required header data that has to be included while sending data to the API endpoint" → **cabeceras estáticas definidas por el desarrollador**, iguales para todas las subcuentas.

### Body EXACTO que envía GHL (literal de la doc, "Sample Payload: The form data is sent as payload to the Send Data URL")

```json
{
   "data": {
        "name": "John Doe",
        "age": "29",
        "gender": "male",
        "hobbies": ["sports", "music"],
        "address": "My Address",
        "country": "US",
        "profileType": "public",
        "dataShare": true,
        "tems": true
   },
   "extras": {
        "locationId": "xyz",
        "contactId": "abc",
        "workflowId": "def"
   },
   "meta": {
        "key": "custom_action_key",
        "version": "1.0"
   }
}
```

Traducido a nuestro caso, un envío real tendría esta pinta (las claves de `data` son los **Reference** que definimos en cada campo):

```json
{
  "data": {
    "proveedor": "brevo",
    "remitente_id": "snd_9f21",
    "plantilla_id": "tpl_bienvenida_v3",
    "asunto": "Bienvenido, Ana",
    "cuerpo_html": "<p>Hola Ana...</p>",
    "responder_a": "hola@bibihairdresser.com",
    "adjuntos": []
  },
  "extras": {
    "locationId": "ewGlt5YqA8PHR1qJWLhC",
    "contactId": "8pQ3aZk1LmNoPqRsTuVw",
    "workflowId": "b7d2f0c4-1a3e-4c9b-9f01-6d5e8c2a7b11"
  },
  "meta": {
    "key": "enviar_email_plantilla",
    "version": "1.0"
  }
}
```

### Dónde viaja cada cosa
- `extras.locationId` → subcuenta (nuestra clave de tenant).
- `extras.contactId` → contacto que está pasando por el nodo.
- `extras.workflowId` → workflow.
- `meta.key` → la Key inmutable de la acción (nos sirve para distinguir el nodo "con plantilla" del nodo "manual" si compartimos endpoint).
- `meta.version` → versión publicada de la acción.
- `data.*` → valores de los campos, con las claves **Reference**.
- **NO viaja `companyId`** en el payload de la acción (sí aparece en el `extras` del Subscription URL de los *triggers*, junto a `locationId` y `workflowId`).

### Con Multi-branch activo, `data` incluye `branches`

```json
{
  "data": {
    "name": "John Doe",
    "age": "29",
    "gender": "male",
    "hobbies": [ "sports", "music" ],
    "address": "My Address",
    "country": "US",
    "profileType": "public",
    "dataShare": true,
    "tems": true,
    "branches": [
      {
        "id": "a8d14b13-d7cc-4241-bd2c-53180f0ec278",
        "name": "Branch name",
        "fields": {
          "branchFieldKey": "branchFieldValue"
        }
      }
    ]
  },
  "extras": {
    "locationId": "xyz",
    "contactId": "abc",
    "workflowId": "def"
  },
  "meta": {
    "key": "custom_action_key",
    "version": "1.0"
  }
}
```

### Cabeceras
- Las que configuremos nosotros en el panel (`Headers`) + `Content-Type: application/json` implícito.
- Si la app tiene **External Authentication** activada, HighLevel inyecta las credenciales del usuario en las llamadas externas: *"stores the tokens securely, and includes them in the external calls your app makes (for example, in your Workflow Actions and Triggers)"*. En la config de External Auth los placeholders documentados son `{{bundle.accessToken}}`, `{{bundle.refreshToken}}`, `{{userData.<key>}}`, `{{externalApp.clientId}}`, `{{externalApp.clientSecret}}`, y el token se manda como `authorization: Bearer {{bundle.accessToken}}`.

---

## 4) La RESPUESTA que debe devolver la app

### Datos de salida usables en pasos posteriores: SI

Mecanismo (sección "Response Data" + "Manage Custom Variables"):
1. En el panel pegamos un **JSON de muestra** de lo que devuelve nuestro endpoint: *"Enter a valid sample response JSON structure that will be sent as a response to the Send Data API endpoint."*
2. En **Manage Custom Variables** creamos variables: **Name** (etiqueta) + **Reference** (clave del JSON de muestra).
3. Esas variables quedan disponibles en el workflow como `{{mycustomaction.data.name}}` / `{{action_a.custom_variable}}`.
4. *"Arrays are supported in response data. This data can be utilized in custom variables based on references and is available for use in **Array Functions, Custom Code, and Custom Webhooks**."*

Ejemplo pensado para nuestro nodo de email:

```json
{
  "ok": true,
  "messageId": "<202608061142.7f3a@bibi.mail>",
  "proveedor": "brevo",
  "remitente": "hola@bibihairdresser.com",
  "aceptadoEn": "2026-08-06T11:42:03.000Z",
  "error": ""
}
```

...y de ahí creamos variables "ID de mensaje" → `messageId`, "Enviado" → `ok`, etc.

### Ramificación (branching)
- **Sync** (Pause Execution = OFF, con branching): *"the contact will be moved to provided branch using `branchId` property from API response"* → devolvemos `{"branchId": "a8d14b13-..."}` en el cuerpo.
- **Async**: el `branchId` se manda después al webhook de resume.

### Pause Execution / resume
- Toggle "Pause Execution": *"the contact will be held at this action unless resume webhook is requested"*.
- *"If this toggle is true then provided `extras` object needs to be passed as body payload for resume workflow endpoint."*
- El botón **"Show API details"** dentro del panel del Marketplace es donde HighLevel muestra el endpoint de resume y los cuerpos de ejemplo para "Success Execution" y "Failed Execution". **Ese endpoint no está publicado en la documentación pública.**
- Para envío de email transaccional lo normal es dejarlo **OFF** (respuesta síncrona) y evitar toda esta complejidad.

### Códigos HTTP, timeouts y reintentos
- **No hay una tabla específica publicada para Marketplace Workflow Actions.** Lo único documentado en el ecosistema:
  - Guía oficial de webhooks (https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide): "Triggers: **any HTTP response that is not a 2xx** success. That includes all 3xx, 4xx, and 5xx status codes. It also includes cases where we get no HTTP response, such as timeouts or connection failures." / "Strategy: **exponential backoff + random jitter**" / "**Retries: we retry up to 12 times**, excluding the original attempt" / "Retries stop as soon as we receive any 2xx response." El changelog de seguridad afirma que los cambios "apply to **All Webhooks**".
  - Circuit breaker: revisión cada ~3 días; si una URL recibe más de 10.000 webhooks en la ventana y su tasa de éxito baja del 90%, primero email de aviso y, si se repite, **pausa de entregas** hasta reactivar los eventos en el panel.
  - Para la acción interna "Custom Webhook" (no marketplace): *"if errors are sent back, those will reflect on the Contact's Workflow execution and cause the action to be **Failed (and then skipped) or Retry with exponential backoffs**"* (https://help.gohighlevel.com/support/solutions/articles/48001238167-guide-to-custom-webhook-workflow-action).
- **Regla práctica:** devolver **200** con el JSON que coincida con el "sample response data" registrado. Si el envío falla por causa nuestra y queremos que GHL reintente, devolver 5xx; si queremos que el contacto siga (fallo lógico, p. ej. email inválido), devolver 200 con `{"ok": false, "error": "..."}` y ramificar por `branchId`.

---

## 5) Verificacion de firma

Documentado en https://marketplace.gohighlevel.com/docs/webhook/WebhookIntegrationGuide (sección "Security: Verifying Webhook Authenticity"):

| Cabecera | Algoritmo | Estado |
|---|---|---|
| `X-WH-Signature` | RSA-SHA256 | **Legacy** — "will be deprecated on **September 1, 2026**" |
| `X-GHL-Signature` | **Ed25519** | **Actual** — "use this when present. We will rely only on this header after the legacy one is removed." |

**Clave pública Ed25519 (para `X-GHL-Signature`), literal:**

```
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----
```

**Clave pública RSA legacy (para `X-WH-Signature`), literal:**

```
-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----
```

**Verificación Ed25519 (código literal de la doc, Node):**

```js
const crypto = require('crypto');

function verifyGhl(payload, signature, publicKeyPem) {
  if (!signature || signature === 'N/A') return { ok: false, reason: 'no signature' };
  try {
    const payloadBuffer = Buffer.from(payload, 'utf8');
    const signatureBuffer = Buffer.from(signature, 'base64');
    const ok = crypto.verify(null, payloadBuffer, publicKeyPem, signatureBuffer);
    return { ok, reason: ok ? null : 'verify failed' };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}
```

**Verificación RSA legacy (literal):**

```js
const verifier = crypto.createVerify('SHA256');
verifier.update(payload);
const ok = verifier.verify(publicKeyPem, signature, 'base64');
```

Flujo recomendado por HighLevel: si está `X-GHL-Signature`, verificar con Ed25519; si solo está `X-WH-Signature`, con la RSA legacy; rechazar si falla.

**AVISO IMPORTANTE (ver incertidumbres):** esta sección vive en la guía de **webhooks de eventos** (ContactCreate, etc.). La documentación de Custom Actions **no menciona firma alguna** para el POST de ejecución del nodo. El changelog de seguridad dice "These changes apply to **All Webhooks**", pero no lo confirma explícitamente para las acciones de marketplace.

**Estrategia defensiva concreta para emails-disruptivo:**
1. Verificar `x-ghl-signature` / `x-wh-signature` **si llegan** (usar el body crudo, no `JSON.stringify` del parseado; en Fastify hay que registrar un `addContentTypeParser` que guarde el raw buffer).
2. **Independientemente de eso**, exigir un secreto propio: en la config del Marketplace, cabecera fija tipo `x-disruptivo-token: <secreto largo>` en la URL de ejecución, la URL del Dynamic y la URL de options; comparar en tiempo constante (`crypto.timingSafeEqual`).
3. Además, path con segmento opaco: `/ghl/acciones/<uuid-secreto>/enviar`.
4. Comprobar que `extras.locationId` corresponde a una instalación viva de la app (tabla de instalaciones OAuth) y que `meta.key` es una de nuestras acciones.
5. Idempotencia por `extras.contactId + extras.workflowId + meta.key + hash(data)` para no duplicar emails ante reintentos.

---

## 6) Varias acciones en la misma app: SI

- El módulo Workflow del panel lista N acciones y N triggers por app; "Create Action" se puede repetir. La doc habla de acciones independientes con Key propia (`action_a`, `mycustomaction`) y versionado independiente por acción.
- **Límite reportado por la comunidad:** *"Right now the max limit for custom actions is 20"* (Daniel Marr, 18-nov-2025, https://ideas.gohighlevel.com/app-marketplace/p/increase-limit-for-custom-actions). **No es un dato oficial de HighLevel** y no aparece en la documentación.
- Para el caso de emails-disruptivo: perfectamente viable declarar dos acciones, por ejemplo `enviar_email_plantilla` y `enviar_email_manual`. Cada una con su propia URL de ejecución, o la misma URL discriminando por `meta.key`. Recomendación: **misma URL, ramificar por `meta.key`** para compartir validación de firma, tenant y cuotas.
- Cada acción tiene su propio ciclo draft → review → publicada, así que se pueden publicar por separado.

---

## 7) Merge fields / variables del contacto en los valores de los campos

- El **usuario de la subcuenta** (no el desarrollador) rellena los campos del nodo dentro del constructor de workflows, y ahí dispone del **selector de custom values / merge fields** estándar de GHL: `{{contact.first_name}}`, `{{contact.email}}`, `{{custom_values.xxx}}`, salidas de pasos anteriores, etc.
- Changelog "allow custom fields in marketplace actions and triggers" (https://ideas.gohighlevel.com/changelog/allow-custom-fields-in-marketplace-actions-and-triggers): antes había que duplicar acciones ("one for static inputs and another for custom values"); ahora **cada input tiene un desplegable para elegir entre valor estándar o selector de custom value**, y aplica a date inputs, dropdowns, tags y campos personalizados de webhooks. Textual: *"There will be no changes to the current process of building marketplace actions and triggers"* → **el desarrollador no tiene que hacer nada especial**.
- El mismo comportamiento se describe en el artículo de soporte: *"A new dropdown option allows users to select between a standard value or a custom value picker. Standard Values: Users can input data based on the field type (e.g., date, dropdown, tag). Custom Value Picker: Users can input data from custom fields, such as values from an inbound webhook trigger or other custom fields."*
- **GHL resuelve los handlebars antes de hacer el POST**: en `data` nos llega el texto ya interpolado ("Bienvenido, Ana"), no la plantilla. Esto se corrobora con la regla de validación pre-definida **"handlebar syntax"**, cuyo caso de uso documentado es *"Block users from entering Handlebar syntax in a plain-text field"* — existe precisamente porque por defecto sí se admiten.
- **Default Value** del campo también admite mapeo: *"Enter or map a value"*, así que podemos preconfigurar por ejemplo `Para: {{contact.email}}` como valor por defecto del nodo.
- Para datos que NO debe tocar el usuario (nuestro tenant id, un identificador de cuenta), usar el tipo **Hidden**, cuyo propósito documentado es exactamente ese.

---

## Chuleta de implementación (Fastify, alineado con marketplace-disruptivo)

Cuatro endpoints públicos a exponer:

| Ruta | Método | Uso en GHL | Cuerpo entrante | Cuerpo saliente |
|---|---|---|---|---|
| `/ghl/acciones/<secreto>/opciones/proveedores` | GET | Option Type "External API" de un `select` | (nada documentado) | `{"options":[{"label","value"}]}` |
| `/ghl/acciones/<secreto>/dinamico` | POST | Campo tipo Dynamic (encadenado) | `{data, extras, meta}` | `{"inputs":[{"section","fields":[...]}]}` |
| `/ghl/acciones/<secreto>/ejecutar` | POST | Action Execution (ambos nodos) | `{data, extras, meta}` | 200 + JSON que case con el "sample response data" |
| `/ghl/webhooks` | POST | Webhooks de eventos de la app (INSTALL/UNINSTALL, etc.) | evento GHL firmado | 200 |

Todos con: lectura del **raw body** para poder verificar Ed25519, comprobación de secreto propio en cabecera, resolución de tenant por `extras.locationId`, y respuesta rápida (procesar el envío real en cola tipo BullMQ como en ticket-system, devolviendo 200 con `messageId` provisional si hace falta).
### Incertidumbres (verificar a mano)
Lo que NO he podido confirmar en fuentes oficiales y hay que dejar configurable o verificar a mano en el panel del Marketplace:

1. **Firma en el POST de ejecución de la acción.** La documentación de Custom Actions no menciona ninguna cabecera de firma. La guía de webhooks describe `X-GHL-Signature` (Ed25519) / `X-WH-Signature` (RSA) y el changelog de seguridad dice que aplica a "All Webhooks", pero **no está confirmado** que las llamadas de una Marketplace Workflow Action lleven firma. Plan: implementar la verificación como opcional (`if (hay firma) verificar`) y apoyar la seguridad real en un secreto propio en cabecera + segmento secreto en la URL + validación de que `extras.locationId` es una instalación viva. Verificar con webhook.site en el primer despliegue qué cabeceras llegan de verdad.

2. **Contexto que recibe el GET de opciones ("External API" de un select).** No está documentado si GHL añade query params (`locationId`, `companyId`, `userId`), cabeceras propias, o si la URL admite placeholders tipo `{{userData.x}}` / `{{bundle.accessToken}}`. Consecuencia práctica: **no se puede asumir multi-tenant ni encadenamiento por esa vía**; hay que usar el campo Dynamic. Comprobar empíricamente apuntando la URL de options a webhook.site.

3. **Timeout exacto y política de reintentos de las Marketplace Workflow Actions.** Solo está publicado el comportamiento de los webhooks de eventos (no-2xx = fallo, hasta 12 reintentos, backoff exponencial + jitter) y el de la acción interna "Custom Webhook" (Failed y saltada, o Retry con backoff). No hay número de segundos publicado para el timeout de la acción de marketplace. Diseñar el endpoint para responder en <5 s y hacer el envío real en cola.

4. **Qué códigos HTTP considera GHL "éxito" en la ejecución de la acción** y si un 4xx marca el nodo como Failed y salta al siguiente paso o detiene el contacto. No documentado.

5. **Endpoint de "resume workflow" para Pause Execution.** Solo visible dentro del panel del Marketplace vía el botón "Show API details"; no hay URL, método ni esquema de cuerpo publicados (ni de "Success Execution" ni de "Failed Execution"). Si acabamos necesitando ejecución asíncrona habrá que leerlo desde el panel.

6. **Lista de "Supported HighLevel Modules"** para el Option Type "Internal Reference": en ambas fuentes es únicamente una captura de pantalla, sin texto. No sé qué módulos concretos ofrece (contactos, usuarios, calendarios, pipelines...).

7. **Formato exacto en `data` de los tipos Attachment, Rich Text Editor, Date, Date Time y Phone.** No hay ejemplo publicado (¿URL del fichero?, ¿objeto?, ¿ISO-8601?, ¿E.164?). Los tres últimos ni siquiera aparecen en la lista de tipos de la documentación, solo en el changelog.

8. **Incoherencia documental en el `fieldType` numérico:** el ejemplo de sección usa `"numerical"` y el ejemplo suelto usa `"numeric"`. Habrá que probar cuál acepta el constructor.

9. **"Tailor-Made Payloads" (payload personalizable) y métodos GET/PUT/DELETE**: anunciados en el changelog pero **sin documentar** en el portal de desarrollador. No sé cómo se define esa plantilla de payload ni qué placeholders admite. Si se puede, sería la vía para mandar un cuerpo plano en vez de `{data, extras, meta}`.

10. **Límite de 20 acciones por app**: dato de un post de comunidad de nov-2025, sin respuesta oficial de HighLevel ni mención en la documentación. Puede haber cambiado.

11. **Inyección de credenciales de External Authentication en las llamadas de la acción**: la doc afirma que los tokens "se incluyen en las llamadas externas que hace tu app (por ejemplo, en tus Workflow Actions y Triggers)", pero no especifica si es automático en la cabecera `authorization` o si hay que escribir `Bearer {{bundle.accessToken}}` a mano en los Headers de la acción. Los placeholders `{{bundle.accessToken}}` y `{{userData.<key>}}` solo están documentados dentro de la configuración de External Auth.

12. **Precio por ejecución**: los $0.01 salen de un artículo de soporte sobre un experimento ya cerrado; el precio vigente hay que confirmarlo en la propia cuenta de agencia, igual que la obligación de que cada subcuenta tenga LC Premium Triggers & Actions activado (si no, el nodo no aparece).

13. **Frecuencia / debounce del POST al campo Dynamic** cuando el usuario teclea o cambia varios campos marcados "Alters Dynamic Field". No documentado: conviene que ese endpoint sea barato, cacheado por `locationId + proveedor` y tolerante a ráfagas.

14. **Nota de fiabilidad**: parte de los detalles de los changelogs (fechas, cifras) se obtuvieron a través de resúmenes de páginas Canny que no exponen fecha de publicación; los textos citados entre comillas sí son literales de la fuente.


---

## MENU lateral y SSO de Custom Pages
### Resumen
Hay dos caminos distintos para que la app aparezca en la barra lateral de una subcuenta, y conviene combinarlos. (1) El módulo **Custom Pages** de la app del marketplace: se configura en la ficha de la app (Build > Modules), GHL la pinta como iframe y la entrada del menú aparece **automáticamente al instalar**, solo en las subcuentas donde la app está instalada, sin ningún scope ni llamada API. (2) La API **/custom-menus/** (scopes `custom-menu-link.write/.readonly`), que crea un Custom Menu Link clásico, pero **exige token de AGENCIA** y no se limita solo a las cuentas con la app: hay que mantener a mano el array `locations` (sincronizándolo con `GET /oauth/installedLocations` y los webhooks AppInstall/AppUninstall). Ojo con el efecto colateral documentado: pedir scopes `custom-menu-link.*` es acceso de nivel agencia y obliga a poner "Who can install = Agency Only", perdiendo la instalación directa por subcuentas. La autenticación de la página es el SSO firmado: el iframe hace `window.parent.postMessage({message:"REQUEST_USER_DATA"},"*")`, recibe `{message:"REQUEST_USER_DATA_RESPONSE", payload:<base64>}` y el backend lo descifra con el Shared Secret (CryptoJS AES = OpenSSL `Salted__` + EVP_BytesToKey MD5 + AES-256-CBC), exactamente el algoritmo que ya está implementado en `C:/Users/keytb/OneDrive/Escritorio/PROYECTOS IA/CLAUDE/marketplace-disruptivo/src/lib/sso.js`. Para obtener `locationId` en OAuth, `user_type=Location` solo sirve si instala un usuario de subcuenta; si instala la agencia (o es bulk) el token es `Company` y hay que canjear por `POST /oauth/locationToken`.
### Detalle
## 1) Custom Menu Links: UI, API y alcance

### 1.1 Qué NO es automático
La API de Custom Menu Links **no se dispara sola al instalar la app**. Crear el enlace es una acción explícita: o la hace un Agency Admin en `Settings > Custom Menu Links > Create New`, o la hace tu backend con `POST /custom-menus/` usando un token de agencia. Lo único que aparece **automáticamente al instalar** es la Custom Page del módulo de la app (ver sección 2).

Fuente UI: https://help.gohighlevel.com/support/solutions/articles/48001185767-customizing-highlevel-menus-a-guide-to-custom-menu-links
- "Only **Agency Admins** can create and manage Custom Menu Links". Permiso concreto: `Settings > Team > Manage Custom Menu Links`.
- FAQ literal: "**Q: Can subaccounts create their own Custom Menu Links?** No, only agency users with the necessary permissions can manage Custom Menu Links."
- Tres modos de apertura: Embedded Page (iFrame) / New Browser Tab / Current Tab.
- Sidebar Preference: **Agency sidebar** (usuarios de agencia) y/o **Sub-Account's sidebar**; al elegir subcuenta "you can choose which subaccounts should display the custom menu link". Role-Based Visibility: All / User / Admin.

### 1.2 Endpoints exactos (OpenAPI oficial)
Spec oficial: https://github.com/GoHighLevel/highlevel-api-docs → `apps/custom-menus.json` y `apps/v3/custom-menus-v3.json`
Docs: https://marketplace.gohighlevel.com/docs/ghl/custom-menus/custom-menu-links

- Servidor: `https://services.leadconnectorhq.com`
- Header obligatorio `Version`: `2021-07-28` (spec clásica) o `v3` (spec v3; mismos paths y mismos DTOs)
- Seguridad en **todos** los endpoints: `Agency-Access` = "Use the Access Token generated with user type as **Agency** (OR) Private Integration Token of Agency."

| Método | Path | Scope |
|---|---|---|
| GET | `/custom-menus/` | `custom-menu-link.readonly` |
| GET | `/custom-menus/{customMenuId}` | `custom-menu-link.readonly` |
| POST | `/custom-menus/` | `custom-menu-link.write` |
| PUT | `/custom-menus/{customMenuId}` | `custom-menu-link.write` |
| DELETE | `/custom-menus/{customMenuId}` | `custom-menu-link.write` |

Respuestas de POST: 201 creado, 400 input inválido, 401 no autorizado, 403 permisos insuficientes, 422 unprocessable.

### 1.3 Body de creación (`CreateCustomMenuDTO`, literal del spec)

Requeridos: `title`, `url`, `icon`, `showOnCompany`, `showOnLocation`, `showToAllLocations`, `locations`, `userRole`.

```json
{
  "title": "Emails Disruptivo",
  "url": "https://emails.tudominio.com/panel?location_id={{location.id}}",
  "icon": { "name": "yin-yang", "fontFamily": "fas" },
  "showOnCompany": false,
  "showOnLocation": true,
  "showToAllLocations": false,
  "locations": ["gfWreTIHL8pDbggBb7af", "67WreTIHL8pDbggBb7ty"],
  "openMode": "iframe",
  "userRole": "all",
  "allowCamera": false,
  "allowMicrophone": false
}
```

Semántica de cada campo (descripciones literales del spec):
- `showOnCompany` (bool, default true): "Whether the menu must be displayed on the agency's level" → **menú a nivel AGENCIA**.
- `showOnLocation` (bool, default true): "Whether the menu must be displayed for sub-accounts level" → **menú a nivel SUBCUENTA**.
- `showToAllLocations` (bool, default true): todas las subcuentas.
- `locations` (array de strings): "List of sub-account IDs where the menu should be shown. This list is applicable only when `showOnLocation` is true and `showToAllLocations` is false" → **este es el mecanismo exacto para restringir a subcuentas concretas**.
- `openMode` enum: `iframe` | `new_tab` | `current_tab`.
- `userRole` enum: `all` | `admin` | `user`.
- `allowCamera` / `allowMicrophone` (bool): "only for iframe mode".
- `icon`: `IconSchema` con `name` (string, ej. `"yin-yang"`) y `fontFamily` enum `fab` | `fas` | `far` (Font Awesome). Ambos requeridos en creación; opcionales en `UpdateCustomMenuDTO`. Referencia de iconos que enlaza la propia doc: `https://doc.clickup.com/8631005/d/h/87cpx-243696/d60fa70db6b92b2`.

`PUT` usa `UpdateCustomMenuDTO`: mismos campos, todos opcionales, `icon` con `IconSchemaOptional`. Respuesta `{ success, customMenu }`.

`GET /custom-menus/` query params: `locationId`, `skip` (default 0), `limit` (default 20), `query` (busca por nombre, parcial o completo), `showOnCompany` (bool: "Filter to show only agency-level menu links. When omitted, fetches both agency and sub-account menu links. **Ignored if locationId is provided**"). Respuesta: `{ customMenus: CustomMenuSchema[], totalLinks: number }`. `CustomMenuSchema` añade `id` y `order` (number).

`DELETE` responde `{ success, message, deletedMenuId, deletedAt }`.

### 1.4 Cómo restringirlo a las subcuentas con la app instalada
No existe un flag "solo donde la app está instalada". Se hace sincronizando `locations`:
1. `GET /oauth/installedLocations?companyId={companyId}&appId={appId}&isInstalled=true&limit=...&skip=...` con header `Version: 2021-07-28`, scope `oauth.readonly`, seguridad `Agency-Access-Only`. Devuelve `{_id, name, address, isInstalled, versionId, installedAt}` por subcuenta.
2. Webhooks `INSTALL` / `UNINSTALL` de la app (se suscriben por defecto si configuras webhook URL). Payload de install literal:
```json
{ "type":"INSTALL", "appId":"665c6bb13d4e5364bdec0e2f", "versionId":"665c6bb13d4e5364bdec0e2f",
  "installType":"Location", "locationId":"HjiMUOsCCHCjtxzEf8PR", "companyId":"GNb7aIv4rQFVb9iwNl5K",
  "userId":"Rg6BRRiHh7dS9gJy3W8a", "companyName":"...", "isWhitelabelCompany":true,
  "whitelabelDetails":{"logoUrl":"...","domain":"..."}, "timestamp":"2025-06-25T06:57:06.225Z",
  "webhookId":"..." }
```
3. `PUT /custom-menus/{id}` con el array `locations` actualizado.

### 1.5 AVISO CRÍTICO de distribución
https://marketplace.gohighlevel.com/docs/oauth/AppDistribution dice literalmente que para que la app sea instalable por subcuentas "you must ensure the app does not require any agency-level access such as: **Agency Level Scopes - companies.readonly, companies.write, location.write, saas/location.write, snapshots.readonly, snapshots.write, custom-menu-link.readonly, custom-menu-link.write**. Module > Snapshots, Module > CustomJS."

→ Si la app pide `custom-menu-link.*`, queda como "Who can install: **Agency Only**". Para "Emails Disruptivo" lo sensato es: **Custom Page del módulo para el menú lateral** (sin scopes) y, si se quiere además un menu link clásico, hacerlo con una app/integración privada de agencia aparte o con un token de agencia propio de Departamento Disruptivo.

Changelog que introdujo la API: https://ideas.gohighlevel.com/changelog/apis-for-custom-menu-links (confirma los dos scopes nuevos y los 5 endpoints).

### 1.6 Variables en la URL del menu link
`{{user.first_name}}`, `{{user.last_name}}`, `{{user.name}}`, `{{user.phone}}`, `{{user.email}}`, `{{location.id}}`, `{{location.name}}`, `{{location.city}}`, `{{location.state}}`, `{{location.country}}`, `{{location.address}}`, `{{location.email}}`, `{{location.phone}}`, `{{location.postal_code}}`, `{{location.full_address}}`, `{{location.website}}`, `{{location.logo_url}}`, `{{location_owner.first_name}}`, `{{location_owner.last_name}}`, `{{location_owner.email}}`, `{{custom_values.NOMBRE}}`.
Aviso del artículo de soporte: "These will only work on the **Location sidebar** when inside an account" (en el sidebar de agencia no hay contexto de location). Y son parámetros de URL: **falsificables**, nunca sirven como autenticación.

---

## 2) Custom Pages: iframe, URL y SSO por postMessage

Doc: https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomPages

### 2.1 Carga y ubicación
- "Custom Pages are rendered inside HighLevel via an **embedded iframe** that loads your externally hosted URL."
- Placement: (a) dentro de la ficha de la app, (b) **en el menú de navegación izquierdo**.
- Placement por tipo de distribución (literal):
  - *Sub-account distribution*: "The custom page appears in the **installed sub-account's left navigation**."
  - *Agency distribution*: aparece en el nav de la agencia instalada.
  - *Agency and sub-account*: en ambos, "where the app is installed".
- "Once the app is installed, the custom page becomes visible to the customer in the configured placement" → **el menú se crea solo, únicamente donde la app está instalada**. Esto es exactamente el comportamiento que se busca y no consume scopes.

### 2.2 Parámetros que manda GHL en la URL
Solo los que tú declares con plantillas al configurar la Custom Page URL. Ejemplo literal de la doc:
```
https://test.com/test?fname={{user.first_name}}&lname={{user.last_name}}&location_id={{location.id}}&custom_value_example={{custom_values.example_field_name}}
```
La lista de variables soportadas es la misma de 1.6. No hay documentado ningún parámetro que GHL añada por su cuenta.

### 2.3 SSO firmado (el mecanismo bueno)
Doc: https://marketplace.gohighlevel.com/docs/other/user-context-marketplace-apps

Frontend dentro del iframe (código literal de la doc):
```js
async function getUserData() {
  const encryptedUserData = await new Promise((resolve) => {
    window.parent.postMessage({ message: "REQUEST_USER_DATA" }, "*");
    const messageHandler = ({ data }) => {
      if (data.message === "REQUEST_USER_DATA_RESPONSE") {
        window.removeEventListener("message", messageHandler);
        resolve(data.payload);
      }
    };
    window.addEventListener("message", messageHandler);
  });
  const response = await fetch("your-backend-endpoint", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ encryptedData: encryptedUserData }),
  });
  return await response.json();
}
```
Variante para Custom JS (no para Custom Pages): `const encryptedUserData = await window.exposeSessionDetails(APP_ID);`

Backend (código literal de la doc):
```js
const CryptoJS = require("crypto-js");
const decrypted = CryptoJS.AES.decrypt(encryptedUserData, sharedSecretKey).toString(CryptoJS.enc.Utf8);
return JSON.parse(decrypted);
```
Sin dependencia externa, el equivalente en Node puro es el que ya tienes en `C:/Users/keytb/OneDrive/Escritorio/PROYECTOS IA/CLAUDE/marketplace-disruptivo/src/lib/sso.js` y el que usa la plantilla oficial en `src/ghl.ts` (`decryptSSOData`): base64 → cabecera `Salted__` (8 bytes) + salt (8 bytes) + ciphertext; derivación EVP_BytesToKey con MD5 (keySize 32, ivSize 16); `aes-256-cbc`. Es idéntico byte a byte.

### 2.4 JSON descifrado (campos literales)
Contexto agencia:
```json
{
  "userId": "MKQJ7wOVVmNOMvrnKKKK",
  "companyId": "GNb7aIv4rQFVb9iwNl5K",
  "role": "admin",
  "type": "agency",
  "userName": "John Doe",
  "email": "...",
  "isAgencyOwner": true,
  "versionId": "695505b431a9710730ee67d7",
  "appStatus": "live",
  "whitelabelDetails": { "domain": "example.com", "logoUrl": "example.com" }
}
```
Contexto location: **los mismos campos + `activeLocation`** (`"activeLocation": "yLKVZpNppIdYpah4RjNE"`, "Unique identifier for the active location").

Tabla de tipos de la doc: `userId` string, `companyId` string, `role` string ('admin'/'user'), `type` string ('agency' o 'location'), `activeLocation` string (solo contexto location), `userName` string, `email` string, `isAgencyOwner` boolean.

**Quirk importante**: en el ejemplo oficial de "Location Context" el campo `type` sigue valiendo `"agency"`. Es decir, **no fíes la detección de subcuenta a `type`**: usa la presencia de `activeLocation`. Esto encaja con lo que ya asume `ssoAuthorized()` en `marketplace-disruptivo/src/lib/sso.js` (el `companyId` de la agencia viaja en el token de cualquier usuario, incluidos los de subcuenta → autorizar por empresa solo si `type==='agency' && role==='admin'`).

Referencia oficial de implementación: https://github.com/GoHighLevel/ghl-marketplace-app-template (endpoint `/decrypt-sso`, helper `src/ui/src/ghl/index.js`, que manda `{key}` al backend).

---

## 3) Shared Secret / SSO key

- **Dónde**: la doc de User Context dice "Navigate to your application's **Advanced Settings > Auth**, under **Shared Secret** click **Generate**". La guía nueva de creación de app (https://marketplace.gohighlevel.com/docs/oauth/CreateMarketplaceApp) lo sitúa en **Manage > 5.2 Secrets > Shared Secret Key** ("used for secure user context access via signed tokens"). Ambas rutas coexisten según la versión de la UI del marketplace.
- **Cómo se usa**: es el passphrase del AES. Solo en backend, en variable de entorno. La plantilla oficial la llama `GHL_APP_SSO_KEY` (`.env.example`: `GHL_APP_CLIENT_ID`, `GHL_APP_CLIENT_SECRET`, `GHL_APP_SSO_KEY`, `GHL_API_DOMAIN=https://services.leadconnectorhq.com`, `PORT=3000`).
- Reglas de seguridad de la doc: nunca en cliente, descifrar solo en backend, HTTPS, rotar periódicamente.

---

## 4) OAuth: distribución, scopes y chooselocation

Docs: https://marketplace.gohighlevel.com/docs/oauth/AppDistribution · https://marketplace.gohighlevel.com/docs/Authorization/OAuth2.0 · https://marketplace.gohighlevel.com/docs/Authorization/TargetUserSubAccount

### 4.1 Tres campos de distribución
| Campo | Valores | Nota |
|---|---|---|
| Who is the target user of the app? | Agency / **Sub-account** | "For most apps, this will be Sub-account (Recommended). **This field cannot be modified once set.**" |
| Who can install the app? | Both Agency and Sub-account / Agency Only | "Agency Only" para features SaaS whitelabel |
| Can this app be bulk-installed by agencies? | Yes / No | "All new Marketplace apps will be set to Yes (mandatory)"; no se puede volver a No |

Matriz de tokens resultante (literal): Target=Agency → `userType: "Company"`, `isBulkInstallation:false`. Target=Sub-account + instala usuario de subcuenta → `userType:"Location"`. Target=Sub-account + instala agencia sin bulk → `userType:"Location"`. Target=Sub-account + bulk + instala agencia → `isBulkInstallation:true`, `userType:"Company"` y entonces toca: 1) `GET /oauth/installedLocations`, 2) `POST /oauth/locationToken` por cada location, 3) escuchar el webhook AppInstall para futuras instalaciones (incluidas las de planes SaaS).

### 4.2 Flujo chooselocation
URL de instalación (la muestra la propia app en Advanced Settings > Auth > Install Link, versión estándar y whitelabel):
```
https://marketplace.gohighlevel.com/oauth/chooselocation?response_type=code&redirect_uri=https://tuapp.com/oauth/callback&client_id=CLIENT_ID&scope=scope1%20scope2
```
Whitelabel: `https://marketplace.leadconnectorhq.com/oauth/chooselocation?...`. El repo de referencia ya la construye así en `C:/Users/keytb/OneDrive/Escritorio/PROYECTOS IA/CLAUDE/marketplace-disruptivo/src/lib/ghl.js`:
```js
const AUTH_BASE = 'https://marketplace.gohighlevel.com/oauth/chooselocation'
```
El usuario elige la cuenta, GHL redirige a `redirect_uri?code=...` (y `state` si lo mandas).

### 4.3 Canje del código (`POST /oauth/token`, sin auth previa)
`GetAccessCodebodyDto`: `client_id`*, `client_secret`*, `grant_type`* (`authorization_code` | `refresh_token` | `client_credentials`), `code`, `refresh_token`, `user_type` (`Company` | `Location`), `redirect_uri`.
Respuesta: `access_token`, `token_type`, `expires_in` (86399 ≈ 24 h), `refresh_token` (1 año **o hasta el primer uso**, es de un solo uso), `scope`, `refreshTokenId`, `userType`, `companyId`, `locationId` ("Present only for Sub-Account Access Token"), `approvedLocations`, `userId`, `planId`, `isBulkInstallation`, `installToFutureLocations`, `approveAllLocations`.

### 4.4 ¿Hace falta `user_type=Location` para tener locationId?
**Sí, pero solo funciona si quien instaló es un usuario de subcuenta.** Literal de la doc:
- "Who can install: Agency Only" → "⚠️ Note: The Access Token generated here will be of type **Company** (Agency-level)" y "To access Sub-Account–specific API endpoints, the Agency-level Access Token must first be exchanged for a Sub-Account (Location-level) Access Token".
- "Everyone" → Escenario 1 (instala agencia) = token `Company`, hay que canjear. Escenario 2 (instala subcuenta) con `--data-urlencode user_type=Location` → respuesta con `"userType":"Location"`, `"locationId":"HjiMUOsCCHCjtxzEf8PR"`.

Canje agencia→location:
```
curl -L 'https://services.leadconnectorhq.com/oauth/locationToken' \
 -H 'Content-Type: application/x-www-form-urlencoded' -H 'Accept: application/json' \
 -H 'Version: 2021-07-28' -H 'Authorization: Bearer {AGENCY_ACCESS_TOKEN}' \
 -d 'companyId=GNb7aIv4rQFVb9iwNl5K' -d 'locationId=HjiMUOsCCHCjtxzEf8PR'
```
Scope `oauth.write`, seguridad `Agency-Access-Only`. Devuelve `access_token`, `expires_in` 86400, `userType:"Location"`, `locationId`, `appId`, `versionId`. Nota: el token de location trae en `scope` `oauth.write oauth.readonly` añadidos.

### 4.5 Scopes relacionados con locations/usuarios (tabla oficial de https://marketplace.gohighlevel.com/docs/Authorization/Scopes)
| Scope | Endpoint | Nivel |
|---|---|---|
| `locations.readonly` | `GET /locations/:locationId` | Sub-Account |
| `users.readonly` | `GET /users/` | Sub-Account, Agency |
| `oauth.readonly` | `GET /oauth/installedLocations` | Agency |
| `oauth.write` | `POST /oauth/locationToken` | Agency |
| `custom-menu-link.readonly` | `GET /custom-menus/`, `GET /custom-menus/:id` | **Agency** |
| `custom-menu-link.write` | `POST`, `PUT`, `DELETE /custom-menus/` | **Agency** |

Para envío de email transaccional no hace falta ninguno de estos salvo los de identificación: con el SSO firmado ya sabes `activeLocation`, `companyId`, `userId`, `role` y `email` sin pedir scopes.

---

## 5) Limitaciones conocidas

**Documentadas** (https://marketplace.gohighlevel.com/docs/marketplace-modules/CustomPages, sección Hosting Requirements):
- **HTTPS obligatorio**: "Serve your Custom Page over HTTPS. Camera and microphone access generally require a secure context, and non-HTTPS pages may be blocked by the browser."
- **Nada de `X-Frame-Options: DENY` ni `SAMEORIGIN`**: "these can prevent the page from loading inside HighLevel".
- **CSP**: "If you use Content Security Policy, configure `frame-ancestors` to allow HighLevel domains to embed your page." (no enumera los dominios).
- **Cookies**: "If your page relies on cookies or session-based authentication, verify that those settings work correctly in an **embedded cross-site context**" → en la práctica exige `SameSite=None; Secure` (y partitioned/CHIPS en Chrome moderno), o mejor evitar cookies y guardar el JWT propio en memoria/`sessionStorage`.
- Cámara/micrófono soportados en Custom Pages; en Custom Menu Links se controlan con `allowCamera`/`allowMicrophone` y "only for iframe mode".
- El artículo de soporte avisa: "Not all websites allow embedding via iFrame. Test the link before deploying".

**Consecuencia práctica del whitelabel**: cada agencia sirve el panel desde su propio dominio CNAME (`app.suagencia.com`), además de `app.gohighlevel.com` / dominios `leadconnectorhq.com` y `msgsndr.com`. El conjunto de orígenes padre es **abierto y no enumerable**, así que: no mandar `X-Frame-Options`, no poner un `frame-ancestors` restrictivo (o dejarlo fuera), y **no usar el origen del `postMessage` como control de acceso**: la única identidad de confianza es el payload cifrado con el Shared Secret.

**Límite del SSO por postMessage**: la propia plantilla oficial dice "their SSO functionality currently supports integration **exclusively with custom pages**". En un Custom Menu Link normal (creado por la agencia o por `/custom-menus/`) el padre **no responde** a `REQUEST_USER_DATA` salvo que se inyecte un listener por Custom JS a nivel agencia (workaround documentado por terceros en https://virexmachina.com/blog/high-level-sso-custom-links/, usando `window.getToken()` y el `appId`). Es decir: **si quieres SSO real, la entrada del menú tiene que ser la Custom Page del módulo de la app, no un Custom Menu Link**.

**Robustez recomendada en el cliente** (ya aplicada en el panel de `marketplace-disruptivo`): comprobar `window.self !== window.top`, timeout (5-10 s) al esperar la respuesta, y aceptar tanto `{message:'REQUEST_USER_DATA_RESPONSE', payload}` como un payload string suelto, porque hay variaciones observadas en el mensaje.

**Módulo CustomJS** (https://marketplace.gohighlevel.com/docs/marketplace-modules/custom-js), por si se usa como plan B: `AppUtils.Storage` limita **5000 bytes** por entrada, cookies con expiración máxima **48 h**, claves autoprefijadas con `custom_`; eventos `routeLoaded`/`routeChangeEvent`; `AppUtils.RouteHelper.navigate()`. Y recuerda: Module > CustomJS también es acceso de nivel agencia (bloquea la instalación por subcuentas).
### Incertidumbres (verificar a mano)
**No confirmado en fuentes oficiales — dejar configurable o verificar a mano en el marketplace:**

1. **Cuántas Custom Pages admite una app y cómo se configuran exactamente.** La doc actual habla de "Custom Pages" en plural y de dos placements, pero **no enumera los campos del formulario** (nombre del menú, URL, icono, selector de placement). Una fuente de terceros (virexmachina, 2024) afirma "there can only be **one** Custom Page" y que vive en "a secondary tab of the App". Hay que abrirlo en `Build > Modules` de la app y comprobar en la UI.

2. **Si la Custom Page colocada en el menú lateral responde igual al `REQUEST_USER_DATA`** que la que está dentro de la ficha de la app. La doc lo presenta como el mecanismo de Custom Pages en general, pero no lo desglosa por placement. Verificar empíricamente antes de basar la autenticación en ello (y dejar un fallback: enlace de "abrir en pestaña" con login propio).

3. **Lista de orígenes de HighLevel para `frame-ancestors`.** GHL solo dice "allow HighLevel domains" y no publica la lista. Con whitelabel el dominio padre es arbitrario (`app.<agencia>.com`). Recomendación: no emitir la cabecera; si el hosting la impone, hacerla configurable por variable de entorno.

4. **Parámetros que GHL añade por su cuenta a la URL del iframe.** No está documentado ninguno; solo la sustitución de `{{...}}` que tú declares. No asumir que llegará `locationId` si no lo pones tú.

5. **Valor exacto del header `Version` para `/custom-menus/` en v3.** El spec v3 declara enum `["v3"]` y el clásico `["2021-07-28"]`. Ambos paths son idénticos; probar `2021-07-28` primero (es el que usa el resto del repo de referencia).

6. **Atributo `sandbox` del iframe, altura/scroll y límites de tamaño**: totalmente indocumentados. No hay ningún límite de peso/dimensiones publicado. Si el panel necesita popups, descargas o `window.open`, hay que probarlo dentro del iframe.

7. **Si un token de subcuenta puede crear/leer Custom Menu Links**: el spec marca `Agency-Access` en los 5 endpoints, así que en teoría no; pero no hay una nota explícita de "403 para tokens Location". Asumir que no.

8. **Comportamiento en la app móvil (LeadConnector)** de las Custom Pages y de los menu links en modo `iframe`: hay un changelog de "Custom Modules / Menu Links" para móvil, pero no está documentado si el SSO por `postMessage` funciona dentro de la webview.

9. **`appStatus`, `versionId` y `whitelabelDetails` del payload SSO**: aparecen en el ejemplo pero la tabla de "Field Descriptions" no los describe. No construir lógica crítica sobre ellos.

10. **`APP_ID` para `window.exposeSessionDetails(APP_ID)`**: la doc no dice dónde obtenerlo; en la práctica es el id de la app del marketplace (el prefijo del `client_id`, ej. `665c6bb13d4e5364bdec0e2f` en `665c6bb13d4e5364bdec0e2f-mawqjyjd`). Verificar.

11. **Si al desinstalar la app GHL limpia algo del Custom Menu Link creado por API**: no documentado. Asumir que no y hacerlo tú desde el webhook `UNINSTALL`.
