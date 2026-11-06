/**
 * Siembra datos ficticios en una base ya migrada y con negocio creado.
 *
 *   BUSINESS_ID=keyko TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
 *   pnpm --filter @keyko/api seed-fictional --allow-remote
 *
 * Solo crea un contacto de WhatsApp con dos mensajes y un cliente con una
 * mascota. No toca el webhook ni datos reales.
 */
import { createClient } from '@libsql/client';

const BUSINESS_ID = process.env.BUSINESS_ID ?? 'keyko';

const MESSAGES = [
  {
    id: 'seed-ai-1',
    contact: 'CO.SEED000000000001',
    phone: '573150000001',
    name: 'Sofía',
    body: 'Hola, me llamo Sofía Ramírez y tengo una perrita llamada Nala, es una french poodle de 4 kg.',
  },
  {
    id: 'seed-ai-2',
    contact: 'CO.SEED000000000001',
    phone: '573150000001',
    name: 'Sofía',
    body: 'Quiero agendar baño y corte para el sábado a las 10 de la mañana.',
  },
];

async function main() {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('Falta TURSO_DATABASE_URL');

  const isLocal = url.startsWith('file:') || url.includes('localhost');
  if (!isLocal && !process.argv.includes('--allow-remote')) {
    throw new Error(
      'Destino remoto detectado. Repite con --allow-remote si es intencional.',
    );
  }

  const client = createClient({
    url,
    ...(process.env.TURSO_AUTH_TOKEN
      ? { authToken: process.env.TURSO_AUTH_TOKEN }
      : {}),
  });

  try {
    for (const message of MESSAGES) {
      await client.execute({
        sql: `INSERT OR IGNORE INTO whatsapp_messages
                (message_id, business_id, direction, contact_key, contact_phone,
                 contact_name, message_type, body, message_timestamp, raw_message_json)
              VALUES (?, ?, 'inbound', ?, ?, ?, 'text', ?, ?, '{}')`,
        args: [
          message.id,
          BUSINESS_ID,
          message.contact,
          message.phone,
          message.name,
          message.body,
          new Date().toISOString(),
        ],
      });
    }

    console.log('Datos ficticios sembrados.');
    console.log(`  negocio: ${BUSINESS_ID}`);
    console.log('  contacto: CO.SEED000000000001 (Sofía, 2 mensajes)');
    console.log('  siguiente paso: POST /api/v1/ai/process con un token');
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
