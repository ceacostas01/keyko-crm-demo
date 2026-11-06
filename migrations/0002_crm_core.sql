-- 0002_crm_core.sql
-- Núcleo del CRM. Solo crea tablas nuevas y añade columnas opcionales.
-- Dinero: INTEGER en centavos, precio final (sin desglose de impuestos).
-- IDs nuevos: TEXT (ULID generado en la app). client_id sigue siendo INTEGER.

PRAGMA foreign_keys = ON;

-- 1. Personal y acceso ------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE,
    name          TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'disabled')),
    last_login_at TEXT,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memberships (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    user_id     TEXT NOT NULL REFERENCES users(id),
    role        TEXT NOT NULL
                CHECK (role IN ('owner', 'admin', 'groomer', 'receptionist')),
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (business_id, user_id)
);

CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    business_id TEXT NOT NULL REFERENCES businesses(id),
    expires_at  TEXT NOT NULL,
    ip          TEXT,
    user_agent  TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    actor_id    TEXT,
    action      TEXT NOT NULL,
    entity      TEXT NOT NULL,
    entity_id   TEXT,
    diff_json   TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Clientes (extensión de la tabla existente) -----------------------------

ALTER TABLE clients ADD COLUMN email TEXT;
ALTER TABLE clients ADD COLUMN extra_json TEXT;
ALTER TABLE clients ADD COLUMN source TEXT DEFAULT 'manual';
ALTER TABLE clients ADD COLUMN consent_marketing INTEGER NOT NULL DEFAULT 0;
ALTER TABLE clients ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_clients_phone
    ON clients(business_id, phone);

CREATE INDEX IF NOT EXISTS idx_clients_deleted
    ON clients(business_id, deleted_at);

