import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { pets } from '@keyko/db';
import type { AppEnv } from '../env';
import { notFound, unauthorized } from '../lib/errors';
import { verifyPhotoToken } from '../lib/jwt';
import { businessPhotoPrefix, requirePhotoStorage } from '../lib/photos';
import { requireAuth } from '../middleware/auth';

/**
 * Fotos privadas.
 *
 * No llevan Bearer porque las consume un <img>. Se usa un token corto con el
 * negocio dentro; el objeto solo se entrega si pertenece a ese negocio.
 */
export const photoRoutes = new Hono<AppEnv>();

photoRoutes.get('/pets/:id', async (c) => {
  requirePhotoStorage(c.env);
  const token = c.req.query('token');
  if (!token) throw unauthorized('Enlace de foto requerido');

  const { bid } = await verifyPhotoToken(c.env.JWT_SECRET, token);
  const db = c.get('db');

  const [pet] = await db
    .select({ id: pets.id, photoKey: pets.photoKey })
    .from(pets)
    .where(
      and(eq(pets.id, c.req.param('id')), eq(pets.businessId, bid)),
    )
    .limit(1);

  if (!pet?.photoKey) throw notFound('Foto no encontrada');

  const object = await c.get('storage').get(pet.photoKey);
  if (!object) throw notFound('Foto no encontrada');

  return new Response(object.bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      'content-type': object.contentType,
      'cache-control': 'private, max-age=300',
      'x-content-type-options': 'nosniff',
    },
  });
});

/**
 * Borra objetos del negocio que ya no están referenciados por ninguna
 * mascota. Solo toca el prefijo del negocio autenticado.
 */
photoRoutes.post('/cleanup', requireAuth, async (c) => {
  requirePhotoStorage(c.env);
  const { businessId } = c.get('auth');
  const db = c.get('db');
  const storage = c.get('storage');

  const rows = await db
    .select({ photoKey: pets.photoKey })
    .from(pets)
    .where(eq(pets.businessId, businessId));

  const referenced = new Set(
    rows.map((row) => row.photoKey).filter((key): key is string => Boolean(key)),
  );

  const keys = await storage.list(businessPhotoPrefix(businessId));
  const orphans = keys.filter((key) => !referenced.has(key));

  for (const key of orphans) {
    await storage.delete(key);
  }

  return c.json({ data: { removed: orphans.length, scanned: keys.length } });
});
