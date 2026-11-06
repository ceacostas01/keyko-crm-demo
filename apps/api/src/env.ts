import type { Db } from '@keyko/db';
import type { Role } from '@keyko/domain';
import type { R2Like } from './lib/storage';

export type AuthContext = {
  userId: string;
  businessId: string;
  role: Role;
};

export type AppEnv = {
  Bindings: {
    TURSO_DATABASE_URL: string;
    TURSO_AUTH_TOKEN: string;
    JWT_SECRET: string;
    /**
     * Orígenes permitidos para CORS, separados por coma.
     * Ej: "https://crm.keyko.co,http://localhost:5173"
     */
    ALLOWED_ORIGINS?: string;

    // --- IA ---
    AI_ENABLED?: string;
    AI_PROVIDER?: string;
    AI_MODEL?: string;
    AI_MAX_OUTPUT_TOKENS?: string;
    AI_MAX_ATTEMPTS?: string;
    AI_DAILY_BUDGET_USD_MICROS?: string;
    AI_MONTHLY_BUDGET_USD_MICROS?: string;
    AI_STORE_RAW_RESPONSE?: string;
    AI_RAW_RETENTION_DAYS?: string;
    AI_SUGGESTION_RETENTION_DAYS?: string;
    AI_USAGE_RETENTION_DAYS?: string;
    AI_INPUT_PRICE_PER_MTOK?: string;
    AI_OUTPUT_PRICE_PER_MTOK?: string;
    AI_AUTO_APPLY?: string;
    /** Crea mascotas nuevas para clientes existentes, sin auto-aplicar el resto. */
    AI_AUTO_CREATE_PETS?: string;
    /** Verifica con el modelo los candidatos antes de crear mascotas. */
    AI_VERIFY_PET_CANDIDATES?: string;
    AI_AUTO_CREATE_APPOINTMENT_REQUESTS?: string;
    AI_AUTO_CONFIRM_APPOINTMENTS?: string;
    /** Clasificación de fotos con visión. */
    AI_VISION_ENABLED?: string;
    AI_VISION_MODEL?: string;
    AI_VISION_MAX_IMAGE_BYTES?: string;
    /** Transcripción de notas de voz. */
    AI_TRANSCRIPTION_ENABLED?: string;
    AI_TRANSCRIPTION_MODEL?: string;
    AI_TRANSCRIPTION_LANGUAGE?: string;
    AI_TRANSCRIPTION_MAX_BYTES?: string;
    AI_TRANSCRIPTION_MAX_SECONDS?: string;
    AI_TRANSCRIPTION_TIMEOUT_MS?: string;
    AI_TRANSCRIPTION_MAX_ATTEMPTS?: string;
    AI_TRANSCRIPTION_RETENTION_DAYS?: string;
    /** Lista separada por comas de contact_key autorizados para pruebas. */
    AI_TEST_CONTACTS?: string;
    /** No procesar mensajes anteriores a este instante (ISO UTC). */
    AI_STARTED_AT?: string;
    /** Permite que el cron procese automáticamente. */
    AI_AUTO_PROCESS?: string;
    AI_API_KEY?: string;

    // --- Fotografías ---
    /** Bucket R2. Si falta, se usa el adaptador en memoria (desarrollo). */
    PHOTOS?: R2Like;
    /** Si es "true", las fotos fallan en vez de usar memoria volátil. */
    PHOTOS_REQUIRED?: string;
    PHOTO_MAX_BYTES?: string;
    PHOTO_URL_TTL_SECONDS?: string;
  };
  Variables: {
    db: Db;
    auth: AuthContext;
    storage: import('./lib/storage').StorageAdapter;
  };
};

/** Origen por defecto cuando no se configura nada: solo desarrollo local. */
export const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5173';

export function parseAllowedOrigins(raw: string | undefined): string[] {
  return (raw ?? DEFAULT_ALLOWED_ORIGINS)
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
