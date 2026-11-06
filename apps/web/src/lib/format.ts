import { formatCop, parseCopToCents } from '@keyko/domain';

export { formatCop, parseCopToCents };

/** 4500000 → '45.000' (para inputs de pesos). */
export function centsToInput(cents: number): string {
  const pesos = Math.round(cents / 100);
  return new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(pesos);
}

/** Lo que escribe la persona → centavos. Vacío o inválido → 0. */
export function inputToCents(input: string): number {
  try {
    return input.trim() === '' ? 0 : parseCopToCents(input);
  } catch {
    return 0;
  }
}

export function initials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() ?? '').join('') || '?';
}

/** Teléfono legible: +57 312 575 4547 */
export function prettyPhone(phone: string | null | undefined): string {
  if (!phone) return 'Sin teléfono';
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length === 12) {
    return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return phone;
}

export const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Agendada',
  confirmed: 'Confirmada',
  in_progress: 'En curso',
  done: 'Completada',
  no_show: 'No vino',
  cancelled: 'Cancelada',
};

export const SPECIES_LABELS: Record<string, string> = {
  perro: 'Perro',
  gato: 'Gato',
};

export const SIZE_LABELS: Record<string, string> = {
  small: 'Pequeño',
  medium: 'Mediano',
  large: 'Grande',
};

export const PET_SIZE_HELP =
  'Pequeño: menos de 10 kg · Mediano: 10 a 25 kg · Grande: más de 25 kg';

export const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  transfer: 'Transferencia',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  other: 'Otro',
};

export const SALE_STATUS_LABELS: Record<string, string> = {
  open: 'Pendiente',
  paid: 'Pagada',
  void: 'Anulada',
};

const dateTz = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Bogota',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** '2026-10-30 15:00:00' (UTC) → '30 oct, 10:00' en Bogotá. */
export function stampLocal(value: string | null): string {
  if (!value) return '';
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';

  const parts: Record<string, string> = {};
  for (const part of dateTz.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  return `${Number(parts.day)} ${monthShort(Number(parts.month))}, ${parts.hour}:${parts.minute}`;
}

/** '2026-11-02' → '2 nov, 2026' (fecha local sin hora). */
export function dayLabel(value: string): string {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  if (!year || !month || !day) return value;
  return `${day} ${monthShort(month)}, ${year}`;
}

function monthShort(month: number): string {
  return [
    'ene',
    'feb',
    'mar',
    'abr',
    'may',
    'jun',
    'jul',
    'ago',
    'sep',
    'oct',
    'nov',
    'dic',
  ][month - 1] ?? '';
}

/** ISO completo (citas) a '30 oct, 10:00'. */
export function isoStampLocal(value: string | null): string {
  return stampLocal(value);
}
