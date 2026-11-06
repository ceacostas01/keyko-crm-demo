import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiConfig } from '../src/lib/ai/config';
import { createFakeProvider } from '../src/lib/ai/fake';
import {
  downloadInboundImage,
  imageFromRawMessage,
} from '../src/lib/ai/media';
import { createOpenRouterProvider } from '../src/lib/ai/openrouter';

const ALLOWED_URL =
  'https://app.kapso.ai/rails/active_storage/blobs/foto.jpeg';

function rawImage(url = ALLOWED_URL): string {
  return JSON.stringify({
    type: 'image',
    image: { mime_type: 'image/jpeg' },
    kapso: {
      media_url: url,
      media_data: {
        url,
        filename: 'foto.jpeg',
        content_type: 'image/jpeg',
      },
    },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fotos de WhatsApp', () => {
  it('extrae la URL de media del payload de Kapso', () => {
    const image = imageFromRawMessage('m1', 'image', rawImage());

    expect(image).toMatchObject({
      messageId: 'm1',
      url: ALLOWED_URL,
      mimeType: 'image/jpeg',
      fileName: 'foto.jpeg',
    });
  });

  it('ignora mensajes que no son fotos o usan hosts desconocidos', () => {
    expect(imageFromRawMessage('m1', 'text', rawImage())).toBeNull();
    expect(
      imageFromRawMessage(
        'm1',
        'image',
        rawImage('https://example.com/foto.jpeg'),
      ),
    ).toBeNull();
  });

  it('descarga y valida una imagen real por sus primeros bytes', async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const fetcher = vi.fn(async () => new Response(jpeg, { status: 200 }));

    const loaded = await downloadInboundImage(
      {
        messageId: 'm1',
        url: ALLOWED_URL,
        mimeType: 'image/jpeg',
        fileName: 'foto.jpeg',
      },
      { maxBytes: 1_000, fetcher: fetcher as never },
    );

    expect(loaded).toMatchObject({ mimeType: 'image/jpeg', byteLength: 6 });
    expect(loaded?.base64).toBe('/9j/4AAQ');
  });

  it('rechaza archivos que no son imágenes o superan el límite', async () => {
    const notImage = vi.fn(
      async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
    );
    const tooLarge = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
          status: 200,
          headers: { 'content-length': '9999' },
        }),
    );

    expect(
      await downloadInboundImage(
        { messageId: 'm1', url: ALLOWED_URL, mimeType: null, fileName: null },
        { maxBytes: 1_000, fetcher: notImage as never },
      ),
    ).toBeNull();

    expect(
      await downloadInboundImage(
        { messageId: 'm1', url: ALLOWED_URL, mimeType: null, fileName: null },
        { maxBytes: 1_000, fetcher: tooLarge as never },
      ),
    ).toBeNull();
  });
});

describe('verificador de candidatos', () => {
  it('acepta una mascota con contexto animal explícito', async () => {
    const provider = createFakeProvider();
    const verdict = await provider.verifyPet!({
      name: 'Nube',
      species: 'perro',
      messages: [
        {
          id: 'm1',
          body: 'Mi perro se llama Nube y tiene 3 años.',
          direction: 'inbound',
          at: '',
          contactName: 'Ana',
        },
      ],
    });

    expect(verdict.allowed).toBe(true);
    expect(verdict.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('rechaza el nombre de una crema aunque el modelo haya inventado la especie', async () => {
    const provider = createFakeProvider();
    const verdict = await provider.verifyPet!({
      name: 'Hydra',
      species: 'perro',
      messages: [
        {
          id: 'm1',
          body: 'Si, tengo esta crema que hay que aplicarle',
          direction: 'inbound',
          at: '',
          contactName: 'CA',
        },
        {
          id: 'm2',
          body: 'Se llama Hydra',
          direction: 'inbound',
          at: '',
          contactName: 'CA',
        },
      ],
    });

    expect(verdict.allowed).toBe(false);
    expect(verdict.confidence).toBeGreaterThan(0.7);
  });

  it('la visión determinista no autoriza fotos sin analizarlas', async () => {
    const provider = createFakeProvider();
    const result = await provider.classifyImage!({
      base64: 'Zm90bw==',
      mimeType: 'image/jpeg',
    });

    expect(result.hasAnimal).toBe(false);
    expect(result.category).toBe('unknown');
  });
});

describe('visión en OpenRouter', () => {
  it('envía la imagen como data URL y respeta el modelo de visión', async () => {
    const config = {
      ...aiConfig({ AI_PROVIDER: 'openrouter' } as never),
      apiKey: 'test-key',
      visionModel: 'openai/gpt-4o-mini',
    };

    let sent: Record<string, unknown> = {};
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"category":"product","has_animal":false,"confidence":0.97,"reason":"Es una crema"}',
              },
            },
          ],
          usage: { prompt_tokens: 900, completion_tokens: 30 },
          model: 'openai/gpt-4o-mini',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const provider = createOpenRouterProvider(config);
    const result = await provider.classifyImage!({
      base64: 'Zm90bw==',
      mimeType: 'image/jpeg',
    });

    expect(sent.model).toBe('openai/gpt-4o-mini');
    const messages = sent.messages as Array<{
      role: string;
      content: Array<{ type: string; image_url?: { url: string } }>;
    }>;
    const userContent = messages.find((message) => message.role === 'user')?.content;
    expect(userContent?.[1]?.image_url?.url).toBe(
      'data:image/jpeg;base64,Zm90bw==',
    );

    expect(result.category).toBe('product');
    expect(result.hasAnimal).toBe(false);
    expect(result.costUsdMicros).toBeGreaterThan(0);
  });
});
