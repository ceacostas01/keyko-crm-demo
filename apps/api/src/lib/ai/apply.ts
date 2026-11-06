import type { Db } from '@keyko/db';
import {
  aiExtractions,
  clients,
  conversations,
  pets,
} from '@keyko/db';
import { isPlaceholderName } from '@keyko/domain';
import { and, eq, isNull } from 'drizzle-orm';
import { overriddenFields } from '../overrides';
import { ensureAppointmentRequest } from '../appointment-requests';
import type { AiMessage } from './fake';
import { resolveAppointmentTime } from './appointment-time';
import type { Extraction } from './schema';

export type SuggestionKind =
  | 'client_create'
  | 'client_update'
  | 'pet_create'
  | 'pet_update'
  | 'appointment_request'
  | 'availability_inquiry'
  | 'service_inquiry'
  | 'conversation_note';

export type SuggestionField = {
  field: string;
  label: string;
  value: unknown;
  confidence: number;
  evidence: string[];
  quotes: string[];
  conflict: boolean;
};

export type SuggestionPet = {
  fields: SuggestionField[];
};

export type SuggestionPayload = {
  kind: SuggestionKind;
  title: string;
  clientId: number | null;
  petId: string | null;
  fields: SuggestionField[];
  /** Mascotas incluidas en una creación de cliente. */
  pets?: SuggestionPet[];
  summary?: string;
  conversation?: {
    intent?: string | null;
    requestedService: string | null;
    wantsAppointment: boolean;
    requestedDate: string | null;
    requestedTime: string | null;
    resolvedStart: string | null;
    openQuestions: string[];
    notes: string | null;
  } | null;
  contactKey?: string | null;
  signature: string;
};

export type ApplyInput = {
  db: Db;
  businessId: string;
  contactKey: string;
  contactPhone?: string | null;
  contactName?: string | null;
  /** Guardar la respuesta cruda del modelo (depuración). */
  storeRaw: boolean;
  extraction: Extraction;
  messages: AiMessage[];
  jobId: string;
  model: string;
  raw: string;
  autoApply: boolean;
  autoCreatePets?: boolean;
  autoCreateAppointmentRequests: boolean;
  autoConfirmAppointments: boolean;
  contactAuthorizedForAppointments: boolean;
  contactAuthorizedForPets?: boolean;
  /**
   * Segunda opinión del modelo para un candidato a mascota. Solo se invoca
   * cuando el sistema está por crear una mascota sin revisión.
   */
  verifyPetCandidate?: (candidate: {
    name: string;
    species: 'perro' | 'gato' | null;
    messages: AiMessage[];
  }) => Promise<{ allowed: boolean; confidence: number; reason: string }>;
  /**
   * Resultado de clasificar la foto del lote. Si hay foto y no se confirmó que
   * sea un animal, no se crea ninguna mascota automáticamente.
   */
  imageCheck?: {
    present: boolean;
    hasAnimal: boolean | null;
    reason?: string;
  };
};

export type ApplyResult = {
  suggestions: number;
  applied: number;
};

const CLIENT_LABELS: Record<string, string> = {
  fullName: 'Nombre',
  phone: 'Teléfono',
  notes: 'Notas',
};

const PET_LABELS: Record<string, string> = {
  name: 'Nombre',
  species: 'Especie',
  breed: 'Raza',
  sex: 'Sexo',
  birthdate: 'Nacimiento',
  ageYears: 'Edad (años)',
  weightKg: 'Peso (kg)',
  allergies: 'Alergias',
  temperament: 'Observaciones',
};

function normalizeName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '');
}

/** "criollita", "criolla" y "mestiza" son la misma raza para el CRM. */
function normalizeBreed(value: string): string {
  const normalized = normalizeName(value);
  if (
    ['criollo', 'criolla', 'criollito', 'criollita', 'mestizo', 'mestiza'].includes(
      normalized,
    )
  ) {
    return 'Criollo/a';
  }
  return value.trim();
}

/**
 * Nombre que el contacto tiene en WhatsApp. Sirve como respaldo cuando la
 * conversación no dice el nombre, pero nunca debe pisar un nombre confirmado.
 * Se descartan valores que en realidad son un teléfono o un marcador genérico.
 */
