import type { Db } from '@keyko/db';
import { appointments, clients, pets } from '@keyko/db';
import {
  BOGOTA_TZ,
  dayRangeUtc,
  localToUtc,
  nowSqlite,
  toUtcIso,
  utcToLocal,
} from '@keyko/domain';
import { and, asc, eq, gte, lt, ne, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import {
  BUSINESS_HOURS,
  buildWarnings,
  findConflicts,
  type Conflict,
  type EnrichedRow,
} from '../lib/agenda';
import { recordAudit, recordChange } from '../lib/audit';
import { badRequest, notFound, unprocessable } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import { idempotent } from '../lib/idempotency';
import { requireAuth } from '../middleware/auth';
import {
  appointmentCreateSchema,
  appointmentQuerySchema,
  appointmentUpdateSchema,
  availabilityQuerySchema,
  reactivateSchema,
} from '../schemas';

export const appointmentRoutes = new Hono<AppEnv>();

appointmentRoutes.use('*', requireAuth);

const MINUTE_MS = 60_000;

type AppointmentRow = typeof appointments.$inferSelect;

function serialize(row: AppointmentRow) {
  return {
    ...row,
    startsAtLocal: utcToLocal(row.startsAt, BOGOTA_TZ),
    endsAtLocal: utcToLocal(row.endsAt, BOGOTA_TZ),
  };
}

function parseDuration(startIso: string, endIso: string): number {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms <= 0) {
    throw unprocessable('La hora de fin debe ser posterior a la de inicio', [
      { path: 'endsAt', message: 'Rango de tiempo inválido' },
    ]);
  }
  return Math.round(ms / MINUTE_MS);
}

function resolveRange(input: {
  startsAt: string;
  endsAt?: string | undefined;
  durationMin?: number | undefined;
}): { startsAt: string; endsAt: string } {
  const startsAt = toUtcIso(input.startsAt, BOGOTA_TZ);
  if (input.endsAt) {
    const endsAt = toUtcIso(input.endsAt, BOGOTA_TZ);
    parseDuration(startsAt, endsAt);
    return { startsAt, endsAt };
  }
  if (!input.durationMin) {
    throw badRequest('Se requiere endsAt o durationMin');
  }
  const endsAt = new Date(
    Date.parse(startsAt) + input.durationMin * MINUTE_MS,
  ).toISOString();
  return { startsAt, endsAt };
}

/**
 * Citas que se cruzan con el intervalo dado, con nombre de mascota y dueño.
 * Se usa para las advertencias de una cita concreta.
 */
async function conflictsFor(
  db: Db,
  businessId: string,
  target: AppointmentRow,
  options: { excludeCancelled?: boolean } = {},
): Promise<Conflict[]> {
  const filters: SQL[] = [
    eq(appointments.businessId, businessId),
    ne(appointments.id, target.id),
    lt(appointments.startsAt, target.endsAt),
    sql`${appointments.endsAt} > ${target.startsAt}`,
  ];
  if (options.excludeCancelled !== false) {
    filters.push(ne(appointments.status, 'cancelled'));
  }

  const rows = await db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
      groomerId: appointments.groomerId,
      petId: appointments.petId,
      petName: pets.name,
      clientName: clients.fullName,
    })
    .from(appointments)
    .leftJoin(pets, eq(pets.id, appointments.petId))
    .leftJoin(clients, eq(clients.id, appointments.clientId))
    .where(and(...filters))
    .orderBy(asc(appointments.startsAt));

  return findConflicts(target, rows as EnrichedRow[]);
}

/** Filas del negocio en una ventana, con nombres, para calcular en memoria. */
async function poolFor(
  db: Db,
  businessId: string,
  fromIso: string,
  toIso: string,
): Promise<EnrichedRow[]> {
  const rows = await db
    .select({
      id: appointments.id,
      startsAt: appointments.startsAt,
      endsAt: appointments.endsAt,
      status: appointments.status,
      groomerId: appointments.groomerId,
      petId: appointments.petId,
      petName: pets.name,
      clientName: clients.fullName,
    })
    .from(appointments)
    .leftJoin(pets, eq(pets.id, appointments.petId))
    .leftJoin(clients, eq(clients.id, appointments.clientId))
    .where(
      and(
        eq(appointments.businessId, businessId),
        lt(appointments.startsAt, toIso),
        ne(appointments.status, 'cancelled'),
      ),
    )
    .orderBy(asc(appointments.startsAt));

  return rows as EnrichedRow[];
}

function withWarnings(row: AppointmentRow, conflicts: Conflict[]) {
  return {
    data: serialize(row),
    warnings: buildWarnings(row, conflicts),
  };
}

appointmentRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(appointmentQuerySchema, c.req.query());

  const filters: SQL[] = [eq(appointments.businessId, businessId)];
  if (query.from)
    filters.push(gte(appointments.startsAt, dayRangeUtc(query.from).startUtc));
  if (query.to) filters.push(lt(appointments.startsAt, dayRangeUtc(query.to).endUtc));
  if (query.groomerId) filters.push(eq(appointments.groomerId, query.groomerId));
  if (query.status) filters.push(eq(appointments.status, query.status));

  const rows = await db
    .select()
    .from(appointments)
    .where(and(...filters))
    .orderBy(asc(appointments.startsAt))
    .limit(query.limit)
    .offset(query.offset);

  // Los cruces se calculan contra una ventana más amplia que la página para
  // no perder una cita que empieza antes del rango consultado.
  let pool: EnrichedRow[] = [];
  if (query.withConflicts && rows.length > 0) {
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (first && last) {
      const dayMs = 24 * 60 * MINUTE_MS;
      pool = await poolFor(
        db,
        businessId,
        new Date(Date.parse(first.startsAt) - dayMs).toISOString(),
        new Date(Date.parse(last.endsAt) + dayMs).toISOString(),
      );
    }
  }

  return c.json({
    data: rows.map((row) => {
      const conflicts = query.withConflicts ? findConflicts(row, pool) : [];
      return {
        ...serialize(row),
        warnings: buildWarnings(row, conflicts),
      };
    }),
    pagination: { limit: query.limit, offset: query.offset, count: rows.length },
  });
});

/**
 * Crear NO falla por solapamiento. El CRM avisa y el administrador decide.
 * La única protección es la idempotencia, contra dobles envíos.
 */
appointmentRoutes.post('/', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(appointmentCreateSchema, await readJson(c));

  const [pet] = await db
    .select()
    .from(pets)
    .where(and(eq(pets.id, body.petId), eq(pets.businessId, businessId)))
    .limit(1);

  if (!pet) throw notFound('Mascota no encontrada');

  if (body.clientId !== undefined && body.clientId !== pet.clientId) {
    throw unprocessable('La mascota no pertenece a ese cliente', [
      { path: 'clientId', message: 'No coincide con el dueño de la mascota' },
    ]);
  }

  const [client] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(and(eq(clients.id, pet.clientId), eq(clients.businessId, businessId)))
    .limit(1);

  if (!client) throw notFound('Cliente no encontrado');

  const { startsAt, endsAt } = resolveRange(body);

  const [row] = await db
    .insert(appointments)
    .values({
      id: crypto.randomUUID(),
      businessId,
      clientId: pet.clientId,
      petId: pet.id,
      groomerId: body.groomerId ?? null,
      startsAt,
      endsAt,
      notes: body.notes ?? null,
      createdBy: userId,
    })
    .returning();

  if (!row) throw unprocessable('No se pudo crear la cita');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'appointment.create',
    entity: 'appointment',
    entityId: row.id,
    diff: {
      petId: { from: null, to: pet.id },
      startsAt: { from: null, to: startsAt },
      endsAt: { from: null, to: endsAt },
      groomerId: { from: null, to: row.groomerId },
    },
  });

  const conflicts = await conflictsFor(db, businessId, row);
  return c.json(withWarnings(row, conflicts), 201);
});

/**
 * Disponibilidad orientativa. Devuelve las franjas que caben en el horario
 * de atención y no se cruzan con otra cita. No es una restricción: la API
 * acepta cualquier hora.
 */
appointmentRoutes.get('/availability', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(availabilityQuerySchema, c.req.query());

  const { startUtc, endUtc } = dayRangeUtc(query.date);
  const [y, m, d] = query.date.split('-').map(Number);
  const weekday = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
  const closed = BUSINESS_HOURS.closedWeekdays.includes(weekday);

  const openLocal = `${String(BUSINESS_HOURS.openHour).padStart(2, '0')}:00`;
  const closeLocal = `${String(BUSINESS_HOURS.closeHour).padStart(2, '0')}:00`;
  const openUtc = Date.parse(localToUtc(`${query.date}T${openLocal}`));
  const closeUtc = Date.parse(localToUtc(`${query.date}T${closeLocal}`));

  const slots: Array<{ start: string; end: string; startLocal: string }> = [];

  if (!closed) {
    const busy = await db
      .select({
        startsAt: appointments.startsAt,
        endsAt: appointments.endsAt,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.businessId, businessId),
          ne(appointments.status, 'cancelled'),
          lt(appointments.startsAt, new Date(closeUtc).toISOString()),
          gte(appointments.endsAt, new Date(openUtc).toISOString()),
        ),
      );

    const busyRanges = busy.map((b) => ({
      start: Date.parse(b.startsAt),
      end: Date.parse(b.endsAt),
    }));

    const durationMs = query.durationMin * MINUTE_MS;
    const stepMs = query.stepMin * MINUTE_MS;

    for (let t = openUtc; t + durationMs <= closeUtc; t += stepMs) {
      const slotEnd = t + durationMs;
      if (busyRanges.some((b) => b.start < slotEnd && b.end > t)) continue;
      const iso = new Date(t).toISOString();
      slots.push({
        start: iso,
        end: new Date(slotEnd).toISOString(),
        startLocal: utcToLocal(iso, BOGOTA_TZ),
      });
    }
  }

  return c.json({
    data: {
      date: query.date,
      timezone: BOGOTA_TZ,
      /** `false` significa "no hay sugerencias", no "no se puede". */
      advisory: true,
      open: !closed,
      businessHours: {
        open: openLocal,
        close: closeLocal,
        closed,
      },
      durationMin: query.durationMin,
      stepMin: query.stepMin,
      slots,
    },
    meta: { weekday, range: { startUtc, endUtc } },
  });
});

