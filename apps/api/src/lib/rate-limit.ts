import { loginFailures } from '@keyko/db';
import type { Db } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, count, eq, gt, lt, min } from 'drizzle-orm';
import type { Context } from 'hono';

/**
 * Límite de intentos de login.
 *
 * Se cuentan solo los fallos, en una ventana deslizante por email y por IP.
 * Se consulta ANTES de verificar la contraseña: así no se gastan 120 000
 * iteraciones de PBKDF2 en un ataque de fuerza bruta.
 */
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const MAX_FAILURES_PER_EMAIL = 5;
export const MAX_FAILURES_PER_IP = 20;

/** Intentos más viejos que esto se borran; ya no afectan a ninguna ventana. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

export type RateLimitVerdict =
  | { blocked: false }
  | { blocked: true; retryAfterSec: number };

/**
 * En Cloudflare `cf-connecting-ip` lo pone el edge y no se puede falsificar.
 * `x-forwarded-for` solo se usa cuando no existe (desarrollo local).
 */
export function clientIp(c: Context): string {
  const cf = c.req.header('cf-connecting-ip');
  if (cf) return cf.trim();

  const forwarded = c.req.header('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

async function windowStats(
  db: Db,
  column: 'email' | 'ip',
  value: string,
  since: string,
): Promise<{ failures: number; oldest: string | null }> {
  const target = column === 'email' ? loginFailures.email : loginFailures.ip;

  const [row] = await db
    .select({ failures: count(), oldest: min(loginFailures.attemptedAt) })
    .from(loginFailures)
    .where(and(eq(target, value), gt(loginFailures.attemptedAt, since)));

  return {
    failures: Number(row?.failures ?? 0),
    oldest: row?.oldest ?? null,
  };
}

function retryAfter(oldest: string | null): number {
  if (!oldest) return Math.ceil(LOGIN_WINDOW_MS / 1000);
  const elapsed = Date.now() - Date.parse(oldest.replace(' ', 'T') + 'Z');
  const remaining = LOGIN_WINDOW_MS - elapsed;
  return Math.max(1, Math.ceil(remaining / 1000));
}

export async function checkLoginRateLimit(
  db: Db,
  email: string,
  ip: string,
): Promise<RateLimitVerdict> {
  const since = nowSqlite(new Date(Date.now() - LOGIN_WINDOW_MS));

  const byEmail = await windowStats(db, 'email', email, since);
  if (byEmail.failures >= MAX_FAILURES_PER_EMAIL) {
    return { blocked: true, retryAfterSec: retryAfter(byEmail.oldest) };
  }

  if (ip !== 'unknown') {
    const byIp = await windowStats(db, 'ip', ip, since);
    if (byIp.failures >= MAX_FAILURES_PER_IP) {
      return { blocked: true, retryAfterSec: retryAfter(byIp.oldest) };
    }
  }

  return { blocked: false };
}

export async function recordLoginFailure(
  db: Db,
  email: string,
  ip: string,
): Promise<void> {
  // Limpieza oportunista: la tabla se mantiene pequeña sin un cron.
  await db
    .delete(loginFailures)
    .where(lt(loginFailures.attemptedAt, nowSqlite(new Date(Date.now() - RETENTION_MS))));

  await db.insert(loginFailures).values({
    id: crypto.randomUUID(),
    email,
    ip: ip === 'unknown' ? null : ip,
  });
}

/** Un login correcto limpia los fallos de ese email en la ventana. */
export async function clearLoginFailures(
  db: Db,
  email: string,
): Promise<void> {
  await db.delete(loginFailures).where(eq(loginFailures.email, email));
}
