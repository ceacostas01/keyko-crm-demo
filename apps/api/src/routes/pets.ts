import type { Db } from '@keyko/db';
import {
  appointments,
  clients,
  petHealthRecords,
  petNotes,
  pets,
  saleItems,
  sales,
} from '@keyko/db';
import { BOGOTA_TZ, nowSqlite, utcToLocal } from '@keyko/domain';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNotNull,
  isNull,
  like,
  lte,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { buildDiff, recordAudit, recordChange } from '../lib/audit';
import { petCompleteness, loadPendingFields } from '../lib/completeness';
import { validateProfileFlags, PET_PROFILE } from '@keyko/domain';
import { signPhotoToken } from '../lib/jwt';
import { photoKeyFor, requirePhotoStorage, validateImage } from '../lib/photos';
import { conflict, notFound, unprocessable } from '../lib/errors';
import { recordOverrides } from '../lib/overrides';
import { parse, readJson } from '../lib/http';
import {
  petSize,
  SIZE_LABELS,
  attributedCents,
} from '../lib/sales';
import { sqliteToIso } from '../lib/time';
import { requireAuth } from '../middleware/auth';
import { petCreateSchema, petQuerySchema, petUpdateSchema } from '../schemas';

export const petRoutes = new Hono<AppEnv>();

petRoutes.use('*', requireAuth);

async function assertClient(
  db: Db,
  businessId: string,
  clientId: number,
): Promise<void> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(
      and(
        eq(clients.id, clientId),
        eq(clients.businessId, businessId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);
  if (!row) throw notFound('Cliente no encontrado');
}

function resolvePhotoUrl(
  pet: { id: string; photoKey?: string | null; photoUrl: string | null },
  token: string | null,
): string | null {
  if (!pet.photoKey) return pet.photoUrl;
  if (!token) return null;
  return `/api/v1/photos/pets/${pet.id}?token=${encodeURIComponent(token)}`;
}

function photoMaxBytes(env: { PHOTO_MAX_BYTES?: string }): number {
  const value = Number(env.PHOTO_MAX_BYTES);
  return Number.isFinite(value) && value > 0 ? value : 5 * 1024 * 1024;
}

function photoTtl(env: { PHOTO_URL_TTL_SECONDS?: string }): number {
  const value = Number(env.PHOTO_URL_TTL_SECONDS);
  return Number.isFinite(value) && value > 0 ? value : 900;
}

function withSize<T extends { weightKg: number | null }>(pet: T) {
  const size = petSize(pet.weightKg);
  return {
    ...pet,
    size,
    sizeLabel: size ? SIZE_LABELS[size] : null,
  };
}

/**
 * Listado de mascotas: la pantalla principal del CRM.
 * Busca por nombre, raza, propietario o teléfono, y filtra por especie,
 * tamaño y propietario.
 */
petRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(petQuerySchema, c.req.query());

  const filters: SQL[] = [
    eq(pets.businessId, businessId),
    isNull(pets.deletedAt),
  ];

  if (query.species) filters.push(eq(pets.species, query.species));
  if (query.clientId) filters.push(eq(pets.clientId, query.clientId));
  if (query.breed) filters.push(like(pets.breed, `%${query.breed}%`));

  if (query.size === 'small') {
    filters.push(and(isNotNull(pets.weightKg), lt(pets.weightKg, 10)) as SQL);
  }
  if (query.size === 'medium') {
    filters.push(and(gte(pets.weightKg, 10), lte(pets.weightKg, 25)) as SQL);
  }
  if (query.size === 'large') {
    filters.push(and(isNotNull(pets.weightKg), gt(pets.weightKg, 25)) as SQL);
  }

  if (query.search) {
    const term = `%${query.search.trim()}%`;
    const match = or(
      like(pets.name, term),
      like(pets.breed, term),
      like(pets.temperament, term),
      like(clients.fullName, term),
      like(clients.phone, term),
    );
    if (match) filters.push(match);
  }

  const rows = await db
    .select({
      pet: pets,
      clientName: clients.fullName,
      clientPhone: clients.phone,
      clientId: clients.id,
    })
    .from(pets)
    .innerJoin(clients, eq(clients.id, pets.clientId))
    .where(and(...filters))
    .orderBy(asc(pets.name))
    .limit(500);

  // La completitud se calcula en memoria (una sola carga de pendientes).
  // El negocio es pequeño; así los filtros y el porcentaje son consistentes.
  const pending = await loadPendingFields(db, businessId);
  const photoToken = await signPhotoToken(
    c.env.JWT_SECRET,
    businessId,
    photoTtl(c.env),
  );
  const missingKeys = (query.missing ?? '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  const enriched = rows
    .map((row) => ({
      ...withSize(row.pet),
      photoUrl: resolvePhotoUrl(row.pet, photoToken),
      clientName: row.clientName,
      clientPhone: row.clientPhone,
      completeness: petCompleteness(row.pet, pending),
    }))
    .filter((row) => {
      if (missingKeys.length > 0) {
        const incomplete = new Set([
          ...row.completeness.missing,
          ...row.completeness.pending,
        ]);
        if (!missingKeys.every((key) => incomplete.has(key))) return false;
      }

      if (query.completeness === 'under50') return row.completeness.percent < 50;
      if (query.completeness === 'mid') {
        return row.completeness.percent >= 50 && row.completeness.percent <= 80;
      }
      if (query.completeness === 'over80') return row.completeness.percent > 80;

      return true;
    });

  const page = enriched.slice(query.offset, query.offset + query.limit);

  return c.json({
    data: page,
    pagination: {
      limit: query.limit,
      offset: query.offset,
      count: enriched.length,
    },
  });
});