export function usableWhatsappName(
  value: string | null | undefined,
): string | null {
  const name = value?.trim() ?? '';
  if (!name || isPlaceholderName(name)) return null;
  if (/^\+?\d[\d\s().-]*$/.test(name)) return null;
  return name;
}

const PET_CONTEXT =
  /\b(perro|perra|perrito|perrita|canino|canina|gato|gata|gatito|gatita|felino|felina|mascota)\b/;

/**
 * Razas que permiten inferir la especie cuando el cliente la dice pero no
 * escribe "perro" o "gato". Es una inferencia segura: la raza es explícita.
 */
const DOG_BREED_TERMS = [
  'beagle',
  'poodle',
  'caniche',
  'labrador',
  'golden retriever',
  'pastor aleman',
  'border collie',
  'bulldog',
  'schnauzer',
  'cocker spaniel',
  'yorkshire',
  'chihuahua',
  'shih tzu',
  'pomerania',
  'husky',
  'dalmat',
  'boxer',
  'rottweiler',
  'pitbull',
  'maltes',
  'bichon',
  'pug',
  'doberman',
  'chandoberman',
  'french poodle',
];

const CAT_BREED_TERMS = [
  'siames',
  'persa',
  'angora',
  'bengali',
  'maine coon',
  'ragdoll',
  'british shorthair',
  'esfinge',
  'abisinio',
];

function inferSpeciesFromBreed(
  breed: string,
): 'perro' | 'gato' | null {
  const value = normalizeName(breed);
  if (CAT_BREED_TERMS.some((term) => value.includes(term))) return 'gato';
  if (DOG_BREED_TERMS.some((term) => value.includes(term))) return 'perro';
  return null;
}

/**
 * Para crear una mascota sin revisión hace falta que el nombre y la especie
 * estén respaldados por un mensaje que hable explícitamente de un animal.
 * "Se llama Hydra" después de hablar de una crema no cumple esta condición.
 */
function hasExplicitPetContext(
  fields: SuggestionField[],
  messages: AiMessage[],
): boolean {
  const evidence = new Set(
    fields
      .filter((field) => field.field === 'name' || field.field === 'species')
      .flatMap((field) => field.evidence),
  );
  const text = messages
    .filter((message) => evidence.has(message.id))
    .map((message) => message.body)
    .join(' ');
  return PET_CONTEXT.test(normalizeName(text));
}

function quoteMap(messages: AiMessage[]): Map<string, string> {
  return new Map(
    messages.map((message) => [
      message.id,
      message.body.length > 160 ? `${message.body.slice(0, 157)}…` : message.body,
    ]),
  );
}

function quotesFor(evidence: string[], quotes: Map<string, string>): string[] {
  return evidence
    .map((id) => quotes.get(id))
    .filter((value): value is string => Boolean(value))
    .slice(0, 3);
}

