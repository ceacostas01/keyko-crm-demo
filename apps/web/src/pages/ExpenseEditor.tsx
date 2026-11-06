import { useEffect, useState } from 'react';
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  type ExpenseCategory,
} from '@keyko/domain';
import { api, ApiError } from '../api/client';
import type { Expense } from '../api/types';
import { Button, Field, Input, Modal, Select } from '../components/ui';
import { today } from '../lib/date';
import { centsToInput, inputToCents } from '../lib/format';
import { newIdempotencyKey } from '../lib/id';

export function ExpenseEditor({
  open,
  expense,
  onClose,
  onSaved,
}: {
  open: boolean;
  expense: Expense | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState<ExpenseCategory>('luz');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [incurredAt, setIncurredAt] = useState(today());
  const [vendor, setVendor] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCategory(expense?.category ?? 'luz');
    setReason(expense?.reason ?? '');
    setAmount(expense ? centsToInput(expense.amountCents) : '');
    setIncurredAt(expense?.incurredAt?.slice(0, 10) ?? today());
    setVendor(expense?.vendor ?? '');
    setError(null);
  }, [open, expense]);

  async function save() {
    const amountCents = inputToCents(amount);
    if (reason.trim().length < 2) {
      setError('Escribe un detalle para saber a qué corresponde el egreso.');
      return;
    }
    if (amountCents <= 0) {
      setError('El monto debe ser mayor que cero.');
      return;
    }

    setBusy(true);
    setError(null);
    const payload = {
      category,
      reason: reason.trim(),
      amountCents,
      incurredAt,
      vendor: vendor.trim() || null,
    };

    try {
      if (expense) {
        await api.expenses.update(expense.id, payload, newIdempotencyKey());
      } else {
        await api.expenses.create(payload, newIdempotencyKey());
      }
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof ApiError ? cause.message : 'No se pudo guardar el egreso.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      title={expense ? 'Editar egreso' : 'Nuevo egreso'}
      subtitle="Registra salidas de dinero del negocio."
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={save} loading={busy}>
            Guardar egreso
          </Button>
        </>
      }
    >
      {error ? (
        <div className="login-error" style={{ marginBottom: 14 }}>
          {error}
        </div>
      ) : null}

      <div className="form-grid">
        <Field label="Tipo de servicio" hint="¿A qué corresponde el pago?">
          <Select
            value={category}
            onChange={(event) =>
              setCategory(event.target.value as ExpenseCategory)
            }
            autoFocus
          >
            {EXPENSE_CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {EXPENSE_CATEGORY_LABELS[value]}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Fecha">
          <Input
            type="date"
            value={incurredAt}
            onChange={(event) => setIncurredAt(event.target.value)}
            required
          />
        </Field>

        <div className="span-2">
          <Field
            label="Detalle"
            hint="Ej.: recibo de luz de octubre, turno de Laura, arriendo de noviembre."
          >
            <Input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Detalle del egreso"
              maxLength={200}
              required
            />
          </Field>
        </div>

        <Field label="Monto (COP)">
          <Input
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="150.000"
            inputMode="numeric"
            required
          />
        </Field>

        <Field label="Pagado a" hint="Opcional: proveedor o persona">
          <Input
            value={vendor}
            onChange={(event) => setVendor(event.target.value)}
            placeholder="Ej.: Enel, Laura Gómez"
            maxLength={120}
          />
        </Field>
      </div>
    </Modal>
  );
}
