import { clients, pets } from '@keyko/db';
import {
  CLIENT_PROFILE,
  isPlaceholderName,
  normalizePhone,
  nowSqlite,
  validateProfileFlags,
} from '@keyko/domain';
import { and, desc, eq, isNull, like, or, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { buildDiff, recordAudit, recordChange } from '../lib/audit';
import {
  clientCompleteness,
  loadPendingFields,
  withoutUnknownName,
} from '../lib/completeness';
import { conflict, isUniqueViolation, notFound, unprocessable } from '../lib/errors';
import { parse, parseId, readJson } from '../lib/http';
import { recordOverrides } from '../lib/overrides';
import { requireAuth } from '../middleware/auth';
import {
  clientCreateSchema,
  clientQuerySchema,
  clientUpdateSchema,
} from '../schemas';

export const clientRoutes = new Hono<AppEnv>();

clientRoutes.use('*', requireAuth);

function serialize(row: typeof clients.$inferSelect) {
  const { extraJson, ...rest } = row;
  return {
    ...rest,
    extra: extraJson ? (JSON.parse(extraJson) as unknown) : null,
  };
}

function phoneDigits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

function looksLikePhone(value: string | null | undefined): boolean {
  return /^\+?\d{8,15}$/.test((value ?? '').trim());
}

function normalizeOrThrow(raw: string): string {
  try {
    return normalizePhone(raw);
  } catch {
    throw unprocessable('Teléfono inválido', [
      { path: 'phone', message: 'No es un teléfono válido' },
    ]);
  }
}

clientRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const { limit, offset, search } = parse(clientQuerySchema, c.req.query());

  const filters: SQL[] = [
    eq(clients.businessId, businessId),
    isNull(clients.deletedAt),
  ];

  if (search) {
    const term = `%${search}%`;
    const match = or(
      like(clients.fullName, term),
      like(clients.whatsappName, term),
      like(clients.phone, term),
    );
    if (match) filters.push(match);
  }

  const rows = await db
    .select()
    .from(clients)
    .where(and(...filters))
    .orderBy(desc(clients.createdAt))
    .limit(limit)
    .offset(offset);

  const pending = await loadPendingFields(db, businessId);

  return c.json({
    data: rows.map((row) => ({
      ...serialize(row),
      completeness: clientCompleteness(row, pending),
    })),
    pagination: { limit, offset, count: rows.length },
  });
});

clientRoutes.post('/', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const body = parse(clientCreateSchema, await readJson(c));
  const phone = normalizeOrThrow(body.phone);

  // El chequeo previo da un mensaje claro. Se comparan dígitos, no el texto:
  // un cliente pudo entrar por WhatsApp con BSUID y otro teléfono formateado.
  const phoneDigitsValue = phoneDigits(phone);
  const existingClients = await db
    .select()
    .from(clients)
    .where(and(eq(clients.businessId, businessId), isNull(clients.deletedAt)));

  const duplicate = existingClients.find(
    (row) =>
      phoneDigits(row.phone) === phoneDigitsValue ||
      (looksLikePhone(row.whatsappContactKey) &&
        phoneDigits(row.whatsappContactKey) === phoneDigitsValue),
  );

  if (duplicate) {
    throw conflict(
      'duplicate_client',
      'Ya existe un cliente con ese teléfono. Búscalo en la lista para evitar duplicados.',
    );
  }

  let row: typeof clients.$inferSelect | undefined;
  try {
    [row] = await db
      .insert(clients)
      .values({
        businessId,
        whatsappContactKey: phone,
        phone,
        fullName: body.fullName,
        email: body.email ?? null,
        notes: body.notes ?? null,
        extraJson: body.extra ? JSON.stringify(body.extra) : null,
        source: body.source ?? 'manual',
        consentMarketing: body.consentMarketing ? 1 : 0,
      })
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('duplicate_client', 'Ya existe un cliente con ese teléfono');
    }
    throw error;
  }

  if (!row) throw unprocessable('No se pudo crear el cliente');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'client.create',
    entity: 'client',
    entityId: String(row.id),
    diff: { fullName: { from: null, to: row.fullName } },
  });

  const pending = await loadPendingFields(db, businessId);
  return c.json(
    { data: { ...serialize(row), completeness: clientCompleteness(row, pending) } },
    201,
  );
});

clientRoutes.get('/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = parseId(c.req.param('id'));

  const [row] = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.id, id),
        eq(clients.businessId, businessId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);

  if (!row) throw notFound('Cliente no encontrado');

  const petRows = await db
    .select()
    .from(pets)
    .where(
      and(
        eq(pets.clientId, id),
        eq(pets.businessId, businessId),
        isNull(pets.deletedAt),
      ),
    );

  const pending = await loadPendingFields(db, businessId);

  return c.json({
    data: {
      ...serialize(row),
      pets: petRows,
      petsCount: petRows.length,
      completeness: clientCompleteness(row, pending),
    },
  });
});

