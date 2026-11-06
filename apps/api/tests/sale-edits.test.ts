import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createClientRow,
  makeHarness,
  request,
  type ApiResponse,
  type Harness,
} from './helpers';

/**
 * Corrección de ventas, devolución de productos y reembolsos.
 *
 * Regla central: editar mueve solo la DIFERENCIA de inventario, anular no
 * devuelve nada por sí sola, y el dinero devuelto se registra siempre como un
 * movimiento explícito.
 */

let h: Harness;
let anaId: number;
let lunaId: string;
let firulaisId: string;
let productA: string;
let productB: string;

const A_PRICE = 2_000_000; // $20.000
const B_PRICE = 1_500_000;

async function newProduct(sku: string, stock: number): Promise<string> {
  const res = await call(h, h.tokens.a, 'POST', '/products', {
    sku,
    name: `Producto ${sku}`,
    priceCents: sku.startsWith('B') ? B_PRICE : A_PRICE,
    stock,
  });
  return res.body.data.id;
}

async function stockOf(productId: string): Promise<number> {
  const rs = await h.client.execute({
    sql: 'SELECT stock FROM products WHERE id = ?',
    args: [productId],
  });
  return Number(rs.rows[0]?.stock);
}

function createSale(
  body: Record<string, unknown>,
  key?: string,
): Promise<ApiResponse> {
  return request(h, {
    method: 'POST',
    path: '/sales',
    token: h.tokens.a,
    payload: body,
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });
}

function patchSale(id: string, body: Record<string, unknown>): Promise<ApiResponse> {
  return request(h, {
    method: 'PATCH',
    path: `/sales/${id}`,
    token: h.tokens.a,
    payload: body,
  });
}

function refund(id: string, body: Record<string, unknown>): Promise<ApiResponse> {
  return request(h, {
    method: 'POST',
    path: `/sales/${id}/refunds`,
    token: h.tokens.a,
    payload: body,
  });
}

function returnProducts(
  id: string,
  body: Record<string, unknown> = {},
): Promise<ApiResponse> {
  return request(h, {
    method: 'POST',
    path: `/sales/${id}/returns`,
    token: h.tokens.a,
    payload: body,
  });
}

async function getSale(id: string): Promise<ApiResponse> {
  return call(h, h.tokens.a, 'GET', `/sales/${id}`);
}

beforeAll(async () => {
  h = await makeHarness();
  anaId = await createClientRow(h, h.tokens.a, '+573103000001', 'Ana Pérez');

  const luna = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId: anaId,
    name: 'Luna',
    species: 'gato',
  });
  lunaId = luna.body.data.id;

  const firulais = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId: anaId,
    name: 'Firulais',
    species: 'perro',
  });
  firulaisId = firulais.body.data.id;

  productA = await newProduct('A-01', 50);
  productB = await newProduct('B-01', 50);
});

afterAll(() => h.close());

