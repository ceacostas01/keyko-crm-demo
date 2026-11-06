import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createClientRow, makeHarness, type Harness } from './helpers';

/**
 * Mascotas como entidad principal: búsqueda por nombre, raza y propietario,
 * filtros por especie, tamaño y dueño, y nombres repetidos distinguidos por
 * el propietario.
 */

let h: Harness;
let anaId: number;
let brunoId: number;

type PetRow = {
  id: string;
  name: string;
  species: string;
  breed: string | null;
  size: string | null;
  sizeLabel: string | null;
  clientName: string | null;
};

async function newPet(
  clientId: number,
  name: string,
  extra: Record<string, unknown>,
): Promise<string> {
  const res = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name,
    ...extra,
  });
  if (res.status !== 201) {
    throw new Error(`No se pudo crear ${name}: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.id;
}

async function search(query: string): Promise<PetRow[]> {
  const res = await call<{ data: PetRow[] }>(
    h,
    h.tokens.a,
    'GET',
    `/pets?limit=100&${query}`,
  );
  expect(res.status).toBe(200);
  return res.body.data;
}

beforeAll(async () => {
  h = await makeHarness();

  anaId = await createClientRow(h, h.tokens.a, '+573102000001', 'Ana Pérez');
  brunoId = await createClientRow(h, h.tokens.a, '+573102000002', 'Bruno Díaz');

  await newPet(anaId, 'Luna', {
    species: 'gato',
    breed: 'Siamés',
    weightKg: 4.2,
    temperament: 'Tranquila',
  });
  await newPet(anaId, 'Firulais', {
    species: 'perro',
    breed: 'Poodle',
    weightKg: 7.5,
  });
  await newPet(anaId, 'Rocky', {
    species: 'perro',
    breed: 'Golden',
    weightKg: 32,
  });
  await newPet(anaId, 'Sin Peso', {
    species: 'gato',
    breed: 'Criollo',
  });

  // Mismo nombre, otro dueño: debe poder distinguirse.
  await newPet(brunoId, 'Luna', {
    species: 'perro',
    breed: 'Beagle',
    weightKg: 12,
  });
});

afterAll(() => h.close());

describe('listado de mascotas', () => {
  it('devuelve nombre, propietario y tamaño calculado', async () => {
    const rows = await search('search=Luna');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.clientName).toBeTruthy();
      expect(row.sizeLabel).toBeTruthy();
    }
  });

  it('busca por nombre', async () => {
    const rows = await search('search=Rocky');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Rocky');
    expect(rows[0]?.clientName).toBe('Ana Pérez');
  });

  it('busca por raza', async () => {
    const rows = await search('search=Beagle');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Luna');
    expect(rows[0]?.clientName).toBe('Bruno Díaz');
  });

  it('busca por propietario y por teléfono', async () => {
    const byName = await search('search=Ana');
    expect(byName).toHaveLength(4);

    const byPhone = await search('search=573102000002');
    expect(byPhone).toHaveLength(1);
    expect(byPhone[0]?.clientName).toBe('Bruno Díaz');
  });

  it('distingue mascotas homónimas por el propietario', async () => {
    const rows = await search('search=Luna');
    const owners = rows.map((row) => row.clientName).sort();
    expect(owners).toEqual(['Ana Pérez', 'Bruno Díaz']);
  });

  it('filtra por especie', async () => {
    const cats = await search('species=gato');
    expect(cats.map((row) => row.name).sort()).toEqual(['Luna', 'Sin Peso']);

    const dogs = await search('species=perro');
    expect(dogs.map((row) => row.name).sort()).toEqual(['Firulais', 'Luna', 'Rocky']);
  });

  it('filtra por tamaño a partir del peso', async () => {
    const small = await search('size=small');
    expect(small.map((row) => row.name).sort()).toEqual(['Firulais', 'Luna']);

    const medium = await search('size=medium');
    expect(medium.map((row) => row.name)).toEqual(['Luna']);

    const large = await search('size=large');
    expect(large.map((row) => row.name)).toEqual(['Rocky']);
  });

  it('filtra por raza', async () => {
    const rows = await search('breed=Poodle');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Firulais');
  });

  it('filtra por propietario', async () => {
    const rows = await search(`clientId=${brunoId}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('Luna');
    expect(rows[0]?.clientName).toBe('Bruno Díaz');
  });

  it('combina búsqueda y filtros', async () => {
    const rows = await search('search=Luna&species=perro&size=medium');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientName).toBe('Bruno Díaz');
  });

  it('un negocio no ve las mascotas de otro', async () => {
    const res = await call<{ data: PetRow[] }>(h, h.tokens.b, 'GET', '/pets');
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it('devuelve la ficha con propietario y salud', async () => {
    const list = await search('search=Rocky');
    const res = await call<{ data: Record<string, unknown> }>(
      h,
      h.tokens.a,
      'GET',
      `/pets/${list[0]?.id}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.client).toMatchObject({ name: 'Ana Pérez' });
    expect(res.body.data.size).toBe('large');
    expect(Array.isArray(res.body.data.health)).toBe(true);
  });
});

describe('historial de la mascota', () => {
  it('incluye las citas con hora local para pintarlas en la ficha', async () => {
    const pet = await newPet(anaId, 'Nube', { species: 'perro' });

    await call(h, h.tokens.a, 'POST', '/appointments', {
      petId: pet,
      startsAt: '2026-11-05T10:00',
      durationMin: 60,
    });

    const res = await call<{
      data: {
        appointments: Array<{ startsAtLocal: string; endsAtLocal: string }>;
      };
    }>(h, h.tokens.a, 'GET', `/pets/${pet}/history`);

    expect(res.status).toBe(200);
    expect(res.body.data.appointments[0]?.startsAtLocal).toBe('2026-11-05T10:00:00');
    expect(res.body.data.appointments[0]?.endsAtLocal).toBe('2026-11-05T11:00:00');
  });
});
