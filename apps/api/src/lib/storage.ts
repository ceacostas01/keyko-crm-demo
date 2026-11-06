/**
 * Almacenamiento de fotografías.
 *
 * En producción es R2 (privado). En desarrollo y pruebas se usa un adaptador
 * en memoria para no crear recursos externos. Turso solo guarda la clave y
 * los metadatos; el binario nunca entra a la base.
 */

export type StoredObject = {
  bytes: Uint8Array;
  contentType: string;
};

export interface StorageAdapter {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): Promise<string[]>;
}

/** Mismo contrato que `R2Bucket`, sin depender de sus tipos. */
export type R2Like = {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    httpMetadata?: { contentType?: string };
  } | null>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated?: boolean;
  }>;
};

export function createMemoryStorage(): StorageAdapter {
  const objects = new Map<string, StoredObject>();

  return {
    async put(key, bytes, contentType) {
      objects.set(key, { bytes, contentType });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async exists(key) {
      return objects.has(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((key) => key.startsWith(prefix));
    },
  };
}

export function createR2Storage(bucket: R2Like): StorageAdapter {
  return {
    async put(key, bytes, contentType) {
      await bucket.put(key, bytes, { httpMetadata: { contentType } });
    },
    async get(key) {
      const object = await bucket.get(key);
      if (!object) return null;

      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
    async exists(key) {
      return (await bucket.get(key)) !== null;
    },
    async list(prefix) {
      const result = await bucket.list({ prefix });
      return result.objects.map((object) => object.key);
    },
  };
}


let sharedMemory: StorageAdapter | null = null;

/**
 * Adaptador por entorno: R2 si hay binding, memoria si no.
 * El de memoria es un singleton para que la demo conserve las fotos mientras
 * el proceso vive. En pruebas se inyecta uno propio.
 */
export function getStorage(env: { PHOTOS?: R2Like }): StorageAdapter {
  if (env.PHOTOS) return createR2Storage(env.PHOTOS);
  sharedMemory ??= createMemoryStorage();
  return sharedMemory;
}
