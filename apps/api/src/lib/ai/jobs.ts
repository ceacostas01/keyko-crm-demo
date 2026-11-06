import type { Db } from '@keyko/db';
import {
  aiJobs,
  aiProcessedMessages,
  aiUsage,
  whatsappMessages,
} from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, asc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { syncConversations } from '../whatsapp';
import { applyExtraction, guardExtraction, type ApplyInput } from './apply';
import {
  aggregateAndPruneUsage,
  budgetState,
  pruneAiData,
  pruneReviewedSuggestions,
  registerBudgetAlerts,
  spendFor,
} from './budget';
import type { AiConfig } from './config';
import type { AiMessage, AiProvider, ProviderUsage } from './fake';
import {
  downloadInboundImage,
  imageFromRawMessage,
  type InboundImage,
  type LoadedImage,
} from './media';
import {
  bodyForAudio,
  pruneTranscriptions,
  transcribeAudioMessages,
} from './transcriptions';
import type { InboundAudio, LoadedAudio } from './audio-media';
import { getProvider } from './provider';

export type ProcessResult = {
  enqueued: number;
  processed: number;
  failed: number;
  skipped: number;
  suggestions: number;
  applied: number;
  reason: string | null;
};

const BATCH_SIZE = 20;
const MAX_MESSAGES_PER_RUN = 240;
const encoder = new TextEncoder();

/** Registra una llamada auxiliar (verificador o visión) en `ai_usage`. */
async function recordUsage(
  db: Db,
  businessId: string,
  usage: ProviderUsage | null,
  error?: string,
): Promise<void> {
  await db.insert(aiUsage).values({
    id: crypto.randomUUID(),
    businessId,
    extractionId: null,
    model: usage?.model ?? 'ai-aux',
    tokensIn: usage?.tokensIn ?? 0,
    tokensOut: usage?.tokensOut ?? 0,
    costUsdMicros: usage?.costUsdMicros ?? 0,
    latencyMs: usage?.latencyMs ?? null,
    ...(error ? { error: error.slice(0, 300) } : {}),
    createdAt: nowSqlite(),
  });
}

/**
 * Id determinista del lote: dos procesos que intenten encolar los mismos
 * mensajes a la vez chocan con la PK y solo uno crea el job.
 */