petRoutes.post('/', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(petCreateSchema, await readJson(c));

  await assertClient(db, businessId, body.clientId);

  const [row] = await db
    .insert(pets)
    .values({
      id: crypto.randomUUID(),
      businessId,
      clientId: body.clientId,
      name: body.name,
      species: body.species ?? 'perro',
      breed: body.breed ?? null,
      sex: body.sex ?? null,
      birthdate: body.birthdate ?? null,
      ageYears: body.ageYears ?? null,
      weightKg: body.weightKg ?? null,
      allergies: body.allergies ?? null,
      temperament: body.temperament ?? null,
      photoUrl: body.photoUrl ?? null,
    })
    .returning();

  if (!row) throw unprocessable('No se pudo crear la mascota');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'pet.create',
    entity: 'pet',
    entityId: row.id,
    diff: {
      name: { from: null, to: row.name },
      clientId: { from: null, to: row.clientId },
    },
  });

  const pending = await loadPendingFields(db, businessId);
  return c.json(
    {
      data: {
        ...withSize(row),
        completeness: petCompleteness(row, pending),
      },
    },
    201,
  );
});

petRoutes.get('/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  const [row] = await db
    .select({ pet: pets, client: clients })
    .from(pets)
    .innerJoin(clients, eq(clients.id, pets.clientId))
    .where(
      and(
        eq(pets.id, id),
        eq(pets.businessId, businessId),
        isNull(pets.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Mascota no encontrada');

  const health = await db
    .select()
    .from(petHealthRecords)
    .where(
      and(
        eq(petHealthRecords.petId, id),
        eq(petHealthRecords.businessId, businessId),
      ),
    )
    .orderBy(desc(petHealthRecords.occurredAt));

  const pending = await loadPendingFields(db, businessId);
  const photoToken = await signPhotoToken(
    c.env.JWT_SECRET,
    businessId,
    photoTtl(c.env),
  );

  return c.json({
    data: {
      ...withSize(row.pet),
      photoUrl: resolvePhotoUrl(row.pet, photoToken),
      client: {
        id: row.client.id,
        name: row.client.fullName,
        phone: row.client.phone,
        email: row.client.email,
      },
      health,
      completeness: petCompleteness(row.pet, pending),
    },
  });
});

/**
 * Historial completo de una mascota, construido desde los registros reales:
 * líneas de venta (servicios y artículos), citas, salud y notas. No se
 * duplica información: se lee de las tablas que ya existen.
 */
petRoutes.get('/:id/history', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  const [petRow] = await db
    .select({ pet: pets, client: clients })
    .from(pets)
    .innerJoin(clients, eq(clients.id, pets.clientId))
    .where(
      and(
        eq(pets.id, id),
        eq(pets.businessId, businessId),
        isNull(pets.deletedAt),
      ),
    )
    .limit(1);

  if (!petRow) throw notFound('Mascota no encontrada');

  const appointmentRows = await db
    .select()
    .from(appointments)
    .where(
      and(eq(appointments.businessId, businessId), eq(appointments.petId, id)),
    )
    .orderBy(desc(appointments.startsAt));

  const lineRows = await db
    .select({ item: saleItems, sale: sales })
    .from(saleItems)
    .innerJoin(sales, eq(sales.id, saleItems.saleId))
    .where(
      and(
        eq(saleItems.businessId, businessId),
        eq(saleItems.petId, id),
        ne(sales.status, 'void'),
      ),
    )
    .orderBy(desc(sales.createdAt));

  const health = await db
    .select()
    .from(petHealthRecords)
    .where(
      and(
        eq(petHealthRecords.petId, id),
        eq(petHealthRecords.businessId, businessId),
      ),
    );

  const notes = await db
    .select()
    .from(petNotes)
    .where(
      and(eq(petNotes.petId, id), eq(petNotes.businessId, businessId)),
    );

  type TimelineEntry = {
    id: string;
    type: 'service' | 'product' | 'appointment' | 'health' | 'note';
    at: string;
    title: string;
    detail: string | null;
    amountCents: number | null;
    status: string | null;
    refId: string;
    saleId: string | null;
  };

  const timeline: TimelineEntry[] = [];

  let totalSpentCents = 0;
  let servicesCount = 0;
  let productsCount = 0;
  let lastServiceAt: string | null = null;
  let lastServiceName: string | null = null;

  for (const row of lineRows) {
    const attributed = attributedCents(
      row.sale.subtotalCents || row.item.totalCents,
      row.sale.discountCents,
      row.item.totalCents,
    );

    totalSpentCents += attributed;

    if (row.item.itemType === 'service') {
      servicesCount += 1;
      if (!lastServiceAt || row.sale.createdAt > lastServiceAt) {
        lastServiceAt = row.sale.createdAt;
        lastServiceName = row.item.name;
      }
    } else {
      productsCount += row.item.qty;
    }

    timeline.push({
      id: row.item.id,
      type: row.item.itemType === 'service' ? 'service' : 'product',
      at: sqliteToIso(row.sale.createdAt),
      title: row.item.name,
      detail: row.item.notes ?? null,
      amountCents: attributed,
      status: row.sale.status,
      refId: row.item.id,
      saleId: row.sale.id,
    });
  }

  for (const appointment of appointmentRows) {
    timeline.push({
      id: appointment.id,
      type: 'appointment',
      at: appointment.startsAt,
      title: 'Cita',
      detail: appointment.notes ?? null,
      amountCents: null,
      status: appointment.status,
      refId: appointment.id,
      saleId: null,
    });
  }

  for (const record of health) {
    timeline.push({
      id: record.id,
      type: 'health',
      at: sqliteToIso(record.occurredAt),
      title: record.description,
      detail: record.type,
      amountCents: null,
      status: null,
      refId: record.id,
      saleId: null,
    });
  }

  for (const note of notes) {
    timeline.push({
      id: note.id,
      type: 'note',
      at: sqliteToIso(note.createdAt),
      title: note.body,
      detail: null,
      amountCents: null,
      status: null,
      refId: note.id,
      saleId: null,
    });
  }

  timeline.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const nowIso = new Date().toISOString();
  const pastVisits = appointmentRows.filter(
    (appointment) => appointment.startsAt <= nowIso,
  );
  const upcoming = appointmentRows.filter(
    (appointment) => appointment.startsAt > nowIso,
  );

  const pending = await loadPendingFields(db, businessId);
  const photoToken = await signPhotoToken(
    c.env.JWT_SECRET,
    businessId,
    photoTtl(c.env),
  );

  return c.json({
    data: {
      pet: {
        ...withSize(petRow.pet),
        photoUrl: resolvePhotoUrl(petRow.pet, photoToken),
      },
      completeness: petCompleteness(petRow.pet, pending),
      client: {
        id: petRow.client.id,
        name: petRow.client.fullName,
        phone: petRow.client.phone,
        email: petRow.client.email,
      },
      stats: {
        totalSpentCents,
        servicesCount,
        productsCount,
        salesCount: new Set(lineRows.map((row) => row.sale.id)).size,
        visitsCount: pastVisits.length,
        upcomingCount: upcoming.length,
        lastServiceAt: lastServiceAt ? sqliteToIso(lastServiceAt) : null,
        lastServiceName,
      },
      appointments: appointmentRows.map((appointment) => ({
        ...appointment,
        startsAtLocal: utcToLocal(appointment.startsAt, BOGOTA_TZ),
        endsAtLocal: utcToLocal(appointment.endsAt, BOGOTA_TZ),
      })),
      timeline,
    },
  });
});

petRoutes.patch('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const body = parse(petUpdateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(pets)
    .where(
      and(
        eq(pets.id, id),
        eq(pets.businessId, businessId),
        isNull(pets.deletedAt),
      ),
    )
    .limit(1);

  if (!current) throw notFound('Mascota no encontrada');

  let flagsJson = current.profileFlagsJson;
  if (body.profileFlags !== undefined) {
    const validation = validateProfileFlags(
      'pet',
      body.profileFlags,
      PET_PROFILE.map((field) => field.key),
    );
    if (validation.invalid.length > 0) {
      throw unprocessable('Marcas no válidas para una mascota', [
        {
          path: 'profileFlags',
          message: `No se puede marcar así: ${validation.invalid.join(', ')}`,
        },
      ]);
    }
    flagsJson = body.profileFlags === null
      ? null
      : JSON.stringify({ unknown: validation.unknown, na: validation.na });
  }

  const patch = {
    name: body.name ?? current.name,
    species: body.species ?? current.species,
    breed: body.breed === undefined ? current.breed : body.breed,
    sex: body.sex === undefined ? current.sex : body.sex,
    birthdate: body.birthdate === undefined ? current.birthdate : body.birthdate,
    ageYears: body.ageYears === undefined ? current.ageYears : body.ageYears,
    weightKg: body.weightKg === undefined ? current.weightKg : body.weightKg,
    allergies: body.allergies === undefined ? current.allergies : body.allergies,
    temperament:
      body.temperament === undefined ? current.temperament : body.temperament,
    photoUrl: body.photoUrl === undefined ? current.photoUrl : body.photoUrl,
    profileFlagsJson: flagsJson,
    updatedAt: nowSqlite(),
  };

  const [row] = await db
    .update(pets)
    .set(patch)
    .where(and(eq(pets.id, id), eq(pets.businessId, businessId)))
    .returning();

  if (!row) throw notFound('Mascota no encontrada');

  const changed = buildDiff(
    current as unknown as Record<string, unknown>,
    patch,
  );
  if (changed) {
    await recordOverrides(db, businessId, 'pet', id, Object.keys(changed));
  }

  await recordChange(
    db,
    {
      businessId,
      actorId: userId,
      action: 'pet.update',
      entity: 'pet',
      entityId: id,
    },
    current as unknown as Record<string, unknown>,
    patch,
  );

  const pending = await loadPendingFields(db, businessId);
  const photoToken = await signPhotoToken(
    c.env.JWT_SECRET,
    businessId,
    photoTtl(c.env),
  );
  return c.json({
    data: {
      ...withSize(row),
      photoUrl: resolvePhotoUrl(row, photoToken),
      completeness: petCompleteness(row, pending),
    },
  });
});

