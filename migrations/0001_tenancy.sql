-- 0001_tenancy.sql
-- Multiempresa aditivo. No borra ni renombra nada.
-- Decisión: las 3 tablas existentes conservan id INTEGER; las nuevas usan TEXT (ULID).

PRAGMA foreign_keys = ON;

-- 1. Negocios ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS businesses (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    slug        TEXT NOT NULL UNIQUE,
    timezone    TEXT NOT NULL DEFAULT 'America/Bogota',
    currency    TEXT NOT NULL DEFAULT 'COP',
    status      TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended', 'closed')),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO businesses (id, name, slug)
VALUES ('keyko', 'Keyko Pet Grooming', 'keyko');

-- 2. business_id en WhatsApp ------------------------------------------------

ALTER TABLE whatsapp_events
    ADD COLUMN business_id TEXT NOT NULL DEFAULT 'keyko';

ALTER TABLE whatsapp_messages
    ADD COLUMN business_id TEXT NOT NULL DEFAULT 'keyko';

UPDATE whatsapp_events
   SET business_id = 'keyko'
 WHERE business_id IS NULL OR business_id = '';

UPDATE whatsapp_messages
   SET business_id = 'keyko'
 WHERE business_id IS NULL OR business_id = '';

-- 3. Índices ----------------------------------------------------------------

CREATE INDEX IF NOT EXISTS idx_clients_business
    ON clients(business_id);

CREATE INDEX IF NOT EXISTS idx_events_business_received
    ON whatsapp_events(business_id, received_at);

CREATE INDEX IF NOT EXISTS idx_messages_business_timestamp
    ON whatsapp_messages(business_id, message_timestamp);

CREATE INDEX IF NOT EXISTS idx_messages_business_contact
    ON whatsapp_messages(business_id, contact_key);

-- 4. Idempotencia del webhook ----------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_events_business_event
    ON whatsapp_events(business_id, event_id);
