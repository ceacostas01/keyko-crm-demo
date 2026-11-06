/**
 * Evaluación de la extracción con IA.
 *
 * 70 conversaciones ficticias con resultados esperados. Mide precisión y
 * recall por campo, exactitud de intención, falsos positivos, duplicados,
 * descartes correctos, descartes indebidos de las guardas, tokens, costo y
 * latencia.
 *
 * Por defecto usa el proveedor `fake` (sin red ni costo). Con
 * AI_PROVIDER=openrouter y una clave nueva hace la misma prueba con el modelo.
 *
 *   pnpm --filter @keyko/api ai:eval
 *   AI_PROVIDER=openrouter AI_API_KEY=... pnpm --filter @keyko/api ai:eval
 */
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@keyko/db';
import { createClient } from '@libsql/client';
import { guardExtraction } from '../src/lib/ai/apply';
import { aiConfig } from '../src/lib/ai/config';
import type { AiProvider, ExtractionInput } from '../src/lib/ai/fake';
import { getProvider } from '../src/lib/ai/provider';
import { processAiJobs } from '../src/lib/ai/jobs';
import type { Extraction } from '../src/lib/ai/schema';

const MIGRATIONS = new URL('../../../migrations/', import.meta.url);

type ExpectedPet = {
  name: string;
  species?: 'perro' | 'gato';
  breed?: string;
  sex?: 'macho' | 'hembra';
  weightKg?: number;
};

type EvalCase = {
  id: string;
  contact: string;
  phone: string;
  profileName: string;
  messages: string[];
  existing?: {
    phone: string;
    name: string;
    pets: Array<{ name: string; species: string; breed?: string }>;
  };
  expected: {
    clientName?: string;
    phone?: string;
    pets: ExpectedPet[];
    intent?: 'service_inquiry' | 'availability_inquiry' | 'appointment_request';
  };
};

// --- Generadores -----------------------------------------------------------

const NAMES = [
  'Sofía Ramírez',
  'Carlos Ruiz',
  'Marcela Gómez',
  'Andrés Molina',
  'Valentina Cruz',
  'Julián Ríos',
  'Camila Torres',
  'Diego Herrera',
  'Paula Mesa',
  'Ricardo Vega',
  'Elena Pardo',
  'Tomás Vera',
  'Laura Cifuentes',
  'Bruno Díaz',
  'Inés Rojas',
  'Felipe Navarro',
  'Sara Luna',
  'Mateo Salas',
  'Verónica Pineda',
  'Óscar Duarte',
];

const PETS: Array<{
  name: string;
  article: string;
  species: 'perro' | 'gato';
  sex: 'macho' | 'hembra';
  breed: string;
  weight: number;
}> = [
  { name: 'Nala', article: 'perrita', species: 'perro', sex: 'hembra', breed: 'french poodle', weight: 4 },
  { name: 'Tom', article: 'gato', species: 'gato', sex: 'macho', breed: 'siamés', weight: 5 },
  { name: 'Rocky', article: 'perro', species: 'perro', sex: 'macho', breed: 'beagle', weight: 12 },
  { name: 'Luna', article: 'gata', species: 'gato', sex: 'hembra', breed: 'siamés', weight: 4 },
  { name: 'Milo', article: 'perro', species: 'perro', sex: 'macho', breed: 'schnauzer', weight: 8 },
  { name: 'Kira', article: 'perra', species: 'perro', sex: 'hembra', breed: 'labrador', weight: 22 },
  { name: 'Simón', article: 'gato', species: 'gato', sex: 'macho', breed: 'criollo', weight: 3 },
  { name: 'Canela', article: 'perrita', species: 'perro', sex: 'hembra', breed: 'criollo', weight: 6 },
  { name: 'Bruno', article: 'perro', species: 'perro', sex: 'macho', breed: 'golden retriever', weight: 28 },
  { name: 'Misha', article: 'gata', species: 'gato', sex: 'hembra', breed: 'criollo', weight: 4 },
  { name: 'Zeus', article: 'perro', species: 'perro', sex: 'macho', breed: 'pastor alemán', weight: 30 },
  { name: 'Pipo', article: 'gato', species: 'gato', sex: 'macho', breed: 'criollo', weight: 3 },
  { name: 'Coco', article: 'perro', species: 'perro', sex: 'macho', breed: 'beagle', weight: 11 },
  { name: 'Nina', article: 'perra', species: 'perro', sex: 'hembra', breed: 'poodle', weight: 5 },
  { name: 'Toby', article: 'perro', species: 'perro', sex: 'macho', breed: 'criollo', weight: 9 },
  { name: 'Mía', article: 'gata', species: 'gato', sex: 'hembra', breed: 'siamés', weight: 4 },
  { name: 'Rex', article: 'perro', species: 'perro', sex: 'macho', breed: 'labrador', weight: 20 },
  { name: 'Frida', article: 'perra', species: 'perro', sex: 'hembra', breed: 'schnauzer', weight: 7 },
  { name: 'Lucas', article: 'perro', species: 'perro', sex: 'macho', breed: 'poodle', weight: 6 },
  { name: 'Cleo', article: 'gata', species: 'gato', sex: 'hembra', breed: 'criollo', weight: 3 },
];