export async function applyExtraction(
  input: ApplyInput,
): Promise<ApplyResult> {
  const { db, businessId, extraction, messages, autoApply } = input;
  const quotes = quoteMap(messages);

  guardExtraction(extraction, messages);

  // Si el cliente dio una raza reconocible pero omitió la especie, se infiere
  // de forma segura (beagle → perro, siamés → gato). Nunca se inventa la raza.
  for (const pet of extraction.pets) {
    if (pet.species || !pet.breed?.value) continue;
    const inferred = inferSpeciesFromBreed(pet.breed.value);
    if (inferred) {
      pet.species = {
        value: inferred,
        confidence: Math.min(0.9, pet.breed.confidence),
        evidence: pet.breed.evidence,
      };
    }
  }

  // El teléfono del job cuenta como evidencia aunque el modelo lo omita: es
  // lo que permite crear un contacto sin nombre y reconocerlo después.
  if (
    !extraction.client.phone &&
    input.contactPhone &&
    input.contactPhone.trim() !== ''
  ) {
    extraction.client.phone = {
      value: input.contactPhone.startsWith('+')
        ? input.contactPhone
        : `+${input.contactPhone}`,
      confidence: 0.95,
      evidence: messages.slice(0, 1).map((message) => message.id),
    };
  }

  const [conversation] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.waContact, input.contactKey),
      ),
    )
    .limit(1);

  // 1. Identificar al cliente: por conversación, por BSUID o por teléfono.
  let client: typeof clients.$inferSelect | null = null;

  if (conversation?.clientId) {
    const [found] = await db
      .select()
      .from(clients)
      .where(
        and(
          eq(clients.id, conversation.clientId),
          eq(clients.businessId, businessId),
          isNull(clients.deletedAt),
        ),
      )
      .limit(1);
    client = found ?? null;
  }

  if (!client) {
    const rows = await db
      .select()
      .from(clients)
      .where(and(eq(clients.businessId, businessId), isNull(clients.deletedAt)));

    // Solo se compara por teléfono si la clave ES un teléfono. Un BSUID
    // como "CO.2744..." también tiene dígitos y podría coincidir por error
    // con el teléfono de otra persona.
    const contactKey = input.contactKey.trim();
    const contactIsPhone = /^\+?\d{8,15}$/.test(contactKey);
    const contactDigits = digits(contactKey);
    // El teléfono que reporta WhatsApp es un identificador real aunque la
    // clave sea un BSUID. Sirve para encontrar una ficha creada a mano.
    const whatsappPhoneDigits = digits(input.contactPhone);
    const hasWhatsappPhone = whatsappPhoneDigits.length >= 8;

    client =
      rows.find(
        (row) =>
          row.whatsappContactKey === contactKey ||
          (contactIsPhone && digits(row.phone) === contactDigits) ||
          (hasWhatsappPhone &&
            (digits(row.phone) === whatsappPhoneDigits ||
              (/^\+?\d{8,15}$/.test(row.whatsappContactKey ?? '') &&
                digits(row.whatsappContactKey) === whatsappPhoneDigits))),
      ) ?? null;
  }

  if (client && conversation && conversation.clientId === null) {
    await db
      .update(conversations)
      .set({ clientId: client.id })
      .where(eq(conversations.id, conversation.id));
  }

  // El nombre de perfil de WhatsApp se guarda como dato de contacto. No pisa
  // el nombre completo confirmado, pero sirve de respaldo al crear la ficha.
  const whatsappProfileName = usableWhatsappName(input.contactName);
  if (
    client &&
    whatsappProfileName &&
    client.whatsappName !== whatsappProfileName
  ) {
    await db
      .update(clients)
      .set({ whatsappName: whatsappProfileName })
      .where(
        and(eq(clients.id, client.id), eq(clients.businessId, businessId)),
      );
    client = { ...client, whatsappName: whatsappProfileName };
  }

  const result: ApplyResult = { suggestions: 0, applied: 0 };
  let appointmentPetId: string | null = null;

  // 2. Cliente.
  const clientFields = buildClientFields(extraction, quotes);
  const extractedPets = dedupePets(extraction.pets);
  const petPayloads: SuggestionPet[] = extractedPets.map((pet) => ({
    fields: buildPetFields(pet, quotes),
  }));

  if (!client) {
    const nameField = clientFields.find((field) => field.field === 'fullName');
    const fallbackTitle = nameField
      ? 'Cliente nuevo'
      : 'Contacto nuevo de WhatsApp';
    const canAutoCreate =
      autoApply &&
      nameField !== undefined &&
      nameField.confidence >= 0.9 &&
      nameField.conflict === false;

    if (canAutoCreate) {
      const created = await createClientFromFields(
        db,
        businessId,
        clientFields,
        input.contactKey,
        { whatsappName: whatsappProfileName },
      );
      client = created;
      await linkConversation(db, businessId, input.contactKey, created.id);

      for (const pet of petPayloads) {
        await createPetFromFields(db, businessId, created.id, pet.fields);
      }

      result.applied += 1;
      await recordExtraction(input, {
        kind: 'client_create',
        title: `Cliente creado: ${created.fullName ?? 'sin nombre'}`,
        clientId: created.id,
        petId: null,
        fields: clientFields,
        pets: petPayloads,
        signature: signatureOf('client_create', String(created.id), clientFields),
        status: 'applied',
        targetEntity: 'client',
        targetId: String(created.id),
      });
    } else {
      const inserted = await recordSuggestion(input, {
        kind: 'client_create',
        title: fallbackTitle,
        clientId: null,
        petId: null,
        fields: clientFields,
        pets: petPayloads,
        signature: signatureOf(
          'client_create',
          `new:${input.contactKey}`,
          clientFields,
        ),
      });
      if (inserted) result.suggestions += 1;
    }
  } else if (client) {
    const overrides = await overriddenFields(db, businessId, 'client', String(client.id));
    const current = client as unknown as Record<string, unknown>;
    const pending = clientFields.filter((field) => {
      if (overrides.has(field.field)) return false;
      const value = current[field.field];
      if (value !== null && value !== undefined && value !== '') {
        // "Ana" y "Ana Pérez" son la misma persona: no es una contradicción.
        if (
          field.field === 'fullName' &&
          isSameName(String(value), String(field.value))
        ) {
          return false;
        }

        // "Cliente WhatsApp" es un marcador: se puede completar con un nombre.
        const placeholder =
          field.field === 'fullName' && value === 'Cliente WhatsApp';
        field.conflict = !placeholder && String(value) !== String(field.value);
        return field.conflict || placeholder;
      }
      return true;
    });

    const autoFields = pending.filter(
      (field) => !field.conflict && field.confidence >= 0.9 && autoApply,
    );

    if (autoFields.length > 0) {
      await db
        .update(clients)
        .set(
          Object.fromEntries(
            autoFields.map((field) => [field.field, field.value]),
          ),
        )
        .where(and(eq(clients.id, client.id), eq(clients.businessId, businessId)));
      result.applied += 1;
      await recordExtraction(input, {
        kind: 'client_update',
        title: `Datos completados: ${client.fullName ?? 'cliente'}`,
        clientId: client.id,
        petId: null,
        fields: autoFields,
        signature: signatureOf('client_update', String(client.id), autoFields),
        status: 'applied',
        targetEntity: 'client',
        targetId: String(client.id),
      });
    }

    const remaining = pending.filter((field) => !autoFields.includes(field));
    if (remaining.length > 0) {
      const inserted = await recordSuggestion(input, {
        kind: 'client_update',
        title: `Actualizar cliente: ${client.fullName ?? 'cliente'}`,
        clientId: client.id,
        petId: null,
        fields: remaining,
        signature: signatureOf('client_update', String(client.id), remaining),
      });
      if (inserted) result.suggestions += 1;
    }
  }

  // 3. Mascotas (cuando el cliente ya existe).
  if (client) {
    const existing = await db
      .select()
      .from(pets)
      .where(and(eq(pets.businessId, businessId), eq(pets.clientId, client.id)));

    for (const extracted of extractedPets) {
      if (!extracted.name?.value) continue;
      const name = extracted.name.value;
      const match = existing.find((pet) => isSameName(pet.name, name));

      const fields = buildPetFields(extracted, quotes);

      if (!match) {
        const nameField = fields.find((field) => field.field === 'name');
        const speciesField = fields.find((field) => field.field === 'species');
        const baseAutoCreatePets =
          input.autoCreatePets === true &&
          input.contactAuthorizedForPets !== false &&
          nameField !== undefined &&
          nameField.confidence >= 0.9 &&
          speciesField !== undefined &&
          hasExplicitPetContext(fields, messages);

        let verified = true;
        if (
          (autoApply || baseAutoCreatePets) &&
          nameField !== undefined &&
          input.verifyPetCandidate
        ) {
          const verdict = await input.verifyPetCandidate({
            name: String(nameField.value),
            species:
              (speciesField?.value as 'perro' | 'gato' | undefined) ?? null,
            messages,
          });
          verified = verdict.allowed && verdict.confidence >= 0.7;
        }

        const imageOk =
          input.imageCheck?.present !== true ||
          input.imageCheck.hasAnimal === true;

        const canAutoCreate =
          (autoApply || baseAutoCreatePets) &&
          nameField !== undefined &&
          nameField.confidence >= 0.9 &&
          verified &&
          imageOk;

        if (canAutoCreate) {
          const [created] = await db
            .insert(pets)
            .values({
              id: crypto.randomUUID(),
              businessId,
              clientId: client.id,
              name,
              species: (fields.find((f) => f.field === 'species')?.value as
                | 'perro'
                | 'gato'
                | undefined) ?? 'perro',
              breed: (fields.find((f) => f.field === 'breed')?.value as string) ?? null,
              sex: (fields.find((f) => f.field === 'sex')?.value as
                | 'macho'
                | 'hembra'
                | undefined) ?? null,
              birthdate:
                (fields.find((f) => f.field === 'birthdate')?.value as string) ?? null,
              ageYears:
                (fields.find((f) => f.field === 'ageYears')?.value as number) ?? null,
              weightKg:
                (fields.find((f) => f.field === 'weightKg')?.value as number) ?? null,
              temperament:
                (fields.find((f) => f.field === 'temperament')?.value as string) ?? null,
              allergies:
                (fields.find((f) => f.field === 'allergies')?.value as string) ?? null,
            })
            .returning();

          appointmentPetId ??= created?.id ?? null;
          result.applied += 1;
          await recordExtraction(input, {
            kind: 'pet_create',
            title: `Mascota creada: ${name}`,
            clientId: client.id,
            petId: created?.id ?? null,
            fields,
            signature: signatureOf('pet_create', created?.id ?? name, fields),
            status: 'applied',
            targetEntity: 'pet',
            targetId: created?.id ?? null,
          });
        } else {
          const inserted = await recordSuggestion(input, {
            kind: 'pet_create',
            title: `Mascota nueva: ${name}`,
            clientId: client.id,
            petId: null,
            fields,
            signature: signatureOf('pet_create', `${client.id}:${normalizeName(name)}`, fields),
          });
          if (inserted) result.suggestions += 1;
        }
        continue;
      }

      appointmentPetId ??= match.id;
      const overrides = await overriddenFields(db, businessId, 'pet', match.id);
      const current = match as unknown as Record<string, unknown>;

      const pending = fields.filter((field) => {
        if (overrides.has(field.field)) return false;
        const value = current[field.field];
        if (value !== null && value !== undefined && value !== '') {
          field.conflict =
            normalizeName(String(value)) !== normalizeName(String(field.value));
          return field.conflict;
        }
        return true;
      });

      const autoFields = pending.filter(
        (field) => !field.conflict && field.confidence >= 0.9 && autoApply,
      );

      if (autoFields.length > 0) {
        await db
          .update(pets)
          .set(
            Object.fromEntries(autoFields.map((field) => [field.field, field.value])),
          )
          .where(and(eq(pets.id, match.id), eq(pets.businessId, businessId)));
        result.applied += 1;
        await recordExtraction(input, {
          kind: 'pet_update',
          title: `Datos completados: ${match.name}`,
          clientId: client.id,
          petId: match.id,
          fields: autoFields,
          signature: signatureOf('pet_update', match.id, autoFields),
          status: 'applied',
          targetEntity: 'pet',
          targetId: match.id,
        });
      }

      const remaining = pending.filter((field) => !autoFields.includes(field));
      if (remaining.length > 0) {
        const inserted = await recordSuggestion(input, {
          kind: 'pet_update',
          title: `Actualizar mascota: ${match.name}`,
          clientId: client.id,
          petId: match.id,
          fields: remaining,
          signature: signatureOf('pet_update', match.id, remaining),
        });
        if (inserted) result.suggestions += 1;
      }
    }
  }

  // 4. Conversación: solicitudes de cita quedan SIEMPRE para revisión.
  const conversationSuggestion = buildConversationSuggestion(
    extraction,
    client,
    messages,
    input.contactKey,
    appointmentPetId,
  );
  if (conversationSuggestion) {
    const signature = signatureOf(
      conversationSuggestion.kind,
      `${input.contactKey}:${
        conversationSuggestion.conversation?.requestedDate ?? ''
      }:${conversationSuggestion.conversation?.requestedTime ?? ''}`,
      [],
    );
    const inserted = await recordSuggestion(input, {
      ...conversationSuggestion,
      signature,
    });
    if (inserted) result.suggestions += 1;
  }

  return result;
}