-- 3. Mascotas ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pets (
    id           TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    client_id    INTEGER NOT NULL REFERENCES clients(id),
    name         TEXT NOT NULL,
    species      TEXT NOT NULL DEFAULT 'perro'
                 CHECK (species IN ('perro', 'gato', 'otro')),
    breed        TEXT,
    sex          TEXT CHECK (sex IN ('macho', 'hembra') OR sex IS NULL),
    birthdate    TEXT,
    weight_kg    REAL,
    allergies    TEXT,
    temperament  TEXT,
    photo_url    TEXT,
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_pets_business_client
    ON pets(business_id, client_id);

CREATE TABLE IF NOT EXISTS pet_health_records (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    pet_id      TEXT NOT NULL REFERENCES pets(id),
    type        TEXT NOT NULL
                CHECK (type IN ('vaccine', 'allergy', 'condition', 'note')),
    description TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    vet_name    TEXT,
    next_due_at TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_health_business_pet
    ON pet_health_records(business_id, pet_id, occurred_at);

CREATE TABLE IF NOT EXISTS pet_notes (
    id             TEXT PRIMARY KEY,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    pet_id         TEXT NOT NULL REFERENCES pets(id),
    appointment_id TEXT,
    author_id      TEXT REFERENCES users(id),
    body           TEXT NOT NULL,
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 4. Catálogo ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS services (
    id           TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    name         TEXT NOT NULL,
    category     TEXT,
    duration_min INTEGER NOT NULL DEFAULT 30 CHECK (duration_min > 0),
    price_cents  INTEGER NOT NULL CHECK (price_cents >= 0),
    active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_services_business
    ON services(business_id, active);

CREATE TABLE IF NOT EXISTS products (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    sku         TEXT,
    name        TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    cost_cents  INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
    stock       INTEGER NOT NULL DEFAULT 0,
    min_stock   INTEGER NOT NULL DEFAULT 0,
    active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at  TEXT,
    UNIQUE (business_id, sku)
);

CREATE TABLE IF NOT EXISTS stock_movements (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    product_id  TEXT NOT NULL REFERENCES products(id),
    delta       INTEGER NOT NULL,
    reason      TEXT NOT NULL,
    ref_type    TEXT,
    ref_id      TEXT,
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_stock_business_product
    ON stock_movements(business_id, product_id, created_at);

-- 5. Agenda -----------------------------------------------------------------

CREATE TABLE IF NOT EXISTS appointments (
    id          TEXT PRIMARY KEY,
    business_id TEXT NOT NULL REFERENCES businesses(id),
    client_id   INTEGER NOT NULL REFERENCES clients(id),
    pet_id      TEXT NOT NULL REFERENCES pets(id),
    groomer_id  TEXT REFERENCES users(id),
    starts_at   TEXT NOT NULL,
    ends_at     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'scheduled'
                CHECK (status IN ('scheduled', 'confirmed', 'in_progress',
                                  'done', 'no_show', 'cancelled')),
    notes       TEXT,
    created_by  TEXT REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_appointments_business_start
    ON appointments(business_id, starts_at);

CREATE INDEX IF NOT EXISTS idx_appointments_business_pet
    ON appointments(business_id, pet_id);

CREATE TABLE IF NOT EXISTS appointment_items (
    id               TEXT PRIMARY KEY,
    business_id      TEXT NOT NULL REFERENCES businesses(id),
    appointment_id   TEXT NOT NULL REFERENCES appointments(id),
    item_type        TEXT NOT NULL CHECK (item_type IN ('service', 'product')),
    item_id          TEXT NOT NULL,
    qty              INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    total_cents      INTEGER NOT NULL CHECK (total_cents >= 0)
);

-- 6. Ventas y pagos ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS sales (
    id             TEXT PRIMARY KEY,
    business_id    TEXT NOT NULL REFERENCES businesses(id),
    client_id      INTEGER REFERENCES clients(id),
    appointment_id TEXT REFERENCES appointments(id),
    status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'paid', 'void')),
    total_cents    INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
    paid_at        TEXT,
    created_by     TEXT REFERENCES users(id),
    created_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_sales_business_created
    ON sales(business_id, created_at);

CREATE TABLE IF NOT EXISTS sale_items (
    id               TEXT PRIMARY KEY,
    business_id      TEXT NOT NULL REFERENCES businesses(id),
    sale_id          TEXT NOT NULL REFERENCES sales(id),
    item_type        TEXT NOT NULL CHECK (item_type IN ('service', 'product')),
    item_id          TEXT NOT NULL,
    qty              INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    total_cents      INTEGER NOT NULL CHECK (total_cents >= 0)
);

CREATE TABLE IF NOT EXISTS payments (
    id           TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    sale_id      TEXT NOT NULL REFERENCES sales(id),
    method       TEXT NOT NULL
                 CHECK (method IN ('cash', 'card', 'transfer', 'nequi', 'daviplata')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    reference    TEXT,
    paid_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_payments_business_paid
    ON payments(business_id, paid_at);

-- 7. Finanzas ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS expenses (
    id           TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    category     TEXT NOT NULL,
    reason       TEXT NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    incurred_at  TEXT NOT NULL,
    vendor       TEXT,
    receipt_url  TEXT,
    created_by   TEXT REFERENCES users(id),
    created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_expenses_business_incurred
    ON expenses(business_id, incurred_at);

CREATE TABLE IF NOT EXISTS cash_sessions (
    id            TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL REFERENCES businesses(id),
    opened_by     TEXT REFERENCES users(id),
    opened_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at     TEXT,
    opening_cents INTEGER NOT NULL DEFAULT 0,
    closing_cents INTEGER
);

CREATE TABLE IF NOT EXISTS cash_movements (
    id              TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    cash_session_id TEXT NOT NULL REFERENCES cash_sessions(id),
    type            TEXT NOT NULL CHECK (type IN ('in', 'out')),
    amount_cents    INTEGER NOT NULL CHECK (amount_cents > 0),
    reason          TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 8. Conversaciones ---------------------------------------------------------

CREATE TABLE IF NOT EXISTS conversations (
    id              TEXT PRIMARY KEY,
    business_id     TEXT NOT NULL REFERENCES businesses(id),
    client_id       INTEGER REFERENCES clients(id),
    wa_contact      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'inactive', 'closed')),
    last_message_at TEXT,
    assigned_to     TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (business_id, wa_contact)
);

CREATE INDEX IF NOT EXISTS idx_conversations_business_last
    ON conversations(business_id, last_message_at);

-- 9. IA ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ai_extractions (
    id            TEXT PRIMARY KEY,
    business_id   TEXT NOT NULL REFERENCES businesses(id),
    source_type   TEXT NOT NULL
                  CHECK (source_type IN ('message', 'appointment', 'manual')),
    source_id     TEXT NOT NULL,
    model         TEXT NOT NULL,
    prompt_version TEXT NOT NULL,
    raw_response  TEXT NOT NULL,
    parsed_json   TEXT,
    confidence    REAL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'validated', 'rejected', 'applied')),
    target_entity TEXT,
    target_id     TEXT,
    reviewed_by   TEXT REFERENCES users(id),
    reviewed_at   TEXT,
    created_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_business_status
    ON ai_extractions(business_id, status, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
    id               TEXT PRIMARY KEY,
    business_id      TEXT NOT NULL REFERENCES businesses(id),
    extraction_id    TEXT REFERENCES ai_extractions(id),
    model            TEXT NOT NULL,
    tokens_in        INTEGER NOT NULL DEFAULT 0,
    tokens_out       INTEGER NOT NULL DEFAULT 0,
    cost_usd_micros  INTEGER NOT NULL DEFAULT 0,
    latency_ms       INTEGER,
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_business_created
    ON ai_usage(business_id, created_at);
