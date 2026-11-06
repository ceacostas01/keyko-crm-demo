/**
 * Las columnas de fecha del esquema usan dos formatos:
 *
 *  - `created_at` (DEFAULT CURRENT_TIMESTAMP): 'YYYY-MM-DD HH:MM:SS' en UTC.
 *  - citas y nacimientos: ISO con 'T' y 'Z'.
 *
 * Mezclarlos al comparar rompe los rangos, porque ' ' ordena antes que 'T'.
 * Estas funciones convierten de forma explícita.
 */

export function sqliteToIso(value: string): string {
  const text = value.trim();
  if (text.includes('T')) {
    return text.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(text) ? text : `${text}Z`;
  }
  return `${text.replace(' ', 'T')}Z`;
}

export function isoToSqlite(value: string): string {
  return new Date(value).toISOString().slice(0, 19).replace('T', ' ');
}
