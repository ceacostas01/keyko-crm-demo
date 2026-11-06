import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  EXPENSE_CATEGORY_LABELS,
} from '@keyko/domain';
import { api, ApiError } from '../api/client';
import type { Expense, SaleListRow } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Icon } from '../components/Icon';
import {
  Badge,
  Button,
  Confirm,
  EmptyState,
  Input,
  Spinner,
  useToast,
} from '../components/ui';
import { dayLabel, formatCop, SALE_STATUS_LABELS, stampLocal } from '../lib/format';
import { ExpenseEditor } from './ExpenseEditor';

type Filter = 'all' | 'open' | 'paid' | 'void';
type Section = 'sales' | 'expenses';

export function SalesPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [section, setSection] = useState<Section>('sales');
  const [filter, setFilter] = useState<Filter>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [expenseEditing, setExpenseEditing] = useState<Expense | 'new' | null>(
    null,
  );
  const [expenseToDelete, setExpenseToDelete] = useState<Expense | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [saleToDelete, setSaleToDelete] = useState<SaleListRow | null>(null);
  const [deletingSale, setDeletingSale] = useState(false);

  const range = useMemo(
    () => ({ ...(from ? { from } : {}), ...(to ? { to } : {}) }),
    [from, to],
  );

  const sales = useAsync(
    () =>
      api.sales.list({
        ...range,
        ...(filter === 'all' ? {} : { status: filter }),
      }),
    [range, filter],
  );
  const expenses = useAsync(() => api.expenses.list(range), [range]);
  const summary = useAsync(() => api.sales.summary(range.from, range.to), [
    range.from,
    range.to,
  ]);

  const rows = sales.data?.data ?? [];
  const expenseRows = expenses.data?.data ?? [];
  const totals = summary.data?.data ?? null;
  const filtered = Boolean(from || to);

  const incomeCents = totals?.netCollectedCents ?? 0;
  const expenseCents = totals?.expensesCents ?? 0;
  const balanceCents = incomeCents - expenseCents;

  async function removeExpense() {
    if (!expenseToDelete) return;
    setDeleting(true);
    try {
      await api.expenses.remove(expenseToDelete.id);
      setExpenseToDelete(null);
      expenses.reload();
      summary.reload();
      toast('Egreso eliminado.');
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo eliminar.',
        'error',
      );
    } finally {
      setDeleting(false);
    }
  }

  async function removeSale() {
    if (!saleToDelete) return;
    setDeletingSale(true);
    try {
      await api.sales.remove(saleToDelete.id);
      setSaleToDelete(null);
      sales.reload();
      summary.reload();
      toast('Venta eliminada.');
    } catch (cause) {
      toast(
        cause instanceof ApiError ? cause.message : 'No se pudo eliminar.',
        'error',
      );
    } finally {
      setDeletingSale(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Ventas</h1>
          <p>Ingresos, egresos y ventas del periodo.</p>
        </div>
        {section === 'sales' ? (
          <Button
            variant="primary"
            icon="plus"
            onClick={() => navigate('/sales/new')}
          >
            Nueva venta
          </Button>
        ) : (
          <Button
            variant="primary"
            icon="plus"
            onClick={() => setExpenseEditing('new')}
          >
            Nuevo egreso
          </Button>
        )}
      </div>

      <div className="filter-bar filter-bar-dates" style={{ marginBottom: 14 }}>
        <label className="row small muted" style={{ gap: 6 }}>
          Desde
          <Input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            style={{ width: 160 }}
          />
        </label>
        <label className="row small muted" style={{ gap: 6 }}>
          Hasta
          <Input
            type="date"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            style={{ width: 160 }}
          />
        </label>
        {filtered ? (
          <Button
            variant="subtle"
            onClick={() => {
              setFrom('');
              setTo('');
            }}
          >
            Limpiar fechas
          </Button>
        ) : null}
      </div>

      <section className="stat-grid" style={{ marginBottom: 16 }}>
        <div className="stat">
          <span className="stat-label">Ingresos</span>
          <strong className="stat-value">{formatCop(incomeCents)}</strong>
          <span className="stat-hint">
            {formatCop(totals?.collectedCents ?? 0)} cobrado ·{' '}
            {formatCop(totals?.refundedCents ?? 0)} devuelto
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Egresos</span>
          <strong className="stat-value">{formatCop(expenseCents)}</strong>
          <span className="stat-hint">
            {totals?.expenseCount ?? 0} egreso
            {totals?.expenseCount === 1 ? '' : 's'}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">Balance</span>
          <strong
            className={`stat-value ${balanceCents < 0 ? 'is-negative' : ''}`}
          >
            {formatCop(balanceCents)}
          </strong>
          <span className="stat-hint">Ingresos menos egresos</span>
        </div>
        <div className="stat">
          <span className="stat-label">Ventas</span>
          <strong className="stat-value">{totals?.salesCount ?? 0}</strong>
          <span className="stat-hint">
            {totals?.servicesCount ?? 0} servicios ·{' '}
            {totals?.productsCount ?? 0} artículos
          </span>
        </div>
      </section>

      <div className="tabs section-tabs" role="tablist" style={{ marginBottom: 14 }}>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'sales'}
          onClick={() => setSection('sales')}
        >
          Ventas
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={section === 'expenses'}
          onClick={() => setSection('expenses')}
        >
          Egresos
        </button>
      </div>

      {section === 'sales' ? (
        <>
          <div className="tabs" role="tablist" style={{ marginBottom: 14 }}>
            {(
              [
                ['all', 'Todas'],
                ['open', 'Pendientes'],
                ['paid', 'Pagadas'],
                ['void', 'Anuladas'],
              ] as Array<[Filter, string]>
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>

          {sales.loading ? (
            <div className="card card-pad">
              <Spinner label="Cargando ventas…" />
            </div>
          ) : sales.error ? (
            <EmptyState
              icon="alert"
              title="No se pudieron cargar las ventas"
              hint={sales.error.message}
              action={<Button onClick={sales.reload}>Reintentar</Button>}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              icon="tag"
              title="Sin ventas"
              hint={
                filtered
                  ? 'No hay ventas en ese rango de fechas.'
                  : 'Registra la primera desde una mascota o desde aquí.'
              }
              action={
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => navigate('/sales/new')}
                >
                  Nueva venta
                </Button>
              }
            />
          ) : (
            <div className="card">
              <div className="list">
                {rows.map((sale) => (
                  <SaleRow
                    key={sale.id}
                    sale={sale}
                    onEnter={() => navigate(`/sales/${sale.id}`)}
                    onEdit={() => navigate(`/sales/${sale.id}/edit`)}
                    onDelete={() => setSaleToDelete(sale)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      ) : (
        <>
          {expenses.loading ? (
            <div className="card card-pad">
              <Spinner label="Cargando egresos…" />
            </div>
          ) : expenses.error ? (
            <EmptyState
              icon="alert"
              title="No se pudieron cargar los egresos"
              hint={expenses.error.message}
              action={<Button onClick={expenses.reload}>Reintentar</Button>}
            />
          ) : expenseRows.length === 0 ? (
            <EmptyState
              icon="tag"
              title="Sin egresos registrados"
              hint={
                filtered
                  ? 'No hay egresos en ese rango de fechas.'
                  : 'Registra luz, agua, arriendo, personal o cualquier otro pago.'
              }
              action={
                <Button
                  variant="primary"
                  icon="plus"
                  onClick={() => setExpenseEditing('new')}
                >
                  Nuevo egreso
                </Button>
              }
            />
          ) : (
            <div className="card">
              <div className="card-head">
                <h2>Egresos del periodo</h2>
                <span className="muted small">
                  {formatCop(expenseCents)} · {expenseRows.length} registro
                  {expenseRows.length === 1 ? '' : 's'}
                </span>
              </div>
              <div className="list">
                {expenseRows.map((expense) => (
                  <ExpenseRow
                    key={expense.id}
                    expense={expense}
                    onEdit={() => setExpenseEditing(expense)}
                    onDelete={() => setExpenseToDelete(expense)}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <ExpenseEditor
        open={expenseEditing !== null}
        expense={
          expenseEditing === 'new' ? null : (expenseEditing as Expense | null)
        }
        onClose={() => setExpenseEditing(null)}
        onSaved={() => {
          setExpenseEditing(null);
          expenses.reload();
          summary.reload();
          toast('Egreso guardado.');
        }}
      />

      <Confirm
        open={expenseToDelete !== null}
        title="Eliminar egreso"
        message={`Se quitará ${formatCop(
          expenseToDelete?.amountCents ?? 0,
        )} de ${EXPENSE_CATEGORY_LABELS[
          expenseToDelete?.category ?? 'otro'
        ]}. Esta acción no se puede deshacer.`}
        confirmLabel="Eliminar"
        onCancel={() => setExpenseToDelete(null)}
        onConfirm={removeExpense}
        busy={deleting}
      />

      <Confirm
        open={saleToDelete !== null}
        title="Eliminar venta"
        message={`Se eliminará permanentemente la venta de ${formatCop(
          saleToDelete?.totalCents ?? 0,
        )}${
          saleToDelete?.clientName ? ` de ${saleToDelete.clientName}` : ''
        }. Sus pagos y devoluciones también se borran, y el stock pendiente vuelve al inventario. Esta acción no se puede deshacer.`}
        confirmLabel="Sí, eliminar"
        onCancel={() => setSaleToDelete(null)}
        onConfirm={removeSale}
        busy={deletingSale}
      />
    </div>
  );
}

function ExpenseRow({
  expense,
  onEdit,
  onDelete,
}: {
  expense: Expense;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="list-item expense-row">
      <span className="empty-icon" style={{ width: 40, height: 40 }}>
        <Icon name="tag" size={18} />
      </span>
      <div className="list-item-body">
        <strong>
          {EXPENSE_CATEGORY_LABELS[expense.category] ?? expense.category}
          {expense.vendor ? ` · ${expense.vendor}` : ''}
        </strong>
        <span>{expense.reason}</span>
        <span className="small muted">{dayLabel(expense.incurredAt)}</span>
      </div>
      <strong className="expense-amount">
        -{formatCop(expense.amountCents)}
      </strong>
      <div className="row-actions">
        <Button variant="subtle" className="btn-sm" onClick={onEdit}>
          Editar
        </Button>
        <Button
          variant="subtle"
          icon="trash"
          className="btn-sm btn-icon"
          onClick={onDelete}
          aria-label={`Eliminar egreso de ${EXPENSE_CATEGORY_LABELS[expense.category]}`}
        />
      </div>
    </div>
  );
}

function SaleRow({
  sale,
  onEnter,
  onEdit,
  onDelete,
}: {
  sale: SaleListRow;
  onEnter: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const people =
    sale.petNames.length > 0 ? sale.petNames.join(', ') : 'Sin mascota';
  const hasRefund = sale.refundedCents > 0;

  return (
    <div className="list-item client-row">
      <button type="button" className="client-row-main" onClick={onEnter}>
        <span className="empty-icon" style={{ width: 40, height: 40 }}>
          <Icon name="tag" size={18} />
        </span>
        <span className="list-item-body">
          <strong>
            {sale.clientName ?? 'Sin cliente'} · {people}
          </strong>
          <span>
            {sale.services.length > 0 ? sale.services.join(', ') : 'Artículos'}
            {' · '}
            {stampLocal(sale.createdAtLocal)}
            {hasRefund ? ` · devuelto ${formatCop(sale.refundedCents)}` : ''}
          </span>
        </span>
        <span className="col" style={{ alignItems: 'flex-end', gap: 3 }}>
          <strong className="price">{formatCop(sale.totalCents)}</strong>
          <Badge
            tone={
              sale.status === 'void'
                ? 'neutral'
                : sale.status === 'paid'
                  ? 'ok'
                  : 'warn'
            }
          >
            {SALE_STATUS_LABELS[sale.status]}
          </Badge>
        </span>
      </button>
      <span className="row" style={{ gap: 4 }}>
        {sale.status !== 'void' ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm btn-icon"
            aria-label="Editar venta"
            title="Editar venta"
            onClick={onEdit}
          >
            <Icon name="edit" size={16} />
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-icon"
          aria-label="Eliminar venta"
          title="Eliminar venta"
          onClick={onDelete}
        >
          <Icon name="trash" size={16} />
        </button>
      </span>
    </div>
  );
}
