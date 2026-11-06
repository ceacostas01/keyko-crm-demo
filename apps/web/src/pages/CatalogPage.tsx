import { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { Product } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Icon } from '../components/Icon';
import {
  Badge,
  Button,
  Confirm,
  EmptyState,
  Field,
  Input,
  Modal,
  Spinner,
  useToast,
} from '../components/ui';
import { centsToInput, formatCop, inputToCents } from '../lib/format';

export function CatalogPage() {
  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Catálogo</h1>
          <p>Artículos físicos con stock. Los servicios se escriben en cada venta.</p>
        </div>
      </div>

      <ProductsTab />
    </div>
  );
}

function ProductsTab() {
  const { toast } = useToast();
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [stockFor, setStockFor] = useState<Product | null>(null);
  const [toDelete, setToDelete] = useState<Product | null>(null);
  const products = useAsync(() => api.products.list(), []);

  async function remove() {
    if (!toDelete) return;
    try {
      await api.products.remove(toDelete.id);
      setToDelete(null);
      products.reload();
      toast('Artículo eliminado.');
    } catch (cause) {
      toast(cause instanceof ApiError ? cause.message : 'No se pudo eliminar.', 'error');
    }
  }

  const rows = products.data?.data ?? [];

  return (
    <div className="card">
      <div className="card-head">
        <h2>Artículos</h2>
        <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
          Nuevo artículo
        </Button>
      </div>

      {products.loading ? (
        <div className="card-pad">
          <Spinner label="Cargando artículos…" />
        </div>
      ) : rows.length === 0 ? (
        <div className="card-pad">
          <EmptyState
            icon="box"
            title="Sin artículos"
            hint="Shampoo, cepillos, snacks… con su stock y precio."
            action={
              <Button variant="primary" icon="plus" onClick={() => setEditing('new')}>
                Nuevo artículo
              </Button>
            }
          />
        </div>
      ) : (
        <div className="list">
          {rows.map((product) => {
            const low = product.stock <= product.minStock;
            return (
              <div
                className="list-item product-row"
                key={product.id}
                style={{ cursor: 'default' }}
              >
                <span className="empty-icon" style={{ width: 40, height: 40 }}>
                  <Icon name="box" size={18} />
                </span>
                <div className="list-item-body">
                  <strong>{product.name}</strong>
                  <span>
                    {product.sku ? `${product.sku} · ` : ''}
                    {formatCop(product.priceCents)}
                  </span>
                </div>
                <Badge tone={low ? 'warn' : 'ok'}>
                  {product.stock} en stock
                </Badge>
                <div className="row-actions">
                  <Button
                    variant="subtle"
                    className="btn-sm"
                    onClick={() => setStockFor(product)}
                  >
                    Stock
                  </Button>
                  <Button
                    variant="subtle"
                    className="btn-sm"
                    onClick={() => setEditing(product)}
                  >
                    Editar
                  </Button>
                  <Button
                    variant="subtle"
                    icon="trash"
                    className="btn-sm btn-icon"
                    onClick={() => setToDelete(product)}
                    aria-label={`Eliminar ${product.name}`}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <ProductEditor
        open={editing !== null}
        product={editing === 'new' ? null : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          products.reload();
          toast('Artículo guardado.');
        }}
      />

      <StockEditor
        product={stockFor}
        onClose={() => setStockFor(null)}
        onSaved={() => {
          setStockFor(null);
          products.reload();
          toast('Stock actualizado.');
        }}
      />

      <Confirm
        open={toDelete !== null}
        title="Eliminar artículo"
        message={`${toDelete?.name ?? 'Este artículo'} dejará de aparecer en el catálogo.`}
        confirmLabel="Eliminar"
        onCancel={() => setToDelete(null)}
        onConfirm={remove}
      />
    </div>
  );
}

function ProductEditor({
  open,
  product,
  onClose,
  onSaved,
}: {
  open: boolean;
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [stock, setStock] = useState('0');
  const [minStock, setMinStock] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSku(product?.sku ?? '');
    setName(product?.name ?? '');
    setPrice(product ? centsToInput(product.priceCents) : '');
    setCost(product ? centsToInput(product.costCents) : '');
    setStock(String(product?.stock ?? 0));
    setMinStock(String(product?.minStock ?? 0));
    setError(null);
  }, [open, product]);

  async function save() {
    setBusy(true);
    setError(null);
    const payload = {
      sku: sku.trim() === '' ? null : sku.trim().toUpperCase(),
      name: name.trim(),
      priceCents: inputToCents(price),
      costCents: inputToCents(cost),
      minStock: Number(minStock) || 0,
    };
    try {
      if (product) {
        await api.products.update(product.id, payload);
      } else {
        await api.products.create({ ...payload, stock: Number(stock) || 0 });
      }
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={product ? 'Editar artículo' : 'Nuevo artículo'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Guardar
          </Button>
        </>
      }
    >
      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="form-grid">
        <div className="span-2">
          <Field label="Nombre">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Shampoo hipoalergénico"
              autoFocus
            />
          </Field>
        </div>
        <Field label="SKU" hint="Opcional, único por negocio">
          <Input
            value={sku}
            onChange={(event) => setSku(event.target.value)}
            placeholder="SH-01"
          />
        </Field>
        <Field label="Precio (COP)">
          <Input
            value={price}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="32.000"
            inputMode="numeric"
          />
        </Field>
        <Field label="Costo (COP)">
          <Input
            value={cost}
            onChange={(event) => setCost(event.target.value)}
            placeholder="18.000"
            inputMode="numeric"
          />
        </Field>
        {product ? null : (
          <Field label="Stock inicial">
            <Input
              type="number"
              min={0}
              value={stock}
              onChange={(event) => setStock(event.target.value)}
              inputMode="numeric"
            />
          </Field>
        )}
        <Field label="Stock mínimo" hint="Avisa cuando baje de aquí">
          <Input
            type="number"
            min={0}
            value={minStock}
            onChange={(event) => setMinStock(event.target.value)}
            inputMode="numeric"
          />
        </Field>
      </div>

      {product ? (
        <p className="muted small" style={{ marginTop: 14 }}>
          El stock se cambia desde el botón «Stock» para dejar registro de cada
          movimiento.
        </p>
      ) : null}
    </Modal>
  );
}

function StockEditor({
  product,
  onClose,
  onSaved,
}: {
  product: Product | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [delta, setDelta] = useState('1');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!product) return;
    setDelta('1');
    setReason('');
    setError(null);
  }, [product]);

  async function save() {
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      await api.products.adjustStock(product.id, {
        delta: Number(delta) || 0,
        reason: reason.trim() === '' ? 'Ajuste manual' : reason.trim(),
      });
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo ajustar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={product !== null}
      title={`Stock · ${product?.name ?? ''}`}
      subtitle={`Actual: ${product?.stock ?? 0} unidades`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Aplicar
          </Button>
        </>
      }
    >
      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <div className="form-grid">
        <Field label="Cambio" hint="Positivo suma, negativo resta">
          <Input
            type="number"
            value={delta}
            onChange={(event) => setDelta(event.target.value)}
            inputMode="numeric"
          />
        </Field>
        <Field label="Motivo">
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Compra, venta, ajuste…"
          />
        </Field>
      </div>
    </Modal>
  );
}
