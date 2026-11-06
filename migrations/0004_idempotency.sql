-- 0004_idempotency.sql
-- La agenda deja de bloquear por solapamientos: los conflictos pasan a ser
-- advertencias. Lo que sí se conserva es la protección frente a envíos
-- duplicados (doble clic, reintento de red) mediante claves de idempotencia.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id              TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    idem_key        TEXT NOT NULL,
    method          TEXT NOT NULL,
    path            TEXT NOT NULL,
    request_hash    TEXT NOT NULL,
    response_status INTEGER,
    response_body   TEXT,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (business_id, idem_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created
    ON idempotency_keys(created_at);

-- El índice de agenda se conserva: sigue acelerando la búsqueda de
-- solapamientos, que ahora solo alimenta advertencias.
