import { BOGOTA_TZ, utcToLocal } from '@keyko/domain';

/**
 * Agenda.
 *
 * El CRM informa, no decide. Aquí se calcula qué citas se cruzan, cuánto
 * tiempo y qué horarios se salen de lo habitual. Nada de esto impide
 * guardar: son advertencias para que el administrador decida.
 */

export const BUSINESS_HOURS: {
  openHour: number;
  closeHour: number;
  /** 0 = domingo. */
  closedWeekdays: readonly number[];
} = {
  openHour: 8,
  closeHour: 18,
  closedWeekdays: [0],
};

const MINUTE_MS = 60_000;

export type AgendaInterval = {
  id: string;
  startsAt: string;
  endsAt: string;
  status: string;
  groomerId: string | null;
};

export type Conflict = {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  startsAtLocal: string;
  endsAtLocal: string;
  overlapStart: string;
  overlapEnd: string;
  overlapMinutes: number;
  status: string;
  groomerId: string | null;
  petId: string | null;
  petName: string | null;
  clientName: string | null;
};

export type WarningType =
  | 'overlap'
  | 'outside_business_hours'
  | 'closed_day';

export type Warning = {
  type: WarningType;
  severity: 'warning';
  /** Texto listo para mostrar; el frontend no tiene que componerlo. */
  message: string;
  /** Solo en `overlap`. */
  conflict?: Conflict;
};

export type EnrichedRow = AgendaInterval & {
  petId?: string | null;
  petName?: string | null;
  clientName?: string | null;
};

/** Minutos de cruce entre dos intervalos; 0 si no se tocan. */
export function overlapMinutes(a: AgendaInterval, b: AgendaInterval): number {
  const start = Math.max(Date.parse(a.startsAt), Date.parse(b.startsAt));
  const end = Math.min(Date.parse(a.endsAt), Date.parse(b.endsAt));
  if (end <= start) return 0;
  return Math.round((end - start) / MINUTE_MS);
}

export function findConflicts(
  target: AgendaInterval,
  pool: readonly EnrichedRow[],
): Conflict[] {
  const conflicts: Conflict[] = [];

  for (const other of pool) {
    if (other.id === target.id) continue;
    if (other.status === 'cancelled') continue;

    const minutes = overlapMinutes(target, other);
    if (minutes <= 0) continue;

    const overlapStart = new Date(
      Math.max(Date.parse(target.startsAt), Date.parse(other.startsAt)),
    ).toISOString();
    const overlapEnd = new Date(
      Math.min(Date.parse(target.endsAt), Date.parse(other.endsAt)),
    ).toISOString();

    conflicts.push({
      appointmentId: other.id,
      startsAt: other.startsAt,
      endsAt: other.endsAt,
      startsAtLocal: utcToLocal(other.startsAt, BOGOTA_TZ),
      endsAtLocal: utcToLocal(other.endsAt, BOGOTA_TZ),
      overlapStart,
      overlapEnd,
      overlapMinutes: minutes,
      status: other.status,
      groomerId: other.groomerId,
      petId: other.petId ?? null,
      petName: other.petName ?? null,
      clientName: other.clientName ?? null,
    });
  }

  return conflicts.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

function timeOf(iso: string): string {
  return utcToLocal(iso, BOGOTA_TZ).slice(11, 16);
}

function weekdayOf(iso: string): number {
  const [y, m, d] = utcToLocal(iso, BOGOTA_TZ)
    .slice(0, 10)
    .split('-')
    .map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

/**
 * Advertencias de una cita. Las de solapamiento llegan ya calculadas porque
 * dependen de las demás citas; las de horario se derivan aquí.
 */
export function buildWarnings(
  target: AgendaInterval,
  conflicts: readonly Conflict[],
): Warning[] {
  const warnings: Warning[] = [];

  for (const conflict of conflicts) {
    const who = conflict.petName ?? 'otra mascota';
    const owner = conflict.clientName ? ` de ${conflict.clientName}` : '';
    warnings.push({
      type: 'overlap',
      severity: 'warning',
      message: `Se cruza ${conflict.overlapMinutes} min con ${who}${owner} (${timeOf(
        conflict.startsAt,
      )}–${timeOf(conflict.endsAt)}).`,
      conflict,
    });
  }

  if (BUSINESS_HOURS.closedWeekdays.includes(weekdayOf(target.startsAt))) {
    warnings.push({
      type: 'closed_day',
      severity: 'warning',
      message: 'Ese día la peluquería no abre. Puedes guardarla igual.',
    });
  }

  const open = timeOf(target.startsAt);
  const close = timeOf(target.endsAt);
  const startsEarly = open < `${String(BUSINESS_HOURS.openHour).padStart(2, '0')}:00`;
  const endsLate = close > `${String(BUSINESS_HOURS.closeHour).padStart(2, '0')}:00`;

  if (startsEarly || endsLate) {
    warnings.push({
      type: 'outside_business_hours',
      severity: 'warning',
      message: `Fuera del horario habitual (${String(
        BUSINESS_HOURS.openHour,
      ).padStart(2, '0')}:00–${String(BUSINESS_HOURS.closeHour).padStart(
        2,
        '0',
      )}:00). Puedes guardarla igual.`,
    });
  }

  return warnings;
}

/** ¿La cita cae dentro del horario de atención? Lo usa la disponibilidad. */
export function isWithinBusinessHours(target: AgendaInterval): boolean {
  return (
    !BUSINESS_HOURS.closedWeekdays.includes(weekdayOf(target.startsAt)) &&
    timeOf(target.startsAt) >=
      `${String(BUSINESS_HOURS.openHour).padStart(2, '0')}:00` &&
    timeOf(target.endsAt) <=
      `${String(BUSINESS_HOURS.closeHour).padStart(2, '0')}:00`
  );
}
