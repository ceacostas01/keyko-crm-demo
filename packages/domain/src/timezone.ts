export const BOGOTA_TZ = 'America/Bogota';

type Parts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function partsInTz(date: Date, tz: string): Parts {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== 'literal') out[part.type] = Number(part.value);
  }
  return {
    year: out.year ?? 0,
    month: out.month ?? 1,
    day: out.day ?? 1,
    hour: out.hour ?? 0,
    minute: out.minute ?? 0,
    second: out.second ?? 0,
  };
}

/** Desfase de la zona respecto a UTC, en milisegundos, para un instante dado. */
export function offsetMs(date: Date, tz: string = BOGOTA_TZ): number {
  const p = partsInTz(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const truncated = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - truncated;
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

export function isLocalDateTime(value: string): boolean {
  return LOCAL_RE.test(value.trim());
}

/**
 * Interpreta 'YYYY-MM-DDTHH:mm[:ss]' como hora de Bogotá y devuelve ISO UTC.
 */
export function localToUtc(local: string, tz: string = BOGOTA_TZ): string {
  const match = LOCAL_RE.exec(local.trim());
  if (!match) throw new Error(`Fecha local inválida: ${local}`);
  const [, y, mo, d, h, mi, s] = match;
  const naive = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? 0),
  );
  const first = naive - offsetMs(new Date(naive), tz);
  const second = naive - offsetMs(new Date(first), tz);
  return new Date(second).toISOString();
}

/** Convierte un instante UTC a 'YYYY-MM-DDTHH:mm:ss' en la zona indicada. */
export function utcToLocal(utcIso: string, tz: string = BOGOTA_TZ): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha UTC inválida: ${utcIso}`);
  const p = partsInTz(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Rango UTC [inicio, fin) de un día calendario en Bogotá. */
export function dayRangeUtc(day: string, tz: string = BOGOTA_TZ): {
  startUtc: string;
  endUtc: string;
} {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`Día inválido: ${day}`);
  const startUtc = localToUtc(`${day}T00:00`, tz);
  const nextDay = new Date(Date.parse(startUtc) + 36 * 3600 * 1000);
  const nextLocalDay = utcToLocal(nextDay.toISOString(), tz).slice(0, 10);
  const endUtc = localToUtc(`${nextLocalDay}T00:00`, tz);
  return { startUtc, endUtc };
}

/** Acepta ISO con offset/Z o fecha local de Bogotá y siempre devuelve ISO UTC. */
export function toUtcIso(input: string, tz: string = BOGOTA_TZ): string {
  const value = input.trim();
  if (isLocalDateTime(value)) return localToUtc(value, tz);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`Fecha inválida: ${input}`);
  return new Date(ms).toISOString();
}

/** 'YYYY-MM-DD' del instante en Bogotá. */
export function localDay(utcIso: string, tz: string = BOGOTA_TZ): string {
  return utcToLocal(utcIso, tz).slice(0, 10);
}

/** Día calendario actual en la zona indicada. */
export function todayLocal(tz: string = BOGOTA_TZ): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
