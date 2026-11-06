-- 0009_profile_completeness.sql
-- Completitud de perfiles: marcas explícitas de "desconocido" y "no aplica".
--
-- El porcentaje no se guarda: se calcula desde los datos reales.
-- Solo se persisten las decisiones humanas sobre campos que no se pueden
-- deducir (por ejemplo: "la edad es desconocida" o "la raza no aplica").

PRAGMA foreign_keys = ON;

ALTER TABLE clients ADD COLUMN profile_flags_json TEXT;
ALTER TABLE pets ADD COLUMN profile_flags_json TEXT;
