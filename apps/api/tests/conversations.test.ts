import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createClientRow, makeHarness, type Harness } from './helpers';

let h: Harness;
let knownPhone: string;
let unknownPhone: string;

type MessageSeed = {
  id: string;
  businessId: string;
  contact: string;
  direction: 'inbound' | 'outbound';
  body: string;
  at: string;
  type?: string;
  /** Teléfono real, cuando `contact` es un BSUID. */
  phone?: string;
  name?: string;
};

async function seedMessage(h: Harness, message: MessageSeed) {
  await h.client.execute({
    sql: `INSERT INTO whatsapp_messages
            (message_id, business_id, direction, contact_key, contact_phone,
             contact_name, message_type, body, message_timestamp, raw_message_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      message.id,
      message.businessId,
      message.direction,
      message.contact,
      message.phone ?? message.contact,
      message.name ?? null,
      message.type ?? 'text',
      message.body,
      message.at,
      JSON.stringify({ secreto: 'no-debe-salir' }),
    ],
  });
}

async function countMessages(): Promise<number> {
  const rs = await h.client.execute('SELECT COUNT(*) AS n FROM whatsapp_messages');
  return Number(rs.rows[0]?.n);
}

beforeAll(async () => {
  h = await makeHarness();

  knownPhone = '+573105557788';
  unknownPhone = '+573109998877';

  // Cliente existente: la conversación debe quedar asociada a él.
  await createClientRow(h, h.tokens.a, knownPhone, 'Camila Restrepo');

  await seedMessage(h, {
    id: 'wamid.a1',
    businessId: 'biz-alfa',
    contact: knownPhone,
    direction: 'inbound',
    body: 'Hola, ¿tienen cita para baño?',
    at: '2026-11-02T15:00:00Z',
  });
  await seedMessage(h, {
    id: 'wamid.a2',
    businessId: 'biz-alfa',
    contact: knownPhone,
    direction: 'outbound',
    body: 'Claro, mañana a las 10.',
    at: '2026-11-02T15:05:00Z',
  });
  await seedMessage(h, {
    id: 'wamid.a3',
    businessId: 'biz-alfa',
    contact: unknownPhone,
    direction: 'inbound',
    body: '¿Cuánto cuesta el corte?',
    at: '2026-11-03T13:00:00Z',
  });

  // Otro negocio: nunca debe aparecer.
  await seedMessage(h, {
    id: 'wamid.b1',
    businessId: 'biz-beta',
    contact: '+573001112233',
    direction: 'inbound',
    body: 'Mensaje de Beta',
    at: '2026-11-03T14:00:00Z',
  });
});

afterAll(() => h.close());

describe('bandeja de WhatsApp', () => {
  it('materializa conversaciones desde los mensajes del webhook', async () => {
    const res = await call(h, h.tokens.a, 'GET', '/conversations');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.meta.sync.contacts).toBe(2);
    expect(res.body.meta.sync.created).toBe(2);

    const contacts = res.body.data.map((row: { waContact: string }) => row.waContact);
    expect(contacts).toContain(knownPhone);
    expect(contacts).toContain(unknownPhone);
    expect(contacts).not.toContain('+573001112233');
  });

  it('ordena por el último mensaje y lo incluye', async () => {
    const res = await call(h, h.tokens.a, 'GET', '/conversations');

    expect(res.body.data[0].waContact).toBe(unknownPhone);
    expect(res.body.data[0].lastMessage.body).toBe('¿Cuánto cuesta el corte?');
    expect(res.body.data[0].lastMessage.direction).toBe('inbound');
    expect(res.body.data[0].lastMessageAt).toBe('2026-11-03T13:00:00Z');

    const known = res.body.data.find(
      (row: { waContact: string }) => row.waContact === knownPhone,
    );
    expect(known.lastMessage.body).toBe('Claro, mañana a las 10.');
  });

  it('asocia el cliente cuando el teléfono coincide', async () => {
    const res = await call(h, h.tokens.a, 'GET', '/conversations');
    const known = res.body.data.find(
      (row: { waContact: string }) => row.waContact === knownPhone,
    );
    expect(known.client).toEqual({
      id: expect.any(Number),
      name: 'Camila Restrepo',
      phone: knownPhone,
    });

    const unknown = res.body.data.find(
      (row: { waContact: string }) => row.waContact === unknownPhone,
    );
    expect(unknown.client).toBeNull();
  });

  it('es idempotente: leer dos veces no duplica nada', async () => {
    const first = await call(h, h.tokens.a, 'GET', '/conversations');
    const second = await call(h, h.tokens.a, 'GET', '/conversations');

    expect(second.body.data).toHaveLength(first.body.data.length);
    expect(second.body.meta.sync.created).toBe(0);

    const rs = await h.client.execute(
      "SELECT COUNT(*) AS n FROM conversations WHERE business_id = 'biz-alfa'",
    );
    expect(Number(rs.rows[0]?.n)).toBe(2);
  });

  it('nunca modifica las tablas del webhook', async () => {
    const before = await countMessages();
    await call(h, h.tokens.a, 'GET', '/conversations');
    expect(await countMessages()).toBe(before);
  });

  it('devuelve el historial ordenado y sin datos crudos', async () => {
    const list = await call(h, h.tokens.a, 'GET', '/conversations');
    const known = list.body.data.find(
      (row: { waContact: string }) => row.waContact === knownPhone,
    );

    const res = await call(
      h,
      h.tokens.a,
      'GET',
      `/conversations/${known.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(2);
    expect(res.body.data.messages.map((m: { body: string }) => m.body)).toEqual([
      'Hola, ¿tienen cita para baño?',
      'Claro, mañana a las 10.',
    ]);
    expect(res.body.data.messages[0].direction).toBe('inbound');
    expect(res.body.data.messages[1].direction).toBe('outbound');
    expect(JSON.stringify(res.body)).not.toContain('no-debe-salir');
    expect(res.body.data.client.name).toBe('Camila Restrepo');
  });

  it('incorpora mensajes nuevos en la siguiente lectura', async () => {
    await seedMessage(h, {
      id: 'wamid.a4',
      businessId: 'biz-alfa',
      contact: unknownPhone,
      direction: 'outbound',
      body: 'El corte cuesta $45.000',
      at: '2026-11-04T10:00:00Z',
    });

    const res = await call(h, h.tokens.a, 'GET', '/conversations');
    const unknown = res.body.data.find(
      (row: { waContact: string }) => row.waContact === unknownPhone,
    );

    expect(unknown.lastMessage.body).toBe('El corte cuesta $45.000');
    expect(unknown.lastMessageAt).toBe('2026-11-04T10:00:00Z');
    expect(res.body.meta.sync.created).toBe(0);
  });

  it('aísla las conversaciones por negocio', async () => {
    const beta = await call(h, h.tokens.b, 'GET', '/conversations');

    expect(beta.status).toBe(200);
    expect(beta.body.data).toHaveLength(1);
    expect(beta.body.data[0].waContact).toBe('+573001112233');

    const ids = beta.body.data.map((row: { id: string }) => row.id);
    for (const id of ids) {
      const cross = await call(h, h.tokens.a, 'GET', `/conversations/${id}`);
      expect(cross.status).toBe(404);
    }
  });

  it('filtra por estado', async () => {
    const closed = await call(
      h,
      h.tokens.a,
      'GET',
      '/conversations?status=closed',
    );
    expect(closed.body.data).toHaveLength(0);

    const active = await call(
      h,
      h.tokens.a,
      'GET',
      '/conversations?status=active',
    );
    expect(active.body.data.length).toBeGreaterThan(0);
  });

  it('no expone endpoints de escritura', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/conversations', {
      waContact: '+573100000000',
    });
    expect(res.status).toBe(404);
  });
});

describe('bandeja: identidad del contacto', () => {
  it('vincula al cliente cuando contact_key es un BSUID y el teléfono viene aparte', async () => {
    // Caso real de producción: contact_key "CO.…" y contact_phone "57312…".
    const bsuid = 'CO.DEMO0000000001';
    const phoneDigits = '573000000000';

    await createClientRow(h, h.tokens.a, `+${phoneDigits}`, 'Cliente BSUID');
    await seedMessage(h, {
      id: 'wamid.bsuid.1',
      businessId: 'biz-alfa',
      contact: bsuid,
      phone: phoneDigits,
      name: 'CA',
      direction: 'inbound',
      body: 'Hola desde BSUID',
      at: '2026-11-05T12:00:00Z',
    });

    const res = await call(h, h.tokens.a, 'GET', '/conversations');
    const row = res.body.data.find(
      (item: { waContact: string }) => item.waContact === bsuid,
    );

    expect(row).toBeDefined();
    expect(row.client).not.toBeNull();
    expect(row.client.phone).toBe(`+${phoneDigits}`);
    expect(row.contactName).toBe('CA');
    expect(row.lastMessage.body).toBe('Hola desde BSUID');
  });
});
