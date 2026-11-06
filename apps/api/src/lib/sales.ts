/**
 * Reglas de dinero de una venta.
 *
 * Todo en centavos. El descuento de una línea se resta de esa línea; el
 * descuento de la venta se resta al final. El historial de una mascota
 * reparte el descuento de la venta de forma proporcional para que el total
 * gastado por mascota cuadre con el total realmente cobrado.
 */

export type SaleLineInput = {
  qty: number;
  unitPriceCents: number;
  discountCents: number;
};

export function lineTotalCents(line: SaleLineInput): number {
  return Math.max(
    0,
    line.qty * line.unitPriceCents - line.discountCents,
  );
}

export function sumLines(lines: readonly SaleLineInput[]): number {
  return lines.reduce((total, line) => total + lineTotalCents(line), 0);
}

/**
 * Parte del descuento de la venta que corresponde a una línea, en proporción
 * a su peso sobre el subtotal. Se redondea al centavo.
 */
export function proportionalDiscount(
  subtotalCents: number,
  saleDiscountCents: number,
  lineCents: number,
): number {
  if (subtotalCents <= 0 || saleDiscountCents <= 0) return 0;
  return Math.round((saleDiscountCents * lineCents) / subtotalCents);
}

/** Lo que realmente aporta una línea al total cobrado. */
export function attributedCents(
  subtotalCents: number,
  saleDiscountCents: number,
  lineCents: number,
): number {
  return Math.max(0, lineCents - proportionalDiscount(subtotalCents, saleDiscountCents, lineCents));
}

export type PaymentInput = { amountCents: number };

export function paidCents(payments: readonly PaymentInput[]): number {
  return payments.reduce((total, payment) => total + payment.amountCents, 0);
}

export type MoneyMovement = {
  amountCents: number;
  kind: 'payment' | 'refund';
};

/**
 * Dinero neto en manos del negocio: lo cobrado menos lo devuelto.
 * Nunca puede ser negativo (no se devuelve más de lo que entró).
 */
export function netPaidCents(movements: readonly MoneyMovement[]): number {
  return movements.reduce(
    (total, movement) =>
      total + (movement.kind === 'refund' ? -movement.amountCents : movement.amountCents),
    0,
  );
}

export type MoneyPosition = {
  paidCents: number;
  refundedCents: number;
  netPaidCents: number;
  pendingCents: number;
  overpaidCents: number;
};

/**
 * Posición de una venta. `pending` y `overpaid` son excluyentes: o falta
 * dinero o sobra. Lo que sobra se devuelve con un reembolso explícito.
 */
export function moneyPosition(
  totalCents: number,
  movements: readonly MoneyMovement[],
): MoneyPosition {
  const paid = movements
    .filter((movement) => movement.kind === 'payment')
    .reduce((sum, movement) => sum + movement.amountCents, 0);
  const refunded = movements
    .filter((movement) => movement.kind === 'refund')
    .reduce((sum, movement) => sum + movement.amountCents, 0);
  const net = paid - refunded;

  return {
    paidCents: paid,
    refundedCents: refunded,
    netPaidCents: net,
    pendingCents: Math.max(0, totalCents - net),
    overpaidCents: Math.max(0, net - totalCents),
  };
}

export function saleStatus(
  totalCents: number,
  paid: number,
): 'open' | 'paid' {
  if (totalCents <= 0) return 'paid';
  return paid >= totalCents ? 'paid' : 'open';
}

/** Tamaño orientativo a partir del peso, porque el esquema no tiene columna. */
export const SIZE_RANGES = {
  small: { maxKg: 10 },
  medium: { maxKg: 25 },
  large: { minKg: 25 },
} as const;

export type PetSize = keyof typeof SIZE_RANGES;

export function petSize(weightKg: number | null): PetSize | null {
  if (weightKg === null || Number.isNaN(weightKg)) return null;
  if (weightKg < 10) return 'small';
  if (weightKg <= 25) return 'medium';
  return 'large';
}

export const SIZE_LABELS: Record<PetSize, string> = {
  small: 'Pequeño',
  medium: 'Mediano',
  large: 'Grande',
};
