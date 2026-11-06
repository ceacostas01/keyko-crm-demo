-- 0000_baseline_prod.sql
-- Retrato exacto del esquema de producción al 2026-10-30.
-- NO modifica nada: solo describe lo que ya existe.
-- Fuente: esquema de producción (documento privado)

CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    business_id TEXT NOT NULL DEFAULT 'keyko',

    whatsapp_contact_key TEXT NOT NULL,
    whatsapp_bsuid TEXT,
    whatsapp_username TEXT,
    phone TEXT,

    whatsapp_name TEXT,
    full_name TEXT,

    notes TEXT,

    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

    UNIQUE (business_id, whatsapp_contact_key)
);

CREATE TABLE IF NOT EXISTS whatsapp_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
    message_id TEXT PRIMARY KEY,
    conversation_id TEXT,
    direction TEXT NOT NULL,
    contact_key TEXT,
    contact_phone TEXT,
    contact_name TEXT,
    message_type TEXT,
    body TEXT,
    message_timestamp TEXT,
    received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    raw_message_json TEXT NOT NULL,
    whatsapp_bsuid TEXT,
    whatsapp_username TEXT
);

CREATE INDEX IF NOT EXISTS idx_messages_contact
    ON whatsapp_messages(contact_key);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
    ON whatsapp_messages(conversation_id);
