-- 0010_photos_usage.sql
-- Fotografías en almacenamiento de objetos y métricas agregadas de IA.
--
-- Turso solo guarda la referencia y los metadatos; nunca el binario.
-- `photo_url` se conserva para las fotos externas antiguas.

PRAGMA foreign_keys = ON;

ALTER TABLE pets ADD COLUMN photo_key TEXT;
ALTER TABLE pets ADD COLUMN photo_meta_json TEXT;

CREATE INDEX IF NOT EXISTS idx_pets_business_photo
    ON pets(business_id, photo_key);

-- Errores de llamadas a la IA (tokens y costo no se cobran en un fallo).
ALTER TABLE ai_usage ADD COLUMN error TEXT;

-- Agregado mensual sin contenido ni datos personales.
CREATE TABLE IF NOT EXISTS ai_usage_monthly (
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    month           TEXT NOT NULL,
    model           TEXT NOT NULL,
    calls           INTEGER NOT NULL DEFAULT 0,
    errors          INTEGER NOT NULL DEFAULT 0,
    tokens_in       INTEGER NOT NULL DEFAULT 0,
    tokens_out      INTEGER NOT NULL DEFAULT 0,
    cost_usd_micros INTEGER NOT NULL DEFAULT 0,
    latency_ms_avg  INTEGER,
    updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (business_id, month, model)
);