/**
 * Guardas deterministas contra datos inventados.
 *
 * El modelo puede "deducir" un teléfono del BSUID, copiar el nombre de perfil
 * o asignar sexo a partir del artículo. Aquí solo sobrevive lo que aparece
 * literalmente en la conversación; el teléfono, si falta, se toma del propio
 * WhatsApp (que es un dato real, no una invención del modelo).
 */
export function guardExtraction(
  extraction: Extraction,
  messages: AiMessage[],
): void {
  const text = messages.map((message) => message.body).join('\n');
  const flat = normalizeName(text);
  const digitsInText = digits(text);

  if (extraction.client.phone) {
    const phoneDigits = digits(extraction.client.phone.value);
    if (!digitsInText.includes(phoneDigits) || phoneDigits.length < 8) {
      delete extraction.client.phone;
    }
  }

  if (extraction.client.fullName) {
    // Comparación por palabras: "Ana" no debe validarse contra "mañana".
    const padded = ` ${flat.replace(/[^a-z0-9ñ]+/g, ' ')} `;
    const name = ` ${normalizeName(extraction.client.fullName.value).replace(/[^a-z0-9ñ]+/g, ' ')} `;
    if (!padded.includes(name)) {
      delete extraction.client.fullName;
    }
  }

  for (const pet of extraction.pets) {
    if (pet.species) {
      const expected = pet.species.value;
      const speciesPattern =
        expected === 'perro'
          ? /\b(perro|perra|perrito|perrita|canino|canina)\b/
          : expected === 'gato'
            ? /\b(gato|gata|gatito|gatita|felino|felina)\b/
            : null;
      if (!speciesPattern || !speciesPattern.test(flat)) {
        delete pet.species;
      }
    }

    if (pet.sex && pet.name?.value) {
      // Solo se acepta el sexo si el contexto inmediato de la mascota lo dice.
      const name = normalizeName(pet.name.value);
      const index = flat.indexOf(name);
      const context = index >= 0 ? flat.slice(Math.max(0, index - 45), index) : '';
      if (!/macho|hembra|perra|perrita|gata|gatita|female|male/.test(context)) {
        delete pet.sex;
      }
    }

    if (pet.weightKg) {
      const value = String(pet.weightKg.value);
      if (!flat.includes(value) && !flat.includes(value.replace('.', ','))) {
        delete pet.weightKg;
      }
    }

    if (pet.breed) {
      const breed = normalizeName(pet.breed.value);
      const words = breed.split(/\s+/).filter((word) => word.length > 3);
      if (!flat.includes(breed) && !words.some((word) => flat.includes(word))) {
        delete pet.breed;
      }
    }

    if (pet.birthdate && !text.includes(pet.birthdate.value)) {
      delete pet.birthdate;
    }

    if (pet.ageYears) {
      const value = Number(pet.ageYears.value);
      const age = String(value);
      const hasYears = /años|anos|year/.test(flat) && flat.includes(age);
      // "6 meses" puede llegar como 0.5 años. Se valida contra los meses.
      const months = value > 0 && value < 1 ? Math.round(value * 12) : null;
      const hasMonths =
        months !== null &&
        /mes|meses/.test(flat) &&
        new RegExp(`\\b${months}\\b`).test(flat);
      if (!hasYears && !hasMonths) {
        delete pet.ageYears;
      }
    }
  }
}

