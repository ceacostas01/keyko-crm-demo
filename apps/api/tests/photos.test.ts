import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BIZ_A,
  call,
  createClientRow,
  download,
  makeHarness,
  upload,
  type Harness,
} from './helpers';

/**
 * Fotografías: validación real del archivo, almacenamiento fuera de Turso,
 * acceso privado con token y limpieza de objetos.
 */

let h: Harness;
let petId: string;

function png(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(16, size));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return bytes;
}

function jpeg(size = 64): Uint8Array {
  const bytes = new Uint8Array(Math.max(16, size));
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return bytes;
}

beforeAll(async () => {
  h = await makeHarness();
  const clientId = await createClientRow(h, h.tokens.a, '+573106660001', 'Dueño Foto');
  const pet = await call(h, h.tokens.a, 'POST', '/pets', {
    clientId,
    name: 'Luna',
    species: 'gato',
  });
  petId = pet.body.data.id;
});

afterAll(() => h.close());

describe('subida de fotos', () => {
  it('guarda la imagen fuera de la base y devuelve una URL firmada', async () => {
    const res = await upload(h, h.tokens.a, `/pets/${petId}/photo`, png(), 'image/png');

    expect(res.status).toBe(201);
    expect(res.body.data.photoKey).toBeTruthy();
    expect(res.body.data.photoUrl).toContain('/api/v1/photos/pets/');
    expect(res.body.data.photoMetaJson).toContain('image/png');
    expect(res.body.data.completeness.complete).toContain('photo');

    const stored = await h.client.execute({
      sql: 'SELECT photo_url, photo_key FROM pets WHERE id = ?',
      args: [petId],
    });
    expect(stored.rows[0]?.photo_url).toBeNull();
    expect(String(stored.rows[0]?.photo_key)).toContain(`pets/${petId}/`);
    // El binario no está en la base.
    expect(JSON.stringify(stored.rows[0])).not.toContain('iVBOR');
  });

  it('sirve la foto solo con un token válido', async () => {
    const pet = await call(h, h.tokens.a, 'GET', `/pets/${petId}`);
    const url = new URL(`http://x${pet.body.data.photoUrl}`);

    const ok = await download(h, `${url.pathname.replace('/api/v1', '')}${url.search}`, null);
    expect(ok.status).toBe(200);
    expect(ok.contentType).toBe('image/png');
    expect(ok.bytes.length).toBeGreaterThan(8);

    const noToken = await download(h, `/photos/pets/${petId}`, null);
    expect(noToken.status).toBe(401);

    const otherBusiness = await upload(
      h,
      h.tokens.b,
      `/pets/${petId}/photo`,
      png(),
      'image/png',
    );
    expect(otherBusiness.status).toBe(404);
  });

  it('reemplaza la foto y borra el objeto anterior', async () => {
    const before = await call(h, h.tokens.a, 'GET', `/pets/${petId}`);
    const oldKey = before.body.data.photoKey as string;
    expect(await h.storage.exists(oldKey)).toBe(true);

    const res = await upload(h, h.tokens.a, `/pets/${petId}/photo`, jpeg(), 'image/jpeg');
    expect(res.status).toBe(201);
    expect(res.body.data.photoKey).not.toBe(oldKey);

    expect(await h.storage.exists(oldKey)).toBe(false);
    expect(await h.storage.exists(res.body.data.photoKey)).toBe(true);

    const prefix = `businesses/${BIZ_A}/pets/${petId}/`;
    expect(await h.storage.list(prefix)).toHaveLength(1);
  });

  it('rechaza archivos que no son imágenes reales', async () => {
    const text = new TextEncoder().encode('esto no es una imagen');
    const res = await upload(h, h.tokens.a, `/pets/${petId}/photo`, text, 'image/png');

    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('no es una imagen');
  });

  it('rechaza si el tipo declarado no coincide con el contenido', async () => {
    const res = await upload(h, h.tokens.a, `/pets/${petId}/photo`, png(), 'image/jpeg');
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('no coincide');
  });

  it('rechaza imágenes que superan el máximo', async () => {
    const res = await upload(
      h,
      h.tokens.a,
      `/pets/${petId}/photo`,
      png(5000),
      'image/png',
    );
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('supera');
  });

  it('quitar la foto borra el objeto y baja la completitud', async () => {
    const current = await call(h, h.tokens.a, 'GET', `/pets/${petId}`);
    const key = current.body.data.photoKey as string;

    const res = await call(h, h.tokens.a, 'DELETE', `/pets/${petId}/photo`);
    expect(res.status).toBe(200);
    expect(res.body.data.photoKey).toBeNull();
    expect(res.body.data.photoUrl).toBeNull();
    expect(res.body.data.completeness.missing).toContain('photo');
    expect(await h.storage.exists(key)).toBe(false);
  });
});

describe('consistencia entre Turso y R2', () => {
  it('si falla el guardado en Turso, borra el objeto nuevo y conserva el anterior', async () => {
    const clientId = await createClientRow(
      h,
      h.tokens.a,
      '+573106660024',
      'Consistencia Foto',
    );
    const pet = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Consistente',
      species: 'perro',
    });
    const petId2 = pet.body.data.id as string;

    const first = await upload(
      h,
      h.tokens.a,
      `/pets/${petId2}/photo`,
      png(),
      'image/png',
    );
    const oldKey = first.body.data.photoKey as string;

    await h.client.execute({
      sql: `CREATE TRIGGER fail_photo_update
            BEFORE UPDATE OF photo_key ON pets
            BEGIN SELECT RAISE(ABORT, 'fallo simulado'); END`,
    });

    try {
      const res = await upload(
        h,
        h.tokens.a,
        `/pets/${petId2}/photo`,
        jpeg(),
        'image/jpeg',
      );
      expect(res.status).toBeGreaterThanOrEqual(500);

      expect(await h.storage.exists(oldKey)).toBe(true);
      expect(
        await h.storage.list(`businesses/${BIZ_A}/pets/${petId2}/`),
      ).toEqual([oldKey]);
    } finally {
      await h.client.execute('DROP TRIGGER IF EXISTS fail_photo_update');
    }
  });
});

