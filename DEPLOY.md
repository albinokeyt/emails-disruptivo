# Puesta en marcha: Emails Disruptivo en EasyPanel

Guía de cero a funcionando. Orden: **A** (desplegar) → **B** (comprobar) → **C** (conectar con GHL,
que sigue en [GHL-SETUP.md](GHL-SETUP.md)) → **D** (relay SMTP, opcional y con fricción real).

---

## A. Desplegar en EasyPanel

### A1. Crear el proyecto y los 3 servicios

En EasyPanel crea un proyecto (p. ej. `emails`) y dentro **3 servicios**:

| Servicio | Tipo | Notas |
|---|---|---|
| `emails-db` | Postgres **17** | Guarda usuario, contraseña y nombre de BD que te genera |
| `emails-redis` | Redis **7** | Sin configuración especial |
| `emails` | App | Source: **GitHub** → tu repo, rama `main`, Build: **Dockerfile** |

Si el repo es **privado**, añade tu token de GitHub en EasyPanel o el build no podrá clonar.

La extensión `citext` la crea la propia migración (`CREATE EXTENSION IF NOT EXISTS citext`). Con la
imagen oficial de Postgres viene incluida; no hay que instalar nada aparte.

### A2. Generar la `ENCRYPTION_KEY`

Es lo primero, porque **sin ella la app no arranca**. Son 32 bytes en base64 (o hex):

```bash
openssl rand -base64 32
```

Sin `openssl` a mano:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Guárdala en tu gestor de contraseñas. Con esa clave se cifran (AES-256-GCM) las credenciales de
todos los proveedores de correo. **Si la pierdes o la cambias, esas credenciales dejan de poder
descifrarse** y hay que volver a introducirlas una por una desde el panel. No la rotes sin un plan.

### A3. Variables de entorno del servicio `emails`

| Variable | Valor de ejemplo |
|---|---|
| `PORT` | `8080` |
| `DATABASE_URL` | `postgres://postgres:<pass>@emails-db:5432/emails` |
| `REDIS_URL` | `redis://emails-redis:6379` |
| `APP_BASE_URL` | `https://emails.tudominio.com` — **sin barra final** |
| `ENCRYPTION_KEY` | la de A2, p. ej. `k7Qv…=` (44 caracteres en base64) |
| `ADMIN_USER` | `admin` |
| `ADMIN_PASS` | contraseña **larga y única** |
| `ENVIO_LIMITE_MINUTO` | *(opcional)* `60` |
| `ENVIO_LIMITE_DIA` | *(opcional)* `5000` |
| `WORKER_CONCURRENCIA` | *(opcional)* `5` |
| `WORKER_HABILITADO` | *(opcional)* `true` |
| `SMTP_RELAY_ENABLED` | `false` de momento — ver sección **D** |

El **host interno** de Postgres y Redis te lo muestra EasyPanel en cada servicio (suele coincidir con
el nombre del servicio). Copia la cadena de conexión que te da y ajústala.

`APP_BASE_URL` tiene que ser exactamente el dominio público final: con ella se construyen la Redirect
URL del OAuth, las URLs de tracking que van dentro de cada correo y las URLs de webhook que se
registran en Brevo. Si la cambias después, los correos ya enviados apuntarán al dominio viejo.

### A4. Dominio y HTTPS

