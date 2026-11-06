/**
 * CLI de migraciones.
 *
 *   pnpm db:status                 # qué está aplicado y qué falta
 *   pnpm db:migrate                # aplica lo pendiente
 *   pnpm db:baseline -- --through 0002   # adopta una base ya migrada
 *
 * Nunca apunta a producción por accidente: si la URL no es local hay que
 * pasar --allow-remote de forma explícita.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import {
  applyMigrations,
  assertConsistent,
  baseline,
  migrationStatus,
  type MigrationFile,
} from '../src/migrations';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '../../../migrations');

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  return files.map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
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

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function makeClient(options: { allowRemote: boolean }): Client {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      'Falta TURSO_DATABASE_URL. Ejemplo: TURSO_DATABASE_URL=file:/tmp/dev.db',
    );
  }

  const isLocal = url.startsWith('file:') || url.includes('localhost');
  if (!isLocal && !options.allowRemote) {
    throw new Error(
      `Destino remoto detectado (${new URL(url.replace(/^libsql:/, 'https:')).host}).\n` +
        'Revisa TURSO_DATABASE_URL y repite con --allow-remote si es intencional.',
    );
  }

  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

async function main() {
  const command = process.argv[2] ?? 'up';
  // `status` es de solo lectura: se puede consultar producción sin riesgo.
  // `up` y `baseline` escriben y exigen --allow-remote.
  const client = makeClient({
    allowRemote: command === 'status' || process.argv.includes('--allow-remote'),
  });
  const files = loadMigrations();

  try {
    if (command === 'status') {
      const status = await migrationStatus(client, files);
      console.log(`Aplicadas: ${status.applied.length}`);
      for (const row of status.applied) {
        const mark = row.baselined ? ' (baseline)' : '';
        console.log(`  ✓ ${row.version}_${row.name} — ${row.applied_at}${mark}`);
      }
      console.log(`Pendientes: ${status.pending.length}`);
      for (const file of status.pending) {
        console.log(`  · ${file.version}_${file.name}`);
      }
      if (status.missing.length || status.modified.length || status.outOfOrder.length) {
        console.log('Problemas:');
        if (status.missing.length) console.log(`  ✗ sin archivo: ${status.missing.join(', ')}`);
        if (status.modified.length) console.log(`  ✗ modificadas: ${status.modified.join(', ')}`);
        if (status.outOfOrder.length) console.log(`  ✗ fuera de orden: ${status.outOfOrder.join(', ')}`);
        process.exitCode = 1;
      }
      return;
    }

    if (command === 'baseline') {
      const through = arg('through');
      if (!through) throw new Error('Uso: baseline --through 0002');
      const marked = await baseline(client, files, through);
      console.log(
        marked.length === 0
          ? 'Nada que marcar.'
          : `Marcadas como aplicadas sin ejecutar: ${marked.join(', ')}`,
      );
      return;
    }

    if (command === 'up') {
      const status = await migrationStatus(client, files);
      assertConsistent(status);
      if (status.pending.length === 0) {
        console.log('Todo aplicado. Nada que hacer.');
        return;
      }
      const applied = await applyMigrations(client, files);
      for (const version of applied) console.log(`  ✓ aplicada ${version}`);
      console.log(`${applied.length} migración(es) aplicada(s).`);
      return;
    }

    throw new Error(`Comando desconocido: ${command}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
