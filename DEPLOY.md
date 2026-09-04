# Puesta en marcha: Emails Disruptivo en EasyPanel

Guía de cero a funcionando. Orden: **A** (desplegar) → **B** (comprobar) → **C** (conectar con GHL,
que sigue en [GHL-SETUP.md](GHL-SETUP.md)) → **D** (relay SMTP, opcional: unos pocos pasos y el
certificado lo lee la app del `acme.json` de Traefik, sin nada a mano).

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
todos los proveedores de correo **y la clave privada del certificado TLS del relay**. **Si la pierdes
o la cambias, esas credenciales dejan de poder descifrarse** y hay que volver a introducirlas una por
una desde el panel (el certificado, en cambio, se vuelve a emitir solo). No la rotes sin un plan.

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
| `SMTP_RELAY_ENABLED` | `false` hasta que quieras el relay; entonces `true` y sigue la sección **D** |

El **host interno** de Postgres y Redis te lo muestra EasyPanel en cada servicio (suele coincidir con
el nombre del servicio). Copia la cadena de conexión que te da y ajústala.

`APP_BASE_URL` tiene que ser exactamente el dominio público final: con ella se construyen la Redirect
URL del OAuth, las URLs de tracking que van dentro de cada correo, las URLs de webhook que se
registran en Brevo y, por defecto, el host del relay SMTP. Si la cambias después, los correos ya
enviados apuntarán al dominio viejo.

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

## D. Encender el relay SMTP

Pocos pasos y **ningún certificado a mano**. El relay es opcional: si no lo enciendes, los **dos nodos
propios** funcionan igual. Lo único que aporta es poder seguir usando el nodo **nativo** de email de
GHL con los datos SMTP que da el panel, sin perder el historial ni el estado de entrega.

**De dónde sale el certificado.** El relay necesita un certificado TLS válido para el host que el
cliente pega en GHL. Ese host es, por defecto, el mismo de `APP_BASE_URL` (por ejemplo
`ddemail.escaladoacelerado.es`), y **Traefik ya tiene ese certificado**: lo emitió al dar de alta el
dominio en *Domains* y lo renueva solo. Está en el `acme.json` de Traefik, en el VPS. La app lo lee
de ahí (montando ese fichero en el contenedor en solo lectura), lo aplica **en caliente** a las dos
escuchas SMTP sin reiniciar nada y vuelve a leerlo cada vez que Traefik lo renueva. Ni volúmenes de
certificados, ni sidecars, ni DNS-01, ni una sola llamada a Let's Encrypt desde la app.

**Por qué no vale el reto HTTP-01 desde la app en EasyPanel** (para que no pierdas tiempo probándolo):
Traefik atiende el puerto 80 y su propio manejador ACME captura `/.well-known/acme-challenge/`
para **todos** los hosts, con prioridad sobre cualquier ruta, y responde `404` vacío antes de
enrutar nada a la app. Dar de alta el host en *Domains* no lo cambia. Let's Encrypt valida por el
80, así que la validación falla siempre (comprobado en vivo). El modo HTTP-01 propio existe (D6),
pero solo para despliegues sin un proxy con ACME delante.

### D1. Comprobar dónde tiene Traefik el certificado

En el VPS (SSH), Traefik de EasyPanel guarda los certificados normalmente en
`/etc/easypanel/traefik/acme.json`. Comprueba la ruta y que el host de la app ya está dentro:

```bash
ls -la /etc/easypanel/traefik/
grep -o '"main": *"[^"]*"' /etc/easypanel/traefik/acme.json
```

Tiene que aparecer `"main": "ddemail.escaladoacelerado.es"` (tu host). Si no aparece, el dominio no
está dado de alta con HTTPS en *Domains* del servicio, o Traefik aún no lo ha emitido: arréglalo
antes de seguir. Si la ruta es otra (`find /etc/easypanel -name acme.json`), usa esa en D2.

### D2. Montar el `acme.json` en el contenedor

EasyPanel → servicio `emails` → **Mounts** → *Bind Mount*:

| Host Path | Mount Path |
|---|---|
| `/etc/easypanel/traefik` | `/certs` |

Se monta el **directorio**, no el fichero suelto: así, si Traefik o EasyPanel sustituyen el fichero
en vez de reescribirlo, el contenedor sigue viendo el nuevo. Márcalo de solo lectura si la opción
existe; la app solo lee. El fichero es `0600` de root y la imagen corre como root dentro del
contenedor, así que se puede leer.

### D3. Variables

En el servicio `emails`:

| Variable | Valor |
|---|---|
| `SMTP_RELAY_ENABLED` | `true` |
| `SMTP_RELAY_TRAEFIK_ACME` | `/certs/acme.json` — ruta del `acme.json` **dentro** del contenedor (según el Mount de D2). Con esta variable la app no llama nunca a Let's Encrypt |
| `SMTP_RELAY_PORT_SSL` | `2465` — escucha SSL dentro del contenedor (la de STARTTLS es `SMTP_RELAY_PORT`, `2525` por defecto). Ya es el valor por defecto; déjala explícita para que se vea en EasyPanel. Definirla **vacía** apaga la escucha SSL |
| `SMTP_RELAY_HOST` | **Solo** si el host del relay va a ser distinto del de la app (ver D7). Si es el mismo, **no la definas**: se toma el de `APP_BASE_URL` |

Todo lo demás tiene valor por defecto y no hace falta tocarlo: `SMTP_RELAY_PORT=2525`,
`SMTP_RELAY_PUBLIC_PORT=587`, `SMTP_RELAY_PUBLIC_PORT_SSL=465`. `SMTP_RELAY_TLS_AUTO`, `ACME_EMAIL`
y `ACME_DIRECTORY` solo cuentan en el modo HTTP-01 propio (D6) y no hacen nada con
`SMTP_RELAY_TRAEFIK_ACME` definido.

**No enciendas `SMTP_RELAY_ENABLED` en EasyPanel sin `SMTP_RELAY_TRAEFIK_ACME`** (o sin ficheros,
D7): el relay se quedaría con el certificado autofirmado provisional, que GHL rechaza al guardar el
servicio.

### D4. Publicar los puertos en EasyPanel

Servicio `emails` → **Ports** (la sección de TCP/UDP; *Domains* es solo HTTP y no vale para SMTP).
Dos entradas:

| Published | Target | Protocol |
|---|---|---|
| `587` | `2525` | `TCP` |
| `465` | `2465` | `TCP` |

Las escuchas internas son puertos altos a propósito: el contenedor los abre sin privilegios. Los
puertos publicados no pueden chocar con otro servicio del mismo servidor. Si algo ya ocupa el 587 o
el 465, cambia `SMTP_RELAY_PUBLIC_PORT` / `SMTP_RELAY_PUBLIC_PORT_SSL` al que publiques de verdad:
es lo que el panel enseña a las subcuentas.

Comprueba también que el VPS no bloquea esos puertos. Publicar un puerto en EasyPanel no sirve de
nada si el firewall del proveedor lo corta antes: muchos VPS bloquean de entrada los puertos de
correo por defecto (antispam) y hay que pedir el desbloqueo por ticket. Desde **fuera del servidor**:

```bash
nc -vz emails.tudominio.com 587
nc -vz emails.tudominio.com 465
```

Si no abren tras el despliegue de D5, el problema es el puerto (firewall del proveedor o *Ports* mal
puesto), nunca el certificado.

### D5. Redesplegar y ver cómo el certificado pasa a «válido»

Pulsa **Deploy**. En el log verás el relay levantar al instante con un certificado autofirmado
provisional y, a los pocos segundos, la línea `relay: certificado de Traefik aplicado, válido hasta …`.

En el panel de admin → **Ajustes** → tarjeta **«Relay SMTP y certificado»** aparece el host, los
puertos públicos y las escuchas internas, el origen del certificado («del acme.json de Traefik»),
el modo TLS en servicio y el badge: pasa de «En emisión» a «Válido hasta …» sin que hagas nada. Si se
queda en error, el motivo está en «Último error» (fichero no montado, host sin certificado en
Traefik…) y el botón **Releer de Traefik ahora** vuelve a leer el fichero en cuanto lo arregles. La
app relee sola cuando Traefik renueva (vigila el fichero) y, además, cada 12 h.

Verifica desde fuera:

```bash
openssl s_client -starttls smtp -connect emails.tudominio.com:587 -crlf
openssl s_client -connect emails.tudominio.com:465
```

En los dos tienes que ver la cadena del certificado con el nombre del host y
`Verify return code: 0 (ok)`. Cualquier otro código significa que aún está el autofirmado
provisional (mira Ajustes) o que el host no es el que cubre el certificado (D7).

Después, por cada subcuenta: panel de la subcuenta → **Relay** → *Activar*. La app genera usuario y
contraseña (**la contraseña se muestra una sola vez**; si se pierde, se rota desde ahí mismo) y la
pantalla enseña el host, los dos puertos públicos y el estado del certificado. Esos datos son los que
se pegan en GHL: [GHL-SETUP.md](GHL-SETUP.md), sección 10.

