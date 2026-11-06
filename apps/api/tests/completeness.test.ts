import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CLIENT_PROFILE,
  PET_PROFILE,
  computeClientCompleteness,
  computePetCompleteness,
  isPlaceholderName,
} from '@keyko/domain';
import {
  BIZ_A,
  BIZ_B,
  call,
  createClientRow,
  makeHarness,
  request,
  type Harness,
} from './helpers';

let h: Harness;

async function makePet(
  clientId: number,
  name: string,
  extra: Record<string, unknown> = {},
): Promise<{
  id: string;
  completeness: { percent: number; missing: string[]; applicable: number };
}> {
  const res = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name,
    ...extra,
  });
  if (res.status !== 201) {
    throw new Error(`No se pudo crear ${name}: ${JSON.stringify(res.body)}`);
  }
  return { id: res.body.data.id, completeness: res.body.data.completeness };
}

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(() => h.close());

describe('cálculo determinista', () => {
  it('un contacto con solo teléfono está al 50%', () => {
    const result = computeClientCompleteness({
      phone: '+573001112233',
      whatsappContactKey: 'CO.123',
      fullName: null,
    });

    expect(result.percent).toBe(50);
    expect(result.complete).toContain('contact');
    expect(result.missing).toContain('name');
    expect(result.earned).toBe(50);
    expect(result.applicable).toBe(100);
  });

  it('un cliente con nombre está al 100%', () => {
    const result = computeClientCompleteness({
      phone: '+573001112233',
      whatsappContactKey: '+573001112233',
      fullName: 'Ana Pérez',
    });

    expect(result.percent).toBe(100);
  });

  it('los marcadores no cuentan como nombre', () => {
    for (const placeholder of ['Cliente WhatsApp', 'Nuevo', 'Sin nombre', '']) {
      expect(isPlaceholderName(placeholder)).toBe(true);
      const result = computeClientCompleteness({
        phone: '+573001112233',
        whatsappContactKey: '+573001112233',
        fullName: placeholder,
      });
      expect(result.percent).toBe(50);
    }
  });

  it('una mascota con solo nombre pesa 25 de 100', () => {
    const result = computePetCompleteness({
      name: 'Luna',
      species: null,
      breed: null,
      weightKg: null,
      birthdate: null,
      sex: null,
      photoUrl: null,
    });

    expect(result.percent).toBe(25);
    expect(result.missing).toEqual(
      expect.arrayContaining(['species', 'breed', 'sizeOrWeight', 'age', 'sex', 'photo']),
    );
  });

  it('una mascota completa llega al 100%', () => {
    const result = computePetCompleteness({
      name: 'Luna',
      species: 'gato',
      breed: 'Siamés',
      weightKg: 4.2,
      birthdate: '2022-01-15',
      sex: 'hembra',
      photoUrl: 'https://cdn.example.com/luna.jpg',
    });

    expect(result.percent).toBe(100);
    expect(result.missing).toHaveLength(0);
  });

  it('los campos no aplicables salen del denominador', () => {
    const result = computePetCompleteness(
      {
        name: 'Luna',
        species: 'gato',
        breed: null,
        weightKg: null,
        birthdate: null,
        sex: null,
        photoUrl: null,
        profileFlagsJson: JSON.stringify({ na: ['photo', 'sex'] }),
      },
    );

    // 25 + 15 = 40 de 75 aplicables.
    expect(result.earned).toBe(40);
    expect(result.applicable).toBe(75);
    expect(result.percent).toBe(53);
    expect(result.notApplicable).toEqual(expect.arrayContaining(['photo', 'sex']));
  });

  it('los campos desconocidos no suman pero siguen contando', () => {
    const result = computePetCompleteness({
      name: 'Luna',
      species: 'gato',
      breed: null,
      weightKg: null,
      birthdate: null,
      sex: null,
      photoUrl: null,
      profileFlagsJson: JSON.stringify({ unknown: ['breed'] }),
    });

    expect(result.applicable).toBe(100);
    expect(result.unknown).toContain('breed');
    expect(result.percent).toBe(40);
  });

  it('las prioridades se ordenan por peso', () => {
    const result = computePetCompleteness({
      name: 'Luna',
      species: 'gato',
      breed: null,
      weightKg: null,
      birthdate: null,
      sex: null,
      photoUrl: null,
    });

    expect(result.priorities[0]?.key).toBe('photo');
    expect(result.priorities[0]?.weight).toBe(20);
  });

  it('los pesos están centralizados y suman 100', () => {
    const sum = (profile: Array<{ weight: number }>) =>
      profile.reduce((total, field) => total + field.weight, 0);

    expect(sum(CLIENT_PROFILE)).toBe(100);
    expect(sum(PET_PROFILE)).toBe(100);
  });
});