function buildClientFields(
  extraction: Extraction,
  quotes: Map<string, string>,
): SuggestionField[] {
  const fields: SuggestionField[] = [];
  const entries: Array<[string, Extraction['client'][keyof Extraction['client']]]> = [
    ['fullName', extraction.client.fullName],
    ['phone', extraction.client.phone],
    ['notes', extraction.client.notes],
  ];

  for (const [name, field] of entries) {
    if (!field) continue;
    fields.push({
      field: name,
      label: CLIENT_LABELS[name] ?? name,
      value: field.value,
      confidence: field.confidence,
      evidence: field.evidence,
      quotes: quotesFor(field.evidence, quotes),
      conflict: false,
    });
  }

  return fields;
}

function buildPetFields(
  pet: Extraction['pets'][number],
  quotes: Map<string, string>,
): SuggestionField[] {
  const fields: SuggestionField[] = [];
  const keys = [
    'name',
    'species',
    'breed',
    'sex',
    'birthdate',
    'ageYears',
    'weightKg',
    'allergies',
    'temperament',
  ] as const;

  for (const key of keys) {
    const field = pet[key];
    if (!field) continue;
    fields.push({
      field: key,
      label: PET_LABELS[key] ?? key,
      value:
        key === 'breed' && typeof field.value === 'string'
          ? normalizeBreed(field.value)
          : field.value,
      confidence: field.confidence,
      evidence: field.evidence,
      quotes: quotesFor(field.evidence, quotes),
      conflict: false,
    });
  }

  return fields;
}

