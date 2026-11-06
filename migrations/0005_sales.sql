-- 0005_sales.sql
-- Ventas con servicios de precio libre, artículos del catálogo y varias
-- mascotas por venta. No crea tablas nuevas: extiende sales, sale_items y
-- payments, que ya existían pero no cubrían este flujo.
--
-- sale_items y payments se reconstruyen porque SQLite no permite relajar un
-- NOT NULL ni ampliar un CHECK con ALTER TABLE. Los datos existentes se
-- copian; no se pierde nada.

PRAGMA foreign_keys = ON;

-- 1. Cabecera de venta ------------------------------------------------------

ALTER TABLE sales ADD COLUMN subtotal_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sales ADD COLUMN notes TEXT;

UPDATE sales
   SET subtotal_cents = total_cents
 WHERE subtotal_cents = 0 AND total_cents > 0;

CREATE INDEX IF NOT EXISTS idx_sales_business_client
    ON sales(business_id, client_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sales_business_status
    ON sales(business_id, status, created_at);

-- 2. Líneas de venta --------------------------------------------------------
-- item_id pasa a ser opcional: los servicios se escriben a mano y no
-- pertenecen a ningún catálogo. `name` congela la descripción del momento.

CREATE TABLE sale_items_new (
    id               TEXT PRIMARY KEY,
    business_id      TEXT NOT NULL REFERENCES businesses(id),
    sale_id          TEXT NOT NULL REFERENCES sales(id),
    item_type        TEXT NOT NULL CHECK (item_type IN ('service', 'product')),
    item_id          TEXT REFERENCES products(id),
    name             TEXT NOT NULL,
    pet_id           TEXT REFERENCES pets(id),
    appointment_id   TEXT REFERENCES appointments(id),
    qty              INTEGER NOT NULL DEFAULT 1 CHECK (qty > 0),
    unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
    discount_cents   INTEGER NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
    total_cents      INTEGER NOT NULL CHECK (total_cents >= 0),
    notes            TEXT,
    created_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sale_items_new
    (id, business_id, sale_id, item_type, item_id, name, pet_id,
     appointment_id, qty, unit_price_cents, discount_cents, total_cents,
     notes, created_at)
SELECT si.id,
       si.business_id,
       si.sale_id,
       si.item_type,
       CASE WHEN si.item_type = 'product' THEN si.item_id ELSE NULL END,
       COALESCE(
           (SELECT p.name FROM products p WHERE p.id = si.item_id),
           'Servicio'
       ),
       NULL,
       NULL,
       si.qty,
       si.unit_price_cents,
       0,
       si.total_cents,
       NULL,
       CURRENT_TIMESTAMP
  FROM sale_items si;

DROP TABLE sale_items;
ALTER TABLE sale_items_new RENAME TO sale_items;

CREATE INDEX IF NOT EXISTS idx_sale_items_sale
    ON sale_items(sale_id);

CREATE INDEX IF NOT EXISTS idx_sale_items_business_pet
    ON sale_items(business_id, pet_id, created_at);

-- 3. Pagos -----------------------------------------------------------------
-- Se amplía el medio de pago con 'other'. Se conserva todo lo existente.

CREATE TABLE payments_new (
    id           TEXT PRIMARY KEY,
    business_id  TEXT NOT NULL REFERENCES businesses(id),
    sale_id      TEXT NOT NULL REFERENCES sales(id),
    method       TEXT NOT NULL
                 CHECK (method IN ('cash', 'card', 'transfer', 'nequi',
                                   'daviplata', 'other')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    reference    TEXT,
    paid_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO payments_new
    (id, business_id, sale_id, method, amount_cents, reference, paid_at)
SELECT id, business_id, sale_id, method, amount_cents, reference, paid_at
  FROM payments;

DROP TABLE payments;
ALTER TABLE payments_new RENAME TO payments;

CREATE INDEX IF NOT EXISTS idx_payments_business_paid
    ON payments(business_id, paid_at);

CREATE INDEX IF NOT EXISTS idx_payments_sale
    ON payments(sale_id);
