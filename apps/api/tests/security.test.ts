import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALLOWED_ORIGIN,
  PASSWORD,
  call,
  makeHarness,
  request,
  type ApiResponse,
  type Harness,
} from './helpers';

let h: Harness;

beforeAll(async () => {
  h = await makeHarness();
});

afterAll(() => h.close());

function login(
  email: string,
  password: string,
  ip?: string,
): Promise<ApiResponse> {
  return request(h, {
    method: 'POST',
    path: '/auth/login',
    payload: { email, password },
    ...(ip ? { headers: { 'cf-connecting-ip': ip } } : {}),
  });
}

describe('CORS', () => {
  it('responde el preflight solo al origen permitido', async () => {
    const ok = await request(h, {
      method: 'OPTIONS',
      path: '/clients',
      headers: {
        origin: ALLOWED_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers':
          'authorization,content-type,idempotency-key',
      },
    });

    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(ok.headers.get('access-control-allow-methods')).toContain('PATCH');
    expect(ok.headers.get('access-control-allow-headers')).toContain(
      'Authorization',
    );
    expect(ok.headers.get('access-control-allow-headers')).toContain(
      'Idempotency-Key',
    );
    expect(ok.headers.get('vary')).toContain('Origin');
  });

  it('no entrega cabeceras CORS a un origen desconocido', async () => {
    const res = await request(h, {
      method: 'OPTIONS',
      path: '/clients',
      headers: {
        origin: 'https://sitio-malicioso.test',
        'access-control-request-method': 'POST',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('la respuesta normal también lleva el origen permitido', async () => {
    const res = await request(h, {
      method: 'GET',
      path: '/clients',
      token: h.tokens.a,
      headers: { origin: ALLOWED_ORIGIN },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED_ORIGIN);
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('una petición sin Origin funciona igual (curl, server-to-server)', async () => {
    const res = await call(h, h.tokens.a, 'GET', '/clients');
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('límite de intentos de login', () => {
  it('cuenta los fallos y bloquea el sexto intento', async () => {
    const email = 'owner@alfa.test';

    for (let i = 0; i < 5; i += 1) {
      const attempt = await login(email, 'ClaveEquivocada1!');
      expect(attempt.status).toBe(401);
    }

    const blocked = await login(email, 'ClaveEquivocada1!');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('rate_limited');

    const retryAfter = Number(blocked.headers.get('retry-after'));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(900);
  });

  it('bloquea aunque la contraseña sea correcta', async () => {
    // El chequeo va antes de verificar: no se regala fuerza de cómputo.
    const res = await login('owner@alfa.test', PASSWORD);
    expect(res.status).toBe(429);
  });

  it('el bloqueo es por email: otra cuenta entra sin problema', async () => {
    const res = await login('owner@beta.test', PASSWORD);
    expect(res.status).toBe(200);
  });

  it('un login correcto limpia los fallos acumulados', async () => {
    const email = 'groomer@beta.test';

    for (let i = 0; i < 4; i += 1) {
      expect((await login(email, 'MalaClave123!')).status).toBe(401);
    }

    expect((await login(email, PASSWORD)).status).toBe(200);

    for (let i = 0; i < 4; i += 1) {
      expect((await login(email, 'MalaClave123!')).status).toBe(401);
    }

    // Si no se hubieran limpiado, aquí habría 8 fallos y estaría bloqueado.
    expect((await login(email, PASSWORD)).status).toBe(200);
  });

  it('limita también por IP, aunque cambie el email', async () => {
    const ip = '203.0.113.7';

    for (let i = 0; i < 20; i += 1) {
      const res = await login(`nadie${i}@alfa.test`, 'MalaClave123!', ip);
      expect(res.status).toBe(401);
    }

    const blocked = await login('otro@alfa.test', 'MalaClave123!', ip);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();

    // Otra IP no está afectada.
    const other = await login('otro@alfa.test', 'MalaClave123!', '198.51.100.9');
    expect(other.status).toBe(401);
  });

  it('no gasta PBKDF2 cuando el email no existe (mismo mensaje)', async () => {
    const started = Date.now();
    const res = await login('fantasma@alfa.test', 'MalaClave123!');
    const elapsed = Date.now() - started;

    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Credenciales inválidas');
    // Verifica el hash de relleno; si se saltara, sería casi instantáneo.
    expect(elapsed).toBeGreaterThan(5);
  });
});
