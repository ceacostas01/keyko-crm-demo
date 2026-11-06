import type { Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import * as schema from './schema';

export function createDb(client: Client) {
  return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