appointmentRoutes.get('/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .limit(1);

  if (!row) throw notFound('Cita no encontrada');

  const conflicts = await conflictsFor(db, businessId, row);
  return c.json(withWarnings(row, conflicts));
});

/** Consulta explícita de cruces, para refrescar el panel sin recargar la cita. */
appointmentRoutes.get('/:id/conflicts', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  const [row] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .limit(1);

  if (!row) throw notFound('Cita no encontrada');

  const conflicts = await conflictsFor(db, businessId, row);

  return c.json({
    data: {
      appointmentId: row.id,
      conflicts,
      totalOverlapMinutes: conflicts.reduce(
        (sum, conflict) => sum + conflict.overlapMinutes,
        0,
      ),
      warnings: buildWarnings(row, conflicts),
    },
  });
});

/** Mover o editar. Tampoco bloquea por solapamiento. */
appointmentRoutes.patch('/:id', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(appointmentUpdateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .limit(1);

  if (!current) throw notFound('Cita no encontrada');

  const startsAt = body.startsAt
    ? toUtcIso(body.startsAt, BOGOTA_TZ)
    : current.startsAt;

  let endsAt = current.endsAt;
  if (body.endsAt) {
    endsAt = toUtcIso(body.endsAt, BOGOTA_TZ);
  } else if (body.durationMin || body.startsAt) {
    const durationMs =
      body.durationMin !== undefined
        ? body.durationMin * MINUTE_MS
        : Date.parse(current.endsAt) - Date.parse(current.startsAt);
    endsAt = new Date(Date.parse(startsAt) + durationMs).toISOString();
  }

  parseDuration(startsAt, endsAt);

  const patch = {
    startsAt,
    endsAt,
    groomerId: body.groomerId === undefined ? current.groomerId : body.groomerId,
    status: body.status ?? current.status,
    notes: body.notes === undefined ? current.notes : body.notes,
    updatedAt: nowSqlite(),
  };

  const [row] = await db
    .update(appointments)
    .set(patch)
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .returning();

  if (!row) throw notFound('Cita no encontrada');

  await recordChange(
    db,
    {
      businessId,
      actorId: userId,
      action: 'appointment.update',
      entity: 'appointment',
      entityId: id,
    },
    current as unknown as Record<string, unknown>,
    patch,
  );

  const conflicts = await conflictsFor(db, businessId, row);
  return c.json(withWarnings(row, conflicts));
});

/** Cancelar es un cambio de estado, idempotente por naturaleza. */
appointmentRoutes.delete('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  const [row] = await db
    .update(appointments)
    .set({ status: 'cancelled', updatedAt: nowSqlite() })
    .where(
      and(
        eq(appointments.id, id),
        eq(appointments.businessId, businessId),
        ne(appointments.status, 'cancelled'),
      ),
    )
    .returning();

  if (!row) {
    const [existing] = await db
      .select()
      .from(appointments)
      .where(
        and(eq(appointments.id, id), eq(appointments.businessId, businessId)),
      )
      .limit(1);

    if (!existing) throw notFound('Cita no encontrada');
    return c.json({ data: serialize(existing), warnings: [] });
  }

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'appointment.cancel',
    entity: 'appointment',
    entityId: row.id,
    diff: { status: { from: 'scheduled', to: 'cancelled' } },
  });

  return c.json({ data: serialize(row), warnings: [] });
});

/** Reactivar una cita cancelada, para cuando el cliente vuelve a confirmar. */
appointmentRoutes.post('/:id/reactivate', idempotent, async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(reactivateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(appointments)
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .limit(1);

  if (!current) throw notFound('Cita no encontrada');

  if (current.status !== 'cancelled') {
    const conflicts = await conflictsFor(db, businessId, current);
    return c.json(withWarnings(current, conflicts));
  }

  const [row] = await db
    .update(appointments)
    .set({ status: body.status, updatedAt: nowSqlite() })
    .where(and(eq(appointments.id, id), eq(appointments.businessId, businessId)))
    .returning();

  if (!row) throw notFound('Cita no encontrada');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'appointment.reactivate',
    entity: 'appointment',
    entityId: id,
    diff: { status: { from: 'cancelled', to: row.status } },
  });

  const conflicts = await conflictsFor(db, businessId, row);
  return c.json(withWarnings(row, conflicts));
});
