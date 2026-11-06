import { detectImageType, type ImageType } from '../photos';

/**
 * Extracción y descarga de la foto de un mensaje de WhatsApp.
 *
 * El webhook guarda el payload de Kapso en `raw_message_json`. Aquí se lee esa
 * URL, se comprueba que sea de un host conocido y se descarga la imagen para
 * enviarla al clasificador de visión. El webhook no se modifica.
 */

export type InboundImage = {
  messageId: string;
  url: string;
  mimeType: string | null;
  fileName: string | null;
};

export type LoadedImage = {
  base64: string;
  mimeType: ImageType;
  byteLength: number;
};

const ALLOWED_HOSTS = [
  'app.kapso.ai',
  'lookaside.fbsbx.com',
  'mmg.whatsapp.net',
  'scontent.whatsapp.net',
];

export function isAllowedMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    return ALLOWED_HOSTS.some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    );
  } catch {
    return false;
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Devuelve la imagen del payload si el mensaje es una foto con una URL
 * permitida. No descarga nada; eso lo hace `downloadInboundImage`.
 */
export function imageFromRawMessage(
  messageId: string,
  messageType: string | null,
  raw: string | null,
): InboundImage | null {
  if (messageType !== 'image' || !raw) return null;

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) return null;
    payload = record;
  } catch {
    return null;
  }

  const type = asString(payload.type) ?? messageType;
  if (type !== 'image') return null;

  const kapso = asRecord(payload.kapso);
  const mediaData = asRecord(kapso?.media_data);
  const image = asRecord(payload.image);
  const generic = asRecord(payload[type]);

  const urlCandidates = [
    asString(mediaData?.url),
    asString(kapso?.media_url),
    asString(image?.link),
    asString(generic?.link),
    asString(image?.url),
  ].filter((value): value is string => value !== null);

  const url = urlCandidates.find(isAllowedMediaUrl);
  if (!url) return null;

  const mimeType =
    asString(mediaData?.content_type) ??
    asString(image?.mime_type) ??
    asString(generic?.mime_type);
  const fileName =
    asString(mediaData?.filename) ?? asString(image?.filename);

  return { messageId, url, mimeType, fileName };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, Math.min(index + chunk, bytes.length)),
    );
  }
  return btoa(binary);
}

/**
 * Descarga la imagen con límite de tamaño y valida el tipo real por los bytes.
 * Devuelve `null` si no es una imagen admitida o si supera el límite.
 */
export async function downloadInboundImage(
  image: InboundImage,
  options: { maxBytes: number; fetcher?: typeof fetch },
): Promise<LoadedImage | null> {
  const fetcher = options.fetcher ?? fetch;

  const response = await fetcher(image.url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) return null;

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > options.maxBytes) return null;

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > options.maxBytes) {
    return null;
  }

  const bytes = new Uint8Array(buffer);
  const detected = detectImageType(bytes);
  if (!detected) return null;

  return {
    base64: bytesToBase64(bytes),
    mimeType: detected,
    byteLength: bytes.length,
  };
}
