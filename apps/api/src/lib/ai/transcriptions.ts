import type { Db } from '@keyko/db';
import { aiUsage, messageTranscriptions } from '@keyko/db';
import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { nowSqlite } from '@keyko/domain';
import {
  audioFromRawMessage,
  downloadInboundAudio,
  type InboundAudio,
  type LoadedAudio,
} from './audio-media';
import type { AiConfig } from './config';
import type { AiProvider } from './fake';

/**
 * Transcripción de notas de voz.
 *
 * Se ejecuta dentro del pipeline de `ai_jobs`, antes de la extracción. Una
 * transcripción terminada se reutiliza siempre: la corrección manual tiene
 * prioridad y un reintento no vuelve a llamar al modelo si ya existe texto.
 */

export type AudioMessageRow = {
  messageId: string;
  messageType: string | null;
  rawMessageJson: string;
  body: string | null;
};

export type TranscriptionOptions = {
  db: Db;
  businessId: string;
  rows: AudioMessageRow[];
  provider: AiProvider;
  config: AiConfig;
  /** Inyectable en pruebas para no descargar audio real. */
  loadAudio?: (audio: InboundAudio) => Promise<LoadedAudio | null>;
};

export type TranscriptionOutcome = {
  /** Texto efectivo por mensaje (corrección manual o transcripción). */
  texts: Map<string, string>;
  failed: number;
};

const AUDIO_TYPES = new Set(['audio', 'voice', 'ptt']);

function isAudio(messageType: string | null): boolean {
  return messageType !== null && AUDIO_TYPES.has(messageType);
}

function effectiveText(row: typeof messageTranscriptions.$inferSelect): string | null {
  const manual = row.manualTranscript?.trim();
  if (manual) return manual;
  const transcript = row.transcript?.trim();
  return transcript || null;
}

/** Texto que ve el modelo: la transcripción, sin la URL privada del audio. */
export function bodyForAudio(
  originalBody: string | null,
  transcript: string,
): string {
  const caption = (originalBody ?? '').trim();
  if (
    caption === '' ||
    /^audio attached/i.test(caption) ||
    /^audio adjunto/i.test(caption) ||
    /^image attached/i.test(caption) ||
    caption.includes('URL:')
  ) {
    return transcript;
  }
  return `${caption}\n${transcript}`;
}

async function recordUsage(
  db: Db,
  businessId: string,
  values: {
    model: string;
    audioSeconds: number | null;
    costUsdMicros: number;
    latencyMs: number | null;
    error?: string;
  },
): Promise<void> {
  await db.insert(aiUsage).values({
    id: crypto.randomUUID(),
    businessId,
    extractionId: null,
    model: values.model,
    tokensIn: 0,
    tokensOut: 0,
    audioSeconds: values.audioSeconds,
    costUsdMicros: values.costUsdMicros,
    latencyMs: values.latencyMs,
    ...(values.error ? { error: values.error.slice(0, 300) } : {}),
    createdAt: nowSqlite(),
  });
}

function backoffPending(row: typeof messageTranscriptions.$inferSelect): boolean {
  if (row.status !== 'failed' || row.attempts <= 0) return false;
  const last = Date.parse(`${row.updatedAt.replace(' ', 'T')}Z`);
  if (!Number.isFinite(last)) return false;
  const waitMs = Math.min(15_000 * 2 ** Math.max(0, row.attempts - 1), 120_000);
  return Date.now() - last < waitMs;
}

/**
 * Garantiza una transcripción por mensaje de audio. Devuelve el texto
 * efectivo para los audios completados. Si un audio falla, lanza para que el
 * lote se reintente sin marcar los mensajes como procesados.
 */
