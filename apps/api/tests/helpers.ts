import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations, createDb, type Db, type MigrationFile } from '@keyko/db';
import { createClient, type Client } from '@libsql/client';
import { createApp } from '../src/app';
import { createMemoryStorage, type StorageAdapter } from '../src/lib/storage';
import type { AppEnv } from '../src/env';
import { hashPassword } from '../src/lib/password';
import { signToken } from '../src/lib/jwt';

export const JWT_SECRET = 'test-secret-no-usar-en-produccion';
export const PASSWORD = 'ClaveSegura123!';

export const BIZ_A = 'biz-alfa';
export const BIZ_B = 'biz-beta';

export const USER_A = 'user-alfa-owner';
export const USER_B = 'user-beta-owner';
export const GROOMER_B = 'user-beta-groomer';

export const ALLOWED_ORIGIN = 'http://localhost:5173';

const MIGRATIONS_DIR = new URL('../../../migrations/', import.meta.url);

/** Lee migrations/*.sql igual que el CLI: nombre, checksum y contenido. */
export function loadMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
      const [, version = '', rest = ''] = /^(\d+)_(.+)\.sql$/.exec(name) ?? [];
      if (!version) throw new Error(`Nombre de migración inválido: ${name}`);
      return {
        version,
        name: rest,
        checksum: createHash('sha256').update(sql).digest('hex'),
        sql,
      };
    });
}

export function tempDbPath(): string {
  return join(tmpdir(), `keyko-test-${randomUUID()}.db`);
}

export async function migratedClient(): Promise<Client> {
  const client = createClient({ url: `file:${tempDbPath()}` });
  await applyMigrations(client, loadMigrations());
  return client;
}

export type Harness = {
  app: ReturnType<typeof createApp>;
  db: Db;
  client: Client;
  tokens: { a: string; b: string; groomerB: string };
  env: AppEnv['Bindings'];
  storage: StorageAdapter;
  close: () => void;
};

export async function makeHarness(): Promise<Harness> {
  const client = await migratedClient();
  const passwordHash = await hashPassword(PASSWORD);

  const users = [
    [USER_A, 'owner@alfa.test', 'Dueño Alfa'],
    [USER_B, 'owner@beta.test', 'Dueño Beta'],
    [GROOMER_B, 'groomer@beta.test', 'Peluquero Beta'],
  ] as const;

  for (const [id, email, name] of users) {
    await client.execute({
      sql: 'INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, ?)',
      args: [id, email, name, passwordHash],
    });
  }

  const seed: Array<[string, string, string]> = [
    [BIZ_A, 'Alfa Grooming', 'alfa'],
    [BIZ_B, 'Beta Grooming', 'beta'],
  ];

  for (const [id, name, slug] of seed) {
    await client.execute({
      sql: `INSERT INTO businesses (id, name, slug, timezone, currency)
            VALUES (?, ?, ?, 'America/Bogota', 'COP')`,
      args: [id, name, slug],
    });
  }

  const memberships: Array<[string, string, string, string]> = [
    ['m-a-owner', BIZ_A, USER_A, 'owner'],
    ['m-b-owner', BIZ_B, USER_B, 'owner'],
    ['m-b-groomer', BIZ_B, GROOMER_B, 'groomer'],
  ];

  for (const [id, businessId, userId, role] of memberships) {
    await client.execute({
      sql: `INSERT INTO memberships (id, business_id, user_id, role)
            VALUES (?, ?, ?, ?)`,
      args: [id, businessId, userId, role],
    });
  }

  const db = createDb(client);
  const storage = createMemoryStorage();
  const app = createApp({ getDb: () => db, getStorage: () => storage });

  const env: AppEnv['Bindings'] = {
    TURSO_DATABASE_URL: 'file:test',
    TURSO_AUTH_TOKEN: 'test-token',
    JWT_SECRET,
    ALLOWED_ORIGINS: ALLOWED_ORIGIN,
    PHOTO_MAX_BYTES: '4096',
    PHOTO_URL_TTL_SECONDS: '900',
  };

  const tokens = {
    a: await signToken(JWT_SECRET, { sub: USER_A, bid: BIZ_A, role: 'owner' }),
    b: await signToken(JWT_SECRET, { sub: USER_B, bid: BIZ_B, role: 'owner' }),
    groomerB: await signToken(JWT_SECRET, {
      sub: GROOMER_B,
      bid: BIZ_B,
      role: 'groomer',
    }),
  };

  return { app, db, client, tokens, env, storage, close: () => client.close() };
}

export type ApiResponse<T = any> = {
  status: number;
  body: T;
  headers: Headers;
};

export async function request<T = any>(
  h: Harness,
  init: {
    method: string;
    path: string;
    token?: string | null;
    payload?: unknown;
    headers?: Record<string, string>;
  },
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...init.headers,
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  const res = await h.app.request(
    `/api/v1${init.path}`,
    {
      method: init.method,
      headers,
      ...(init.payload === undefined
        ? {}
        : { body: JSON.stringify(init.payload) }),
    },
    h.env,
  );

  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as T,
    headers: res.headers,
  };
}

export async function call<T = any>(
  h: Harness,
  token: string | null,
  method: string,
  path: string,
  payload?: unknown,
): Promise<ApiResponse<T>> {
  return request<T>(h, { method, path, token, payload });
}

/** Sube bytes binarios (fotos) sin pasar por JSON. */
export async function upload(
  h: Harness,
  token: string,
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<ApiResponse> {
  const res = await h.app.request(
    `/api/v1${path}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': contentType,
      },
      body: bytes as unknown as BodyInit,
    },
    h.env,
  );

  const text = await res.text();
  return {
    status: res.status,
    body: (text ? JSON.parse(text) : null) as never,
    headers: res.headers,
  };
}

/** Descarga binaria (foto firmada). */
export async function download(
  h: Harness,
  path: string,
  token: string | null,
): Promise<{ status: number; bytes: Uint8Array; contentType: string | null }> {
  const res = await h.app.request(
    `/api/v1${path}`,
    {
      method: 'GET',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    },
    h.env,
  );

  return {
    status: res.status,
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type'),
  };
}

export async function createClientRow(
  h: Harness,
  token: string,
  phone: string,
  fullName = 'Cliente de prueba',
): Promise<number> {
  const res = await call<{ data: { id: number } }>(h, token, 'POST', '/clients', {
    fullName,
    phone,
  });
  if (res.status !== 201) {
    throw new Error(`No se pudo crear el cliente: ${JSON.stringify(res.body)}`);
  }
  return res.body.data.id;
}