petRoutes.delete('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');
  const deletedAt = nowSqlite();

  const [row] = await db
    .update(pets)
    .set({ deletedAt, active: 0 })
    .where(
      and(
        eq(pets.id, id),
        eq(pets.businessId, businessId),
        isNull(pets.deletedAt),
      ),
    )
    .returning({ id: pets.id });

  if (!row) throw notFound('Mascota no encontrada');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'pet.delete',
    entity: 'pet',
    entityId: row.id,
    diff: { deletedAt: { from: null, to: deletedAt } },
  });

  return c.json({ data: { id: row.id, deleted: true } });
});

/**
 * Sube o reemplaza la foto principal. El binario nunca toca Turso: se guarda
 * en el adaptador de almacenamiento y en la ficha solo queda la clave.
 */
petRoutes.post('/:id/photo', async (c) => {
  requirePhotoStorage(c.env);
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const storage = c.get('storage');
  const id = c.req.param('id');

  const [pet] = await db
    .select()
    .from(pets)
    .where(
      and(eq(pets.id, id), eq(pets.businessId, businessId), isNull(pets.deletedAt)),
    )
    .limit(1);

  if (!pet) throw notFound('Mascota no encontrada');

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const validation = validateImage(
    bytes,
    c.req.header('content-type') ?? null,
    photoMaxBytes(c.env),
  );

  if (!validation.ok) {
    throw unprocessable(validation.reason, [{ path: 'photo', message: validation.reason }]);
  }

  const key = photoKeyFor(businessId, id, validation.extension);
  await storage.put(key, bytes, validation.type);

  let row: typeof pets.$inferSelect | undefined;
  try {
    [row] = await db
      .update(pets)
      .set({
        photoKey: key,
        photoMetaJson: JSON.stringify({
          contentType: validation.type,
          bytes: bytes.length,
          uploadedAt: nowSqlite(),
        }),
        photoUrl: null,
        updatedAt: nowSqlite(),
      })
      .where(and(eq(pets.id, id), eq(pets.businessId, businessId)))
      .returning();
  } catch (error) {
    // Turso no quedó con la referencia: se borra el objeto recién subido
    // para no dejar basura en R2.
    await storage.delete(key);
    throw error;
  }

  if (!row) {
    await storage.delete(key);
    throw notFound('Mascota no encontrada');
  }

  // La foto anterior se borra solo después de guardar la nueva.
  if (pet.photoKey && pet.photoKey !== key) {
    await storage.delete(pet.photoKey);
  }

  const pending = await loadPendingFields(db, businessId);
  const photoToken = await signPhotoToken(
    c.env.JWT_SECRET,
    businessId,
    photoTtl(c.env),
  );

  return c.json(
    {
      data: {
        ...withSize(row),
        photoUrl: resolvePhotoUrl(row, photoToken),
        completeness: petCompleteness(row, pending),
      },
    },
    201,
  );
});

