import type { Client } from '@libsql/client';

/**
 * Seguimiento de migraciones.
 *
 * Las migraciones SQL siguen siendo la fuente de verdad: este módulo no
 * genera esquema, solo aplica archivos y registra lo aplicado para que
 * reaplicar sea seguro y para detectar archivos editados después de usarse.
 *
 * Sin imports de Node para que el paquete siga siendo seguro de importar
 * desde el Worker. El CLI calcula los checksums y pasa el contenido ya leído.
 */

export type MigrationFile = {
  version: string;
  name: string;
  /** sha256 hex del contenido exacto del archivo. */
  checksum: string;
  sql: string;
};

export type AppliedMigration = {
  version: string;
  name: string;
  checksum: string;
  applied_at: string;
  baselined: number;
};

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

const CREATE_TRACKING_TABLE = `
CREATE TABLE IF NOT EXISTS schema_migrations (
    version    TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    baselined  INTEGER NOT NULL DEFAULT 0
)`;

export async function ensureTrackingTable(client: Client): Promise<void> {
  await client.executeMultiple(CREATE_TRACKING_TABLE);
}

async function trackingTableExists(client: Client): Promise<boolean> {
  const rs = await client.execute(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'schema_migrations'`,
  );
  return rs.rows.length > 0;
}

/**
 * Solo lectura: si la base nunca se migró con este runner, devuelve una lista
 * vacía en vez de crear la tabla. Así `status` se puede consultar contra
 * producción sin escribir nada.
 */
export async function appliedMigrations(
  client: Client,
): Promise<AppliedMigration[]> {
  if (!(await trackingTableExists(client))) return [];

  const rs = await client.execute(
    `SELECT version, name, checksum, applied_at, baselined
       FROM schema_migrations
      ORDER BY version ASC`,
  );
  return rs.rows.map((row) => ({
    version: String(row.version),
    name: String(row.name),
    checksum: String(row.checksum),
    applied_at: String(row.applied_at),
    baselined: Number(row.baselined),
  }));
}

export type MigrationStatus = {
  applied: AppliedMigration[];
  pending: MigrationFile[];
  /** Registradas en la base pero sin archivo: alguien borró o renombró. */
  missing: string[];
  /** El archivo cambió después de aplicarse. */
  modified: string[];
  /** Pendientes con versión anterior a una ya aplicada. */
  outOfOrder: string[];
};

export async function migrationStatus(
  client: Client,
  files: readonly MigrationFile[],
): Promise<MigrationStatus> {
  const applied = await appliedMigrations(client);
  const byVersion = new Map(files.map((file) => [file.version, file]));
  const appliedVersions = new Set(applied.map((row) => row.version));

  const missing: string[] = [];
  const modified: string[] = [];

  for (const row of applied) {
    const file = byVersion.get(row.version);
    if (!file) {
      missing.push(row.version);
      continue;
    }
    if (file.checksum !== row.checksum) modified.push(row.version);
  }

  const pending = files.filter((file) => !appliedVersions.has(file.version));
  const lastApplied = applied.at(-1)?.version ?? '';
  const outOfOrder = pending
    .filter((file) => file.version < lastApplied)
    .map((file) => file.version);

  return { applied, pending, missing, modified, outOfOrder };
}

/** Lanza si el historial local y el registrado en la base no cuadran. */
export function assertConsistent(status: MigrationStatus): void {
  const problems: string[] = [];

  if (status.missing.length > 0) {
    problems.push(
      `migraciones registradas sin archivo: ${status.missing.join(', ')}`,
    );
  }

  if (status.modified.length > 0) {
    problems.push(
      `migraciones modificadas después de aplicarse: ${status.modified.join(', ')}`,
    );
  }

  if (status.outOfOrder.length > 0) {
    problems.push(
      `migraciones pendientes anteriores a una ya aplicada: ${status.outOfOrder.join(', ')}`,
    );
  }

  if (problems.length > 0) {
    throw new MigrationError(
      `Historial inconsistente.\n  - ${problems.join('\n  - ')}\n` +
        'No se aplicó nada. Corrige el historial antes de continuar.',
    );
  }
}

async function record(
  client: Client,
  file: MigrationFile,
  baselined: boolean,
): Promise<void> {
  await client.execute({
    sql: `INSERT INTO schema_migrations (version, name, checksum, baselined)
          VALUES (?, ?, ?, ?)`,
    args: [file.version, file.name, file.checksum, baselined ? 1 : 0],
  });
}

/**
 * Marca como aplicadas las migraciones de una base que ya tiene el esquema
 * pero no el historial (el caso de producción al adoptar este mecanismo).
 * No ejecuta SQL: solo escribe el registro.
 */
export async function baseline(
  client: Client,
  files: readonly MigrationFile[],
  throughVersion: string,
): Promise<string[]> {
  await ensureTrackingTable(client);
  const applied = new Set(
    (await appliedMigrations(client)).map((row) => row.version),
  );

  const toMark = files
    .filter((file) => file.version <= throughVersion)
    .filter((file) => !applied.has(file.version));

  for (const file of toMark) await record(client, file, true);
  return toMark.map((file) => file.version);
}

/**
 * Aplica en orden las migraciones pendientes. Cada archivo se ejecuta en su
 * propia transacción junto con su registro: o queda aplicada y registrada,
 * o no queda nada.
 */
export async function applyMigrations(
  client: Client,
  files: readonly MigrationFile[],
): Promise<string[]> {
  await ensureTrackingTable(client);

  const status = await migrationStatus(client, files);
  assertConsistent(status);

  const applied: string[] = [];

  for (const file of status.pending) {
    const tx = await client.transaction('write');
    try {
      await tx.executeMultiple(file.sql);
      await tx.execute({
        sql: `INSERT INTO schema_migrations (version, name, checksum, baselined)
              VALUES (?, ?, ?, 0)`,
        args: [file.version, file.name, file.checksum],
      });
      await tx.commit();
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // La transacción ya pudo haberse cerrado por el propio error.
      }
      throw new MigrationError(
        `Falló la migración ${file.version}_${file.name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    applied.push(file.version);
  }

  return applied;
}