describe('corregir una venta', () => {
  it('recalcula totales y solo mueve la diferencia de inventario', async () => {
    const before = await stockOf(productA);

    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 5_000_000,
        },
        { type: 'product', productId: productA, qty: 2 },
      ],
    });
    expect(created.status).toBe(201);
    expect(await stockOf(productA)).toBe(before - 2);

    const sale = await getSale(created.body.data.id);
    const productLine = sale.body.data.items.find(
      (item: { itemType: string }) => item.itemType === 'product',
    );
    const serviceLine = sale.body.data.items.find(
      (item: { itemType: string }) => item.itemType === 'service',
    );

    const updated = await patchSale(created.body.data.id, {
      clientId: anaId,
      discountCents: 0,
      notes: 'Precio corregido',
      items: [
        {
          id: serviceLine.id,
          type: 'service',
          name: 'Baño medicado',
          petId: lunaId,
          unitPriceCents: 6_000_000,
          discountCents: 0,
        },
        {
          id: productLine.id,
          type: 'product',
          productId: productA,
          qty: 3,
          unitPriceCents: A_PRICE,
          discountCents: 0,
        },
      ],
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.subtotalCents).toBe(6_000_000 + A_PRICE * 3);
    expect(updated.body.data.totalCents).toBe(6_000_000 + A_PRICE * 3);
    expect(updated.body.data.items[0].name).toBe('Baño medicado');
    // Solo entró una unidad más.
    expect(await stockOf(productA)).toBe(before - 3);
  });

  it('devolver unidades al bajar la cantidad', async () => {
    const before = await stockOf(productA);

    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productA, qty: 4 }],
    });
    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];

    const updated = await patchSale(created.body.data.id, {
      items: [
        {
          id: line.id,
          type: 'product',
          productId: productA,
          qty: 1,
          unitPriceCents: A_PRICE,
          discountCents: 0,
        },
      ],
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.totalCents).toBe(A_PRICE);
    expect(await stockOf(productA)).toBe(before - 1);
  });

  it('cambiar la mascota de una línea', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 3_000_000,
        },
      ],
    });
    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];

    const updated = await patchSale(created.body.data.id, {
      items: [
        {
          id: line.id,
          type: 'service',
          name: 'Baño',
          petId: firulaisId,
          unitPriceCents: 3_000_000,
          discountCents: 0,
        },
      ],
    });

    expect(updated.body.data.items[0].petId).toBe(firulaisId);
    expect(updated.body.data.items[0].petName).toBe('Firulais');
  });

  it('quitar una línea de producto devuelve lo que quedaba', async () => {
    const before = await stockOf(productB);

    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 2_000_000,
        },
        { type: 'product', productId: productB, qty: 3 },
      ],
    });
    expect(await stockOf(productB)).toBe(before - 3);

    const sale = await getSale(created.body.data.id);
    const service = sale.body.data.items.find(
      (item: { itemType: string }) => item.itemType === 'service',
    );

    const updated = await patchSale(created.body.data.id, {
      items: [
        {
          id: service.id,
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 2_000_000,
          discountCents: 0,
        },
      ],
    });

    expect(updated.status).toBe(200);
    expect(updated.body.data.items).toHaveLength(1);
    expect(await stockOf(productB)).toBe(before);
  });

  it('no deja el stock negativo al subir cantidades', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productB, qty: 1 }],
    });
    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];
    const before = await stockOf(productB);

    const updated = await patchSale(created.body.data.id, {
      items: [
        {
          id: line.id,
          type: 'product',
          productId: productB,
          qty: 999,
          unitPriceCents: B_PRICE,
          discountCents: 0,
        },
      ],
    });

    expect(updated.status).toBe(409);
    expect(updated.body.error.code).toBe('insufficient_stock');
    expect(await stockOf(productB)).toBe(before);
  });

  it('no permite editar una venta anulada', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 1_000_000,
        },
      ],
    });

    await request(h, {
      method: 'POST',
      path: `/sales/${created.body.data.id}/void`,
      token: h.tokens.a,
    });

    const updated = await patchSale(created.body.data.id, {
      items: [
        {
          type: 'service',
          name: 'Otro',
          petId: lunaId,
          unitPriceCents: 2_000_000,
          discountCents: 0,
        },
      ],
    });

    expect(updated.status).toBe(409);
  });
});

describe('dinero: pagos, saldos y reembolsos', () => {
  it('una venta pagada que sube de precio queda pendiente', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 5_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 5_000_000 }],
    });
    expect(created.body.data.status).toBe('paid');

    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];

    const updated = await patchSale(created.body.data.id, {
      items: [
        {
          id: line.id,
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 7_000_000,
          discountCents: 0,
        },
      ],
    });

    expect(updated.body.data.totalCents).toBe(7_000_000);
    expect(updated.body.data.paidCents).toBe(5_000_000);
    expect(updated.body.data.pendingCents).toBe(2_000_000);
    expect(updated.body.data.status).toBe('open');
  });

  it('si baja de precio, deja saldo a favor y permite devolverlo', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 8_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 8_000_000 }],
    });

    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];

    const updated = await patchSale(created.body.data.id, {
      items: [
        {
          id: line.id,
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 6_000_000,
          discountCents: 0,
        },
      ],
    });

    expect(updated.body.data.totalCents).toBe(6_000_000);
    // El dinero recibido no se toca solo.
    expect(updated.body.data.paidCents).toBe(8_000_000);
    expect(updated.body.data.netPaidCents).toBe(8_000_000);
    expect(updated.body.data.overpaidCents).toBe(2_000_000);
    expect(updated.body.data.pendingCents).toBe(0);
    expect(updated.body.data.status).toBe('paid');

    const refunded = await refund(created.body.data.id, {
      method: 'cash',
      amountCents: 2_000_000,
      notes: 'Ajuste de precio',
    });

    expect(refunded.status).toBe(201);
    expect(refunded.body.data.paidCents).toBe(8_000_000);
    expect(refunded.body.data.refundedCents).toBe(2_000_000);
    expect(refunded.body.data.netPaidCents).toBe(6_000_000);
    expect(refunded.body.data.overpaidCents).toBe(0);
    expect(refunded.body.data.payments.at(-1).kind).toBe('refund');
  });

  it('no se puede devolver más de lo recibido', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 4_000_000,
        },
      ],
      payments: [{ method: 'nequi', amountCents: 4_000_000 }],
    });

    const tooMuch = await refund(created.body.data.id, {
      method: 'nequi',
      amountCents: 5_000_000,
    });
    expect(tooMuch.status).toBe(422);

    const partial = await refund(created.body.data.id, {
      method: 'nequi',
      amountCents: 1_000_000,
    });
    expect(partial.status).toBe(201);
    expect(partial.body.data.netPaidCents).toBe(3_000_000);
    expect(partial.body.data.pendingCents).toBe(1_000_000);
    expect(partial.body.data.status).toBe('open');
  });
});

