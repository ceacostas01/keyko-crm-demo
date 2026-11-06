import { products, stockMovements } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { recordAudit, recordChange } from '../lib/audit';
import { conflict, isUniqueViolation, notFound, unprocessable } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import {
  productCreateSchema,
  productUpdateSchema,
  stockAdjustSchema,
} from '../schemas';

export const productRoutes = new Hono<AppEnv>();

productRoutes.use('*', requireAuth);

async function findDuplicateSku(
  db: AppEnv['Variables']['db'],
  businessId: string,
  sku: string | null | undefined,
  excludeId?: string,
): Promise<boolean> {
  if (!sku) return false;
  const [row] = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.businessId, businessId), eq(products.sku, sku)))
    .limit(1);
  return Boolean(row && row.id !== excludeId);
}

productRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');

  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.businessId, businessId), isNull(products.deletedAt)))
    .orderBy(asc(products.name));

  return c.json({ data: rows });
});

productRoutes.post('/', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(productCreateSchema, await readJson(c));
  const sku = body.sku?.trim() || null;

  if (await findDuplicateSku(db, businessId, sku)) {
    throw conflict('duplicate_sku', 'Ya existe un artículo con ese SKU');
  }

  let row: typeof products.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(products)
      .values({
        id: crypto.randomUUID(),
        businessId,
        sku,
        name: body.name,
        priceCents: body.priceCents,
        costCents: body.costCents ?? 0,
        stock: body.stock ?? 0,
        minStock: body.minStock ?? 0,
        active: body.active === false ? 0 : 1,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('duplicate_sku', 'Ya existe un artículo con ese SKU');
    }
    throw error;
  }

  if (!row) throw unprocessable('No se pudo crear el artículo');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'product.create',
    entity: 'product',
    entityId: row.id,
    diff: {
      name: { from: null, to: row.name },
      sku: { from: null, to: row.sku },
      stock: { from: null, to: row.stock },
    },
  });

  return c.json({ data: row }, 201);
});

productRoutes.get('/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, id),
        eq(products.businessId, businessId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Artículo no encontrado');

  const movements = await db
    .select()
    .from(stockMovements)
    .where(
      and(
        eq(stockMovements.productId, id),
        eq(stockMovements.businessId, businessId),
      ),
    )
    .orderBy(asc(stockMovements.createdAt));

  return c.json({ data: { ...row, movements } });
});

productRoutes.patch('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(productUpdateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(products)
    .where(
      and(
        eq(products.id, id),
        eq(products.businessId, businessId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  if (!current) throw notFound('Artículo no encontrado');

  const sku = body.sku === undefined ? current.sku : body.sku?.trim() || null;
  if (sku !== current.sku && (await findDuplicateSku(db, businessId, sku, id))) {
    throw conflict('duplicate_sku', 'Ya existe un artículo con ese SKU');
  }

  const patch = {
    sku,
    name: body.name ?? current.name,
    priceCents: body.priceCents ?? current.priceCents,
    costCents: body.costCents ?? current.costCents,
    minStock: body.minStock ?? current.minStock,
    active: body.active === undefined ? current.active : body.active ? 1 : 0,
    updatedAt: nowSqlite(),
  };

  let row: typeof products.$inferSelect | undefined;
  try {
    [row] = await db
      .update(products)
      .set(patch)
      .where(and(eq(products.id, id), eq(products.businessId, businessId)))
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('duplicate_sku', 'Ya existe un artículo con ese SKU');
    }
    throw error;
  }

  if (!row) throw notFound('Artículo no encontrado');

  await recordChange(
    db,
    {
      businessId,
      actorId: userId,
      action: 'product.update',
      entity: 'product',
      entityId: id,
    },
    current as unknown as Record<string, unknown>,
    patch,
  );

  return c.json({ data: row });
});

productRoutes.delete('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const deletedAt = nowSqlite();

  const [row] = await db
    .update(products)
    .set({ deletedAt, active: 0 })
    .where(
      and(
        eq(products.id, id),
        eq(products.businessId, businessId),
        isNull(products.deletedAt),
      ),
    )
    .returning({ id: products.id });

  if (!row) throw notFound('Artículo no encontrado');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'product.delete',
    entity: 'product',
    entityId: row.id,
    diff: { deletedAt: { from: null, to: deletedAt } },
  });

  return c.json({ data: { id: row.id, deleted: true } });
});

/**
 * Ajuste de inventario.
 *
 * El stock no se lee y luego se escribe: la resta ocurre dentro del propio
 * UPDATE (`stock = stock + delta`) con la condición `stock + delta >= 0`.
 * Así dos ventas simultáneas no se pisan ni pueden vender de más.
 */
productRoutes.post('/:id/stock', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(stockAdjustSchema, await readJson(c));

  const [before] = await db
    .select({ stock: products.stock })
    .from(products)
    .where(
      and(
        eq(products.id, id),
        eq(products.businessId, businessId),
        isNull(products.deletedAt),
      ),
    )
    .limit(1);

  if (!before) throw notFound('Artículo no encontrado');

  const [row] = await db
    .update(products)
    .set({
      stock: sql`${products.stock} + ${body.delta}`,
      updatedAt: nowSqlite(),
    })
    .where(
      and(
        eq(products.id, id),
        eq(products.businessId, businessId),
        isNull(products.deletedAt),
        sql`${products.stock} + ${body.delta} >= 0`,
      ),
    )
    .returning();

  if (!row) {
    // Otra petición se quedó con las últimas unidades, o el stock cambió.
    const [actual] = await db
      .select({ stock: products.stock })
      .from(products)
      .where(and(eq(products.id, id), eq(products.businessId, businessId)))
      .limit(1);

    throw unprocessable('El stock no puede quedar negativo', [
      { path: 'delta', message: `Stock actual: ${actual?.stock ?? 0}` },
    ]);
  }

  await db.insert(stockMovements).values({
    id: crypto.randomUUID(),
    businessId,
    productId: id,
    delta: body.delta,
    reason: body.reason,
    refType: body.refType ?? null,
    refId: body.refId ?? null,
  });

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'product.stock',
    entity: 'product',
    entityId: id,
    diff: {
      stock: { from: before.stock, to: row.stock },
      delta: { from: null, to: body.delta },
      reason: { from: null, to: body.reason },
    },
  });

  return c.json({ data: row });
});
