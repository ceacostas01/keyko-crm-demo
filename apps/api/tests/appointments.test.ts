import {
  BOGOTA_TZ,
  dayRangeUtc,
  localDay,
  localToUtc,
  utcToLocal,
} from '@keyko/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, createClientRow, makeHarness, type Harness } from './helpers';

let h: Harness;
let clientId: number;
let petId: string;
let otherPetId: string;

// 2026-11-02 es lunes. 10:00 en Bogotá (UTC-5) son las 15:00 UTC.
const MONDAY = '2026-11-02';

beforeAll(async () => {
  h = await makeHarness();
  clientId = await createClientRow(h, h.tokens.a, '+573102220001', 'Dueño Citas');

  const pet = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name: 'Nube',
  });
  petId = pet.body.data.id;

  const other = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name: 'Sol',
  });
  otherPetId = other.body.data.id;
});

afterAll(() => h.close());

describe('zona horaria America/Bogota', () => {
  it('convierte hora local de Bogotá a UTC', () => {
    expect(localToUtc('2026-11-02T10:00')).toBe('2026-11-02T15:00:00.000Z');
    expect(localToUtc('2026-11-02T00:00')).toBe('2026-11-02T05:00:00.000Z');
    expect(localToUtc('2026-11-02T23:59')).toBe('2026-11-03T04:59:00.000Z');
  });

  it('convierte UTC a hora local de Bogotá', () => {
    expect(utcToLocal('2026-11-02T15:00:00.000Z')).toBe('2026-11-02T10:00:00');
    expect(utcToLocal('2026-11-03T04:59:00.000Z')).toBe('2026-11-02T23:59:00');
  });

  it('un día de Bogotá empieza a las 05:00 UTC', () => {
    const range = dayRangeUtc(MONDAY);
    expect(range.startUtc).toBe('2026-11-02T05:00:00.000Z');
    expect(range.endUtc).toBe('2026-11-03T05:00:00.000Z');
  });

  it('clasifica por día local y no por día UTC', () => {
    const lateNight = localToUtc('2026-11-03T00:30');
    expect(lateNight).toBe('2026-11-03T05:30:00.000Z');
    expect(localDay(lateNight, BOGOTA_TZ)).toBe('2026-11-03');

    const beforeMidnight = localToUtc('2026-11-02T23:30');
    expect(beforeMidnight).toBe('2026-11-03T04:30:00.000Z');
    expect(localDay(beforeMidnight, BOGOTA_TZ)).toBe('2026-11-02');
  });

  it('no hay horario de verano: el desfase es -05:00 todo el año', () => {
    expect(localToUtc('2026-01-15T12:00')).toBe('2026-01-15T17:00:00.000Z');
    expect(localToUtc('2026-07-15T12:00')).toBe('2026-07-15T17:00:00.000Z');
  });
});

