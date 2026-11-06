import { bytesToBase64, isAllowedMediaUrl } from './media';

/**
 * Descarga y validación de notas de voz de WhatsApp.
 *
 * Kapso entrega la URL del medio en el mismo payload que las fotos. El audio
 * se mantiene en memoria el tiempo necesario para transcribirlo: no se guarda
 * en Turso ni depende de R2.
 */

export type AudioFormat =
  | 'ogg'
  | 'mp3'
  | 'wav'
  | 'm4a'
  | 'webm'
  | 'flac';

export type InboundAudio = {
  messageId: string;
  url: string;
  mimeType: string | null;
  fileName: string | null;
  /** Duración reportada por Kapso, si viene en el payload. */
  durationSeconds: number | null;
};

export type LoadedAudio = {
  base64: string;
  format: AudioFormat;
  mimeType: string;
  byteLength: number;
};

const AUDIO_TYPES = new Set(['audio', 'voice', 'ptt']);

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.'));
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function findDuration(payload: Record<string, unknown>): number | null {
  const kapso = asRecord(payload.kapso);
  const mediaData = asRecord(kapso?.media_data);
  const messageData = asRecord(kapso?.message_type_data);
  const audio = asRecord(payload.audio) ?? asRecord(payload.voice);
  const generic = asRecord(payload.ptt);

  return (
    asNumber(audio?.duration) ??
    asNumber(audio?.seconds) ??
    asNumber(mediaData?.duration) ??
    asNumber(mediaData?.seconds) ??
    asNumber(messageData?.duration) ??
    asNumber(kapso?.duration) ??
    asNumber(generic?.duration) ??
    asNumber(payload.duration) ??
    null
  );
}

export function audioFromRawMessage(
  messageId: string,
  messageType: string | null,
  raw: string | null,
): InboundAudio | null {
  if (!raw) return null;

  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    const record = asRecord(parsed);
    if (!record) return null;
    payload = record;
  } catch {
    return null;
  }

  const type = asString(payload.type) ?? messageType ?? '';
  if (!AUDIO_TYPES.has(type)) return null;

  const kapso = asRecord(payload.kapso);
  const mediaData = asRecord(kapso?.media_data);
  const media = asRecord(payload[type]) ?? asRecord(payload.audio) ?? asRecord(payload.voice);

  const urlCandidates = [
    asString(mediaData?.url),
    asString(kapso?.media_url),
    asString(media?.link),
    asString(media?.url),
  ].filter((value): value is string => value !== null);

  const url = urlCandidates.find(isAllowedMediaUrl);
  if (!url) return null;

  const mimeType =
    asString(mediaData?.content_type) ??
    asString(media?.mime_type) ??
    asString(media?.mimeType);
  const fileName =
    asString(mediaData?.filename) ?? asString(media?.filename);

  return {
    messageId,
    url,
    mimeType,
    fileName,
    durationSeconds: findDuration(payload),
  };
}

export function detectAudioType(bytes: Uint8Array): {
  format: AudioFormat;
  mimeType: string;
} | null {
  const starts = (values: number[], offset = 0): boolean =>
    values.every((value, index) => bytes[offset + index] === value);

  if (starts([0x4f, 0x67, 0x67, 0x53])) {
    // "OggS" — WhatsApp usa OGG/Opus para notas de voz.
    return { format: 'ogg', mimeType: 'audio/ogg' };
  }
  if (starts([0x49, 0x44, 0x33]) || starts([0xff, 0xfb]) || starts([0xff, 0xf3])) {
    return { format: 'mp3', mimeType: 'audio/mpeg' };
  }
  if (
    starts([0x52, 0x49, 0x46, 0x46]) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x41 &&
    bytes[10] === 0x56 &&
    bytes[11] === 0x45
  ) {
    return { format: 'wav', mimeType: 'audio/wav' };
  }
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
    return { format: 'm4a', mimeType: 'audio/mp4' };
  }
  if (starts([0x1a, 0x45, 0xdf, 0xa3])) {
    return { format: 'webm', mimeType: 'audio/webm' };
  }
  if (starts([0x66, 0x4c, 0x61, 0x43])) {
    return { format: 'flac', mimeType: 'audio/flac' };
  }
  return null;
}

export async function downloadInboundAudio(
  audio: InboundAudio,
  options: { maxBytes: number; fetcher?: typeof fetch },
): Promise<LoadedAudio | null> {
  const fetcher = options.fetcher ?? fetch;

  const response = await fetcher(audio.url, {
    method: 'GET',
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return null;

  const declaredLength = Number(response.headers.get('content-length') ?? 0);
  if (declaredLength > options.maxBytes) return null;

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > options.maxBytes) {
    return null;
  }

  const bytes = new Uint8Array(buffer);
  const detected = detectAudioType(bytes);
  if (!detected) return null;

  return {
    base64: bytesToBase64(bytes),
    format: detected.format,
    mimeType: detected.mimeType,
    byteLength: bytes.length,
  };
}
