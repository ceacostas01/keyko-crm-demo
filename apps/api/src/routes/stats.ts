import { Hono } from 'hono';
import type { AppEnv } from '../env';
import { dataQualitySummary } from '../lib/completeness';
import { requireAuth } from '../middleware/auth';

/**
 * Calidad de datos. Deliberadamente separada de ventas y citas: mezclar
 * "faltan fotos" con "ingresos del mes" confunde dos cosas distintas.
 */
export const statsRoutes = new Hono<AppEnv>();

statsRoutes.use('*', requireAuth);

statsRoutes.get('/data-quality', async (c) => {
  const { businessId } = c.get('auth');
  const db = c.get('db');

  const data = await dataQualitySummary(db, businessId);
  return c.json({
    data: {
      ...data,
      generatedAt: new Date().toISOString(),
    },
  });
});
