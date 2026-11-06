import { BOGOTA_TZ, toUtcIso, utcToLocal } from '@keyko/domain';
import type { AiMessage } from './fake';

export type ResolvedAppointmentTime = {
  date: string | null;
  time: string | null;
  /** 'YYYY-MM-DDTHH:mm' en America/Bogota, si hay fecha y hora. */
  startsAtLocal: string | null;
};

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const WEEKDAYS = [
  'domingo',
  'lunes',
  'martes',
  'miercoles',
  'jueves',
  'viernes',
  'sabado',
];

function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function fromUtcDay(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days))
    .toISOString()
    .slice(0, 10);
}

function weekdayIndex(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)).getUTCDay();
}

function localBase(messages: AiMessage[]): { date: string; dateTime: string } {
  const latest = [...messages]
    .map((message) => message.at)
    .filter(Boolean)
    .sort()
    .at(-1);
  const utcIso = toUtcIso(latest ?? new Date().toISOString(), BOGOTA_TZ);
  const local = utcToLocal(utcIso, BOGOTA_TZ);
  return { date: local.slice(0, 10), dateTime: local };
}

function resolveDate(text: string, baseDate: string): string | null {
  if (!text) return null;
  const value = normalize(text);
  const baseYear = Number(baseDate.slice(0, 4));

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const numeric = /(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?/.exec(value);
  if (numeric) {
    const day = Number(numeric[1]);
    const month = Number(numeric[2]);
    let year = numeric[3] ? Number(numeric[3]) : baseYear;
    if (year < 100) year += 2000;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return fromUtcDay(year, month, day);
    }
  }

  const named = new RegExp(
    `(\\d{1,2})\\s+de\\s+(${MONTHS.join('|')})`,
  ).exec(value);
  if (named) {
    const day = Number(named[1]);
    const month = MONTHS.indexOf(named[2] ?? '') + 1;
    if (month > 0) {
      let candidate = fromUtcDay(baseYear, month, day);
      // Una fecha ya pasada se interpreta como el próximo año.
      if (candidate < baseDate) candidate = fromUtcDay(baseYear + 1, month, day);
      return candidate;
    }
  }

  if (value.includes('pasado manana')) return addDays(baseDate, 2);
  if (value.includes('manana')) return addDays(baseDate, 1);
  if (value.includes('hoy')) return baseDate;

  for (let index = 0; index < WEEKDAYS.length; index += 1) {
    const dayName = WEEKDAYS[index] ?? '';
    if (!value.includes(dayName)) continue;
    const current = weekdayIndex(baseDate);
    let delta = (index - current + 7) % 7;
    if (delta === 0) delta = 7;
    return addDays(baseDate, delta);
  }

  return null;
}

function resolveTime(text: string): string | null {
  if (!text) return null;
  const value = normalize(text);

  const match = /(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.?\s*m\.?|p\.?\s*m\.?|de la manana|de la tarde|de la noche|hs|horas)?/.exec(
    value,
  );
  if (!match) return null;

  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const suffix = (match[3] ?? '').replace(/\s+/g, ' ');
  if (hour > 23 || minute > 59) return null;

  const isPm = /^(pm|p\.?\s*m\.?|de la tarde|de la noche)$/.test(suffix);
  const isAm = /^(am|a\.?\s*m\.?|de la manana)$/.test(suffix);
  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;

  // Sin sufijo solo se acepta una hora con minutos explícitos (10:00);
  // "a las 10" es ambiguo y se deja para revisión humana.
  if (!suffix && !match[2]) return null;
  if (hour < 0 || hour > 23) return null;

  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * Resuelve fechas relativas usando el timestamp de la conversación, no la
 * fecha en que corre el procesador. Si no hay certeza, devuelve null y la
 * solicitud queda pendiente de revisión.
 */
export function resolveAppointmentTime(
  messages: AiMessage[],
  requestedDate: string | null,
  requestedTime: string | null,
): ResolvedAppointmentTime {
  const base = localBase(messages);
  const date = resolveDate(requestedDate ?? '', base.date);
  const time = resolveTime(requestedTime ?? '');
  return {
    date,
    time,
    startsAtLocal: date && time ? `${date}T${time}` : null,
  };
}
