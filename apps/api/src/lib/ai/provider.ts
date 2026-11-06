import type { AiConfig } from './config';
import { createFakeProvider, type AiProvider } from './fake';
import { createOpenRouterProvider } from './openrouter';

/**
 * En desarrollo se usa el proveedor determinista: no hay red ni costo.
 * OpenRouter solo se activa con AI_PROVIDER=openrouter y su propia clave.
 */
export function getProvider(config: AiConfig): AiProvider {
  return config.provider === 'openrouter'
    ? createOpenRouterProvider(config)
    : createFakeProvider();
}
