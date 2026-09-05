-- Buzón IMAP por subcuenta (SPEC §14): cuentas, mensajes recibidos, adjuntos y cuota de espacio.

CREATE TABLE IF NOT EXISTS mailboxes (
  id                  bigserial PRIMARY KEY,
  location_id         text        NOT NULL,
  name                text        NOT NULL,
  email               citext      NOT NULL,
  host                text        NOT NULL,
  port                int         NOT NULL DEFAULT 993,
  secure              boolean     NOT NULL DEFAULT true,          -- TLS implícito (993); false = STARTTLS (143)
  username            text        NOT NULL,
  password_enc        text        NOT NULL,                       -- AES-256-GCM, misma clave que los proveedores
  folder              text        NOT NULL DEFAULT 'INBOX',
  delete_after_import boolean     NOT NULL DEFAULT false,         -- false = dejar copia en el servidor
  sync_interval_min   int         NOT NULL DEFAULT 5,
  reply_sender_id     bigint      REFERENCES senders(id) ON DELETE SET NULL,
  enabled             boolean     NOT NULL DEFAULT true,
  status              text        NOT NULL DEFAULT 'sin_probar'
                                  CHECK (status IN ('ok','error','sin_probar','cuota_llena')),
  last_error          text,
  last_sync_at        timestamptz,
  last_uid            bigint      NOT NULL DEFAULT 0,
  uidvalidity         bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (location_id, email)
);
CREATE INDEX IF NOT EXISTS mailboxes_sync_idx ON mailboxes (enabled, last_sync_at);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id              bigserial PRIMARY KEY,
  location_id     text        NOT NULL,
  mailbox_id      bigint      NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  uid             bigint      NOT NULL,
  message_id      text,
  in_reply_to     text,
  "references"    text,
  thread_key      text        NOT NULL,                           -- Message-ID raíz del hilo
  from_email      citext,
  from_name       text,
  recipients      jsonb       NOT NULL DEFAULT '[]',              -- [{tipo:'to'|'cc', email, name}]
  subject         text,
  date            timestamptz NOT NULL DEFAULT now(),
  snippet         text,
  text            text,
  html            text,                                           -- ya saneado (sin scripts)
  size_bytes      bigint      NOT NULL DEFAULT 0,                 -- tamaño del mensaje crudo
  has_attachments boolean     NOT NULL DEFAULT false,
  is_read         boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (mailbox_id, uid)
);
CREATE INDEX IF NOT EXISTS inbox_messages_location_idx ON inbox_messages (location_id, date DESC);
CREATE INDEX IF NOT EXISTS inbox_messages_thread_idx   ON inbox_messages (location_id, thread_key);
CREATE INDEX IF NOT EXISTS inbox_messages_msgid_idx    ON inbox_messages (message_id);

CREATE TABLE IF NOT EXISTS inbox_attachments (
  id            bigserial PRIMARY KEY,
  message_id    bigint      NOT NULL REFERENCES inbox_messages(id) ON DELETE CASCADE,
  filename      text        NOT NULL,
  content_type  text        NOT NULL DEFAULT 'application/octet-stream',
  size_bytes    bigint      NOT NULL DEFAULT 0,
  content       bytea       NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inbox_attachments_message_idx ON inbox_attachments (message_id);

-- Cuota por subcuenta (NULL = usar el valor por defecto de settings.limites.buzon_quota_mb)
ALTER TABLE location_settings ADD COLUMN IF NOT EXISTS buzon_quota_mb   int;
ALTER TABLE location_settings ADD COLUMN IF NOT EXISTS buzon_used_bytes bigint NOT NULL DEFAULT 0;

-- Respuestas desde el buzón: van por la cola normal con cabeceras de hilo y enlazadas al mensaje original
ALTER TABLE messages ADD COLUMN IF NOT EXISTS extra_headers      jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS inbox_reply_to_id  bigint REFERENCES inbox_messages(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_key         text;
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE messages ADD CONSTRAINT messages_origin_check
  CHECK (origin IN ('nodo_plantilla','nodo_personalizado','relay','buzon'));
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages (location_id, thread_key) WHERE thread_key IS NOT NULL;
