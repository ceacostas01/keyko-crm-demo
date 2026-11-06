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
 * Ventas: servicios de precio libre, artículos del catálogo, varias mascotas,
 * pagos parciales, anulación con devolución de stock e historial por mascota.
 */

let h: Harness;
let anaId: number;
let brunoId: number;
let lunaId: string;
let firulaisId: string;
let brunoPetId: string;
let shampooId: string;
let cepilloId: string;

const SHAMPOO_PRICE = 3_200_000; // $32.000
const SHAMPOO_COST = 1_800_000;
const CEPILLO_PRICE = 1_500_000;

async function newPet(
  clientId: number,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name,
    ...extra,
  });
  if (res.status !== 201) {
    throw new Error(`No se pudo crear ${name}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.id;
}

function createSale(
  body: Record<string, unknown>,
  key?: string,
  token = h.tokens.a,
): Promise<ApiResponse> {
  return request(h, {
    method: 'POST',
    path: '/sales',
    token,
    payload: body,
    ...(key ? { headers: { 'idempotency-key': key } } : {}),
  });
}

async function stock(productId: string): Promise<number> {
  const rs = await h.client.execute({
    sql: 'SELECT stock FROM products WHERE id = ?',
    args: [productId],
  });
  return Number(rs.rows[0]?.stock);
}

beforeAll(async () => {
  h = await makeHarness();

  anaId = await createClientRow(h, h.tokens.a, '+573101000001', 'Ana Pérez');
  brunoId = await createClientRow(h, h.tokens.a, '+573101000002', 'Bruno Díaz');

  lunaId = await newPet(anaId, 'Luna', {
    species: 'gato',
    breed: 'Siamés',
    sex: 'hembra',
    weightKg: 4.2,
    allergies: 'Pollo',
  });
  firulaisId = await newPet(anaId, 'Firulais', {
    species: 'perro',
    breed: 'Poodle',
    weightKg: 7.5,
  });
  brunoPetId = await newPet(brunoId, 'Toby', {
    species: 'perro',
    breed: 'Beagle',
    weightKg: 30,
  });

  const shampoo = await call(h, h.tokens.a, 'POST', '/products', {
    sku: 'SH-01',
    name: 'Shampoo hipoalergénico',
    priceCents: SHAMPOO_PRICE,
    costCents: SHAMPOO_COST,
    stock: 10,
    minStock: 2,
  });
  shampooId = shampoo.body.data.id;

  const cepillo = await call(h, h.tokens.a, 'POST', '/products', {
    sku: 'CP-02',
    name: 'Cepillo doble',
    priceCents: CEPILLO_PRICE,
    stock: 1,
    minStock: 1,
  });
  cepilloId = cepillo.body.data.id;
});

afterAll(() => h.close());

describe('ventas: servicios con precio libre', () => {
  it('registra un servicio escrito a mano con su precio y pago', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño y peluquería',
          petId: lunaId,
          unitPriceCents: 5_500_000,
          notes: 'Se portó bien',
        },
        {
          type: 'service',
          name: 'Corte de uñas',
          petId: lunaId,
          unitPriceCents: 1_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 6_500_000 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.totalCents).toBe(6_500_000);
    expect(res.body.data.subtotalCents).toBe(6_500_000);
    expect(res.body.data.status).toBe('paid');
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.items[0].name).toBe('Baño y peluquería');
    expect(res.body.data.items[0].itemId).toBeNull();
    expect(res.body.data.items[0].petName).toBe('Luna');
    expect(res.body.data.payments[0].method).toBe('cash');
    expect(res.body.data.paidCents).toBe(6_500_000);
    expect(res.body.data.pendingCents).toBe(0);
  });

  it('el mismo servicio puede costar distinto en otra atención', async () => {
    const first = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 4_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 4_000_000 }],
    });

    const second = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: firulaisId,
          unitPriceCents: 6_000_000,
        },
      ],
      payments: [{ method: 'nequi', amountCents: 6_000_000 }],
    });

    expect(first.body.data.items[0].unitPriceCents).toBe(4_000_000);
    expect(second.body.data.items[0].unitPriceCents).toBe(6_000_000);
  });

  it('exige nombre y precio en un servicio', async () => {
    const noPrice = await createSale({
      clientId: anaId,
      items: [{ type: 'service', name: 'Baño', petId: lunaId }],
    });
    expect(noPrice.status).toBe(422);

    const noName = await createSale({
      clientId: anaId,
      items: [
        { type: 'service', name: 'X', petId: lunaId, unitPriceCents: 1_000_000 },
      ],
    });
    expect(noName.status).toBe(422);
  });
});

describe('ventas: artículos e inventario', () => {
  it('vende un artículo, descuenta stock y deja movimiento', async () => {
    const before = await stock(shampooId);

    const res = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: shampooId, qty: 2 }],
      payments: [{ method: 'card', amountCents: SHAMPOO_PRICE * 2 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.items[0].unitPriceCents).toBe(SHAMPOO_PRICE);
    expect(res.body.data.items[0].name).toBe('Shampoo hipoalergénico');
    expect(await stock(shampooId)).toBe(before - 2);

    const movements = await h.client.execute({
      sql: `SELECT delta, ref_type FROM stock_movements
             WHERE product_id = ? AND ref_id = ?`,
      args: [shampooId, res.body.data.id],
    });
    expect(movements.rows).toHaveLength(1);
    expect(Number(movements.rows[0]?.delta)).toBe(-2);
    expect(movements.rows[0]?.ref_type).toBe('sale');
  });

  it('permite cambiar el precio del artículo en esa venta sin tocar el catálogo', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'product',
          productId: shampooId,
          qty: 1,
          unitPriceCents: 2_500_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 2_500_000 }],
    });

    expect(res.body.data.items[0].unitPriceCents).toBe(2_500_000);

    const product = await call(h, h.tokens.a, 'GET', `/products/${shampooId}`);
    expect(product.body.data.priceCents).toBe(SHAMPOO_PRICE);
  });

  it('no vende más de lo que hay y no deja rastro a medias', async () => {
    const before = await stock(cepilloId);
    const salesBefore = await h.client.execute(
      'SELECT COUNT(*) AS n FROM sales',
    );

    const res = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: cepilloId, qty: 5 }],
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('insufficient_stock');
    expect(await stock(cepilloId)).toBe(before);

    const salesAfter = await h.client.execute(
      'SELECT COUNT(*) AS n FROM sales',
    );
    expect(Number(salesAfter.rows[0]?.n)).toBe(Number(salesBefore.rows[0]?.n));
  });

  it('vende artículos sin mascota', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: shampooId, qty: 1 }],
      payments: [{ method: 'cash', amountCents: SHAMPOO_PRICE }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.items[0].petId).toBeNull();
    expect(res.body.data.items[0].petName).toBeNull();
  });

  it('conserva el precio histórico aunque cambie el catálogo', async () => {
    const sale = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: shampooId, qty: 1 }],
      payments: [{ method: 'cash', amountCents: SHAMPOO_PRICE }],
    });

    await call(h, h.tokens.a, 'PATCH', `/products/${shampooId}`, {
      priceCents: 9_900_000,
    });

    const detail = await call(h, h.tokens.a, 'GET', `/sales/${sale.body.data.id}`);
    expect(detail.body.data.items[0].unitPriceCents).toBe(SHAMPOO_PRICE);

    const fresh = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId: shampooId, qty: 1 }],
    });
    expect(fresh.body.data.items[0].unitPriceCents).toBe(9_900_000);

    // Se devuelve al precio original para no afectar otras pruebas.
    await call(h, h.tokens.a, 'PATCH', `/products/${shampooId}`, {
      priceCents: SHAMPOO_PRICE,
    });
  });
});

describe('ventas: mixtas y varias mascotas', () => {
  it('mezcla servicios y artículos en una sola venta', async () => {
    const before = await stock(shampooId);

    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño medicado',
          petId: lunaId,
          unitPriceCents: 6_000_000,
        },
        { type: 'product', productId: shampooId, qty: 1 },
      ],
      payments: [{ method: 'transfer', amountCents: 6_000_000 + SHAMPOO_PRICE }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.subtotalCents).toBe(6_000_000 + SHAMPOO_PRICE);
    expect(res.body.data.items).toHaveLength(2);
    expect(await stock(shampooId)).toBe(before - 1);
  });

  it('cobra servicios de dos mascotas en la misma venta', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 4_000_000,
        },
        {
          type: 'service',
          name: 'Baño',
          petId: firulaisId,
          unitPriceCents: 7_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 11_000_000 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.totalCents).toBe(11_000_000);
    expect(res.body.data.items.map((item: { petName: string }) => item.petName)).toEqual([
      'Luna',
      'Firulais',
    ]);
  });

  it('rechaza mascotas de otro cliente', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: brunoPetId,
          unitPriceCents: 1_000_000,
        },
      ],
    });

    expect(res.status).toBe(422);
  });

  it('deriva el cliente cuando solo se envía la mascota', async () => {
    const res = await createSale({
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 3_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 3_000_000 }],
    });

    expect(res.status).toBe(201);
    expect(res.body.data.clientId).toBe(anaId);
    expect(res.body.data.client.name).toBe('Ana Pérez');
  });
});

describe('ventas: descuentos y pagos', () => {
  it('aplica descuento de línea y de venta', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 5_000_000,
          discountCents: 500_000,
        },
      ],
      discountCents: 300_000,
      payments: [{ method: 'cash', amountCents: 4_200_000 }],
    });

    expect(res.body.data.subtotalCents).toBe(4_500_000);
    expect(res.body.data.totalCents).toBe(4_200_000);
    expect(res.body.data.status).toBe('paid');
  });

  it('deja la venta pendiente si el pago es parcial y permite abonar', async () => {
    const sale = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 10_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 4_000_000 }],
    });

    expect(sale.body.data.status).not.toBe('paid');
    expect(sale.body.data.paidCents).toBe(4_000_000);
    expect(sale.body.data.pendingCents).toBe(6_000_000);

    const abono = await request(h, {
      method: 'POST',
      path: `/sales/${sale.body.data.id}/payments`,
      token: h.tokens.a,
      payload: { method: 'nequi', amountCents: 6_000_000 },
    });

    expect(abono.status).toBe(201);
    expect(abono.body.data.status).toBe('paid');
    expect(abono.body.data.paidCents).toBe(10_000_000);
    expect(abono.body.data.pendingCents).toBe(0);
  });

  it('no acepta pagos por encima del total', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 1_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 2_000_000 }],
    });

    expect(res.status).toBe(422);
  });

  it('no acepta descuento mayor al subtotal', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 1_000_000,
        },
      ],
      discountCents: 2_000_000,
    });

    expect(res.status).toBe(422);
  });

  it('separa lo vendido de lo cobrado en el resumen', async () => {
    const summary = await call(h, h.tokens.a, 'GET', '/sales/summary');
    expect(summary.status).toBe(200);
    expect(summary.body.data.soldCents).toBeGreaterThan(0);
    expect(summary.body.data.collectedCents).toBeGreaterThan(0);
    expect(summary.body.data.pendingCents).toBeGreaterThanOrEqual(0);
    expect(
      summary.body.data.collectedCents + summary.body.data.pendingCents,
    ).toBe(summary.body.data.soldCents);
  });
});

describe('ventas: idempotencia y anulación', () => {
  it('un reintento con la misma clave no duplica la venta ni el stock', async () => {
    const key = 'venta-doble-clic-0001';
    const body = {
      clientId: anaId,
      items: [{ type: 'product', productId: shampooId, qty: 3 }],
      payments: [{ method: 'cash', amountCents: SHAMPOO_PRICE * 3 }],
    };

    const before = await stock(shampooId);

    const first = await createSale(body, key);
    const second = await createSale(body, key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers.get('idempotency-replayed')).toBe('true');
    expect(await stock(shampooId)).toBe(before - 3);

    const movements = await h.client.execute({
      sql: 'SELECT COUNT(*) AS n FROM stock_movements WHERE ref_id = ?',
      args: [first.body.data.id],
    });
    expect(Number(movements.rows[0]?.n)).toBe(1);
  });

  it('anular devuelve el stock una sola vez y excluye la venta del resumen', async () => {
    // Producto propio: así la prueba no depende de lo que gastaron las demás.
    const product = await call(h, h.tokens.a, 'POST', '/products', {
      sku: 'VOID-01',
      name: 'Producto para anular',
      priceCents: 1_000_000,
      stock: 5,
    });
    const productId = product.body.data.id;

    const sale = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId, qty: 2 }],
      payments: [{ method: 'cash', amountCents: 2_000_000 }],
    });
    expect(sale.status).toBe(201);
    const saleId = sale.body.data.id;

    const afterSale = await stock(productId);

    const voided = await request(h, {
      method: 'POST',
      path: `/sales/${saleId}/void`,
      token: h.tokens.a,
      payload: { returnProducts: true },
    });
    expect(voided.status).toBe(200);
    expect(voided.body.data.status).toBe('void');
    expect(await stock(productId)).toBe(afterSale + 2);

    const again = await request(h, {
      method: 'POST',
      path: `/sales/${saleId}/void`,
      token: h.tokens.a,
      payload: { returnProducts: true },
    });
    expect(again.status).toBe(200);
    expect(await stock(productId)).toBe(afterSale + 2);

    const movements = await h.client.execute({
      sql: 'SELECT delta FROM stock_movements WHERE ref_id = ? ORDER BY created_at',
      args: [saleId],
    });
    expect(movements.rows.map((row) => Number(row.delta)).sort()).toEqual([-2, 2]);

    const summary = await call(h, h.tokens.a, 'GET', '/sales/summary');
    const sold = await h.client.execute({
      sql: "SELECT COALESCE(SUM(total_cents),0) AS n FROM sales WHERE business_id = 'biz-alfa' AND status <> 'void'",
    });
    expect(summary.body.data.soldCents).toBe(Number(sold.rows[0]?.n));
  });

  it('no se puede abonar a una venta anulada', async () => {
    const sale = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: lunaId,
          unitPriceCents: 2_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 1_000_000 }],
    });

    await request(h, {
      method: 'POST',
      path: `/sales/${sale.body.data.id}/void`,
      token: h.tokens.a,
    });

    const abono = await request(h, {
      method: 'POST',
      path: `/sales/${sale.body.data.id}/payments`,
      token: h.tokens.a,
      payload: { method: 'cash', amountCents: 1_000_000 },
    });

    expect(abono.status).toBe(409);
  });

  it('eliminar una venta devuelve el stock y borra pagos y líneas', async () => {
    const product = await call(h, h.tokens.a, 'POST', '/products', {
      sku: 'DEL-01',
      name: 'Producto para eliminar',
      priceCents: 1_000_000,
      stock: 4,
    });
    const productId = product.body.data.id;

    const sale = await createSale({
      clientId: anaId,
      items: [{ type: 'product', productId, qty: 3 }],
      payments: [{ method: 'cash', amountCents: 3_000_000 }],
    });
    expect(sale.status).toBe(201);
    const saleId = sale.body.data.id;
    expect(await stock(productId)).toBe(1);

    const removed = await request(h, {
      method: 'DELETE',
      path: `/sales/${saleId}`,
      token: h.tokens.a,
    });
    expect(removed.status).toBe(200);
    expect(removed.body.data).toMatchObject({ id: saleId, deleted: true });
    expect(await stock(productId)).toBe(4);

    const gone = await call(h, h.tokens.a, 'GET', `/sales/${saleId}`);
    expect(gone.status).toBe(404);

    for (const table of ['sale_items', 'payments', 'stock_movements']) {
      const column = table === 'stock_movements' ? 'ref_id' : 'sale_id';
      const rows = await h.client.execute({
        sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`,
        args: [saleId],
      });
      expect(Number(rows.rows[0]?.n)).toBe(0);
    }

    const audit = await h.client.execute({
      sql: "SELECT action FROM audit_log WHERE entity_id = ? AND action = 'sale.delete'",
      args: [saleId],
    });
    expect(audit.rows).toHaveLength(1);

    const again = await request(h, {
      method: 'DELETE',
      path: `/sales/${saleId}`,
      token: h.tokens.a,
    });
    expect(again.status).toBe(404);
  });
});

