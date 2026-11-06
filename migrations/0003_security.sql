-- 0003_security.sql
-- Un solo administrador por negocio. No se crean roles ni permisos:
-- memberships se conserva tal cual para poder añadir más usuarios después.
-- Aquí solo: intentos de login fallidos e índices de auditoría y agenda.

PRAGMA foreign_keys = ON;

-- 1. Límite de intentos de login -------------------------------------------
-- Solo se guardan los fallos. Los logins exitosos van a audit_log.

CREATE TABLE IF NOT EXISTS login_failures (
    id           TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    ip           TEXT,
    attempted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_failures_email_time
    ON login_failures(email, attempted_at);

CREATE INDEX IF NOT EXISTS idx_login_failures_ip_time
    ON login_failures(ip, attempted_at);

-- 2. Auditoría --------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_audit_business_created
    ON audit_log(business_id, created_at);

-- 3. Agenda ----------------------------------------------------------------
-- Índice parcial: las citas canceladas no compiten por el horario, así que
-- la búsqueda de solapamientos ignora esa rama del índice.

CREATE INDEX IF NOT EXISTS idx_appointments_active_range
    ON appointments(business_id, starts_at, ends_at)
    WHERE status <> 'cancelled';
