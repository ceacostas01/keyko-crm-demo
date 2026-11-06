/**
 * Validación de imágenes en el servidor.
 *
 * El navegador ya comprime, pero un cliente malicioso puede enviar cualquier
 * cosa. Aquí se comprueba el tipo real por los primeros bytes (no se confía en
 * el `Content-Type` declarado) y el tamaño.
 */

import { serviceUnavailable } from './errors';

export const ALLOWED_IMAGE_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type ImageType = (typeof ALLOWED_IMAGE_TYPES)[number];

export type ImageValidation =
  | { ok: true; type: ImageType; extension: 'jpg' | 'png' | 'webp' }
  | { ok: false; reason: string };

export function detectImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }

  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }

  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp';
  }

  return null;
}

export function validateImage(
  bytes: Uint8Array,
  declaredType: string | null,
  maxBytes: number,
): ImageValidation {
  if (bytes.length === 0) {
    return { ok: false, reason: 'La imagen está vacía' };
  }

  if (bytes.length > maxBytes) {
    return {
      ok: false,
      reason: `La imagen supera el máximo de ${Math.round(maxBytes / 1024)} KB`,
    };
  }

  const detected = detectImageType(bytes);
  if (!detected) {
    return {
      ok: false,
      reason: 'El archivo no es una imagen JPEG, PNG o WebP válida',
    };
  }

  const declared = (declaredType ?? '').split(';')[0]?.trim().toLowerCase();
  if (declared && declared !== detected && declared !== 'application/octet-stream') {
    return {
      ok: false,
      reason: `El tipo declarado (${declared}) no coincide con el contenido (${detected})`,
    };
  }

  const extension = detected === 'image/jpeg' ? 'jpg' : detected === 'image/png' ? 'png' : 'webp';
  return { ok: true, type: detected, extension };
}

export function photoKeyFor(
  businessId: string,
  petId: string,
  extension: string,
): string {
  return `businesses/${businessId}/pets/${petId}/${crypto.randomUUID()}.${extension}`;
}

export function businessPhotoPrefix(businessId: string): string {
  return `businesses/${businessId}/`;
}


/**
 * En producción el binding es obligatorio: el adaptador en memoria pierde las
 * fotos al reiniciar el isolate y no las comparte entre instancias.
 */
export function requirePhotoStorage(env: {
  PHOTOS?: unknown;
  PHOTOS_REQUIRED?: string;
}): void {
  if (env.PHOTOS_REQUIRED === 'true' && !env.PHOTOS) {
    throw serviceUnavailable(
      'El almacenamiento de fotos no está configurado. Falta el bucket R2.',
    );
  }
}