const DAYS = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const TIMES = ['9:00', '10:00', '11:30', '15:00', '16:30'];

function contact(index: number): { contact: string; phone: string } {
  const suffix = String(index + 1).padStart(4, '0');
  return {
    contact: `CO.EVAL${suffix}`,
    phone: `57315558${suffix}`,
  };
}

function buildCases(): EvalCase[] {
  const cases: EvalCase[] = [];

  // 20 clientes nuevos con mascota e intención de cita.
  for (let index = 0; index < 20; index += 1) {
    const name = NAMES[index % NAMES.length] as string;
    const pet = PETS[index % PETS.length] as (typeof PETS)[number];
    const day = DAYS[index % DAYS.length] as string;
    const time = TIMES[index % TIMES.length] as string;
    const ids = contact(index);
    const plan = index % 4;

    const first =
      plan === 0
        ? `Hola, me llamo ${name} y tengo un${pet.article.endsWith('a') ? 'a' : ''} ${pet.article} llamad${pet.article.endsWith('a') ? 'a' : 'o'} ${pet.name}, es ${pet.breed} y pesa ${pet.weight} kg.`
        : plan === 1
          ? `Buenas, soy ${name}. Mi ${pet.article} ${pet.name} es ${pet.breed}, pesa ${pet.weight} kg.`
          : plan === 2
            ? `Hola, me llamo ${name}. Tengo una mascota llamada ${pet.name}, es ${pet.breed} y pesa ${pet.weight} kg.`
            : `ola, me llamo ${name} y mi ${pet.article} se llama ${pet.name}, raza ${pet.breed}, ${pet.weight} kg.`;

    const second =
      index % 3 === 0
        ? `Quiero agendar baño y corte para el ${day} a las ${time}.`
        : index % 3 === 1
          ? `Quisiera reservar una cita el ${day} a las ${time} para baño.`
          : `Me gustaría agendar el ${day} a las ${time}.`;

    cases.push({
      id: `nuevo-${index + 1}`,
      ...ids,
      profileName: name.split(' ')[0] as string,
      messages: index % 5 === 0 ? [first, second] : [first, '¿Tienen disponibilidad?', second],
      expected: {
        clientName: name,
        phone: `+${ids.phone}`,
        pets: [
          {
            name: pet.name,
            // En el plan 2 el mensaje dice "mascota", sin especie explícita.
            ...(plan === 2 ? {} : { species: pet.species }),
            breed: pet.breed,
            ...(pet.article.endsWith('a') || pet.article === 'perra' || pet.article === 'gata'
              ? { sex: 'hembra' as const }
              : {}),
            weightKg: pet.weight,
          },
        ],
        intent: 'appointment_request',
      },
    });
  }

  // 10 consultas de precio.
  const services = ['corte completo', 'baño', 'corte de uñas', 'peluquería', 'baño medicado'];
  for (let index = 0; index < 10; index += 1) {
    const ids = contact(20 + index);
    const service = services[index % services.length] as string;
    cases.push({
      id: `precio-${index + 1}`,
      ...ids,
      profileName: 'Consulta',
      messages: [`Hola, ¿cuánto cuesta el ${service} para un perro mediano?`],
      expected: { phone: `+${ids.phone}`, pets: [], intent: 'service_inquiry' },
    });
  }

  // 10 consultas de disponibilidad.
  const slots = [
    '¿tienen cupo para el sábado?',
    '¿hay disponibilidad mañana?',
    '¿a qué hora abren el domingo?',
    '¿tienen espacio esta semana?',
    '¿hay lugar para el viernes?',
  ];
  for (let index = 0; index < 10; index += 1) {
    const ids = contact(30 + index);
    cases.push({
      id: `cupo-${index + 1}`,
      ...ids,
      profileName: 'Cupo',
      messages: [`Buenas, ${slots[index % slots.length] as string}`],
      expected: { phone: `+${ids.phone}`, pets: [], intent: 'availability_inquiry' },
    });
  }

  // 10 solicitudes explícitas de cita (3 con errores ortográficos).
  for (let index = 0; index < 10; index += 1) {
    const ids = contact(40 + index);
    const day = DAYS[index % DAYS.length] as string;
    const time = TIMES[index % TIMES.length] as string;
    const typo = index >= 7;
    const body = typo
      ? `kiero agendar una cita el ${day} a las ${time}`
      : index % 2 === 0
        ? `Quiero agendar una cita el ${day} a las ${time}.`
        : `Necesito reservar una cita para el ${day} a las ${time}.`;

    cases.push({
      id: `cita-${index + 1}`,
      ...ids,
      profileName: 'Cita',
      messages: [body],
      expected: { phone: `+${ids.phone}`, pets: [], intent: 'appointment_request' },
    });
  }

  // 5 clientes existentes que agregan otra mascota.
  for (let index = 0; index < 5; index += 1) {
    const ids = contact(50 + index);
    const pet = PETS[(index + 5) % PETS.length] as (typeof PETS)[number];
    cases.push({
      id: `existente-${index + 1}`,
      ...ids,
      profileName: 'Cliente',
      messages: [
        `Hola, quiero agendar un baño para mi ${pet.article} ${pet.name}, es ${pet.breed} y pesa ${pet.weight} kg.`,
      ],
      existing: {
        phone: `+${ids.phone}`,
        name: `Cliente ${index + 1}`,
        pets: [{ name: 'Luna', species: 'gato', breed: 'Siamés' }],
      },
      expected: {
        pets: [
          {
            name: pet.name,
            species: pet.species,
            breed: pet.breed,
            weightKg: pet.weight,
            ...(pet.article.endsWith('a') ? { sex: 'hembra' as const } : {}),
          },
        ],
        intent: 'appointment_request',
      },
    });
  }

  // 5 mascotas con el mismo nombre y otro dueño.
  for (let index = 0; index < 5; index += 1) {
    const ids = contact(55 + index);
    const breed = ['poodle', 'beagle', 'labrador', 'criollo', 'schnauzer'][index] as string;
    cases.push({
      id: `homónima-${index + 1}`,
      ...ids,
      profileName: 'Otro',
      messages: [`Hola, mi perra Luna es una ${breed} y pesa ${8 + index} kg.`],
      existing: {
        phone: `+${ids.phone}`,
        name: `Dueño ${index + 1}`,
        pets: [{ name: 'Luna', species: 'perro' }],
      },
      expected: {
        pets: [
          {
            name: 'Luna',
            sex: 'hembra',
            breed,
            weightKg: 8 + index,
          },
        ],
      },
    });
  }

  // 5 mensajes incompletos.
  const short = ['Hola, buenas tardes.', 'Buenas, ¿cómo están?', 'Hola 👋', 'Buen día', 'Hola, escribo luego.'];
  for (let index = 0; index < 5; index += 1) {
    const ids = contact(60 + index);
    cases.push({
      id: `incompleto-${index + 1}`,
      ...ids,
      profileName: 'Corto',
      messages: [short[index] as string],
      expected: { phone: `+${ids.phone}`, pets: [] },
    });
  }

  // 5 contradicciones.
  for (let index = 0; index < 5; index += 1) {
    const ids = contact(65 + index);
    const breed = ['poodle', 'beagle', 'labrador', 'criollo', 'schnauzer'][index] as string;
    cases.push({
      id: `contradiccion-${index + 1}`,
      ...ids,
      profileName: 'Contra',
      messages: [`Mi gata Luna es una ${breed}, ¿la pueden bañar?`],
      existing: {
        phone: `+${ids.phone}`,
        name: `Dueño C ${index + 1}`,
        pets: [{ name: 'Luna', species: 'gato', breed: 'Siamés' }],
      },
      expected: {
        pets: [{ name: 'Luna', sex: 'hembra', breed }],
        intent: 'service_inquiry',
      },
    });
  }

  // 3 con errores ortográficos fuertes: el proveedor determinista falla y
  // el reporte debe reflejarlo.
  const typos = [
    'nesesito reserbar una cita para el sabado',
    'kiero separar una cita el viernes',
    'ola, puedo azer una riserba para el lunes?',
  ];
  for (let index = 0; index < typos.length; index += 1) {
    const ids = contact(70 + index);
    cases.push({
      id: `typo-${index + 1}`,
      ...ids,
      profileName: 'Typo',
      messages: [typos[index] as string],
      expected: { phone: `+${ids.phone}`, pets: [], intent: 'appointment_request' },
    });
  }

  return cases;
}

