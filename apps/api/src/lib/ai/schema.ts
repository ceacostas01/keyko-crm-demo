import { z } from 'zod';

/**
 * Contrato de salida del modelo.
 *
 * Cada campo lleva su valor, una confianza de 0 a 1 y los mensajes de los que
 * sale. Si el modelo no tiene evidencia, el campo no debe aparecer: el
 * esquema no rellena huecos.
 */

const confidence = z.coerce.number().min(0).max(1);

function field<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value,
    confidence: confidence.default(0.5),
    evidence: z.array(z.string().max(120)).max(10).default([]),
  });
}

export const speciesSchema = z.enum(['perro', 'gato']);
export const sexSchema = z.enum(['macho', 'hembra']);

export const petExtractionSchema = z.object({
  name: field(z.string().min(1).max(80)).optional(),
  species: field(speciesSchema).optional(),
  breed: field(z.string().min(1).max(80)).optional(),
  sex: field(sexSchema).optional(),
  /** Solo si el mensaje da una fecha utilizable. */
  birthdate: field(z.coerce.string().min(4).max(20)).optional(),
  /** Edad declarada, sin convertirla a fecha de nacimiento. */
  ageYears: field(z.coerce.number().min(0).max(40)).optional(),
  weightKg: field(z.number().positive().max(200)).optional(),
  allergies: field(z.coerce.string().min(1).max(1000)).optional(),
  temperament: field(z.coerce.string().min(1).max(1000)).optional(),
});

export const intentSchema = z.enum([
  'service_inquiry',
  'availability_inquiry',
  'appointment_request',
  'other',
]);

export const conversationExtractionSchema = z.object({
  /** Qué quiere la persona: consultar precio, disponibilidad o reservar. */
  intent: field(intentSchema).optional(),
  requestedService: field(z.coerce.string().min(1).max(120)).optional(),
  wantsAppointment: field(z.coerce.boolean()).optional(),
  requestedDate: field(z.coerce.string().min(2).max(40)).optional(),
  requestedTime: field(z.coerce.string().min(2).max(20)).optional(),
  openQuestions: z.array(z.string().max(200)).max(10).default([]),
  notes: field(z.coerce.string().min(1).max(1000)).optional(),
});

export const extractionSchema = z.object({
  client: z
    .object({
      fullName: field(z.coerce.string().min(2).max(120)).optional(),
      phone: field(z.coerce.string().min(7).max(25)).optional(),
      notes: field(z.coerce.string().min(1).max(1000)).optional(),
    })
    .default({}),
  pets: z.array(petExtractionSchema).max(5).default([]),
  conversation: conversationExtractionSchema.default({
    openQuestions: [],
  }),
  summary: z.string().max(500).default(''),
});

export type Field<T> = {
  value: T;
  confidence: number;
  evidence: string[];
};

export type PetExtraction = z.infer<typeof petExtractionSchema>;
export type Extraction = z.infer<typeof extractionSchema>;

/**
 * Los modelos reales varían: mandan "Hembra", "female", cadenas vacías o
 * pesos como "4 kg". Se normaliza antes de validar para no descartar una
 * extracción entera por un detalle de formato.
 */
function mapSex(value: string): 'macho' | 'hembra' | undefined {
  const text = value.toLowerCase();
  if (['macho', 'male', 'm', 'masculino'].includes(text)) return 'macho';
  if (['hembra', 'female', 'f', 'femenino'].includes(text)) return 'hembra';
  return undefined;
}

function mapSpecies(value: string): 'perro' | 'gato' | undefined {
  const text = value.toLowerCase();
  if (['perro', 'perra', 'dog', 'canino', 'perrito', 'perrita'].includes(text)) {
    return 'perro';
  }
  if (['gato', 'gata', 'cat', 'felino', 'gatito', 'gatita'].includes(text)) {
    return 'gato';
  }
  return undefined;
}

function coerceValue(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    const text = value.trim();
    if (text === '') return undefined;
    if (key === 'sex') return mapSex(text);
    if (key === 'species') return mapSpecies(text);
    if (key === 'birthdate') {
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : undefined;
    }
    if (key === 'weightKg') {
      const match = /(\d+(?:[.,]\d+)?)/.exec(text);
      return match ? Number(match[1]?.replace(',', '.')) : undefined;
    }
    if (key === 'ageYears') {
      const match = /(\d+(?:[.,]\d+)?)/.exec(text);
      return match ? Number(match[1]?.replace(',', '.')) : undefined;
    }
    return text;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    // Un teléfono o un nombre pueden venir como número: se convierten a texto.
    return key === 'weightKg' || key === 'ageYears' ? value : String(value);
  }
  if (typeof value === 'boolean') return value;
  return undefined;
}

function coerce(node: unknown, key?: string): unknown {
  if (Array.isArray(node)) {
    return node
      .map((item) => coerce(item, key))
      .filter((item) => item !== undefined);
  }

  if (!node || typeof node !== 'object') {
    return coerceValue(node, key);
  }

  const obj = node as Record<string, unknown>;

  // Envoltorio { value, confidence, evidence }. Algunos modelos omiten
  // `value`; en ese caso el campo se descarta en vez de romper el parseo.
  if ('value' in obj || 'confidence' in obj || 'evidence' in obj) {
    const value = 'value' in obj ? coerceValue(obj.value, key) : undefined;
    if (value === undefined) return undefined;

    const confidenceRaw = Number(obj.confidence ?? 0.5);
    const confidence = Number.isFinite(confidenceRaw)
      ? Math.min(1, Math.max(0, confidenceRaw > 1 ? confidenceRaw / 100 : confidenceRaw))
      : 0.5;

    const evidence = Array.isArray(obj.evidence)
      ? obj.evidence.filter((item): item is string => typeof item === 'string').slice(0, 10)
      : [];

    return { value, confidence, evidence };
  }

  const out: Record<string, unknown> = {};
  for (const [name, child] of Object.entries(obj)) {
    const coerced = coerce(child, name);
    if (coerced !== undefined) out[name] = coerced;
  }
  return out;
}

/** Extrae el primer objeto JSON completo, ignorando texto antes o después. */
function firstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/** El modelo a veces devuelve ```json ... ``` o agrega texto después. */
export function parseExtraction(raw: string): Extraction {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let json: unknown;
  try {
    json = JSON.parse(cleaned);
  } catch {
    const candidate = firstJsonObject(cleaned);
    if (!candidate) throw new Error('La IA no devolvió JSON válido');
    try {
      json = JSON.parse(candidate);
    } catch {
      throw new Error('La IA no devolvió JSON válido');
    }
  }

  return extractionSchema.parse(coerce(json));
}
