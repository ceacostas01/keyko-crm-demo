import { estimateCostMicros, type AiConfig } from './config';
import type { AiProvider, ExtractionInput, ProviderResult } from './fake';
import { parseExtraction } from './schema';

/**
 * Prompt del sistema. Insiste en tres cosas: no inventar, citar el mensaje y
 * devolver solo JSON válido.
 */
const SYSTEM_PROMPT = `Eres un asistente de un pet grooming. Extraes datos de conversaciones de WhatsApp.

Reglas estrictas:
- NO inventes datos. Si un dato no aparece de forma explícita, omite el campo.
- No inferieras el sexo del animal por el artículo ("perro"/"gato"); solo si dice macho, hembra, perra o gata.
- Revisa el mensaje completo: si menciona raza, peso, edad, alergias o preferencias, inclúyelos con su evidencia.
- Los mensajes marcados "audio transcrito" son notas de voz del cliente; trátalos como texto dicho por esa persona. No inventes datos que no aparezcan en la transcripción.
- El "nombre de perfil" de WhatsApp NO es el nombre de la persona: no lo uses como fullName.
- No incluyas campos con valor vacío, null ni "desconocido".
- species debe ser exactamente: perro o gato. sex: macho o hembra (minúsculas).
- Cada campo debe incluir "confidence" (0 a 1) y "evidence" (ids de los mensajes de donde sale).
- No deduzcas la raza, el peso ni la edad si no se dicen.
- Si el cliente menciona problemas de salud, piel, cuidados o comportamiento, guárdalo en "temperament" como observación textual, sin diagnóstico. Usa "allergies" solo si dice explícitamente que es alérgico.
- Si dicen "tiene 13 años", usa ageYears=13. No extraigas birthdate ni calcules una fecha de nacimiento; este CRM usa edad, no fecha.
- Las fechas relativas ("el sábado") van tal cual en requestedDate, sin convertirlas.
- "intent" clasifica la intención:
  · appointment_request: pide explícitamente una cita ("quiero agendar", "reservar").
  · availability_inquiry: pregunta por cupo, horario o disponibilidad, sin pedir cita.
  · service_inquiry: pregunta precios o por un servicio concreto.
  · other: cualquier otra cosa.
- requestedService debe conservar los calificativos del servicio: si dicen "baño medicado", devuelve "baño medicado", no solo "baño".
- Devuelve SOLO un objeto JSON con esta forma:
{
  "client": {
    "fullName": {"value": "...", "confidence": 0.9, "evidence": ["id"]},
    "phone": {"value": "+57...", "confidence": 0.9, "evidence": ["id"]},
    "notes": {"value": "...", "confidence": 0.8, "evidence": ["id"]}
  },
  "pets": [
    {
      "name": {"value": "Luna", "confidence": 0.95, "evidence": ["id"]},
      "species": {"value": "perro|gato", "confidence": 0.9, "evidence": ["id"]},
      "breed": {"value": "...", "confidence": 0.8, "evidence": ["id"]},
      "sex": {"value": "macho|hembra", "confidence": 0.9, "evidence": ["id"]},
      "ageYears": {"value": 13, "confidence": 0.9, "evidence": ["id"]},
      "weightKg": {"value": 4.2, "confidence": 0.8, "evidence": ["id"]},
      "allergies": {"value": "...", "confidence": 0.8, "evidence": ["id"]},
      "temperament": {"value": "...", "confidence": 0.8, "evidence": ["id"]}
    }
  ],
  "conversation": {
    "intent": {"value": "service_inquiry|availability_inquiry|appointment_request|other", "confidence": 0.9, "evidence": ["id"]},
    "requestedService": {"value": "...", "confidence": 0.8, "evidence": ["id"]},
    "wantsAppointment": {"value": true, "confidence": 0.9, "evidence": ["id"]},
    "requestedDate": {"value": "sábado", "confidence": 0.6, "evidence": ["id"]},
    "requestedTime": {"value": "10:00", "confidence": 0.6, "evidence": ["id"]},
    "openQuestions": ["..."],
    "notes": {"value": "...", "confidence": 0.7, "evidence": ["id"]}
  },
  "summary": "una frase"
}
Todos los campos son opcionales salvo "pets" y "conversation".`;

