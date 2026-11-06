import { auditLog, users } from '@keyko/db';
import { and, desc, eq, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { parse } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import { auditQuerySchema } from '../schemas';

/**
 * Consulta de auditoría: solo lectura, siempre del negocio del token.
 */
export const auditRoutes = new Hono<AppEnv>();

auditRoutes.use('*', requireAuth);

auditRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const { limit, offset, entity, action } = parse(
    auditQuerySchema,
    c.req.query(),
  );

  const filters: SQL[] = [eq(auditLog.businessId, businessId)];
  if (entity) filters.push(eq(auditLog.entity, entity));
  if (action) filters.push(eq(auditLog.action, action));

  const rows = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      entity: auditLog.entity,
      entityId: auditLog.entityId,
      actorId: auditLog.actorId,
      actorName: users.name,
      diffJson: auditLog.diffJson,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(and(...filters))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({
    data: rows.map(({ diffJson, ...rest }) => ({
      ...rest,
      diff: diffJson ? (JSON.parse(diffJson) as unknown) : null,
    })),
    pagination: { limit, offset, count: rows.length },
  });
});
