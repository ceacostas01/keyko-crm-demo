import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createClientRow, makeHarness, type Harness } from './helpers';

let h: Harness;
let clientId: number;
let petId: string;

type AuditRow = {
  action: string;
  entity: string;
  entityId: string;
  actorId: string | null;
  actorName: string | null;
  diff: Record<string, { from: unknown; to: unknown }> | null;
};

beforeAll(async () => {
  h = await makeHarness();
  clientId = await createClientRow(h, h.tokens.a, '+573103330001', 'Auditoría');
  const pet = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name: 'Auditada',
  });
  petId = pet.body.data.id;
});

afterAll(() => h.close());

async function audit(
  token: string,
  query = '',
): Promise<AuditRow[]> {
  const res = await call<{ data: AuditRow[] }>(
    h,
    token,
    'GET',
    `/audit?limit=100${query}`,
  );
  expect(res.status).toBe(200);
  return res.body.data;
}

describe('auditoría', () => {
  it('registra la creación de un cliente con su actor', async () => {
    const rows = await audit(h.tokens.a, '&entity=client&action=client.create');
    const entry = rows.find((row) => row.entityId === String(clientId));

    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe('user-alfa-owner');
    expect(entry?.actorName).toBe('Dueño Alfa');
    expect(entry?.diff?.fullName).toEqual({ from: null, to: 'Auditoría' });
  });

  it('registra solo los campos que cambian', async () => {
    await call(h, h.tokens.a, 'PATCH', `/clients/${clientId}`, {
      fullName: 'Auditoría Renombrada',
      notes: 'nota nueva',
    });

    const rows = await audit(h.tokens.a, '&entity=client&action=client.update');
    const entry = rows.find((row) => row.entityId === String(clientId));

    expect(entry?.diff).toEqual({
      fullName: { from: 'Auditoría', to: 'Auditoría Renombrada' },
      notes: { from: null, to: 'nota nueva' },
    });
    // updatedAt nunca ensucia el diff.
    expect(Object.keys(entry?.diff ?? {})).not.toContain('updatedAt');
  });

  it('un guardado sin cambios no genera entrada', async () => {
    const before = await audit(h.tokens.a, '&entity=client&action=client.update');

    const res = await call(h, h.tokens.a, 'PATCH', `/clients/${clientId}`, {
      fullName: 'Auditoría Renombrada',
    });
    expect(res.status).toBe(200);

    const after = await audit(h.tokens.a, '&entity=client&action=client.update');
    expect(after).toHaveLength(before.length);
  });

  it('registra la creación de una mascota y sus cambios', async () => {
    await call(h, h.tokens.a, 'PATCH', `/pets/${petId}`, {
      allergies: 'Pollo',
    });

    const created = await audit(h.tokens.a, '&entity=pet&action=pet.create');
    expect(created.some((row) => row.entityId === petId)).toBe(true);

    const updated = await audit(h.tokens.a, '&entity=pet&action=pet.update');
    const entry = updated.find((row) => row.entityId === petId);
    expect(entry?.diff).toEqual({ allergies: { from: null, to: 'Pollo' } });
  });

  it('registra cambios de precio en un servicio', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/services', {
      name: 'Baño auditoría',
      priceCents: 4000000,
    });
    const id = created.body.data.id;

    await call(h, h.tokens.a, 'PATCH', `/services/${id}`, {
      priceCents: 4500000,
    });

    const rows = await audit(h.tokens.a, '&entity=service&action=service.update');
    const entry = rows.find((row) => row.entityId === id);
    expect(entry?.diff).toEqual({ priceCents: { from: 4000000, to: 4500000 } });
  });

  it('registra ajustes de inventario con stock antes y después', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Producto auditoría',
      priceCents: 1000000,
      stock: 4,
    });
    const id = created.body.data.id;

    await call(h, h.tokens.a, 'POST', `/products/${id}/stock`, {
      delta: 3,
      reason: 'Compra',
    });

    const rows = await audit(h.tokens.a, '&entity=product&action=product.stock');
    const entry = rows.find((row) => row.entityId === id);
    expect(entry?.diff?.stock).toEqual({ from: 4, to: 7 });
    expect(entry?.diff?.reason).toEqual({ from: null, to: 'Compra' });
  });

  it('registra la creación y la cancelación de una cita', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-10T09:00',
      durationMin: 60,
    });
    const id = created.body.data.id;

    await call(h, h.tokens.a, 'DELETE', `/appointments/${id}`);

    const rows = await audit(h.tokens.a);
    expect(
      rows.some((row) => row.action === 'appointment.create' && row.entityId === id),
    ).toBe(true);
    expect(
      rows.some((row) => row.action === 'appointment.cancel' && row.entityId === id),
    ).toBe(true);
  });

  it('registra el login exitoso', async () => {
    await call(h, null, 'POST', '/auth/login', {
      email: 'owner@beta.test',
      password: 'ClaveSegura123!',
    });

    const rows = await audit(h.tokens.b, '&action=auth.login');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.entity).toBe('user');
    expect(rows[0]?.actorId).toBe('user-beta-owner');
  });

  it('registra el borrado lógico de un cliente', async () => {
    const id = await createClientRow(h, h.tokens.a, '+573103330099', 'A borrar');
    await call(h, h.tokens.a, 'DELETE', `/clients/${id}`);

    const rows = await audit(h.tokens.a, '&action=client.delete');
    const entry = rows.find((row) => row.entityId === String(id));
    expect(entry?.diff?.deletedAt).toBeDefined();
  });

  it('nunca muestra la auditoría de otro negocio', async () => {
    const rows = await audit(h.tokens.b);
    expect(rows.every((row) => row.actorId !== 'user-alfa-owner')).toBe(true);
  });

  it('exige autenticación', async () => {
    const res = await call(h, null, 'GET', '/audit');
    expect(res.status).toBe(401);
  });

  it('filtra por acción y valida el filtro', async () => {
    const rows = await audit(h.tokens.a, '&action=client.create');
    expect(rows.every((row) => row.action === 'client.create')).toBe(true);

    const invalid = await call(h, h.tokens.a, 'GET', '/audit?action=inventada');
    expect(invalid.status).toBe(422);
  });
});
