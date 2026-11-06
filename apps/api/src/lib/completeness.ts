import type { Db } from '@keyko/db';
import { aiExtractions, clients, conversations, pets } from '@keyko/db';
import {
  computeClientCompleteness,
  computePetCompleteness,
  isPlaceholderName,
  type CompletenessResult,
} from '@keyko/domain';
import { and, eq, isNull } from 'drizzle-orm';
import { nowSqlite } from '@keyko/domain';
import { lastMessages, syncConversations } from './whatsapp';

/**
 * Campos con una sugerencia de IA pendiente.
 *
 * Se cargan una sola vez por petición y se reparten en memoria: evita una
 * consulta por cliente o mascota al pintar un listado.
 */
export type PendingFields = {
  clients: Map<number, Set<string>>;
  pets: Map<string, Set<string>>;
};

export async function loadPendingFields(
  db: Db,
  businessId: string,
): Promise<PendingFields> {
  const rows = await db
    .select({
      parsedJson: aiExtractions.parsedJson,
      targetEntity: aiExtractions.targetEntity,
    })
    .from(aiExtractions)
    .where(
      and(
        eq(aiExtractions.businessId, businessId),
        eq(aiExtractions.status, 'pending'),
      ),
    );

  const result: PendingFields = {
    clients: new Map(),
    pets: new Map(),
  };

  for (const row of rows) {
    if (!row.parsedJson) continue;

    let parsed: {
      clientId?: number | null;
      petId?: string | null;
      fields?: Array<{ field: string }>;
    };
    try {
      parsed = JSON.parse(row.parsedJson);
    } catch {
      continue;
    }

    const fields = (parsed.fields ?? []).map((field) => field.field);
    if (fields.length === 0) continue;

    if (parsed.petId) {
      const set = result.pets.get(parsed.petId) ?? new Set<string>();
      for (const field of fields) set.add(field);
      result.pets.set(parsed.petId, set);
      continue;
    }

    if (parsed.clientId) {
      const set = result.clients.get(parsed.clientId) ?? new Set<string>();
      for (const field of fields) set.add(field);
      result.clients.set(parsed.clientId, set);
    }
  }

  return result;
}

/**
 * Quita la marca de "nombre desconocido". Se usa cuando llega un nombre
 * válido (manual o aceptado de la IA). Devuelve si hubo cambio.
 */
export function withoutUnknownName(flagsJson: string | null): {
  json: string | null;
  cleared: boolean;
} {
  if (!flagsJson) return { json: null, cleared: false };

  try {
    const parsed = JSON.parse(flagsJson) as {
      unknown?: string[];
      na?: string[];
    };
    const unknown = parsed.unknown ?? [];
    if (!unknown.includes('name')) return { json: flagsJson, cleared: false };

    return {
      json: JSON.stringify({
        unknown: unknown.filter((key) => key !== 'name'),
        na: parsed.na ?? [],
      }),
      cleared: true,
    };
  } catch {
    return { json: flagsJson, cleared: false };
  }
}

export async function clearUnknownNameIfNamed(
  db: Db,
  businessId: string,
  clientId: number,
): Promise<boolean> {
  const [client] = await db
    .select()
    .from(clients)
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)))
    .limit(1);

  if (!client) return false;
  if (isPlaceholderName(client.fullName)) return false;

  const result = withoutUnknownName(client.profileFlagsJson);
  if (!result.cleared) return false;

  await db
    .update(clients)
    .set({ profileFlagsJson: result.json, updatedAt: nowSqlite() })
    .where(and(eq(clients.id, clientId), eq(clients.businessId, businessId)));

  return true;
}

export function clientCompleteness(
  client: {
    id: number;
    phone: string | null;
    whatsappContactKey: string;
    fullName: string | null;
    profileFlagsJson?: string | null;
  },
  pending: PendingFields,
): CompletenessResult {
  return computeClientCompleteness(client, pending.clients.get(client.id));
}

export function petCompleteness(
  pet: {
    id: string;
    name: string;
    species: string | null;
    breed: string | null;
    weightKg: number | null;
    birthdate: string | null;
    ageYears?: number | null;
    sex: string | null;
    photoUrl: string | null;
    profileFlagsJson?: string | null;
  },
  pending: PendingFields,
): CompletenessResult {
  return computePetCompleteness(pet, pending.pets.get(pet.id));
}

/** Contacto de WhatsApp que aún no tiene ficha: solo cuenta su identificador. */
export function contactCompleteness(contactKey: string): CompletenessResult {
  return computeClientCompleteness({
    phone: null,
    whatsappContactKey: contactKey,
    fullName: null,
    profileFlagsJson: null,
  });
}

export type DataQualityContact = {
  conversationId: string;
  contactKey: string;
  contactName: string | null;
  phone: string | null;
};

export type DataQualityClient = {
  id: number;
  fullName: string | null;
  phone: string | null;
};

export type DataQualityPet = {
  id: string;
  name: string;
  clientId: number;
  clientName: string | null;
  percent: number;
};

