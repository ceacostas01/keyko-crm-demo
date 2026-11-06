import { and, eq } from 'drizzle-orm';
import { messageTranscriptions } from '@keyko/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { aiConfig, type AiConfig } from '../src/lib/ai/config';
import { createFakeProvider, type AiProvider } from '../src/lib/ai/fake';
import { detectAudioType } from '../src/lib/ai/audio-media';
import {
  transcribeAudioMessages,
  type AudioMessageRow,
} from '../src/lib/ai/transcriptions';
import { processAiJobs } from '../src/lib/ai/jobs';
import {
  BIZ_A,
  BIZ_B,
  call,
  makeHarness,
  request,
  type Harness,
} from './helpers';

const config: AiConfig = {
  ...aiConfig({} as never),
  autoApply: false,
  autoCreatePets: false,
  autoCreateAppointmentRequests: false,
  transcriptionEnabled: true,
  testContacts: [],
};

const OGG_BASE64 = 'T2dnUw==';

function providerWithTranscripts(
  transcripts: Record<string, string>,
  options: { fail?: Set<string>; empty?: Set<string> } = {},
): AiProvider & { calls: string[] } {
  const base = createFakeProvider();
  const calls: string[] = [];
  return {
    ...base,
    calls,
    async transcribe(input) {
      calls.push(input.messageId);
      if (options.fail?.has(input.messageId)) {
        throw new Error('OpenRouter temporal');
      }
      if (options.empty?.has(input.messageId)) {
        throw new Error('El audio no tiene voz reconocible');
      }
      return {
        text: transcripts[input.messageId] ?? 'Audio de prueba',
        language: 'es',
        audioSeconds: input.durationSeconds ?? 5,
        model: 'fake-transcriber',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 1,
        costUsdMicros: 120,
      };
    },
  };
}

async function seedAudio(
  h: Harness,
  options: {
    id: string;
    contact: string;
    phone: string;
    name: string;
    at: string;
    body?: string;
    businessId?: string;
  },
): Promise<void> {
  const url = 'https://app.kapso.ai/rails/active_storage/audio-prueba.ogg';
  await h.client.execute({
    sql: `INSERT INTO whatsapp_messages
            (message_id, business_id, direction, contact_key, contact_phone,
             contact_name, message_type, body, message_timestamp, received_at,
             raw_message_json)
          VALUES (?, ?, 'inbound', ?, ?, ?, 'audio', ?, ?, ?, ?)`,
    args: [
      options.id,
      options.businessId ?? BIZ_A,
      options.contact,
      options.phone,
      options.name,
      options.body ?? 'Audio adjunto',
      options.at,
      options.at,
      JSON.stringify({
        type: 'audio',
        audio: { mime_type: 'audio/ogg; codecs=opus', duration: 5 },
        kapso: {
          media_url: url,
          media_data: {
            url,
            filename: 'audio-prueba.ogg',
            content_type: 'audio/ogg',
            byte_size: 4,
            duration: 5,
          },
        },
      }),
    ],
  });
}

async function seedText(
  h: Harness,
  options: {
    id: string;
    contact: string;
    phone: string;
    name: string;
    at: string;
    body: string;
    direction?: 'inbound' | 'outbound';
  },
): Promise<void> {
  await h.client.execute({
    sql: `INSERT INTO whatsapp_messages
            (message_id, business_id, direction, contact_key, contact_phone,
             contact_name, message_type, body, message_timestamp, received_at,
             raw_message_json)
          VALUES (?, ?, ?, ?, ?, ?, 'text', ?, ?, ?, '{}')`,
    args: [
      options.id,
      BIZ_A,
      options.direction ?? 'inbound',
      options.contact,
      options.phone,
      options.name,
      options.body,
      options.at,
      options.at,
    ],
  });
}

