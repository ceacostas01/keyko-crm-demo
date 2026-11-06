import type { AppEnv } from '../../env';

/**
 * Configuración de IA.
 *
 * Todo se controla por variables de entorno para poder apagarla o cambiar de
 * modelo sin tocar código. En desarrollo el proveedor por defecto es `fake`:
 * no hace llamadas de red y no cuesta nada.
 */
export type AiConfig = {
  enabled: boolean;
  provider: 'fake' | 'openrouter';
  model: string;
  maxOutputTokens: number;
  maxAttempts: number;
  /** Presupuesto diario en micro-dólares (1 USD = 1 000 000). */
  dailyBudgetUsdMicros: number;
  /** Presupuesto mensual, independiente del diario. */
  monthlyBudgetUsdMicros: number;
  /** Guardar la respuesta cruda del modelo (solo si se necesita depurar). */
  storeRawResponse: boolean;
  /** Días que se conserva la respuesta cruda antes de borrarla. */
  rawRetentionDays: number;
  /** Días que se conservan las sugerencias ya revisadas. */
  suggestionRetentionDays: number;
  /** Días de detalle de consumo antes de agregarlo por mes. */
  usageRetentionDays: number;
  /** Precio en USD por millón de tokens. */
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  autoApply: boolean;
  autoCreatePets: boolean;
  /** Verifica con el modelo los candidatos antes de crear mascotas. */
  verifyPetCandidates: boolean;
  autoCreateAppointmentRequests: boolean;
  autoConfirmAppointments: boolean;
  /** Clasificación de fotos con visión (animal, persona, producto…). */
  visionEnabled: boolean;
  visionModel: string;
  visionMaxImageBytes: number;
  transcriptionEnabled: boolean;
  transcriptionModel: string;
  transcriptionLanguage: string;
  transcriptionMaxBytes: number;
  transcriptionMaxSeconds: number;
  transcriptionTimeoutMs: number;
  transcriptionMaxAttempts: number;
  transcriptionRetentionDays: number;
  testContacts: string[];
  startedAt: string | null;
  autoProcess: boolean;
  apiKey: string | null;
};

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value.toLowerCase() !== 'false' && value !== '0';
}

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function aiConfig(env: AppEnv['Bindings']): AiConfig {
  const provider = env.AI_PROVIDER === 'openrouter' ? 'openrouter' : 'fake';

  return {
    enabled: bool(env.AI_ENABLED, true),
    provider,
    model: env.AI_MODEL ?? 'openai/gpt-4o-mini',
    maxOutputTokens: num(env.AI_MAX_OUTPUT_TOKENS, 1600),
    maxAttempts: num(env.AI_MAX_ATTEMPTS, 3),
    dailyBudgetUsdMicros: num(env.AI_DAILY_BUDGET_USD_MICROS, 100_000),
    monthlyBudgetUsdMicros: num(env.AI_MONTHLY_BUDGET_USD_MICROS, 5_000_000),
    storeRawResponse: bool(env.AI_STORE_RAW_RESPONSE, false),
    rawRetentionDays: num(env.AI_RAW_RETENTION_DAYS, 7),
    suggestionRetentionDays: num(env.AI_SUGGESTION_RETENTION_DAYS, 180),
    usageRetentionDays: num(env.AI_USAGE_RETENTION_DAYS, 180),
    inputPricePerMTok: num(env.AI_INPUT_PRICE_PER_MTOK, 0.15),
    outputPricePerMTok: num(env.AI_OUTPUT_PRICE_PER_MTOK, 0.6),
    autoApply: bool(env.AI_AUTO_APPLY, false),
    autoCreatePets: bool(env.AI_AUTO_CREATE_PETS, false),
    verifyPetCandidates: bool(env.AI_VERIFY_PET_CANDIDATES, true),
    autoCreateAppointmentRequests: bool(
      env.AI_AUTO_CREATE_APPOINTMENT_REQUESTS,
      false,
    ),
    autoConfirmAppointments: bool(env.AI_AUTO_CONFIRM_APPOINTMENTS, false),
    visionEnabled: bool(env.AI_VISION_ENABLED, false),
    visionModel: env.AI_VISION_MODEL ?? 'openai/gpt-4o-mini',
    visionMaxImageBytes: num(env.AI_VISION_MAX_IMAGE_BYTES, 4_000_000),
    transcriptionEnabled: bool(env.AI_TRANSCRIPTION_ENABLED, true),
    transcriptionModel:
      env.AI_TRANSCRIPTION_MODEL ?? 'openai/gpt-4o-mini-transcribe',
    transcriptionLanguage: env.AI_TRANSCRIPTION_LANGUAGE ?? 'es',
    transcriptionMaxBytes: num(env.AI_TRANSCRIPTION_MAX_BYTES, 20_000_000),
    transcriptionMaxSeconds: num(env.AI_TRANSCRIPTION_MAX_SECONDS, 300),
    transcriptionTimeoutMs: num(env.AI_TRANSCRIPTION_TIMEOUT_MS, 45_000),
    transcriptionMaxAttempts: num(env.AI_TRANSCRIPTION_MAX_ATTEMPTS, 3),
    transcriptionRetentionDays: num(env.AI_TRANSCRIPTION_RETENTION_DAYS, 180),
    testContacts: (env.AI_TEST_CONTACTS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    startedAt: env.AI_STARTED_AT?.trim() || null,
    autoProcess: bool(env.AI_AUTO_PROCESS, true),
    apiKey: env.AI_API_KEY ?? null,
  };
}

/**
 * Costo en micro-dólares.
 * El precio es USD por millón de tokens, que equivale a micro-dólares por
 * token: `tokens * precio` ya está en micros.
 */
export function estimateCostMicros(
  tokensIn: number,
  tokensOut: number,
  config: AiConfig,
): number {
  return Math.round(
    tokensIn * config.inputPricePerMTok + tokensOut * config.outputPricePerMTok,
  );
}