describe('devolución de productos', () => {
  it('devuelve stock y no deja repetir la misma unidad', async () => {
    const before = await stockOf(productA);

    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productA, qty: 3 }],
    });
    expect(await stockOf(productA)).toBe(before - 3);

    const returned = await returnProducts(created.body.data.id, {
      reason: 'Cambio de producto',
    });
    expect(returned.status).toBe(201);
    expect(await stockOf(productA)).toBe(before);
    expect(returned.body.data.items[0].returnedQty).toBe(3);

    const again = await returnProducts(created.body.data.id, {});
    expect(again.status).toBe(422);
    expect(await stockOf(productA)).toBe(before);
  });

  it('permite devolver solo una parte', async () => {
    const before = await stockOf(productA);

    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productA, qty: 4 }],
    });
    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];

    const returned = await returnProducts(created.body.data.id, {
      items: [{ saleItemId: line.id, qty: 2 }],
    });

    expect(returned.status).toBe(201);
    expect(await stockOf(productA)).toBe(before - 2);
    expect(returned.body.data.items[0].returnedQty).toBe(2);
  });

  it('rechaza devolver más unidades de las vendidas', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productA, qty: 1 }],
    });
    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];

    const res = await returnProducts(created.body.data.id, {
      items: [{ saleItemId: line.id, qty: 5 }],
    });

    expect(res.status).toBe(422);
  });

  it('una venta solo de servicios no tiene nada que devolver', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 1_000_000,
        },
      ],
    });

    const res = await returnProducts(created.body.data.id);
    expect(res.status).toBe(422);
  });
});

describe('anulación', () => {
  it('anular no devuelve stock ni dinero por sí sola', async () => {
    const before = await stockOf(productA);

    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productA, qty: 2 }],
      payments: [{ method: 'cash', amountCents: A_PRICE * 2 }],
    });
    expect(await stockOf(productA)).toBe(before - 2);

    const voided = await request(h, {
      method: 'POST',
      path: `/sales/${created.body.data.id}/void`,
      token: h.tokens.a,
      payload: {},
    });

    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('void');
    // Sin devolución explícita, el artículo sigue fuera del inventario.
    expect(await stockOf(productA)).toBe(before - 2);
    expect(voided.body.data.refundedCents).toBe(0);
    // El pago queda registrado, pero la venta no cuenta en ingresos.
    expect(voided.body.data.paidCents).toBe(A_PRICE * 2);
  });

  it('anular con devolución de producto y de dinero en un solo paso', async () => {
    const before = await stockOf(productA);

    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productA, qty: 2 }],
      payments: [{ method: 'card', amountCents: A_PRICE * 2 }],
    });

    const voided = await request(h, {
      method: 'POST',
      path: `/sales/${created.body.data.id}/void`,
      token: h.tokens.a,
      payload: {
        returnProducts: true,
        refund: { method: 'card', amountCents: A_PRICE * 2 },
        notes: 'Cliente devolvió todo',
      },
    });

    expect(voided.status).toBe(200);
    expect(await stockOf(productA)).toBe(before);
    expect(voided.body.data.refundedCents).toBe(A_PRICE * 2);
    expect(voided.body.data.netPaidCents).toBe(0);

    // Repetir la anulación no vuelve a sumar stock ni a devolver dinero.
    const again = await request(h, {
      method: 'POST',
      path: `/sales/${created.body.data.id}/void`,
      token: h.tokens.a,
      payload: {
        returnProducts: true,
        refund: { method: 'card', amountCents: A_PRICE * 2 },
      },
    });

    expect(again.status).toBe(200);
    expect(await stockOf(productA)).toBe(before);
    expect(again.body.data.refundedCents).toBe(A_PRICE * 2);
  });
});

