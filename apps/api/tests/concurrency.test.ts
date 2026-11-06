import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  call,
  createClientRow,
  makeHarness,
  request,
  type ApiResponse,
  type Harness,
} from './helpers';

/**
 * Concurrencia e idempotencia.
 *
 * La agenda ya no bloquea por solapamiento: dos citas a la misma hora son
 * legítimas. Lo que sigue protegido es el doble envío de la MISMA operación.
 */

let h: Harness;
let clientId: number;
let petId: string;

beforeAll(async () => {
  h = await makeHarness();
  clientId = await createClientRow(h, h.tokens.a, '+573104440001', 'Concurrencia');
  const pet = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name: 'Rayo',
  });
  petId = pet.body.data.id;
});

afterAll(() => h.close());

function tally(statuses: number[]) {
  return statuses.reduce<Record<number, number>>((acc, status) => {
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});
}

describe('duplicados de negocio', () => {
  it('8 altas simultáneas con el mismo teléfono dejan un cliente', async () => {
    const phone = '+573104440777';
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(h, h.tokens.a, 'POST', '/clients', {
          fullName: 'Cliente Carrera',
          phone,
        }),
      ),
    );

    const counts = tally(attempts.map((res) => res.status));
    expect(counts[201]).toBe(1);
    expect(counts[409]).toBe(7);
    expect(counts[500]).toBeUndefined();

    const list = await call(
      h,
      h.tokens.a,
      'GET',
      '/clients?search=573104440777&limit=100',
    );
    expect(list.body.data).toHaveLength(1);
  });

  it('8 altas simultáneas con el mismo SKU dejan un artículo', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(h, h.tokens.a, 'POST', '/products', {
          sku: 'CARRERA-01',
          name: 'Artículo carrera',
          priceCents: 1000000,
        }),
      ),
    );

    const counts = tally(attempts.map((res) => res.status));
    expect(counts[201]).toBe(1);
    expect(counts[409]).toBe(7);
    expect(counts[500]).toBeUndefined();
  });
});

describe('inventario', () => {
  it('no vende más unidades de las que hay', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Stock justo',
      priceCents: 500000,
      stock: 3,
    });
    const id = created.body.data.id;

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        call(h, h.tokens.a, 'POST', `/products/${id}/stock`, {
          delta: -1,
          reason: 'Venta simultánea',
          refType: 'sale',
        }),
      ),
    );

    const counts = tally(attempts.map((res) => res.status));
    expect(counts[200]).toBe(3);
    expect(counts[422]).toBe(3);
    expect(counts[500]).toBeUndefined();

    const detail = await call(h, h.tokens.a, 'GET', `/products/${id}`);
    expect(detail.body.data.stock).toBe(0);
    expect(detail.body.data.movements).toHaveLength(3);
  });

  it('las compras simultáneas suman todas', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/products', {
      name: 'Stock suma',
      priceCents: 500000,
      stock: 0,
    });
    const id = created.body.data.id;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        call(h, h.tokens.a, 'POST', `/products/${id}/stock`, {
          delta: 2,
          reason: 'Compra simultánea',
        }),
      ),
    );

    const detail = await call(h, h.tokens.a, 'GET', `/products/${id}`);
    expect(detail.body.data.stock).toBe(10);
    expect(detail.body.data.movements).toHaveLength(5);
  });
});

describe('idempotencia de citas', () => {
  function createWithKey(
    key: string,
    startsAt = '2026-11-16T09:00',
  ): Promise<ApiResponse> {
    return request(h, {
      method: 'POST',
      path: '/appointments',
      token: h.tokens.a,
      headers: { 'idempotency-key': key },
      payload: { petId, startsAt, durationMin: 60 },
    });
  }

  it('un reintento con la misma clave devuelve la misma cita', async () => {
    const key = 'cita-doble-clic-0001';

    const first = await createWithKey(key);
    const second = await createWithKey(key);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers.get('idempotency-replayed')).toBe('true');

    const list = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments?from=2026-11-16&to=2026-11-16&limit=100',
    );
    expect(list.body.data).toHaveLength(1);
  });

  it('envíos simultáneos con la misma clave crean una sola cita', async () => {
    const key = 'cita-doble-clic-0002';
    const startsAt = '2026-11-17T09:00';

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () => createWithKey(key, startsAt)),
    );

    const ok = attempts.filter((res) => res.status === 201);
    const busy = attempts.filter((res) => res.status === 409);

    // Ninguna respuesta puede ser un error interno.
    expect(attempts.every((res) => res.status < 500)).toBe(true);
    expect(ok.length + busy.length).toBe(attempts.length);
    expect(ok.length).toBeGreaterThanOrEqual(1);

    // Todas las que respondieron apuntan a la misma cita.
    expect(new Set(ok.map((res) => res.body.data.id)).size).toBe(1);

    // Las que llegaron mientras la primera se procesaba piden reintentar.
    for (const res of busy) {
      expect(res.body.error.code).toBe('idempotency_in_progress');
    }

    const list = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments?from=2026-11-17&to=2026-11-17&limit=100',
    );
    const matching = list.body.data.filter(
      (row: { startsAtLocal: string }) =>
        row.startsAtLocal === '2026-11-17T09:00:00',
    );
    expect(matching).toHaveLength(1);
    expect(matching[0].id).toBe(ok[0]?.body.data.id);
  });

  it('la misma clave con otros datos es un conflicto', async () => {
    const key = 'cita-doble-clic-0003';
    await createWithKey(key, '2026-11-18T09:00');

    const reused = await createWithKey(key, '2026-11-18T15:00');

    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe('idempotency_key_reuse');
  });

  it('una clave corta se rechaza con un mensaje claro', async () => {
    const res = await createWithKey('abc');
    expect(res.status).toBe(400);
  });

  it('sin cabecera cada envío crea su propia cita', async () => {
    const first = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-19T09:00',
      durationMin: 60,
    });
    const second = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-19T09:00',
      durationMin: 60,
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.body.data.id);
  });

  it('protege también la reprogramación', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-20T09:00',
      durationMin: 60,
    });
    const id = created.body.data.id;
    const key = 'mover-cita-0001';

    const move = () =>
      request(h, {
        method: 'PATCH',
        path: `/appointments/${id}`,
        token: h.tokens.a,
        headers: { 'idempotency-key': key },
        payload: { startsAt: '2026-11-20T11:00' },
      });

    const [a, b] = await Promise.all([move(), move()]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.data.startsAtLocal).toBe('2026-11-20T11:00:00');

    const audit = await call(
      h,
      h.tokens.a,
      'GET',
      '/audit?action=appointment.update&limit=100',
    );
    const moves = audit.body.data.filter(
      (row: { entityId: string }) => row.entityId === id,
    );
    expect(moves).toHaveLength(1);
  });
});

describe('la agenda acepta solapamientos en paralelo', () => {
  it('12 citas simultáneas al mismo horario se guardan todas', async () => {
    const attempts = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        call(h, h.tokens.a, 'POST', '/appointments', {
          petId,
          startsAt: '2026-11-23T09:00',
          durationMin: 60,
          notes: `intento ${index}`,
        }),
      ),
    );

    expect(attempts.every((res) => res.status === 201)).toBe(true);

    const list = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments?from=2026-11-23&to=2026-11-23&limit=100',
    );
    expect(list.body.data).toHaveLength(12);

    // Todas se avisan mutuamente: cada una cruza con las otras 11.
    const first = list.body.data[0];
    const overlaps = first.warnings.filter(
      (w: { type: string }) => w.type === 'overlap',
    );
    expect(overlaps).toHaveLength(11);
  });
});
