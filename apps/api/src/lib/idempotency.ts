import type { Db } from '@keyko/db';
import { nowSqlite } from '@keyko/domain';
import { sql } from 'drizzle-orm';
import { createMiddleware } from 'hono/factory';
import type { AppEnv } from '../env';
import { badRequest, conflict } from './errors';

/**
 * Idempotencia de mutaciones.
 *
 * El cliente manda `Idempotency-Key`. El primer envío se procesa y su
 * respuesta se guarda; los reenvíos con la misma clave devuelven exactamente
 * la misma respuesta, sin volver a crear ni modificar nada.
 *
 * Así un doble clic o un reintento de red no duplica citas, aunque la agenda
 * ya no bloquee por solapamientos.
 *
 * La clave se "reserva" con un INSERT ... ON CONFLICT DO NOTHING: si dos
 * peticiones llegan a la vez con la misma clave, solo una puede insertarla y
 * la otra recibe 409 en vez de duplicar la operación.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;
const RETENTION_MS = 24 * 60 * 60 * 1000;

function replay(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'idempotency-replayed': 'true',
    },
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function release(db: Db, businessId: string, key: string): Promise<void> {
  await db.run(
    sql`DELETE FROM idempotency_keys
         WHERE business_id = ${businessId} AND idem_key = ${key}`,
  );
}

export const idempotent = createMiddleware<AppEnv>(async (c, next) => {
  const key = c.req.header(IDEMPOTENCY_HEADER)?.trim();
  if (!key) {
    await next();
    return;
  }

  if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {
    throw badRequest(
      `Idempotency-Key debe tener entre ${MIN_KEY_LENGTH} y ${MAX_KEY_LENGTH} caracteres`,
    );
  }

  const { businessId } = c.get('auth');
  const db = c.get('db');
  const method = c.req.method;
  const path = new URL(c.req.url).pathname;
  // Hono cachea el body, así que el handler puede volver a leerlo como JSON.
  const raw = await c.req.text();
  const requestHash = await sha256Hex(`${method} ${path} ${raw}`);

  await db.run(
    sql`DELETE FROM idempotency_keys
         WHERE created_at < ${nowSqlite(new Date(Date.now() - RETENTION_MS))}`,
  );

  const claimed = await db.all<{ id: string }>(sql`
    INSERT INTO idempotency_keys
      (id, business_id, idem_key, method, path, request_hash)
    VALUES (${crypto.randomUUID()}, ${businessId}, ${key}, ${method}, ${path},
            ${requestHash})
    ON CONFLICT (business_id, idem_key) DO NOTHING
    RETURNING id
  `);

  if (claimed.length === 0) {
    const rows = await db.all<{
      request_hash: string;
      response_status: number | null;
      response_body: string | null;
    }>(sql`
      SELECT request_hash, response_status, response_body
        FROM idempotency_keys
       WHERE business_id = ${businessId} AND idem_key = ${key}
    `);
    const row = rows[0];

    if (!row) {
      throw conflict(
        'idempotency_in_progress',
        'La operación con esa clave está en curso. Reintenta en un momento.',
      );
    }

    if (row.request_hash !== requestHash) {
      throw conflict(
        'idempotency_key_reuse',
        'Esa Idempotency-Key ya se usó con otros datos. Usa una clave nueva.',
      );
    }

    if (row.response_body === null || row.response_status === null) {
      throw conflict(
        'idempotency_in_progress',
        'La operación con esa clave está en curso. Reintenta en un momento.',
      );
    }

    return replay(String(row.response_body), Number(row.response_status));
  }

  try {
    await next();
  } catch (error) {
    // Si falló, la clave se libera para que el cliente pueda reintentar.
    await release(db, businessId, key);
    throw error;
  }

  const status = c.res.status;
  const body = await c.res.clone().text();

  if (status >= 500) {
    await release(db, businessId, key);
    return;
  }

  await db.run(
    sql`UPDATE idempotency_keys
           SET response_status = ${status}, response_body = ${body}
         WHERE business_id = ${businessId} AND idem_key = ${key}`,
  );

  c.header('Idempotency-Key', key);
});
