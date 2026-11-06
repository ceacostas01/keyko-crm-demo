import type { Db } from '@keyko/db';
import { clients, conversations } from '@keyko/db';
import { sql } from 'drizzle-orm';

/**
 * Bandeja de WhatsApp.
 *
 * El webhook de producción escribe en `whatsapp_events` y `whatsapp_messages`,
 * pero no en `conversations`. En vez de tocarlo, la bandeja se materializa
 * aquí a partir de los mensajes: una conversación por contacto, con su último
 * mensaje y el cliente asociado si el teléfono coincide.
 *
 * Es idempotente: se puede ejecutar en cada lectura sin duplicar nada. Nunca
 * escribe en las tablas del webhook.
 *
 * Ojo con la identidad del contacto: en producción `contact_key` es un BSUID
 * (`CO.27…`), no un teléfono. El teléfono real viene en `contact_phone`, así
 * que la vinculación con clientes mira ambos.
 */

export type LastMessage = {
  body: string | null;
  direction: string;
  messageType: string | null;
  contactName: string | null;
  sentAt: string | null;
};

export type SyncResult = {
  contacts: number;
  created: number;
  linkedClients: number;
};

/** Dígitos normalizados: "+57 312 575 4547" y "573000000000" son lo mismo. */
function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

export async function syncConversations(
  db: Db,
  businessId: string,
): Promise<SyncResult> {
  const rows = await db.all<{ contact_key: string }>(sql`
    SELECT DISTINCT contact_key
      FROM whatsapp_messages
     WHERE business_id = ${businessId}
       AND contact_key IS NOT NULL
       AND contact_key <> ''
  `);

  const contacts = rows.map((row) => String(row.contact_key));

  const existing = await db.all<{ wa_contact: string }>(sql`
    SELECT wa_contact
      FROM conversations
     WHERE business_id = ${businessId}
  `);
  const known = new Set(existing.map((row) => String(row.wa_contact)));
  const missing = contacts.filter((contact) => !known.has(contact));

  if (missing.length > 0) {
    await db
      .insert(conversations)
      .values(
        missing.map((contact) => ({
          id: crypto.randomUUID(),
          businessId,
          waContact: contact,
          status: 'active' as const,
        })),
      )
      .onConflictDoNothing();
  }

  // El último mensaje manda para ordenar la bandeja. `MAX()` sobre un
  // COALESCE evita que un mensaje sin timestamp deje la conversación al final.
  await db.all(sql`
    UPDATE conversations
       SET last_message_at = (
             SELECT MAX(COALESCE(m.message_timestamp, m.received_at))
               FROM whatsapp_messages m
              WHERE m.business_id = conversations.business_id
                AND m.contact_key = conversations.wa_contact
           )
     WHERE business_id = ${businessId}
  `);

  const linkedClients = await linkClients(db, businessId);

  return {
    contacts: contacts.length,
    created: missing.length,
    linkedClients,
  };
}

/**
 * Vincula conversaciones sin cliente. Se resuelve en memoria porque son
 * pocas filas y así se comparan teléfonos con formatos distintos sin escribir
 * SQL ilegible.
 */
async function linkClients(db: Db, businessId: string): Promise<number> {
  const unlinked = await db.all<{ id: string; wa_contact: string }>(sql`
    SELECT id, wa_contact
      FROM conversations
     WHERE business_id = ${businessId}
       AND client_id IS NULL
  `);

  if (unlinked.length === 0) return 0;

  const clientRows = await db.all<{
    id: number;
    phone: string | null;
    whatsapp_contact_key: string | null;
  }>(sql`
    SELECT id, phone, whatsapp_contact_key
      FROM clients
     WHERE business_id = ${businessId}
       AND deleted_at IS NULL
  `);

  const byPhone = new Map<string, number>();
  for (const client of clientRows) {
    for (const candidate of [client.phone, client.whatsapp_contact_key]) {
      const key = digits(candidate);
      if (key) byPhone.set(key, Number(client.id));
    }
  }

  if (byPhone.size === 0) return 0;

  // Teléfono que el webhook conoce para cada contacto (BSUID o número).
  const phoneRows = await db.all<{
    contact_key: string;
    contact_phone: string | null;
  }>(sql`
    SELECT contact_key, MAX(contact_phone) AS contact_phone
      FROM whatsapp_messages
     WHERE business_id = ${businessId}
       AND contact_phone IS NOT NULL
       AND contact_phone <> ''
     GROUP BY contact_key
  `);

  const phoneByContact = new Map<string, string>();
  for (const row of phoneRows) {
    phoneByContact.set(String(row.contact_key), String(row.contact_phone));
  }

  // Agrupa por cliente para hacer un UPDATE por cliente, no por conversación.
  const byClient = new Map<number, string[]>();
  for (const conversation of unlinked) {
    // La clave del contacto puede ser un BSUID ("CO.123..."): sus dígitos no
    // son un teléfono. Solo se usa como teléfono si de verdad lo parece.
    const looksLikePhone = /^\+?\d{8,15}$/.test(conversation.wa_contact.trim());

    const candidates = [
      looksLikePhone ? digits(conversation.wa_contact) : '',
      digits(phoneByContact.get(conversation.wa_contact)),
    ].filter(Boolean);

    const clientId = candidates
      .map((candidate) => byPhone.get(candidate))
      .find((id) => id !== undefined);

    if (clientId === undefined) continue;
    const list = byClient.get(clientId) ?? [];
    list.push(conversation.id);
    byClient.set(clientId, list);
  }

  let linked = 0;
  for (const [clientId, ids] of byClient) {
    for (const id of ids) {
      await db.run(sql`
        UPDATE conversations
           SET client_id = ${clientId}
         WHERE business_id = ${businessId} AND id = ${id}
      `);
      linked += 1;
    }
  }

  return linked;
}