function buildUserPrompt(input: ExtractionInput): string {
  const messages = input.messages
    .map(
      (message, index) =>
        `[${message.id}] (${message.direction === 'outbound' ? 'nosotros' : 'cliente'}${message.mediaType === 'audio' ? ', audio transcrito' : ''}) ${message.body}`,
    )
    .join('\n');

  return `Contacto de WhatsApp: ${input.contactKey}
Teléfono conocido: ${input.contactPhone ?? 'no disponible'}
Nombre de perfil: ${input.contactName ?? 'no disponible'}

Mensajes (${input.messages.length}):
${messages}`;
}

export function createOpenRouterProvider(
  config: AiConfig,
): AiProvider {
  async function chat(body: Record<string, unknown>): Promise<{
    raw: string;
    tokensIn: number;
    tokensOut: number;
    model: string;
    latencyMs: number;
  }> {
    if (!config.apiKey) {
      throw new Error('Falta AI_API_KEY para usar OpenRouter');
    }

    const started = Date.now();
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'Keyko CRM',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      },
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `OpenRouter ${response.status}: ${detail.slice(0, 200)}`,
      );
    }

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };

    const raw = payload.choices?.[0]?.message?.content ?? '';
    if (raw.trim() === '') {
      throw new Error(
        `OpenRouter devolvió contenido vacío (finish_reason=${
          payload.choices?.[0]?.finish_reason ?? 'null'
        })`,
      );
    }

    return {
      raw,
      tokensIn: payload.usage?.prompt_tokens ?? 0,
      tokensOut: payload.usage?.completion_tokens ?? 0,
      model: payload.model ?? config.model,
      latencyMs: Date.now() - started,
    };
  }

  function jsonObject(raw: string): Record<string, unknown> {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Se intenta rescatar el primer objeto embebido.
    }

    const match = /\{[\s\S]*\}/.exec(raw);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Continúa al error de abajo.
      }
    }

    throw new Error(`Respuesta JSON inválida (${raw.slice(0, 120)})`);
  }

  return {
    name: 'openrouter',
    async extract(input) {
      const result = await chat({
        model: config.model,
        temperature: 0,
        max_tokens: config.maxOutputTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(input) },
        ],
      });

      let extraction;
      try {
        extraction = parseExtraction(result.raw);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : 'JSON inválido'} (${result.raw.length} caracteres)`,
        );
      }

      return {
        raw: result.raw,
        extraction,
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
        costUsdMicros: estimateCostMicros(
          result.tokensIn,
          result.tokensOut,
          config,
        ),
      } satisfies ProviderResult;
    },

    async verifyPet(input) {
      const messages = input.messages
        .map(
          (message) =>
            `[${message.id}] (${message.direction === 'outbound' ? 'nosotros' : 'cliente'}) ${message.body}`,
        )
        .join('\n');

      const result = await chat({
        model: config.model,
        temperature: 0,
        max_tokens: 220,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Eres un verificador estricto de datos de una peluquería de mascotas.

Debes decidir si el nombre indicado corresponde REALMENTE a una mascota (perro o gato) y no a un producto, persona, marca, servicio o lugar.

Rechaza (is_pet=false) cuando:
- el nombre aparece en una frase sobre una crema, shampoo, medicamento, juguete, alimento u otro producto;
- solo dicen "se llama X" sin ninguna palabra que indique animal;
- la especie fue inferida por el modelo y el texto no menciona perro, gato, perrito, gatito, canino, felino o mascota;
- hay duda razonable.

Acepta (is_pet=true) solo si el texto respalda de forma explícita que es una mascota.

Devuelve SOLO JSON:
{"is_pet": true|false, "confidence": 0.0-1.0, "reason": "frase corta"}`,
          },
          {
            role: 'user',
            content: `Nombre candidato: ${input.name}
Especie declarada: ${input.species ?? 'no disponible'}

Conversación:
${messages}`,
          },
        ],
      });

      const parsed = jsonObject(result.raw);
      return {
        allowed: parsed.is_pet === true,
        confidence:
          typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        reason:
          typeof parsed.reason === 'string'
            ? parsed.reason.slice(0, 240)
            : 'Sin explicación',
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
        costUsdMicros: estimateCostMicros(
          result.tokensIn,
          result.tokensOut,
          config,
        ),
      };
    },

    async classifyImage(input) {
      const result = await chat({
        model: config.visionModel,
        temperature: 0,
        max_tokens: 220,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: `Clasificas la imagen principal de un mensaje de WhatsApp para una peluquería de mascotas.

Categorías permitidas:
- dog: un perro es el sujeto principal.
- cat: un gato es el sujeto principal.
- other_pet: otro animal doméstico.
- person: una persona es el sujeto principal.
- product: crema, shampoo, medicamento, juguete, empaque o producto.
- document: captura, documento, recibo o texto.
- other: cualquier otra cosa.
- unknown: la imagen no se puede interpretar.

has_animal debe ser true solo si hay un perro, gato u otro animal claramente visible como sujeto principal. Una foto de una crema, un frasco, una persona o una captura NO tiene animal.

Devuelve SOLO JSON:
{"category":"dog|cat|other_pet|person|product|document|other|unknown","has_animal":true|false,"confidence":0.0-1.0,"reason":"frase corta"}`,
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Clasifica esta imagen principal.',
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:${input.mimeType};base64,${input.base64}`,
                  // Baja resolución: basta para distinguir animal de producto y
                  // reduce el costo de tokens de imagen de forma notable.
                  detail: 'low',
                },
              },
            ],
          },
        ],
      });

      const parsed = jsonObject(result.raw);
      const categories = [
        'dog',
        'cat',
        'other_pet',
        'person',
        'product',
        'document',
        'other',
        'unknown',
      ] as const;
      const category = categories.includes(parsed.category as never)
        ? (parsed.category as (typeof categories)[number])
        : 'unknown';

      return {
        category,
        hasAnimal: parsed.has_animal === true,
        confidence:
          typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        reason:
          typeof parsed.reason === 'string'
            ? parsed.reason.slice(0, 240)
            : 'Sin explicación',
        model: result.model,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        latencyMs: result.latencyMs,
        costUsdMicros: estimateCostMicros(
          result.tokensIn,
          result.tokensOut,
          config,
        ),
      };
    },

    async transcribe(input) {
      if (!config.apiKey) {
        throw new Error('Falta AI_API_KEY para transcribir audio');
      }

      const started = Date.now();
      const response = await fetch(
        'https://openrouter.ai/api/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            'content-type': 'application/json',
            'x-title': 'Keyko CRM',
          },
          body: JSON.stringify({
            model: config.transcriptionModel,
            input_audio: {
              data: input.base64,
              format: input.format,
            },
            language: config.transcriptionLanguage,
            temperature: 0,
          }),
          signal: AbortSignal.timeout(config.transcriptionTimeoutMs),
        },
      );

      if (!response.ok) {
        const detail = await response.text();
        throw new Error(
          `OpenRouter transcripción ${response.status}: ${detail.slice(0, 200)}`,
        );
      }

      const payload = (await response.json()) as {
        text?: string | null;
        language?: string | null;
        usage?: {
          seconds?: number;
          cost?: number;
          total_tokens?: number;
        };
      };

      const text = (payload.text ?? '').trim();
      if (text === '') {
        throw new Error('El audio no tiene voz reconocible');
      }

      const audioSeconds =
        typeof payload.usage?.seconds === 'number'
          ? payload.usage.seconds
          : (input.durationSeconds ?? 0);
      const cost =
        typeof payload.usage?.cost === 'number' ? payload.usage.cost : 0;

      return {
        text,
        language: payload.language ?? config.transcriptionLanguage,
        audioSeconds,
        model: config.transcriptionModel,
        tokensIn: payload.usage?.total_tokens ?? 0,
        tokensOut: 0,
        latencyMs: Date.now() - started,
        costUsdMicros: Math.round(cost * 1_000_000),
      };
    },
  };
}