const CASES = buildCases();

// --- Comparación -----------------------------------------------------------

function norm(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function digits(value: unknown): string {
  return String(value ?? '').replace(/\D/g, '');
}

type Flat = Map<string, unknown>;

function addPetFields(flat: Flat, petFields: Array<{ field: string; value: unknown }>) {
  const name = petFields.find((field) => field.field === 'name')?.value;
  if (!name) return;
  for (const field of petFields) {
    if (field.field === 'name') {
      flat.set(`pet.${norm(name)}.name`, field.value);
      continue;
    }
    flat.set(`pet.${norm(name)}.${field.field}`, field.value);
  }
}

/** Campos de una extracción del proveedor (antes de las guardas). */
function flattenExtraction(extraction: Extraction): Flat {
  const flat: Flat = new Map();

  if (extraction.client.fullName) {
    flat.set('client.fullName', extraction.client.fullName.value);
  }
  if (extraction.client.phone) {
    flat.set('client.phone', extraction.client.phone.value);
  }
  for (const pet of extraction.pets) {
    if (!pet.name?.value) continue;
    const fields: Array<{ field: string; value: unknown }> = [
      { field: 'name', value: pet.name.value },
    ];
    for (const key of ['species', 'breed', 'sex', 'weightKg'] as const) {
      const field = pet[key];
      if (field) fields.push({ field: key, value: field.value });
    }
    addPetFields(flat, fields);
  }

  const intent = extraction.conversation.intent?.value;
  if (intent) flat.set('intent', intent);

  return flat;
}

/** Campos observados en las sugerencias creadas por el pipeline. */
function flattenSuggestions(
  rows: Array<{ parsed_json: string }>,
  fallbackPetName?: string,
): Flat {
  const flat: Flat = new Map();

  for (const row of rows) {
    const parsed = JSON.parse(String(row.parsed_json)) as {
      kind: string;
      petId?: string | null;
      fields?: Array<{ field: string; value: unknown }>;
      pets?: Array<{ fields: Array<{ field: string; value: unknown }> }>;
    };

    if (
      ['service_inquiry', 'availability_inquiry', 'appointment_request'].includes(
        parsed.kind,
      )
    ) {
      flat.set('intent', parsed.kind);
    }

    const name = parsed.fields?.find((field) => field.field === 'name')?.value;
    const isPetPayload = parsed.kind === 'pet_create' || parsed.kind === 'pet_update';

    if (isPetPayload) {
      const petName = name ?? fallbackPetName;
      if (petName) {
        for (const field of parsed.fields ?? []) {
          flat.set(
            field.field === 'name'
              ? `pet.${norm(petName)}.name`
              : `pet.${norm(petName)}.${field.field}`,
            field.value,
          );
        }
      }
    } else {
      for (const field of parsed.fields ?? []) {
        if (field.field === 'fullName') flat.set('client.fullName', field.value);
        else if (field.field === 'phone') flat.set('client.phone', field.value);
      }
    }

    for (const pet of parsed.pets ?? []) {
      addPetFields(flat, pet.fields);
    }
  }

  return flat;
}

function expectedFlat(testCase: EvalCase): Array<{ key: string; value: unknown }> {
  const fields: Array<{ key: string; value: unknown }> = [];
  const existingPets = new Set(
    (testCase.existing?.pets ?? []).map((pet) => norm(pet.name)),
  );

  if (testCase.expected.clientName) {
    fields.push({ key: 'client.fullName', value: testCase.expected.clientName });
  }
  if (testCase.expected.phone) {
    fields.push({ key: 'client.phone', value: testCase.expected.phone });
  }
  for (const pet of testCase.expected.pets) {
    const prefix = `pet.${norm(pet.name)}`;
    // Si la mascota ya existe, el nombre no se vuelve a extraer.
    if (!existingPets.has(norm(pet.name))) {
      fields.push({ key: `${prefix}.name`, value: pet.name });
    }
    for (const [field, value] of Object.entries(pet)) {
      if (field === 'name') continue;
      fields.push({ key: `${prefix}.${field}`, value });
    }
  }
  if (testCase.expected.intent) {
    fields.push({ key: 'intent', value: testCase.expected.intent });
  }

  return fields;
}

function matches(key: string, expected: unknown, flat: Flat): boolean {
  const actual = flat.get(key);
  if (actual === undefined) return false;
  if (key === 'client.phone') return digits(actual) === digits(expected);
  if (typeof expected === 'number') return Number(actual) === expected;

  return norm(actual) === norm(expected);
}

function fieldGroup(key: string): string {
  if (key === 'intent') return 'intención';
  if (key === 'client.fullName') return 'cliente.nombre';
  if (key === 'client.phone') return 'cliente.teléfono';
  if (key.endsWith('.name')) return 'mascota.nombre';
  return `mascota.${key.split('.').pop()}`;
}

// --- Ejecución -------------------------------------------------------------

async function main() {
  const providerName = process.env.AI_PROVIDER === 'openrouter' ? 'openrouter' : 'fake';
  const config = aiConfig(process.env as never);

  if (providerName === 'openrouter' && !config.apiKey) {
    throw new Error('Falta AI_API_KEY para la evaluación con OpenRouter');
  }

  const file = join(tmpdir(), `keyko-eval-${randomUUID()}.db`);
  const client = createClient({ url: `file:${file}` });

  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(readFileSync(new URL(name, MIGRATIONS), 'utf8'));
  }

  await client.execute(
    `INSERT INTO businesses (id, name, slug) VALUES ('eval', 'Evaluación', 'eval')`,
  );

  for (const testCase of CASES) {
    if (!testCase.existing) continue;
    const created = await client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('eval', ?, ?, ?) RETURNING id`,
      args: [testCase.existing.phone, testCase.existing.phone, testCase.existing.name],
    });
    const clientId = Number(created.rows[0]?.id);
    for (const pet of testCase.existing.pets) {
      await client.execute({
        sql: `INSERT INTO pets (id, business_id, client_id, name, species, breed)
              VALUES (?, 'eval', ?, ?, ?, ?)`,
        args: [randomUUID(), clientId, pet.name, pet.species, pet.breed ?? null],
      });
    }
  }

  const provider = getProvider(config);
  const db = createDb(client);

  const perField = new Map<
    string,
    { expected: number; matched: number; falsePositives: number }
  >();

  let rawMatchedTotal = 0;
  let guardedMatchedTotal = 0;
  let correctlyDiscarded = 0;

  const outcomes: Array<{
    id: string;
    expected: number;
    matched: number;
    falsePositives: string[];
    falsePositiveValues?: string[];
    missing: string[];
    duplicates: number;
    guardDrops: string[];
    suggestions: number;
  }> = [];

  for (const testCase of CASES) {
    const before = await client.execute('SELECT id FROM ai_extractions');
    const known = new Set(before.rows.map((row) => String(row.id)));

    const input: ExtractionInput = {
      contactKey: testCase.contact,
      contactPhone: testCase.phone,
      contactName: testCase.profileName,
      messages: testCase.messages.map((body, index) => ({
        id: `${testCase.id}-${index}`,
        direction: 'inbound',
        at: new Date(Date.now() + index * 60_000).toISOString(),
        contactName: testCase.profileName,
        body,
      })),
    };


    for (const [index, body] of testCase.messages.entries()) {
      await client.execute({
        sql: `INSERT INTO whatsapp_messages
                (message_id, business_id, direction, contact_key, contact_phone,
                 contact_name, message_type, body, message_timestamp, raw_message_json)
              VALUES (?, 'eval', 'inbound', ?, ?, ?, 'text', ?, ?, '{}')`,
        args: [
          `${testCase.id}-${index}`,
          testCase.contact,
          testCase.phone,
          testCase.profileName,
          body,
          new Date(Date.now() + index * 60_000).toISOString(),
        ],
      });
    }

    const capture: { value: { raw: unknown; guarded: unknown } | null } = {
      value: null,
    };

    const run = await processAiJobs(db, 'eval', {
      config,
      limit: 10,
      onExtraction: (info) => {
        capture.value = { raw: info.raw, guarded: info.guarded };
      },
    });
    if (run.failed > 0) {
      await processAiJobs(db, 'eval', { config, limit: 10 });
    }

    if (process.argv.includes('--verbose') && !capture.value) {
      const errors = await client.execute({
        sql: "SELECT last_error, attempts FROM ai_jobs WHERE business_id = 'eval' AND wa_contact = ? ORDER BY created_at DESC LIMIT 1",
        args: [testCase.contact],
      });
      console.log(
        `  ⚠ ${testCase.id} sin extracción · intentos=${errors.rows[0]?.attempts} · ${errors.rows[0]?.last_error ?? 'sin error'}`,
      );
    }

    // Comparación crudo vs. guardas con la misma llamada al proveedor.
    let guardDrops: string[] = [];
    let rawMatched = 0;
    let guardedMatched = 0;

    if (capture.value) {
      const rawFlat = flattenExtraction(capture.value.raw as Extraction);
      const guardedFlat = flattenExtraction(capture.value.guarded as Extraction);
      const expected = expectedFlat(testCase);

      rawMatched = expected.filter((field) =>
        matches(field.key, field.value, rawFlat),
      ).length;
      guardedMatched = expected.filter((field) =>
        matches(field.key, field.value, guardedFlat),
      ).length;

      guardDrops = expected
        .filter((field) => field.key !== 'client.phone')
        .filter((field) => matches(field.key, field.value, rawFlat))
        .filter((field) => !matches(field.key, field.value, guardedFlat))
        .map((field) => field.key);

      const expectedKeysRaw = new Set(expected.map((field) => field.key));
      for (const key of rawFlat.keys()) {
        if (expectedKeysRaw.has(key) || key === 'client.phone') continue;
        if (guardedFlat.get(key) === undefined) correctlyDiscarded += 1;
      }

      rawMatchedTotal += rawMatched;
      guardedMatchedTotal += guardedMatched;
    }


    const after = await client.execute('SELECT id, parsed_json FROM ai_extractions');
    const fresh = after.rows.filter((row) => !known.has(String(row.id)));

    const normalized = fresh.map((row) => ({
      parsed_json: String(row.parsed_json),
    }));

    const fallbackPetName =
      testCase.expected.pets.length === 1
        ? (testCase.expected.pets[0] as ExpectedPet).name
        : undefined;

    const flat = flattenSuggestions(normalized, fallbackPetName);
    const expected = expectedFlat(testCase);

    let matched = 0;
    const missing: string[] = [];

    for (const field of expected) {
      const group = fieldGroup(field.key);
      const stats = perField.get(group) ?? {
        expected: 0,
        matched: 0,
        falsePositives: 0,
      };
      stats.expected += 1;

      if (matches(field.key, field.value, flat)) {
        stats.matched += 1;
        matched += 1;
      } else {
        missing.push(`${field.key}=${String(field.value)}`);
      }
      perField.set(group, stats);
    }

    const expectedKeys = new Set(expected.map((field) => field.key));
    const falsePositives = [...flat.keys()].filter((key) => !expectedKeys.has(key));

    for (const key of falsePositives) {
      const group = fieldGroup(key);
      const stats = perField.get(group) ?? {
        expected: 0,
        matched: 0,
        falsePositives: 0,
      };
      stats.falsePositives += 1;
      perField.set(group, stats);
    }

    // Duplicados: dos mascotas con el mismo nombre en el mismo caso.
    const names = normalized.flatMap((row) => {
      const parsed = JSON.parse(row.parsed_json) as {
        kind?: string;
        fields?: Array<{ field: string; value: unknown }>;
        pets?: Array<{ fields: Array<{ field: string; value: unknown }> }>;
      };
      const list: string[] = [];
      for (const pet of parsed.pets ?? []) {
        const name = pet.fields.find((field) => field.field === 'name')?.value;
        if (name) list.push(norm(name));
      }
      if (parsed.kind === 'pet_create') {
        const name = parsed.fields?.find((field) => field.field === 'name')?.value;
        if (name) list.push(norm(name));
      }
      return list;
    });
    const duplicates = names.length - new Set(names).size;

    outcomes.push({
      id: testCase.id,
      expected: expected.length,
      matched,
      falsePositives,
      missing,
      duplicates,
      guardDrops,
      suggestions: normalized.length,
      falsePositiveValues: falsePositives.map((key) => `${key}=${String(flat.get(key))}`),
    });
  }

  const usage = (await client.execute(
    `SELECT COUNT(*) AS calls,
            COALESCE(SUM(tokens_in), 0) AS tin,
            COALESCE(SUM(tokens_out), 0) AS tout,
            COALESCE(SUM(cost_usd_micros), 0) AS cost,
            COALESCE(AVG(latency_ms), 0) AS latency
       FROM ai_usage`,
  )).rows[0] as {
    calls?: number;
    tin?: number;
    tout?: number;
    cost?: number;
    latency?: number;
  };

  const totalExpected = outcomes.reduce((sum, row) => sum + row.expected, 0);
  const totalMatched = outcomes.reduce((sum, row) => sum + row.matched, 0);
  const totalFalsePositives = outcomes.reduce(
    (sum, row) => sum + row.falsePositives.length,
    0,
  );
  const totalDuplicates = outcomes.reduce((sum, row) => sum + row.duplicates, 0);
  const totalGuardDrops = outcomes.reduce((sum, row) => sum + row.guardDrops.length, 0);

  console.log(`\nProveedor: ${providerName} · modelo: ${config.model}`);
  console.log(
    `Casos: ${CASES.length} · llamadas: ${usage.calls} · tokens: ${
      Number(usage.tin) + Number(usage.tout)
    } · costo: $${(Number(usage.cost) / 1_000_000).toFixed(4)} · latencia media: ${Math.round(
      Number(usage.latency),
    )} ms\n`,
  );

  console.log(
    'Campo'.padEnd(22) +
      'Esperados'.padStart(10) +
      'Aciertos'.padStart(10) +
      'Precisión'.padStart(11) +
      'Recall'.padStart(9),
  );

  for (const [group, stats] of [...perField.entries()].sort()) {
    const precision =
      stats.matched + stats.falsePositives === 0
        ? 1
        : stats.matched / (stats.matched + stats.falsePositives);
    const recall = stats.expected === 0 ? 1 : stats.matched / stats.expected;

    console.log(
      group.padEnd(22) +
        String(stats.expected).padStart(10) +
        String(stats.matched).padStart(10) +
        `${(precision * 100).toFixed(1)}%`.padStart(11) +
        `${(recall * 100).toFixed(1)}%`.padStart(9),
    );
  }

  const intentCases = outcomes.filter(
    (row) =>
      row.id.startsWith('precio') ||
      row.id.startsWith('cupo') ||
      row.id.startsWith('cita') ||
      row.id.startsWith('typo'),
  );
  const intentOk = intentCases.filter(
    (row) => row.missing.every((entry) => !entry.startsWith('intent=')),
  ).length;

  console.log(
    `\nGlobal: ${totalMatched}/${totalExpected} campos (${(
      (totalMatched / totalExpected) * 100
    ).toFixed(1)}%) · recall ${(
      (totalMatched / totalExpected) * 100
    ).toFixed(1)}%`,
  );
  console.log(
    `Comparación: crudo ${rawMatchedTotal}/${totalExpected} → guardas ${guardedMatchedTotal}/${totalExpected} · descartes correctos ${correctlyDiscarded}`,
  );
  console.log(
    `Intenciones: ${intentOk}/${intentCases.length} · falsos positivos: ${totalFalsePositives} · duplicados: ${totalDuplicates}`,
  );
  console.log(
    `Descartes de guardas sobre campos correctos: ${totalGuardDrops} · casos con fallos: ${
      outcomes.filter((row) => row.missing.length > 0).length
    }`,
  );

  if (process.argv.includes('--dump-fps')) {
    const withFps = outcomes.filter(
      (row) =>
        row.falsePositives.length > 0 ||
        (row.falsePositiveValues?.length ?? 0) > 0,
    );
    if (withFps.length > 0) {
      console.log('\nFalsos positivos por caso:');
      for (const row of withFps) {
        console.log(
          `  · ${row.id}: ${(row.falsePositiveValues ?? row.falsePositives).join(', ')}`,
        );
      }
    }
  }

  const failures = outcomes.filter((row) => row.missing.length > 0);
  if (failures.length > 0) {
    console.log('\nFaltantes por caso:');
    for (const row of failures.slice(0, 20)) {
      console.log(`  · ${row.id}: ${row.missing.slice(0, 4).join(', ')}`);
    }
  }

  client.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
