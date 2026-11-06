/**
 * Normaliza a E.164 asumiendo Colombia (+57) cuando el número viene sin
 * prefijo internacional.
 */
export function normalizePhone(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');

  if (digits.length === 0) throw new Error('Teléfono vacío');

  let e164: string;
  if (trimmed.startsWith('+')) {
    e164 = `+${digits}`;
  } else if (digits.length === 10 && digits.startsWith('3')) {
    e164 = `+57${digits}`;
  } else if (digits.length === 12 && digits.startsWith('57')) {
    e164 = `+${digits}`;
  } else {
    e164 = `+${digits}`;
  }

  const length = e164.replace(/\D/g, '').length;
  if (length < 8 || length > 15) throw new Error('Teléfono fuera de rango E.164');
  return e164;
}

/** Formato legible para Colombia: +57 321 349 7950 */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  if (digits.startsWith('57') && digits.length === 12) {
    return `+57 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return e164;
}
