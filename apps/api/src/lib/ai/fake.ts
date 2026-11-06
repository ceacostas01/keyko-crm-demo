import type { Extraction } from './schema';

export type AiMessage = {
  id: string;
  body: string;
  direction: string;
  at: string;
  contactName: string | null;
  /** Marca para que el prompt sepa que el texto viene de una nota de voz. */
  mediaType?: 'audio';
};

export type ExtractionInput = {
  contactKey: string;
  contactPhone: string | null;
  contactName: string | null;
  messages: AiMessage[];
};

export type ProviderResult = {
  raw: string;
  extraction: Extraction;
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsdMicros: number;
};

export type ProviderUsage = {
  model: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsdMicros: number;
};

/** Segunda opinión del modelo antes de crear una mascota sin revisión. */
export type PetVerificationInput = {
  name: string;
  species: 'perro' | 'gato' | null;
  messages: AiMessage[];
};

export type PetVerification = ProviderUsage & {
  allowed: boolean;
  confidence: number;
  reason: string;
};

export type ImageCategory =
  | 'dog'
  | 'cat'
  | 'other_pet'
  | 'person'
  | 'product'
  | 'document'
  | 'other'
  | 'unknown';

export type ImageClassificationInput = {
  base64: string;
  mimeType: string;
  fileName?: string | null;
};

export type ImageClassification = ProviderUsage & {
  category: ImageCategory;
  hasAnimal: boolean;
  confidence: number;
  reason: string;
};

export type TranscriptionInput = {
  messageId: string;
  base64: string;
  format: string;
  mimeType: string;
  durationSeconds?: number | null;
};

export type TranscriptionResult = ProviderUsage & {
  text: string;
  language: string | null;
  audioSeconds: number;
};

export interface AiProvider {
  readonly name: string;
  extract(input: ExtractionInput): Promise<ProviderResult>;
  /** Verifica que un nombre corresponda a una mascota real y no a un producto. */
  verifyPet?(input: PetVerificationInput): Promise<PetVerification>;
  /** Clasifica una foto (animal, persona, producto, documento…). */
  classifyImage?(input: ImageClassificationInput): Promise<ImageClassification>;
  /** Transcribe una nota de voz. */
  transcribe?(input: TranscriptionInput): Promise<TranscriptionResult>;
}

/**
 * Proveedor determinista para desarrollo y pruebas.
 *
 * Lee el texto con reglas simples y devuelve el mismo contrato que el modelo
 * real. No inventa: si no encuentra un patrón, el campo no aparece. Costo 0.
 */
export function createFakeProvider(): AiProvider {
  return {
    name: 'fake',
    async extract(input) {
      const started = Date.now();
      const extraction = ruleBasedExtraction(input);

      return {
        raw: JSON.stringify(extraction),
        extraction,
        model: 'fake-rule-based',
        tokensIn: Math.ceil(
          input.messages.reduce((total, message) => total + message.body.length, 0) / 4,
        ),
        tokensOut: 0,
        latencyMs: Date.now() - started,
        costUsdMicros: 0,
      };
    },
    async verifyPet(input) {
      const started = Date.now();
      const verdict = ruleBasedPetVerification(input);

      return {
        ...verdict,
        model: 'fake-verifier',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: Date.now() - started,
        costUsdMicros: 0,
      };
    },
    async classifyImage() {
      // El proveedor determinista no puede mirar la imagen. Devuelve "unknown"
      // para que la creación automática quede bloqueada y se revise a mano.
      return {
        category: 'unknown' as const,
        hasAnimal: false,
        confidence: 0,
        reason: 'El proveedor de pruebas no analiza imágenes',
        model: 'fake-vision',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: 0,
        costUsdMicros: 0,
      };
    },
    async transcribe(input) {
      const started = Date.now();
      return {
        text: 'Transcripción de audio de prueba.',
        language: 'es',
        audioSeconds: input.durationSeconds ?? 0,
        model: 'fake-transcriber',
        tokensIn: 0,
        tokensOut: 0,
        latencyMs: Date.now() - started,
        costUsdMicros: 0,
      };
    },
  };
}