function isSameName(currentValue: string, extractedValue: string): boolean {
  const current = normalizeName(currentValue);
  const extracted = normalizeName(extractedValue);
  if (!current || !extracted) return false;
  return current.startsWith(extracted) || extracted.startsWith(current);
}

function dedupePets(pets: Extraction['pets']): Extraction['pets'] {
  const seen = new Map<string, Extraction['pets'][number]>();
  for (const pet of pets) {
    if (!pet.name?.value) continue;
    const key = normalizeName(pet.name.value);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, pet);
      continue;
    }
    // Se queda el primero, pero completa con lo que traiga la repetición.
    seen.set(key, {
      ...pet,
      ...existing,
      species: existing.species ?? pet.species,
      breed: existing.breed ?? pet.breed,
      temperament: existing.temperament ?? pet.temperament,
    });
  }
  return [...seen.values()];
}

function buildConversationSuggestion(
  extraction: Extraction,
  client: typeof clients.$inferSelect | null,
  messages: AiMessage[],
  contactKey: string,
  appointmentPetId: string | null,
): Omit<SuggestionPayload, 'signature'> | null {
  const conversation = extraction.conversation;

  const intent =
    conversation.intent?.value ??
    (conversation.wantsAppointment?.value === true
      ? 'appointment_request'
      : conversation.requestedService
        ? 'service_inquiry'
        : null);

  if (
    intent === 'appointment_request' ||
    intent === 'availability_inquiry' ||
    intent === 'service_inquiry'
  ) {
    const titles: Record<string, string> = {
      appointment_request: 'Solicitud de cita',
      availability_inquiry: 'Consulta de disponibilidad',
      service_inquiry: 'Consulta de servicio',
    };

    return {
      kind: intent,
      title: titles[intent] ?? 'Consulta',
      clientId: client?.id ?? null,
      petId: appointmentPetId,
      fields: [],
      pets: [],
      summary: extraction.summary,
      contactKey,
      conversation: {
        intent,
        requestedService: conversation.requestedService?.value ?? null,
        wantsAppointment: intent === 'appointment_request',
        requestedDate: conversation.requestedDate?.value ?? null,
        requestedTime: conversation.requestedTime?.value ?? null,
        resolvedStart: resolveAppointmentTime(
          messages,
          conversation.requestedDate?.value ?? null,
          conversation.requestedTime?.value ?? null,
        ).startsAtLocal,
        openQuestions: conversation.openQuestions,
        notes: conversation.notes?.value ?? null,
      },
    };
  }

  if (conversation.notes && client) {
    return {
      kind: 'conversation_note',
      title: 'Información para la ficha',
      clientId: client.id,
      petId: null,
      fields: [
        {
          field: 'notes',
          label: 'Notas',
          value: conversation.notes.value,
          confidence: conversation.notes.confidence,
          evidence: conversation.notes.evidence,
          quotes: [],
          conflict: false,
        },
      ],
      pets: [],
      summary: extraction.summary,
      conversation: null,
    };
  }

  return null;
}

