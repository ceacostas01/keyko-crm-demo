-- 0006_sale_edits.sql
-- Edición de ventas, devoluciones de producto y reembolsos de dinero.
--
-- Se separan tres cosas que antes estaban mezcladas:
--   · corregir una venta  → no mueve dinero ni stock salvo la diferencia
--   · anular              → estado 'void', sin efectos colaterales implícitos
--   · devolver producto   → stock + returned_qty
--   · devolver dinero     → fila en payments con kind = 'refund'
--
-- Sin tablas nuevas: todo cabe en payments y sale_items.

PRAGMA foreign_keys = ON;

-- 1. Pagos con signo explícito ---------------------------------------------
-- `amount_cents` sigue siendo positivo; `kind` dice si entra o sale dinero.

ALTER TABLE payments
    ADD COLUMN kind TEXT NOT NULL DEFAULT 'payment'
    CHECK (kind IN ('payment', 'refund'));

ALTER TABLE payments ADD COLUMN notes TEXT;

CREATE INDEX IF NOT EXISTS idx_payments_business_kind
    ON payments(business_id, kind, paid_at);

-- 2. Unidades ya devueltas por línea ---------------------------------------
-- Evita devolver dos veces el mismo artículo.

ALTER TABLE sale_items
    ADD COLUMN returned_qty INTEGER NOT NULL DEFAULT 0
    CHECK (returned_qty >= 0);

CREATE INDEX IF NOT EXISTS idx_sale_items_business_sale
    ON sale_items(business_id, sale_id);