describe('compatibilidad y limpieza', () => {
  it('mantiene las fotos antiguas por URL', async () => {
    const res = await call(h, h.tokens.a, 'PATCH', `/pets/${petId}`, {
      photoUrl: 'https://cdn.example.com/legacy.jpg',
    });

    expect(res.body.data.photoUrl).toBe('https://cdn.example.com/legacy.jpg');
    expect(res.body.data.completeness.complete).toContain('photo');
  });

  it('borra objetos huérfanos solo del negocio autenticado', async () => {
    await h.storage.put(`businesses/${BIZ_A}/pets/${petId}/huerfano.jpg`, png(), 'image/png');
    await h.storage.put('businesses/biz-beta/pets/x/huerfano.jpg', png(), 'image/png');

    const res = await call(h, h.tokens.a, 'POST', '/photos/cleanup');
    expect(res.status).toBe(200);
    expect(res.body.data.removed).toBeGreaterThanOrEqual(1);

    expect(
      await h.storage.exists(`businesses/${BIZ_A}/pets/${petId}/huerfano.jpg`),
    ).toBe(false);
    expect(
      await h.storage.exists('businesses/biz-beta/pets/x/huerfano.jpg'),
    ).toBe(true);
  });
});

describe('ciclo de vida de la foto', () => {
  it('desactivar la mascota conserva la foto', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573106660020', 'Ciclo Foto');
    const pet = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Temporal',
      species: 'perro',
    });
    const petId2 = pet.body.data.id as string;

    const uploaded = await upload(
      h,
      h.tokens.a,
      `/pets/${petId2}/photo`,
      png(),
      'image/png',
    );
    const key = uploaded.body.data.photoKey as string;
    const photoUrl = new URL(`http://x${uploaded.body.data.photoUrl}`);

    const removed = await call(h, h.tokens.a, 'DELETE', `/pets/${petId2}`);
    expect(removed.status).toBe(200);

    // La foto sigue sirviéndose mientras la mascota está desactivada.
    const stillServed = await download(
      h,
      `${photoUrl.pathname.replace('/api/v1', '')}${photoUrl.search}`,
      null,
    );
    expect(stillServed.status).toBe(200);

    const row = await h.client.execute({
      sql: 'SELECT deleted_at, photo_key FROM pets WHERE id = ?',
      args: [petId2],
    });
    expect(row.rows[0]?.deleted_at).toBeTruthy();
    expect(row.rows[0]?.photo_key).toBe(key);
    expect(await h.storage.exists(key)).toBe(true);

    // La limpieza de huérfanos tampoco borra fotos de mascotas desactivadas.
    const cleanup = await call(h, h.tokens.a, 'POST', '/photos/cleanup');
    expect(cleanup.status).toBe(200);
    expect(await h.storage.exists(key)).toBe(true);
  });

  it('la eliminación definitiva exige desactivar primero', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573106660021', 'Purga Activa');
    const pet = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Activa',
      species: 'gato',
    });

    const res = await call(
      h,
      h.tokens.a,
      'DELETE',
      `/pets/${pet.body.data.id}/permanent`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('pet_active');
  });

  it('elimina definitivamente sin historial y borra la foto', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573106660022', 'Purga Libre');
    const pet = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Sin Historia',
      species: 'gato',
    });
    const petId2 = pet.body.data.id as string;

    const uploaded = await upload(
      h,
      h.tokens.a,
      `/pets/${petId2}/photo`,
      png(),
      'image/png',
    );
    const key = uploaded.body.data.photoKey as string;

    await call(h, h.tokens.a, 'DELETE', `/pets/${petId2}`);

    const res = await call(
      h,
      h.tokens.a,
      'DELETE',
      `/pets/${petId2}/permanent`,
    );

    expect(res.status).toBe(200);
    expect(res.body.data.permanent).toBe(true);

    const row = await h.client.execute({
      sql: 'SELECT COUNT(*) AS n FROM pets WHERE id = ?',
      args: [petId2],
    });
    expect(Number(row.rows[0]?.n)).toBe(0);
    expect(await h.storage.exists(key)).toBe(false);
  });

  it('no elimina definitivamente una mascota con historial', async () => {
    const clientId = await createClientRow(h, h.tokens.a, '+573106660023', 'Purga Historia');
    const pet = await call(h, h.tokens.a, 'POST', '/pets', {
      clientId,
      name: 'Con Cita',
      species: 'perro',
    });
    const petId2 = pet.body.data.id as string;

    await call(h, h.tokens.a, 'POST', '/appointments', {
      petId: petId2,
      startsAt: '2026-11-02T09:00',
      durationMin: 60,
    });
    await call(h, h.tokens.a, 'DELETE', `/pets/${petId2}`);

    const res = await call(
      h,
      h.tokens.a,
      'DELETE',
      `/pets/${petId2}/permanent`,
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('pet_has_history');
  });
});
