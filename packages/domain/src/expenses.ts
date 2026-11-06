/**
 * Categorías de egresos del negocio.
 *
 * Son deliberadamente pocas y cerradas: el detalle libre explica el gasto y
 * la categoría permite sumar por tipo sin depender de texto escrito a mano.
 */
export const EXPENSE_CATEGORIES = [
  'luz',
  'gas',
  'agua',
  'arriendo',
  'personal',
  'otro',
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const EXPENSE_CATEGORY_LABELS: Record<ExpenseCategory, string> = {
  luz: 'Luz',
  gas: 'Gas',
  agua: 'Agua',
  arriendo: 'Arriendo',
  personal: 'Personal',
  otro: 'Otro',
};

export function isExpenseCategory(value: string): value is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}