petRoutes.delete('/:id/photo', async (c) => {
  requirePhotoStorage(c.env);
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const storage = c.get('storage');
  const id = c.req.param('id');

  const [pet] = await db
    .select()
    .from(pets)
    .where(
      and(eq(pets.id, id), eq(pets.businessId, businessId), isNull(pets.deletedAt)),
    )
    .limit(1);

  if (!pet) throw notFound('Mascota no encontrada');

  if (pet.photoKey) {
    await storage.delete(pet.photoKey);
  }

  const [row] = await db
    .update(pets)
    .set({
      photoKey: null,
      photoMetaJson: null,
      photoUrl: null,
      updatedAt: nowSqlite(),
    })
    .where(and(eq(pets.id, id), eq(pets.businessId, businessId)))
    .returning();

  if (!row) throw notFound('Mascota no encontrada');

  const pending = await loadPendingFields(db, businessId);
  return c.json({
    data: {
      ...withSize(row),
      photoUrl: null,
      completeness: petCompleteness(row, pending),
    },
  });
});

/**
 * Eliminación definitiva. No se permite sobre una mascota activa ni si tiene
 * historial: primero se desactiva (borrado lógico) y, cuando ya no queda nada
 * que conserve su historial, se puede purgar. En ese momento sí se borra la
 * fotografía de R2.
 */
