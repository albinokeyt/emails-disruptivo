-- «Enviar prueba» de la pantalla Remitentes (SPEC §5.2 y §9): el correo de prueba de un remitente
-- va por la cola normal como cualquier otro mensaje, con su propio origen para poder filtrarlo en
-- Envíos y distinguirlo del correo real. Mismo patrón que 005_buzon.sql: se rehace el CHECK.
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_origin_check;
ALTER TABLE messages ADD CONSTRAINT messages_origin_check
  CHECK (origin IN ('nodo_plantilla','nodo_personalizado','relay','buzon','prueba'));
