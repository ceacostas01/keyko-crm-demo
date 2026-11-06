/**
 * Completitud de perfil.
 *
 * Reglas deterministas, sin IA ni coste. El porcentaje se calcula siempre
 * desde los datos actuales; no se almacena.
 *
 *   porcentaje = puntos_completos / puntos_aplicables * 100
 *
 * Un campo "no aplica" sale del denominador. Un campo "desconocido" o
 * "pendiente" sigue contando (no sabemos el dato), pero no suma puntos.
 */

export type FieldStatus =
  | 'complete'
  | 'missing'
  | 'pending'
  | 'unknown'
  | 'not_applicable';

export type FieldPriority = 'high' | 'medium' | 'low';

export type ProfileFieldConfig = {
  key: string;
  label: string;
  weight: number;
  priority: FieldPriority;
  /** Acción sugerida en la interfaz. */
  action: string;
};

export type CompletenessField = ProfileFieldConfig & {
  status: FieldStatus;
};

export type CompletenessResult = {
  percent: number;
  earned: number;
  applicable: number;
  fields: CompletenessField[];
  complete: string[];
  missing: string[];
  pending: string[];
  unknown: string[];
  notApplicable: string[];
  /** Solo los faltantes/pendientes, ordenados por peso. */
  priorities: CompletenessField[];
};

export type ProfileFlags = {
  unknown?: string[] | undefined;
  na?: string[] | undefined;
};

export const CLIENT_PROFILE: ProfileFieldConfig[] = [
  {
    key: 'contact',
    label: 'WhatsApp o teléfono',
    weight: 50,
    priority: 'high',
    action: 'Agregar teléfono',
  },
  {
    key: 'name',
    label: 'Nombre',
    weight: 50,
    priority: 'high',
    action: 'Agregar nombre',
  },
];

export const PET_PROFILE: ProfileFieldConfig[] = [
  { key: 'name', label: 'Nombre', weight: 25, priority: 'high', action: 'Agregar nombre' },
  {
    key: 'species',
    label: 'Especie',
    weight: 15,
    priority: 'medium',
    action: 'Indicar especie',
  },
  { key: 'breed', label: 'Raza', weight: 15, priority: 'medium', action: 'Agregar raza' },
  {
    key: 'sizeOrWeight',
    label: 'Peso o tamaño',
    weight: 10,
    priority: 'medium',
    action: 'Registrar peso',
  },
  { key: 'age', label: 'Edad', weight: 10, priority: 'medium', action: 'Registrar edad' },
  { key: 'sex', label: 'Sexo', weight: 5, priority: 'low', action: 'Indicar sexo' },
  {
    key: 'photo',
    label: 'Fotografía',
    weight: 20,
    priority: 'high',
    action: 'Agregar fotografía',
  },
];

/**
 * Nombres que no cuentan como identificador real: son marcadores que crea el
 * sistema cuando todavía no conocemos a la persona.
 */
/**
 * Campos que pueden declararse "no aplica". El nombre y la especie de una
 * mascota nunca lo son; permitirlo sería una forma de inflar el porcentaje.
 */
export const CLIENT_NA_ALLOWED: string[] = [];
export const PET_NA_ALLOWED = ['breed', 'sizeOrWeight', 'age', 'sex', 'photo'];

export function allowedNaKeys(profile: 'client' | 'pet'): string[] {
  return profile === 'pet' ? PET_NA_ALLOWED : CLIENT_NA_ALLOWED;
}

export type ProfileFlagsValidation = {
  unknown: string[];
  na: string[];
  invalid: string[];
};

export function validateProfileFlags(
  profile: 'client' | 'pet',
  flags: ProfileFlags | null | undefined,
  validKeys: readonly string[],
): ProfileFlagsValidation {
  if (!flags) return { unknown: [], na: [], invalid: [] };

  const unknown = (flags.unknown ?? []).filter((key) => validKeys.includes(key));
  const allowedNa = allowedNaKeys(profile);
  const na = (flags.na ?? []).filter((key) => allowedNa.includes(key));

  const invalid = [
    ...(flags.unknown ?? []).filter((key) => !validKeys.includes(key)),
    ...(flags.na ?? []).filter((key) => !allowedNa.includes(key)),
  ];

  return { unknown: [...new Set(unknown)], na: [...new Set(na)], invalid };
}

export const PLACEHOLDER_NAMES = [
  'cliente whatsapp',
  'contacto whatsapp',
  'cliente',
  'nuevo',
  'nuevo contacto',
  'sin nombre',
  'whatsapp',
];

