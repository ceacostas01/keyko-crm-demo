import { and, eq } from 'drizzle-orm';
import { aiProcessedMessages } from '@keyko/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiConfig, type AiConfig } from '../src/lib/ai/config';
import { processAiJobs } from '../src/lib/ai/jobs';
import {
  BIZ_A,
  BIZ_B,
  call,
  createClientRow,
  makeHarness,
  request,
  type ApiResponse,
  type Harness,
} from './helpers';

/**
 * Extracción con IA sobre conversaciones ficticias.
 *
 * El proveedor por defecto en pruebas es el determinista (`fake`): no hay red
 * ni costo, pero el contrato y las reglas son las mismas que con OpenRouter.
 */

let h: Harness;
let anaId: number;
let brunoId: number;
let anaLunaId: string;
let brunoLunaId: string;

const config: AiConfig = aiConfig({} as never);

async function seedMessage(options: {
  id: string;
  contact: string;
  phone: string;
  name: string;
  body: string;
  businessId?: string;
  at?: string;
}): Promise<void> {
  await h.client.execute({
    sql: `INSERT INTO whatsapp_messages
            (message_id, business_id, direction, contact_key, contact_phone,
             contact_name, message_type, body, message_timestamp, raw_message_json)
          VALUES (?, ?, 'inbound', ?, ?, ?, 'text', ?, ?, '{}')`,
    args: [
      options.id,
      options.businessId ?? BIZ_A,
      options.contact,
      options.phone,
      options.name,
      options.body,
      options.at ?? new Date().toISOString(),
    ],
  });
}

function process(token = h.tokens.a): Promise<ApiResponse> {
  return request(h, {
    method: 'POST',
    path: '/ai/process',
    token,
    payload: { limit: 50 },
  });
}

async function seedImageMessage(options: {
  id: string;
  contact: string;
  phone: string;
  name: string;
  body: string;
}): Promise<void> {
  const mediaUrl = 'https://app.kapso.ai/rails/active_storage/foto-prueba.jpeg';
  await h.client.execute({
    sql: `INSERT INTO whatsapp_messages
            (message_id, business_id, direction, contact_key, contact_phone,
             contact_name, message_type, body, message_timestamp, raw_message_json)
          VALUES (?, ?, 'inbound', ?, ?, ?, 'image', ?, ?, ?)`,
    args: [
      options.id,
      BIZ_A,
      options.contact,
      options.phone,
      options.name,
      options.body,
      new Date().toISOString(),
      JSON.stringify({
        type: 'image',
        kapso: {
          media_url: mediaUrl,
          media_data: {
            url: mediaUrl,
            filename: 'foto-prueba.jpeg',
            content_type: 'image/jpeg',
          },
        },
      }),
    ],
  });
}

async function pending(token = h.tokens.a): Promise<ApiResponse> {
  return call(h, token, 'GET', '/ai/suggestions?status=pending&limit=100');
}

function accept(id: string, token = h.tokens.a, body: Record<string, unknown> = {}) {
  return request(h, {
    method: 'POST',
    path: `/ai/suggestions/${id}/accept`,
    token,
    payload: body,
  });
}

function reject(id: string, token = h.tokens.a) {
  return request(h, {
    method: 'POST',
    path: `/ai/suggestions/${id}/reject`,
    token,
    payload: {},
  });
}

async function petOf(clientId: number, name: string) {
  const res = await call<{ data: Array<Record<string, unknown>> }>(
    h,
    h.tokens.a,
    'GET',
    `/pets?clientId=${clientId}&limit=100`,
  );
  return res.body.data.find((pet) => pet.name === name);
}

beforeAll(async () => {
  h = await makeHarness();

  anaId = await createClientRow(h, h.tokens.a, '+573101000001', 'Ana Pérez');
  brunoId = await createClientRow(h, h.tokens.a, '+573101000002', 'Bruno Díaz');

  const ana = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId: anaId,
    name: 'Luna',
    species: 'gato',
    breed: 'Siamés',
    weightKg: 4.2,
  });
  anaLunaId = ana.body.data.id;

  const bruno = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId: brunoId,
    name: 'Luna',
    species: 'perro',
  });
  brunoLunaId = bruno.body.data.id;
});

afterAll(() => h.close());

