-- Certificados TLS del relay SMTP emitidos automáticamente por ACME (Let's Encrypt), SPEC §13.
-- Las claves van cifradas con ENCRYPTION_KEY (mismo esquema que las credenciales de proveedores).
CREATE TABLE IF NOT EXISTS tls_certificates (
  hostname         text        PRIMARY KEY,
  account_key_enc  text,                      -- clave de la cuenta ACME (cifrada)
  private_key_enc  text,                      -- clave privada del certificado (cifrada)
  certificate_pem  text,                      -- cadena completa (fullchain) en PEM
  issued_at        timestamptz,
  expires_at       timestamptz,
  last_attempt_at  timestamptz,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
