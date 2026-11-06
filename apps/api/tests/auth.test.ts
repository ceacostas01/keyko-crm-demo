import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signToken } from '../src/lib/jwt';
import { hashPassword, verifyPassword } from '../src/lib/password';
import { JWT_SECRET, PASSWORD, call, makeHarness, type Harness } from './helpers';

let h: Harness;

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(() => h.close());

describe('autenticación', () => {
  it('login correcto devuelve token y negocio', async () => {
    const res = await call(h, null, 'POST', '/auth/login', {
      email: 'owner@alfa.test',
      password: PASSWORD,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.business.id).toBe('biz-alfa');
    expect(res.body.role).toBe('owner');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('rechaza contraseña incorrecta', async () => {
    const res = await call(h, null, 'POST', '/auth/login', {
      email: 'owner@alfa.test',
      password: 'ClaveEquivocada1!',
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('unauthorized');
  });

  it('rechaza email inexistente con el mismo mensaje', async () => {
    const res = await call(h, null, 'POST', '/auth/login', {
      email: 'nadie@alfa.test',
      password: PASSWORD,
    });
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Credenciales inválidas');
  });

  it('rechaza peticiones sin token', async () => {
    const res = await call(h, null, 'GET', '/clients');
    expect(res.status).toBe(401);
  });

  it('rechaza tokens firmados con otro secreto', async () => {
    const forged = await signToken('otro-secreto', {
      sub: 'user-alfa-owner',
      bid: 'biz-alfa',
      role: 'owner',
    });
    const res = await call(h, forged, 'GET', '/clients');
    expect(res.status).toBe(401);
  });

  it('/auth/me devuelve la identidad del token', async () => {
    const res = await call(h, h.tokens.b, 'GET', '/auth/me');
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('user-beta-owner');
    expect(res.body.business.id).toBe('biz-beta');
  });
});

describe('hash de contraseñas', () => {
  it('usa PBKDF2 con sal aleatoria y verifica correctamente', async () => {
    const one = await hashPassword('Secreta123!');
    const two = await hashPassword('Secreta123!');

    expect(one).toMatch(/^pbkdf2\$\d+\$/);
    expect(one).not.toBe(two);
    expect(await verifyPassword('Secreta123!', one)).toBe(true);
    expect(await verifyPassword('Otra123!', one)).toBe(false);
  });

  it('no acepta hashes con formato inválido', async () => {
    expect(await verifyPassword('x', 'texto-plano')).toBe(false);
    expect(await verifyPassword('x', 'pbkdf2$0$aa$bb')).toBe(false);
  });

  it('el token no expone el hash de la contraseña', async () => {
    const res = await call(h, h.tokens.a, 'GET', '/auth/me');
    expect(JSON.stringify(res.body)).not.toContain('pbkdf2');
  });
});

describe('autorización', () => {
  it('no hay matriz de roles: un solo administrador por negocio', async () => {
    // El negocio tiene hoy una única persona. `memberships` acepta varias
    // para el futuro, pero ninguna ruta evalúa el rol.
    const write = await call(h, h.tokens.groomerB, 'POST', '/services', {
      name: 'Servicio creado por miembro',
      priceCents: 1000000,
    });

    expect(write.status).toBe(201);
    expect(write.body.data.businessId).toBe('biz-beta');

    const read = await call(h, h.tokens.groomerB, 'GET', '/clients');
    expect(read.status).toBe(200);
  });
});
