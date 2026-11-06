export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError(400, 'bad_request', message, details);

export const unauthorized = (message = 'No autenticado') =>
  new HttpError(401, 'unauthorized', message);

export const forbidden = (message = 'Sin permisos') =>
  new HttpError(403, 'forbidden', message);

export const notFound = (message = 'No encontrado') =>
  new HttpError(404, 'not_found', message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);

export const unprocessable = (message: string, details?: unknown) =>
  new HttpError(422, 'validation_error', message, details);

export const serviceUnavailable = (message: string, details?: unknown) =>
  new HttpError(503, 'service_unavailable', message, details);

/** Violación de un índice único detectada por la base (carrera entre peticiones). */
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE constraint failed/i.test(message);
}