describe('integración con la ficha', () => {
  it('el listado y la ficha devuelven completitud', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573105560001', 'Ana Test');

    const pet = await makePet(clientId, 'Luna', {
      species: 'gato',
      breed: 'Siamés',
    });

    expect(pet.completeness.percent).toBe(55);

    const detail = await call(
      h,
      h.tokens.a,
      'GET',
      `/pets/${pet.id}`,
    );

    expect(detail.status).toBe(200);
    expect(detail.body.data.completeness.percent).toBe(55);
    expect(detail.body.data.completeness.missing).toContain('photo');

    const list = await call(
      h,
      h.tokens.a,
      'GET',
      '/pets?limit=100',
    );
    const row = list.body.data.find((item: { id: string }) => item.id === pet.id);
    expect(row.completeness.percent).toBe(55);
  });

  it('editar la ficha actualiza el porcentaje al instante', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573105560002', 'Edita Test');
    const pet = await makePet(clientId, 'Toby', { species: 'perro' });

    expect(pet.completeness.percent).toBe(40);

    const patched = await call(
      h,
      h.tokens.a,
      'PATCH',
      `/pets/${pet.id}`,
      { weightKg: 9, sex: 'macho', birthdate: '2023-05-01' },
    );

    expect(patched.body.data.completeness.percent).toBe(65);

    const withPhoto = await call(h, h.tokens.a, 'PATCH', `/pets/${pet.id}`, {
      photoUrl: 'https://cdn.example.com/toby.jpg',
    });
    expect(withPhoto.body.data.completeness.percent).toBe(85);
  });

  it('una sugerencia pendiente no cuenta como completada', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573105560003', 'Pendiente Test');
    const pet = await makePet(clientId, 'Nala', { species: 'gato' });

    expect(pet.completeness.percent).toBe(40);

    await h.client.execute({
      sql: `INSERT INTO ai_extractions
              (id, business_id, source_type, source_id, model, prompt_version,
               raw_response, parsed_json, confidence, status, created_at)
            VALUES ('sugg-pending-breed', 'biz-alfa', 'message', 'job-1', 'test', 'v2',
                    '', ?, 0.9, 'pending', CURRENT_TIMESTAMP)`,
      args: [
        JSON.stringify({
          kind: 'pet_update',
          title: 'Actualizar mascota',
          clientId,
          petId: pet.id,
          fields: [
            {
              field: 'breed',
              label: 'Raza',
              value: 'schnauzer',
              confidence: 0.9,
              evidence: [],
              quotes: [],
              conflict: false,
            },
          ],
          signature: 'pet_update|pending-breed',
        }),
      ],
    });

    const detail = await call(h, h.tokens.a, 'GET', `/pets/${pet.id}`);
    expect(detail.body.data.completeness.percent).toBe(40);
    expect(detail.body.data.completeness.pending).toContain('breed');
    expect(detail.body.data.completeness.complete).not.toContain('breed');
  });

  it('aceptar la sugerencia sube la completitud y deja auditoría', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573105560004', 'Acepta Test');
    const pet = await makePet(clientId, 'Michi', { species: 'gato' });

    await h.client.execute({
      sql: `INSERT INTO ai_extractions
              (id, business_id, source_type, source_id, model, prompt_version,
               raw_response, parsed_json, confidence, status, created_at)
            VALUES ('sugg-accept-breed', 'biz-alfa', 'message', 'job-2', 'test', 'v2',
                    '', ?, 0.9, 'pending', CURRENT_TIMESTAMP)`,
      args: [
        JSON.stringify({
          kind: 'pet_update',
          title: 'Actualizar mascota',
          clientId,
          petId: pet.id,
          fields: [
            {
              field: 'breed',
              label: 'Raza',
              value: 'schnauzer',
              confidence: 0.9,
              evidence: ['m1'],
              quotes: ['es una schnauzer'],
              conflict: false,
            },
          ],
          signature: 'pet_update|accept-breed',
        }),
      ],
    });

    const accepted = await request(h, {
      method: 'POST',
      path: '/ai/suggestions/sugg-accept-breed/accept',
      token: h.tokens.a,
      payload: {},
    });
    expect(accepted.status).toBe(200);

    const detail = await call(h, h.tokens.a, 'GET', `/pets/${pet.id}`);
    expect(detail.body.data.breed).toBe('schnauzer');
    expect(detail.body.data.completeness.percent).toBe(55);

    const audit = await call(
      h,
      h.tokens.a,
      'GET',
      '/audit?action=ai.apply&limit=20',
    );
    expect(
      audit.body.data.some(
        (entry: { entityId: string }) => entry.entityId === pet.id,
      ),
    ).toBe(true);

    // Al revisarse, se conservan los ids pero no las citas textuales.
    const stored = await h.client.execute(
      "SELECT parsed_json FROM ai_extractions WHERE id = 'sugg-accept-breed'",
    );
    const parsed = JSON.parse(String(stored.rows[0]?.parsed_json));
    expect(parsed.fields[0].evidence).toEqual(['m1']);
    expect(parsed.fields[0].quotes).toEqual([]);
  });

  it('marcar no aplicable baja el denominador', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573105560005', 'Flags Test');
    const pet = await makePet(clientId, 'Rocky', {
      species: 'perro',
      breed: 'Criollo',
    });

    expect(pet.completeness.percent).toBe(55);

    const patched = await call(h, h.tokens.a, 'PATCH', `/pets/${pet.id}`, {
      profileFlags: { na: ['photo', 'age'], unknown: ['sex'] },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.data.completeness.applicable).toBe(70);
    expect(patched.body.data.completeness.notApplicable).toEqual(
      expect.arrayContaining(['photo', 'age']),
    );
    expect(patched.body.data.completeness.unknown).toContain('sex');
  });
});

