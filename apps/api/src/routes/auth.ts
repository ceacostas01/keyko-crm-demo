import { businesses, memberships, users } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { recordAudit } from '../lib/audit';
import { unauthorized } from '../lib/errors';
import { parse, readJson } from '../lib/http';
import { signToken } from '../lib/jwt';
import { verifyPassword } from '../lib/password';
import {
  checkLoginRateLimit,
  clearLoginFailures,
  clientIp,
  recordLoginFailure,
} from '../lib/rate-limit';
import { requireAuth } from '../middleware/auth';
import { loginSchema } from '../schemas';

export const authRoutes = new Hono<AppEnv>();

/**
 * Hash de relleno para verificar cuando el email no existe. Sin esto, un
 * email desconocido responde mucho más rápido que uno válido con contraseña
 * incorrecta, y ese tiempo permite enumerar cuentas.
 * No corresponde a ninguna contraseña real.
 */
const DUMMY_HASH =
  'pbkdf2$120000$cV/c2AZz1sZFCqzajN3NqQ==$/oCBv386qFVNi/Us4/IE+ZULGl9V0qQ54vz6HBfQFCE=';

authRoutes.post('/login', async (c) => {
  const body = parse(loginSchema, await readJson(c));
  const db = c.get('db');
  const email = body.email.trim().toLowerCase();
  const ip = clientIp(c);

  // Antes de tocar la base de usuarios y antes de PBKDF2.
  const verdict = await checkLoginRateLimit(db, email, ip);
  if (verdict.blocked) {
    return c.json(
      {
        error: {
          code: 'rate_limited',
          message: 'Demasiados intentos fallidos. Intenta de nuevo más tarde.',
        },
      },
      429,
      { 'Retry-After': String(verdict.retryAfterSec) },
    );
  }

  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user || user.status !== 'active') {
    await verifyPassword(body.password, DUMMY_HASH);
    await recordLoginFailure(db, email, ip);
    throw unauthorized('Credenciales inválidas');
  }

  const valid = await verifyPassword(body.password, user.passwordHash);
  if (!valid) {
    await recordLoginFailure(db, email, ip);
    throw unauthorized('Credenciales inválidas');
  }

  // memberships ya soporta varias personas por negocio; hoy solo existe
  // el administrador, pero la consulta no cambia si mañana hay más.
  const rows = await db
    .select({ membership: memberships, business: businesses })
    .from(memberships)
    .innerJoin(businesses, eq(memberships.businessId, businesses.id))
    .where(and(eq(memberships.userId, user.id), eq(memberships.active, 1)));

  const match = body.businessSlug
    ? rows.find((row) => row.business.slug === body.businessSlug)
    : rows[0];

  if (!match) throw unauthorized('Sin acceso a ningún negocio');

  const token = await signToken(c.env.JWT_SECRET, {
    sub: user.id,
    bid: match.business.id,
    role: match.membership.role,
  });

  await db
    .update(users)
    .set({ lastLoginAt: nowSqlite() })
    .where(eq(users.id, user.id));

  await clearLoginFailures(db, email);

  await recordAudit(db, {
    businessId: match.business.id,
    actorId: user.id,
    action: 'auth.login',
    entity: 'user',
    entityId: user.id,
    diff: null,
  });

  return c.json({
    token,
    user: { id: user.id, email: user.email, name: user.name },
    business: {
      id: match.business.id,
      name: match.business.name,
      slug: match.business.slug,
      timezone: match.business.timezone,
      currency: match.business.currency,
    },
    role: match.membership.role,
  });
});

authRoutes.get('/me', requireAuth, async (c) => {
  const auth = c.get('auth');
  const db = c.get('db');

  const [user] = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(eq(users.id, auth.userId))
    .limit(1);

  const [business] = await db
    .select()
    .from(businesses)
    .where(eq(businesses.id, auth.businessId))
    .limit(1);

  if (!user || !business) throw unauthorized('Sesión inválida');

  return c.json({
    user,
    business: {
      id: business.id,
      name: business.name,
      slug: business.slug,
      timezone: business.timezone,
      currency: business.currency,
    },
    role: auth.role,
  });
});
