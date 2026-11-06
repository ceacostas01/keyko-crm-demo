import type { Db } from '@keyko/db';
import {
  aiExtractions,
  aiJobs,
  clients,
  pets,
} from '@keyko/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { nowSqlite } from '@keyko/domain';
import { recordAudit } from '../audit';
import { clearUnknownNameIfNamed } from '../completeness';
import {
  ensureAppointmentRequest,
  linkPendingAppointmentRequests,
} from '../appointment-requests';
import { overriddenFields, recordOverrides } from '../overrides';
import type { SuggestionField, SuggestionPayload } from './apply';
import {
  createClientFromFields,
  createPetFromFields,
  usableWhatsappName,
} from './apply';

export type AcceptResult = {
  targetEntity: string | null;
  targetId: string | null;
};

type ExtractionRow = typeof aiExtractions.$inferSelect;

function applyCorrections(
  fields: SuggestionField[],
  corrections: Record<string, unknown> | undefined,
): SuggestionField[] {
  if (!corrections) return fields;

  return fields.map((field) =>
    Object.prototype.hasOwnProperty.call(corrections, field.field)
      ? { ...field, value: corrections[field.field], confidence: 1, conflict: false }
      : field,
  );
}

function valueOf(fields: SuggestionField[], name: string): unknown {
  return fields.find((field) => field.field === name)?.value ?? null;
}

function stripQuotes(parsedJson: string | null): string | null {
  if (!parsedJson) return null;
  try {
    const parsed = JSON.parse(parsedJson) as {
      fields?: Array<Record<string, unknown>>;
      pets?: Array<{ fields?: Array<Record<string, unknown>> }>;
    };

    return JSON.stringify({
      ...parsed,
      fields: (parsed.fields ?? []).map((field) => ({ ...field, quotes: [] })),
      pets: (parsed.pets ?? []).map((pet) => ({
        ...pet,
        fields: (pet.fields ?? []).map((field) => ({ ...field, quotes: [] })),
      })),
    });
  } catch {
    return parsedJson;
  }
}

/**
 * Nombre de perfil del contacto en WhatsApp. Se lee del último mensaje que
 * tenga nombre, porque la ficha pudo crearse después de varios mensajes.
 */
async function whatsappNameFor(
  db: Db,
  businessId: string,
  contactKey: string,
): Promise<string | null> {
  const rows = await db.all<{ contact_name: string | null }>(sql`
    SELECT contact_name
      FROM whatsapp_messages
     WHERE business_id = ${businessId}
       AND contact_key = ${contactKey}
       AND contact_name IS NOT NULL
       AND contact_name <> ''
     ORDER BY COALESCE(message_timestamp, received_at) DESC
     LIMIT 1
  `);

  return usableWhatsappName(
    rows[0]?.contact_name === undefined
      ? null
      : String(rows[0].contact_name),
  );
}

async function markReviewed(
  db: Db,
  extraction: ExtractionRow,
  status: 'applied' | 'validated',
  targetEntity: string | null,
  targetId: string | null,
  userId: string,
): Promise<void> {
  await db
    .update(aiExtractions)
    .set({
      status,
      targetEntity,
      targetId,
      reviewedBy: userId,
      reviewedAt: nowSqlite(),
      // Al revisar se descartan las citas textuales: quedan los ids de los
      // mensajes, que es la referencia mínima sin duplicar datos personales.
      parsedJson: stripQuotes(extraction.parsedJson),
    })
    .where(
      and(
        eq(aiExtractions.id, extraction.id),
        eq(aiExtractions.businessId, extraction.businessId),
      ),
    );
}

/**
 * Aplica una sugerencia con las correcciones que haya hecho la persona.
 * Los campos corregidos quedan marcados como manuales para que la IA no los
 * vuelva a tocar.
 */