describe('filtros de completitud', () => {
  it('filtra por faltantes y por tramos', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573105560010', 'Filtros Test');

    const bare = await makePet(clientId, 'Solo Nombre');
    const mid = await makePet(clientId, 'Media', {
      species: 'gato',
      breed: 'Siamés',
    });
    const full = await makePet(clientId, 'Completa', {
      species: 'perro',
      breed: 'Poodle',
      weightKg: 6,
      birthdate: '2021-03-03',
      sex: 'hembra',
      photoUrl: 'https://cdn.example.com/full.jpg',
    });

    const noPhoto = await call(h, h.tokens.a, 'GET', '/pets?missing=photo&limit=100');
    const ids = noPhoto.body.data.map((pet: { id: string }) => pet.id);
    expect(ids).toContain(bare.id);
    expect(ids).toContain(mid.id);
    expect(ids).not.toContain(full.id);

    const low = await call(h, h.tokens.a, 'GET', '/pets?completeness=under50&limit=100');
    expect(low.body.data.map((pet: { id: string }) => pet.id)).toContain(bare.id);

    const over = await call(h, h.tokens.a, 'GET', '/pets?completeness=over80&limit=100');
    const overIds = over.body.data.map((pet: { id: string }) => pet.id);
    expect(overIds).toContain(full.id);
    expect(overIds).not.toContain(bare.id);
  });

  it('el resumen de calidad separa los indicadores', async () => {
    const res = await call(h, h.tokens.a, 'GET', '/stats/data-quality');

    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.contactsWithoutClient).toBeGreaterThanOrEqual(0);
    expect(data.clientsWithoutName).toBeGreaterThanOrEqual(0);
    expect(data.contactsWithoutPets).toBeGreaterThanOrEqual(0);
    expect(data.petsWithoutPhoto).toBeGreaterThan(0);
    expect(data.petsIncomplete).toBeGreaterThan(0);
    expect(data.averagePetCompleteness).toBeGreaterThan(0);
    expect(data.averagePetCompleteness).toBeLessThanOrEqual(100);
    expect(data.details.petsWithoutPhoto).toHaveLength(data.petsWithoutPhoto);
    expect(data.details.petsIncomplete).toHaveLength(data.petsIncomplete);
    expect(data.details.allPets).toHaveLength(data.totalPets);
    expect(data.details.petsWithoutPhoto[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      percent: expect.any(Number),
    });
  });

  it('la bandeja muestra completitud y mascotas', async () => {
    await h.client.execute({
      sql: `INSERT INTO whatsapp_messages
              (message_id, business_id, direction, contact_key, contact_phone,
               contact_name, message_type, body, message_timestamp, raw_message_json)
            VALUES ('wamid.comp.1', 'biz-alfa', 'inbound', '+573105560020',
                    '573105560020', 'Contacto', 'text', 'Hola', '2026-11-01T10:00:00Z', '{}')`,
    });

    const res = await call(h, h.tokens.a, 'GET', '/conversations');
    const row = res.body.data.find(
      (item: { waContact: string }) => item.waContact === '+573105560020',
    );

    expect(row).toBeDefined();
    expect(row.completeness.percent).toBe(50);
    expect(row.hasPets).toBe(false);
    expect(row.missing).toContain('Nombre');
  });

  it('no se mezclan negocios', async () => {
    const list = await call(h, h.tokens.b, 'GET', '/pets?limit=100');
    expect(list.body.data).toHaveLength(0);

    const summary = await call(h, h.tokens.b, 'GET', '/stats/data-quality');
    expect(summary.body.data.totalPets).toBe(0);
    expect(summary.body.data.averagePetCompleteness).toBe(0);
  });
});

