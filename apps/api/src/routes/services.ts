import { services } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { recordAudit, recordChange } from '../lib/audit';
import { notFound, unprocessable } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { serviceCreateSchema, serviceUpdateSchema } from '../schemas';

export const serviceRoutes = new Hono<AppEnv>();

serviceRoutes.use('*', requireAuth);

serviceRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');

  const rows = await db
    .select()
    .from(services)
    .where(and(eq(services.businessId, businessId), isNull(services.deletedAt)))
    .orderBy(asc(services.name));

  return c.json({ data: rows });
});

serviceRoutes.post('/', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(serviceCreateSchema, await readJson(c));

  const [row] = await db
    .insert(services)
    .values({
      id: crypto.randomUUID(),
      businessId,
      name: body.name,
      category: body.category ?? null,
      durationMin: body.durationMin ?? 30,
      priceCents: body.priceCents,
      active: body.active === false ? 0 : 1,
    })
    .returning();

  if (!row) throw unprocessable('No se pudo crear el servicio');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'service.create',
    entity: 'service',
    entityId: row.id,
    diff: {
      name: { from: null, to: row.name },
      priceCents: { from: null, to: row.priceCents },
    },
  });

  return c.json({ data: row }, 201);
});

serviceRoutes.get('/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.id, id),
        eq(services.businessId, businessId),
        isNull(services.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Servicio no encontrado');
  return c.json({ data: row });
});

serviceRoutes.patch('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(serviceUpdateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(services)
    .where(
      and(
        eq(services.id, id),
        eq(services.businessId, businessId),
        isNull(services.deletedAt),
      ),
    )
    .limit(1);

  if (!current) throw notFound('Servicio no encontrado');

  const patch = {
    name: body.name ?? current.name,
    category: body.category === undefined ? current.category : body.category,
    durationMin: body.durationMin ?? current.durationMin,
    priceCents: body.priceCents ?? current.priceCents,
    active: body.active === undefined ? current.active : body.active ? 1 : 0,
    updatedAt: nowSqlite(),
  };

  const [row] = await db
    .update(services)
    .set(patch)
    .where(and(eq(services.id, id), eq(services.businessId, businessId)))
    .returning();

  if (!row) throw notFound('Servicio no encontrado');

  await recordChange(
    db,
    {
      businessId,
      actorId: userId,
      action: 'service.update',
      entity: 'service',
      entityId: id,
    },
    current as unknown as Record<string, unknown>,
    patch,
  );

  return c.json({ data: row });
});

serviceRoutes.delete('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const deletedAt = nowSqlite();

  const [row] = await db
    .update(services)
    .set({ deletedAt, active: 0 })
    .where(
      and(
        eq(services.id, id),
        eq(services.businessId, businessId),
        isNull(services.deletedAt),
      ),
    )
    .returning({ id: services.id });

  if (!row) throw notFound('Servicio no encontrado');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'service.delete',
    entity: 'service',
    entityId: row.id,
    diff: { deletedAt: { from: null, to: deletedAt } },
  });

  return c.json({ data: { id: row.id, deleted: true } });
});