export async function acceptSuggestion(input: {
  db: Db;
  businessId: string;
  extraction: ExtractionRow;
  corrections?: Record<string, unknown>;
  petCorrections?: Array<Record<string, unknown>>;
  userId: string;
}): Promise<AcceptResult> {
  const { db, businessId, extraction, userId } = input;

  const payload = extraction.parsedJson
    ? (JSON.parse(extraction.parsedJson) as SuggestionPayload)
    : null;

  if (!payload) return { targetEntity: null, targetId: null };

  const fields = applyCorrections(payload.fields, input.corrections);
  const corrected = new Set(
    input.corrections ? Object.keys(input.corrections) : [],
  );

  switch (payload.kind) {
    case 'client_create': {
      // El contacto sale del job, que es quien conoce el WhatsApp real.
      const [job] = await db
        .select({ waContact: aiJobs.waContact })
        .from(aiJobs)
        .where(
          and(
            eq(aiJobs.id, extraction.sourceId),
            eq(aiJobs.businessId, businessId),
          ),
        )
        .limit(1);

      const contactKey = job?.waContact ?? `ai:${extraction.id}`;
      const whatsappName = await whatsappNameFor(db, businessId, contactKey);

      // Si el cliente ya existe (p. ej. dos sugerencias del mismo contacto),
      // se completa en vez de crear un duplicado.
      const [existingClient] = await db
        .select()
        .from(clients)
        .where(
          and(
            eq(clients.businessId, businessId),
            eq(clients.whatsappContactKey, contactKey),
          ),
        )
        .limit(1);

      if (existingClient) {
        const overrides = await overriddenFields(
          db,
          businessId,
          'client',
          String(existingClient.id),
        );
        const current = existingClient as unknown as Record<string, unknown>;
        const patch: Record<string, unknown> = {};

        for (const field of fields) {
          if (overrides.has(field.field) && !corrected.has(field.field)) continue;
          const value = current[field.field];
          if (
            !corrected.has(field.field) &&
            value !== null &&
            value !== undefined &&
            value !== ''
          ) {
            continue;
          }
          patch[field.field] = field.value;
        }

        if (
          whatsappName &&
          existingClient.whatsappName !== whatsappName
        ) {
          patch.whatsappName = whatsappName;
        }

        if (Object.keys(patch).length > 0) {
          await db
            .update(clients)
            .set({ ...patch, updatedAt: nowSqlite() })
            .where(
              and(
                eq(clients.id, existingClient.id),
                eq(clients.businessId, businessId),
              ),
            );
        }

        await linkPendingAppointmentRequests(db, businessId, contactKey, {
          clientId: existingClient.id,
        });
        await markReviewed(
          db,
          extraction,
          'applied',
          'client',
          String(existingClient.id),
          userId,
        );
        const clearedName = fields.some((field) => field.field === 'fullName')
          ? await clearUnknownNameIfNamed(db, businessId, existingClient.id)
          : false;
        await auditApply(
          db,
          businessId,
          userId,
          extraction,
          payload,
          fields,
          corrected,
          'client',
          String(existingClient.id),
          clearedName,
        );
        return { targetEntity: 'client', targetId: String(existingClient.id) };
      }

      const created = await createClientFromFields(
        db,
        businessId,
        fields,
        contactKey,
        { whatsappName },
      );

      let firstPetId: string | null = null;
      for (const [index, pet] of (payload.pets ?? []).entries()) {
        const createdPetId = await createPetFromFields(
          db,
          businessId,
          created.id,
          applyCorrections(pet.fields, input.petCorrections?.[index]),
        );
        firstPetId ??= createdPetId;
      }

      await linkPendingAppointmentRequests(db, businessId, contactKey, {
        clientId: created.id,
        petId: firstPetId,
      });

      if (corrected.size > 0) {
        await recordOverrides(db, businessId, 'client', String(created.id), [
          ...corrected,
        ]);
      }

      await markReviewed(db, extraction, 'applied', 'client', String(created.id), userId);
      await auditApply(db, businessId, userId, extraction, payload, fields, corrected, 'client', String(created.id));
      return { targetEntity: 'client', targetId: String(created.id) };
    }

    case 'client_update':
    case 'conversation_note': {
      const clientId = payload.clientId;
      if (!clientId) return { targetEntity: null, targetId: null };

      const [client] = await db
        .select()
        .from(clients)
        .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)))
        .limit(1);
      if (!client) return { targetEntity: null, targetId: null };

      const overrides = await overriddenFields(db, businessId, 'client', String(clientId));
      const current = client as unknown as Record<string, unknown>;
      const patch: Record<string, unknown> = {};

      for (const field of fields) {
        const isCorrected = corrected.has(field.field);
        if (overrides.has(field.field) && !isCorrected) continue;
        const existingValue = current[field.field];
        if (!isCorrected && existingValue !== null && existingValue !== '') continue;
        patch[field.field] = field.value;
      }

      if (Object.keys(patch).length > 0) {
        await db
          .update(clients)
          .set({ ...patch, updatedAt: nowSqlite() })
          .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)));
        if (corrected.size > 0) {
          await recordOverrides(db, businessId, 'client', String(clientId), [
            ...corrected,
          ]);
        }
      }

      await markReviewed(db, extraction, 'applied', 'client', String(clientId), userId);
      const clearedName = fields.some((field) => field.field === 'fullName')
        ? await clearUnknownNameIfNamed(db, businessId, clientId)
        : false;
      await auditApply(
        db,
        businessId,
        userId,
        extraction,
        payload,
        fields,
        corrected,
        'client',
        String(clientId),
        clearedName,
      );
      return { targetEntity: 'client', targetId: String(clientId) };
    }

    case 'pet_create': {
      const clientId = payload.clientId;
      if (!clientId) return { targetEntity: null, targetId: null };

      const petId = await createPetFromFields(db, businessId, clientId, fields);

      if (petId) {
        await linkPendingAppointmentRequests(
          db,
          businessId,
          payload.contactKey ?? `ai:${extraction.id}`,
          { clientId, petId },
        );
      }

      if (petId && corrected.size > 0) {
        await recordOverrides(db, businessId, 'pet', petId, [...corrected]);
      }

      await markReviewed(db, extraction, 'applied', 'pet', petId, userId);
      if (petId) {
        await auditApply(db, businessId, userId, extraction, payload, fields, corrected, 'pet', petId);
      }
      return { targetEntity: 'pet', targetId: petId };
    }

    case 'pet_update': {
      const petId = payload.petId;
      if (!petId) return { targetEntity: null, targetId: null };

      const [pet] = await db
        .select()
        .from(pets)
        .where(and(eq(pets.id, petId), eq(pets.businessId, businessId)))
        .limit(1);
      if (!pet) return { targetEntity: null, targetId: null };

      const overrides = await overriddenFields(db, businessId, 'pet', petId);
      const current = pet as unknown as Record<string, unknown>;
      const patch: Record<string, unknown> = {};

      for (const field of fields) {
        const isCorrected = corrected.has(field.field);
        if (overrides.has(field.field) && !isCorrected) continue;
        const existingValue = current[field.field];
        if (!isCorrected && existingValue !== null && existingValue !== '') continue;
        patch[field.field] = field.value;
      }

      if (Object.keys(patch).length > 0) {
        await db
          .update(pets)
          .set({ ...patch, updatedAt: nowSqlite() })
          .where(and(eq(pets.id, petId), eq(pets.businessId, businessId)));
        if (corrected.size > 0) {
          await recordOverrides(db, businessId, 'pet', petId, [...corrected]);
        }
      }

      await markReviewed(db, extraction, 'applied', 'pet', petId, userId);
      if (petId) {
        await linkPendingAppointmentRequests(
          db,
          businessId,
          payload.contactKey ?? `ai:${extraction.id}`,
          { petId },
        );
        await auditApply(db, businessId, userId, extraction, payload, fields, corrected, 'pet', petId);
      }
      return { targetEntity: 'pet', targetId: petId };
    }

    case 'appointment_request': {
      const conversation = payload.conversation;
      if (!conversation) {
        await markReviewed(db, extraction, 'validated', 'appointment', null, userId);
        return { targetEntity: 'appointment', targetId: null };
      }

      const request = await ensureAppointmentRequest(db, businessId, {
        extractionId: extraction.id,
        clientId: payload.clientId,
        petId: payload.petId,
        contactKey: payload.contactKey ?? `ai:${extraction.id}`,
        requestedService: conversation.requestedService,
        requestedDate: conversation.requestedDate,
        requestedTime: conversation.requestedTime,
        startsAtLocal: conversation.resolvedStart,
        notes: conversation.notes,
        confidence: extraction.confidence,
      });

      await markReviewed(
        db,
        extraction,
        'applied',
        'appointment_request',
        request?.id ?? null,
        userId,
      );

      await recordAudit(db, {
        businessId,
        actorId: userId,
        action: 'ai.apply',
        entity: 'appointment_request',
        entityId: request?.id ?? extraction.id,
        diff: {
          kind: { from: null, to: 'appointment_request' },
          extractionId: { from: null, to: extraction.id },
          startsAtLocal: {
            from: null,
            to: conversation.resolvedStart ?? conversation.requestedDate,
          },
        },
      });

      return { targetEntity: 'appointment_request', targetId: request?.id ?? null };
    }

    case 'availability_inquiry':
    case 'service_inquiry': {
      // Nunca crean la cita: solo dejan constancia de que se revisaron.
      await markReviewed(db, extraction, 'validated', 'appointment', null, userId);
      return { targetEntity: 'appointment', targetId: null };
    }

    default:
      return { targetEntity: null, targetId: null };
  }
}

