-- Esquema inicial de la app de email para el marketplace de GoHighLevel.
-- Idempotente: se aplica una sola vez (control en schema_migrations) pero puede reejecutarse sin romper.

-- citext: los correos se comparan sin distinguir mayúsculas en TODAS las claves únicas.
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------------------
-- Subcuentas de GHL con la app instalada
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connections (
  id                bigserial PRIMARY KEY,
  location_id       text        NOT NULL UNIQUE,
  company_id        text,
  name              text,
  access_token      text,
  refresh_token     text,
  token_expires_at  timestamptz,
  status            text        NOT NULL DEFAULT 'connected'
                                CHECK (status IN ('connected','error','uninstalled')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Configuración global de la app (clave/valor): credenciales GHL, límites, admins
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        text        PRIMARY KEY,
  value      jsonb       NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Proveedores de email saliente (de la subcuenta o del admin de la agencia)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS providers (
  id              bigserial PRIMARY KEY,
  owner_scope     text        NOT NULL CHECK (owner_scope IN ('location','admin')),
  location_id     text,
  name            text        NOT NULL,
  type            text        NOT NULL CHECK (type IN ('smtp','brevo')),
  credentials_enc text        NOT NULL,               -- AES-256-GCM, nunca sale de la API
  config          jsonb       NOT NULL DEFAULT '{}',  -- no secreto: host, port, secure, pool
  status          text        NOT NULL DEFAULT 'sin_probar'
                              CHECK (status IN ('ok','error','sin_probar')),
  last_check_at   timestamptz,
  last_error      text,
  daily_limit     int,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  -- un proveedor de subcuenta SIEMPRE tiene dueño; uno de admin NUNCA lo tiene
  CONSTRAINT providers_scope_coherente CHECK (
    (owner_scope = 'location' AND location_id IS NOT NULL) OR
    (owner_scope = 'admin'    AND location_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS providers_location_idx
  ON providers (location_id) WHERE owner_scope = 'location';

-- Proveedores del admin cedidos a subcuentas concretas
CREATE TABLE IF NOT EXISTS provider_assignments (
  id          bigserial PRIMARY KEY,
  provider_id bigint      NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  location_id text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, location_id)
);
CREATE INDEX IF NOT EXISTS provider_assignments_location_idx
  ON provider_assignments (location_id);

-- ---------------------------------------------------------------------------
-- Dominios: la propiedad de un dominio VERIFICADO es exclusiva de una subcuenta.
-- Es el guardarraíl que impide que una subcuenta envíe desde el dominio de otra.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sender_domains (
  id           bigserial PRIMARY KEY,
  location_id  text        NOT NULL,
  domain       text        NOT NULL,
  verified     boolean     NOT NULL DEFAULT false,
  verify_token text,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, domain)
);
CREATE UNIQUE INDEX IF NOT EXISTS sender_domains_verificado_unico
  ON sender_domains (domain) WHERE verified;

-- ---------------------------------------------------------------------------
-- Remitentes. origin='auto' = dado de alta solo por el relay al ver un From nuevo.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS senders (
  id             bigserial PRIMARY KEY,
  location_id    text        NOT NULL,
  provider_id    bigint      REFERENCES providers(id) ON DELETE SET NULL,
  email          citext      NOT NULL,
  name           text        NOT NULL,
  reply_to       text,
  is_default     boolean     NOT NULL DEFAULT false,
  origin         text        NOT NULL DEFAULT 'panel' CHECK (origin IN ('panel','admin','auto')),
  verified_state text        NOT NULL DEFAULT 'desconocido'
                             CHECK (verified_state IN ('verificado','no_verificado','desconocido')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, email)
);
-- como mucho un remitente por defecto por subcuenta
CREATE UNIQUE INDEX IF NOT EXISTS senders_default_unico
  ON senders (location_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS senders_provider_idx ON senders (provider_id);

-- ---------------------------------------------------------------------------
-- Plantillas. location_id NULL = plantilla global del admin, visible por todas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS templates (
  id          bigserial PRIMARY KEY,
  location_id text,
  name        text        NOT NULL,
  subject     text        NOT NULL,
  preheader   text,
  html        text        NOT NULL,
  text        text,
  variables   jsonb       NOT NULL DEFAULT '[]',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS templates_location_idx ON templates (location_id);

-- ---------------------------------------------------------------------------
-- Mensajes: cola de envío E historial. Fuente única de verdad para las tres vías
-- (los dos nodos propios y el relay SMTP).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id                  bigserial PRIMARY KEY,
  location_id         text        NOT NULL,
  provider_id         bigint      REFERENCES providers(id) ON DELETE SET NULL,
  sender_id           bigint      REFERENCES senders(id)   ON DELETE SET NULL,
  template_id         bigint      REFERENCES templates(id) ON DELETE SET NULL,
  origin              text        NOT NULL
                                  CHECK (origin IN ('nodo_plantilla','nodo_personalizado','relay')),
  status              text        NOT NULL DEFAULT 'encolado'
                                  CHECK (status IN ('encolado','reintento','enviando','enviado',
                                                    'diferido','entregado','rebotado','spam',
                                                    'fallido','suprimido')),
  -- rango del estado: un webhook que llega tarde NUNCA puede hacer retroceder el estado
  status_rank         int         NOT NULL DEFAULT 0,
  to_email            citext      NOT NULL,
  to_name             text,
  cc                  text[],
  bcc                 text[],
  reply_to            text,
  subject             text        NOT NULL,
  preheader           text,
  html                text,
  text                text,
  ghl_contact_id      text,
  ghl_workflow_id     text,
  provider_message_id text,
  -- viaja en X-Mailin-custom y vuelve en todos los webhooks: es como se correlaciona
  correlation_id      text        NOT NULL UNIQUE,
  attempts            int         NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz NOT NULL DEFAULT now(),
  locked_at           timestamptz,
  locked_by           text,
  last_error          text,
  opened_at           timestamptz,
  clicked_at          timestamptz,
  sent_at             timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- el índice que usa el worker para reclamar trabajo (FOR UPDATE SKIP LOCKED)
CREATE INDEX IF NOT EXISTS messages_cola_idx
  ON messages (next_attempt_at) WHERE status IN ('encolado','reintento');
-- rescate de mensajes cuyo worker murió a mitad
CREATE INDEX IF NOT EXISTS messages_bloqueados_idx
  ON messages (locked_at) WHERE status = 'enviando';
CREATE INDEX IF NOT EXISTS messages_location_idx  ON messages (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_provider_msg_idx ON messages (provider_message_id);
CREATE INDEX IF NOT EXISTS messages_to_idx        ON messages (location_id, to_email);

-- ---------------------------------------------------------------------------
-- Histórico de eventos, append-only. dedupe_key da la idempotencia: los webhooks
-- llegan repetidos y desordenados, y un reintento no puede duplicar filas.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_events (
  id          bigserial PRIMARY KEY,
  message_id  bigint      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  event       text        NOT NULL,
  occurred_at timestamptz NOT NULL,
  dedupe_key  text        NOT NULL,
  data        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (message_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS message_events_message_idx
  ON message_events (message_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- Enlaces reescritos para el seguimiento de clics. El redirector SOLO redirige a
-- una URL que esté aquí: sin esta tabla sería un redirector abierto.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_links (
  id         bigserial PRIMARY KEY,
  message_id bigint      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  token      text        NOT NULL UNIQUE,
  url        text        NOT NULL,
  clicks     int         NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Lista de supresión: se consulta ANTES de cada envío, venga de un nodo o del relay
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  id          bigserial PRIMARY KEY,
  location_id text        NOT NULL,
  email       citext      NOT NULL,
  reason      text        NOT NULL CHECK (reason IN ('rebote_duro','spam','baja','manual')),
  source      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, email)
);

-- ---------------------------------------------------------------------------
-- Credenciales del relay SMTP por subcuenta: lo que el usuario pega en
-- GHL › Settings › Email Services para usar el nodo nativo de email.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS relay_accounts (
  id                      bigserial PRIMARY KEY,
  location_id             text        NOT NULL UNIQUE,
  username                text        NOT NULL UNIQUE,
  password_hash           text        NOT NULL,          -- scrypt, jamás en claro
  enabled                 boolean     NOT NULL DEFAULT false,
  default_provider_id     bigint      REFERENCES providers(id) ON DELETE SET NULL,
  -- por defecto TRUE: si llega un From no registrado se da de alta y se envía,
  -- en vez de rechazarlo. Es el comportamiento que se espera del nodo nativo de GHL.
  accept_unknown_senders  boolean     NOT NULL DEFAULT true,
  last_used_at            timestamptz,
  rotated_at              timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