const ANIMAL_WORDS =
  /\b(perro|perra|perrito|perrita|canino|canina|gato|gata|gatito|gatita|felino|felina|mascota)\b/;

const PRODUCT_WORDS =
  /\b(crema|shampoo|champu|jabon|medicamento|pastilla|jarabe|suplemento|juguete|alimento|concentrado|collar|arnes|correa|cepillo|producto|marca)\b/;

/**
 * Regla determinista equivalente al verificador real: el nombre debe aparecer
 * en una frase con contexto animal. Una frase que habla de una crema no vale.
 */
function ruleBasedPetVerification(input: PetVerificationInput): {
  allowed: boolean;
  confidence: number;
  reason: string;
} {
  const name = normalize(input.name);
  const sentences = input.messages
    .flatMap((message) => message.body.split(/[.\n¿?¡!]+/))
    .map((sentence) => normalize(sentence))
    .filter(Boolean);

  const ownSentence = sentences.find((sentence) => sentence.includes(name));
  const conversation = sentences.join(' ');

  if (ownSentence && PRODUCT_WORDS.test(ownSentence)) {
    return {
      allowed: false,
      confidence: 0.95,
      reason: 'El nombre aparece en una frase sobre un producto',
    };
  }

  if (ownSentence && ANIMAL_WORDS.test(ownSentence)) {
    return {
      allowed: true,
      confidence: 0.9,
      reason: 'La frase que nombra a la mascota habla de un animal',
    };
  }

  if (ANIMAL_WORDS.test(conversation) && !PRODUCT_WORDS.test(conversation)) {
    return {
      allowed: true,
      confidence: 0.75,
      reason: 'La conversación tiene contexto animal explícito',
    };
  }

  return {
    allowed: false,
    confidence: 0.9,
    reason: 'No hay contexto animal que respalde el nombre',
  };
}

const ANIMALS = [
  { word: 'perrita', species: 'perro' as const, sex: 'hembra' as const },
  { word: 'perrito', species: 'perro' as const, sex: 'macho' as const },
  { word: 'perra', species: 'perro' as const, sex: 'hembra' as const },
  { word: 'perro', species: 'perro' as const },
  { word: 'gatita', species: 'gato' as const, sex: 'hembra' as const },
  { word: 'gatito', species: 'gato' as const, sex: 'macho' as const },
  { word: 'gata', species: 'gato' as const, sex: 'hembra' as const },
  { word: 'gato', species: 'gato' as const },
  { word: 'mascota' },
];

const BREEDS = [
  'french poodle',
  'golden retriever',
  'pastor alemán',
  'pastor aleman',
  'siamés',
  'siames',
  'poodle',
  'labrador',
  'beagle',
  'bulldog',
  'schnauzer',
  'chihuahua',
  'husky',
  'criollo',
  'pug',
];

const SERVICES = [
  'corte de uñas',
  'corte de unas',
  'baño medicado',
  'baño y corte',
  'baño',
  'peluquería',
  'peluqueria',
  'desparasitación',
  'desparasitacion',
  'vacuna',
  'guardería',
  'guarderia',
  'corte',
];

