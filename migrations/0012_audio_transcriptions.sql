-- 0012_audio_transcriptions.sql
-- Transcripciones de notas de voz de WhatsApp.
-- Aditivo: no modifica el webhook ni los datos existentes.

CREATE TABLE IF NOT EXISTS message_transcriptions (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    message_id        TEXT NOT NULL REFERENCES whatsapp_messages(message_id),
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    provider          TEXT NOT NULL DEFAULT 'openrouter',
    model             TEXT,
    transcript        TEXT,
    -- Corrección humana: tiene prioridad sobre la transcripción automática.
    manual_transcript TEXT,
    language          TEXT,
    duration_seconds  REAL,
    audio_format      TEXT,
    audio_bytes       INTEGER,
    attempts          INTEGER NOT NULL DEFAULT 0,
    cost_usd_micros   INTEGER NOT NULL DEFAULT 0,
    latency_ms        INTEGER,
    last_error        TEXT,
    transcribed_at    TEXT,
    corrected_at      TEXT,
    corrected_by      TEXT REFERENCES users(id),
    purged_at         TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_message_transcriptions_message
    ON message_transcriptions(business_id, message_id);

CREATE INDEX IF NOT EXISTS idx_message_transcriptions_status
    ON message_transcriptions(business_id, status);

CREATE INDEX IF NOT EXISTS idx_message_transcriptions_created
    ON message_transcriptions(business_id, created_at);

ALTER TABLE ai_usage ADD COLUMN audio_seconds REAL;
