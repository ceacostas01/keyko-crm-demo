/**
 * Edad de mascotas: el CRM pide un número y una unidad (meses o años).
 * Internamente se guarda en `ageYears` para no duplicar columnas.
 */

export type AgeUnit = 'years' | 'months';

export type AgeInput = {
  value: string;
  unit: AgeUnit;
};

export function ageToInput(ageYears: number | null | undefined): AgeInput {
  if (ageYears === null || ageYears === undefined) {
    return { value: '', unit: 'years' };
  }

  if (!Number.isInteger(ageYears)) {
    return {
      value: String(Math.round(ageYears * 12)),
      unit: 'months',
    };
  }

  return { value: String(ageYears), unit: 'years' };
}

export function ageFromInput(value: string, unit: AgeUnit): number | null {
  const text = value.trim();
  if (text === '') return null;

  const number = Number(text);
  if (!Number.isFinite(number) || number < 0) return null;

  if (unit === 'months') {
    return Math.round((number / 12) * 1000) / 1000;
  }
  return Math.round(number * 100) / 100;
}

export function formatPetAge(ageYears: number | null | undefined): string {
  if (ageYears === null || ageYears === undefined) return '';
  if (ageYears > 0 && !Number.isInteger(ageYears)) {
    return `${Math.round(ageYears * 12)} meses`;
  }
  if (ageYears === 1) return '1 año';
  return `${ageYears} años`;
}
