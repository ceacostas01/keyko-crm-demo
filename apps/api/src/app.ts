import type { Db } from '@keyko/db';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { parseAllowedOrigins, type AppEnv } from './env';
import { HttpError } from './lib/errors';
import type { StorageAdapter } from './lib/storage';
import { aiRoutes } from './routes/ai';
import { auditRoutes } from './routes/audit';
import { appointmentRequestRoutes } from './routes/appointment-requests';
import { appointmentRoutes } from './routes/appointments';
import { authRoutes } from './routes/auth';
import { clientRoutes } from './routes/clients';
import { conversationRoutes } from './routes/conversations';
import { expenseRoutes } from './routes/expenses';
import { petRoutes } from './routes/pets';
import { photoRoutes } from './routes/photos';
import { productRoutes } from './routes/products';
import { saleRoutes } from './routes/sales';
import { statsRoutes } from './routes/stats';
import { serviceRoutes } from './routes/services';

/**
 * La conexión a base de datos se inyecta para poder usar el driver
 * nativo en tests y el driver web en Cloudflare Workers.
 */
export type DbFactory = (env: AppEnv['Bindings']) => Db;
export type StorageFactory = (env: AppEnv['Bindings']) => StorageAdapter;

export type AppDeps = {
  getDb: DbFactory;
  getStorage: StorageFactory;
};

export function createApp({ getDb, getStorage }: AppDeps) {
  const app = new Hono<AppEnv>();

  // Solo los orígenes configurados reciben cabeceras CORS. Un origen
  // desconocido no las recibe y el navegador bloquea la lectura.
  app.use(
    '*',
    cors({
      origin: (origin, c) =>
        parseAllowedOrigins(c.env.ALLOWED_ORIGINS).includes(origin)
          ? origin
          : null,
      allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
      maxAge: 86_400,
    }),
  );

  app.use('*', async (c, next) => {
    c.set('db', getDb(c.env));
    c.set('storage', getStorage(c.env));
    await next();
  });

  app.get('/health', (c) =>
    c.json({ status: 'ok', service: 'keyko-crm-api', timezone: 'America/Bogota' }),
  );

  const api = new Hono<AppEnv>();
  api.route('/auth', authRoutes);
  api.route('/clients', clientRoutes);
  api.route('/pets', petRoutes);
  api.route('/services', serviceRoutes);
  api.route('/products', productRoutes);
  api.route('/sales', saleRoutes);
  api.route('/expenses', expenseRoutes);
  api.route('/appointments', appointmentRoutes);
  api.route('/appointment-requests', appointmentRequestRoutes);
  api.route('/conversations', conversationRoutes);
  api.route('/audit', auditRoutes);
  api.route('/ai', aiRoutes);
  api.route('/stats', statsRoutes);
  api.route('/photos', photoRoutes);

  app.route('/api/v1', api);

  app.notFound((c) =>
    c.json({ error: { code: 'not_found', message: 'Ruta no encontrada' } }, 404),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details === undefined ? {} : { details: err.details }),
          },
        },
        err.status as ContentfulStatusCode,
      );
    }

    console.error('unhandled_error', err);
    return c.json(
      { error: { code: 'internal_error', message: 'Error interno' } },
      500,
    );
  });

  return app;
}