describe('contactos y clientes: métricas separadas', () => {
  it('no cuenta dos veces una conversación vinculada a un cliente sin nombre', async () => {
    // Cliente sin nombre creado como lo haría la IA.
    const created = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-alfa', 'CO.UNNAMED000001', '573106660099', NULL)
            RETURNING id`,
    });
    const clientId = Number(created.rows[0]?.id);

    await h.client.execute({
      sql: `INSERT INTO conversations (id, business_id, client_id, wa_contact, status)
            VALUES ('conv-unnamed', 'biz-alfa', ?, 'CO.UNNAMED000001', 'active')`,
      args: [clientId],
    });

    const summary = await call(h, h.tokens.a, 'GET', '/stats/data-quality');
    const data = summary.body.data;

    expect(data.clientsWithoutName).toBeGreaterThanOrEqual(1);
    // La conversación está vinculada: no suma como contacto sin ficha.
    const unlinked = await h.client.execute(
      "SELECT COUNT(*) AS n FROM conversations WHERE business_id = 'biz-alfa' AND client_id IS NULL",
    );
    expect(data.contactsWithoutClient).toBe(Number(unlinked.rows[0]?.n));
  });

  it('un BSUID con dígitos parecidos a un teléfono no se vincula', async () => {
    // Ana tiene +573101000001. El BSUID contiene esos dígitos pero el
    // contact_phone es otro.
    await h.client.execute({
      sql: `INSERT INTO whatsapp_messages
              (message_id, business_id, direction, contact_key, contact_phone,
               contact_name, message_type, body, message_timestamp, raw_message_json)
            VALUES ('wamid.bsuid.photo', 'biz-alfa', 'inbound',
                    'CO.573101000001999', '573109998888', 'BSUID', 'text',
                    'Hola', '2026-11-01T10:00:00Z', '{}')`,
    });

    const conversations = await call(h, h.tokens.a, 'GET', '/conversations');
    const row = conversations.body.data.find(
      (item: { waContact: string }) => item.waContact === 'CO.573101000001999',
    );

    expect(row).toBeDefined();
    expect(row.clientId).toBeNull();

    const summary = await call(h, h.tokens.a, 'GET', '/stats/data-quality');
    expect(summary.body.data.contactsWithoutClient).toBeGreaterThanOrEqual(1);
  });
});

describe('marcas válidas', () => {
  it('no permite "no aplica" en el nombre de una mascota', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573106660010', 'Flags Val');
    const pet = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Nala',
      species: 'gato',
    });

    const res = await call(h, h.tokens.a, 'PATCH', `/pets/${pet.body.data.id}`, {
      profileFlags: { na: ['name'] },
    });

    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.error)).toContain('No se puede marcar');
  });

  it('no permite "no aplica" en el nombre de un cliente', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573106660011', 'Cliente Val');

    const res = await call(h, h.tokens.a, 'PATCH', `/clients/${clientId}`, {
      profileFlags: { na: ['name'] },
    });

    expect(res.status).toBe(422);
  });

  it('permite marcar el nombre del cliente como desconocido', async () => {
    const created = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-alfa', 'CO.UNKNOWN00002', '573106660012', NULL)
            RETURNING id`,
    });
    const clientId = Number(created.rows[0]?.id);

    const res = await call(h, h.tokens.a, 'PATCH', `/clients/${clientId}`, {
      profileFlags: { unknown: ['name'] },
    });

    expect(res.status).toBe(200);
    expect(res.body.data.completeness.unknown).toContain('name');
    expect(res.body.data.completeness.missing).not.toContain('name');
    // Sigue afectando el porcentaje: 50 %.
    expect(res.body.data.completeness.percent).toBe(50);
  });
});

