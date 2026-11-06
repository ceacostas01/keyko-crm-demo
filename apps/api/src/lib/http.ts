import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { badRequest, unprocessable } from './errors';

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw badRequest('JSON inválido');
  }
}

/** Para endpoints donde el cuerpo es opcional (por ejemplo, anular). */
export async function readJsonOrEmpty(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('JSON inválido');
  }
}

export function parse<T>(schema: ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw unprocessable(
      'Datos inválidos',
      result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

export function parseId(raw: string | undefined): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Identificador inválido');
  return id;
}
