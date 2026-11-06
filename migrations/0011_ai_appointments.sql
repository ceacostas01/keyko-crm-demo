-- 0011_ai_appointments.sql
-- Edad explícita (sin inventar fecha de nacimiento) y solicitudes de cita
-- detectadas por IA. Todo es aditivo.

ALTER TABLE pets ADD COLUMN age_years INTEGER;

CREATE TABLE IF NOT EXISTS appointment_requests (
    id                TEXT PRIMARY KEY,
    business_id       TEXT NOT NULL REFERENCES businesses(id),
    extraction_id     TEXT REFERENCES ai_extractions(id),
    client_id         INTEGER REFERENCES clients(id),
    pet_id            TEXT REFERENCES pets(id),
    contact_key       TEXT NOT NULL,
    requested_service TEXT,
    requested_date    TEXT,
    requested_time    TEXT,
    starts_at_local   TEXT,
    duration_min      INTEGER,
    status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN (
                        'pending', 'scheduled', 'confirmed', 'cancelled', 'discarded'
                      )),
    confidence        REAL,
    notes             TEXT,
    appointment_id    TEXT REFERENCES appointments(id),
    confirmed_at      TEXT,
    created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_appointment_requests_extraction
    ON appointment_requests(business_id, extraction_id);

CREATE INDEX IF NOT EXISTS idx_appointment_requests_business_status
    ON appointment_requests(business_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_appointment_requests_contact
    ON appointment_requests(business_id, contact_key, status);