export async function transcribeAudioMessages(
  options: TranscriptionOptions,
): Promise<TranscriptionOutcome> {
  const { db, businessId, provider, config } = options;
  const audioRows = options.rows.filter((row) => isAudio(row.messageType));
  const texts = new Map<string, string>();
  if (audioRows.length === 0) return { texts, failed: 0 };

  const ids = audioRows.map((row) => row.messageId);
  const existing = await db
    .select()
    .from(messageTranscriptions)
    .where(
      and(
        eq(messageTranscriptions.businessId, businessId),
        inArray(messageTranscriptions.messageId, ids),
      ),
    );
  const byMessage = new Map(existing.map((row) => [row.messageId, row]));

  let failed = 0;

  for (const message of audioRows) {
    const current = byMessage.get(message.messageId);

    // La corrección manual y las transcripciones ya listas no cuestan nada.
    if (current) {
      const text = effectiveText(current);
      if (text && (current.status === 'completed' || current.manualTranscript)) {
        texts.set(message.messageId, text);
        continue;
      }
    }

    if (!config.transcriptionEnabled) continue;
    if (!provider.transcribe) {
      throw new Error('El proveedor de IA no soporta transcripción de audio');
    }

    if (
      current?.status === 'failed' &&
      current.attempts >= config.transcriptionMaxAttempts
    ) {
      throw new Error(
        current.lastError ?? 'La transcripción falló y agotó los reintentos',
      );
    }
    if (current && backoffPending(current)) {
      throw new Error('La transcripción espera el siguiente reintento');
    }

    if (!current) {
      await db
        .insert(messageTranscriptions)
        .values({
          id: crypto.randomUUID(),
          businessId,
          messageId: message.messageId,
          status: 'pending',
          provider: provider.name === 'openrouter' ? 'openrouter' : 'fake',
          createdAt: nowSqlite(),
          updatedAt: nowSqlite(),
        })
        .onConflictDoNothing();
    }

    const staleBefore = new Date(
      Date.now() - config.transcriptionTimeoutMs,
    )
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    const [claimed] = await db
      .update(messageTranscriptions)
      .set({
        status: 'processing',
        attempts: sql`${messageTranscriptions.attempts} + 1`,
        lastError: null,
        updatedAt: nowSqlite(),
      })
      .where(
        and(
          eq(messageTranscriptions.businessId, businessId),
          eq(messageTranscriptions.messageId, message.messageId),
          or(
            inArray(messageTranscriptions.status, ['pending', 'failed']),
            and(
              eq(messageTranscriptions.status, 'processing'),
              lt(messageTranscriptions.updatedAt, staleBefore),
            ),
          ),
        ),
      )
      .returning();

    if (!claimed) {
      throw new Error('La transcripción ya está en proceso');
    }

    const audio = audioFromRawMessage(
      message.messageId,
      message.messageType,
      message.rawMessageJson,
    );

    if (!audio) {
      const detail =
        'No se pudo obtener el audio. El archivo puede haber expirado.';
      await db
        .update(messageTranscriptions)
        .set({
          status: 'failed',
          lastError: detail,
          updatedAt: nowSqlite(),
        })
        .where(eq(messageTranscriptions.id, claimed.id));
      await recordUsage(db, businessId, {
        model: config.transcriptionModel,
        audioSeconds: null,
        costUsdMicros: 0,
        latencyMs: null,
        error: detail,
      });
      failed += 1;
      throw new Error(detail);
    }

    if (
      audio.durationSeconds !== null &&
      audio.durationSeconds > config.transcriptionMaxSeconds
    ) {
      const detail = `El audio supera el máximo de ${config.transcriptionMaxSeconds} segundos`;
      await db
        .update(messageTranscriptions)
        .set({
          status: 'failed',
          lastError: detail,
          durationSeconds: audio.durationSeconds,
          updatedAt: nowSqlite(),
        })
        .where(eq(messageTranscriptions.id, claimed.id));
      failed += 1;
      throw new Error(detail);
    }

    const loader =
      options.loadAudio ??
      ((value: InboundAudio) =>
        downloadInboundAudio(value, {
          maxBytes: config.transcriptionMaxBytes,
        }));

    const started = Date.now();
    let loaded: LoadedAudio | null = null;
    try {
      loaded = await loader(audio);
    } catch {
      loaded = null;
    }

    if (!loaded) {
      const detail =
        'No se pudo descargar el audio. Puede haber expirado o ser inválido.';
      await db
        .update(messageTranscriptions)
        .set({
          status: 'failed',
          lastError: detail,
          updatedAt: nowSqlite(),
        })
        .where(eq(messageTranscriptions.id, claimed.id));
      await recordUsage(db, businessId, {
        model: config.transcriptionModel,
        audioSeconds: audio.durationSeconds,
        costUsdMicros: 0,
        latencyMs: Date.now() - started,
        error: detail,
      });
      failed += 1;
      throw new Error(detail);
    }

    try {
      const result = await provider.transcribe({
        messageId: message.messageId,
        base64: loaded.base64,
        format: loaded.format,
        mimeType: loaded.mimeType,
        durationSeconds: audio.durationSeconds,
      });

      if (result.audioSeconds > config.transcriptionMaxSeconds) {
        throw new Error(
          `El audio supera el máximo de ${config.transcriptionMaxSeconds} segundos`,
        );
      }

      await db
        .update(messageTranscriptions)
        .set({
          status: 'completed',
          model: result.model,
          transcript: result.text,
          language: result.language,
          durationSeconds: result.audioSeconds,
          audioFormat: loaded.format,
          audioBytes: loaded.byteLength,
          costUsdMicros: result.costUsdMicros,
          latencyMs: result.latencyMs,
          lastError: null,
          transcribedAt: nowSqlite(),
          updatedAt: nowSqlite(),
        })
        .where(eq(messageTranscriptions.id, claimed.id));

      await recordUsage(db, businessId, {
        model: result.model,
        audioSeconds: result.audioSeconds,
        costUsdMicros: result.costUsdMicros,
        latencyMs: result.latencyMs,
      });

      texts.set(message.messageId, result.text);
    } catch (cause) {
      const detail =
        cause instanceof Error ? cause.message : 'No se pudo transcribir el audio';
      await db
        .update(messageTranscriptions)
        .set({
          status: 'failed',
          lastError: detail.slice(0, 300),
          audioFormat: loaded.format,
          audioBytes: loaded.byteLength,
          updatedAt: nowSqlite(),
        })
        .where(eq(messageTranscriptions.id, claimed.id));
      await recordUsage(db, businessId, {
        model: config.transcriptionModel,
        audioSeconds: audio.durationSeconds,
        costUsdMicros: 0,
        latencyMs: Date.now() - started,
        error: detail,
      });
      failed += 1;
      throw new Error(detail);
    }
  }

  return { texts, failed };
}

