const cop = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

/** Centavos → '$ 45.000' */
export function formatCop(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error('Los centavos deben ser enteros');
  return cop.format(cents / 100);
}

/** '45.000' o '45000' → 4500000 centavos */
export function parseCopToCents(input: string): number {
  const clean = input.replace(/[^\d]/g, '');
  if (clean === '') throw new Error('Monto vacío');
  return Number(clean) * 100;
}
