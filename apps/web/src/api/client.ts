import type {
  AiProcessResult,
  Completeness,
  AiSuggestion,
  AiUsage,
  DataQualitySummary,
  Appointment,
  AppointmentRequest,
  Expense,
  AuthResponse,
  Client,
  Conversation,
  ConversationDetail,
  MeResponse,
  MessageTranscription,
  Paginated,
  Pet,
  PetHistory,
  PetWithClient,
  Product,
  Sale,
  SaleListRow,
  SaleSummary,
  Service,
} from './types';

const TOKEN_KEY = 'keyko.token';

/**
 * Base de la API. Vacía en desarrollo (Vite hace proxy de `/api`).
 * En un despliegue separado se configura con VITE_API_BASE_URL.
 */
export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');

/** Convierte una ruta relativa de la API en absoluta (para <img>). */
export function mediaUrl(path: string | null | undefined): string | null {
  if (!path) return null;
  if (/^(https?:|blob:|data:)/.test(path)) return path;
  return `${API_BASE}${path}`;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Por defecto usa el token guardado. */
  token?: string | null;
};

export async function request<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const token = options.token === undefined ? getToken() : options.token;

  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      0,
      'network_error',
      'No se pudo conectar con la API. ¿Está corriendo el backend?',
    );
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  if (!response.ok) {
    if (response.status === 401 && token) {
      clearToken();
      window.dispatchEvent(new Event('keyko:unauthorized'));
    }
    const error = body?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'http_error',
      error.message ?? `Error ${response.status}`,
      error.details,
    );
  }

  return body as T;
}

function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '') continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : '';
}