describe('ventas: cliente y/o mascota', () => {
  it('permite un servicio solo del cliente, sin mascota', async () => {
    const sale = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Solo baño',
          unitPriceCents: 1_500_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 1_500_000 }],
    });

    expect(sale.status).toBe(201);
    expect(sale.body.data.clientId).toBe(anaId);
    expect(sale.body.data.items[0]?.petId).toBeNull();
  });

  it('permite una venta solo de la mascota sin indicar cliente', async () => {
    const sale = await createSale({
      items: [
        {
          type: 'service',
          name: 'Solo peluquería',
          petId: lunaId,
          unitPriceCents: 2_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 2_000_000 }],
    });

    expect(sale.status).toBe(201);
    expect(sale.body.data.clientId).toBe(anaId);
    expect(sale.body.data.items[0]?.petId).toBe(lunaId);
  });

  it('permite una venta sin cliente y sin mascota', async () => {
    const sale = await createSale({
      items: [
        {
          type: 'service',
          name: 'Solo baño',
          unitPriceCents: 1_200_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 1_200_000 }],
    });

    expect(sale.status).toBe(201);
    expect(sale.body.data.clientId).toBeNull();
    expect(sale.body.data.items[0]?.petId).toBeNull();
  });

  it('guarda el día de la venta elegido', async () => {
    const sale = await createSale({
      clientId: anaId,
      soldOn: '2026-10-15',
      items: [
        {
          type: 'service',
          name: 'Guardería',
          unitPriceCents: 1_000_000,
        },
      ],
      payments: [{ method: 'cash', amountCents: 1_000_000 }],
    });

    expect(sale.status).toBe(201);
    expect(sale.body.data.createdAtLocal).toContain('2026-10-15');
  });
});