async function auditApply(
  db: Db,
  businessId: string,
  userId: string,
  extraction: ExtractionRow,
  payload: SuggestionPayload,
  fields: SuggestionField[],
  corrected: Set<string>,
  entity: 'client' | 'pet',
  entityId: string,
  nameUnknownCleared = false,
): Promise<void> {
  await recordAudit(db, {
    businessId,
    actorId: userId,
    action: 'ai.apply',
    entity,
    entityId,
    diff: {
      kind: { from: null, to: payload.kind },
      extractionId: { from: null, to: extraction.id },
      fields: { from: null, to: fields.map((field) => field.field).join(',') },
      corrected: { from: null, to: corrected.size > 0 },
      ...(nameUnknownCleared
        ? { nameUnknown: { from: true, to: false } }
        : {}),
    },
  });
}

export async function rejectSuggestion(input: {
  db: Db;
  businessId: string;
  extractionId: string;
  userId: string;
}): Promise<boolean> {
  const [updated] = await input.db
    .update(aiExtractions)
    .set({
      status: 'rejected',
      reviewedBy: input.userId,
      reviewedAt: nowSqlite(),
    })
    .where(
      and(
        eq(aiExtractions.id, input.extractionId),
        eq(aiExtractions.businessId, input.businessId),
        eq(aiExtractions.status, 'pending'),
      ),
    )
    .returning({ id: aiExtractions.id });

  return Boolean(updated);
}
