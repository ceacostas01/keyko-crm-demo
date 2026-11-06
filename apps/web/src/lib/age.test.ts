import { describe, expect, it } from 'vitest';
import { ageFromInput, ageToInput, formatPetAge } from './age';

describe('edad de mascotas', () => {
  it('muestra años enteros y meses para fracciones', () => {
    expect(ageToInput(2)).toEqual({ value: '2', unit: 'years' });
    expect(ageToInput(0.5)).toEqual({ value: '6', unit: 'months' });
    expect(ageToInput(1.5)).toEqual({ value: '18', unit: 'months' });
    expect(ageToInput(null)).toEqual({ value: '', unit: 'years' });
  });

  it('convierte meses a años internamente', () => {
    expect(ageFromInput('6', 'months')).toBe(0.5);
    expect(ageFromInput('18', 'months')).toBe(1.5);
    expect(ageFromInput('2', 'years')).toBe(2);
    expect(ageFromInput('', 'years')).toBeNull();
  });

  it('formatea la edad para la ficha', () => {
    expect(formatPetAge(2)).toBe('2 años');
    expect(formatPetAge(1)).toBe('1 año');
    expect(formatPetAge(0.5)).toBe('6 meses');
    expect(formatPetAge(1.5)).toBe('18 meses');
  });
});
