-- Sección "Rebotados" (SPEC §12): vínculo con el contacto de GHL, estado del DND y preferencias.

-- La sección se apoya en suppressions (reason='rebote_duro'): ahí ya cae todo correo inexistente
-- o no conseguido, venga del webhook de Brevo, de un DSN VERP o de un rechazo permanente al enviar.
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS ghl_contact_id text;
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS dnd_at timestamptz;   -- cuándo se activó el DND en GHL
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS dnd_error text;       -- último error al intentarlo, si lo hubo
CREATE INDEX IF NOT EXISTS suppressions_rebotados_idx
  ON suppressions (location_id, created_at DESC) WHERE reason = 'rebote_duro';

-- Preferencias por subcuenta (de momento solo el auto-DND; tabla pensada para crecer).
CREATE TABLE IF NOT EXISTS location_settings (
  location_id text        PRIMARY KEY,
  auto_dnd    boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