export async function createClientFromFields(
  db: Db,
  businessId: string,
  fields: SuggestionField[],
  contactKey: string,
  profile?: { whatsappName?: string | null },
): Promise<typeof clients.$inferSelect> {
  const value = (name: string) =>
    (fields.find((field) => field.field === name)?.value as string) ?? null;

  const whatsappName = usableWhatsappName(profile?.whatsappName);
  const fullName = value('fullName') ?? whatsappName;
  const phone = value('phone');

  const [created] = await db
    .insert(clients)
    .values({
      businessId,
      whatsappContactKey: contactKey,
      phone,
      whatsappName,
      fullName,
      notes: value('notes'),
      source: 'whatsapp',
    })
    .returning();

  if (!created) throw new Error('No se pudo crear el cliente');
  return created;
}

export async function createPetFromFields(
  db: Db,
  businessId: string,
  clientId: number,
  fields: SuggestionField[],
): Promise<string | null> {
  const value = (name: string) =>
    fields.find((field) => field.field === name)?.value ?? null;

  const name = value('name');
  if (typeof name !== 'string' || name.trim() === '') return null;

  const [created] = await db.insert(pets).values({
    id: crypto.randomUUID(),
    businessId,
    clientId,
    name,
    species: (value('species') as 'perro' | 'gato' | null) ?? 'perro',
    breed: (value('breed') as string | null) ?? null,
    sex: (value('sex') as 'macho' | 'hembra' | null) ?? null,
    birthdate: (value('birthdate') as string | null) ?? null,
    ageYears: (value('ageYears') as number | null) ?? null,
    weightKg: (value('weightKg') as number | null) ?? null,
    temperament: (value('temperament') as string | null) ?? null,
    allergies: (value('allergies') as string | null) ?? null,
  }).returning({ id: pets.id });

  return created?.id ?? null;
}

