import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import type { Pet, Product } from '../api/types';
import { useAsync } from '../api/useAsync';
import { Button, Field, Input, Select, useToast } from '../components/ui';
import { PetEditor } from './PetEditor';
import { newIdempotencyKey } from '../lib/id';
import { today } from '../lib/date';
import { centsToInput, formatCop, inputToCents, PAYMENT_LABELS } from '../lib/format';

const SERVICE_OPTIONS = [
  'Solo baño',
  'Solo peluquería',
  'Baño y peluquería',
  'Corte de uñas',
  'Guardería',
];

export function SaleEditorPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { id: saleIdParam } = useParams();
  const editing = Boolean(saleIdParam);

  const [searchParams] = useSearchParams();
  const initialPetId = searchParams.get('petId') ?? '';
  const initialClientId = searchParams.get('clientId') ?? '';
  const appointmentId = searchParams.get('appointmentId');

  const clients = useAsync(() => api.clients.list(), []);
  const pets = useAsync(() => api.pets.list(), []);
  const products = useAsync(() => api.products.list(), []);
  const existing = useAsync(
    () =>
      editing
        ? api.sales.get(String(saleIdParam))
        : Promise.resolve(null),
    [saleIdParam],
  );
  const preloaded = useRef(false);

  const [clientId, setClientId] = useState(initialClientId);
  const [salePetId, setSalePetId] = useState(initialPetId);
  const [saleDate, setSaleDate] = useState(today());
  const [petEditorOpen, setPetEditorOpen] = useState(false);
  const [services, setServices] = useState<
    Array<{
      key: string;
      id?: string;
      name: string;
      custom: boolean;
      petId: string;
      price: string;
      notes: string;
    }>
  >([
    {
      key: newIdempotencyKey(),
      name: '',
      custom: false,
      petId: initialPetId,
      price: '',
      notes: '',
    },
  ]);
  const [items, setItems] = useState<
    Array<{
      key: string;
      id?: string;
      productId: string;
      qty: string;
      price: string;
    }>
  >([]);
  const [discount, setDiscount] = useState('');
  const [notes, setNotes] = useState('');
  const [paymentMode, setPaymentMode] = useState<'full' | 'partial' | 'pending'>(
    'full',
  );
  const [partialAmount, setPartialAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientPets = useMemo(
    () =>
      (pets.data?.data ?? []).filter(
        (pet: Pet) => !clientId || pet.clientId === Number(clientId),
      ),
    [pets.data, clientId],
  );

  const productList = products.data?.data ?? [];
  const allPets = pets.data?.data ?? [];
  const petOptions = clientId ? clientPets : allPets;
  const clientById = new Map(
    (clients.data?.data ?? []).map((client) => [client.id, client]),
  );

  // Al editar, se cargan las líneas existentes una sola vez.
  useEffect(() => {
    const sale = existing.data?.data;
    if (!sale || preloaded.current) return;
    preloaded.current = true;

    setClientId(sale.clientId ? String(sale.clientId) : '');
    setSalePetId(
      sale.items.find((item) => item.petId)?.petId ?? '',
    );
    setSaleDate(sale.createdAtLocal?.slice(0, 10) ?? today());
    setDiscount(sale.discountCents ? centsToInput(sale.discountCents) : '');
    setNotes(sale.notes ?? '');

    const serviceLines = sale.items.filter((item) => item.itemType === 'service');
    const productLines = sale.items.filter((item) => item.itemType === 'product');

    setServices(
      serviceLines.map((item) => ({
        key: item.id,
        id: item.id,
        name: item.name,
        custom: !SERVICE_OPTIONS.includes(item.name),
        petId: item.petId ?? '',
        price: centsToInput(item.unitPriceCents),
        notes: item.notes ?? '',
      })),
    );
    setItems(
      productLines.map((item) => ({
        key: item.id,
        id: item.id,
        productId: item.itemId ?? '',
        qty: String(item.qty),
        price: centsToInput(item.unitPriceCents),
      })),
    );
  }, [existing.data]);

  // Si se llega desde una mascota, se completa el cliente solo.
  useEffect(() => {
    if (clientId || !initialPetId) return;
    const pet = (pets.data?.data ?? []).find((row: Pet) => row.id === initialPetId);
    if (pet) setClientId(String(pet.clientId));
  }, [clientId, initialPetId, pets.data]);

  const subtotalCents =
    services.reduce((total, line) => {
      const price = inputToCents(line.price);
      return total + (line.name.trim() ? price : 0);
    }, 0) +
    items.reduce((total, line) => {
      const price = inputToCents(line.price);
      const qty = Number(line.qty) || 0;
      return total + (line.productId ? price * qty : 0);
    }, 0);

  const discountCents = inputToCents(discount);
  const totalCents = Math.max(0, subtotalCents - discountCents);
  const validServices = services.filter(
    (line) => line.name.trim().length > 1 && inputToCents(line.price) >= 0,
  );
  const validItems = items.filter((line) => line.productId && Number(line.qty) > 0);
  const canSave =
    (validServices.length > 0 || validItems.length > 0) &&
    discountCents <= subtotalCents;

  const validationHint =
    validServices.length === 0 && validItems.length === 0
      ? 'Añade un servicio con nombre y precio, o un artículo del catálogo.'
      : discountCents > subtotalCents
        ? 'El descuento no puede superar el subtotal.'
        : null;

  // Si el cliente tiene una sola mascota, se selecciona sola.
  useEffect(() => {
    if (!clientId || clientPets.length !== 1) return;
    const onlyPet = clientPets[0]?.id;
    if (!onlyPet) return;
    setSalePetId((current) => current || onlyPet);
    setServices((rows) => {
      if (!rows.some((row) => !row.petId)) return rows;
      return rows.map((row) => (row.petId ? row : { ...row, petId: onlyPet }));
    });
  }, [clientId, clientPets]);

  async function save() {
    setBusy(true);
    setError(null);

    const paidAmount =
      paymentMode === 'full'
        ? totalCents
        : paymentMode === 'partial'
          ? inputToCents(partialAmount)
          : 0;

    const payload = {
      ...(clientId ? { clientId: Number(clientId) } : {}),
      soldOn: saleDate,
      ...(appointmentId ? { appointmentId } : {}),
      discountCents,
      notes: notes.trim() === '' ? null : notes.trim(),
      items: [
        ...validServices.map((line) => ({
          ...(line.id ? { id: line.id } : {}),
          type: 'service',
          name: line.name.trim(),
          petId: line.petId,
          unitPriceCents: inputToCents(line.price),
          notes: line.notes.trim() === '' ? null : line.notes.trim(),
        })),
        ...validItems.map((line) => ({
          ...(line.id ? { id: line.id } : {}),
          type: 'product',
          productId: line.productId,
          qty: Number(line.qty),
          unitPriceCents: inputToCents(line.price),
        })),
      ],
      payments:
        paidAmount > 0 ? [{ method, amountCents: paidAmount }] : [],
    };

    try {
      if (editing) {
        const { payments: _ignored, ...patch } = payload;
        const result = await api.sales.update(
          String(saleIdParam),
          patch,
          newIdempotencyKey(),
        );
        toast('Venta corregida.');
        navigate(`/sales/${result.data.id}`);
        return;
      }

      const result = await api.sales.create(payload, newIdempotencyKey());
      toast(
        paymentMode === 'pending'
          ? 'Venta guardada como pendiente.'
          : 'Venta registrada.',
      );
      navigate(`/sales/${result.data.id}`);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'No se pudo guardar la venta.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sale-editor">
      <div className="page-head">
        <div>
          <h1>{editing ? 'Editar venta' : 'Nueva venta'}</h1>
          <p>
            {editing
              ? 'Los cambios recalculan totales y ajustan solo la diferencia de stock.'
              : 'Servicios con precio libre y artículos del catálogo.'}
          </p>
        </div>
      </div>

      {error ? <div className="login-error" style={{ marginBottom: 14 }}>{error}</div> : null}

      <section className="card card-pad">
        <div className="form-grid">
          <Field
            label="Cliente (opcional)"
            hint="Puedes registrar la venta sin cliente ni mascota"
          >
            <Select
              value={clientId}
              onChange={(event) => {
                const nextClientId = event.target.value;
                setClientId(nextClientId);
                setSalePetId('');
                const nextPets = (pets.data?.data ?? []).filter(
                  (pet: Pet) => String(pet.clientId) === nextClientId,
                );
                setServices((rows) =>
                  rows.map((row) => ({
                    ...row,
                    petId: nextPets.length === 1 ? (nextPets[0]?.id ?? '') : '',
                  })),
                );
              }}
            >
              <option value="">Elige un cliente…</option>
              {(clients.data?.data ?? []).map((client) => (
                <option key={client.id} value={client.id}>
                  {client.fullName ?? `Cliente ${client.id}`}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Mascota (opcional)"
            hint="La venta puede ser del cliente, de la mascota o de ambos"
          >
            <Select
              value={salePetId}
              onChange={(event) => {
                const nextPetId = event.target.value;
                setSalePetId(nextPetId);
                const pet = allPets.find((row: Pet) => row.id === nextPetId);
                if (pet) setClientId(String(pet.clientId));
                setServices((rows) =>
                  rows.map((row) =>
                    row.petId || !nextPetId
                      ? row
                      : { ...row, petId: nextPetId },
                  ),
                );
              }}
            >
              <option value="">Sin mascota</option>
              {petOptions.map((pet: Pet) => (
                <option key={pet.id} value={pet.id}>
                  {pet.name}
                  {!clientId
                    ? ` · ${
                        clientById.get(pet.clientId)?.fullName ??
                        `Cliente ${pet.clientId}`
                      }`
                    : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fecha de la venta" hint="Por defecto hoy; puedes cambiarla">
            <Input
              type="date"
              value={saleDate}
              onChange={(event) => setSaleDate(event.target.value)}
            />
          </Field>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <Button icon="plus" onClick={() => setPetEditorOpen(true)}>
              Nueva mascota
            </Button>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Servicios realizados</h2>
          <Button
            icon="plus"
            onClick={() =>
              setServices((rows) => [
                ...rows,
                {
                  key: newIdempotencyKey(),
                  name: '',
                  custom: false,
                  petId: salePetId || (clientPets.length === 1 ? (clientPets[0]?.id ?? '') : ''),
                  price: '',
                  notes: '',
                },
              ])
            }
          >
            Añadir servicio
          </Button>
        </div>
        <div className="card-pad col" style={{ gap: 12 }}>
          {services.length === 0 ? (
            <p className="muted small">Sin servicios. Añade el primero.</p>
          ) : null}
          {services.map((line, index) => (
            <div className="sale-line" key={line.key}>
              <div className="sale-line-head">
                <strong>Servicio {index + 1}</strong>
                <Button
                  variant="subtle"
                  icon="trash"
                  className="btn-sm btn-icon"
                  aria-label="Quitar servicio"
                  onClick={() =>
                    setServices((rows) => rows.filter((row) => row.key !== line.key))
                  }
                />
              </div>
              <div className="form-grid">
                <div className="span-2">
                  <Field label="Qué se hizo">
                    <Select
                      value={line.custom ? 'otro' : line.name}
                      onChange={(event) => {
                        const value = event.target.value;
                        setServices((rows) =>
                          rows.map((row) =>
                            row.key === line.key
                              ? {
                                  ...row,
                                  custom: value === 'otro',
                                  name:
                                    value === 'otro'
                                      ? row.custom
                                        ? row.name
                                        : ''
                                      : value,
                                }
                              : row,
                          ),
                        );
                      }}
                    >
                      <option value="">Elige…</option>
                      {SERVICE_OPTIONS.map((service) => (
                        <option key={service} value={service}>
                          {service}
                        </option>
                      ))}
                      <option value="otro">Otro</option>
                    </Select>
                    {line.custom ? (
                      <Input
                        value={line.name}
                        placeholder="Escribe el servicio"
                        onChange={(event) =>
                          setServices((rows) =>
                            rows.map((row) =>
                              row.key === line.key
                                ? { ...row, name: event.target.value }
                                : row,
                            ),
                          )
                        }
                      />
                    ) : null}
                  </Field>
                </div>
                <Field label="Mascota (opcional)">
                  <Select
                    value={line.petId}
                    onChange={(event) =>
                      setServices((rows) =>
                        rows.map((row) =>
                          row.key === line.key
                            ? { ...row, petId: event.target.value }
                            : row,
                        ),
                      )
                    }
                  >
                    <option value="">Elige…</option>
                    {clientPets.map((pet: Pet) => (
                      <option key={pet.id} value={pet.id}>
                        {pet.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Precio cobrado (COP)">
                  <Input
                    value={line.price}
                    onChange={(event) =>
                      setServices((rows) =>
                        rows.map((row) =>
                          row.key === line.key
                            ? { ...row, price: event.target.value }
                            : row,
                        ),
                      )
                    }
                    placeholder="55.000"
                    inputMode="numeric"
                  />
                </Field>
                <div className="span-2">
                  <Field label="Observaciones (opcional)">
                    <Input
                      value={line.notes}
                      onChange={(event) =>
                        setServices((rows) =>
                          rows.map((row) =>
                            row.key === line.key
                              ? { ...row, notes: event.target.value }
                              : row,
                          ),
                        )
                      }
                      placeholder="Se portó bien, sin secadora…"
                    />
                  </Field>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Artículos</h2>
          <Button
            icon="plus"
            onClick={() =>
              setItems((rows) => [
                ...rows,
                { key: newIdempotencyKey(), productId: '', qty: '1', price: '' },
              ])
            }
          >
            Añadir artículo
          </Button>
        </div>
        <div className="card-pad col" style={{ gap: 12 }}>
          {items.length === 0 ? (
            <p className="muted small">Sin artículos. Añade uno del catálogo.</p>
          ) : null}
          {items.map((line) => (
            <div className="sale-line" key={line.key}>
              <div className="sale-line-head">
                <strong>Artículo</strong>
                <Button
                  variant="subtle"
                  icon="trash"
                  className="btn-sm btn-icon"
                  aria-label="Quitar artículo"
                  onClick={() =>
                    setItems((rows) => rows.filter((row) => row.key !== line.key))
                  }
                />
              </div>
              <div className="form-grid">
                <div className="span-2">
                  <Field label="Producto">
                    <Select
                      value={line.productId}
                      onChange={(event) => {
                        const product = productList.find(
                          (row: Product) => row.id === event.target.value,
                        );
                        setItems((rows) =>
                          rows.map((row) =>
                            row.key === line.key
                              ? {
                                  ...row,
                                  productId: event.target.value,
                                  price: product ? centsToInput(product.priceCents) : row.price,
                                }
                              : row,
                          ),
                        );
                      }}
                    >
                      <option value="">Elige un artículo…</option>
                      {productList.map((product: Product) => (
                        <option key={product.id} value={product.id}>
                          {product.name} · {product.stock} en stock
                        </option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Cantidad">
                  <Input
                    type="number"
                    min={1}
                    value={line.qty}
                    onChange={(event) =>
                      setItems((rows) =>
                        rows.map((row) =>
                          row.key === line.key
                            ? { ...row, qty: event.target.value }
                            : row,
                        ),
                      )
                    }
                    inputMode="numeric"
                  />
                </Field>
                <Field label="Precio aplicado (COP)">
                  <Input
                    value={line.price}
                    onChange={(event) =>
                      setItems((rows) =>
                        rows.map((row) =>
                          row.key === line.key
                            ? { ...row, price: event.target.value }
                            : row,
                        ),
                      )
                    }
                    inputMode="numeric"
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="card card-pad">
        <div className="form-grid">
          <Field label="Descuento (COP)">
            <Input
              value={discount}
              onChange={(event) => setDiscount(event.target.value)}
              placeholder="0"
              inputMode="numeric"
            />
          </Field>
          <Field label="Notas de la venta">
            <Input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="Opcional"
            />
          </Field>
        </div>
      </section>

      <section className="card card-pad" hidden={editing}>
        <h2 className="section-title" style={{ marginBottom: 10 }}>
          Pago
        </h2>
        <div className="segmented" role="group" aria-label="Forma de pago">
          <button
            type="button"
            aria-pressed={paymentMode === 'full'}
            onClick={() => setPaymentMode('full')}
          >
            Pagada
          </button>
          <button
            type="button"
            aria-pressed={paymentMode === 'partial'}
            onClick={() => setPaymentMode('partial')}
          >
            Abono
          </button>
          <button
            type="button"
            aria-pressed={paymentMode === 'pending'}
            onClick={() => setPaymentMode('pending')}
          >
            Pendiente
          </button>
        </div>

        {paymentMode !== 'pending' ? (
          <div className="form-grid" style={{ marginTop: 12 }}>
            <Field label="Medio de pago">
              <Select value={method} onChange={(event) => setMethod(event.target.value)}>
                {Object.entries(PAYMENT_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Monto recibido (COP)"
              hint={paymentMode === 'full' ? 'Igual al total' : 'Puede ser menor al total'}
            >
              <Input
                value={
                  paymentMode === 'full' ? centsToInput(totalCents) : partialAmount
                }
                disabled={paymentMode === 'full'}
                onChange={(event) => setPartialAmount(event.target.value)}
                inputMode="numeric"
              />
            </Field>
          </div>
        ) : (
          <p className="muted small" style={{ marginTop: 10 }}>
            La venta quedará pendiente y podrás registrar el pago después.
          </p>
        )}
      </section>

      <div className="sale-total">
        <div>
          <span className="muted small">Subtotal {formatCop(subtotalCents)}</span>
          {discountCents > 0 ? (
            <span className="muted small"> · Descuento {formatCop(discountCents)}</span>
          ) : null}
          <strong className="sale-total-value">{formatCop(totalCents)}</strong>
          {!canSave && validationHint ? (
            <span className="muted small">{validationHint}</span>
          ) : null}
        </div>
        <Button variant="primary" onClick={save} loading={busy} disabled={!canSave}>
          {editing ? 'Guardar cambios' : 'Guardar venta'}
        </Button>
      </div>

      <PetEditor
        open={petEditorOpen}
        pet={null}
        clients={clients.data?.data ?? []}
        onClose={() => setPetEditorOpen(false)}
        onSaved={(pet) => {
          setPetEditorOpen(false);
          pets.reload();
          clients.reload();
          setClientId(String(pet.clientId));
          setServices((rows) =>
            rows.length === 0
              ? rows
              : rows.map((row, index) =>
                  index === 0 ? { ...row, petId: pet.id } : row,
                ),
          );
          toast('Mascota creada y seleccionada.');
        }}
      />
    </div>
  );
}
