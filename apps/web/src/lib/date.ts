/**
 * Utilidades de fecha pensadas para la agenda.
 *
 * Todo se maneja como 'YYYY-MM-DD' (día local de Bogotá) o 'HH:MM'.
 * Nunca se construye un Date con la zona del navegador para no desplazar
 * las citas cuando el equipo esté en otra zona.
 */

const TZ = 'America/Bogota';

export function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Hoy en Bogotá, como 'YYYY-MM-DD'. */
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** Suma días a un 'YYYY-MM-DD' sin pasar por la zona del navegador. */
export function addDays(day: string, amount: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
  const next = new Date(base + amount * 86_400_000);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

/** 0 = domingo. */
export function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)).getUTCDay();
}

/** Lunes de la semana que contiene `day`. */
export function startOfWeek(day: string): string {
  const wd = weekday(day);
  const diff = wd === 0 ? -6 : 1 - wd;
  return addDays(day, diff);
}

export function weekDays(day: string): string[] {
  const start = startOfWeek(day);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

const WEEKDAY_NAMES = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
const MONTH_NAMES = [
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

export function weekdayShort(day: string): string {
  return WEEKDAY_NAMES[weekday(day)] ?? '';
}

export function dayNumber(day: string): string {
  return String(Number(day.slice(8, 10)));
}

export function monthName(day: string): string {
  const index = Number(day.slice(5, 7)) - 1;
  return MONTH_NAMES[index] ?? '';
}

/** 'lunes 2 de noviembre' */
export function longDate(day: string): string {
  const name = ['domingo', ...WEEKDAY_NAMES.slice(1, 7)][weekday(day)] ?? '';
  return `${name} ${dayNumber(day)} de ${monthName(day)}`;
}

/** '2 nov' */
export function shortDate(day: string): string {
  return `${dayNumber(day)} ${monthName(day).slice(0, 3)}`;
}

export function isToday(day: string): boolean {
  return day === today();
}

/** 'HH:MM' a partir del ISO local que devuelve la API. */
export function localTime(localIso: string): string {
  return localIso.slice(11, 16);
}

export function localDayOf(localIso: string): string {
  return localIso.slice(0, 10);
}

/** 'HH:MM' → minutos desde medianoche. */
export function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function minutesToTime(minutes: number): string {
  const m = Math.max(0, minutes);
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Minutos desde la medianoche local de un ISO local. */
export function minutesOfDay(localIso: string): number {
  return timeToMinutes(localTime(localIso));
}

export function durationMinutes(startLocal: string, endLocal: string): number {
  return Math.max(
    0,
    timeToMinutes(localTime(endLocal)) - timeToMinutes(localTime(startLocal)),
  );
}

export function humanDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Hora relativa corta para la bandeja: '14:05', 'ayer', '2 nov'. */
export function relativeStamp(iso: string | null): string {
  if (!iso) return '';
  const normalized = iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) return '';

  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const parts: Record<string, string> = {};
  for (const part of local) if (part.type !== 'literal') parts[part.type] = part.value;

  const day = `${parts.year}-${parts.month}-${parts.day}`;
  const time = `${parts.hour}:${parts.minute}`;

  if (day === today()) return time;
  if (day === addDays(today(), -1)) return 'ayer';
  return shortDate(day);
}