const WEEKDAYS =
  'lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo';

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function ruleBasedExtraction(input: ExtractionInput): Extraction {
  const combined = input.messages.map((message) => message.body).join('\n');
  const flat = normalize(combined);

  const evidenceFor = (needle: string): string[] => {
    const target = normalize(needle);
    const matches = input.messages
      .filter((message) => normalize(message.body).includes(target))
      .map((message) => message.id);
    return matches.length > 0
      ? matches
      : input.messages.slice(0, 1).map((message) => message.id);
  };

  const extraction: Extraction = {
    client: {},
    pets: [],
    conversation: { openQuestions: [] },
    summary: combined.slice(0, 300),
  };

  // --- Cliente -------------------------------------------------------------
  const namePattern =
    /(?:[Mm]e llamo|[Mm]i nombre es|\b[Ss]oy)\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)?)/;
  const nameMatch = namePattern.exec(combined);
  if (nameMatch?.[1]) {
    extraction.client.fullName = {
      value: nameMatch[1].trim(),
      confidence: 0.92,
      evidence: evidenceFor(nameMatch[1]),
    };
  }

  const phoneMatch = /(\+?57[\s.-]?)?(3\d{2})[\s.-]?(\d{3})[\s.-]?(\d{4})/.exec(
    combined,
  );
  if (!phoneMatch && input.contactPhone) {
    extraction.client.phone = {
      value: input.contactPhone.startsWith('+')
        ? input.contactPhone
        : `+${input.contactPhone}`,
      confidence: 0.95,
      evidence: input.messages.slice(0, 1).map((message) => message.id),
    };
  } else if (phoneMatch) {
    const digits = phoneMatch.slice(2).join('');
    extraction.client.phone = {
      value: digits.startsWith('57') ? `+${digits}` : `+57${digits}`,
      confidence: 0.9,
      evidence: evidenceFor(phoneMatch[0]),
    };
  }

  // --- Mascotas ------------------------------------------------------------
  const found = new Map<
    string,
    { name: string; species?: 'perro' | 'gato'; sex?: 'macho' | 'hembra'; evidence: string[] }
  >();

  for (const animal of ANIMALS) {
    const pattern = new RegExp(
      `${animal.word}\\s+(?:llamad[oa]\\s+|de nombre\\s+|que se llama\\s+)?([A-ZÁÉÍÓÚÑ][\\wáéíóúñ]+)`,
      'g',
    );
    for (const match of combined.matchAll(pattern)) {
      const name = match[1];
      if (!name) continue;
      const key = normalize(name);
      if (found.has(key)) continue;
      found.set(key, {
        name,
        ...(animal.species ? { species: animal.species } : {}),
        ...(animal.sex ? { sex: animal.sex } : {}),
        evidence: evidenceFor(name),
      });
    }
  }

  // "se llama X" sin especie explícita: se busca el animal en la frase.
  const seLlama = /se llama\s+([A-ZÁÉÍÓÚÑ][\wáéíóúñ]+)/g;
  for (const match of combined.matchAll(seLlama)) {
    const name = match[1];
    if (!name) continue;
    const key = normalize(name);
    if (found.has(key)) continue;
    const sentence = combined
      .split(/[.\n]/)
      .find((part) => part.includes(name)) ?? '';
    const animal = ANIMALS.find((item) => normalize(sentence).includes(item.word));
    found.set(key, {
      name,
      ...(animal ? { species: animal.species } : {}),
      ...(animal && 'sex' in animal && animal.sex ? { sex: animal.sex } : {}),
      evidence: evidenceFor(name),
    });
  }

  for (const pet of found.values()) {
    const petEvidence = pet.evidence;
    const entry: Extraction['pets'][number] = {
      name: { value: pet.name, confidence: 0.93, evidence: petEvidence },
    };

    if (pet.species) {
      entry.species = {
        value: pet.species,
        confidence: 0.9,
        evidence: petEvidence,
      };
    }
    if (pet.sex) {
      entry.sex = { value: pet.sex, confidence: 0.88, evidence: petEvidence };
    }

    const breed = BREEDS.find((candidate) => flat.includes(normalize(candidate)));
    if (breed) {
      entry.breed = {
        value: breed,
        confidence: 0.85,
        evidence: evidenceFor(breed),
      };
    }

    const weight = /(\d{1,2}(?:[.,]\d)?)\s*kg/.exec(flat);
    if (weight?.[1]) {
      entry.weightKg = {
        value: Number(weight[1].replace(',', '.')),
        confidence: 0.85,
        evidence: evidenceFor(weight[0]),
      };
    }

    const age = /(\d{1,2})\s*(?:años|anos|year[s]?)/.exec(flat);
    if (age?.[1]) {
      entry.ageYears = {
        value: Number(age[1]),
        confidence: 0.9,
        evidence: evidenceFor(age[0]),
      };
    }

    const birth = /(\d{4}-\d{2}-\d{2})/.exec(combined);
    if (birth?.[1]) {
      entry.birthdate = {
        value: birth[1],
        confidence: 0.9,
        evidence: evidenceFor(birth[1]),
      };
    }

    const allergy = /[^.\n]*alergia[^.\n]*/i.exec(combined);
    if (allergy?.[0]) {
      entry.allergies = {
        value: allergy[0].trim(),
        confidence: 0.85,
        evidence: evidenceFor(allergy[0]),
      };
    }

    const notePattern = /[^.\n]*(miedoso|miedosa|nervios[oa]|prefiere|tranquil[oa])[^.\n]*/i;
    const note = notePattern.exec(combined);
    if (note?.[0]) {
      entry.temperament = {
        value: note[0].trim(),
        confidence: 0.8,
        evidence: evidenceFor(note[0]),
      };
    }

    extraction.pets.push(entry);
  }

  // --- Conversación --------------------------------------------------------
  // Prioridad: reservar > preguntar disponibilidad > preguntar precio.
  const booking = /(quiero|quisiera|necesito|me gustaria|puedo)\s+(una\s+)?(cita|turno)|agendar|reservar|apartar\s+(una\s+)?(cita|cupo)/.test(
    flat,
  );
  const availability =
    /tienen cupo|hay cupo|disponibilidad|tienen espacio|a que hora|horario|estan abiertos|abren|hay lugar/.test(
      flat,
    );
  const serviceQuestion =
    /cuanto (cuesta|vale|sale)|precio|tarifa|que incluye|cuanto cobran/.test(
      flat,
    );
  const mentionsService =
    /banar|bano|banera|corte|cortar|unas|peluquer|vacun|desparasit|guarder/.test(flat);

  if (booking) {
    extraction.conversation.intent = {
      value: 'appointment_request',
      confidence: 0.9,
      evidence: evidenceFor('agendar'),
    };
    extraction.conversation.wantsAppointment = {
      value: true,
      confidence: 0.9,
      evidence: evidenceFor('agendar'),
    };
  } else if (availability) {
    extraction.conversation.intent = {
      value: 'availability_inquiry',
      confidence: 0.8,
      evidence: evidenceFor('cupo'),
    };
    extraction.conversation.wantsAppointment = {
      value: false,
      confidence: 0.8,
      evidence: evidenceFor('cupo'),
    };
  } else if (serviceQuestion || mentionsService) {
    extraction.conversation.intent = {
      value: 'service_inquiry',
      confidence: 0.8,
      evidence: evidenceFor('precio'),
    };
    extraction.conversation.wantsAppointment = {
      value: false,
      confidence: 0.8,
      evidence: evidenceFor('precio'),
    };
  }

  const service = SERVICES.find((candidate) => flat.includes(normalize(candidate)));
  if (service) {
    extraction.conversation.requestedService = {
      value: service,
      confidence: service.includes('corte') || service.includes('baño') ? 0.85 : 0.7,
      evidence: evidenceFor(service),
    };
  }

  const day = new RegExp(`\\b(${WEEKDAYS}|mañana|manana|hoy)\\b`, 'i').exec(combined);
  if (day?.[1]) {
    extraction.conversation.requestedDate = {
      value: day[1],
      confidence: 0.6,
      evidence: evidenceFor(day[1]),
    };
  }

  const timeMatch =
    /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|de la mañana|de la tarde|hs)\b/i.exec(
      combined,
    );
  if (timeMatch?.[1]) {
    let hour = Number(timeMatch[1]);
    const minutes = Number(timeMatch[2] ?? 0);
    const suffix = normalize(timeMatch[3] ?? '');
    if ((suffix === 'pm' || suffix.includes('tarde')) && hour < 12) hour += 12;
    extraction.conversation.requestedTime = {
      value: `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
      confidence: 0.65,
      evidence: evidenceFor(timeMatch[0]),
    };
  }

  extraction.conversation.openQuestions = combined
    .split(/\n|(?<=\?)\s/)
    .filter((part) => part.trim().endsWith('?'))
    .map((part) => part.trim())
    .slice(0, 5);

  const conversationNote = /[^.\n]*(prefiere|preferencia|pregunt[oó]|confirmar)[^.\n]*/i.exec(
    combined,
  );
  if (conversationNote?.[0]) {
    extraction.conversation.notes = {
      value: conversationNote[0].trim(),
      confidence: 0.7,
      evidence: evidenceFor(conversationNote[0]),
    };
  }

  return extraction;
}
