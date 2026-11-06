import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, makeHarness, request, type Harness } from './helpers';
import { resolveAppointmentTime } from '../src/lib/ai/appointment-time';

let h: Harness;
let clientId: number;
let petId: string;

beforeAll(async () => {
  h = await makeHarness();
  clientId = await (async () => {
    const res = await call(h, h.tokens.a, 'POST', '/clients', {
      fullName: 'Solicitud Cita',
      phone: '+573106660099',
    });
    return Number(res.body.data.id);
  })();
  const pet = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name: 'Apolo',
    species: 'perro',
    breed: 'Beagle',
    ageYears: 13,
  });
  petId = pet.body.data.id;
});

afterAll(() => h.close());

describe('resolución determinista de fecha', () => {
  it('interpreta “mañana a las 10 de la mañana” desde el timestamp del mensaje', () => {
    const resolved = resolveAppointmentTime(
      [
        {
          id: 'm1',
          body: 'Mañana tengo agenda desde las 8',
          direction: 'outbound',
          at: '2026-11-02T21:42:03.000Z',
          contactName: null,
        },
        {
          id: 'm2',
          body: 'A las 10 de la mañana está bien',
          direction: 'inbound',
          at: '2026-11-02T21:42:15.000Z',
          contactName: null,
        },
      ],
      'mañana',
      '10 de la mañana',
    );

    expect(resolved.date).toBe('2026-11-03');
    expect(resolved.time).toBe('10:00');
    expect(resolved.startsAtLocal).toBe('2026-11-03T10:00');
  });

  it('no inventa una hora sin sufijo ni minutos', () => {
    const resolved = resolveAppointmentTime(
      [{ id: 'm1', body: 'a las 10', direction: 'inbound', at: '2026-11-02T15:00:00Z', contactName: null }],
      'mañana',
      'a las 10',
    );
    expect(resolved.date).toBe('2026-11-03');
    expect(resolved.time).toBeNull();
  });
});

describe('solicitudes de cita', () => {
  it('lista, agenda y confirma una solicitud vinculando la cita', async () => {
    const id = crypto.randomUUID();
    await h.client.execute({
      sql: `INSERT INTO appointment_requests
              (id, business_id, client_id, pet_id, contact_key, requested_service,
               requested_date, requested_time, starts_at_local, status, confidence)
            VALUES (?, 'biz-alfa', ?, ?, 'CO.TEST', 'Baño medicado',
                    'mañana', '10 de la mañana', '2026-11-03T10:00', 'pending', 0.8)`,
      args: [id, clientId, petId],
    });

    const list = await call(
      h,
      h.tokens.a,
      'GET',
      '/appointment-requests?status=pending',
    );
    expect(list.status).toBe(200);
    expect(
      list.body.data.some((row: { id: string }) => row.id === id),
    ).toBe(true);

    const appointment = await request(h, {
      method: 'POST',
      path: '/appointments',
      token: h.tokens.a,
      payload: {
        petId,
        startsAt: '2026-11-03T10:00',
        durationMin: 60,
        notes: 'Solicitud de prueba',
      },
      headers: { 'idempotency-key': crypto.randomUUID() },
    });
    expect(appointment.status).toBe(201);

    const scheduled = await request(h, {
      method: 'PATCH',
      path: `/appointment-requests/${id}`,
      token: h.tokens.a,
      payload: {
        status: 'scheduled',
        appointmentId: appointment.body.data.id,
        clientId,
        petId,
      },
    });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.data.status).toBe('scheduled');

    const confirmed = await request(h, {
      method: 'PATCH',
      path: `/appointment-requests/${id}`,
      token: h.tokens.a,
      payload: {
        status: 'confirmed',
        appointmentId: appointment.body.data.id,
      },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('confirmed');

    const rows = await h.client.execute({
      sql: 'SELECT status FROM appointments WHERE id = ?',
      args: [appointment.body.data.id],
    });
    expect(rows.rows[0]?.status).toBe('confirmed');
  });

  it('aísla las solicitudes por negocio', async () => {
    const list = await call(
      h,
      h.tokens.b,
      'GET',
      '/appointment-requests?status=pending',
    );
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('el alta automática queda pendiente y usa la fecha resuelta', async () => {
    const { applyExtraction } = await import('../src/lib/ai/apply');
    const before = await h.client.execute(
      'SELECT COUNT(*) AS n FROM appointment_requests',
    );

    await applyExtraction({
      db: h.db,
      businessId: 'biz-alfa',
      contactKey: 'CO.APOLO-AUTO',
      contactPhone: null,
      contactName: 'Contacto',
      extraction: {
        client: {},
        pets: [
          {
            name: { value: 'Apolo', confidence: 0.9, evidence: ['m1'] },
            species: { value: 'perro', confidence: 0.9, evidence: ['m1'] },
            breed: { value: 'Beagle', confidence: 0.9, evidence: ['m1'] },
            ageYears: { value: 13, confidence: 0.9, evidence: ['m2'] },
          },
        ],
        conversation: {
          intent: { value: 'appointment_request', confidence: 0.9, evidence: ['m1'] },
          requestedService: { value: 'Baño medicado', confidence: 0.9, evidence: ['m2'] },
          requestedDate: { value: 'mañana', confidence: 0.8, evidence: ['m1'] },
          requestedTime: { value: '10 de la mañana', confidence: 0.8, evidence: ['m2'] },
          openQuestions: [],
        },
        summary: 'Solicitud de baño',
      } as never,
      messages: [
        {
          id: 'm1',
          body: 'Mañana tengo agenda desde las 8',
          direction: 'outbound',
          at: '2026-11-02T21:42:03.000Z',
          contactName: null,
        },
        {
          id: 'm2',
          body: 'A las 10 de la mañana está bien. Se llama Apolo. Tiene 13 años.',
          direction: 'inbound',
          at: '2026-11-02T21:42:47.000Z',
          contactName: null,
        },
      ],
      jobId: crypto.randomUUID(),
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreateAppointmentRequests: true,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: true,
      storeRaw: false,
    });

    const after = await h.client.execute(
      'SELECT COUNT(*) AS n FROM appointment_requests',
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n) + 1);

    const row = await h.client.execute({
      sql: `SELECT status, starts_at_local FROM appointment_requests
             WHERE contact_key = 'CO.APOLO-AUTO' ORDER BY created_at DESC LIMIT 1`,
    });
    expect(row.rows[0]?.status).toBe('pending');
    expect(row.rows[0]?.starts_at_local).toBe('2026-11-03T10:00');
  });
});