clientRoutes.patch('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = parseId(c.req.param('id'));
  const body = parse(clientUpdateSchema, await readJson(c));

  const [current] = await db
    .select()
    .from(clients)
    .where(
      and(
        eq(clients.id, id),
        eq(clients.businessId, businessId),
        isNull(clients.deletedAt),
      ),
    )
    .limit(1);

  if (!current) throw notFound('Cliente no encontrado');

  let phone = current.phone;
  let contactKey = current.whatsappContactKey;

  if (body.phone !== undefined) {
    const normalized = normalizeOrThrow(body.phone);
    const normalizedDigits = phoneDigits(normalized);
    const existingClients = await db
      .select()
      .from(clients)
      .where(and(eq(clients.businessId, businessId), isNull(clients.deletedAt)));

    const duplicate = existingClients.find(
      (row) =>
        row.id !== id &&
        (phoneDigits(row.phone) === normalizedDigits ||
          (looksLikePhone(row.whatsappContactKey) &&
            phoneDigits(row.whatsappContactKey) === normalizedDigits)),
    );
    if (duplicate) {
      throw conflict(
        'duplicate_client',
        'Ya existe un cliente con ese teléfono. Búscalo en la lista para evitar duplicados.',
      );
    }
    phone = normalized;
    contactKey = normalized;
  }

  let flagsJson = current.profileFlagsJson;
  let nameUnknownCleared = false;

  // Un nombre válido confirma la identidad: se retira la marca de desconocido.
  if (body.fullName !== undefined && !isPlaceholderName(body.fullName)) {
    const cleaned = withoutUnknownName(flagsJson);
    flagsJson = cleaned.json;
    nameUnknownCleared = cleaned.cleared;
  }

  if (body.profileFlags !== undefined) {
    const validation = validateProfileFlags(
      'client',
      body.profileFlags,
      CLIENT_PROFILE.map((field) => field.key),
    );
    if (validation.invalid.length > 0) {
      throw unprocessable('Marcas no válidas para un cliente', [
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
    phone,
    whatsappContactKey: contactKey,
    fullName: body.fullName ?? current.fullName,
    email: body.email === undefined ? current.email : body.email,
    notes: body.notes === undefined ? current.notes : body.notes,
    extraJson:
      body.extra === undefined
        ? current.extraJson
        : body.extra === null
          ? null
          : JSON.stringify(body.extra),
    source: body.source ?? current.source,
    consentMarketing:
      body.consentMarketing === undefined
        ? current.consentMarketing
        : body.consentMarketing
          ? 1
          : 0,
    profileFlagsJson: flagsJson,
    updatedAt: nowSqlite(),
  };

  let row: typeof clients.$inferSelect | undefined;
  try {
    [row] = await db
      .update(clients)
      .set(patch)
      .where(and(eq(clients.id, id), eq(clients.businessId, businessId)))
      .returning();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw conflict('duplicate_client', 'Ya existe un cliente con ese teléfono');
    }
    throw error;
  }

  if (!row) throw notFound('Cliente no encontrado');

  const changed = buildDiff(
    current as unknown as Record<string, unknown>,
    patch,
  );
  if (changed) {
    await recordOverrides(
      db,
      businessId,
      'client',
      String(id),
      Object.keys(changed),
    );
  }

  await recordChange(
    db,
    {
      businessId,
      actorId: userId,
      action: 'client.update',
      entity: 'client',
      entityId: String(id),
    },
    current as unknown as Record<string, unknown>,
    patch,
  );

  if (nameUnknownCleared) {
    await recordAudit(db, {
      businessId,
      actorId: userId,
      action: 'client.update',
      entity: 'client',
      entityId: String(id),
      diff: { nameUnknown: { from: true, to: false } },
    });
  }

  const pending = await loadPendingFields(db, businessId);
  return c.json({
    data: { ...serialize(row), completeness: clientCompleteness(row, pending) },
  });
});

clientRoutes.delete('/:id', async (c) => {
  const { businessId, userId } = c.get('auth');
  const db = c.get('db');
  const id = parseId(c.req.param('id'));
  const deletedAt = nowSqlite();

  const [row] = await db
    .update(clients)
    .set({ deletedAt })
    .where(
      and(
        eq(clients.id, id),
        eq(clients.businessId, businessId),
        isNull(clients.deletedAt),
      ),
    )
    .returning({ id: clients.id });

  if (!row) throw notFound('Cliente no encontrado');

  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'client.delete',
    entity: 'client',
    entityId: String(row.id),
    diff: { deletedAt: { from: null, to: deletedAt } },
  });

  return c.json({ data: { id: row.id, deleted: true } });
});