describe('nombre confirmado', () => {
  it('un PATCH con nombre válido retira la marca unknown y deja auditoría', async () => {
    const created = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-alfa', 'CO.CONFIRM00001', '573106660030', NULL)
            RETURNING id`,
    });
    const clientId = Number(created.rows[0]?.id);

    await call(h, h.tokens.a, 'PATCH', `/clients/${clientId}`, {
      profileFlags: { unknown: ['name'] },
    });

    const res = await call(h, h.tokens.a, 'PATCH', `/clients/${clientId}`, {
      fullName: 'Lucía Pardo',
    });

    expect(res.status).toBe(200);
    expect(res.body.data.completeness.percent).toBe(100);
    expect(res.body.data.completeness.unknown).not.toContain('name');

    const flags = await h.client.execute({
      sql: 'SELECT profile_flags_json FROM clients WHERE id = ?',
      args: [clientId],
    });
    expect(String(flags.rows[0]?.profile_flags_json)).not.toContain('"name"');

    const audit = await call(
      h,
      h.tokens.a,
      'GET',
      '/audit?action=client.update&limit=100',
    );
    expect(
      audit.body.data.some(
        (entry: { entityId: string; diff: { nameUnknown?: unknown } }) =>
          entry.entityId === String(clientId) && entry.diff?.nameUnknown,
      ),
    ).toBe(true);
  });

  it('aceptar una sugerencia sin nombre no retira la marca', async () => {
    const created = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name, profile_flags_json)
            VALUES ('biz-alfa', 'CO.CONFIRM00003', '573106660032', 'Ana Ruiz', '{"unknown":["name"],"na":[]}')
            RETURNING id`,
    });
    const clientId = Number(created.rows[0]?.id);

    await h.client.execute({
      sql: `INSERT INTO ai_extractions
              (id, business_id, source_type, source_id, model, prompt_version,
               raw_response, parsed_json, confidence, status, created_at)
            VALUES ('sugg-phone-only', 'biz-alfa', 'message', 'job-phone', 'test', 'v2',
                    '', ?, 0.95, 'pending', CURRENT_TIMESTAMP)`,
      args: [
        JSON.stringify({
          kind: 'client_update',
          title: 'Actualizar teléfono',
          clientId,
          petId: null,
          fields: [
            {
              field: 'phone',
              label: 'Teléfono',
              value: '+573106660099',
              confidence: 0.95,
              evidence: ['m1'],
              quotes: [],
              conflict: false,
            },
          ],
          signature: 'client_update|phone-only',
        }),
      ],
    });

    const res = await request(h, {
      method: 'POST',
      path: '/ai/suggestions/sugg-phone-only/accept',
      token: h.tokens.a,
      payload: {},
    });
    expect(res.status).toBe(200);

    const row = await h.client.execute({
      sql: 'SELECT profile_flags_json FROM clients WHERE id = ?',
      args: [clientId],
    });
    expect(String(row.rows[0]?.profile_flags_json)).toContain('"name"');
  });

  it('aceptar un nombre de la IA también retira la marca', async () => {
    const created = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name, profile_flags_json)
            VALUES ('biz-alfa', 'CO.CONFIRM00002', '573106660031', NULL, '{"unknown":["name"],"na":[]}')
            RETURNING id`,
    });
    const clientId = Number(created.rows[0]?.id);

    await h.client.execute({
      sql: `INSERT INTO ai_extractions
              (id, business_id, source_type, source_id, model, prompt_version,
               raw_response, parsed_json, confidence, status, created_at)
            VALUES ('sugg-name-confirm', 'biz-alfa', 'message', 'job-name', 'test', 'v2',
                    '', ?, 0.95, 'pending', CURRENT_TIMESTAMP)`,
      args: [
        JSON.stringify({
          kind: 'client_update',
          title: 'Actualizar cliente',
          clientId,
          petId: null,
          fields: [
            {
              field: 'fullName',
              label: 'Nombre',
              value: 'Marta Ríos',
              confidence: 0.95,
              evidence: ['m1'],
              quotes: [],
              conflict: false,
            },
          ],
          signature: 'client_update|name-confirm',
        }),
      ],
    });

    const res = await request(h, {
      method: 'POST',
      path: '/ai/suggestions/sugg-name-confirm/accept',
      token: h.tokens.a,
      payload: {},
    });
    expect(res.status).toBe(200);

    const row = await h.client.execute({
      sql: 'SELECT full_name, profile_flags_json FROM clients WHERE id = ?',
      args: [clientId],
    });
    expect(row.rows[0]?.full_name).toBe('Marta Ríos');
    expect(String(row.rows[0]?.profile_flags_json)).not.toContain('"name"');

    const audit = await call(
      h,
      h.tokens.a,
      'GET',
      '/audit?action=ai.apply&limit=100',
    );
    expect(
      audit.body.data.some(
        (entry: { entityId: string; diff: { nameUnknown?: unknown } }) =>
          entry.entityId === String(clientId) && entry.diff?.nameUnknown,
      ),
    ).toBe(true);
  });
});
