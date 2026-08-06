-- Tracking universal (SPEC §11): clasificación de eventos y dominios de tracking por subcuenta.

-- Eventos reales vs automáticos (Apple MPP, proxys, escáneres). El dato ya viajaba en data jsonb;
-- la columna existe para poder agregar en SQL (Resumen, Envios) sin abrir el jsonb fila a fila.
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS automatico boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS message_events_reales_idx
  ON message_events (message_id, event) WHERE NOT automatico;

-- Dominio de tracking propio por subcuenta (branded tracking domain vía CNAME).
-- Sin él, todos los clientes comparten el dominio de los enlaces y la reputación de uno
-- arrastra a los demás. UNIQUE en domain: un dominio no puede servir a dos subcuentas.
CREATE TABLE IF NOT EXISTS tracking_domains (
  id           bigserial PRIMARY KEY,
  location_id  text        NOT NULL UNIQUE,
  domain       text        NOT NULL UNIQUE,
  verified     boolean     NOT NULL DEFAULT false,
  verify_token text,
  verified_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