/**
 * Último mensaje de cada contacto. Con `ROW_NUMBER()` en una sola consulta,
 * sin una consulta por conversación.
 */
export async function lastMessages(
  db: Db,
  businessId: string,
): Promise<Map<string, LastMessage>> {
  const rows = await db.all<{
    contact_key: string;
    body: string | null;
    direction: string;
    message_type: string | null;
    contact_name: string | null;
    sent_at: string | null;
  }>(sql`
    SELECT contact_key, body, direction, message_type, contact_name, sent_at
      FROM (
        SELECT contact_key,
               body,
               direction,
               message_type,
               contact_name,
               COALESCE(message_timestamp, received_at) AS sent_at,
               ROW_NUMBER() OVER (
                 PARTITION BY contact_key
                 ORDER BY COALESCE(message_timestamp, received_at) DESC,
                          message_id DESC
               ) AS rn
          FROM whatsapp_messages
         WHERE business_id = ${businessId}
           AND contact_key IS NOT NULL
      )
     WHERE rn = 1
  `);

  const map = new Map<string, LastMessage>();
  for (const row of rows) {
    map.set(String(row.contact_key), {
      body: row.body === null ? null : String(row.body),
      direction: String(row.direction),
      messageType: row.message_type === null ? null : String(row.message_type),
      contactName: row.contact_name === null ? null : String(row.contact_name),
      sentAt: row.sent_at === null ? null : String(row.sent_at),
    });
  }
  return map;
}

/** Cliente asociado a una conversación. */
export async function clientFor(
  db: Db,
  businessId: string,
  clientId: number | null,
): Promise<{ id: number; name: string | null; phone: string | null } | null> {
  if (clientId === null) return null;
  const [row] = await db
    .select({
      id: clients.id,
      name: clients.fullName,
      phone: clients.phone,
    })
    .from(clients)
    .where(sql`${clients.id} = ${clientId} AND ${clients.businessId} = ${businessId}`)
    .limit(1);

  return row ?? null;
}

export type ConversationMessage = {
  messageId: string;
  direction: string;
  messageType: string | null;
  body: string | null;
  contactPhone: string | null;
  contactName: string | null;
  sentAt: string | null;
  receivedAt: string;
  transcription: {
    status: 'pending' | 'processing' | 'completed' | 'failed';
    text: string | null;
    originalText: string | null;
    error: string | null;
    attempts: number;
    durationSeconds: number | null;
    costUsdMicros: number;
    model: string | null;
    correctedAt: string | null;
  } | null;
};

export async function messagesFor(
  db: Db,
  businessId: string,
  conversationId: string,
  waContact: string,
): Promise<ConversationMessage[]> {
  const rows = await db.all<{
    message_id: string;
    direction: string;
    message_type: string | null;
    body: string | null;
    contact_phone: string | null;
    contact_name: string | null;
    sent_at: string | null;
    received_at: string;
    transcription_status: string | null;
    transcript: string | null;
    manual_transcript: string | null;
    transcription_error: string | null;
    transcription_attempts: number | null;
    duration_seconds: number | null;
    transcription_cost: number | null;
    transcription_model: string | null;
    corrected_at: string | null;
  }>(sql`
    SELECT m.message_id, m.direction, m.message_type, m.body, m.contact_phone,
           m.contact_name, COALESCE(m.message_timestamp, m.received_at) AS sent_at,
           m.received_at,
           t.status AS transcription_status,
           t.transcript,
           t.manual_transcript,
           t.last_error AS transcription_error,
           t.attempts AS transcription_attempts,
           t.duration_seconds,
           t.cost_usd_micros AS transcription_cost,
           t.model AS transcription_model,
           t.corrected_at
      FROM whatsapp_messages m
      LEFT JOIN message_transcriptions t
        ON t.business_id = m.business_id
       AND t.message_id = m.message_id
     WHERE m.business_id = ${businessId}
       AND (m.conversation_id = ${conversationId} OR m.contact_key = ${waContact})
     ORDER BY COALESCE(m.message_timestamp, m.received_at) ASC, m.message_id ASC
  `);

  return rows.map((row) => {
    const transcript = row.transcript?.trim() || null;
    const manual = row.manual_transcript?.trim() || null;
    return {
      messageId: String(row.message_id),
      direction: String(row.direction),
      messageType: row.message_type === null ? null : String(row.message_type),
      body: row.body === null ? null : String(row.body),
      contactPhone: row.contact_phone === null ? null : String(row.contact_phone),
      contactName: row.contact_name === null ? null : String(row.contact_name),
      sentAt: row.sent_at === null ? null : String(row.sent_at),
      receivedAt: String(row.received_at),
      transcription: row.transcription_status
        ? {
            status: row.transcription_status as
              | 'pending'
              | 'processing'
              | 'completed'
              | 'failed',
            text: manual ?? transcript,
            originalText: transcript,
            error:
              row.transcription_error === null
                ? null
                : String(row.transcription_error),
            attempts: Number(row.transcription_attempts ?? 0),
            durationSeconds:
              row.duration_seconds === null
                ? null
                : Number(row.duration_seconds),
            costUsdMicros: Number(row.transcription_cost ?? 0),
            model:
              row.transcription_model === null
                ? null
                : String(row.transcription_model),
            correctedAt:
              row.corrected_at === null ? null : String(row.corrected_at),
          }
        : null,
    };
  });
}
