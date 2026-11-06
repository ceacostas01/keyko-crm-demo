import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeHarness, request, type Harness } from './helpers';

/**
 * Egresos: categorías de servicios, detalle libre, fecha local, aislamiento
 * por negocio, idempotencia y suma en el resumen de ventas.
 */

let h: Harness;
let luzId: string;

const key = () => crypto.randomUUID();

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(() => h.close());

describe('egresos', () => {
  it('registra un egreso con categoría, detalle, monto y fecha', async () => {
    const res = await request(h, {
      method: 'POST',
      path: '/expenses',
      token: h.tokens.a,
      payload: {
        category: 'luz',
        reason: 'Recibo de luz de octubre',
        amountCents: 15_000_000,
        incurredAt: '2026-11-02',
        vendor: 'Enel',
      },
      headers: { 'idempotency-key': key() },
    });

    expect(res.status).toBe(201);
    expect(res.body.data.category).toBe('luz');
    expect(res.body.data.reason).toBe('Recibo de luz de octubre');
    expect(res.body.data.amountCents).toBe(15_000_000);
    expect(res.body.data.incurredAt).toBe('2026-11-02');
    expect(res.body.data.vendor).toBe('Enel');
    luzId = res.body.data.id;
  });

  it('no duplica el egreso al reintentar con la misma clave', async () => {
    const idem = key();
    const payload = {
      category: 'agua',
      reason: 'Acueducto de noviembre',
      amountCents: 8_500_000,
      incurredAt: '2026-11-03',
    };

    const first = await request(h, {
      method: 'POST',
      path: '/expenses',
      token: h.tokens.a,
      payload,
      headers: { 'idempotency-key': idem },
    });
    const second = await request(h, {
      method: 'POST',
      path: '/expenses',
      token: h.tokens.a,
      payload,
      headers: { 'idempotency-key': idem },
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('lista por rango de fechas y por categoría', async () => {
    const onlyDay = await call(
      h,
      h.tokens.a,
      'GET',
      '/expenses?from=2026-11-02&to=2026-11-02',
    );
    expect(onlyDay.status).toBe(200);
    expect(onlyDay.body.data).toHaveLength(1);
    expect(onlyDay.body.data[0].category).toBe('luz');

    const onlyGas = await call(h, h.tokens.a, 'GET', '/expenses?category=gas');
    expect(onlyGas.status).toBe(200);
    expect(onlyGas.body.data).toHaveLength(0);

    const all = await call(h, h.tokens.a, 'GET', '/expenses');
    expect(all.status).toBe(200);
    expect(all.body.data.length).toBeGreaterThanOrEqual(2);
    expect(all.body.data[0].incurredAt >= all.body.data[1].incurredAt).toBe(
      true,
    );
  });

  it('suma los egresos del periodo en el resumen de ventas', async () => {
    await request(h, {
      method: 'POST',
      path: '/expenses',
      token: h.tokens.a,
      payload: {
        category: 'personal',
        reason: 'Turno de Laura',
        amountCents: 7_000_000,
        incurredAt: '2026-11-04',
      },
      headers: { 'idempotency-key': key() },
    });

    const summary = await call(
      h,
      h.tokens.a,
      'GET',
      '/sales/summary?from=2026-11-01&to=2026-11-05',
    );

    expect(summary.status).toBe(200);
    expect(summary.body.data.expensesCents).toBeGreaterThanOrEqual(30_500_000);
    expect(summary.body.data.expenseCount).toBeGreaterThanOrEqual(3);
  });

  it('edita un egreso y registra auditoría', async () => {
    const res = await request(h, {
      method: 'PATCH',
      path: `/expenses/${luzId}`,
      token: h.tokens.a,
      payload: { amountCents: 16_000_000, reason: 'Luz de octubre ajustada' },
      headers: { 'idempotency-key': key() },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.amountCents).toBe(16_000_000);
    expect(res.body.data.reason).toBe('Luz de octubre ajustada');

    const audit = await call(
      h,
      h.tokens.a,
      'GET',
      '/audit?action=expense.create&limit=100',
    );
    expect(
      audit.body.data.some(
        (entry: { entityId: string }) => entry.entityId === luzId,
      ),
    ).toBe(true);
  });

  it('elimina lógicamente y deja de sumar', async () => {
    const removed = await call(
      h,
      h.tokens.a,
      'DELETE',
      `/expenses/${luzId}`,
    );
    expect(removed.status).toBe(200);

    const list = await call(h, h.tokens.a, 'GET', '/expenses');
    expect(
      list.body.data.some((row: { id: string }) => row.id === luzId),
    ).toBe(false);

    const again = await call(h, h.tokens.a, 'DELETE', `/expenses/${luzId}`);
    expect(again.status).toBe(404);

    const summary = await call(
      h,
      h.tokens.a,
      'GET',
      '/sales/summary?from=2026-11-02&to=2026-11-02',
    );
    expect(summary.body.data.expensesCents).toBe(0);
  });

  it('valida categoría, detalle y monto', async () => {
    const badCategory = await request(h, {
      method: 'POST',
      path: '/expenses',
      token: h.tokens.a,
      payload: {
        category: 'internet',
        reason: 'Plan de datos',
        amountCents: 1_000_000,
        incurredAt: '2026-11-02',
      },
      headers: { 'idempotency-key': key() },
    });
    expect(badCategory.status).toBe(422);

    const noReason = await request(h, {
      method: 'POST',
      path: '/expenses',
      token: h.tokens.a,
      payload: {
        category: 'gas',
        reason: '',
        amountCents: 1_000_000,
        incurredAt: '2026-11-02',
      },
      headers: { 'idempotency-key': key() },
    });
    expect(noReason.status).toBe(422);

    const zero = await request(h, {
      method: 'POST',
      path: '/expenses',
      token: h.tokens.a,
      payload: {
        category: 'gas',
        reason: 'Gas',
        amountCents: 0,
        incurredAt: '2026-11-02',
      },
      headers: { 'idempotency-key': key() },
    });
    expect(zero.status).toBe(422);
  });

  it('aísla los egresos entre negocios', async () => {
    const list = await call(h, h.tokens.b, 'GET', '/expenses');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);

    const patch = await request(h, {
      method: 'PATCH',
      path: `/expenses/${luzId}`,
      token: h.tokens.b,
      payload: { amountCents: 1 },
      headers: { 'idempotency-key': key() },
    });
    expect(patch.status).toBe(404);
  });
});
