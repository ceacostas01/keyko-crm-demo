/**
 * Validación y compresión de imágenes en el navegador.
 *
 * Se redimensiona a un máximo razonable y se recomprime a JPEG antes de
 * subir. El servidor vuelve a validar el tipo real por los primeros bytes.
 */

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
/**
 * Tope del archivo original. Es mayor que el de subida porque la foto se
 * comprime en el navegador antes de enviarla: una foto de celular de 8–20 MB
 * puede quedar muy por debajo de 5 MB.
 */
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;
export const ALLOWED_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  // Formatos de cámara que se intentan convertir a JPEG en el navegador.
  'image/heic',
  'image/heif',
  'image/avif',
];

export const UPLOADABLE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_DIMENSION = 1600;

/** El navegador no siempre identifica el HEIC; también se mira la extensión. */
export function isHeicImage(file: File): boolean {
  return (
    /image\/hei[cf]/i.test(file.type) ||
    /\.hei[cf]$/i.test(file.name)
  );
}

export function validateImageFile(file: File): string | null {
  if (!file) return 'Selecciona una imagen';
  if (!ALLOWED_TYPES.includes(file.type) && !isHeicImage(file)) {
    return 'Formato no válido. Usa JPEG, PNG, WebP o HEIC.';
  }
  if (file.size > MAX_SOURCE_BYTES) {
    return `La imagen original pesa ${formatBytes(file.size)}. El máximo es ${formatBytes(
      MAX_SOURCE_BYTES,
    )}.`;
  }
  return null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function scaleDimensions(
  width: number,
  height: number,
  max = MAX_DIMENSION,
): { width: number; height: number } {
  if (width <= max && height <= max) return { width, height };
  const ratio = Math.min(max / width, max / height);
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
  };
}

async function convertHeic(file: File): Promise<Blob | null> {
  try {
    const { default: heic2any } = await import('heic2any');
    const result = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: 0.82,
    });
    const blob = Array.isArray(result) ? result[0] : result;
    return blob ?? null;
  } catch {
    return null;
  }
}

/**
 * Redimensiona y recomprime. Devuelve un JPEG (o el original si el navegador
 * no puede dibujarlo). Los HEIC/HEIF se convierten primero a JPEG porque
 * Chrome y la mayoría de navegadores de escritorio no los pueden dibujar.
 */
export async function compressImage(
  file: File,
  options: { maxDimension?: number; quality?: number } = {},
): Promise<Blob> {
  const maxDimension = options.maxDimension ?? MAX_DIMENSION;
  const quality = options.quality ?? 0.82;

  let source: Blob = file;
  if (isHeicImage(file)) {
    const converted = await convertHeic(file);
    if (!converted) return file;
    source = converted;
  }

  const bitmap = await loadBitmap(source);
  if (!bitmap) return source;

  const size = scaleDimensions(bitmap.width, bitmap.height, maxDimension);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext('2d');
  if (!context) return source;

  context.drawImage(bitmap, 0, 0, size.width, size.height);

  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/jpeg', quality);
  });

  return blob ?? source;
}

async function loadBitmap(
  file: Blob,
): Promise<{ width: number; height: number } & CanvasImageSource | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Se intenta con <img>.
    }
  }

  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}