### D6. Sin Traefik delante: certificado por ACME HTTP-01 desde la app (alternativa)

Solo para despliegues en los que el puerto 80 del host **sí** entrega a la app la petición
`http://<host>/.well-known/acme-challenge/<token>` (un proxy sin ACME propio, o la app expuesta
directamente). En EasyPanel **no** es el caso (ver el aviso al principio de esta sección).

No definas `SMTP_RELAY_TRAEFIK_ACME`; con `SMTP_RELAY_TLS_AUTO=true` (valor por defecto) la app le
pide el certificado a Let's Encrypt ella misma, lo guarda cifrado en Postgres (`tls_certificates`),
lo aplica en caliente y lo renueva cuando quedan menos de 30 días. `ACME_EMAIL` es opcional
(contacto de la cuenta: te avisan si un certificado va a caducar sin renovarse). Para pruebas sin
gastar cuota, `ACME_DIRECTORY=staging` (o la URL completa
`https://acme-staging-v02.api.letsencrypt.org/directory`); el certificado de staging no es de
confianza para nadie, así que quítala antes de dárselo a un cliente.

Antes de pedir la validación, la app comprueba su propia URL del reto. Si detecta que la captura el
ACME de un Traefik (404 vacío), **aborta sin gastar cuota** y deja en «Último error» un motivo
claro que te manda a D1–D3. Tras cualquier otro fallo no vuelve a llamar a Let's Encrypt hasta
pasada una hora, y el botón **Emitir / renovar ahora** solo fuerza la renovación de un certificado
que aún vale si han pasado 48 h desde su emisión (Let's Encrypt limita a 5 certificados idénticos
por semana).

### D7. Un host distinto para el relay (opcional)

Si prefieres que los clientes peguen `smtp.tudominio.com` en vez del dominio de la app:

1. DNS: registro **A** de `smtp.tudominio.com` a la IP del servidor.
2. EasyPanel → servicio `emails` → **Domains**: añade `smtp.tudominio.com` apuntando al puerto
   `8080` **con HTTPS activado**: así Traefik le emite su certificado y lo mete en el mismo
   `acme.json` (compruébalo como en D1).
3. Variable `SMTP_RELAY_HOST=smtp.tudominio.com` y redespliega. Nada más cambia: la app lee el
   certificado de ese nombre igual que en D5.

**Alternativa solo para un host que no enruta a este servidor** (y por tanto Traefik no puede tener
su certificado): emite el certificado tú con reto **DNS-01** (`certbot` o `lego` contra el DNS de tu
dominio) en un volumen montado en el contenedor y apunta `SMTP_RELAY_TLS_CERT=/certs/fullchain.pem`
y `SMTP_RELAY_TLS_KEY=/certs/privkey.pem`. Los ficheros tienen prioridad sobre Traefik y sobre el
automático. Renueva con un sidecar de `certbot` cada 60 días y reinicia el servicio tras cada
renovación: los ficheros se leen al arrancar. Es la ruta con fricción; úsala solo si de verdad no
hay otra.

### D8. Captura de rebotes (VERP)

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
   `rebotes.tudominio.com. MX 10 emails.tudominio.com.` (el host de la app, o `SMTP_RELAY_HOST` si
   definiste otro en D7). Añade también un TXT de SPF en ese subdominio que incluya al
   proveedor por el que envías (p. ej. `v=spf1 include:spf.tuproveedor.com ~all`): con VERP, los
   destinos evalúan SPF contra este dominio, no contra el del `From`, y la alineación DMARC del
   cliente pasa a depender de su firma DKIM.
2. **Puerto**: en EasyPanel, servicio `emails` → **Ports**, una entrada más:
   **Published** `25` → **Target** `2525` (la escucha STARTTLS; el relay atiende a la vez el correo
   autenticado de GHL y los rebotes).
3. **Variable**: `SMTP_BOUNCE_DOMAIN=rebotes.tudominio.com` en el servicio `emails` y redespliega.
   En el arranque, el log del relay muestra `rebotes: "rebotes.tudominio.com"`.

**Probarlo con un rebote real** (no hay simulacro que valga tanto como esto):

