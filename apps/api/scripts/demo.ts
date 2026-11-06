/**
 * Servidor de demostración local.
 *
 * Usa una base SQLite temporal construida desde migrations/ y NUNCA
 * toca Turso de producción. Sirve para probar la API por HTTP real:
 *
 *   pnpm demo
 *   curl -s localhost:8787/health
 */
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@keyko/db';
import { localToUtc } from '@keyko/domain';
import { createClient } from '@libsql/client';
import { createApp } from '../src/app';
import { createMemoryStorage } from '../src/lib/storage';
import type { AppEnv } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { isoToSqlite } from '../src/lib/time';

const PORT = Number(process.env.PORT ?? 8787);
const JWT_SECRET = 'demo-secret-solo-local';
const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);
const DEMO_EMAIL = 'demo@keyko.local';
const DEMO_PASSWORD = 'Demo1234!';

async function main() {
  const file = join(tmpdir(), `keyko-demo-${randomUUID()}.db`);
  const client = createClient({ url: `file:${file}` });

  const migrations = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  for (const name of migrations) {
    await client.executeMultiple(readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8'));
  }

  const passwordHash = await hashPassword(DEMO_PASSWORD);

  await client.execute({
    sql: `INSERT INTO users (id, email, name, password_hash)
          VALUES (?, ?, ?, ?)`,
    args: ['user-demo-owner', DEMO_EMAIL, 'Demo Keyko', passwordHash],
  });

  await client.execute({
    sql: `INSERT INTO memberships (id, business_id, user_id, role)
          VALUES ('member-demo', 'keyko', 'user-demo-owner', 'owner')`,
  });

  // --- Datos ficticios para que la interfaz tenga vida ---------------------
  const todayLocal = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Bogota',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const dayOffset = (offset: number) => {
    const [y, m, d] = todayLocal.split('-').map(Number);
    const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
    const next = new Date(base + offset * 86_400_000);
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
  };

  const at = (offset: number, hour: number, minute = 0) =>
    localToUtc(
      `${dayOffset(offset)}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    );

  const clients = [
    ['+573001112233', 'Ana Pérez', 'ana@example.com', 'Prefiere citas en la mañana.'],
    ['+573124445566', 'Carlos Ruiz', 'carlos@example.com', null],
    ['+573157778899', 'Marcela Gómez', null, 'Llega con su mamá.'],
  ] as const;

  const clientIds = new Map<string, number>();
  for (const [phone, name, email, notes] of clients) {
    const result = await client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name, email, notes)
            VALUES ('keyko', ?, ?, ?, ?, ?) RETURNING id`,
      args: [phone, phone, name, email, notes],
    });
    clientIds.set(name, Number(result.rows[0]?.id));
  }

  const clientIdOf = (name: string): number => {
    const id = clientIds.get(name);
    if (id === undefined) throw new Error(`Cliente no sembrado: ${name}`);
    return id;
  };

  const petsSeed = [
    ['pet-luna', 'Ana Pérez', 'Luna', 'gato', 'hembra', 'Siamés', 4.2, 'Pollo'],
    ['pet-firulais', 'Ana Pérez', 'Firulais', 'perro', 'macho', 'Poodle', 7.5, null],
    ['pet-toby', 'Carlos Ruiz', 'Toby', 'perro', 'macho', 'Beagle', 12.0, 'Polen'],
    ['pet-michi', 'Marcela Gómez', 'Michi', 'gato', 'macho', 'Criollo', 3.8, null],
  ] as const;

  for (const [id, owner, name, species, sex, breed, weight, allergies] of petsSeed) {
    await client.execute({
      sql: `INSERT INTO pets
              (id, business_id, client_id, name, species, sex, breed, weight_kg, allergies)
            VALUES (?, 'keyko', ?, ?, ?, ?, ?, ?, ?)`,
      args: [id, clientIdOf(owner), name, species, sex, breed, weight, allergies],
    });
  }

  const servicesSeed = [
    ['svc-bath', 'Baño y secado', 'estética', 60, 4500000],
    ['svc-nails', 'Corte de uñas', 'estética', 20, 2500000],
    ['svc-medicated', 'Baño medicado', 'salud', 75, 6000000],
    ['svc-full', 'Corte completo', 'estética', 120, 8000000],
  ] as const;

  for (const [id, name, category, duration, price] of servicesSeed) {
    await client.execute({
      sql: `INSERT INTO services (id, business_id, name, category, duration_min, price_cents)
            VALUES (?, 'keyko', ?, ?, ?, ?)`,
      args: [id, name, category, duration, price],
    });
  }

  const productsSeed = [
    ['prod-shampoo', 'SH-01', 'Shampoo hipoalergénico', 3200000, 1800000, 8, 3],
    ['prod-brush', 'CP-02', 'Cepillo doble', 1500000, 700000, 2, 4],
    ['prod-snacks', 'SN-03', 'Snacks dentales', 1200000, 600000, 25, 5],
  ] as const;

  for (const [id, sku, name, price, cost, stock, minStock] of productsSeed) {
    await client.execute({
      sql: `INSERT INTO products
              (id, business_id, sku, name, price_cents, cost_cents, stock, min_stock)
            VALUES (?, 'keyko', ?, ?, ?, ?, ?, ?)`,
      args: [id, sku, name, price, cost, stock, minStock],
    });
  }

  // Una cita a las 11:00 que se cruza con la de 10:30: la agenda debe
  // mostrarla con aviso y dejar guardarla igual.
  const appointmentsSeed = [
    ['appt-1', 'Ana Pérez', 'pet-luna', 0, 9, 0, 60, 'done', 'Baño y secado'],
    ['appt-2', 'Carlos Ruiz', 'pet-toby', 0, 10, 30, 60, 'confirmed', null],
    ['appt-3', 'Ana Pérez', 'pet-firulais', 0, 11, 0, 45, 'scheduled', 'Corte de uñas'],
    ['appt-4', 'Marcela Gómez', 'pet-michi', 0, 15, 0, 60, 'scheduled', null],
    ['appt-5', 'Ana Pérez', 'pet-luna', 1, 10, 0, 60, 'scheduled', null],
    ['appt-6', 'Carlos Ruiz', 'pet-toby', 1, 11, 30, 90, 'confirmed', null],
    ['appt-7', 'Marcela Gómez', 'pet-michi', 2, 9, 0, 60, 'scheduled', null],
  ] as const;

  for (const [
    id,
    owner,
    petId,
    offset,
    hour,
    minute,
    duration,
    status,
    notes,
  ] of appointmentsSeed) {
    const startsAt = at(offset, hour, minute);
    const endsAt = new Date(Date.parse(startsAt) + duration * 60_000).toISOString();
    await client.execute({
      sql: `INSERT INTO appointments
              (id, business_id, client_id, pet_id, starts_at, ends_at, status, notes, created_by)
            VALUES (?, 'keyko', ?, ?, ?, ?, ?, ?, 'user-demo-owner')`,
      args: [id, clientIdOf(owner), petId, startsAt, endsAt, status, notes],
    });
  }

  // --- Ventas de ejemplo ---------------------------------------------------
  type SeedLine = {
    type: 'service' | 'product';
    name: string;
    petId?: string;
    productId?: string;
    qty: number;
    unit: number;
    notes?: string;
  };

  async function seedSale(options: {
    id: string;
    clientId: number;
    appointmentId?: string;
    offset: number;
    hour: number;
    items: SeedLine[];
    discount?: number;
    payments: Array<{ method: string; amount: number }>;
    notes?: string;
  }) {
    const createdAt = isoToSqlite(
      localToUtc(
        `${dayOffset(options.offset)}T${String(options.hour).padStart(2, '0')}:00`,
      ),
    );
    const subtotal = options.items.reduce(
      (total, item) => total + item.qty * item.unit,
      0,
    );
    const discount = options.discount ?? 0;
    const total = subtotal - discount;
    const paid = options.payments.reduce((sum, payment) => sum + payment.amount, 0);
    const status = paid >= total ? 'paid' : 'open';

    await client.execute({
      sql: `INSERT INTO sales
              (id, business_id, client_id, appointment_id, status, subtotal_cents,
               discount_cents, total_cents, notes, paid_at, created_by, created_at)
            VALUES (?, 'keyko', ?, ?, ?, ?, ?, ?, ?, ?, 'user-demo-owner', ?)`,
      args: [
        options.id,
        options.clientId,
        options.appointmentId ?? null,
        status,
        subtotal,
        discount,
        total,
        options.notes ?? null,
        status === 'paid' ? createdAt : null,
        createdAt,
      ],
    });

    for (const [index, item] of options.items.entries()) {
      await client.execute({
        sql: `INSERT INTO sale_items
                (id, business_id, sale_id, item_type, item_id, name, pet_id,
                 qty, unit_price_cents, discount_cents, total_cents, notes, created_at)
              VALUES (?, 'keyko', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        args: [
          `${options.id}-item-${index}`,
          options.id,
          item.type,
          item.productId ?? null,
          item.name,
          item.petId ?? null,
          item.qty,
          item.unit,
          item.qty * item.unit,
          item.notes ?? null,
          createdAt,
        ],
      });

      if (item.productId) {
        await client.execute({
          sql: `UPDATE products SET stock = stock - ? WHERE id = ?`,
          args: [item.qty, item.productId],
        });
        await client.execute({
          sql: `INSERT INTO stock_movements
                  (id, business_id, product_id, delta, reason, ref_type, ref_id, created_at)
                VALUES (?, 'keyko', ?, ?, ?, 'sale', ?, ?)`,
          args: [
            `mv-${options.id}-${index}`,
            item.productId,
            -item.qty,
            `Venta ${options.id}`,
            options.id,
            createdAt,
          ],
        });
      }
    }

    for (const [index, payment] of options.payments.entries()) {
      await client.execute({
        sql: `INSERT INTO payments
                (id, business_id, sale_id, method, amount_cents, reference, paid_at)
              VALUES (?, 'keyko', ?, ?, ?, NULL, ?)`,
        args: [
          `${options.id}-pay-${index}`,
          options.id,
          payment.method,
          payment.amount,
          createdAt,
        ],
      });
    }
  }

  await seedSale({
    id: 'sale-1',
    clientId: clientIdOf('Ana Pérez'),
    appointmentId: 'appt-1',
    offset: -2,
    hour: 16,
    items: [
      {
        type: 'service',
        name: 'Baño y peluquería',
        petId: 'pet-luna',
        qty: 1,
        unit: 5_500_000,
        notes: 'Con perfume, sin secadora fuerte',
      },
      {
        type: 'service',
        name: 'Corte de uñas',
        petId: 'pet-luna',
        qty: 1,
        unit: 1_000_000,
      },
    ],
    payments: [{ method: 'cash', amount: 6_500_000 }],
  });

  await seedSale({
    id: 'sale-2',
    clientId: clientIdOf('Ana Pérez'),
    offset: -1,
    hour: 17,
    items: [
      {
        type: 'service',
        name: 'Baño medicado',
        petId: 'pet-luna',
        qty: 1,
        unit: 6_000_000,
      },
      {
        type: 'product',
        name: 'Shampoo hipoalergénico',
        productId: 'prod-shampoo',
        qty: 1,
        unit: 3_200_000,
        petId: 'pet-luna',
      },
    ],
    discount: 200_000,
    payments: [{ method: 'nequi', amount: 9_000_000 }],
  });

  await seedSale({
    id: 'sale-3',
    clientId: clientIdOf('Carlos Ruiz'),
    appointmentId: 'appt-2',
    offset: 0,
    hour: 12,
    items: [
      {
        type: 'service',
        name: 'Corte completo',
        petId: 'pet-toby',
        qty: 1,
        unit: 8_000_000,
        notes: 'Queda pendiente el saldo',
      },
    ],
    payments: [{ method: 'cash', amount: 3_000_000 }],
  });

  await seedSale({
    id: 'sale-4',
    clientId: clientIdOf('Marcela Gómez'),
    offset: -3,
    hour: 11,
    items: [
      {
        type: 'product',
        name: 'Snacks dentales',
        productId: 'prod-snacks',
        qty: 2,
        unit: 1_200_000,
      },
    ],
    payments: [{ method: 'card', amount: 2_400_000 }],
  });

  // Bandeja: un contacto llega como BSUID (igual que producción) y se vincula
  // al cliente por contact_phone. El otro todavía no tiene ficha.
  const messagesSeed = [
    ['wamid.demo.1', 'CO.DEMO0000000001', '573001112233', 'Ana', 'inbound',
      'Hola, ¿tienen cita para baño el sábado?', at(0, 8, 10)],
    ['wamid.demo.2', 'CO.DEMO0000000001', '573001112233', 'Ana', 'outbound',
      'Hola Ana, sí. Te reservo a las 10:00.', at(0, 8, 14)],
    ['wamid.demo.3', 'CO.DEMO0000000001', '573001112233', 'Ana', 'inbound',
      'Perfecto, gracias 🙌', at(0, 8, 20)],
    ['wamid.demo.4', 'CO.9988776655443322', '573209998877', 'Nuevo', 'inbound',
      'Buenas, ¿cuánto cuesta el corte completo?', at(0, 9, 5)],
    ['wamid.demo.5', 'CO.9988776655443322', '573209998877', 'Nuevo', 'outbound',
      'Hola, el corte completo cuesta $80.000.', at(0, 9, 12)],
    // Conversación ficticia para la demo de extracción con IA.
    ['wamid.ai.1', 'CO.1111222233334444', '573155550001', 'Sofía', 'inbound',
      'Hola, me llamo Sofía Ramírez y tengo una perrita llamada Nala, es una french poodle de 4 kg.',
      at(0, 10, 5)],
    ['wamid.ai.2', 'CO.1111222233334444', '573155550001', 'Sofía', 'inbound',
      'Quisiera agendar baño y corte para el sábado a las 10 de la mañana. ¿Tienen cupo?',
      at(0, 10, 6)],
    // Cliente existente que menciona otra mascota.
    ['wamid.ai.3', 'CO.DEMO0000000001', '573001112233', 'Ana', 'inbound',
      'Hola, quiero agendar un baño para mi gato Tom, es siamés y pesa 5 kg.',
      at(0, 10, 20)],
  ] as const;

  for (const [id, contact, phone, name, direction, body, stamp] of messagesSeed) {
    await client.execute({
      sql: `INSERT INTO whatsapp_messages
              (message_id, business_id, direction, contact_key, contact_phone,
               contact_name, message_type, body, message_timestamp, raw_message_json)
            VALUES (?, 'keyko', ?, ?, ?, ?, 'text', ?, ?, '{}')`,
      args: [id, direction, contact, phone, name, body, stamp],
    });
  }

  const db = createDb(client);
  const storage = createMemoryStorage();
  const app = createApp({ getDb: () => db, getStorage: () => storage });

  const env: AppEnv['Bindings'] = {
    TURSO_DATABASE_URL: `file:${file}`,
    TURSO_AUTH_TOKEN: 'local',
    JWT_SECRET,
    ALLOWED_ORIGINS: 'http://localhost:5173',
    AI_ENABLED: process.env.AI_ENABLED ?? 'true',
    AI_PROVIDER: process.env.AI_PROVIDER ?? 'fake',
    AI_AUTO_APPLY: 'false',
    AI_DAILY_BUDGET_USD_MICROS: '100000',
    AI_MONTHLY_BUDGET_USD_MICROS: '5000000',
    AI_STORE_RAW_RESPONSE: 'false',
    ...(process.env.AI_MODEL ? { AI_MODEL: process.env.AI_MODEL } : {}),
    ...(process.env.AI_API_KEY ? { AI_API_KEY: process.env.AI_API_KEY } : {}),
  };

  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const request = new Request(`http://127.0.0.1:${PORT}${req.url ?? '/'}`, {
      method: req.method ?? 'GET',
      headers: req.headers as Record<string, string>,
      ...(body && req.method !== 'GET' && req.method !== 'HEAD'
        ? { body }
        : {}),
    });

    const response = await app.fetch(request, env);
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    res.writeHead(response.status, headers);
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`API demo en http://127.0.0.1:${PORT}`);
    console.log(`Usuario: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
    console.log('Base temporal:', file);
    console.log('Producción intacta: esta demo no usa TURSO_DATABASE_URL.');
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
