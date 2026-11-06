import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client';
import type { Sale, SaleHistoryEntry } from '../api/types';
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
  Select,
  Spinner,
  useToast,
} from '../components/ui';
import { newIdempotencyKey } from '../lib/id';
import {
  centsToInput,
  formatCop,
  inputToCents,
  PAYMENT_LABELS,
  SALE_STATUS_LABELS,
  stampLocal,
} from '../lib/format';

const ACTION_LABELS: Record<string, string> = {
  'sale.create': 'Venta creada',
  'sale.update': 'Venta corregida',
  'sale.payment': 'Pago registrado',
  'sale.refund': 'Devolución de dinero',
  'sale.return': 'Devolución de productos',
  'sale.void': 'Venta anulada',
  'sale.delete': 'Venta eliminada',
};

export function SaleDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const sale = useAsync(() => api.sales.get(String(id)), [id]);
  const [paying, setPaying] = useState(false);
  const [refunding, setRefunding] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [returning, setReturning] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);

  const data = sale.data?.data ?? null;

  const remainingByProduct = (saleData: Sale): number =>
    saleData.items
      .filter((item) => item.itemType === 'product')
      .reduce((total, item) => total + (item.qty - item.returnedQty), 0);

  async function doReturn() {
    if (!data) return;
    setBusy(true);
    try {
      await api.sales.returnProducts(data.id, {}, newIdempotencyKey());
      setReturning(false);
      sale.reload();
      toast('Productos devueltos al inventario.');
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo devolver.',
        'error',
      );
    } finally {
      setBusy(false);
    }
  }

  async function removeSale() {
    if (!data) return;
    setDeleting(true);
    try {
      await api.sales.remove(data.id);
      toast('Venta eliminada.');
      navigate('/sales');
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo eliminar.',
        'error',
      );
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  if (sale.loading) {
    return (
      <div className="card card-pad">
        <Spinner label="Cargando venta…" />
      </div>
    );
  }

  if (sale.error || !data) {
    return (
      <EmptyState
        icon="alert"
        title="No se encontró la venta"
        hint={sale.error?.message}
        action={<Button onClick={() => navigate('/sales')}>Volver a ventas</Button>}
      />
    );
  }

  const petIds = [
    ...new Set(data.items.map((item) => item.petId).filter(Boolean)),
  ] as string[];
  const remaining = remainingByProduct(data);
  const isVoid = data.status === 'void';

  return (
    <div className="col" style={{ gap: 18 }}>
      <Link to="/sales" className="row muted small" style={{ gap: 6 }}>
        <Icon name="back" size={16} /> Ventas
      </Link>

      <div className="page-head" style={{ marginBottom: 0 }}>
        <div>
          <h1>{formatCop(data.totalCents)}</h1>
          <p>
            {data.client?.name ?? 'Sin cliente'} ·{' '}
            {stampLocal(data.createdAtLocal ?? data.createdAt)}
            {data.appointmentId ? ' · desde una cita' : ''}
          </p>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Badge tone={isVoid ? 'neutral' : data.status === 'paid' ? 'ok' : 'warn'}>
            {SALE_STATUS_LABELS[data.status]}
          </Badge>
          {!isVoid ? (
            <Button onClick={() => navigate(`/sales/${data.id}/edit`)}>Editar</Button>
          ) : null}
          {!isVoid && data.pendingCents > 0 ? (
            <Button variant="primary" onClick={() => setPaying(true)}>
              Registrar pago
            </Button>
          ) : null}
          {data.netPaidCents > 0 ? (
            <Button onClick={() => setRefunding(true)}>Devolver dinero</Button>
          ) : null}
          {remaining > 0 ? (
            <Button onClick={() => setReturning(true)}>
              Devolver productos
            </Button>
          ) : null}
          {!isVoid ? (
            <Button variant="subtle" icon="trash" onClick={() => setVoiding(true)}>
              Anular
            </Button>
          ) : null}
          <Button
            variant="subtle"
            icon="trash"
            onClick={() => setConfirmDelete(true)}
          >
            Eliminar
          </Button>
        </div>
      </div>

      <section className="stat-grid">
        <Stat label="Total vendido" value={formatCop(data.totalCents)} />
        <Stat label="Cobrado (neto)" value={formatCop(data.netPaidCents)} />
        <Stat
          label="Pendiente"
          value={formatCop(data.pendingCents)}
          tone={data.pendingCents > 0 ? 'warn' : undefined}
        />
        <Stat
          label="Reembolsado"
          value={formatCop(data.refundedCents)}
          tone={data.refundedCents > 0 ? 'danger' : undefined}
        />
      </section>

      {data.overpaidCents > 0 ? (
        <div className="warn-item">
          <Icon name="alert" size={16} />
          <span>
            Hay {formatCop(data.overpaidCents)} a favor del cliente. Regístralo
            con «Devolver dinero» para que la caja cuadre.
          </span>
        </div>
      ) : null}

      <section className="card">
        <div className="card-head">
          <h2>Conceptos</h2>
        </div>
        <div className="list">
          {data.items.map((item) => (
            <div className="list-item" key={item.id} style={{ cursor: 'default' }}>
              <span className="empty-icon" style={{ width: 38, height: 38 }}>
                <Icon name={item.itemType === 'service' ? 'sparkle' : 'box'} size={16} />
              </span>
              <div className="list-item-body">
                <strong>{item.name}</strong>
                <span>
                  {item.petName ? `${item.petName} · ` : ''}
                  {item.qty} × {formatCop(item.unitPriceCents)}
                  {item.returnedQty > 0 ? ` · ${item.returnedQty} devueltas` : ''}
                  {item.notes ? ` · ${item.notes}` : ''}
                </span>
              </div>
              <span className="price">{formatCop(item.totalCents)}</span>
            </div>
          ))}
        </div>
        <div className="sale-summary">
          <span>Subtotal {formatCop(data.subtotalCents)}</span>
          {data.discountCents > 0 ? (
            <span>Descuento −{formatCop(data.discountCents)}</span>
          ) : null}
          <strong>Total {formatCop(data.totalCents)}</strong>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Movimientos de dinero</h2>
        </div>
        {data.payments.length === 0 ? (
          <p className="muted small" style={{ padding: 16 }}>
            Sin movimientos. La venta está pendiente.
          </p>
        ) : (
          <div className="list">
            {data.payments.map((payment) => (
              <div className="list-item" key={payment.id} style={{ cursor: 'default' }}>
                <div className="list-item-body">
                  <strong>
                    {payment.kind === 'refund' ? 'Devolución · ' : ''}
                    {PAYMENT_LABELS[payment.method] ?? payment.method}
                  </strong>
                  <span>
                    {stampLocal(payment.paidAtLocal ?? payment.paidAt)}
                    {payment.notes ? ` · ${payment.notes}` : ''}
                  </span>
                </div>
                <span
                  className="price"
                  style={{ color: payment.kind === 'refund' ? 'var(--danger)' : undefined }}
                >
                  {payment.kind === 'refund' ? '−' : ''}
                  {formatCop(payment.amountCents)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Historial</h2>
        </div>
        <div className="card-pad">
          {data.history.length === 0 ? (
            <p className="muted small">Sin cambios registrados.</p>
          ) : (
            <ol className="timeline">
              {data.history.map((entry) => (
                <li key={entry.id} className="timeline-item is-note">
                  <span className="timeline-dot">
                    <Icon name="clock" size={14} />
                  </span>
                  <div className="grow">
                    <strong className="small">
                      {ACTION_LABELS[entry.action] ?? entry.action}
                    </strong>
                    <span className="muted small">
                      {stampLocal(entry.createdAtLocal ?? entry.createdAt)}
                      {entry.actorName ? ` · ${entry.actorName}` : ''}
                    </span>
                    <p className="small muted" style={{ marginTop: 2 }}>
                      {describeDiff(entry)}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>

      <section className="card card-pad">
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {data.clientId ? (
            <Link className="btn btn-ghost" to={`/clients/${data.clientId}`}>
              <Icon name="users" size={17} /> Abrir propietario
            </Link>
          ) : null}
          {petIds.map((petId) => (
            <Link key={petId} className="btn btn-ghost" to={`/pets/${petId}`}>
              <Icon name="paw" size={17} /> Ver mascota
            </Link>
          ))}
        </div>
        {data.notes ? (
          <p className="small" style={{ marginTop: 12 }}>
            {data.notes}
          </p>
        ) : null}
      </section>

      <PaymentModal
        open={paying}
        sale={data}
        onClose={() => setPaying(false)}
        onSaved={() => {
          setPaying(false);
          sale.reload();
          toast('Pago registrado.');
        }}
      />

      <RefundModal
        open={refunding}
        sale={data}
        onClose={() => setRefunding(false)}
        onSaved={() => {
          setRefunding(false);
          sale.reload();
          toast('Devolución registrada.');
        }}
      />

      <VoidModal
        open={voiding}
        sale={data}
        remaining={remaining}
        onClose={() => setVoiding(false)}
        onSaved={() => {
          setVoiding(false);
          sale.reload();
          toast('Venta anulada.');
        }}
      />

      <Confirm
        open={returning}
        title="Devolver productos"
        message={`Se devolverán ${remaining} unidad(es) al inventario y quedarán marcadas como devueltas en la venta. No se mueve dinero.`}
        confirmLabel="Devolver"
        tone="primary"
        busy={busy}
        onCancel={() => setReturning(false)}
        onConfirm={doReturn}
      />

      <Confirm
        open={confirmDelete}
        title="Eliminar venta"
        message={`Se eliminará permanentemente la venta de ${formatCop(
          data.totalCents,
        )}, sus pagos y devoluciones. El stock de productos pendientes vuelve al inventario. Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar venta"
        busy={deleting}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={removeSale}
      />
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'warn' | 'danger';
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong
        className="stat-value"
        style={{
          color:
            tone === 'warn' ? 'var(--warn)' : tone === 'danger' ? 'var(--danger)' : undefined,
        }}
      >
        {value}
      </strong>
    </div>
  );
}

function describeDiff(entry: SaleHistoryEntry): string {
  const diff = entry.diff as Record<string, { from?: unknown; to?: unknown }> | null;
  if (!diff) return '';

  const parts: string[] = [];

  if (diff.totalCents) {
    parts.push(
      `Total ${formatCop(Number(diff.totalCents.from ?? 0))} → ${formatCop(
        Number(diff.totalCents.to ?? 0),
      )}`,
    );
  }
  if (diff.refundedCents) {
    parts.push(
      `Reembolsado ${formatCop(Number(diff.refundedCents.to ?? 0))}`,
    );
  }
  if (diff.amountCents && diff.method) {
    parts.push(
      `${String(diff.method.to)} · ${formatCop(Number(diff.amountCents.to ?? 0))}`,
    );
  }
  if (diff.returnedUnits) {
    parts.push(`${String(diff.returnedUnits.to)} unidad(es)`);
  }
  if (diff.status) {
    parts.push(
      `${SALE_STATUS_LABELS[String(diff.status.from ?? '')] ?? diff.status.from} → ${
        SALE_STATUS_LABELS[String(diff.status.to ?? '')] ?? diff.status.to
      }`,
    );
  }
  if (diff.reason && diff.reason.to) parts.push(String(diff.reason.to));

  return parts.join(' · ');
}

function PaymentModal({
  open,
  sale,
  onClose,
  onSaved,
}: {
  open: boolean;
  sale: Sale;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.sales.addPayment(
        sale.id,
        { method, amountCents: inputToCents(amount) || sale.pendingCents },
        newIdempotencyKey(),
      );
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo registrar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Registrar pago"
      subtitle={`Pendiente: ${formatCop(sale.pendingCents)}`}
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
        <Field label="Medio de pago">
          <Select value={method} onChange={(event) => setMethod(event.target.value)}>
            {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Monto (COP)" hint={`Máximo ${formatCop(sale.pendingCents)}`}>
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={centsToInput(sale.pendingCents)}
            inputMode="numeric"
          />
        </Field>
      </div>
    </Modal>
  );
}

function RefundModal({
  open,
  sale,
  onClose,
  onSaved,
}: {
  open: boolean;
  sale: Sale;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suggested = sale.overpaidCents > 0 ? sale.overpaidCents : sale.netPaidCents;

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.sales.refund(
        sale.id,
        {
          method,
          amountCents: inputToCents(amount) || suggested,
          notes: notes.trim() === '' ? null : notes.trim(),
        },
        newIdempotencyKey(),
      );
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo devolver.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Devolver dinero"
      subtitle={`Disponible: ${formatCop(sale.netPaidCents)}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={save} loading={busy}>
            Registrar devolución
          </Button>
        </>
      }
    >
      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}
      <div className="form-grid">
        <Field label="Medio">
          <Select value={method} onChange={(event) => setMethod(event.target.value)}>
            {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Monto (COP)"
          hint={sale.overpaidCents > 0 ? 'Sugerido: el saldo a favor' : undefined}
        >
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder={centsToInput(suggested)}
            inputMode="numeric"
          />
        </Field>
        <div className="span-2">
          <Field label="Motivo (opcional)">
            <Input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Ajuste de precio, servicio no realizado…"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

function VoidModal({
  open,
  sale,
  remaining,
  onClose,
  onSaved,
}: {
  open: boolean;
  sale: Sale;
  remaining: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [returnProducts, setReturnProducts] = useState(true);
  const [refundMoney, setRefundMoney] = useState(sale.netPaidCents > 0);
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.sales.void(
        sale.id,
        {
          returnProducts: returnProducts && remaining > 0,
          ...(refundMoney && sale.netPaidCents > 0
            ? {
                refund: {
                  method,
                  amountCents: inputToCents(amount) || sale.netPaidCents,
                  notes: notes.trim() === '' ? null : notes.trim(),
                },
              }
            : {}),
          ...(notes.trim() === '' ? {} : { notes: notes.trim() }),
        },
        newIdempotencyKey(),
      );
      onSaved();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'No se pudo anular.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title="Anular venta"
      subtitle="Elige qué pasa con el inventario y el dinero."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="danger" onClick={save} loading={busy}>
            Anular
          </Button>
        </>
      }
    >
      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <p className="small muted" style={{ marginBottom: 14 }}>
        Anular solo saca la venta de los ingresos. Nada se devuelve si no lo
        marcas aquí.
      </p>

      <label className="switch">
        <input
          type="checkbox"
          checked={returnProducts && remaining > 0}
          disabled={remaining === 0}
          onChange={(event) => setReturnProducts(event.target.checked)}
        />
        Devolver {remaining} artículo(s) al inventario
      </label>

      <label className="switch">
        <input
          type="checkbox"
          checked={refundMoney && sale.netPaidCents > 0}
          disabled={sale.netPaidCents === 0}
          onChange={(event) => setRefundMoney(event.target.checked)}
        />
        Devolver {formatCop(sale.netPaidCents)} al cliente
      </label>

      {refundMoney && sale.netPaidCents > 0 ? (
        <div className="form-grid" style={{ marginTop: 10 }}>
          <Field label="Medio de la devolución">
            <Select value={method} onChange={(event) => setMethod(event.target.value)}>
              {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Monto (COP)">
            <Input
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder={centsToInput(sale.netPaidCents)}
              inputMode="numeric"
            />
          </Field>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <Field label="Motivo (opcional)">
          <Input
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            placeholder="Cliente canceló, error de cobro…"
          />
        </Field>
      </div>
    </Modal>
  );
}
