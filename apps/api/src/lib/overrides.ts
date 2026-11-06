import type { Db } from '@keyko/db';
import { fieldOverrides } from '@keyko/db';
import { and, eq } from 'drizzle-orm';

/**
 * Campos que una persona editó a mano.
 *
 * La IA nunca los sobrescribe, ni siquiera si llega con más confianza.
 * Se registran desde los PATCH de clientes y mascotas.
 */
export type OverrideEntity = 'client' | 'pet';

export async function recordOverrides(
  db: Db,
  businessId: string,
  entity: OverrideEntity,
  entityId: string,
  fields: readonly string[],
): Promise<void> {
  const unique = [...new Set(fields)];
  if (unique.length === 0) return;

  for (const field of unique) {
    await db
      .insert(fieldOverrides)
      .values({ businessId, entity, entityId, field })
      .onConflictDoUpdate({
        target: [
          fieldOverrides.businessId,
          fieldOverrides.entity,
          fieldOverrides.entityId,
          fieldOverrides.field,
        ],
        set: { updatedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') },
      });
  }
}

export async function overriddenFields(
  db: Db,
  businessId: string,
  entity: OverrideEntity,
  entityId: string,
): Promise<Set<string>> {
  const rows = await db
    .select({ field: fieldOverrides.field })
    .from(fieldOverrides)
    .where(
      and(
        eq(fieldOverrides.businessId, businessId),
        eq(fieldOverrides.entity, entity),
        eq(fieldOverrides.entityId, entityId),
      ),
    );

  return new Set(rows.map((row) => row.field));
}