describe('ventas: aislamiento entre negocios', () => {
  it('no deja vender con una mascota de otro negocio', async () => {
    const res = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño',
          petId: brunoPetId,
          unitPriceCents: 1_000_000,
        },
      ],
    });
    expect(res.status).toBe(422);
  });

  it('no expone ventas de otro negocio', async () => {
    const list = await call(h, h.tokens.b, 'GET', '/sales');
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);

    const mine = await call(h, h.tokens.a, 'GET', '/sales?limit=1');
    const id = mine.body.data[0].id;

    const cross = await call(h, h.tokens.b, 'GET', `/sales/${id}`);
    expect(cross.status).toBe(404);
  });
});

describe('historial de la mascota', () => {
  it('reúne servicios, artículos y citas con el total gastado', async () => {
    const product = await call(h, h.tokens.a, 'POST', '/products', {
      sku: 'HIST-01',
      name: 'Producto historial',
      priceCents: 2_000_000,
      stock: 5,
    });

    const created = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño premium',
          petId: lunaId,
          unitPriceCents: 8_000_000,
          notes: 'Con perfume',
        },
        { type: 'product', productId: product.body.data.id, qty: 1, petId: lunaId },
      ],
      payments: [{ method: 'cash', amountCents: 10_000_000 }],
    });
    expect(created.status).toBe(201);

    await call(h, h.tokens.a, 'POST', '/appointments', {
      petId: lunaId,
      startsAt: '2026-12-01T09:00',
      durationMin: 60,
    });

    const history = await call(h, h.tokens.a, 'GET', `/pets/${lunaId}/history`);

    expect(history.status).toBe(200);
    expect(history.body.data.pet.name).toBe('Luna');
    expect(history.body.data.client.name).toBe('Ana Pérez');
    expect(history.body.data.stats.totalSpentCents).toBeGreaterThan(0);
    expect(history.body.data.stats.lastServiceName).toBe('Baño premium');
    expect(history.body.data.stats.servicesCount).toBeGreaterThan(0);
    expect(history.body.data.stats.productsCount).toBeGreaterThan(0);

    const services = history.body.data.timeline.filter(
      (entry: { type: string }) => entry.type === 'service',
    );
    expect(services[0].title).toBe('Baño premium');
    expect(services[0].amountCents).toBe(8_000_000);
    expect(services[0].detail).toBe('Con perfume');

    expect(
      history.body.data.timeline.some(
        (entry: { type: string }) => entry.type === 'appointment',
      ),
    ).toBe(true);

    // Orden cronológico descendente.
    const dates = history.body.data.timeline.map((entry: { at: string }) =>
      Date.parse(entry.at),
    );
    const sorted = [...dates].sort((a, b) => b - a);
    expect(dates).toEqual(sorted);
  });

  it('reparte el descuento de la venta entre las mascotas', async () => {
    const sale = await createSale({
      clientId: anaId,
      items: [
        {
          type: 'service',
          name: 'Baño Luna',
          petId: lunaId,
          unitPriceCents: 6_000_000,
        },
        {
          type: 'service',
          name: 'Baño Firulais',
          petId: firulaisId,
          unitPriceCents: 4_000_000,
        },
      ],
      discountCents: 1_000_000,
      payments: [{ method: 'cash', amountCents: 9_000_000 }],
    });
    expect(sale.status).toBe(201);

    const luna = await call(h, h.tokens.a, 'GET', `/pets/${lunaId}/history`);
    const firulais = await call(
      h,
      h.tokens.a,
      'GET',
      `/pets/${firulaisId}/history`,
    );

    const lunaLine = luna.body.data.timeline.find(
      (entry: { title: string }) => entry.title === 'Baño Luna',
    );
    const firulaisLine = firulais.body.data.timeline.find(
      (entry: { title: string }) => entry.title === 'Baño Firulais',
    );

    expect(lunaLine.amountCents).toBe(5_400_000);
    expect(firulaisLine.amountCents).toBe(3_600_000);
    expect(lunaLine.amountCents + firulaisLine.amountCents).toBe(9_000_000);
  });

  it('no existe historial de una mascota de otro negocio', async () => {
    const res = await call(h, h.tokens.b, 'GET', `/pets/${lunaId}/history`);
    expect(res.status).toBe(404);
  });
});
