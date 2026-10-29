export interface ApiFieldErrors {
  [field: string]: string[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: ApiFieldErrors;

  constructor(status: number, code: string, message: string, details?: ApiFieldErrors) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const UNAUTHORIZED_EVENT = 'erp:unauthorized';

/**
 * Thin fetch wrapper. Sends cookies, parses the API error envelope, and emits a
 * global event on session expiry so the auth provider can reset state.
 */
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });

  if (response.status === 204) return undefined as T;

  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json') ? await response.json() : null;

  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const error = (body as { error?: { code?: string; message?: string; details?: ApiFieldErrors } })
      ?.error;
    throw new ApiError(
      response.status,
      error?.code ?? 'request_failed',
      error?.message ?? 'The request could not be completed',
      error?.details,
    );
  }

  return body as T;
}

export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

export function fieldErrors(error: unknown): ApiFieldErrors {
  return error instanceof ApiError && error.details ? error.details : {};
}