describe('audios: formatos y descarga', () => {
  it('detecta OGG/Opus por sus primeros bytes', () => {
    const bytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]);
    expect(detectAudioType(bytes)).toEqual({
      format: 'ogg',
      mimeType: 'audio/ogg',
    });
  });

  it('rechaza un archivo que no es audio', () => {
    expect(detectAudioType(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('audios: transcripción y extracción', () => {
  let h: Harness;
  const contact = 'CO.AUDIO000000001';

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(() => h.close());

  it('transcribe un audio y lo usa en la extracción', async () => {
    await seedAudio(h, {
      id: 'audio.1',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });

    const provider = providerWithTranscripts({
      'audio.1':
        'Tengo un perro beagle que se llama Apolo y tiene 13 años. Necesita un baño medicado porque tiene problemas en la piel.',
    });

    const result = await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    expect(result.processed).toBe(1);
    expect(provider.calls).toEqual(['audio.1']);

    const rows = await h.db
      .select()
      .from(messageTranscriptions)
      .where(eq(messageTranscriptions.messageId, 'audio.1'));
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.transcript).toContain('Apolo');

    const pending = await call<{
      data: Array<{ kind: string; pets?: Array<{ fields: Array<{ field: string; value: unknown }> }> }>;
    }>(h, h.tokens.a, 'GET', '/ai/suggestions?status=pending&limit=20');
    const petSuggestion = pending.body.data.find((item) => item.kind === 'client_create');
    const petFields = petSuggestion?.pets?.[0]?.fields ?? [];
    expect(petFields.find((field) => field.field === 'name')?.value).toBe(
      'Apolo',
    );
    expect(petFields.find((field) => field.field === 'breed')?.value).toBe(
      'beagle',
    );
    expect(petFields.find((field) => field.field === 'ageYears')?.value).toBe(
      13,
    );

    const usage = await h.client.execute(
      "SELECT audio_seconds, cost_usd_micros FROM ai_usage WHERE business_id = ? AND model = 'fake-transcriber'",
      [BIZ_A],
    );
    expect(Number(usage.rows[0]?.audio_seconds)).toBe(5);
    expect(Number(usage.rows[0]?.cost_usd_micros)).toBe(120);
  });

  it('combina texto y varios audios intercalados sin duplicar', async () => {
    await seedAudio(h, {
      id: 'audio.2',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });
    await seedText(h, {
      id: 'text.2',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:10Z',
      body: 'Quiero agendar baño medicado para mañana a las 10.',
    });
    await seedAudio(h, {
      id: 'audio.3',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:20Z',
    });

    const provider = providerWithTranscripts({
      'audio.2': 'Mi perro se llama Apolo, es beagle y tiene 13 años.',
      'audio.3': 'Tiene problemas en la piel.',
    });

    const result = await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });
    expect(result.processed).toBe(1);
    expect(provider.calls.sort()).toEqual(['audio.2', 'audio.3']);

    const count = await h.client.execute(
      "SELECT COUNT(*) AS n FROM message_transcriptions WHERE business_id = ?",
      [BIZ_A],
    );
    expect(Number(count.rows[0]?.n)).toBe(2);

    const suggestions = await call<{
      data: Array<{ kind: string; conversation?: { requestedService: string | null } | null }>;
    }>(h, h.tokens.a, 'GET', '/ai/suggestions?status=pending&limit=20');
    expect(
      suggestions.body.data.some(
        (item) =>
          item.kind === 'appointment_request' &&
          item.conversation?.requestedService === 'baño medicado',
      ),
    ).toBe(true);

    // Repetir el proceso no vuelve a transcribir ni duplica sugerencias.
    const before = provider.calls.length;
    await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });
    expect(provider.calls.length).toBe(before);
  });

  it('reutiliza una transcripción existente en vez de llamar dos veces', async () => {
    await seedAudio(h, {
      id: 'audio.reuse',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });

    const provider = providerWithTranscripts({
      'audio.reuse': 'Mi perro se llama Nube.',
    });
    const rows: AudioMessageRow[] = [
      {
        messageId: 'audio.reuse',
        messageType: 'audio',
        rawMessageJson: JSON.stringify({
          type: 'audio',
          kapso: { media_url: 'https://app.kapso.ai/a.ogg' },
        }),
        body: 'Audio adjunto',
      },
    ];
    const loader = async () => ({
      base64: OGG_BASE64,
      format: 'ogg' as const,
      mimeType: 'audio/ogg',
      byteLength: 4,
    });

    await transcribeAudioMessages({
      db: h.db,
      businessId: BIZ_A,
      rows,
      provider,
      config,
      loadAudio: loader,
    });
    const second = await transcribeAudioMessages({
      db: h.db,
      businessId: BIZ_A,
      rows,
      provider,
      config,
      loadAudio: loader,
    });

    expect(provider.calls).toHaveLength(1);
    expect(second.texts.get('audio.reuse')).toContain('Nube');
  });

  it('marca error de audio sin voz y no pierde el mensaje', async () => {
    await seedAudio(h, {
      id: 'audio.empty',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });
    const provider = providerWithTranscripts(
      {},
      { empty: new Set(['audio.empty']) },
    );

    const result = await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    expect(result.failed).toBe(1);
    const row = await h.db
      .select()
      .from(messageTranscriptions)
      .where(eq(messageTranscriptions.messageId, 'audio.empty'));
    expect(row[0]?.status).toBe('failed');
    expect(row[0]?.lastError).toContain('voz');

    const message = await h.client.execute(
      "SELECT COUNT(*) AS n FROM whatsapp_messages WHERE message_id = 'audio.empty'",
    );
    expect(Number(message.rows[0]?.n)).toBe(1);
  });

  it('recupera un job que quedó atascado en processing', async () => {
    await seedAudio(h, {
      id: 'audio.stale',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });
    await h.client.execute({
      sql: `INSERT INTO ai_jobs
              (id, business_id, wa_contact, message_ids, status, attempts, created_at, updated_at)
            VALUES ('stale-audio-job', ?, ?, ?, 'processing', 0,
                    datetime('now', '-10 minutes'), datetime('now', '-10 minutes'))`,
      args: [BIZ_A, contact, JSON.stringify(['audio.stale'])],
    });

    const provider = providerWithTranscripts({
      'audio.stale': 'Mi perro se llama Nube.',
    });
    const result = await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    expect(result.processed).toBe(1);
    const job = await h.client.execute(
      "SELECT status FROM ai_jobs WHERE id='stale-audio-job'",
    );
    expect(job.rows[0]?.status).toBe('done');
  });

  it('marca error si el audio no se puede descargar o está dañado', async () => {
    await seedAudio(h, {
      id: 'audio.damaged',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });
    const provider = providerWithTranscripts({});

    const result = await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => null,
    });

    expect(result.failed).toBe(1);
    expect(provider.calls).toHaveLength(0);
    const row = await h.db
      .select()
      .from(messageTranscriptions)
      .where(eq(messageTranscriptions.messageId, 'audio.damaged'));
    expect(row[0]?.status).toBe('failed');
    expect(row[0]?.lastError).toContain('descargar');
  });

  it('no procesa audios de contactos fuera de AI_TEST_CONTACTS', async () => {
    await seedAudio(h, {
      id: 'audio.unauthorized',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });
    const provider = providerWithTranscripts({});

    const result = await processAiJobs(h.db, BIZ_A, {
      config: { ...config, testContacts: ['CO.OTRO'] },
      contactKeys: ['CO.OTRO'],
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    expect(result.enqueued).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('sirve el audio por la API sin exponer la URL privada', async () => {
    await seedAudio(h, {
      id: 'audio.proxy',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });
    // La conversación la materializa el listado; basta con crearla a mano.
    await h.client.execute({
      sql: `INSERT INTO conversations (id, business_id, wa_contact)
            VALUES ('conv-audio-proxy', ?, ?)`,
      args: [BIZ_A, contact],
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0, 0, 0]), {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      })) as typeof fetch;

    try {
      const res = await h.app.request(
        `/api/v1/conversations/conv-audio-proxy/messages/audio.proxy/audio`,
        { headers: { authorization: `Bearer ${h.tokens.a}` } },
        h.env,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('audio/ogg');
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes[0]).toBe(0x4f);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('reintenta un error temporal sin duplicar la transcripción', async () => {
    await seedAudio(h, {
      id: 'audio.retry',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });

    const failing = providerWithTranscripts(
      { 'audio.retry': 'Mi perro se llama Toby.' },
      { fail: new Set(['audio.retry']) },
    );
    await transcribeAudioMessages({
      db: h.db,
      businessId: BIZ_A,
      rows: [
        {
          messageId: 'audio.retry',
          messageType: 'audio',
          rawMessageJson: JSON.stringify({
            type: 'audio',
            kapso: { media_url: 'https://app.kapso.ai/a.ogg' },
          }),
          body: 'Audio adjunto',
        },
      ],
      provider: failing,
      config,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    }).catch(() => null);

    await h.client.execute({
      sql: "UPDATE message_transcriptions SET updated_at = datetime('now', '-5 minutes') WHERE message_id = 'audio.retry'",
    });

    const working = providerWithTranscripts({
      'audio.retry': 'Mi perro se llama Toby.',
    });
    const second = await transcribeAudioMessages({
      db: h.db,
      businessId: BIZ_A,
      rows: [
        {
          messageId: 'audio.retry',
          messageType: 'audio',
          rawMessageJson: JSON.stringify({
            type: 'audio',
            kapso: { media_url: 'https://app.kapso.ai/a.ogg' },
          }),
          body: 'Audio adjunto',
        },
      ],
      provider: working,
      config,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    expect(second.texts.get('audio.retry')).toContain('Toby');
    const rows = await h.db
      .select()
      .from(messageTranscriptions)
      .where(eq(messageTranscriptions.messageId, 'audio.retry'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.attempts).toBe(2);
  });

  it('no procesa audios de otro negocio', async () => {
    await seedAudio(h, {
      id: 'audio.other',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
      businessId: BIZ_B,
    });

    const provider = providerWithTranscripts({
      'audio.other': 'Mi perro se llama Ajeno.',
    });
    const result = await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    expect(result.processed).toBe(0);
    expect(provider.calls).toHaveLength(0);
  });

  it('con presupuesto agotado deja el audio pendiente', async () => {
    await seedAudio(h, {
      id: 'audio.budget',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });

    const provider = providerWithTranscripts({
      'audio.budget': 'Mi perro se llama Presupuesto.',
    });
    const result = await processAiJobs(h.db, BIZ_A, {
      config: { ...config, dailyBudgetUsdMicros: 1_000_000, monthlyBudgetUsdMicros: 0 },
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    expect(result.reason).toBe('budget_monthly');
    expect(provider.calls).toHaveLength(0);
    const rows = await h.db
      .select()
      .from(messageTranscriptions)
      .where(eq(messageTranscriptions.messageId, 'audio.budget'));
    expect(rows).toHaveLength(0);
  });

  it('permite corregir la transcripción y la deja por encima del texto automático', async () => {
    await seedAudio(h, {
      id: 'audio.correct',
      contact,
      phone: '573155570100',
      name: 'Audio',
      at: '2026-11-05T10:00:00Z',
    });
    const provider = providerWithTranscripts({
      'audio.correct': 'Mi perro Apolo tiene 30 años.',
    });
    await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });

    const conversation = await h.client.execute(
      "SELECT id FROM conversations WHERE business_id = ? AND wa_contact = ?",
      [BIZ_A, contact],
    );
    const conversationId = String(conversation.rows[0]?.id);
    const correction = await request(h, {
      method: 'PATCH',
      path: `/conversations/${conversationId}/messages/audio.correct/transcription`,
      token: h.tokens.a,
      payload: { text: 'Mi perro Apolo tiene 13 años.' },
    });

    expect(correction.status).toBe(200);
    expect(correction.body.data.text).toBe('Mi perro Apolo tiene 13 años.');
    expect(correction.body.data.originalText).toBe(
      'Mi perro Apolo tiene 30 años.',
    );

    const row = await h.db
      .select()
      .from(messageTranscriptions)
      .where(eq(messageTranscriptions.messageId, 'audio.correct'));
    expect(row[0]?.manualTranscript).toBe('Mi perro Apolo tiene 13 años.');

    const audit = await h.client.execute(
      "SELECT action FROM audit_log WHERE business_id = ? AND entity_id = 'audio.correct'",
      [BIZ_A],
    );
    expect(audit.rows[0]?.action).toBe('transcription.correct');

    // El mensaje vuelve a quedar pendiente de IA para reutilizar la corrección.
    const processed = await h.client.execute(
      "SELECT COUNT(*) AS n FROM ai_processed_messages WHERE business_id = ? AND message_id = 'audio.correct'",
      [BIZ_A],
    );
    expect(Number(processed.rows[0]?.n)).toBe(0);

    // Al reprocesar se usa la corrección y no quedan dos sugerencias vivas.
    const callsBefore = provider.calls.length;
    await processAiJobs(h.db, BIZ_A, {
      config,
      provider,
      loadAudio: async () => ({
        base64: OGG_BASE64,
        format: 'ogg',
        mimeType: 'audio/ogg',
        byteLength: 4,
      }),
    });
    expect(provider.calls.length).toBe(callsBefore);

    const live = await call<{
      data: Array<{
        kind: string;
        pets?: Array<{ fields: Array<{ field: string; value: unknown }> }>;
      }>;
    }>(h, h.tokens.a, 'GET', '/ai/suggestions?status=pending&limit=20');
    const petSuggestions = live.body.data.filter(
      (item) => item.kind === 'client_create' && item.pets?.length,
    );
    expect(petSuggestions).toHaveLength(1);
    expect(
      petSuggestions[0]?.pets?.[0]?.fields.find(
        (field) => field.field === 'ageYears',
      )?.value,
    ).toBe(13);
  });
});