describe('historial y reportes', () => {
  it('la venta expone su historial de cambios', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 3_000_000,
        },
      ],
    });
    const sale = await getSale(created.body.data.id);
    const line = sale.body.data.items[0];

    await patchSale(created.body.data.id, {
      items: [
        {
          id: line.id,
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 4_000_000,
          discountCents: 0,
        },
      ],
    });

    const updated = await getSale(created.body.data.id);
    const entry = updated.body.data.history.find(
      (item: { action: string }) => item.action === 'sale.update',
    );

    expect(entry).toBeDefined();
    expect(entry.diff.totalCents).toEqual({ from: 3_000_000, to: 4_000_000 });
    expect(entry.actorName).toBe('Dueño Alfa');
  });

  it('el resumen filtra por fechas y separa servicios, artículos y reembolsos', async () => {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Bogota',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());

    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño resumen',
          petId: lunaId,
          unitPriceCents: 5_000_000,
        },
        { type: 'product', productId: productB, qty: 2 },
      ],
      payments: [{ method: 'cash', amountCents: 5_000_000 + B_PRICE * 2 }],
    });

    await refund(created.body.data.id, {
      method: 'cash',
      amountCents: 1_000_000,
    });

    const summary = await call(
      h,
      h.tokens.a,
      'GET',
      `/sales/summary?from=${today}&to=${today}`,
    );

    expect(summary.status).toBe(200);
    const data = summary.body.data;
    expect(data.salesCount).toBeGreaterThan(0);
    expect(data.servicesCount).toBeGreaterThan(0);
    expect(data.productsCount).toBeGreaterThan(0);
    expect(data.refundedCents).toBeGreaterThanOrEqual(1_000_000);
    expect(data.netCollectedCents).toBe(data.collectedCents - data.refundedCents);
    expect(data.servicesCents).toBeGreaterThan(0);
    expect(data.productsCents).toBeGreaterThan(0);

    const past = await call(
      h,
      h.tokens.a,
      'GET',
      '/sales/summary?from=2020-01-01&to=2020-01-02',
    );
    expect(past.body.data.salesCount).toBe(0);
    expect(past.body.data.soldCents).toBe(0);
    expect(past.body.data.refundedCents).toBe(0);
  });
});

describe('aislamiento entre negocios', () => {
  it('otro negocio no puede editar, devolver ni reembolsar', async () => {
    const created = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: productA, qty: 1 }],
      payments: [{ method: 'cash', amountCents: A_PRICE }],
    });
    const id = created.body.data.id;

    const edit = await request(h, {
      method: 'PATCH',
      path: `/sales/${id}`,
      token: h.tokens.b,
      payload: {
        items: [
          {
            type: 'service',
            name: 'Intruso',
            petId: lunaId,
            unitPriceCents: 1_000_000,
            discountCents: 0,
          },
        ],
      },
    });
    expect(edit.status).toBe(404);

    const ret = await request(h, {
      method: 'POST',
      path: `/sales/${id}/returns`,
      token: h.tokens.b,
      payload: {},
    });
    expect(ret.status).toBe(404);

    const ref = await request(h, {
      method: 'POST',
      path: `/sales/${id}/refunds`,
      token: h.tokens.b,
      payload: { method: 'cash', amountCents: 1_000_000 },
    });
    expect(ref.status).toBe(404);

    const voided = await request(h, {
      method: 'POST',
      path: `/sales/${id}/void`,
      token: h.tokens.b,
      payload: {},
    });
    expect(voided.status).toBe(404);
  });
});