describe('citas: el CRM informa, no bloquea', () => {
  it('crea una cita sin exigir peluquero', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-02T10:00',
      durationMin: 60,
    });

    expect(res.status).toBe(201);
    expect(res.body.data.groomerId).toBeNull();
    expect(res.body.data.startsAt).toBe('2026-11-02T15:00:00.000Z');
    expect(res.body.data.startsAtLocal).toBe('2026-11-02T10:00:00');
    expect(res.body.warnings).toEqual([]);
  });

  it('guarda una cita solapada y la reporta como advertencia', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId: otherPetId,
      startsAt: '2026-11-02T10:30',
      durationMin: 30,
    });

    expect(res.status).toBe(201);

    const overlap = res.body.warnings.find(
      (w: { type: string }) => w.type === 'overlap',
    );
    expect(overlap).toBeDefined();
    expect(overlap.severity).toBe('warning');
    expect(overlap.conflict.overlapMinutes).toBe(30);
    expect(overlap.conflict.startsAtLocal).toBe('2026-11-02T10:00:00');
    expect(overlap.message).toContain('30 min');
    expect(overlap.message).toContain('Nube');
  });

  it('reporta todos los cruces y el tiempo total', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-02T10:15',
      durationMin: 60,
    });

    const overlaps = created.body.warnings.filter(
      (w: { type: string }) => w.type === 'overlap',
    );
    expect(overlaps).toHaveLength(2);
    expect(
      overlaps.reduce(
        (sum: number, w: { conflict: { overlapMinutes: number } }) =>
          sum + w.conflict.overlapMinutes,
        0,
      ),
    ).toBe(75);

    const detail = await call(
      h,
      h.tokens.a,
      'GET',
      `/appointments/${created.body.data.id}/conflicts`,
    );
    expect(detail.status).toBe(200);
    expect(detail.body.data.totalOverlapMinutes).toBe(75);
    expect(detail.body.data.conflicts).toHaveLength(2);
    expect(detail.body.data.conflicts[0].overlapStart).toBeTypeOf('string');
  });

  it('permite reprogramar encima de otra cita', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-02T16:00',
      durationMin: 60,
    });

    const res = await call(
      h,
      h.tokens.a,
      'PATCH',
      `/appointments/${created.body.data.id}`,
      { startsAt: '2026-11-02T10:00', durationMin: 30 },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.startsAtLocal).toBe('2026-11-02T10:00:00');

    const overlaps = res.body.warnings.filter(
      (w: { type: string }) => w.type === 'overlap',
    );
    expect(overlaps.length).toBeGreaterThan(0);
  });

  it('permite mover una cita sin cambiar la duración', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-02T13:00',
      durationMin: 45,
    });

    const res = await call(
      h,
      h.tokens.a,
      'PATCH',
      `/appointments/${created.body.data.id}`,
      { startsAt: '2026-11-02T14:00' },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.startsAtLocal).toBe('2026-11-02T14:00:00');
    expect(res.body.data.endsAtLocal).toBe('2026-11-02T14:45:00');
  });

  it('rechaza fin anterior al inicio', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-02T14:00',
      endsAt: '2026-11-02T13:00',
    });

    expect(res.status).toBe(422);
  });

  it('una cita cancelada no genera advertencias de cruce', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-02T11:00',
      durationMin: 60,
    });
    await call(h, h.tokens.a, 'DELETE', `/appointments/${created.body.data.id}`);

    const fresh = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId: otherPetId,
      startsAt: '2026-11-02T11:15',
      durationMin: 30,
    });

    const overlaps = fresh.body.warnings.filter(
      (w: { type: string }) => w.type === 'overlap',
    );
    expect(
      overlaps.some(
        (w: { conflict: { appointmentId: string } }) =>
          w.conflict.appointmentId === created.body.data.id,
      ),
    ).toBe(false);
  });

  it('avisa de horario fuera de lo habitual sin bloquear', async () => {
    const early = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-04T07:00',
      durationMin: 60,
    });

    expect(early.status).toBe(201);
    expect(
      early.body.warnings.some(
        (w: { type: string }) => w.type === 'outside_business_hours',
      ),
    ).toBe(true);

    const late = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-04T17:30',
      durationMin: 60,
    });

    expect(late.status).toBe(201);
    expect(
      late.body.warnings.some(
        (w: { type: string }) => w.type === 'outside_business_hours',
      ),
    ).toBe(true);
  });

  it('avisa de domingo sin impedir la cita', async () => {
    const res = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-08T10:00',
      durationMin: 60,
    });

    expect(res.status).toBe(201);
    expect(
      res.body.warnings.some((w: { type: string }) => w.type === 'closed_day'),
    ).toBe(true);
  });
});

describe('citas: ciclo de vida', () => {
  it('cancela, reactiva y vuelve a cancelar', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-09T09:00',
      durationMin: 60,
    });
    const id = created.body.data.id;

    const cancelled = await call(h, h.tokens.a, 'DELETE', `/appointments/${id}`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');

    // Cancelar dos veces es idempotente.
    const again = await call(h, h.tokens.a, 'DELETE', `/appointments/${id}`);
    expect(again.status).toBe(200);
    expect(again.body.data.status).toBe('cancelled');

    const reactivated = await call(
      h,
      h.tokens.a,
      'POST',
      `/appointments/${id}/reactivate`,
      {},
    );
    expect(reactivated.status).toBe(200);
    expect(reactivated.body.data.status).toBe('scheduled');

    // Reactivar una cita activa no rompe nada.
    const twice = await call(
      h,
      h.tokens.a,
      'POST',
      `/appointments/${id}/reactivate`,
      {},
    );
    expect(twice.status).toBe(200);
    expect(twice.body.data.status).toBe('scheduled');
  });

  it('permite reactivar como confirmada', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-09T11:00',
      durationMin: 60,
    });
    const id = created.body.data.id;
    await call(h, h.tokens.a, 'DELETE', `/appointments/${id}`);

    const res = await call(
      h,
      h.tokens.a,
      'POST',
      `/appointments/${id}/reactivate`,
      { status: 'confirmed' },
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('confirmed');
  });
});

