import { createClient } from '@libsql/client';
import { applyMigrations, baseline, migrationStatus } from '@keyko/db';
import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, migratedClient, tempDbPath } from './helpers';

const files = loadMigrations();
const cleanup: Array<() => void> = [];

function newClient() {
  const client = createClient({ url: `file:${tempDbPath()}` });
  cleanup.push(() => client.close());
  return client;
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.();
});

describe('seguimiento de migraciones', () => {
  it('aplica todo en orden y lo registra', async () => {
    const client = newClient();
    const applied = await applyMigrations(client, files);

    expect(applied).toEqual(files.map((file) => file.version));

    const status = await migrationStatus(client, files);
    expect(status.applied).toHaveLength(files.length);
    expect(status.pending).toHaveLength(0);
    expect(status.missing).toHaveLength(0);
    expect(status.modified).toHaveLength(0);
    expect(status.outOfOrder).toHaveLength(0);

    // Checksums de 64 hex: sha256 del archivo exacto.
    for (const row of status.applied) {
      expect(row.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(row.baselined).toBe(0);
    }
  });

  it('reaplicar no hace nada', async () => {
    const client = newClient();
    await applyMigrations(client, files);

    const second = await applyMigrations(client, files);
    expect(second).toEqual([]);

    const rs = await client.execute('SELECT COUNT(*) AS n FROM schema_migrations');
    expect(Number(rs.rows[0]?.n)).toBe(files.length);
  });

  it('detecta una migración editada después de aplicarse', async () => {
    const client = newClient();
    await applyMigrations(client, files);

    const tampered = files.map((file, index) =>
      index === 0 ? { ...file, checksum: 'a'.repeat(64) } : file,
    );

    await expect(applyMigrations(client, tampered)).rejects.toThrow(
      /modificadas después de aplicarse/,
    );
  });

  it('detecta una migración registrada sin archivo', async () => {
    const client = newClient();
    await applyMigrations(client, files);

    // Alguien borró 0002 del repo: el historial ya no cuadra.
    const withoutSecond = files.filter((file) => file.version !== '0002');
    await expect(applyMigrations(client, withoutSecond)).rejects.toThrow(
      /sin archivo: 0002/,
    );
  });

  it('detecta migraciones fuera de orden', async () => {
    const client = newClient();
    await applyMigrations(client, files);

    // Simula un historial donde 0002 nunca se registró pero 0003 sí.
    await client.execute("DELETE FROM schema_migrations WHERE version = '0002'");

    await expect(applyMigrations(client, files)).rejects.toThrow(
      /anteriores a una ya aplicada/,
    );
  });

  it('una migración que falla no deja nada a medias', async () => {
    const client = newClient();

    const broken = {
      version: '9999',
      name: 'rota',
      checksum: 'b'.repeat(64),
      sql: `CREATE TABLE tabla_a_medias (id TEXT);
            ESTO_NO_ES_SQL;`,
    };

    await expect(applyMigrations(client, [...files, broken])).rejects.toThrow(
      /Falló la migración 9999_rota/,
    );

    const table = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tabla_a_medias'",
    );
    expect(table.rows).toHaveLength(0);

    const recorded = await client.execute(
      "SELECT version FROM schema_migrations WHERE version = '9999'",
    );
    expect(recorded.rows).toHaveLength(0);
  });

  it('status no escribe nada, ni siquiera la tabla de historial', async () => {
    const client = newClient();

    const status = await migrationStatus(client, files);
    expect(status.applied).toHaveLength(0);
    expect(status.pending).toHaveLength(files.length);

    // Ni tabla de seguimiento ni tablas de dominio.
    const tables = await client.execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    );
    expect(tables.rows).toHaveLength(0);
  });

  it('baseline adopta una base ya migrada sin reejecutar SQL', async () => {
    // Este es el caso de producción: el esquema existe, el historial no.
    const client = newClient();
    for (const file of files.filter((f) => f.version <= '0002')) {
      await client.executeMultiple(file.sql);
    }

    const before = await migrationStatus(client, files);
    expect(before.applied).toHaveLength(0);
    expect(before.pending).toHaveLength(files.length);

    const marked = await baseline(client, files, '0002');
    expect(marked).toEqual(['0000', '0001', '0002']);

    const afterBaseline = await migrationStatus(client, files);
    expect(afterBaseline.applied.every((row) => row.baselined === 1)).toBe(true);
    expect(afterBaseline.pending.map((f) => f.version)).toEqual([
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
    ]);

    // Y ahora sí, solo aplica lo que falta.
    const applied = await applyMigrations(client, files);
    expect(applied).toEqual([
      '0003',
      '0004',
      '0005',
      '0006',
      '0007',
      '0008',
      '0009',
      '0010',
      '0011',
      '0012',
    ]);

    const finalStatus = await migrationStatus(client, files);
    expect(finalStatus.pending).toHaveLength(0);
  });

  it('el baseline no toca tablas con datos', async () => {
    const client = newClient();
    for (const file of files.filter((f) => f.version <= '0002')) {
      await client.executeMultiple(file.sql);
    }

    await client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('keyko', '+573000000123', '+573000000123', 'Cliente real')`,
    });

    await baseline(client, files, '0002');
    await applyMigrations(client, files);

    const rs = await client.execute('SELECT full_name FROM clients');
    expect(rs.rows).toHaveLength(1);
    expect(rs.rows[0]?.full_name).toBe('Cliente real');
  });
});

describe('esquema resultante', () => {
  it('la base migrada por el runner tiene las tablas esperadas', async () => {
    const client = await migratedClient();
    cleanup.push(() => client.close());

    const rs = await client.execute(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
    );

    // 34 tablas de dominio + schema_migrations
    expect(Number(rs.rows[0]?.n)).toBe(35);
  });
});