async function batchJobId(
  businessId: string,
  messageIds: string[],
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(`${businessId}\n${[...messageIds].sort().join('\n')}`),
  );
  return `ai-${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Agrupa mensajes nuevos por contacto en lotes pequeños. */
export async function enqueueAiJobs(
  db: Db,
  businessId: string,
  options: { since?: string | null; contactKeys?: string[] } = {},
): Promise<{ created: number; messages: number }> {
  await syncConversations(db, businessId);

  const filters = [
    eq(whatsappMessages.businessId, businessId),
    sql`${whatsappMessages.contactKey} IS NOT NULL`,
    sql`${whatsappMessages.contactKey} <> ''`,
    notInArray(
      whatsappMessages.messageId,
      db
        .select({ id: aiProcessedMessages.messageId })
        .from(aiProcessedMessages)
        .where(eq(aiProcessedMessages.businessId, businessId)),
    ),
  ];
  if (options.since) {
    const sinceSql = new Date(options.since)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');
    // Se compara la fecha real del mensaje, no la fecha en que se importó.
    // Así el historial antiguo cargado después de activar la IA no se procesa.
    filters.push(
      sql`COALESCE(${whatsappMessages.messageTimestamp}, ${whatsappMessages.receivedAt}) >= ${sinceSql}`,
    );
  }
  if (options.contactKeys && options.contactKeys.length > 0) {
    filters.push(inArray(whatsappMessages.contactKey, options.contactKeys));
  }

  const unprocessed = await db
    .select({
      messageId: whatsappMessages.messageId,
      contactKey: whatsappMessages.contactKey,
    })
    .from(whatsappMessages)
    .where(and(...filters))
    .orderBy(asc(whatsappMessages.receivedAt))
    .limit(MAX_MESSAGES_PER_RUN);

  if (unprocessed.length === 0) return { created: 0, messages: 0 };

  // No repetir mensajes que ya están en un lote pendiente.
  const active = await db
    .select({ messageIds: aiJobs.messageIds })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.businessId, businessId),
        inArray(aiJobs.status, ['pending', 'processing']),
      ),
    );

  const queued = new Set<string>();
  for (const job of active) {
    try {
      for (const id of JSON.parse(job.messageIds) as string[]) queued.add(id);
    } catch {
      // Lote corrupto: se ignora.
    }
  }

  const byContact = new Map<string, string[]>();
  for (const row of unprocessed) {
    if (queued.has(row.messageId)) continue;
    const contact = String(row.contactKey);
    const list = byContact.get(contact) ?? [];
    list.push(row.messageId);
    byContact.set(contact, list);
  }

  let created = 0;
  let messages = 0;

  for (const [contact, ids] of byContact) {
    for (let index = 0; index < ids.length; index += BATCH_SIZE) {
      const chunk = ids.slice(index, index + BATCH_SIZE);
      if (chunk.length === 0) continue;

      const inserted = await db
        .insert(aiJobs)
        .values({
          id: await batchJobId(businessId, chunk),
          businessId,
          waContact: contact,
          messageIds: JSON.stringify(chunk),
          status: 'pending',
          createdAt: nowSqlite(),
          updatedAt: nowSqlite(),
        })
        .onConflictDoNothing()
        .returning({ id: aiJobs.id });

      if (inserted.length === 0) continue;
      created += 1;
      messages += chunk.length;
    }
  }

  return { created, messages };
}

export async function processAiJobs(
  db: Db,
  businessId: string,
  options: {
    config: AiConfig;
    provider?: AiProvider;
    limit?: number;
    actorId?: string | null;
    /** Restringe el lote a contactos concretos (manual o lista de prueba). */
    contactKeys?: string[];
    /** Solo mensajes recibidos desde este instante (ISO UTC). */
    since?: string | null;
    /** Para evaluación: entrega la extracción cruda y la que pasa guardas. */
    onExtraction?: (info: {
      jobId: string;
      raw: unknown;
      guarded: unknown;
    }) => void;
    /** Inyectable en pruebas para no descargar imágenes reales. */
    loadImage?: (image: InboundImage) => Promise<LoadedImage | null>;
    /** Inyectable en pruebas para no descargar audios reales. */
    loadAudio?: (audio: InboundAudio) => Promise<LoadedAudio | null>;
  },
): Promise<ProcessResult> {
  const config = options.config;
  const result: ProcessResult = {
    enqueued: 0,
    processed: 0,
    failed: 0,
    skipped: 0,
    suggestions: 0,
    applied: 0,
    reason: null,
  };

  if (!config.enabled) {
    result.reason = 'disabled';
    return result;
  }

  const enqueued = await enqueueAiJobs(db, businessId, {
    ...(options.since ? { since: options.since } : {}),
    ...(options.contactKeys && options.contactKeys.length > 0
      ? { contactKeys: options.contactKeys }
      : {}),
  });
  result.enqueued = enqueued.created;

  const provider = options.provider ?? getProvider(config);

  // Depuración con retención limitada, antes de gastar en más llamadas.
  await pruneAiData(db, businessId, config.rawRetentionDays);
  await pruneTranscriptions(db, businessId, config.transcriptionRetentionDays);
  await pruneReviewedSuggestions(db, businessId, config.suggestionRetentionDays);
  await aggregateAndPruneUsage(db, businessId, config.usageRetentionDays);

  let budget = await budgetState(db, businessId, config);

  // Un isolate puede morir a mitad de un job (límite de CPU, red o reinicio).
  // Se recupera para que no quede en `processing` para siempre.
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
  const staleJobs = await db
    .select({ id: aiJobs.id, attempts: aiJobs.attempts })
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.businessId, businessId),
        eq(aiJobs.status, 'processing'),
        lt(aiJobs.updatedAt, staleBefore),
      ),
    );

  for (const stale of staleJobs) {
    const attempts = stale.attempts + 1;
    await db
      .update(aiJobs)
      .set({
        status: attempts >= config.maxAttempts ? 'failed' : 'pending',
        attempts,
        lastError: 'Procesamiento interrumpido; reintentando',
        updatedAt: nowSqlite(),
      })
      .where(and(eq(aiJobs.id, stale.id), eq(aiJobs.businessId, businessId)));
  }

  const jobs = await db
    .select()
    .from(aiJobs)
    .where(
      and(
        eq(aiJobs.businessId, businessId),
        inArray(aiJobs.status, ['pending', 'failed']),
        lt(aiJobs.attempts, config.maxAttempts),
        ...(options.contactKeys && options.contactKeys.length > 0
          ? [inArray(aiJobs.waContact, options.contactKeys)]
          : []),
      ),
    )
    .orderBy(asc(aiJobs.createdAt))
    .limit(options.limit ?? 10);

  for (const job of jobs) {
    if (budget.blocked) {
      result.skipped += 1;
      result.reason = budget.blocked === 'monthly' ? 'budget_monthly' : 'budget_daily';
      continue;
    }

    const [claimed] = await db
      .update(aiJobs)
      .set({ status: 'processing', updatedAt: nowSqlite() })
      .where(
        and(
          eq(aiJobs.id, job.id),
          eq(aiJobs.businessId, businessId),
          inArray(aiJobs.status, ['pending', 'failed']),
        ),
      )
      .returning({ id: aiJobs.id });

    if (!claimed) continue;

    let messageIds: string[] = [];
    try {
      messageIds = JSON.parse(job.messageIds) as string[];
    } catch {
      messageIds = [];
    }

    try {
      const rows = await db
        .select()
        .from(whatsappMessages)
        .where(
          and(
            eq(whatsappMessages.businessId, businessId),
            inArray(whatsappMessages.messageId, messageIds),
          ),
        )
        .orderBy(asc(whatsappMessages.receivedAt));

      if (rows.length === 0) {
        await db
          .update(aiJobs)
          .set({ status: 'done', updatedAt: nowSqlite() })
          .where(eq(aiJobs.id, job.id));
        continue;
      }

      // Los audios se transcriben antes de extraer. Si uno falla, el lote
      // queda pendiente y se reintenta; el mensaje original no se marca como
      // procesado ni se pierde.
      const beforeTranscription = await budgetState(db, businessId, config);
      if (beforeTranscription.blocked) {
        throw new Error('Presupuesto de IA agotado');
      }

      const transcription = await transcribeAudioMessages({
        db,
        businessId,
        rows: rows.map((row) => ({
          messageId: row.messageId,
          messageType: row.messageType,
          rawMessageJson: row.rawMessageJson,
          body: row.body,
        })),
        provider,
        config,
        ...(options.loadAudio ? { loadAudio: options.loadAudio } : {}),
      });

      const messages: AiMessage[] = rows.map((row) => {
        const isAudio =
          row.messageType === 'audio' ||
          row.messageType === 'voice' ||
          row.messageType === 'ptt';
        const transcript = transcription.texts.get(row.messageId);

        return {
          id: row.messageId,
          body: isAudio
            ? transcript
              ? bodyForAudio(row.body, transcript)
              : 'Audio sin transcribir.'
            : (row.body ?? ''),
          direction: row.direction,
          at: row.messageTimestamp ?? row.receivedAt,
          contactName: row.contactName,
          ...(isAudio ? { mediaType: 'audio' as const } : {}),
        };
      });

      const afterTranscription = await budgetState(db, businessId, config);
      budget = afterTranscription;
      if (afterTranscription.blocked) {
        throw new Error('Presupuesto de IA agotado');
      }

      const contactName = rows[rows.length - 1]?.contactName ?? null;

      const providerResult = await provider.extract({
        contactKey: job.waContact,
        contactPhone: rows[0]?.contactPhone ?? null,
        contactName,
        messages,
      });

      if (options.onExtraction) {
        options.onExtraction({
          jobId: job.id,
          raw: JSON.parse(JSON.stringify(providerResult.extraction)),
          guarded: (() => {
            const clone = JSON.parse(JSON.stringify(providerResult.extraction));
            guardExtraction(clone, messages);

            // Igual que applyExtraction: el teléfono del job es un dato real.
            const phone = rows[0]?.contactPhone;
            if (!clone.client.phone && phone) {
              clone.client.phone = {
                value: phone.startsWith('+') ? phone : `+${phone}`,
                confidence: 0.95,
                evidence: messages.slice(0, 1).map((message) => message.id),
              };
            }
            return clone;
          })(),
        });
      }

      // Compuerta de visión: solo se clasifica la foto si el lote propone
      // mascotas. Si hay foto y no se confirma un animal, no se auto-crea.
      const inboundImages = rows
        .map((row) =>
          imageFromRawMessage(
            row.messageId,
            row.messageType,
            row.rawMessageJson,
          ),
        )
        .filter((image): image is InboundImage => image !== null);

      let imageCheck: ApplyInput['imageCheck'];
      const mayCreatePets = config.autoCreatePets || config.autoApply;
      if (
        mayCreatePets &&
        inboundImages.length > 0 &&
        providerResult.extraction.pets.length > 0
      ) {
        const firstImage = inboundImages[0] as InboundImage;

        if (config.visionEnabled && provider.classifyImage && !budget.blocked) {
          try {
            const loader =
              options.loadImage ??
              ((image: InboundImage) =>
                downloadInboundImage(image, {
                  maxBytes: config.visionMaxImageBytes,
                }));
            const loaded = await loader(firstImage);

            if (!loaded) {
              imageCheck = {
                present: true,
                hasAnimal: null,
                reason: 'No se pudo leer la foto',
              };
            } else {
              const classification = await provider.classifyImage({
                base64: loaded.base64,
                mimeType: loaded.mimeType,
                fileName: firstImage.fileName,
              });
              await recordUsage(db, businessId, classification);
              budget = await budgetState(db, businessId, config);
              imageCheck = {
                present: true,
                hasAnimal: classification.hasAnimal,
                reason: classification.reason,
              };
            }
          } catch (cause) {
            const detail =
              cause instanceof Error ? cause.message : String(cause);
            await recordUsage(db, businessId, null, detail);
            imageCheck = {
              present: true,
              hasAnimal: null,
              reason: 'La clasificación de la foto falló',
            };
          }
        } else {
          imageCheck = {
            present: true,
            hasAnimal: null,
            reason: config.visionEnabled
              ? 'Visión no disponible'
              : 'Visión desactivada',
          };
        }
      }

      const verifyPetCandidate =
        config.verifyPetCandidates && provider.verifyPet
          ? async (candidate: {
              name: string;
              species: 'perro' | 'gato' | null;
              messages: AiMessage[];
            }) => {
              if (budget.blocked) {
                return {
                  allowed: false,
                  confidence: 0,
                  reason: 'Presupuesto de IA agotado',
                };
              }

              try {
                const verdict = await provider.verifyPet!(candidate);
                await recordUsage(db, businessId, verdict);
                budget = await budgetState(db, businessId, config);
                return {
                  allowed: verdict.allowed,
                  confidence: verdict.confidence,
                  reason: verdict.reason,
                };
              } catch (cause) {
                const detail =
                  cause instanceof Error ? cause.message : String(cause);
                await recordUsage(db, businessId, null, detail);
                return {
                  allowed: false,
                  confidence: 0,
                  reason: 'El verificador falló',
                };
              }
            }
          : undefined;

      const applied = await applyExtraction({
        db,
        businessId,
        contactKey: job.waContact,
        contactPhone: rows[0]?.contactPhone ?? null,
        contactName,
        extraction: providerResult.extraction,
        messages,
        jobId: job.id,
        model: providerResult.model,
        raw: providerResult.raw,
        autoApply: config.autoApply,
        autoCreatePets: config.autoCreatePets,
        autoCreateAppointmentRequests: config.autoCreateAppointmentRequests,
        autoConfirmAppointments: config.autoConfirmAppointments,
        contactAuthorizedForAppointments:
          config.testContacts.length === 0 ||
          config.testContacts.includes(job.waContact),
        contactAuthorizedForPets:
          config.testContacts.length === 0 ||
          config.testContacts.includes(job.waContact),
        storeRaw: config.storeRawResponse,
        ...(verifyPetCandidate ? { verifyPetCandidate } : {}),
        ...(imageCheck ? { imageCheck } : {}),
      });

      await db.insert(aiUsage).values({
        id: crypto.randomUUID(),
        businessId,
        extractionId: null,
        model: providerResult.model,
        tokensIn: providerResult.tokensIn,
        tokensOut: providerResult.tokensOut,
        costUsdMicros: providerResult.costUsdMicros,
        latencyMs: providerResult.latencyMs,
        createdAt: nowSqlite(),
      });

      if (messageIds.length > 0) {
        await db
          .insert(aiProcessedMessages)
          .values(
            messageIds.map((messageId) => ({
              messageId,
              businessId,
              jobId: job.id,
              processedAt: nowSqlite(),
            })),
          )
          .onConflictDoNothing();
      }

      await db
        .update(aiJobs)
        .set({ status: 'done', updatedAt: nowSqlite(), lastError: null })
        .where(eq(aiJobs.id, job.id));

      budget = await budgetState(db, businessId, config);
      await registerBudgetAlerts(db, businessId, config, budget.spent);

      result.processed += 1;
      result.suggestions += applied.suggestions;
      result.applied += applied.applied;
    } catch (cause) {
      const attempts = job.attempts + 1;
      const terminal = attempts >= config.maxAttempts;
      const message = cause instanceof Error ? cause.message : String(cause);

      await db
        .update(aiJobs)
        .set({
          status: terminal ? 'failed' : 'pending',
          attempts,
          lastError: message.slice(0, 300),
          updatedAt: nowSqlite(),
        })
        .where(eq(aiJobs.id, job.id));

      // Se registra el fallo sin costo para que las métricas lo cuenten.
      await db.insert(aiUsage).values({
        id: crypto.randomUUID(),
        businessId,
        extractionId: null,
        model: config.model,
        tokensIn: 0,
        tokensOut: 0,
        costUsdMicros: 0,
        latencyMs: null,
        error: message.slice(0, 300),
        createdAt: nowSqlite(),
      });

      result.failed += 1;
    }
  }

  return result;
}

export { spendFor };

