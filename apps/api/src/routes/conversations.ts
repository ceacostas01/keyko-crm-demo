import {
  aiExtractions,
  aiJobs,
  aiProcessedMessages,
  clients,
  conversations,
  messageTranscriptions,
  pets,
  whatsappMessages,
} from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { recordAudit } from '../lib/audit';
import { aiConfig } from '../lib/ai/config';
import {
  audioFromRawMessage,
  downloadInboundAudio,
} from '../lib/ai/audio-media';
import {
  clientCompleteness,
  contactCompleteness,
  loadPendingFields,
} from '../lib/completeness';
import { notFound, unprocessable } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import {
  clientFor,
  lastMessages,
  messagesFor,
  syncConversations,
} from '../lib/whatsapp';
import { requireAuth } from '../middleware/auth';
import {
  conversationQuerySchema,
  transcriptionCorrectionSchema,
} from '../schemas';

/**
 * Consulta de conversaciones de WhatsApp.
 *
 * Solo lectura desde fuera: este módulo NUNCA escribe en whatsapp_events ni
 * en whatsapp_messages, no envía mensajes y no llama a ningún modelo de IA.
 * Lo único que materializa es la tabla `conversations`, derivada de los
 * mensajes que ya guardó el webhook.
 */
export const conversationRoutes = new Hono<AppEnv>();

conversationRoutes.use('*', requireAuth);

conversationRoutes.get('/', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const query = parse(conversationQuerySchema, c.req.query());

  const sync = await syncConversations(db, businessId);

  const filters: SQL[] = [eq(conversations.businessId, businessId)];
  if (query.status) filters.push(eq(conversations.status, query.status));

  const rows = await db
    .select()
    .from(conversations)
    .where(and(...filters))
    .orderBy(
      sql`COALESCE(${conversations.lastMessageAt}, ${conversations.createdAt}) DESC`,
    )
    .limit(query.limit)
    .offset(query.offset);

  const latest = await lastMessages(db, businessId);

  // Completitud: una carga para todos los clientes y mascotas de la bandeja.
  const pending = await loadPendingFields(db, businessId);
  const clientRows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.businessId, businessId), isNull(clients.deletedAt)));
  const clientById = new Map(clientRows.map((client) => [client.id, client]));

  const petRows = await db
    .select({ clientId: pets.clientId })
    .from(pets)
    .where(and(eq(pets.businessId, businessId), isNull(pets.deletedAt)));
  const petsByClient = new Map<number, number>();
  for (const pet of petRows) {
    petsByClient.set(pet.clientId, (petsByClient.get(pet.clientId) ?? 0) + 1);
  }

  const data = await Promise.all(
    rows.map(async (row) => {
      const lastMessage = latest.get(row.waContact) ?? null;
      const client = await clientFor(db, businessId, row.clientId);
      const stored = row.clientId ? clientById.get(row.clientId) : undefined;

      const completeness = stored
        ? clientCompleteness(stored, pending)
        : contactCompleteness(row.waContact);

      return {
        ...row,
        client,
        contactName: lastMessage?.contactName ?? null,
        lastMessage,
        completeness,
        hasPets: row.clientId
          ? (petsByClient.get(row.clientId) ?? 0) > 0
          : false,
        missing: completeness.priorities.slice(0, 2).map((field) => field.label),
      };
    }),
  );

  return c.json({
    data,
    pagination: { limit: query.limit, offset: query.offset, count: rows.length },
    meta: { sync },
  });
});