petRoutes.delete('/:id/permanent', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const storage = c.get('storage');
  const id = c.req.param('id');

  const [pet] = await db
    .select()
    .from(pets)
    .where(and(eq(pets.id, id), eq(pets.businessId, businessId)))
    .limit(1);

  if (!pet) throw notFound('Mascota no encontrada');
  if (!pet.deletedAt) {
    throw conflict(
      'pet_active',
      'Primero desactiva la mascota; la eliminación definitiva es irreversible',
    );
  }

  const refs = await db.all<{
    appointments: number;
    sales: number;
    health: number;
    notes: number;
  }>(sql`
    SELECT
      (SELECT COUNT(*) FROM appointments WHERE pet_id = ${id} AND business_id = ${businessId}) AS appointments,
      (SELECT COUNT(*) FROM sale_items WHERE pet_id = ${id} AND business_id = ${businessId}) AS sales,
      (SELECT COUNT(*) FROM pet_health_records WHERE pet_id = ${id} AND business_id = ${businessId}) AS health,
      (SELECT COUNT(*) FROM pet_notes WHERE pet_id = ${id} AND business_id = ${businessId}) AS notes
  `);

  const counts = refs[0] ?? { appointments: 0, sales: 0, health: 0, notes: 0 };
  const total =
    Number(counts.appointments) +
    Number(counts.sales) +
    Number(counts.health) +
    Number(counts.notes);

  if (total > 0) {
    throw conflict(
      'pet_has_history',
      'La mascota tiene historial (citas, ventas o notas). Consérvala desactivada.',
      counts,
    );
  }

  if (pet.photoKey) {
    await storage.delete(pet.photoKey);
  }

  await db.delete(pets).where(and(eq(pets.id, id), eq(pets.businessId, businessId)));

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'pet.purge',
    entity: 'pet',
    entityId: id,
    diff: { permanent: { from: false, to: true } },
  });

  return c.json({ data: { id, deleted: true, permanent: true } });
});

export { sql };
