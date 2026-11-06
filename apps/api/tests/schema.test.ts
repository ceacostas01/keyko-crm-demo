import { getTableColumns, getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '@keyko/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeHarness, type Harness } from './helpers';

type ColumnInfo = {
  name: string;
  type: string;
  pk: number;
  notnull: number;
  dflt_value: string | null;
};

let h: Harness;

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(() => h.close());

async function columns(table: string): Promise<ColumnInfo[]> {
  const rs = await h.client.execute(`PRAGMA table_info(${table})`);
  return rs.rows as unknown as ColumnInfo[];
}

describe('esquema: claves primarias heredadas de producción', () => {
  it('clients.id sigue siendo INTEGER AUTOINCREMENT', async () => {
    const id = (await columns('clients')).find((c) => c.name === 'id');
    expect(id?.type).toBe('INTEGER');
    expect(id?.pk).toBe(1);

    // AUTOINCREMENT se verifica en sqlite_master
    const rs = await h.client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='clients'",
    );
    const sql = String(rs.rows[0]?.sql ?? '');
    expect(sql).toMatch(/id\s+INTEGER PRIMARY KEY AUTOINCREMENT/i);
  });

  it('whatsapp_events.event_id sigue siendo TEXT', async () => {
    const id = (await columns('whatsapp_events')).find((c) => c.name === 'event_id');
    expect(id?.type).toBe('TEXT');
    expect(id?.pk).toBe(1);
  });

  it('whatsapp_messages.message_id sigue siendo TEXT', async () => {
    const id = (await columns('whatsapp_messages')).find(
      (c) => c.name === 'message_id',
    );
    expect(id?.type).toBe('TEXT');
    expect(id?.pk).toBe(1);
  });
});

describe('esquema: tenancy y columnas añadidas', () => {
  it('las 3 tablas heredadas tienen business_id NOT NULL con default keyko', async () => {
    for (const table of ['clients', 'whatsapp_events', 'whatsapp_messages']) {
      const col = (await columns(table)).find((c) => c.name === 'business_id');
      expect(col, table).toBeDefined();
      expect(col?.notnull, table).toBe(1);
    }

    const rs = await h.client.execute(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='whatsapp_messages'",
    );
    expect(String(rs.rows[0]?.sql ?? '')).toContain("DEFAULT 'keyko'");
  });

  it('existe el negocio keyko y su zona horaria es Bogotá', async () => {
    const rs = await h.client.execute(
      "SELECT id, timezone, currency FROM businesses WHERE id = 'keyko'",
    );
    expect(rs.rows[0]).toMatchObject({
      id: 'keyko',
      timezone: 'America/Bogota',
      currency: 'COP',
    });
  });
});

describe('esquema: Drizzle es espejo exacto de las migraciones', () => {
  const tables = Object.entries(schema)
    .filter(([, value]) => is(value, SQLiteTable))
    .map(([, value]) => value as SQLiteTable);

  it('cubre las 34 tablas de las migraciones', async () => {
    expect(tables).toHaveLength(34);

    // schema_migrations es infraestructura del runner, no una tabla de dominio.
    const rs = await h.client.execute(
      `SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name NOT LIKE 'sqlite_%'
          AND name <> 'schema_migrations'
        ORDER BY name`,
    );
    const sqlTables = rs.rows.map((r) => String(r.name)).sort();
    const drizzleTables = tables.map((t) => getTableName(t)).sort();
    expect(drizzleTables).toEqual(sqlTables);
  });

  it('cada columna coincide en nombre, tipo, nulabilidad y default', async () => {
    const problems: string[] = [];

    for (const table of tables) {
      const tableName = getTableName(table);
      const drizzleCols = Object.entries(getTableColumns(table));
      const actual = await columns(tableName);
      const byName = new Map(actual.map((c) => [c.name, c]));

      if (actual.length !== drizzleCols.length) {
        problems.push(
          `${tableName}: SQL tiene ${actual.length} columnas, Drizzle ${drizzleCols.length}`,
        );
      }

      for (const [key, col] of drizzleCols) {
        const info = byName.get(col.name);
        if (!info) {
          problems.push(`${tableName}.${col.name} (${key}) falta en SQL`);
          continue;
        }

        if (info.type.toLowerCase() !== col.getSQLType().toLowerCase()) {
          problems.push(
            `${tableName}.${col.name}: SQL=${info.type} Drizzle=${col.getSQLType()}`,
          );
        }

        if (info.pk === 0 && Boolean(info.notnull) !== col.notNull) {
          problems.push(
            `${tableName}.${col.name}: notnull SQL=${info.notnull} Drizzle=${col.notNull}`,
          );
        }

        // SQLite no reporta default en PK AUTOINCREMENT; Drizzle sí lo marca.
        if (info.pk === 0 && Boolean(info.dflt_value) !== col.hasDefault) {
          problems.push(
            `${tableName}.${col.name}: default SQL=${String(info.dflt_value)} Drizzle=${col.hasDefault}`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });
});

describe('esquema: integridad referencial', () => {
  it('foreign_key_check no reporta violaciones', async () => {
    const rs = await h.client.execute('PRAGMA foreign_key_check');
    expect(rs.rows).toHaveLength(0);
  });

  it('no se puede crear una mascota con un cliente inexistente', async () => {
    await expect(
      h.client.execute({
        sql: `INSERT INTO pets (id, business_id, client_id, name)
              VALUES (?, ?, ?, ?)`,
        args: ['pet-fantasma', 'biz-alfa', 999999, 'Fantasma'],
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('no se puede crear una cita con una mascota inexistente', async () => {
    const clientId = await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-alfa', '+573000000001', '+573000000001', 'Temporal')
            RETURNING id`,
      args: [],
    });
    const id = Number(clientId.rows[0]?.id);

    await expect(
      h.client.execute({
        sql: `INSERT INTO appointments
                (id, business_id, client_id, pet_id, starts_at, ends_at)
              VALUES (?, 'biz-alfa', ?, 'pet-inexistente', ?, ?)`,
        args: [
          'appt-fantasma',
          id,
          '2026-11-02T15:00:00.000Z',
          '2026-11-02T16:00:00.000Z',
        ],
      }),
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it('el teléfono de cliente es único por negocio, no global', async () => {
    const phone = '+573001112233';
    await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-alfa', ?, ?, 'Alfa')`,
      args: [phone, phone],
    });
    await h.client.execute({
      sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
            VALUES ('biz-beta', ?, ?, 'Beta')`,
      args: [phone, phone],
    });

    await expect(
      h.client.execute({
        sql: `INSERT INTO clients (business_id, whatsapp_contact_key, phone, full_name)
              VALUES ('biz-alfa', ?, ?, 'Duplicado')`,
        args: [phone, phone],
      }),
    ).rejects.toThrow(/UNIQUE/i);
  });
});
