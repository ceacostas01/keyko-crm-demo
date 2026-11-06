import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers';
import { applyExtraction } from '../src/lib/ai/apply';

let h: Harness;

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(() => h.close());

describe('identidad de cliente manual', () => {
  it('una ficha creada a mano se reconoce por el teléfono de WhatsApp aunque la clave sea BSUID', async () => {
    const inserted = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-alfa', 'CO.MANUAL-MATCH', '+573105557700', 'Cliente Manual')`,
    });
    const clientId = Number(inserted.lastInsertRowid);

    const before = await h.client.execute(
      "SELECT COUNT(*) AS n FROM clients WHERE business_id = 'biz-alfa'",
    );

    await applyExtraction({
      db: h.db,
      businessId: 'biz-alfa',
      contactKey: 'CO.MANUAL-MATCH',
      contactPhone: '573105557700',
      contactName: 'Perfil WhatsApp',
      extraction: {
        client: {},
        pets: [
          {
            name: { value: 'Apolo', confidence: 0.9, evidence: ['m1'] },
            species: { value: 'perro', confidence: 0.9, evidence: ['m1'] },
          },
        ],
        conversation: { openQuestions: [] },
        summary: 'Mascota mencionada',
      } as never,
      messages: [
        {
          id: 'm1',
          body: 'Mi perro se llama Apolo',
          direction: 'inbound',
          at: '2026-11-02T21:00:00Z',
          contactName: 'Perfil WhatsApp',
        },
      ],
      jobId: crypto.randomUUID(),
      model: 'test',
      raw: '',
      autoApply: false,
      autoCreateAppointmentRequests: false,
      autoConfirmAppointments: false,
      contactAuthorizedForAppointments: false,
      storeRaw: false,
    });

    const after = await h.client.execute(
      "SELECT COUNT(*) AS n FROM clients WHERE business_id = 'biz-alfa'",
    );
    expect(Number(after.rows[0]?.n)).toBe(Number(before.rows[0]?.n));

    const suggestion = await h.client.execute({
      sql: `SELECT parsed_json FROM ai_extractions
             WHERE business_id = 'biz-alfa' ORDER BY created_at DESC LIMIT 1`,
    });
    const parsed = JSON.parse(String(suggestion.rows[0]?.parsed_json)) as {
      kind: string;
      clientId: number | null;
    };
    expect(parsed.kind).toBe('pet_create');
    expect(parsed.clientId).toBe(clientId);
  });
});
