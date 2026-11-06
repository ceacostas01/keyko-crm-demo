import { expenses } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, desc, eq, gte, isNull, lte, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { recordAudit, recordChange } from '../lib/audit';
import { notFound, unprocessable } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { requireAuth } from '../middleware/auth';
import {
  expenseCreateSchema,
  expenseQuerySchema,
  expenseUpdateSchema,
} from '../schemas';

/**
 * Egresos del negocio.
 *
 * `incurredAt` es una fecha local (`YYYY-MM-DD`), no un instante: un pago de
 * luz pertenece al día en que se registra, sin que la zona horaria lo mueva
 * al día anterior o siguiente.
 */
export const expenseRoutes = new Hono<AppEnv>();

expenseRoutes.use('*', requireAuth);

expenseRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(expenseQuerySchema, c.req.query());

  const filters: SQL[] = [
    eq(expenses.businessId, businessId),
    isNull(expenses.deletedAt),
  ];
  if (query.from) filters.push(gte(expenses.incurredAt, query.from));
  if (query.to) filters.push(lte(expenses.incurredAt, query.to));
  if (query.category) filters.push(eq(expenses.category, query.category));

  const rows = await db
    .select()
    .from(expenses)
    .where(and(...filters))
    .orderBy(desc(expenses.incurredAt), desc(expenses.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({
    data: rows,
    pagination: { limit: query.limit, offset: query.offset, count: rows.length },
  });
});

expenseRoutes.post('/', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(expenseCreateSchema, await readJson(c));

  const [row] = await db
    .insert(expenses)
    .values({
      id: crypto.randomUUID(),
      businessId,
      category: body.category,
      reason: body.reason,
      amountCents: body.amountCents,
      incurredAt: body.incurredAt,
      vendor: body.vendor?.trim() || null,
      createdBy: userId,
    })
    .returning();

  if (!row) throw unprocessable('No se pudo registrar el egreso');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'expense.create',
    entity: 'expense',
    entityId: row.id,
    diff: {
      category: { from: null, to: row.category },
      reason: { from: null, to: row.reason },
      amountCents: { from: null, to: row.amountCents },
      incurredAt: { from: null, to: row.incurredAt },
    },
  });

  return c.json({ data: row }, 201);
});

expenseRoutes.patch('/:id', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(expenseUpdateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(expenses)
    .where(
      and(
        eq(expenses.id, id),
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
      ),
    )
    .limit(1);

  if (!current) throw notFound('Egreso no encontrado');

  const patch = {
    ...(body.category === undefined ? {} : { category: body.category }),
    ...(body.reason === undefined ? {} : { reason: body.reason }),
    ...(body.amountCents === undefined ? {} : { amountCents: body.amountCents }),
    ...(body.incurredAt === undefined ? {} : { incurredAt: body.incurredAt }),
    ...(body.vendor === undefined
      ? {}
      : { vendor: body.vendor?.trim() || null }),
  };

  if (Object.keys(patch).length === 0) {
    return c.json({ data: current });
  }

  const [row] = await db
    .update(expenses)
    .set(patch)
    .where(
      and(
        eq(expenses.id, id),
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
      ),
    )
    .returning();

  if (!row) throw notFound('Egreso no encontrado');

  await recordChange(
    db,
    {
      businessId,
      actorId: userId,
      action: 'expense.update',
      entity: 'expense',
      entityId: id,
    },
    current as unknown as Record<string, unknown>,
    patch,
  );

  return c.json({ data: row });
});

expenseRoutes.delete('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const deletedAt = nowSqlite();

  const [row] = await db
    .update(expenses)
    .set({ deletedAt })
    .where(
      and(
        eq(expenses.id, id),
        eq(expenses.businessId, businessId),
        isNull(expenses.deletedAt),
      ),
    )
    .returning({ id: expenses.id });

  if (!row) throw notFound('Egreso no encontrado');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'expense.delete',
    entity: 'expense',
    entityId: row.id,
    diff: { deletedAt: { from: null, to: deletedAt } },
  });

  return c.json({ data: { id: row.id, deleted: true } });
});
