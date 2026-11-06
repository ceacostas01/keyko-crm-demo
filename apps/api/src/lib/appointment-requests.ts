import type { Db } from '@keyko/db';
import { appointmentRequests } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, eq, isNull } from 'drizzle-orm';
import { recordAudit } from './audit';

export type CreateAppointmentRequestInput = {
  extractionId: string;
  clientId: number | null;
  petId: string | null;
  contactKey: string;
  requestedService: string | null;
  requestedDate: string | null;
  requestedTime: string | null;
  startsAtLocal: string | null;
  durationMin?: number | null;
  notes?: string | null;
  confidence?: number | null;
};

/**
 * Crea una solicitud pendiente. No crea la cita: eso lo decide una persona o,
 * más adelante, una confirmación explícita. La extracción es la clave de
 * idempotencia para que reprocesar no duplique la solicitud.
 */
export async function ensureAppointmentRequest(
  db: Db,
  businessId: string,
  input: CreateAppointmentRequestInput,
): Promise<typeof appointmentRequests.$inferSelect | null> {
  const [existing] = await db
    .select()
    .from(appointmentRequests)
    .where(
      and(
        eq(appointmentRequests.businessId, businessId),
        eq(appointmentRequests.extractionId, input.extractionId),
      ),
    )
    .limit(1);

  if (existing) return existing;

  const [row] = await db
    .insert(appointmentRequests)
    .values({
      id: crypto.randomUUID(),
      businessId,
      extractionId: input.extractionId,
      clientId: input.clientId,
      petId: input.petId,
      contactKey: input.contactKey,
      requestedService: input.requestedService,
      requestedDate: input.requestedDate,
      requestedTime: input.requestedTime,
      startsAtLocal: input.startsAtLocal,
      durationMin: input.durationMin ?? null,
      notes: input.notes ?? null,
      confidence: input.confidence ?? null,
      status: 'pending',
      updatedAt: nowSqlite(),
    })
    .onConflictDoNothing()
    .returning();

  if (!row) return null;

  await recordAudit(db, {
    businessId,
    actorId: null,
    action: 'appointment_request.create',
    entity: 'appointment_request',
    entityId: row.id,
    diff: {
      request: { from: null, to: row.status },
      requestedDate: { from: null, to: row.startsAtLocal ?? row.requestedDate },
      contactKey: { from: null, to: row.contactKey },
    },
  });

  return row;
}


/** Vincula solicitudes pendientes del mismo contacto con la ficha creada. */
export async function linkPendingAppointmentRequests(
  db: Db,
  businessId: string,
  contactKey: string,
  links: { clientId?: number | null; petId?: string | null },
): Promise<void> {
  const patch = {
    ...(links.clientId == null ? {} : { clientId: links.clientId }),
    ...(links.petId == null ? {} : { petId: links.petId }),
    updatedAt: nowSqlite(),
  };
  if (Object.keys(patch).length === 1) return;

  await db
    .update(appointmentRequests)
    .set(patch)
    .where(
      and(
        eq(appointmentRequests.businessId, businessId),
        eq(appointmentRequests.contactKey, contactKey),
        eq(appointmentRequests.status, 'pending'),
        isNull(appointmentRequests.appointmentId),
      ),
    );
}