describe('agenda: listado y advertencias', () => {
  it('lista con advertencias incluidas por defecto', async () => {
    const res = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments?from=2026-11-02&to=2026-11-02&limit=100',
    );

    expect(res.status).toBe(200);
    const withWarnings = res.body.data.filter(
      (row: { warnings: unknown[] }) => row.warnings.length > 0,
    );
    expect(withWarnings.length).toBeGreaterThan(0);
    expect(res.body.data[0].startsAtLocal).toBeTypeOf('string');
  });

  it('permite pedir el listado sin calcular cruces', async () => {
    const res = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments?from=2026-11-02&to=2026-11-02&withConflicts=false&limit=100',
    );

    expect(res.status).toBe(200);
    expect(
      res.body.data.every((row: { warnings: unknown[] }) => row.warnings.length === 0),
    ).toBe(true);
  });

  it('filtra por rango de días en hora local', async () => {
    const late = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-03T00:30',
      durationMin: 30,
    });
    expect(late.status).toBe(201);

    const day = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments?from=2026-11-03&to=2026-11-03&limit=100',
    );
    expect(day.body.data.map((a: { id: string }) => a.id)).toContain(
      late.body.data.id,
    );

    const previous = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments?from=2026-11-02&to=2026-11-02&limit=100',
    );
    expect(previous.body.data.map((a: { id: string }) => a.id)).not.toContain(
      late.body.data.id,
    );
  });
});

describe('disponibilidad orientativa', () => {
  it('devuelve franjas del horario de atención y se declara orientativa', async () => {
    const res = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments/availability?date=2026-11-11&durationMin=60&stepMin=30',
    );

    expect(res.status).toBe(200);
    expect(res.body.data.advisory).toBe(true);
    expect(res.body.data.open).toBe(true);
    expect(res.body.data.businessHours).toEqual({
      open: '08:00',
      close: '18:00',
      closed: false,
    });

    const first = res.body.data.slots[0];
    expect(first.startLocal).toBe('2026-11-11T08:00:00');
    expect(first.start).toBe('2026-11-11T13:00:00.000Z');
    expect(res.body.data.slots.at(-1).startLocal).toBe('2026-11-11T17:00:00');
  });

  it('excluye las franjas ocupadas pero no impide reservarlas', async () => {
    const created = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-05T09:00',
      durationMin: 60,
    });
    expect(created.status).toBe(201);

    const availability = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments/availability?date=2026-11-05&durationMin=60&stepMin=30',
    );
    const locals = availability.body.data.slots.map(
      (s: { startLocal: string }) => s.startLocal,
    );
    expect(locals).not.toContain('2026-11-05T09:00:00');
    expect(locals).toContain('2026-11-05T10:00:00');

    // La API acepta igualmente la hora ocupada.
    const forced = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId: otherPetId,
      startsAt: '2026-11-05T09:00',
      durationMin: 60,
    });
    expect(forced.status).toBe(201);
    expect(
      forced.body.warnings.some((w: { type: string }) => w.type === 'overlap'),
    ).toBe(true);
  });

  it('domingo: sin sugerencias, pero se puede reservar', async () => {
    const res = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments/availability?date=2026-11-08&durationMin=60',
    );

    expect(res.status).toBe(200);
    expect(res.body.data.open).toBe(false);
    expect(res.body.data.businessHours.closed).toBe(true);
    expect(res.body.data.slots).toHaveLength(0);

    const forced = await call(h, h.tokens.a, 'POST', '/appointments', {
      petId,
      startsAt: '2026-11-08T12:00',
      durationMin: 60,
    });
    expect(forced.status).toBe(201);
  });

  it('no sugiere una franja que termina después del cierre', async () => {
    const res = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointments/availability?date=2026-11-06&durationMin=60&stepMin=30',
    );

    const locals = res.body.data.slots.map(
      (s: { startLocal: string }) => s.startLocal,
    );
    expect(locals).not.toContain('2026-11-06T17:30:00');
    expect(locals.at(-1)).toBe('2026-11-06T17:00:00');
  });
});