describe('cliente nuevo', () => {
  it('detecta cliente, mascota y solicitud de cita, y los crea al aprobar', async () => {
    await seedMessage({
      id: 'ai.new.1',
      contact: 'CO.1111222233334444',
      phone: '573155550001',
      name: 'Sofía',
      body: 'Hola, me llamo Sofía Ramírez y tengo una perrita llamada Nala, es una french poodle de 4 kg.',
    });
    await seedMessage({
      id: 'ai.new.2',
      contact: 'CO.1111222233334444',
      phone: '573155550001',
      name: 'Sofía',
      body: 'Quisiera agendar baño y corte para el sábado a las 10 de la mañana. ¿Tienen cupo?',
    });

    const processed = await process();
    expect(processed.status).toBe(200);
    expect(processed.body.data.processed).toBeGreaterThan(0);

    const list = await pending();
    const suggestion = list.body.data.find(
      (item: { kind: string; fields: Array<{ field: string; value: unknown }> }) =>
        item.kind === 'client_create' &&
        item.fields.some((field) => field.value === 'Sofía Ramírez'),
    );

    expect(suggestion).toBeDefined();
    expect(
      suggestion.pets[0].fields.find(
        (field: { field: string }) => field.field === 'name',
      ).value,
    ).toBe('Nala');

    const phoneField = suggestion.fields.find(
      (field: { field: string }) => field.field === 'phone',
    );
    expect(phoneField?.value).toBe('+573155550001');

    const accepted = await accept(suggestion.id);
    expect(accepted.status).toBe(200);

    const clients = await call<{ data: Array<Record<string, unknown>> }>(
      h,
      h.tokens.a,
      'GET',
      '/clients?search=Sofía&limit=100',
    );
    const created = clients.body.data.find(
      (client) => client.fullName === 'Sofía Ramírez',
    );
    expect(created).toBeDefined();

    const nala = await petOf(Number(created?.id), 'Nala');
    expect(nala).toMatchObject({
      species: 'perro',
      breed: 'french poodle',
      sex: 'hembra',
      weightKg: 4,
    });

    // La conversación queda asociada al cliente nuevo.
    const conversations = await call<{
      data: Array<{ waContact: string; clientId: number | null }>;
    }>(h, h.tokens.a, 'GET', '/conversations');
    const conversation = conversations.body.data.find(
      (row) => row.waContact === 'CO.1111222233334444',
    );
    expect(conversation?.clientId).toBe(Number(created?.id));

    // La solicitud de cita queda pendiente y no crea nada.
    const appointmentSuggestion = (await pending()).body.data.find(
      (item: { kind: string }) => item.kind === 'appointment_request',
    );
    expect(appointmentSuggestion).toBeDefined();

    const before = await h.client.execute('SELECT COUNT(*) AS n FROM appointments');
    const acceptedAppointment = await accept(appointmentSuggestion.id);
    expect(acceptedAppointment.status).toBe(200);
    const after = await h.client.execute('SELECT COUNT(*) AS n FROM appointments');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('usa el nombre de WhatsApp cuando la conversación no dice el nombre', async () => {
    await seedMessage({
      id: 'ai.waname.1',
      contact: 'CO.9999888877776666',
      phone: '573155559999',
      name: 'CA',
      body: 'Hola, tengo un perro llamado Toby.',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; contactKey: string | null }) =>
        item.kind === 'client_create' &&
        item.contactKey === 'CO.9999888877776666',
    );
    expect(suggestion).toBeDefined();

    const accepted = await accept(suggestion.id);
    expect(accepted.status).toBe(200);

    const clientId = accepted.body.data.applied.targetId;
    const detail = await call<{ data: Record<string, unknown> }>(
      h,
      h.tokens.a,
      'GET',
      `/clients/${clientId}`,
    );

    expect(detail.body.data.fullName).toBe('CA');
    expect(detail.body.data.whatsappName).toBe('CA');
    expect(await petOf(Number(clientId), 'Toby')).toBeDefined();
  });

  it('no usa un teléfono como nombre de WhatsApp', async () => {
    await seedMessage({
      id: 'ai.waname.2',
      contact: 'CO.8888777766665555',
      phone: '573155558888',
      name: '573155558888',
      body: 'Hola, tengo un gato llamado Michi.',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; contactKey: string | null }) =>
        item.kind === 'client_create' &&
        item.contactKey === 'CO.8888777766665555',
    );
    expect(suggestion).toBeDefined();

    const accepted = await accept(suggestion.id);
    const clientId = accepted.body.data.applied.targetId;
    const detail = await call<{ data: Record<string, unknown> }>(
      h,
      h.tokens.a,
      'GET',
      `/clients/${clientId}`,
    );

    expect(detail.body.data.fullName).toBeNull();
    expect(detail.body.data.whatsappName).toBeNull();
  });
});

