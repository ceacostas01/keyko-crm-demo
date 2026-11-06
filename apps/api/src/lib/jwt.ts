import type { Role } from '@keyko/domain';
import { jwtVerify, SignJWT } from 'jose';
import { unauthorized } from './errors';

const ALG = 'HS256';
const ISSUER = 'keyko-crm';
const TTL = '12h';

export type TokenPayload = {
  sub: string;
  bid: string;
  role: Role;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signToken(
  secret: string,
  payload: TokenPayload,
): Promise<string> {
  return new SignJWT({ bid: payload.bid, role: payload.role })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(secretKey(secret));
}

/** Token corto para servir una foto privada desde un <img>. */
export async function signPhotoToken(
  secret: string,
  businessId: string,
  ttlSeconds = 900,
): Promise<string> {
  return new SignJWT({ bid: businessId })
    .setProtectedHeader({ alg: ALG })
    .setIssuer(ISSUER)
    .setAudience('photo')
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

export async function verifyPhotoToken(
  secret: string,
  token: string,
): Promise<{ bid: string }> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: [ALG],
      issuer: ISSUER,
      audience: 'photo',
    });
    if (typeof payload.bid !== 'string') throw new Error('sin negocio');
    return { bid: payload.bid };
  } catch {
    throw unauthorized('Enlace de foto inválido o expirado');
  }
}

export async function verifyToken(
  secret: string,
  token: string,
): Promise<TokenPayload> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      algorithms: [ALG],
      issuer: ISSUER,
    });
    const bid = payload.bid;
    const role = payload.role;
    const sub = payload.sub;
    if (typeof bid !== 'string' || typeof sub !== 'string' || typeof role !== 'string') {
      throw new Error('payload incompleto');
    }
    return { sub, bid, role: role as Role };
  } catch {
    throw unauthorized('Token inválido o expirado');
  }
}
