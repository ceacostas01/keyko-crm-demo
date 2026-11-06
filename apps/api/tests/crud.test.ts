import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createClientRow, makeHarness, type Harness } from './helpers';

let h: Harness;

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(() => h.close());

describe('clientes', () => {
  it('crea un cliente y normaliza el teléfono a E.164', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'Camila Restrepo',
      phone: '310 555 7788',
      email: 'camila@example.com',
      notes: 'Prefiere citas en la mañana',
    });

    expect(res.status).toBe(201);
    expect(res.body.data.phone).toBe('+573105557788');
    expect(res.body.data.whatsappContactKey).toBe('+573105557788');
    expect(res.body.data.source).toBe('manual');
    expect(res.body.data.businessId).toBe('biz-alfa');
  });

  it('rechaza teléfonos duplicados en el mismo negocio', async () => {
    const phone = '+573105550001';
    await createClientRow(h, h.tokens.a, phone, 'Original');

    const res = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'Duplicado',
      phone,
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('duplicate_client');
  });

  it('rechaza el teléfono si ya existe una ficha de WhatsApp con BSUID', async () => {
    const created = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-alfa', 'CO.MANUAL-DUP', '+573105550099', 'Desde WhatsApp')`,
    });
    expect(created.rowsAffected).toBe(1);

    const res = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'Manual duplicado',
      phone: '310 555 0099',
    });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('duplicate_client');
  });

  it('permite el mismo teléfono en otro negocio', async () => {
    const phone = '+573105550002';
    await createClientRow(h, h.tokens.a, phone, 'Alfa');

    const res = await call(h, h.tokens.b, 'POST', '/clients', {
      fullName: 'Beta',
      phone,
    });

    expect(res.status).toBe(201);
  });

  it('valida teléfono, email y nombre', async () => {
    const badPhone = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'Sin teléfono válido',
      phone: '12',
    });
    expect(badPhone.status).toBe(422);

    const badEmail = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'Email malo',
      phone: '+573105550003',
      email: 'no-es-email',
    });
    expect(badEmail.status).toBe(422);

    const shortName = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'A',
      phone: '+573105550004',
    });
    expect(shortName.status).toBe(422);
  });

  it('edita un cliente', async () => {
    const id = await createClientRow(h, h.tokens.a, '+573105550005', 'Nombre Viejo');

    const res = await call(h, h.tokens.a, 'PATCH', `/clients/${id}`, {
      fullName: 'Nombre Nuevo',
      notes: 'Actualizado',
      consentMarketing: true,
    });

    expect(res.status).toBe(200);
    expect(res.body.data.fullName).toBe('Nombre Nuevo');
    expect(res.body.data.notes).toBe('Actualizado');
    expect(res.body.data.consentMarketing).toBe(1);
  });

  it('no permite editar el teléfono hacia uno ya usado', async () => {
    const first = await createClientRow(h, h.tokens.a, '+573105550006', 'Uno');
    await createClientRow(h, h.tokens.a, '+573105550007', 'Dos');

    const res = await call(h, h.tokens.a, 'PATCH', `/clients/${first}`, {
      phone: '+573105550007',
    });

    expect(res.status).toBe(409);
  });

  it('borra lógicamente: desaparece del listado pero queda en la base', async () => {
    const id = await createClientRow(h, h.tokens.a, '+573105550008', 'Temporal');

    const del = await call(h, h.tokens.a, 'DELETE', `/clients/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);

    const list = await call(h, h.tokens.a, 'GET', '/clients?limit=100');
    expect(list.body.data.map((c: { id: number }) => c.id)).not.toContain(id);

    const read = await call(h, h.tokens.a, 'GET', `/clients/${id}`);
    expect(read.status).toBe(404);

    const row = await h.client.execute({
      sql: 'SELECT deleted_at FROM clients WHERE id = ?',
      args: [id],
    });
    expect(row.rows[0]?.deleted_at).toBeTruthy();
  });
});

describe('mascotas', () => {
  let clientId: number;

  beforeAll(async () => {
    clientId = await createClientRow(h, h.tokens.a, '+573105551001', 'Dueño Mascota');
  });

  it('crea, edita y borra una mascota', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Luna',
      species: 'gato',
      sex: 'hembra',
      weightKg: 4.2,
    });

    expect(created.status).toBe(201);
    expect(created.body.data.businessId).toBe('biz-alfa');
    expect(created.body.data.species).toBe('gato');

    const id = created.body.data.id;

    const patched = await call(h, h.tokens.a, 'PATCH', `/pets/${id}`, {
      name: 'Luna María',
      allergies: 'Pollo',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.data.name).toBe('Luna María');
    expect(patched.body.data.allergies).toBe('Pollo');

    const del = await call(h, h.tokens.a, 'DELETE', `/pets/${id}`);
    expect(del.status).toBe(200);

    const read = await call(h, h.tokens.a, 'GET', `/pets/${id}`);
    expect(read.status).toBe(404);
  });

  it('exige que el cliente exista y sea del mismo negocio', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId: 999999,
      name: 'Sin dueño',
    });
    expect(res.status).toBe(404);
  });

  it('valida la especie', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Rex',
      species: 'dinosaurio',
    });
    expect(res.status).toBe(422);
  });

  it('filtra mascotas por cliente', async () => {
    const otherClient = await createClientRow(h, h.tokens.a, '+573105551002', 'Otro');

    await call(h, h.tokens.a, 'POST', '/pets', { clientId, name: 'Rocky' });
    await call(h, h.tokens.a, 'POST', '/pets', {
      clientId: otherClient,
      name: 'Toby',
    });

    const res = await call(h, h.tokens.a, 'GET', `/pets?clientId=${clientId}&limit=100`);
    expect(res.status).toBe(200);
    for (const pet of res.body.data) {
      expect(pet.clientId).toBe(clientId);
    }
  });
});

describe('servicios', () => {
  it('crea y edita un servicio', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/services', {
      name: 'Corte de uñas',
      category: 'estética',
      durationMin: 20,
      priceCents: 2500000,
    });

    expect(created.status).toBe(201);
    expect(created.body.data.priceCents).toBe(2500000);

    const id = created.body.data.id;
    const patched = await call(h, h.tokens.a, 'PATCH', `/services/${id}`, {
      priceCents: 3000000,
      active: false,
    });

    expect(patched.status).toBe(200);
    expect(patched.body.data.priceCents).toBe(3000000);
    expect(patched.body.data.active).toBe(0);
  });

  it('rechaza precios negativos y duraciones absurdas', async () => {
    const negative = await call(h, h.tokens.a, 'POST', '/services', {
      name: 'Inválido',
      priceCents: -1,
    });
    expect(negative.status).toBe(422);

    const short = await call(h, h.tokens.a, 'POST', '/services', {
      name: 'Muy corto',
      priceCents: 1000,
      durationMin: 1,
    });
    expect(short.status).toBe(422);
  });

  it('borra lógicamente el servicio', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/services', {
      name: 'Temporal',
      priceCents: 1000,
    });
    const id = created.body.data.id;

    const del = await call(h, h.tokens.a, 'DELETE', `/services/${id}`);
    expect(del.status).toBe(200);

    const list = await call(h, h.tokens.a, 'GET', '/services');
    expect(list.body.data.map((s: { id: string }) => s.id)).not.toContain(id);
  });
});

describe('artículos e inventario', () => {
  it('crea un artículo y evita SKU duplicado en el negocio', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/products', {
      sku: 'SHAMPOO-01',
      name: 'Shampoo hipoalergénico',
      priceCents: 3200000,
      costCents: 1800000,
      stock: 10,
      minStock: 3,
    });

    expect(created.status).toBe(201);
    expect(created.body.data.stock).toBe(10);

    const dup = await call(h, h.tokens.a, 'POST', '/products', {
      sku: 'SHAMPOO-01',
      name: 'Otro shampoo',
      priceCents: 1000,
    });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('duplicate_sku');
  });

  it('permite SKU repetido en otro negocio', async () => {
    const res = await call(h, h.tokens.b, 'POST', '/products', {
      sku: 'SHAMPOO-01',
      name: 'Shampoo Beta',
      priceCents: 2000000,
    });
    expect(res.status).toBe(201);
  });

  it('permite varios artículos sin SKU (NULL no colisiona)', async () => {
    const a = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Sin SKU 1',
      priceCents: 1000,
    });
    const b = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Sin SKU 2',
      priceCents: 1000,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
  });

  it('ajusta stock y registra el movimiento', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Cepillo',
      priceCents: 1500000,
      stock: 5,
    });
    const id = created.body.data.id;

    const add = await call(h, h.tokens.a, 'POST', `/products/${id}/stock`, {
      delta: 7,
      reason: 'Compra a proveedor',
      refType: 'purchase',
    });
    expect(add.status).toBe(200);
    expect(add.body.data.stock).toBe(12);

    const remove = await call(h, h.tokens.a, 'POST', `/products/${id}/stock`, {
      delta: -2,
      reason: 'Venta mostrador',
      refType: 'sale',
    });
    expect(remove.body.data.stock).toBe(10);

    const detail = await call(h, h.tokens.a, 'GET', `/products/${id}`);
    expect(detail.body.data.movements).toHaveLength(2);
  });

  it('no permite dejar stock negativo', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Collar',
      priceCents: 900000,
      stock: 1,
    });

    const res = await call(
      h,
      h.tokens.a,
      'POST',
      `/products/${created.body.data.id}/stock`,
      { delta: -5, reason: 'Ajuste' },
    );

    expect(res.status).toBe(422);
  });

  it('rechaza un ajuste de cero', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Juguete',
      priceCents: 700000,
    });

    const res = await call(
      h,
      h.tokens.a,
      'POST',
      `/products/${created.body.data.id}/stock`,
      { delta: 0, reason: 'Nada' },
    );

    expect(res.status).toBe(422);
  });
});

describe('conversaciones (solo lectura)', () => {
  it('no existe endpoint de escritura', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/conversations', {
      waContact: '+573100000000',
    });
    expect(res.status).toBe(404);
  });

  it('no expone datos crudos del webhook', async () => {
    await h.client.execute({
      sql: `INSERT INTO conversations (id, business_id, wa_contact, status)
            VALUES ('conv-alfa-1', 'biz-alfa', '+573105557788', 'active')`,
      args: [],
    });
    await h.client.execute({
      sql: `INSERT INTO whatsapp_messages
              (message_id, business_id, conversation_id, direction, contact_key,
               contact_phone, message_type, body, message_timestamp, raw_message_json)
            VALUES ('wamid.1', 'biz-alfa', 'conv-alfa-1', 'inbound',
                    '+573105557788', '+573105557788', 'text', 'Hola',
                    '2026-11-02T15:00:00Z', '{"secret":"no-debe-salir"}')`,
    });

    const res = await call(h, h.tokens.a, 'GET', '/conversations/conv-alfa-1');
    expect(res.status).toBe(200);
    expect(res.body.data.messages).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toContain('no-debe-salir');
  });
});