describe('cliente existente', () => {
  it('agrega una mascota nueva sin duplicar al cliente', async () => {
    const before = await h.client.execute('SELECT COUNT(*) AS n FROM clients');

    await seedMessage({
      id: 'ai.ana.1',
      contact: '+573101000001',
      phone: '573101000001',
      name: 'Ana',
      body: 'Hola, quiero agendar un baño para mi gato Tom, es siamés y pesa 5 kg.',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; title: string }) =>
        item.kind === 'pet_create' && item.title.includes('Tom'),
    );
    expect(suggestion).toBeDefined();
    expect(suggestion.clientId).toBe(anaId);

    const accepted = await accept(suggestion.id);
    expect(accepted.status).toBe(200);

    const tom = await petOf(anaId, 'Tom');
    expect(tom).toMatchObject({ species: 'gato', breed: 'siamés', weightKg: 5 });

    const after = await h.client.execute('SELECT COUNT(*) AS n FROM clients');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('crea automáticamente una mascota nueva de un cliente existente', async () => {
    await seedMessage({
      id: 'ai.auto.pet.1',
      contact: '+573101000001',
      phone: '573101000001',
      name: 'Ana',
      body: 'Mi perro se llama Nube y tiene 3 años.',
    });

    const result = await processAiJobs(h.db, BIZ_A, {
      config: { ...config, autoCreatePets: true },
    });

    expect(result.applied).toBeGreaterThan(0);
    expect(await petOf(anaId, 'Nube')).toMatchObject({ species: 'perro' });

    const suggestions = (await pending()).body.data.filter(
      (item: { kind: string; title: string }) =>
        item.kind === 'pet_create' && item.title.includes('Nube'),
    );
    expect(suggestions).toHaveLength(0);
  });

  it('no convierte el nombre de una crema en mascota sin contexto animal', async () => {
    const { applyExtraction } = await import('../src/lib/ai/apply');

    await applyExtraction({
      db: h.db,
      businessId: BIZ_A,
      contactKey: '+573101000001',
      contactPhone: '573101000001',
      contactName: 'Ana',
      extraction: {
        client: {},
        pets: [
          {
            name: { value: 'hydra', confidence: 0.95, evidence: ['m2'] },
            species: { value: 'perro', confidence: 0.9, evidence: ['m2'] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: '',
      } as never,
      messages: [
        {
          id: 'm1',
          body: 'Si, tengo esta crema que hay que aplicarle',
          direction: 'inbound',
          at: '2026-11-03T06:06:53Z',
          contactName: 'Ana',
        },
        {
          id: 'm2',
          body: 'Se llama hydra',
          direction: 'inbound',
          at: '2026-11-03T06:07:09Z',
          contactName: 'Ana',
        },
      ],
      jobId: crypto.randomUUID(),
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreatePets: true,
      autoCreateAppointmentRequests: false,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: true,
      contactAuthorizedForPets: true,
      storeRaw: false,
    });

    expect(await petOf(anaId, 'hydra')).toBeUndefined();
  });

  it('bloquea la creación si el verificador no respalda la mascota', async () => {
    const { applyExtraction } = await import('../src/lib/ai/apply');

    await applyExtraction({
      db: h.db,
      businessId: BIZ_A,
      contactKey: '+573101000001',
      contactPhone: '573101000001',
      contactName: 'Ana',
      extraction: {
        client: {},
        pets: [
          {
            name: { value: 'Hydra', confidence: 0.95, evidence: ['v1'] },
            species: { value: 'perro', confidence: 0.9, evidence: ['v1'] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: '',
      } as never,
      messages: [
        {
          id: 'v1',
          body: 'Mi perro necesita una crema. Se llama Hydra.',
          direction: 'inbound',
          at: '',
          contactName: 'Ana',
        },
      ],
      jobId: crypto.randomUUID(),
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreatePets: true,
      autoCreateAppointmentRequests: false,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: true,
      contactAuthorizedForPets: true,
      verifyPetCandidate: async () => ({
        allowed: false,
        confidence: 0.95,
        reason: 'Hydra es el nombre de una crema',
      }),
      storeRaw: false,
    });

    expect(await petOf(anaId, 'Hydra')).toBeUndefined();
  });

  it('bloquea la creación si la foto no es un animal', async () => {
    const { applyExtraction } = await import('../src/lib/ai/apply');

    await applyExtraction({
      db: h.db,
      businessId: BIZ_A,
      contactKey: '+573101000001',
      contactPhone: '573101000001',
      contactName: 'Ana',
      extraction: {
        client: {},
        pets: [
          {
            name: { value: 'Firulais', confidence: 0.95, evidence: ['p1'] },
            species: { value: 'perro', confidence: 0.9, evidence: ['p1'] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: '',
      } as never,
      messages: [
        {
          id: 'p1',
          body: 'Mi perro se llama Firulais.',
          direction: 'inbound',
          at: '',
          contactName: 'Ana',
        },
      ],
      jobId: crypto.randomUUID(),
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreatePets: true,
      autoCreateAppointmentRequests: false,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: true,
      contactAuthorizedForPets: true,
      imageCheck: {
        present: true,
        hasAnimal: false,
        reason: 'La foto es una crema',
      },
      storeRaw: false,
    });

    expect(await petOf(anaId, 'Firulais')).toBeUndefined();
  });

  it('no crea la mascota cuando la foto del lote es un producto', async () => {
    const { createFakeProvider } = await import('../src/lib/ai/fake');

    await seedImageMessage({
      id: 'ai.vision.product.1',
      contact: '+573101000001',
      phone: '573101000001',
      name: 'Ana',
      body: 'Mi perro se llama Tobby.',
    });

    const base = createFakeProvider();
    const provider = {
      ...base,
      async classifyImage() {
        return {
          category: 'product' as const,
          hasAnimal: false,
          confidence: 0.97,
          reason: 'Es un frasco de crema',
          model: 'fake-vision',
          tokensIn: 10,
          tokensOut: 5,
          latencyMs: 1,
          costUsdMicros: 1,
        };
      },
    };

    await processAiJobs(h.db, BIZ_A, {
      config: { ...config, autoCreatePets: true, visionEnabled: true },
      provider,
      loadImage: async () => ({
        base64: 'Zm90bw==',
        mimeType: 'image/jpeg',
        byteLength: 4,
      }),
    });

    expect(await petOf(anaId, 'Tobby')).toBeUndefined();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; title: string }) =>
        item.kind === 'pet_create' && item.title.includes('Tobby'),
    );
    expect(suggestion).toBeDefined();
  });

  it('crea la mascota cuando la foto sí contiene un animal', async () => {
    const { createFakeProvider } = await import('../src/lib/ai/fake');

    await seedImageMessage({
      id: 'ai.vision.animal.1',
      contact: '+573101000001',
      phone: '573101000001',
      name: 'Ana',
      body: 'Mi perro se llama Coco.',
    });

    const base = createFakeProvider();
    const provider = {
      ...base,
      async classifyImage() {
        return {
          category: 'dog' as const,
          hasAnimal: true,
          confidence: 0.96,
          reason: 'Se ve un perro',
          model: 'fake-vision',
          tokensIn: 10,
          tokensOut: 5,
          latencyMs: 1,
          costUsdMicros: 1,
        };
      },
    };

    await processAiJobs(h.db, BIZ_A, {
      config: { ...config, autoCreatePets: true, visionEnabled: true },
      provider,
      loadImage: async () => ({
        base64: 'Zm90bw==',
        mimeType: 'image/jpeg',
        byteLength: 4,
      }),
    });

    expect(await petOf(anaId, 'Coco')).toMatchObject({ species: 'perro' });
  });

  it('infiere perro o gato desde una raza explícita', async () => {
    const { applyExtraction } = await import('../src/lib/ai/apply');

    await applyExtraction({
      db: h.db,
      businessId: BIZ_A,
      contactKey: '+573101000001',
      contactPhone: '573101000001',
      contactName: 'Ana',
      extraction: {
        client: {},
        pets: [
          {
            name: { value: 'Keiko', confidence: 0.95, evidence: ['r1'] },
            breed: { value: 'beagle', confidence: 0.9, evidence: ['r1'] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: '',
      } as never,
      messages: [
        {
          id: 'r1',
          body: 'Quisiera agendar otra mascota que se llama Keiko. Es un beagle.',
          direction: 'inbound',
          at: '',
          contactName: 'Ana',
        },
      ],
      jobId: crypto.randomUUID(),
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreatePets: true,
      autoCreateAppointmentRequests: false,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: true,
      contactAuthorizedForPets: true,
      storeRaw: false,
    });

    expect(await petOf(anaId, 'Keiko')).toMatchObject({
      species: 'perro',
      breed: 'beagle',
    });
  });

  it('un cliente con dos mascotas nuevas las crea por separado', async () => {
    await seedMessage({
      id: 'ai.two.1',
      contact: 'CO.TWO0000000000000',
      phone: '573155550002',
      name: 'Dos',
      body: 'Buenas, me llamo Carla Gómez. Tengo un perro llamado Bruno y una gata llamada Misha.',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; fields: Array<{ value: unknown }> }) =>
        item.kind === 'client_create' &&
        item.fields.some((field) => field.value === 'Carla Gómez'),
    );
    expect(suggestion).toBeDefined();
    expect(suggestion.pets).toHaveLength(2);

    await accept(suggestion.id);

    const clients = await call<{ data: Array<Record<string, unknown>> }>(
      h,
      h.tokens.a,
      'GET',
      '/clients?search=Carla&limit=100',
    );
    const carla = clients.body.data.find((row) => row.fullName === 'Carla Gómez');
    expect(carla).toBeDefined();

    expect(await petOf(Number(carla?.id), 'Bruno')).toBeDefined();
    expect(await petOf(Number(carla?.id), 'Misha')).toBeDefined();
  });
});

describe('mascotas con el mismo nombre', () => {
  it('actualiza la mascota del dueño correcto', async () => {
    await seedMessage({
      id: 'ai.bruno.1',
      contact: '+573101000002',
      phone: '573101000002',
      name: 'Bruno',
      body: 'Hola, mi perra Luna es una poodle y pesa 12 kg.',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; petId: string | null }) =>
        item.kind === 'pet_update' && item.petId === brunoLunaId,
    );
    expect(suggestion).toBeDefined();

    await accept(suggestion.id);

    const brunoLuna = await petOf(brunoId, 'Luna');
    expect(brunoLuna).toMatchObject({ breed: 'poodle', weightKg: 12 });

    const anaLuna = await petOf(anaId, 'Luna');
    expect(anaLuna).toMatchObject({ breed: 'Siamés', weightKg: 4.2 });
  });
});

describe('calidad de los datos', () => {
  it('un mensaje sin datos no genera sugerencias', async () => {
    await seedMessage({
      id: 'ai.empty.1',
      contact: 'CO.EMPTY00000000000',
      phone: '573155550003',
      name: 'Vacío',
      body: 'Hola, buenas tardes.',
    });

    const result = await process();
    expect(result.body.data.processed).toBeGreaterThan(0);

    const list = await pending();
    const related = list.body.data.filter(
      (item: { title: string }) => item.title.includes('Vacío'),
    );
    expect(related).toHaveLength(0);
  });

  it('marca contradicciones y no sobrescribe lo existente', async () => {
    await seedMessage({
      id: 'ai.conflict.1',
      contact: '+573101000001',
      phone: '573101000001',
      name: 'Ana',
      body: 'Mi gata Luna es una poodle, ¿la pueden bañar?',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; petId: string | null }) =>
        item.kind === 'pet_update' && item.petId === anaLunaId,
    );
    expect(suggestion).toBeDefined();

    const breed = suggestion.fields.find(
      (field: { field: string }) => field.field === 'breed',
    );
    expect(breed.conflict).toBe(true);

    await accept(suggestion.id);

    const luna = await petOf(anaId, 'Luna');
    expect(luna?.breed).toBe('Siamés');
  });

  it('no repite el procesamiento de los mismos mensajes', async () => {
    const before = await pending();
    const again = await process();

    expect(again.body.data.enqueued).toBe(0);
    const after = await pending();
    expect(after.body.data).toHaveLength(before.body.data.length);
  });

  it('una mascota mencionada varias veces aparece una sola vez', async () => {
    await seedMessage({
      id: 'ai.repeat.1',
      contact: 'CO.REPEAT0000000000',
      phone: '573155550004',
      name: 'Repite',
      body: 'Me llamo Diego Ruiz. Mi perro Rocky es juguetón. Rocky pesa 3 kg.',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; fields: Array<{ value: unknown }> }) =>
        item.kind === 'client_create' &&
        item.fields.some((field) => field.value === 'Diego Ruiz'),
    );
    expect(suggestion).toBeDefined();
    expect(suggestion.pets).toHaveLength(1);
    expect(suggestion.pets[0].fields[0].value).toBe('Rocky');
  });
});

describe('correcciones manuales', () => {
  it('la IA no sobrescribe un campo editado a mano', async () => {
    // Se fija la raza a mano: queda como override.
    await call(h, h.tokens.a, 'PATCH', `/pets/${brunoLunaId}`, {
      breed: 'Criollo',
    });

    await seedMessage({
      id: 'ai.override.1',
      contact: '+573101000002',
      phone: '573101000002',
      name: 'Bruno',
      body: 'Mi perra Luna es una beagle, ¿le pueden cortar las uñas?',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; petId: string | null }) =>
        item.kind === 'pet_update' && item.petId === brunoLunaId,
    );

    if (suggestion) {
      expect(
        suggestion.fields.some((field: { field: string }) => field.field === 'breed'),
      ).toBe(false);
    }

    const luna = await petOf(brunoId, 'Luna');
    expect(luna?.breed).toBe('Criollo');
  });

  it('aplicar una corrección manual guarda el valor corregido', async () => {
    await seedMessage({
      id: 'ai.correct.1',
      contact: 'CO.CORRECT000000000',
      phone: '573155550005',
      name: 'Corrige',
      body: 'Hola, me llamo Paula Mesa y tengo un gato llamado Simón.',
    });

    await process();

    const suggestion = (await pending()).body.data.find(
      (item: { kind: string; fields: Array<{ value: unknown }> }) =>
        item.kind === 'client_create' &&
        item.fields.some((field) => field.value === 'Paula Mesa'),
    );
    expect(suggestion).toBeDefined();

    await accept(suggestion.id, h.tokens.a, { fields: { fullName: 'Paula Mesa R.' } });

    const clients = await call<{ data: Array<Record<string, unknown>> }>(
      h,
      h.tokens.a,
      'GET',
      '/clients?search=Paula&limit=100',
    );
    expect(clients.body.data.some((row) => row.fullName === 'Paula Mesa R.')).toBe(true);
  });
});

describe('límites y fallos', () => {
  it('un proveedor caído deja el job para reintento y no marca los mensajes', async () => {
    await seedMessage({
      id: 'ai.fail.1',
      contact: 'CO.FAIL000000000000',
      phone: '573155550006',
      name: 'Falla',
      body: 'Me llamo Inés Rojas y tengo una perra llamada Kiara.',
    });

    const failing = {
      name: 'failing',
      async extract(): Promise<never> {
        throw new Error('proveedor caído');
      },
    };

    const result = await processAiJobs(h.db, BIZ_A, { config, provider: failing });
    expect(result.failed).toBeGreaterThan(0);

    const processed = await h.db
      .select()
      .from(aiProcessedMessages)
      .where(eq(aiProcessedMessages.messageId, 'ai.fail.1'));
    expect(processed).toHaveLength(0);

    const retry = await processAiJobs(h.db, BIZ_A, { config });
    expect(retry.processed).toBeGreaterThan(0);

    const processedAfter = await h.db
      .select()
      .from(aiProcessedMessages)
      .where(eq(aiProcessedMessages.messageId, 'ai.fail.1'));
    expect(processedAfter).toHaveLength(1);
  });

  it('respeta el presupuesto diario', async () => {
    await seedMessage({
      id: 'ai.budget.1',
      contact: 'CO.BUDGET0000000000',
      phone: '573155550007',
      name: 'Presupuesto',
      body: 'Me llamo Sara Luna y tengo un perro llamado Zeus.',
    });

    const result = await processAiJobs(h.db, BIZ_A, {
      config: { ...config, dailyBudgetUsdMicros: 0 },
    });

    expect(result.skipped).toBeGreaterThan(0);
    expect(result.reason).toBe('budget_daily');
  });

  it('se puede desactivar por completo', async () => {
    const result = await processAiJobs(h.db, BIZ_A, {
      config: { ...config, enabled: false },
    });
    expect(result.reason).toBe('disabled');
    expect(result.processed).toBe(0);
  });

  it('con auto-aplicación crea cliente y mascota sin revisión', async () => {
    await seedMessage({
      id: 'ai.auto.1',
      contact: 'CO.AUTO000000000000',
      phone: '573155550008',
      name: 'Auto',
      body: 'Me llamo Laura Cifuentes y tengo una gata llamada Mía.',
    });

    const result = await processAiJobs(h.db, BIZ_A, {
      config: { ...config, autoApply: true },
    });
    expect(result.applied).toBeGreaterThan(0);

    const clients = await call<{ data: Array<Record<string, unknown>> }>(
      h,
      h.tokens.a,
      'GET',
      '/clients?search=Laura&limit=100',
    );
    const created = clients.body.data.find(
      (row) => row.fullName === 'Laura Cifuentes',
    );
    expect(created).toBeDefined();
    expect(await petOf(Number(created?.id), 'Mía')).toBeDefined();
  });
});

describe('aislamiento', () => {
  it('cada negocio solo procesa y ve sus conversaciones', async () => {
    await seedMessage({
      id: 'ai.beta.1',
      businessId: BIZ_B,
      contact: 'CO.BETA000000000000',
      phone: '573155550009',
      name: 'Beta',
      body: 'Me llamo Valentina Ruiz y tengo un perro llamado Coco.',
    });

    await process(h.tokens.a);

    const fromA = await pending(h.tokens.a);
    expect(
      fromA.body.data.some(
        (item: { title: string }) => item.title.includes('Valentina'),
      ),
    ).toBe(false);

    await process(h.tokens.b);
    const fromB = await pending(h.tokens.b);
    expect(
      fromB.body.data.some(
        (item: { kind: string; fields: Array<{ value: unknown }> }) =>
          item.kind === 'client_create' &&
          item.fields.some((field) => field.value === 'Valentina Ruiz'),
      ),
    ).toBe(true);
  });

  it('no se puede aceptar una sugerencia de otro negocio', async () => {
    const fromB = await pending(h.tokens.b);
    const suggestion = fromB.body.data[0];
    expect(suggestion).toBeDefined();

    const res = await accept(suggestion.id, h.tokens.a);
    expect(res.status).toBe(404);
  });
});

describe('descartar', () => {
  it('marca la sugerencia como rechazada y no crea nada', async () => {
    await seedMessage({
      id: 'ai.reject.1',
      contact: 'CO.REJECT0000000000',
      phone: '573155550010',
      name: 'Rechaza',
      body: 'Me llamo Tomás Vera y tengo un perro llamado Rex.',
    });

    await process();

    const list = await pending();
    const suggestion = list.body.data.find(
      (item: { kind: string; fields: Array<{ value: unknown }> }) =>
        item.kind === 'client_create' &&
        item.fields.some((field) => field.value === 'Tomás Vera'),
    );
    expect(suggestion).toBeDefined();

    const rejected = await reject(suggestion.id);
    expect(rejected.status).toBe(200);

    const clients = await call<{ data: Array<Record<string, unknown>> }>(
      h,
      h.tokens.a,
      'GET',
      '/clients?search=Tomás&limit=100',
    );
    expect(clients.body.data).toHaveLength(0);

    const again = await reject(suggestion.id);
    expect(again.status).toBe(409);
  });
});

describe('clasificación de intenciones', () => {
  async function classify(body: string, contact: string) {
    const before = new Set(
      (await pending()).body.data.map((item: { id: string }) => item.id),
    );

    await seedMessage({
      id: `ai.intent.${contact}`,
      contact,
      phone: `57315556${contact.slice(-4)}`,
      name: 'Consulta',
      body,
    });
    await process();
    const list = await pending();
    return list.body.data
      .filter((item: { id: string }) => !before.has(item.id))
      .filter((item: { kind: string }) =>
        ['service_inquiry', 'availability_inquiry', 'appointment_request'].includes(
          item.kind,
        ),
      );
  }

  it('una pregunta de precio es consulta de servicio, no cita', async () => {
    const before = await h.client.execute('SELECT COUNT(*) AS n FROM appointments');

    const suggestions = await classify(
      'Hola, ¿cuánto cuesta el corte completo para un perro mediano?',
      'CO.PRICE00000000001',
    );

    expect(
      suggestions.some((item: { kind: string }) => item.kind === 'service_inquiry'),
    ).toBe(true);
    expect(
      suggestions.some((item: { kind: string }) => item.kind === 'appointment_request'),
    ).toBe(false);

    const after = await h.client.execute('SELECT COUNT(*) AS n FROM appointments');
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('preguntar por cupo es consulta de disponibilidad', async () => {
    const suggestions = await classify(
      'Hola, ¿tienen cupo para el sábado en la tarde?',
      'CO.SLOT00000000002',
    );

    expect(
      suggestions.some(
        (item: { kind: string }) => item.kind === 'availability_inquiry',
      ),
    ).toBe(true);
    expect(
      suggestions.some((item: { kind: string }) => item.kind === 'appointment_request'),
    ).toBe(false);
  });

  it('pedir cita explícitamente sí es solicitud de cita', async () => {
    const suggestions = await classify(
      'Quiero agendar una cita para el sábado a las 10 de la mañana.',
      'CO.BOOK00000000003',
    );

    expect(
      suggestions.some((item: { kind: string }) => item.kind === 'appointment_request'),
    ).toBe(true);
  });
});

describe('contactos sin nombre', () => {
  it('crea el contacto por WhatsApp y lo completa cuando llega el nombre', async () => {
    await seedMessage({
      id: 'ai.noname.1',
      contact: 'CO.NONAME000000004',
      phone: '573155560004',
      name: 'Sin nombre',
      body: 'Hola, ¿cuánto cuesta el baño?',
    });

    await process();

    const list = await pending();
    const suggestion = list.body.data.find(
      (item: { kind: string; title: string }) =>
        item.kind === 'client_create' && item.title.includes('Contacto nuevo'),
    );
    expect(suggestion).toBeDefined();
    expect(
      suggestion.fields.some(
        (field: { field: string; value: unknown }) =>
          field.field === 'phone' && field.value === '+573155560004',
      ),
    ).toBe(true);

    await accept(suggestion.id);

    const created = await h.client.execute(
      "SELECT id, full_name, whatsapp_contact_key FROM clients WHERE whatsapp_contact_key = 'CO.NONAME000000004'",
    );
    expect(created.rows).toHaveLength(1);
    expect(created.rows[0]?.full_name).toBeNull();
    const clientId = Number(created.rows[0]?.id);

    // Llega el nombre en otro mensaje: se completa la ficha.
    await seedMessage({
      id: 'ai.noname.2',
      contact: 'CO.NONAME000000004',
      phone: '573155560004',
      name: 'Sin nombre',
      body: 'Perdón, me llamo Lucía Pardo.',
    });

    await process();

    const refresh = await pending();
    const update = refresh.body.data.find(
      (item: { kind: string; clientId: number | null }) =>
        item.kind === 'client_update' && item.clientId === clientId,
    );
    expect(update).toBeDefined();

    await accept(update.id);

    const updated = await h.client.execute({
      sql: 'SELECT full_name FROM clients WHERE id = ?',
      args: [clientId],
    });
    expect(updated.rows[0]?.full_name).toBe('Lucía Pardo');
  });
});

describe('BSUID vs teléfono', () => {
  it('un BSUID con dígitos parecidos a un teléfono no se confunde con el cliente', async () => {
    // El teléfono de Ana es +573101000001. Este BSUID contiene esos dígitos.
    await seedMessage({
      id: 'ai.bsuid.1',
      contact: 'CO.573101000001999',
      phone: '573109998888',
      name: 'Otra persona',
      body: 'Hola, me llamo Verónica Salas y tengo una perra llamada Canela.',
    });

    await process();

    const list = await pending();
    const suggestion = list.body.data.find(
      (item: { kind: string; fields: Array<{ value: unknown }> }) =>
        item.kind === 'client_create' &&
        item.fields.some((field) => field.value === 'Verónica Salas'),
    );

    expect(suggestion).toBeDefined();
    // No se asoció a Ana: se propone un cliente nuevo.
    expect(suggestion.clientId).toBeNull();

    const anaLuna = await petOf(anaId, 'Luna');
    expect(anaLuna).toBeDefined();
    const canela = await petOf(anaId, 'Canela');
    expect(canela).toBeUndefined();
  });
});

describe('presupuesto y retención', () => {
  it('bloquea por presupuesto mensual cuando el diario aún alcanza', async () => {
    await seedMessage({
      id: 'ai.monthly.1',
      contact: 'CO.MONTH00000000005',
      phone: '573155560005',
      name: 'Mensual',
      body: 'Me llamo Rosa Melo y tengo un gato llamado Pipo.',
    });

    const result = await processAiJobs(h.db, BIZ_A, {
      config: {
        ...config,
        dailyBudgetUsdMicros: 1_000_000,
        monthlyBudgetUsdMicros: 0,
      },
    });

    expect(result.reason).toBe('budget_monthly');
  });

  it('genera alerta al 80% del presupuesto diario', async () => {
    // Se simula gasto previo sin llamar al proveedor.
    await h.client.execute({
      sql: `INSERT INTO ai_usage (id, business_id, model, tokens_in, tokens_out, cost_usd_micros, created_at)
            VALUES ('usage-alert-1', 'biz-alfa', 'test', 0, 0, 85000, datetime('now'))`,
    });

    await seedMessage({
      id: 'ai.alert.1',
      contact: 'CO.ALERT00000000006',
      phone: '573155560006',
      name: 'Alerta',
      body: 'Hola, ¿cuánto cuesta el baño?',
    });

    await processAiJobs(h.db, BIZ_A, {
      config: { ...config, dailyBudgetUsdMicros: 100_000 },
    });

    const alerts = await h.client.execute(
      "SELECT kind, threshold FROM ai_alerts WHERE business_id = 'biz-alfa'",
    );
    expect(
      alerts.rows.some(
        (row) => row.kind === 'daily_budget' && Number(row.threshold) === 80,
      ),
    ).toBe(true);
  });

  it('borra la respuesta cruda antigua y conserva lo estructurado', async () => {
    await h.client.execute({
      sql: `INSERT INTO ai_extractions
              (id, business_id, source_type, source_id, model, prompt_version,
               raw_response, parsed_json, confidence, status, created_at)
            VALUES ('old-extraction', 'biz-alfa', 'message', 'job-viejo', 'test', 'v1',
                    'respuesta cruda larga', '{"kind":"client_update"}', 0.5, 'pending',
                    datetime('now', '-30 days'))`,
    });

    const res = await request(h, {
      method: 'POST',
      path: '/ai/prune',
      token: h.tokens.a,
      payload: {},
    });

    expect(res.status).toBe(200);
    expect(res.body.data.cleared).toBeGreaterThan(0);

    const row = await h.client.execute(
      "SELECT raw_response, parsed_json FROM ai_extractions WHERE id = 'old-extraction'",
    );
    expect(row.rows[0]?.raw_response).toBe('');
    expect(row.rows[0]?.parsed_json).toContain('client_update');
  });
});

describe('guardas anti-invención', () => {
  function extractionWith(partial: Record<string, unknown>) {
    return {
      client: {},
      pets: [],
      conversation: { openQuestions: [] },
      summary: '',
      ...partial,
    } as never;
  }

  it('no acepta el nombre de perfil si no se dijo en el mensaje', async () => {
    const { guardExtraction } = await import('../src/lib/ai/apply');

    const extraction = extractionWith({
      client: {
        fullName: { value: 'Ana', confidence: 0.9, evidence: ['m1'] },
      },
    });

    guardExtraction(extraction, [
      { id: 'm1', body: 'Quiero agendar un baño mañana.', direction: 'inbound', at: '', contactName: 'Ana' },
    ]);

    expect((extraction as { client: Record<string, unknown> }).client.fullName).toBeUndefined();
  });

  it('acepta el nombre cuando aparece completo', async () => {
    const { guardExtraction } = await import('../src/lib/ai/apply');

    const extraction = extractionWith({
      client: {
        fullName: { value: 'Sofía Ramírez', confidence: 0.9, evidence: ['m1'] },
      },
    });

    guardExtraction(extraction, [
      { id: 'm1', body: 'Hola, me llamo Sofía Ramírez.', direction: 'inbound', at: '', contactName: 'Sofi' },
    ]);

    expect(
      (extraction as { client: { fullName?: { value: string } } }).client.fullName?.value,
    ).toBe('Sofía Ramírez');
  });

  it('acepta "6 meses" como 0.5 años', async () => {
    const { guardExtraction } = await import('../src/lib/ai/apply');

    const extraction = extractionWith({
      pets: [
        {
          name: { value: 'Dino', confidence: 0.9, evidence: ['m1'] },
          ageYears: { value: 0.5, confidence: 0.9, evidence: ['m1'] },
        },
      ],
    });

    guardExtraction(extraction, [
      { id: 'm1', body: 'Dino tiene 6 meses.', direction: 'inbound', at: '', contactName: 'Lorena' },
    ]);

    expect(
      (extraction as { pets: Array<{ ageYears?: { value: number } }> }).pets[0]
        ?.ageYears?.value,
    ).toBe(0.5);
  });

  it('descarta un teléfono deducido del BSUID', async () => {
    const { guardExtraction } = await import('../src/lib/ai/apply');

    const extraction = extractionWith({
      client: {
        phone: { value: '+573101000001', confidence: 0.9, evidence: ['m1'] },
      },
    });

    guardExtraction(extraction, [
      { id: 'm1', body: 'Hola, tengo una perra llamada Canela.', direction: 'inbound', at: '', contactName: 'BSUID' },
    ]);

    expect((extraction as { client: Record<string, unknown> }).client.phone).toBeUndefined();
  });

  it('descarta el sexo inferido del artículo', async () => {
    const { guardExtraction } = await import('../src/lib/ai/apply');

    const extraction = extractionWith({
      pets: [
        {
          name: { value: 'Bruno', confidence: 0.9, evidence: ['m1'] },
          sex: { value: 'macho', confidence: 0.8, evidence: ['m1'] },
        },
      ],
    });

    guardExtraction(extraction, [
      { id: 'm1', body: 'Tengo un perro llamado Bruno.', direction: 'inbound', at: '', contactName: 'X' },
    ]);

    expect(
      (extraction as { pets: Array<{ sex?: unknown }> }).pets[0]?.sex,
    ).toBeUndefined();
  });
});

describe('nombres parciales', () => {
  it('"Ana" no contradice a "Ana Pérez"', async () => {
    const { applyExtraction } = await import('../src/lib/ai/apply');

    const db = h.db;
    const before = await h.client.execute('SELECT COUNT(*) AS n FROM ai_extractions');

    await applyExtraction({
      db,
      businessId: BIZ_A,
      contactKey: '+573101000001',
      contactPhone: '573101000001',
      contactName: 'Ana',
      extraction: {
        client: {
          fullName: { value: 'Ana', confidence: 0.9, evidence: ['x'] },
        },
        pets: [],
        conversation: { openQuestions: [] },
        summary: '',
      } as never,
      messages: [
        { id: 'x', body: 'Hola Ana, te confirmo la cita.', direction: 'outbound', at: '', contactName: 'Ana' },
      ],
      jobId: 'job-partial-name',
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreateAppointmentRequests: false,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: false,
      storeRaw: false,
    });

    const after = await h.client.execute('SELECT COUNT(*) AS n FROM ai_extractions');
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));
  });

  it('no duplica la mascota si el nombre es una variante del existente', async () => {
    const { applyExtraction } = await import('../src/lib/ai/apply');

    const created = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId: anaId,
      name: 'Rocco',
      species: 'perro',
    });
    expect(created.status).toBe(201);

    await applyExtraction({
      db: h.db,
      businessId: BIZ_A,
      contactKey: '+573101000001',
      contactPhone: '573101000001',
      contactName: 'Ana',
      extraction: {
        client: {},
        pets: [
          {
            name: { value: 'Rocco Pérez', confidence: 0.95, evidence: ['x'] },
            species: { value: 'perro', confidence: 0.9, evidence: ['x'] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: '',
      } as never,
      messages: [
        {
          id: 'x',
          body: 'Mi perro Rocco Pérez tiene 4 años.',
          direction: 'inbound',
          at: '',
          contactName: 'Ana',
        },
      ],
      jobId: 'job-partial-pet-name',
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreatePets: true,
      autoCreateAppointmentRequests: false,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: false,
      contactAuthorizedForPets: true,
      storeRaw: false,
    });

    const rows = await h.client.execute({
      sql: "SELECT name FROM pets WHERE business_id = ? AND client_id = ? AND name LIKE 'Rocco%'",
      args: [BIZ_A, anaId],
    });
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.name).toBe('Rocco');
  });
});


describe('métricas y retención de consumo', () => {
  it('un fallo del proveedor queda registrado como error sin costo', async () => {
    const before = await h.client.execute(
      "SELECT COUNT(*) AS n FROM ai_usage WHERE error IS NOT NULL",
    );

    await seedMessage({
      id: 'ai.error.1',
      contact: 'CO.ERROR00000000001',
      phone: '573155570021',
      name: 'Error',
      body: 'Me llamo Error Prueba y tengo un perro llamado Duque.',
    });

    const failing = {
      name: 'failing',
      async extract(): Promise<never> {
        throw new Error('proveedor caído para métrica');
      },
    };

    await processAiJobs(h.db, BIZ_A, { config, provider: failing });

    const after = await h.client.execute(
      "SELECT COUNT(*) AS n FROM ai_usage WHERE error IS NOT NULL",
    );
    expect(Number(after.rows[0]?.n)).toBeGreaterThan(Number(before.rows[0]?.n));

    const usage = await call(h, h.tokens.a, 'GET', '/ai/usage');
    expect(usage.body.data.errors).toBeGreaterThanOrEqual(1);
  });

  it('agrega el consumo antiguo por mes y borra el detalle', async () => {
    await h.client.execute({
      sql: `INSERT INTO ai_usage (id, business_id, model, tokens_in, tokens_out,
                                  cost_usd_micros, latency_ms, error, created_at)
            VALUES ('old-usage-1', 'biz-alfa', 'test-model', 100, 50, 1200, 800, NULL,
                    datetime('now', '-200 days')),
                   ('old-usage-2', 'biz-alfa', 'test-model', 10, 0, 0, NULL,
                    'fallo', datetime('now', '-200 days'))`,
    });

    const res = await request(h, {
      method: 'POST',
      path: '/ai/prune',
      token: h.tokens.a,
      payload: {},
    });
    expect(res.status).toBe(200);
    expect(res.body.data.prunedUsageRows).toBeGreaterThanOrEqual(2);

    const kept = await h.client.execute(
      "SELECT COUNT(*) AS n FROM ai_usage WHERE id LIKE 'old-usage-%'",
    );
    expect(Number(kept.rows[0]?.n)).toBe(0);

    const monthly = await h.client.execute(
      "SELECT calls, errors, tokens_in, tokens_out FROM ai_usage_monthly WHERE business_id = 'biz-alfa'",
    );
    const row = monthly.rows.find(
      (entry) => Number(entry.tokens_in) >= 100,
    );
    expect(row).toBeDefined();
    expect(Number(row?.calls)).toBeGreaterThanOrEqual(2);
    expect(Number(row?.errors)).toBeGreaterThanOrEqual(1);

    const usage = await call(h, h.tokens.a, 'GET', '/ai/usage');
    expect(Array.isArray(usage.body.data.monthlyUsage)).toBe(true);
    expect(usage.body.data.monthlyUsage.length).toBeGreaterThan(0);
  });
});

describe('tolerancia al formato del modelo', () => {
  it('descarta un campo sin valor en vez de fallar toda la extracción', async () => {
    const { parseExtraction } = await import('../src/lib/ai/schema');

    const parsed = parseExtraction(
      JSON.stringify({
        client: { fullName: { value: 'Ana', confidence: 0.9, evidence: [] } },
        pets: [],
        conversation: {
          notes: { confidence: 0.7, evidence: ['m1'] },
          openQuestions: [],
        },
        summary: 'x',
      }),
    );

    expect(parsed.client.fullName?.value).toBe('Ana');
    expect(parsed.conversation.notes).toBeUndefined();
  });

  it('normaliza sexo y especie en mayúsculas o sinónimos', async () => {
    const { parseExtraction } = await import('../src/lib/ai/schema');

    const parsed = parseExtraction(
      JSON.stringify({
        client: {},
        pets: [
          {
            name: { value: 'Luna', confidence: 0.9, evidence: [] },
            species: { value: 'Gato', confidence: 0.9, evidence: [] },
            sex: { value: 'Hembra', confidence: 0.9, evidence: [] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: '',
      }),
    );

    expect(parsed.pets[0]?.species?.value).toBe('gato');
    expect(parsed.pets[0]?.sex?.value).toBe('hembra');
  });

  it('acepta edades fraccionarias para cachorros de meses', async () => {
    const { parseExtraction } = await import('../src/lib/ai/schema');

    const parsed = parseExtraction(
      JSON.stringify({
        client: {},
        pets: [
          {
            name: { value: 'Dino', confidence: 0.9, evidence: [] },
            ageYears: { value: 0.5, confidence: 0.9, evidence: [] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: '',
      }),
    );

    expect(parsed.pets[0]?.ageYears?.value).toBe(0.5);
  });
});
