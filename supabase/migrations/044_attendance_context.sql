-- Attendance Bot context: estado entre mensajes (empleado pendiente, corrección de hora)
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS attendance_context jsonb;