async function linkConversation(
  db: Db,
  businessId: string,
  contactKey: string,
  clientId: number,
): Promise<void> {
  await db
    .update(conversations)
    .set({ clientId })
    .where(
      and(
        eq(conversations.businessId, businessId),
        eq(conversations.waContact, contactKey),
      ),
    );
}

function signatureOf(
  kind: SuggestionKind,
  target: string,
  fields: SuggestionField[],
): string {
  const parts = fields
    .map((field) => `${field.field}=${String(field.value)}`)
    .sort()
    .join('|');
  return `${kind}|${target}|${parts}`;
}

async function pendingSignatures(db: Db, businessId: string): Promise<Set<string>> {
  const rows = await db
    .select({ parsedJson: aiExtractions.parsedJson })
    .from(aiExtractions)
    .where(
      and(
        eq(aiExtractions.businessId, businessId),
        eq(aiExtractions.status, 'pending'),
      ),
    );

  const signatures = new Set<string>();
  for (const row of rows) {
    if (!row.parsedJson) continue;
    try {
      const parsed = JSON.parse(row.parsedJson) as { signature?: string };
      if (parsed.signature) signatures.add(parsed.signature);
    } catch {
      // Ignorar filas corruptas.
    }
  }
  return signatures;
}

async function recordSuggestion(
  input: ApplyInput,
  suggestion: Omit<SuggestionPayload, 'signature'> & { signature: string },
): Promise<string | null> {
  const existing = await pendingSignatures(input.db, input.businessId);
  if (existing.has(suggestion.signature)) return null;

  const extractionId = await recordExtraction(input, {
    ...suggestion,
    status: 'pending',
    targetEntity: null,
    targetId: null,
  });

  if (
    suggestion.kind === 'appointment_request' &&
    input.autoCreateAppointmentRequests &&
    input.contactAuthorizedForAppointments
  ) {
    const conversation = suggestion.conversation;
    await ensureAppointmentRequest(input.db, input.businessId, {
      extractionId,
      clientId: suggestion.clientId,
      petId: suggestion.petId,
      contactKey: suggestion.contactKey ?? input.contactKey,
      requestedService: conversation?.requestedService ?? null,
      requestedDate: conversation?.requestedDate ?? null,
      requestedTime: conversation?.requestedTime ?? null,
      startsAtLocal: conversation?.resolvedStart ?? null,
      notes: conversation?.notes ?? null,
      confidence: 0.7,
    });
  }

  return extractionId;
}

async function recordExtraction(
  input: ApplyInput,
  data: SuggestionPayload & {
    status: 'pending' | 'applied';
    targetEntity: string | null;
    targetId: string | null;
  },
): Promise<string> {
  const confidence =
    data.fields.length > 0
      ? Math.min(...data.fields.map((field) => field.confidence))
      : 0.6;

  const id = crypto.randomUUID();
  await input.db.insert(aiExtractions).values({
    id,
    businessId: input.businessId,
    sourceType: 'message',
    sourceId: input.jobId,
    model: input.model,
    promptVersion: 'v2',
    // En producción no se guarda la salida completa del modelo.
    rawResponse: input.storeRaw ? input.raw.slice(0, 4000) : '',
    parsedJson: JSON.stringify({
      ...data,
      contactKey: data.contactKey ?? input.contactKey,
    }),
    confidence,
    status: data.status,
    targetEntity: data.targetEntity,
    targetId: data.targetId,
  });
  return id;
}
