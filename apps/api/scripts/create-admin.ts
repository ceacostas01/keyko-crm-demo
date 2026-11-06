/**
 * Crea el negocio y el administrador en una base ya migrada.
 *
 *   BUSINESS_ID=keyko ADMIN_EMAIL=... ADMIN_PASSWORD=... \
 *   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
 *   pnpm --filter @keyko/api create-admin
 *
 * Contra un host remoto exige `--allow-remote`. No imprime contraseñas.
 */
import { createClient } from '@libsql/client';
import { hashPassword } from '../src/lib/password';

const BUSINESS_ID = process.env.BUSINESS_ID ?? 'keyko';
const BUSINESS_NAME = process.env.BUSINESS_NAME ?? 'Keyko Pet Grooming';
const BUSINESS_SLUG = process.env.BUSINESS_SLUG ?? BUSINESS_ID;
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const ADMIN_NAME = process.env.ADMIN_NAME ?? 'Administrador';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? '';

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('Falta TURSO_DATABASE_URL');

  const isLocal = url.startsWith('file:') || url.includes('localhost');
  if (!isLocal && !process.argv.includes('--allow-remote')) {
    throw new Error(
      'Destino remoto detectado. Repite con --allow-remote si es intencional.',
    );
  }

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
    throw new Error('Faltan ADMIN_EMAIL y ADMIN_PASSWORD');
  }

  if (ADMIN_PASSWORD.length < 10) {
    throw new Error('ADMIN_PASSWORD debe tener al menos 10 caracteres');
  }

  const client = createClient({
    url,
    ...(process.env.TURSO_AUTH_TOKEN
      ? { authToken: process.env.TURSO_AUTH_TOKEN }
      : {}),
  });

  try {
    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('businesses','users','memberships')",
    );
    if (tables.rows.length < 3) {
      throw new Error('La base no está migrada. Ejecuta db:migrate primero.');
    }

    await client.execute({
      sql: `INSERT OR IGNORE INTO businesses (id, name, slug)
            VALUES (?, ?, ?)`,
      args: [BUSINESS_ID, BUSINESS_NAME, BUSINESS_SLUG],
    });

    const existing = await client.execute({
      sql: 'SELECT id FROM users WHERE email = ?',
      args: [ADMIN_EMAIL],
    });

    let userId = existing.rows[0]?.id ? String(existing.rows[0].id) : null;
    let createdUser = false;

    if (!userId) {
      userId = crypto.randomUUID();
      await client.execute({
        sql: `INSERT INTO users (id, email, name, password_hash)
              VALUES (?, ?, ?, ?)`,
        args: [userId, ADMIN_EMAIL, ADMIN_NAME, await hashPassword(ADMIN_PASSWORD)],
      });
      createdUser = true;
    }

    const membershipId = `member-${BUSINESS_ID}-${userId}`;
    await client.execute({
      sql: `INSERT OR IGNORE INTO memberships (id, business_id, user_id, role)
            VALUES (?, ?, ?, 'owner')`,
      args: [membershipId, BUSINESS_ID, userId],
    });

    console.log('Listo.');
    console.log(`  negocio: ${BUSINESS_ID} (${BUSINESS_SLUG})`);
    console.log(`  admin:   ${ADMIN_EMAIL}${createdUser ? ' (creado)' : ' (ya existía, contraseña intacta)'}`);
    console.log(`  rol:     owner`);
    console.log(
      createdUser
        ? '  contraseña: definida por ADMIN_PASSWORD (no se muestra)'
        : '  nota: el usuario existía; no se cambió su contraseña',
    );
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