conversationRoutes.get('/:id', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const id = c.req.param('id');

  // Permite abrir una conversación recién llegada sin esperar a la bandeja.
  await syncConversations(db, businessId);

  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(eq(conversations.id, id), eq(conversations.businessId, businessId)),
    )
    .limit(1);

  if (!row) throw notFound('Conversación no encontrada');

  const [messages, client] = await Promise.all([
    messagesFor(db, businessId, row.id, row.waContact),
    clientFor(db, businessId, row.clientId),
  ]);

  const [aiState] = await db
    .select({
      processed: sql<number>`COUNT(DISTINCT ${aiProcessedMessages.messageId})`,
    })
    .from(aiProcessedMessages)
    .innerJoin(
      whatsappMessages,
      eq(whatsappMessages.messageId, aiProcessedMessages.messageId),
    )
    .where(
      and(
        eq(aiProcessedMessages.businessId, businessId),
        eq(whatsappMessages.businessId, businessId),
        eq(whatsappMessages.contactKey, row.waContact),
      ),
    );

  const [suggestionCount] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(aiExtractions)
    .innerJoin(aiJobs, eq(aiJobs.id, aiExtractions.sourceId))
    .where(
      and(
        eq(aiExtractions.businessId, businessId),
        eq(aiJobs.businessId, businessId),
        eq(aiJobs.waContact, row.waContact),
      ),
    );

  const [lastJob] = await db
    .select({ status: aiJobs.status, lastError: aiJobs.lastError })
    .from(aiJobs)
    .where(
      and(eq(aiJobs.businessId, businessId), eq(aiJobs.waContact, row.waContact)),
    )
    .orderBy(desc(aiJobs.createdAt))
    .limit(1);

  return c.json({
    data: {
      ...row,
      client,
      contactName: client?.name ?? messages.at(-1)?.contactName ?? null,
      lastMessage: messages.at(-1) ?? null,
      messages,
      ai: {
        processedMessages: Number(aiState?.processed ?? 0),
        suggestions: Number(suggestionCount?.n ?? 0),
        lastJobStatus: lastJob?.status ?? null,
        lastError: lastJob?.lastError ?? null,
      },
    },
  });
});

async function messageInConversation(
  db: AppEnv['Variables']['db'],
  businessId: string,
  conversationId: string,
  messageId: string,
): Promise<{
  conversation: typeof conversations.$inferSelect;
  message: typeof whatsappMessages.$inferSelect;
}> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.businessId, businessId),
      ),
    )
    .limit(1);

  if (!conversation) throw notFound('Conversación no encontrada');

  const [message] = await db
    .select()
    .from(whatsappMessages)
    .where(
      and(
        eq(whatsappMessages.businessId, businessId),
        eq(whatsappMessages.messageId, messageId),
        or(
          eq(whatsappMessages.conversationId, conversationId),
          eq(whatsappMessages.contactKey, conversation.waContact),
        ),
      ),
    )
    .limit(1);

  if (!message) throw notFound('Mensaje no encontrado');
  return { conversation, message };
}

async function requeueJobForMessage(
  db: AppEnv['Variables']['db'],
  businessId: string,
  messageId: string,
): Promise<void> {
  const jobs = await db
    .select({ id: aiJobs.id, status: aiJobs.status })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.businessId, businessId),
        sql`instr(${aiJobs.messageIds}, ${messageId}) > 0`,
      ),
    );

  for (const job of jobs) {
    if (job.status !== 'done' && job.status !== 'failed') continue;
    await db
      .update(aiJobs)
      .set({
        status: 'pending',
        attempts: 0,
        lastError: null,
        updatedAt: nowSqlite(),
      })
      .where(and(eq(aiJobs.id, job.id), eq(aiJobs.businessId, businessId)));
  }
}

function serializeTranscription(
  row: typeof messageTranscriptions.$inferSelect,
) {
  const text = row.manualTranscript?.trim() || row.transcript?.trim() || null;
  return {
    status: row.status,
    text,
    originalText: row.transcript,
    error: row.lastError,
    attempts: row.attempts,
    durationSeconds: row.durationSeconds,
    costUsdMicros: row.costUsdMicros,
    model: row.model,
    correctedAt: row.correctedAt,
  };
}

/**
 * Sirve el audio desde Kapso sin exponer la URL privada en el navegador.
 * No se almacena en R2 ni en Turso.
 */
conversationRoutes.get('/:id/messages/:messageId/audio', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const { message } = await messageInConversation(
    db,
    businessId,
    c.req.param('id'),
    c.req.param('messageId'),
  );

  const audio = audioFromRawMessage(
    message.messageId,
    message.messageType,
    message.rawMessageJson,
  );
  if (!audio) throw notFound('El audio ya no está disponible');

  const config = aiConfig(c.env);
  const loaded = await downloadInboundAudio(audio, {
    maxBytes: config.transcriptionMaxBytes,
  });
  if (!loaded) throw notFound('El audio ya no está disponible');

  const binary = atob(loaded.base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Response(bytes, {
    headers: {
      'content-type': loaded.mimeType,
      'content-length': String(loaded.byteLength),
      'cache-control': 'private, no-store',
    },
  });
});