export function isPlaceholderName(value: string | null | undefined): boolean {
  if (!value) return true;
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
  if (normalized.length < 2) return true;
  return PLACEHOLDER_NAMES.includes(normalized);
}

export function parseProfileFlags(raw: string | null | undefined): ProfileFlags {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as ProfileFlags;
    return {
      unknown: Array.isArray(parsed.unknown) ? parsed.unknown : [],
      na: Array.isArray(parsed.na) ? parsed.na : [],
    };
  } catch {
    return {};
  }
}

export function computeCompleteness(
  profile: readonly ProfileFieldConfig[],
  complete: ReadonlySet<string>,
  options: {
    pending?: ReadonlySet<string>;
    flags?: ProfileFlags;
  } = {},
): CompletenessResult {
  const pending = options.pending ?? new Set<string>();
  const unknown = new Set(options.flags?.unknown ?? []);
  const na = new Set(options.flags?.na ?? []);

  let earned = 0;
  let applicable = 0;

  const fields: CompletenessField[] = profile.map((field) => {
    let status: FieldStatus;

    if (na.has(field.key)) {
      status = 'not_applicable';
    } else {
      applicable += field.weight;
      if (complete.has(field.key)) {
        status = 'complete';
        earned += field.weight;
      } else if (pending.has(field.key)) {
        status = 'pending';
      } else if (unknown.has(field.key)) {
        status = 'unknown';
      } else {
        status = 'missing';
      }
    }

    return { ...field, status };
  });

  const byStatus = (status: FieldStatus) =>
    fields.filter((field) => field.status === status).map((field) => field.key);

  const priorities = fields
    .filter((field) => field.status === 'missing' || field.status === 'pending')
    .sort((a, b) => b.weight - a.weight);

  return {
    percent: applicable === 0 ? 100 : Math.round((earned / applicable) * 100),
    earned,
    applicable,
    fields,
    complete: byStatus('complete'),
    missing: byStatus('missing'),
    pending: byStatus('pending'),
    unknown: byStatus('unknown'),
    notApplicable: byStatus('not_applicable'),
    priorities,
  };
}

/** Datos mínimos de un cliente, tal como los ve el cálculo. */
export type ClientProfileInput = {
  phone: string | null;
  whatsappContactKey: string;
  fullName: string | null;
  profileFlagsJson?: string | null;
};

export function clientCompleteFields(client: ClientProfileInput): Set<string> {
  const complete = new Set<string>();

  const phone = (client.phone ?? '').replace(/\D/g, '');
  const key = (client.whatsappContactKey ?? '').trim();
  if (phone.length >= 8 || key.length >= 5) complete.add('contact');

  if (!isPlaceholderName(client.fullName)) complete.add('name');

  return complete;
}

export function computeClientCompleteness(
  client: ClientProfileInput,
  pending?: ReadonlySet<string>,
): CompletenessResult {
  return computeCompleteness(CLIENT_PROFILE, clientCompleteFields(client), {
    pending: pending ?? new Set(),
    flags: parseProfileFlags(client.profileFlagsJson),
  });
}

export type PetProfileInput = {
  name: string;
  species: string | null;
  breed: string | null;
  weightKg: number | null;
  birthdate: string | null;
  ageYears?: number | null;
  sex: string | null;
  photoUrl: string | null;
  photoKey?: string | null;
  profileFlagsJson?: string | null;
};

export function petCompleteFields(pet: PetProfileInput): Set<string> {
  const complete = new Set<string>();

  if (!isPlaceholderName(pet.name)) complete.add('name');
  if (pet.species && ['perro', 'gato'].includes(pet.species)) {
    complete.add('species');
  }
  if (pet.breed && pet.breed.trim() !== '') complete.add('breed');
  if (pet.weightKg !== null && pet.weightKg !== undefined) {
    complete.add('sizeOrWeight');
  }
  if (
    (pet.birthdate && pet.birthdate.trim() !== '') ||
    (pet.ageYears !== null && pet.ageYears !== undefined)
  ) {
    complete.add('age');
  }
  if (pet.sex && (pet.sex === 'macho' || pet.sex === 'hembra')) complete.add('sex');
  if (
    (pet.photoUrl && pet.photoUrl.trim() !== '') ||
    (pet.photoKey && pet.photoKey.trim() !== '')
  ) {
    complete.add('photo');
  }

  return complete;
}

export function computePetCompleteness(
  pet: PetProfileInput,
  pending?: ReadonlySet<string>,
): CompletenessResult {
  return computeCompleteness(PET_PROFILE, petCompleteFields(pet), {
    pending: pending ?? new Set(),
    flags: parseProfileFlags(pet.profileFlagsJson),
  });
}