/** Transcripciones existentes por mensaje (para la bandeja). */
export async function transcriptionsForMessages(
  db: Db,
  businessId: string,
  messageIds: string[],
): Promise<Map<string, typeof messageTranscriptions.$inferSelect>> {
  if (messageIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(messageTranscriptions)
    .where(
      and(
        eq(messageTranscriptions.businessId, businessId),
        inArray(messageTranscriptions.messageId, messageIds),
      ),
    );
  return new Map(rows.map((row) => [row.messageId, row]));
}

export function effectiveTranscript(
  row: typeof messageTranscriptions.$inferSelect | undefined,
): string | null {
  return row ? effectiveText(row) : null;
}


/**
 * Retención de transcripciones: borra el texto pasado el plazo, pero conserva
 * la fila, el estado, el modelo y el costo para no romper la trazabilidad de
 * extracciones ya aplicadas.
 */
export async function pruneTranscriptions(
  db: Db,
  businessId: string,
  retentionDays: number,
): Promise<number> {
  if (retentionDays <= 0) return 0;
  const cutoff = new Date(
    Date.now() - retentionDays * 24 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');

  const rows = await db
    .select({ id: messageTranscriptions.id })
    .from(messageTranscriptions)
    .where(
      and(
        eq(messageTranscriptions.businessId, businessId),
        sql`${messageTranscriptions.createdAt} < ${cutoff}`,
        sql`${messageTranscriptions.purgedAt} IS NULL`,
        sql`(${messageTranscriptions.transcript} IS NOT NULL OR ${messageTranscriptions.manualTranscript} IS NOT NULL)`,
      ),
    )
    .limit(500);

  for (const row of rows) {
    await db
      .update(messageTranscriptions)
      .set({
        transcript: null,
        manualTranscript: null,
        purgedAt: nowSqlite(),
        updatedAt: nowSqlite(),
      })
      .where(eq(messageTranscriptions.id, row.id));
  }

  return rows.length;
}