/** Corrección humana de una transcripción. Queda auditada. */
conversationRoutes.patch(
  '/:id/messages/:messageId/transcription',
  async (c) => {
    const { businessId, userId } = c.get('auth');
    const db = c.get('db');
    const body = parse(
      transcriptionCorrectionSchema,
      await readJson(c),
    );
    const { message } = await messageInConversation(
      db,
      businessId,
      c.req.param('id'),
      c.req.param('messageId'),
    );

    if (
      message.messageType !== 'audio' &&
      message.messageType !== 'voice' &&
      message.messageType !== 'ptt'
    ) {
      throw unprocessable('El mensaje no es un audio');
    }

    const [current] = await db
      .select()
      .from(messageTranscriptions)
      .where(
        and(
          eq(messageTranscriptions.businessId, businessId),
          eq(messageTranscriptions.messageId, message.messageId),
        ),
      )
      .limit(1);

    const now = nowSqlite();
    const [updated] = await db
      .insert(messageTranscriptions)
      .values({
        id: crypto.randomUUID(),
        businessId,
        messageId: message.messageId,
        status: 'completed',
        provider: 'manual',
        manualTranscript: body.text,
        correctedAt: now,
        correctedBy: userId,
        transcribedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messageTranscriptions.businessId,
          messageTranscriptions.messageId,
        ],
        set: {
          status: 'completed',
          manualTranscript: body.text,
          correctedAt: now,
          correctedBy: userId,
          lastError: null,
          updatedAt: now,
        },
      })
      .returning();

    // El texto corregido debe poder reutilizarse en la siguiente extracción.
    await db
      .delete(aiProcessedMessages)
      .where(
        and(
          eq(aiProcessedMessages.businessId, businessId),
          eq(aiProcessedMessages.messageId, message.messageId),
        ),
      );

    await requeueJobForMessage(db, businessId, message.messageId);

    // Las sugerencias pendientes que citaban esta transcripción quedan
    // reemplazadas por la nueva extracción; así no se duplican.
    const pendingSuggestions = await db
      .select({
        id: aiExtractions.id,
        parsedJson: aiExtractions.parsedJson,
      })
      .from(aiExtractions)
      .where(
        and(
          eq(aiExtractions.businessId, businessId),
          eq(aiExtractions.status, 'pending'),
        ),
      );

    for (const suggestion of pendingSuggestions) {
      if (!suggestion.parsedJson?.includes(message.messageId)) continue;
      await db
        .update(aiExtractions)
        .set({
          status: 'rejected',
          reviewedAt: now,
          reviewedBy: userId,
        })
        .where(eq(aiExtractions.id, suggestion.id));
    }

    await recordAudit(db, {
      businessId,
      actorId: userId,
      action: 'transcription.correct',
      entity: 'message',
      entityId: message.messageId,
      diff: {
        transcription: {
          from: current?.manualTranscript ?? current?.transcript ?? null,
          to: body.text,
        },
      },
    });

    return c.json({ data: updated ? serializeTranscription(updated) : null });
  },
);

/** Permite reintentar una transcripción fallida o expirada. */
conversationRoutes.post(
  '/:id/messages/:messageId/transcription/retry',
  async (c) => {
    const { businessId } = c.get('auth');
    const db = c.get('db');
    const { message } = await messageInConversation(
      db,
      businessId,
      c.req.param('id'),
      c.req.param('messageId'),
    );

    if (
      message.messageType !== 'audio' &&
      message.messageType !== 'voice' &&
      message.messageType !== 'ptt'
    ) {
      throw unprocessable('El mensaje no es un audio');
    }

    const now = nowSqlite();
    const [updated] = await db
      .insert(messageTranscriptions)
      .values({
        id: crypto.randomUUID(),
        businessId,
        messageId: message.messageId,
        status: 'pending',
        provider: 'openrouter',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          messageTranscriptions.businessId,
          messageTranscriptions.messageId,
        ],
        set: {
          status: 'pending',
          attempts: 0,
          lastError: null,
          updatedAt: now,
        },
      })
      .returning();

    await db
      .delete(aiProcessedMessages)
      .where(
        and(
          eq(aiProcessedMessages.businessId, businessId),
          eq(aiProcessedMessages.messageId, message.messageId),
        ),
      );

    await requeueJobForMessage(db, businessId, message.messageId);

    return c.json({ data: updated ? serializeTranscription(updated) : null });
  },
);
