-- 0008_ai_alerts.sql
-- Alertas de presupuesto de IA.
--
-- Los límites son independientes: diario y mensual. Se registra una alerta por
-- umbral y periodo para no repetirla en cada mensaje procesado.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ai_alerts (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    kind              TEXT NOT NULL
                      CHECK (kind IN ('daily_budget', 'monthly_budget')),
    threshold         INTEGER NOT NULL CHECK (threshold IN (80, 100)),
    spent_usd_micros  INTEGER NOT NULL,
    budget_usd_micros INTEGER NOT NULL,
    period            TEXT NOT NULL,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (business_id, kind, threshold, period)
);

CREATE INDEX IF NOT EXISTS idx_ai_alerts_business_created
    ON ai_alerts(business_id, created_at);
