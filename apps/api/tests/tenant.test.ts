import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BIZ_A,
  BIZ_B,
  call,
  createClientRow,
  makeHarness,
  type Harness,
} from './helpers';

let h: Harness;
let clientA: number;
let clientB: number;
let petA: string;
let petB: string;
let serviceA: string;
let serviceB: string;
let conversationB: string;

beforeAll(async () => {
  h = await makeHarness();

  clientA = await createClientRow(h, h.tokens.a, '+573101110001', 'Ana Alfa');
  clientB = await createClientRow(h, h.tokens.b, '+573101110002', 'Bruno Beta');

  const petResA = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId: clientA,
    name: 'Firulais',
  });
  petA = petResA.body.data.id;

  const petResB = await call(h, h.tokens.b, 'POST', '/pets', {
    clientId: clientB,
    name: 'Michi',
  });
  petB = petResB.body.data.id;

  const svcA = await call(h, h.tokens.a, 'POST', '/services', {
    name: 'Baño Alfa',
    priceCents: 4500000,
  });
  serviceA = svcA.body.data.id;

  const svcB = await call(h, h.tokens.b, 'POST', '/services', {
    name: 'Baño Beta',
    priceCents: 5000000,
  });
  serviceB = svcB.body.data.id;

  await h.client.execute({
    sql: `INSERT INTO conversations (id, business_id, wa_contact, status)
          VALUES ('conv-beta', ?, '+573101110002', 'active')`,
    args: [BIZ_B],
  });
  conversationB = 'conv-beta';
});

afterAll(() => h.close());

describe('aislamiento entre negocios', () => {
  it('cada negocio solo lista sus clientes', async () => {
    const a = await call(h, h.tokens.a, 'GET', '/clients');
    const b = await call(h, h.tokens.b, 'GET', '/clients');

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.data.map((c: { id: number }) => c.id)).toEqual([clientA]);
    expect(b.body.data.map((c: { id: number }) => c.id)).toEqual([clientB]);
  });

  it('A no puede leer un cliente de B', async () => {
    const res = await call(h, h.tokens.a, 'GET', `/clients/${clientB}`);
    expect(res.status).toBe(404);
  });

  it('A no puede editar un cliente de B', async () => {
    const res = await call(h, h.tokens.a, 'PATCH', `/clients/${clientB}`, {
      fullName: 'Hackeado',
    });
    expect(res.status).toBe(404);

    const check = await call(h, h.tokens.b, 'GET', `/clients/${clientB}`);
    expect(check.body.data.fullName).toBe('Bruno Beta');
  });

  it('A no puede borrar un cliente de B', async () => {
    const res = await call(h, h.tokens.a, 'DELETE', `/clients/${clientB}`);
    expect(res.status).toBe(404);

    const check = await call(h, h.tokens.b, 'GET', `/clients/${clientB}`);
    expect(check.status).toBe(200);
  });

  it('A no puede crear una mascota para un cliente de B', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId: clientB,
      name: 'Intrusa',
    });
    expect(res.status).toBe(404);
  });

  it('A no puede leer ni editar mascotas de B', async () => {
    const read = await call(h, h.tokens.a, 'GET', `/pets/${petB}`);
    expect(read.status).toBe(404);

    const patch = await call(h, h.tokens.a, 'PATCH', `/pets/${petB}`, {
      name: 'Robada',
    });
    expect(patch.status).toBe(404);
  });

  it('el listado de mascotas no mezcla negocios', async () => {
    const a = await call(h, h.tokens.a, 'GET', '/pets');
    expect(a.body.data.map((p: { id: string }) => p.id)).toEqual([petA]);
  });

  it('los servicios están aislados', async () => {
    const a = await call(h, h.tokens.a, 'GET', '/services');
    expect(a.body.data.map((s: { id: string }) => s.id)).toEqual([serviceA]);

    const cross = await call(h, h.tokens.a, 'GET', `/services/${serviceB}`);
    expect(cross.status).toBe(404);

    const patch = await call(h, h.tokens.a, 'PATCH', `/services/${serviceB}`, {
      priceCents: 1,
    });
    expect(patch.status).toBe(404);
  });

  it('A no puede crear una cita con la mascota de B', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId: petB,
      startsAt: '2026-11-02T10:00',
      durationMin: 60,
    });
    expect(res.status).toBe(404);
  });

  it('las conversaciones están aisladas', async () => {
    const b = await call(h, h.tokens.b, 'GET', '/conversations');
    expect(b.body.data.map((c: { id: string }) => c.id)).toContain(conversationB);

    const a = await call(h, h.tokens.a, 'GET', '/conversations');
    expect(a.body.data).toHaveLength(0);

    const cross = await call(h, h.tokens.a, 'GET', `/conversations/${conversationB}`);
    expect(cross.status).toBe(404);
  });

  it('ignora el business_id enviado por el cliente', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'Inyección',
      phone: '+573109990000',
      businessId: BIZ_B,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.businessId).toBe(BIZ_A);

    const inB = await call(h, h.tokens.b, 'GET', '/clients');
    expect(inB.body.data.map((c: { phone: string }) => c.phone)).not.toContain(
      '+573109990000',
    );
  });

  it('ignora el business_id enviado en query params', async () => {
    const res = await call(
      h,
      h.tokens.a,
      'GET',
      `/clients?business_id=${BIZ_B}&limit=100`,
    );
    expect(res.status).toBe(200);
    for (const row of res.body.data) {
      expect(row.businessId).toBe(BIZ_A);
    }
  });
});
