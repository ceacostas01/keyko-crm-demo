-- 0007_ai.sql
-- Procesamiento asíncrono de conversaciones con IA.
--
-- Reutiliza ai_extractions (sugerencias) y ai_usage (costo).
-- Añade tres tablas pequeñas:
--   · ai_jobs               lote de mensajes por contacto, con reintentos
--   · ai_processed_messages idempotencia: un mensaje se procesa una sola vez
--   · field_overrides       campos editados a mano que la IA no debe pisar

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ai_jobs (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    wa_contact  TEXT NOT NULL,
    message_ids TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'processing', 'done', 'failed', 'skipped')),
    attempts    INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error  TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_jobs_business_status
    ON ai_jobs(business_id, status, created_at);

CREATE TABLE IF NOT EXISTS ai_processed_messages (
    message_id   TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    job_id       TEXT,
    processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_processed_business
    ON ai_processed_messages(business_id, processed_at);

CREATE TABLE IF NOT EXISTS field_overrides (
    business_id TEXT NOT NULL REFERENCES businesses(id),
    entity      TEXT NOT NULL CHECK (entity IN ('client', 'pet')),
    entity_id   TEXT NOT NULL,
    field       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (business_id, entity, entity_id, field)
);
