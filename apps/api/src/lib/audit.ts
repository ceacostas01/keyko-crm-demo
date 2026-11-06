import { auditLog } from '@keyko/db';
import type { Db } from '@keyko/db';

/**
 * Auditoría básica de cambios importantes.
 *
 * Se guarda el delta, no la fila completa: sirve para responder "quién
 * cambió qué y cuándo" sin duplicar la base. Nunca se registran contraseñas
 * ni tokens porque ninguna entidad los expone en un patch.
 *
 * La escritura es best-effort: si falla, se registra en el log del Worker
 * pero no se tumba la operación que el usuario ya completó.
 */

export type AuditAction =
  | 'auth.login'
  | 'client.create'
  | 'client.update'
  | 'client.delete'
  | 'pet.create'
  | 'pet.update'
  | 'pet.delete'
  | 'pet.purge'
  | 'service.create'
  | 'service.update'
  | 'service.delete'
  | 'product.create'
  | 'product.update'
  | 'product.delete'
  | 'product.stock'
  | 'sale.create'
  | 'sale.update'
  | 'sale.payment'
  | 'sale.refund'
  | 'sale.return'
  | 'sale.void'
  | 'sale.delete'
  | 'expense.create'
  | 'expense.update'
  | 'expense.delete'
  | 'appointment_request.create'
  | 'appointment_request.update'
  | 'ai.apply'
  | 'transcription.correct'
  | 'appointment.create'
  | 'appointment.update'
  | 'appointment.cancel'
  | 'appointment.reactivate';

export type AuditEntity =
  | 'user'
  | 'client'
  | 'pet'
  | 'service'
  | 'product'
  | 'sale'
  | 'appointment'
  | 'appointment_request'
  | 'expense'
  | 'message';

export type Diff = Record<string, { from: unknown; to: unknown }>;

/**
 * Solo los campos que realmente cambian. `undefined` significa "no lo toques"
 * y no entra en el diff. `updatedAt` cambia siempre y no aporta nada.
 */
export function buildDiff(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
  ignore: readonly string[] = ['updatedAt'],
): Diff | null {
  const diff: Diff = {};

  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || ignore.includes(key)) continue;
    const previous = before[key] ?? null;
    const next = value ?? null;
    if (previous === next) continue;
    diff[key] = { from: previous, to: next };
  }

  return Object.keys(diff).length > 0 ? diff : null;
}

export type AuditInput = {
  businessId: string;
  actorId: string | null;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string;
  diff?: Diff | null;
};

export async function recordAudit(db: Db, input: AuditInput): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      businessId: input.businessId,
      actorId: input.actorId,
      action: input.action,
      entity: input.entity,
      entityId: input.entityId,
      diffJson: input.diff ? JSON.stringify(input.diff) : null,
    });
  } catch (error) {
    console.error('audit_failed', input.action, input.entity, error);
  }
}

/**
 * Registra una edición solo si algo cambió de verdad. Guardar sin modificar
 * nada no es un cambio que auditar.
 */
export async function recordChange(
  db: Db,
  base: Omit<AuditInput, 'diff'>,
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Promise<void> {
  const diff = buildDiff(before, patch);
  if (!diff) return;
  await recordAudit(db, { ...base, diff });
}
