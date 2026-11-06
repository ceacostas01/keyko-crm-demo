import { businesses, createDb } from '@keyko/db';
import { createClient, type Client } from '@libsql/client/web';
import { eq } from 'drizzle-orm';
import { createApp } from './app';
import { aiConfig } from './lib/ai/config';
import { processAiJobs } from './lib/ai/jobs';
import { getStorage } from './lib/storage';
import type { AppEnv } from './env';

/**
 * Un cliente por isolate: reutilizar la conexión evita abrir un socket
 * HTTP nuevo en cada petición.
 */
let cached: Client | null = null;
let cachedKey = '';

function dbFor(env: AppEnv['Bindings']) {
  if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
    throw new Error('Faltan TURSO_DATABASE_URL o TURSO_AUTH_TOKEN');
  }

  const key = `${env.TURSO_DATABASE_URL}|${env.TURSO_AUTH_TOKEN.slice(0, 8)}`;
  if (!cached || cachedKey !== key) {
    cached = createClient({
      url: env.TURSO_DATABASE_URL,
      authToken: env.TURSO_AUTH_TOKEN,
    });
    cachedKey = key;
  }
  return createDb(cached);
}

const app = createApp({ getDb: dbFor, getStorage });

/**
 * Procesamiento programado: lee mensajes nuevos de Turso y crea lotes sin
 * tocar el webhook. El cursor real es `ai_processed_messages`; `AI_STARTED_AT`
 * evita reprocesar el historial anterior a la activación.
 */
async function runAiCron(env: AppEnv['Bindings']): Promise<void> {
  const config = aiConfig(env);
  if (!config.enabled || !config.autoProcess) return;

  const db = dbFor(env);
  const active = await db
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.status, 'active'));

  for (const business of active) {
    try {
      const result = await processAiJobs(db, business.id, {
        config,
        limit: 5,
        ...(config.testContacts.length > 0
          ? { contactKeys: config.testContacts }
          : {}),
        since: config.startedAt,
      });
      console.log(
        'ai_cron',
        business.id,
        `processed=${result.processed}`,
        `failed=${result.failed}`,
        `skipped=${result.skipped}`,
        `reason=${result.reason ?? 'none'}`,
      );
    } catch (error) {
      console.error('ai_cron_failed', business.id, error);
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled: async (
    _event: unknown,
    env: AppEnv['Bindings'],
    ctx: { waitUntil(promise: Promise<unknown>): void },
  ) => {
    ctx.waitUntil(runAiCron(env));
  },
};