```bash
# 1. El MX resuelve y el 25 responde desde fuera del servidor
dig +short MX rebotes.tudominio.com
nc -vz emails.tudominio.com 25
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
| El relay no acepta conexiones (`ETIMEDOUT`, `nc` no abre) | Puertos 587/465 **bloqueados por el VPS** (pide el desbloqueo por ticket) o *Ports* del servicio sin publicar o con el *Target* equivocado (ver D4) |
| GHL falla al guardar el servicio con un error de certificado | El certificado aún está **en emisión** (espera un minuto y vuelve a guardar) o **en error**: mira Ajustes → «Relay SMTP y certificado» |
| Último error: `no existe /certs/acme.json dentro del contenedor` | Falta el **Mount** de D2 o la ruta de `SMTP_RELAY_TRAEFIK_ACME` no coincide con el *Mount Path*. Corrígelo, redespliega y pulsa «Releer de Traefik ahora» |
| Último error: `Traefik no tiene certificado para <host> (tiene: …)` | El host del relay no está dado de alta **con HTTPS** en *Domains* (o Traefik aún no lo ha emitido). Dalo de alta, espera a que cargue por HTTPS y pulsa «Releer de Traefik ahora» (ver D1 y D7) |
| Último error: `sin permiso para leer /certs/acme.json` | El contenedor no corre como root (imagen modificada) y el `acme.json` es `0600`. Vuelve a la imagen oficial o monta una copia legible |
| Último error: `el puerto 80 de <host> lo atiende el ACME del propio Traefik` | Estás en modo HTTP-01 propio detrás de Traefik: no puede funcionar. Pasa al modo Traefik (D1–D3) |
| Certificado en error con `rateLimited` / `too many certificates` (modo HTTP-01 propio) | **Cuota de Let's Encrypt agotada** (5 certificados idénticos por semana, 50 por dominio registrado y semana). La app no reintenta más de una vez por hora; espera a que pase la ventana. Para pruebas usa `ACME_DIRECTORY=staging` |
| Certificado en error con `unauthorized`, `Invalid response`, `DNS problem` o `connection refused` (modo HTTP-01 propio) | El **host del relay no resuelve a esta app** o el puerto 80 no le entrega el reto: `SMTP_RELAY_HOST` apunta a otra IP, o hay un proxy con ACME delante (ver D6) |
| `openssl s_client` devuelve `self signed certificate` | Sigue el autofirmado provisional: la lectura o la emisión no ha terminado o ha fallado. Ajustes → botón de releer/emitir y mira «Último error» |
| Ajustes muestra el certificado de un host distinto del que ven las subcuentas | Cambiaste `SMTP_RELAY_HOST` después de emitir. Al redesplegar se lee o emite para el nuevo host; entre medias las subcuentas ven «en emisión» |
| Ajustes: badge verde pero «último certificado rechazado» en «Último error» | Traefik (o Let's Encrypt) entregó un certificado que la pasarela no pudo aplicar; el que está en servicio sigue bien. Mira el motivo y el log; si persiste en la renovación siguiente, avisa |
| El relay responde **550** | El `From` usa un dominio verificado por **otra** subcuenta. Es el rechazo intencionado |
| El relay responde **451** | La subcuenta no tiene proveedor por defecto configurado en la pantalla *Relay* |

---

## Seguridad y mantenimiento

- `ADMIN_PASS` largo y único. El panel de admin es el que ve **todas** las subcuentas.
- La `ENCRYPTION_KEY` es la llave de todas las credenciales de correo de tus clientes y de la clave
  privada del certificado del relay: al gestor de contraseñas, nunca al repo, y presente también
  en cualquier copia de seguridad de la configuración.
- Las copias de seguridad de Postgres contienen tokens de OAuth de GHL, credenciales cifradas y el
  certificado TLS del relay (clave privada cifrada). Guárdalas cifradas y con acceso restringido.
- Cuando puedas, repo en **privado**.
- Vigila las tasas de rebote por subcuenta: por encima del 2-5 % de rebote duro conviene pausar esa
  subcuenta antes de que queme la reputación del dominio y de la IP del proveedor.
- Brevo limita a **300 peticiones/hora** todo lo que sea `/v3/smtp/*` distinto del envío, y a **100
  peticiones/hora** cosas como `/v3/account`, `/v3/senders` o `/v3/webhooks`. Enviar no es problema
  (1.000 por segundo), consultar sí: cualquier reconciliación barre por ventana temporal, nunca
  mensaje a mensaje.
- El certificado del relay se renueva solo (comprobación cada 12 h, renovación con menos de 30 días
  de vida). Si `ACME_EMAIL` está definido, Let's Encrypt avisa por correo cuando un certificado va a
  caducar sin renovarse: es la señal de que algo (puerto, host, cuota) se ha roto por debajo.
