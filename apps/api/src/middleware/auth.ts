import type { Role } from '@keyko/domain';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { unauthorized } from '../lib/errors';
import { verifyToken } from '../lib/jwt';

/**
 * El business_id SIEMPRE sale del token firmado.
 * Nunca se lee de body, query ni headers del cliente.
 *
 * No hay matriz de roles: un negocio tiene un solo administrador. El rol
 * viaja en el token como dato para cuando haga falta, pero no se evalúa.
 */
export const requireAuth = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match?.[1]) throw unauthorized('Token requerido');

  const payload = await verifyToken(c.env.JWT_SECRET, match[1]);
  c.set('auth', {
    userId: payload.sub,
    businessId: payload.bid,
    role: payload.role as Role,
  });

  await next();
});