1. En el servicio `emails` → **Domains**: añade tu dominio apuntando al **puerto 8080** y activa
   HTTPS (Let's Encrypt de EasyPanel).
2. HTTPS es **obligatorio**, no opcional: GHL solo carga Custom Pages servidas por HTTPS.
3. No pongas delante ningún proxy que añada `X-Frame-Options: DENY` o `SAMEORIGIN`, ni una
   `Content-Security-Policy` con `frame-ancestors` restrictivo. El panel se pinta **dentro de un
   iframe de GHL** y esas cabeceras lo bloquean. Además, con agencias whitelabel el dominio padre es
   arbitrario (`app.suagencia.com`), así que no hay lista de orígenes que valga: la seguridad la da
   el payload cifrado del SSO, no el origen del iframe.

### A5. Desplegar

Pulsa **Deploy**. El primer build tarda unos minutos porque compila el panel de React. Las
**migraciones corren solas** al arrancar, serializadas con `pg_advisory_lock`: puedes tener varias
réplicas y solo una aplicará el esquema.

### A6. Dominio de tracking de cada cliente (CNAME + certificado)

Cuando una subcuenta da de alta su dominio de tracking en el panel (Dominios → «Dominio de
tracking», SPEC §11.3), el cliente publica dos registros DNS que la app comprueba: el CNAME
(`link.sudominio.com → emails.tudominio.com`) y un TXT de propiedad
(`_disruptivo-verify.link.sudominio.com` con el valor que enseña el panel — el CNAME apunta a un
host compartido por todas las subcuentas, así que solo el TXT demuestra de quién es el dominio).
Pero **el DNS no basta**: los enlaces salen por
`https://link.sudominio.com/...`, así que Traefik necesita un certificado para ESE dominio, y
Let's Encrypt solo lo emite si el dominio está dado de alta en EasyPanel.

Por cada dominio de tracking verificado:

1. En el servicio `emails` → **Domains**: añade `link.sudominio.com` apuntando al **puerto 8080**
   con HTTPS activado (igual que en A4). El CNAME del cliente ya apunta aquí, así que la
   verificación HTTP de Let's Encrypt funciona sin tocar nada más.
2. No hay nada que configurar en la app: las rutas `/t/*` responden igual llegue el host que llegue.

Sin este alta, el CNAME verifica igual en el panel pero los clics de ese cliente fallarán con un
error de certificado en el navegador del destinatario. Es un paso manual por cliente: apúntalo en
el proceso de onboarding.

---

## B. Comprobar que está vivo

```bash
curl https://emails.tudominio.com/healthz
```

Debe responder:

```json
{ "ok": true, "db": true, "redis": true }
```

- Si `db` sale en `false`, revisa `DATABASE_URL` (host interno, contraseña, nombre de la base).
- Si `redis` sale en `false`, revisa `REDIS_URL`.
- Si el contenedor ni arranca, mira los logs: lo más habitual es `ENCRYPTION_KEY` ausente o con un
  tamaño distinto de 32 bytes (la app falla a propósito en vez de arrancar sin cifrado).

Después entra en `https://emails.tudominio.com/admin` con `ADMIN_USER` y `ADMIN_PASS`. Ese es el
panel de la agencia. El panel de subcuenta (la raíz `/`) solo tiene sentido **dentro** del iframe de
GHL, porque su sesión nace del SSO cifrado.

---

## C. Conectar con GoHighLevel

Todo el alta en el marketplace —app, scopes, Custom Page, los dos nodos de workflow y el relay— está
en **[GHL-SETUP.md](GHL-SETUP.md)**. El resumen de lo que necesitas de este lado:

- **Redirect URL** para pegar en la app de GHL: `https://emails.tudominio.com/api/oauth/callback`
- **Custom Page URL** (la que hace aparecer el menú lateral): `https://emails.tudominio.com/`
- Las credenciales de la app (`client_id`, `client_secret`, `app_id`, `shared_secret`, `company_id`)
  se pegan en el panel de admin → **Ajustes**, no en variables de entorno: viven en la tabla
  `settings` bajo la clave `ghl` y los secretos se devuelven enmascarados al leerlos.

Para instalar la app en la primera subcuenta, abre
`https://emails.tudominio.com/api/oauth/instalar`: te lleva al `chooselocation` de GHL con un `state`
anti-CSRF, eliges la subcuenta e instalas. Al volver, aparece en *Subcuentas* del panel de admin.

---

## D. Publicar el puerto del relay SMTP

Esta es **la parte con fricción real del despliegue**. No es difícil por el código: es difícil por el
certificado y por el puerto. Léela entera antes de prometerle el relay a un cliente.

Si te atascas, no pasa nada grave: deja `SMTP_RELAY_ENABLED=false` y usa los **dos nodos propios**,
que no necesitan nada de esto. El relay solo aporta poder seguir usando el nodo **nativo** de email
de GHL.

### D1. Lo primero: Traefik no sirve para esto

EasyPanel enruta con **Traefik**, y Traefik aquí **solo enruta HTTP/HTTPS**. La sección *Domains* de
un servicio, con su certificado Let's Encrypt automático, vale para el panel y la API — y para nada
más. **SMTP es TCP plano: no pasa por ahí.**

Lo que sí hay es la sección **Ports** del servicio de tipo App, cuya propia descripción dice que
publica *tráfico TCP o UDP no-HTTP directamente desde el servidor*:

| Campo | Valor |
|---|---|
| **Published** | el puerto en el servidor, p. ej. `587` |
| **Target** | el puerto dentro del contenedor, el mismo de `SMTP_RELAY_PORT` (`2525`) |
| **Protocol** | `TCP` |

Los puertos publicados no pueden chocar con otro servicio del mismo servidor.

### D2. El certificado TLS es el punto duro

El host que el cliente escriba en *SMTP Host* de GHL (p. ej. `smtp.tudominio.com`) necesita un
**certificado TLS válido para ese nombre**, dentro del contenedor, en las rutas que apunten
`SMTP_RELAY_TLS_CERT` y `SMTP_RELAY_TLS_KEY`.

El certificado que EasyPanel emite para el dominio del panel **no sirve**: lo tiene Traefik, no tu
contenedor, y además el reto HTTP-01 no puede validar un servicio TCP.

**No hay procedimiento oficial documentado por EasyPanel para esto.** Lo que sigue son las dos rutas
razonables, pero es una inferencia, no una receta publicada — es el mayor riesgo de esta sección:

- **Reto DNS-01** con `certbot` o `lego` contra el DNS de `tudominio.com`, emitiendo el certificado
  de `smtp.tudominio.com` en un **volumen compartido** que montas en el contenedor de la app. Apuntas
  `SMTP_RELAY_TLS_CERT=/certs/fullchain.pem` y `SMTP_RELAY_TLS_KEY=/certs/privkey.pem`.
- **Sidecar de renovación**: un segundo servicio con `certbot` que renueva cada 60 días en ese mismo
  volumen. Tras la renovación hay que reiniciar el servicio de la app para que recargue el contexto
  TLS (o implementar `sniOptions` con recarga en caliente, que no está previsto en esta versión).

Sin certificado válido, el relay solo puede ofrecer **STARTTLS oportunista** con un certificado
autofirmado. **Sin confirmar:** no hay documentación de GHL que diga si valida el certificado del
servidor SMTP al conectarse, si acepta uno autofirmado, o si en ese caso enviaría en claro.
**Cómo comprobarlo:** monta el relay con el autofirmado, configúralo en una subcuenta de pruebas,
envía un correo desde *Conversations* y mira si llega o si aparece el triángulo rojo de error.

### D3. Qué puerto publicar

La documentación de GHL solo menciona **587 con TLS/STARTTLS** y **465 con SSL**. **Sin confirmar:**
no hay ninguna fuente que diga si GHL acepta `2525`, `25` o un puerto arbitrario, lo cual importa
mucho si tu hosting bloquea 587 y 465.

**Cómo comprobarlo:** en una subcuenta de pruebas, *Settings › Email Services › SMTP Service ›
+ Add Service*, proveedor `Other`, pon el puerto no estándar, guarda y envía un correo de prueba
desde *Conversations*. Si falla, el error sale al pinchar el triángulo rojo del mensaje.

**Antes de nada, confirma con tu proveedor de VPS que los puertos 25/465/587 están abiertos**, al
menos de entrada. Muchos los bloquean por defecto para frenar el spam y hay que pedir el desbloqueo
por ticket. Publicar un puerto en EasyPanel no sirve de nada si el firewall del proveedor lo corta
antes.

### D4. DNS

- Un registro **A** de `smtp.tudominio.com` a la IP del servidor (es el nombre que va en *SMTP Host*
  y el que tiene que cubrir el certificado).
- El **PTR / DNS inverso** no hace falta para que funcione el TLS, pero ayuda a la reputación si
  algún día el relay entrega directamente en vez de reenviar a Brevo o a otro SMTP.

### D5. Activarlo

Con el puerto publicado, el certificado montado y el DNS puesto:

| Variable | Valor |
|---|---|
| `SMTP_RELAY_ENABLED` | `true` |
| `SMTP_RELAY_PORT` | `2525` (el *Target* de D1) |
| `SMTP_RELAY_HOST` | `smtp.tudominio.com` — es lo que se le enseña al usuario para pegar en GHL |
| `SMTP_RELAY_TLS_CERT` | `/certs/fullchain.pem` |
| `SMTP_RELAY_TLS_KEY` | `/certs/privkey.pem` |
| `SMTP_RELAY_MAX_SIZE` | `26214400` (25 MB) |

Redespliega y comprueba desde **fuera del servidor**:

```bash
openssl s_client -starttls smtp -connect smtp.tudominio.com:587 -crlf
```

Tienes que ver el banner del servidor, la cadena del certificado y `Verify return code: 0 (ok)`.
Cualquier otro código significa que el certificado no vale para ese nombre o que no está completo
(falta la cadena intermedia: usa `fullchain.pem`, no `cert.pem`).

Si la conexión ni se abre, el problema es el puerto (firewall del proveedor o *Ports* mal
configurado), no el certificado.

Después, desde el panel de la subcuenta → **Relay** → *Activar*: la app genera usuario y contraseña.
**La contraseña se muestra una sola vez**; si se pierde, se rota desde ahí mismo. Esos datos son los
que se pegan en GHL (ver [GHL-SETUP.md](GHL-SETUP.md), última sección).

### D6. Captura de rebotes (VERP)

Opcional, y solo tiene sentido con el relay ya funcionando (D1–D5). Con `SMTP_BOUNCE_DOMAIN`
definido, cada envío por un proveedor **SMTP** sale con un Return-Path propio y único
(`b.<id>@rebotes.tudominio.com`); cuando un buzón no existe o está lleno, el servidor de destino
devuelve el aviso (DSN) a esa dirección, el relay lo recibe **sin autenticación** —solo para ese
patrón de direcciones, todo lo demás sin credenciales se rechaza con 550— y el mensaje pasa a
`rebotado` (con alta en supresiones) o registra un `rebote_blando`. Con Brevo no aplica: sus
rebotes ya llegan por webhook.

**Aviso honesto antes de empezar:** los rebotes llegan por el **puerto 25**, y muchos hostings y
VPS lo bloquean de entrada por defecto (es la medida antispam estándar). Pregunta a tu proveedor
**antes** de montar nada; si no te lo abren, esta pieza queda apagada —no definas
`SMTP_BOUNCE_DOMAIN`— y **no se rompe nada**: los envíos siguen saliendo igual, solo que los
rebotes de SMTP genérico no se capturan (todo se queda en `enviado`, como hasta ahora).

Pasos:

1. **DNS**: registro **MX** del subdominio de rebotes apuntando al host del relay:
   `rebotes.tudominio.com. MX 10 smtp.tudominio.com.` (el mismo `SMTP_RELAY_HOST` de D5, que ya
   tiene su registro A de D4). Añade también un TXT de SPF en ese subdominio que incluya al
   proveedor por el que envías (p. ej. `v=spf1 include:spf.tuproveedor.com ~all`): con VERP, los
   destinos evalúan SPF contra este dominio, no contra el del `From`, y la alineación DMARC del
   cliente pasa a depender de su firma DKIM.
2. **Puerto**: en EasyPanel, servicio `emails` → **Ports**, una entrada más:
   **Published** `25` → **Target** `2525` (el mismo `SMTP_RELAY_PORT`; el servidor del relay
   atiende a la vez el correo autenticado de GHL y los rebotes).
3. **Variable**: `SMTP_BOUNCE_DOMAIN=rebotes.tudominio.com` en el servicio `emails` y redespliega.
   En el arranque, el log del relay muestra `rebotes: "rebotes.tudominio.com"`.

**Probarlo con un rebote real** (no hay simulacro que valga tanto como esto):

```bash
# 1. El MX resuelve y el 25 responde desde fuera del servidor
dig +short MX rebotes.tudominio.com
nc -vz smtp.tudominio.com 25
```

2. Desde un workflow de la subcuenta (o desde *Conversations*), envía un correo por un proveedor
   SMTP a un buzón que **no exista** en un dominio real, p. ej.
   `noexiste-9f3c1a2b@gmail.com`. El proveedor lo acepta (queda `enviado`) y al poco —de segundos a
   minutos— el servidor de destino devuelve el DSN.
3. En el panel → **Envios**, el mensaje tiene que pasar a `rebotado`, con el evento `rebote` (y el
   `Diagnostic-Code` del destino) en su histórico, y la dirección tiene que aparecer en
   **Supresiones** como `rebote_duro`. Si en unos minutos no llega nada, mira los logs del relay:
   si no hay ni rastro de la conexión, el 25 sigue bloqueado (paso 1); si hay conexiones rechazadas
   con 550, revisa que el MX apunte al host correcto y que `SMTP_BOUNCE_DOMAIN` coincida
   exactamente con el subdominio del MX.

---

## Resolución de problemas

| Síntoma | Causa probable |
|---|---|
| El contenedor no arranca | Falta `ENCRYPTION_KEY` o no son 32 bytes; `DATABASE_URL`/`REDIS_URL` mal. Mira los logs |
| `/healthz` con `db:false` o `redis:false` | Postgres o Redis inaccesibles desde el contenedor (host interno equivocado) |
| El OAuth falla al instalar | `APP_BASE_URL` con barra final o distinta del dominio real; Redirect URL distinta en la app de GHL |
| El panel sale en blanco dentro de GHL | Un proxy delante añadiendo `X-Frame-Options`, o el dominio sin HTTPS |
| Dentro de GHL pide login en vez de entrar solo | Falta el **Shared Secret** en Ajustes, o la entrada del menú es un *Custom Menu Link* en vez de la **Custom Page** del módulo (el menu link no responde al `REQUEST_USER_DATA`) |
| El nodo no aparece en el workflow | La subcuenta no tiene **LC Premium Triggers & Actions** activado, la app no está instalada ahí, o la acción sigue en *draft* |
| El nodo devuelve 400 «no encontrado» | El proveedor, remitente o plantilla elegidos no son de esa subcuenta, o se borraron después de configurar el workflow |
| Los desplegables del nodo salen vacíos | La subcuenta no tiene proveedores/remitentes creados todavía, o la URL del campo Dynamic tiene el `action_secret` equivocado |
| Todo se queda en `encolado` | `WORKER_HABILITADO=false` y no hay ningún otro servicio ejecutando el worker |
| Todo se queda en `enviado`, nunca `entregado` | Es lo normal con SMTP genérico (solo confirma el primer salto). Con Brevo, revisa que el webhook esté registrado y apunte a `APP_BASE_URL` |
| Brevo rechaza con 400 `invalid_parameter` | Remitente no verificado en Brevo. El motivo crudo queda en `last_error` y se ve en el detalle del envío |
| Envíos en `fallido` con error de credenciales | Clave de API o contraseña SMTP caducada. No se reintenta a propósito: reintentar un `535` acaba con la cuenta bloqueada en el proveedor |
| El pixel y los enlaces apuntan a un dominio viejo | `APP_BASE_URL` se cambió después de enviar; solo afecta a los correos ya salidos |
| El relay no acepta conexiones | Puerto bloqueado por el proveedor de VPS, o *Ports* del servicio sin publicar (ver D1 y D3) |
| El relay conecta pero GHL no envía | Certificado inválido para ese hostname (ver D2), o el puerto no lo acepta GHL (ver D3) |
| El relay responde **550** | El `From` usa un dominio verificado por **otra** subcuenta. Es el rechazo intencionado |
| El relay responde **451** | La subcuenta no tiene proveedor por defecto configurado en la pantalla *Relay* |

---

## Seguridad y mantenimiento

- `ADMIN_PASS` largo y único. El panel de admin es el que ve **todas** las subcuentas.
- La `ENCRYPTION_KEY` es la llave de todas las credenciales de correo de tus clientes: al gestor de
  contraseñas, nunca al repo, y presente también en cualquier copia de seguridad de la configuración.
- Las copias de seguridad de Postgres contienen tokens de OAuth de GHL y credenciales cifradas.
  Guárdalas cifradas y con acceso restringido.
- Cuando puedas, repo en **privado**.
- Vigila las tasas de rebote por subcuenta: por encima del 2-5 % de rebote duro conviene pausar esa
  subcuenta antes de que queme la reputación del dominio y de la IP del proveedor.
- Brevo limita a **300 peticiones/hora** todo lo que sea `/v3/smtp/*` distinto del envío, y a **100
  peticiones/hora** cosas como `/v3/account`, `/v3/senders` o `/v3/webhooks`. Enviar no es problema
  (1.000 por segundo), consultar sí: cualquier reconciliación barre por ventana temporal, nunca
  mensaje a mensaje.