async function binaryRequest<T>(path: string, body: Blob): Promise<T> {
  const token = getToken();
  let response: Response;

  try {
    response = await fetch(`${API_BASE}/api/v1${path}`, {
      method: 'POST',
      headers: {
        'content-type': body.type || 'application/octet-stream',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body,
    });
  } catch {
    throw new ApiError(0, 'network_error', 'No se pudo subir la imagen');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new ApiError(
      response.status,
      error.code ?? 'http_error',
      error.message ?? `Error ${response.status}`,
    );
  }

  return payload as T;
}

/** Descarga autenticada de un binario (audio) y devuelve un Blob local. */
async function binaryBlob(path: string): Promise<Blob> {
  const token = getToken();
  let response: Response;
  try {
    response = await fetch(`${API_BASE}/api/v1${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  } catch {
    throw new ApiError(0, 'network_error', 'No se pudo descargar el audio');
  }

  if (!response.ok) {
    let message = `Error ${response.status}`;
    try {
      const payload = (await response.json()) as {
        error?: { message?: string };
      };
      message = payload.error?.message ?? message;
    } catch {
      // La respuesta de error no era JSON.
    }
    throw new ApiError(response.status, 'http_error', message);
  }

  return response.blob();
}

export const api = {
  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      token: null,
      body: { email, password },
    }),

  me: () => request<MeResponse>('/auth/me'),

  clients: {
    list: (search?: string) =>
      request<Paginated<Client>>(`/clients${query({ search, limit: 100 })}`),
    get: (id: number) => request<{ data: Client & { pets: Pet[] } }>(`/clients/${id}`),
    create: (body: Record<string, unknown>) =>
      request<{ data: Client }>('/clients', { method: 'POST', body }),
    update: (id: number, body: Record<string, unknown>) =>
      request<{ data: Client }>(`/clients/${id}`, { method: 'PATCH', body }),
    remove: (id: number) =>
      request<{ data: { deleted: boolean } }>(`/clients/${id}`, { method: 'DELETE' }),
  },

  pets: {
    list: (
      filters: {
        search?: string;
        species?: string;
        breed?: string;
        size?: string;
        clientId?: number;
        missing?: string;
        completeness?: string;
      } = {},
    ) =>
      request<Paginated<PetWithClient>>(
        `/pets${query({ ...filters, limit: 100 })}`,
      ),
    get: (id: string) =>
      request<{ data: Pet & { client: { id: number; name: string | null; phone: string | null; email: string | null }; health: unknown[] } }>(
        `/pets/${id}`,
      ),
    history: (id: string) =>
      request<{ data: PetHistory }>(`/pets/${id}/history`),
    create: (body: Record<string, unknown>) =>
      request<{ data: Pet }>('/pets', { method: 'POST', body }),
    update: (id: string, body: Record<string, unknown>) =>
      request<{ data: Pet }>(`/pets/${id}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ data: { deleted: boolean } }>(`/pets/${id}`, { method: 'DELETE' }),
    uploadPhoto: (id: string, file: Blob) =>
      binaryRequest<{ data: Pet & { photoUrl: string | null; completeness: Completeness } }>(
        `/pets/${id}/photo`,
        file,
      ),
    removePhoto: (id: string) =>
      request<{ data: Pet & { photoUrl: null; completeness: Completeness } }>(
        `/pets/${id}/photo`,
        { method: 'DELETE' },
      ),
  },

  services: {
    list: () => request<{ data: Service[] }>('/services'),
    create: (body: Record<string, unknown>) =>
      request<{ data: Service }>('/services', { method: 'POST', body }),
    update: (id: string, body: Record<string, unknown>) =>
      request<{ data: Service }>(`/services/${id}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ data: { deleted: boolean } }>(`/services/${id}`, { method: 'DELETE' }),
  },

  products: {
    list: () => request<{ data: Product[] }>('/products'),
    get: (id: string) => request<{ data: Product }>(`/products/${id}`),
    create: (body: Record<string, unknown>) =>
      request<{ data: Product }>('/products', { method: 'POST', body }),
    update: (id: string, body: Record<string, unknown>) =>
      request<{ data: Product }>(`/products/${id}`, { method: 'PATCH', body }),
    remove: (id: string) =>
      request<{ data: { deleted: boolean } }>(`/products/${id}`, { method: 'DELETE' }),
    adjustStock: (id: string, body: { delta: number; reason: string }) =>
      request<{ data: Product }>(`/products/${id}/stock`, { method: 'POST', body }),
  },

  appointments: {
    list: (from: string, to: string) =>
      request<Paginated<Appointment>>(
        `/appointments${query({ from, to, limit: 100, withConflicts: 'true' })}`,
      ),
    create: (body: Record<string, unknown>, idempotencyKey: string) =>
      request<{ data: Appointment; warnings: Appointment['warnings'] }>(
        '/appointments',
        {
          method: 'POST',
          body,
          headers: { 'idempotency-key': idempotencyKey },
        },
      ),
    update: (
      id: string,
      body: Record<string, unknown>,
      idempotencyKey: string,
    ) =>
      request<{ data: Appointment; warnings: Appointment['warnings'] }>(
        `/appointments/${id}`,
        {
          method: 'PATCH',
          body,
          headers: { 'idempotency-key': idempotencyKey },
        },
      ),
    cancel: (id: string) =>
      request<{ data: Appointment }>(`/appointments/${id}`, { method: 'DELETE' }),
    reactivate: (id: string) =>
      request<{ data: Appointment; warnings: Appointment['warnings'] }>(
        `/appointments/${id}/reactivate`,
        { method: 'POST', body: {} },
      ),
  },

  conversations: {
    list: () =>
      request<{
        data: Conversation[];
        meta: { sync: { contacts: number; created: number; linkedClients: number } };
      }>('/conversations'),
    get: (id: string) =>
      request<{ data: ConversationDetail }>(`/conversations/${id}`),
    audio: (id: string, messageId: string) =>
      binaryBlob(
        `/conversations/${id}/messages/${encodeURIComponent(messageId)}/audio`,
      ),
    correctTranscription: (id: string, messageId: string, text: string) =>
      request<{ data: MessageTranscription }>(
        `/conversations/${id}/messages/${encodeURIComponent(messageId)}/transcription`,
        { method: 'PATCH', body: { text } },
      ),
    retryTranscription: (id: string, messageId: string) =>
      request<{ data: MessageTranscription }>(
        `/conversations/${id}/messages/${encodeURIComponent(messageId)}/transcription/retry`,
        { method: 'POST' },
      ),
  },

  stats: {
    dataQuality: () =>
      request<{ data: DataQualitySummary }>('/stats/data-quality'),
  },

  ai: {
    process: (body: { limit?: number; contactKey?: string } = {}) =>
      request<{
        data: {
          enabled: boolean;
          provider: string;
          model: string;
          autoApply: boolean;
          enqueued: number;
          processed: number;
          failed: number;
          skipped: number;
          suggestions: number;
          applied: number;
          reason: string | null;
        };
      }>('/ai/process', { method: 'POST', body }),
    suggestions: (status = 'pending') =>
      request<{ data: AiSuggestion[] }>(
        `/ai/suggestions?status=${status}&limit=100`,
      ),
    usage: () => request<{ data: AiUsage }>('/ai/usage'),
    accept: (
      id: string,
      body: {
        fields?: Record<string, unknown>;
        pets?: Array<Record<string, unknown>>;
      },
    ) =>
      request<{ data: AiSuggestion & { applied: unknown } }>(
        `/ai/suggestions/${id}/accept`,
        { method: 'POST', body },
      ),
    reject: (id: string) =>
      request<{ data: { id: string; status: string } }>(
        `/ai/suggestions/${id}/reject`,
        { method: 'POST', body: {} },
      ),
  },

  appointmentRequests: {
    list: (params: { status?: string; contactKey?: string } = {}) =>
      request<Paginated<AppointmentRequest>>(
        `/appointment-requests${query({ ...params, limit: 100 })}`,
      ),
    update: (
      id: string,
      body: {
        status: string;
        appointmentId?: string | null;
        clientId?: number | null;
        petId?: string | null;
      },
    ) =>
      request<{ data: AppointmentRequest }>(`/appointment-requests/${id}`, {
        method: 'PATCH',
        body,
      }),
  },

  expenses: {
    list: (params: { from?: string; to?: string; category?: string } = {}) =>
      request<Paginated<Expense>>(
        `/expenses${query({ ...params, limit: 100 })}`,
      ),
    create: (body: Record<string, unknown>, idempotencyKey: string) =>
      request<{ data: Expense }>('/expenses', {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    update: (id: string, body: Record<string, unknown>, idempotencyKey: string) =>
      request<{ data: Expense }>(`/expenses/${id}`, {
        method: 'PATCH',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    remove: (id: string) =>
      request<{ data: { deleted: boolean } }>(`/expenses/${id}`, {
        method: 'DELETE',
      }),
  },

  sales: {
    list: (params: {
      from?: string;
      to?: string;
      status?: string;
      petId?: string;
      clientId?: number;
    } = {}) =>
      request<Paginated<SaleListRow>>(`/sales${query({ ...params, limit: 100 })}`),
    summary: (from?: string, to?: string) =>
      request<{ data: SaleSummary }>(`/sales/summary${query({ from, to })}`),
    get: (id: string) => request<{ data: Sale }>(`/sales/${id}`),
    create: (body: Record<string, unknown>, idempotencyKey: string) =>
      request<{ data: Sale }>('/sales', {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    update: (id: string, body: Record<string, unknown>, idempotencyKey: string) =>
      request<{ data: Sale }>(`/sales/${id}`, {
        method: 'PATCH',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    refund: (id: string, body: Record<string, unknown>, idempotencyKey: string) =>
      request<{ data: Sale }>(`/sales/${id}/refunds`, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    returnProducts: (
      id: string,
      body: Record<string, unknown>,
      idempotencyKey: string,
    ) =>
      request<{ data: Sale }>(`/sales/${id}/returns`, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    addPayment: (
      id: string,
      body: Record<string, unknown>,
      idempotencyKey: string,
    ) =>
      request<{ data: Sale }>(`/sales/${id}/payments`, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    void: (id: string, body: Record<string, unknown>, idempotencyKey: string) =>
      request<{ data: Sale }>(`/sales/${id}/void`, {
        method: 'POST',
        body,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    remove: (id: string) =>
      request<{ data: { id: string; deleted: boolean } }>(`/sales/${id}`, {
        method: 'DELETE',
      }),
  },
};