export type DataQualitySummary = {
  /** Conversaciones de WhatsApp que todavía no tienen ficha de cliente. */
  contactsWithoutClient: number;
  /** Clientes registrados a los que les falta el nombre. */
  clientsWithoutName: number;
  contactsWithoutPets: number;
  petsWithoutPhoto: number;
  petsIncomplete: number;
  averagePetCompleteness: number;
  totalClients: number;
  totalPets: number;
  details: {
    contactsWithoutClient: DataQualityContact[];
    clientsWithoutName: DataQualityClient[];
    contactsWithoutPets: DataQualityClient[];
    petsWithoutPhoto: DataQualityPet[];
    petsIncomplete: DataQualityPet[];
    allPets: DataQualityPet[];
  };
};

/**
 * Resumen de calidad de datos. Separado de las métricas comerciales.
 * Se calcula en tres consultas y algo de memoria; no hay N+1.
 */
export async function dataQualitySummary(
  db: Db,
  businessId: string,
): Promise<DataQualitySummary> {
  // Materializa la bandeja para que los contactos nuevos cuenten desde ya.
  await syncConversations(db, businessId);

  const pending = await loadPendingFields(db, businessId);

  const clientRows = await db
    .select()
    .from(clients)
    .where(and(eq(clients.businessId, businessId), isNull(clients.deletedAt)));

  const petRows = await db
    .select()
    .from(pets)
    .where(and(eq(pets.businessId, businessId), isNull(pets.deletedAt)));

  const petsByClient = new Map<number, number>();
  for (const pet of petRows) {
    petsByClient.set(pet.clientId, (petsByClient.get(pet.clientId) ?? 0) + 1);
  }

  // Dos métricas separadas: fichas sin nombre y contactos sin ficha.
  // Una conversación vinculada a un cliente sin nombre cuenta solo en la
  // segunda, nunca en las dos.
  let clientsWithoutName = 0;
  for (const client of clientRows) {
    const result = clientCompleteness(client, pending);
    if (result.missing.includes('name') || result.unknown.includes('name')) {
      clientsWithoutName += 1;
    }
  }

  const unlinked = await db
    .select({ id: conversations.id, waContact: conversations.waContact })
    .from(conversations)
    .where(
      and(
        eq(conversations.businessId, businessId),
        isNull(conversations.clientId),
      ),
    );

  const last = await lastMessages(db, businessId);
  const phoneLike = (value: string) => /^\+?\d{8,15}$/.test(value);
  const contactsWithoutClient = unlinked.length;
  const contactDetails: DataQualityContact[] = unlinked
    .slice(0, 200)
    .map((row) => {
      const lastMessage = last.get(row.waContact);
      return {
        conversationId: row.id,
        contactKey: row.waContact,
        contactName: lastMessage?.contactName ?? null,
        phone: phoneLike(row.waContact) ? row.waContact : null,
      };
    });

  const clientById = new Map(clientRows.map((client) => [client.id, client]));
  const clientsWithoutNameDetails: DataQualityClient[] = [];
  for (const client of clientRows) {
    const result = clientCompleteness(client, pending);
    if (result.missing.includes('name') || result.unknown.includes('name')) {
      clientsWithoutNameDetails.push({
        id: client.id,
        fullName: client.fullName,
        phone: client.phone,
      });
    }
  }

  let contactsWithoutPets = 0;
  const contactsWithoutPetsDetails: DataQualityClient[] = [];
  for (const client of clientRows) {
    if ((petsByClient.get(client.id) ?? 0) === 0) {
      contactsWithoutPets += 1;
      contactsWithoutPetsDetails.push({
        id: client.id,
        fullName: client.fullName,
        phone: client.phone,
      });
    }
  }

  let petsWithoutPhoto = 0;
  let petsIncomplete = 0;
  let totalPercent = 0;
  const petDetails: DataQualityPet[] = [];
  const petsWithoutPhotoDetails: DataQualityPet[] = [];
  const petsIncompleteDetails: DataQualityPet[] = [];

  for (const pet of petRows) {
    const result = petCompleteness(pet, pending);
    totalPercent += result.percent;
    const detail: DataQualityPet = {
      id: pet.id,
      name: pet.name,
      clientId: pet.clientId,
      clientName: clientById.get(pet.clientId)?.fullName ?? null,
      percent: result.percent,
    };
    petDetails.push(detail);
    if (result.missing.includes('photo')) {
      petsWithoutPhoto += 1;
      petsWithoutPhotoDetails.push(detail);
    }
    if (result.percent < 100) {
      petsIncomplete += 1;
      petsIncompleteDetails.push(detail);
    }
  }

  return {
    contactsWithoutClient,
    clientsWithoutName,
    contactsWithoutPets,
    petsWithoutPhoto,
    petsIncomplete,
    averagePetCompleteness:
      petRows.length === 0 ? 0 : Math.round(totalPercent / petRows.length),
    totalClients: clientRows.length,
    totalPets: petRows.length,
    details: {
      contactsWithoutClient: contactDetails,
      clientsWithoutName: clientsWithoutNameDetails.slice(0, 200),
      contactsWithoutPets: contactsWithoutPetsDetails.slice(0, 200),
      petsWithoutPhoto: petsWithoutPhotoDetails.slice(0, 200),
      petsIncomplete: petsIncompleteDetails.slice(0, 200),
      allPets: petDetails
        .sort((a, b) => a.percent - b.percent)
        .slice(0, 200),
    },
  };
}
