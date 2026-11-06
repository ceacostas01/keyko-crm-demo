export * from './timezone';
export * from './phone';
export * from './money';
export * from './completeness';
export * from './expenses';

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Marca de tiempo en el mismo formato que CURRENT_TIMESTAMP de SQLite
 * ('YYYY-MM-DD HH:MM:SS' en UTC). Evita mezclar formatos en columnas que
 * el frontend ordena como texto.
 */
export function nowSqlite(date: Date = new Date()): string {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * Igual que `nowSqlite` pero con milisegundos. Se usa donde el orden entre
 * dos registros del mismo segundo importa (ventas, por ejemplo: dos cobros
 * seguidos deben quedar en orden).
 */
export function nowSqliteMs(date: Date = new Date()): string {
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

export type Role = 'owner' | 'admin' | 'groomer' | 'receptionist';

/**
 * Un negocio tiene hoy un único administrador: no hay matriz de permisos.
 * El rol se conserva como dato porque `memberships` ya soporta varias
 * personas por negocio y no queremos migrar el esquema para añadirlas.
 */
