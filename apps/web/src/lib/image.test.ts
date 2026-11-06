import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  isHeicImage,
  MAX_SOURCE_BYTES,
  MAX_UPLOAD_BYTES,
  scaleDimensions,
  validateImageFile,
} from './image';

function file(type: string, size: number): File {
  return new File([new Uint8Array(size)], 'foto', { type });
}

describe('validación de imágenes', () => {
  it('acepta JPEG, PNG y WebP dentro del límite', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp']) {
      expect(validateImageFile(file(type, 1000))).toBeNull();
    }
  });

  it('rechaza otros formatos', () => {
    expect(validateImageFile(file('image/gif', 1000))).toContain('Formato');
    expect(validateImageFile(file('application/pdf', 1000))).toContain('Formato');
  });

  it('acepta HEIC/HEIF aunque el navegador no los pueda dibujar', () => {
    const heic = new File([new Uint8Array(1000)], 'foto.heic', {
      type: 'image/heic',
    });
    const unknownType = new File([new Uint8Array(1000)], 'foto.heif', {
      type: '',
    });

    expect(isHeicImage(heic)).toBe(true);
    expect(isHeicImage(unknownType)).toBe(true);
    expect(validateImageFile(heic)).toBeNull();
    expect(validateImageFile(unknownType)).toBeNull();
  });

  it('rechaza archivos demasiado grandes', () => {
    const result = validateImageFile(file('image/jpeg', MAX_SOURCE_BYTES + 1));
    expect(result).toContain('máximo');
  });

  it('acepta fotos grandes que se comprimen antes de subir', () => {
    expect(
      validateImageFile(file('image/jpeg', MAX_UPLOAD_BYTES + 1024)),
    ).toBeNull();
  });

  it('limita dimensiones manteniendo proporción', () => {
    expect(scaleDimensions(3200, 1600)).toEqual({ width: 1600, height: 800 });
    expect(scaleDimensions(800, 600)).toEqual({ width: 800, height: 600 });
    expect(scaleDimensions(1000, 3000)).toEqual({ width: 533, height: 1600 });
  });

  it('formatea tamaños', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
