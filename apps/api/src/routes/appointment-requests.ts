import { appointmentRequests, appointments, clients, pets } from '@keyko/db';
import { nowSqlite, utcToLocal, BOGOTA_TZ } from '@keyko/domain';
import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { recordAudit } from '../lib/audit';
import { notFound, unprocessable } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import { requireAuth } from '../middleware/auth';
import {
  appointmentRequestQuerySchema,
  appointmentRequestUpdateSchema,
} from '../schemas';

export const appointmentRequestRoutes = new Hono<AppEnv>();

appointmentRequestRoutes.use('*', requireAuth);

appointmentRequestRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(appointmentRequestQuerySchema, c.req.query());

  const filters = [
    eq(appointmentRequests.businessId, businessId),
    eq(appointmentRequests.status, query.status),
  ];
  if (query.contactKey) {
    filters.push(eq(appointmentRequests.contactKey, query.contactKey));
  }

  const rows = await db
    .select({
      request: appointmentRequests,
      clientName: clients.fullName,
      petName: pets.name,
      appointmentStartsAt: appointments.startsAt,
      appointmentStatus: appointments.status,
    })
    .from(appointmentRequests)
    .leftJoin(clients, eq(clients.id, appointmentRequests.clientId))
    .leftJoin(pets, eq(pets.id, appointmentRequests.petId))
    .leftJoin(appointments, eq(appointments.id, appointmentRequests.appointmentId))
    .where(and(...filters))
    .orderBy(desc(appointmentRequests.createdAt))
    .limit(query.limit)
    .offset(query.offset);

  return c.json({
    data: rows.map((row) => ({
      ...row.request,
      clientName: row.clientName,
      petName: row.petName,
      appointmentStartsAtLocal: row.appointmentStartsAt
        ? utcToLocal(row.appointmentStartsAt, BOGOTA_TZ)
        : null,
      appointmentStatus: row.appointmentStatus,
    })),
    pagination: { limit: query.limit, offset: query.offset, count: rows.length },
  });
});

appointmentRequestRoutes.patch('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(appointmentRequestUpdateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(appointmentRequests)
    .where(
      and(
        eq(appointmentRequests.id, id),
        eq(appointmentRequests.businessId, businessId),
      ),
    )
    .limit(1);

  if (!current) throw notFound('Solicitud de cita no encontrada');

  const appointmentId = body.appointmentId ?? current.appointmentId;
  if (
    (body.status === 'scheduled' || body.status === 'confirmed') &&
    !appointmentId
  ) {
    throw unprocessable('Para agendar o confirmar hace falta una cita');
  }

  if (appointmentId) {
    const [appointment] = await db
      .select()
      .from(appointments)
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.businessId, businessId),
        ),
      )
      .limit(1);
    if (!appointment) throw notFound('Cita no encontrada');
    if (appointment.status === 'cancelled') {
      throw unprocessable('No se puede vincular una cita cancelada');
    }
  }

  if (body.clientId) {
    const [client] = await db
      .select({ id: clients.id })
      .from(clients)
      .where(
        and(
          eq(clients.id, body.clientId),
          eq(clients.businessId, businessId),
        ),
      )
      .limit(1);
    if (!client) throw notFound('Cliente no encontrado');
  }

  if (body.petId) {
    const [pet] = await db
      .select({ id: pets.id })
      .from(pets)
      .where(and(eq(pets.id, body.petId), eq(pets.businessId, businessId)))
      .limit(1);
    if (!pet) throw notFound('Mascota no encontrada');
  }

  const confirmedAt =
    body.status === 'confirmed' ? current.confirmedAt ?? nowSqlite() : null;

  const [row] = await db
    .update(appointmentRequests)
    .set({
      status: body.status,
      appointmentId: appointmentId ?? null,
      ...(body.clientId === undefined ? {} : { clientId: body.clientId }),
      ...(body.petId === undefined ? {} : { petId: body.petId }),
      confirmedAt,
      updatedAt: nowSqlite(),
    })
    .where(
      and(
        eq(appointmentRequests.id, id),
        eq(appointmentRequests.businessId, businessId),
      ),
    )
    .returning();

  if (!row) throw notFound('Solicitud de cita no encontrada');

  // Confirmar la solicitud confirma también la cita vinculada si seguía
  // programada. No se toca una cita ya completada o cancelada.
  if (body.status === 'confirmed' && appointmentId) {
    await db
      .update(appointments)
      .set({ status: 'confirmed', updatedAt: nowSqlite() })
      .where(
        and(
          eq(appointments.id, appointmentId),
          eq(appointments.businessId, businessId),
          eq(appointments.status, 'scheduled'),
        ),
      );
  }

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'appointment_request.update',
    entity: 'appointment_request',
    entityId: id,
    diff: {
      status: { from: current.status, to: row.status },
      appointmentId: { from: current.appointmentId, to: row.appointmentId },
    },
  });

  return c.json({ data: row });
});
