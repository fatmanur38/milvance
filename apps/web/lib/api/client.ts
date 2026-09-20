import type { z } from 'zod';

/**
 * The single place the workspace talks to the Milvance read API.
 *
 * Every call validates its response against a schema, and every failure is
 * classified into something a person can act on. No component calls `fetch`
 * against the API directly.
 *
 * This client only READS chain-derived state. The one write it performs —
 * evidence metadata — is off-chain metadata, not financial state; financial
 * actions go through the user's wallet and Soroban, never through here.
 */

export const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001').replace(
  /\/+$/,
  '',
);

export type ApiErrorKind = 'unreachable' | 'not-found' | 'rejected' | 'server' | 'invalid-response';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A human explanation for each failure kind. Never a stack trace. */
export function describeApiError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return 'Something went wrong while loading workspace data.';
  }
  switch (error.kind) {
    case 'unreachable':
      return 'The Milvance workspace service is not reachable. Your funds are unaffected — they live on Stellar, not here.';
    case 'not-found':
      return 'This record is not in the workspace yet. If it was just created on Stellar, it may still be syncing.';
    case 'rejected':
      return error.message;
    case 'server':
      return 'The workspace service had a problem. Try again shortly.';
    case 'invalid-response':
      return 'The workspace service returned data this app does not recognise, so nothing is shown rather than something possibly wrong.';
  }
}

async function readMessage(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: unknown };
    return typeof body.message === 'string' ? body.message : `Request failed (${response.status})`;
  } catch {
    return `Request failed (${response.status})`;
  }
}

export async function apiRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${API_BASE_URL}/api${path}`, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('unreachable', 'The workspace service is not reachable.');
  }

  if (response.status === 404) {
    throw new ApiError('not-found', await readMessage(response), 404);
  }
  if (response.status >= 400 && response.status < 500) {
    throw new ApiError('rejected', await readMessage(response), response.status);
  }
  if (!response.ok) {
    throw new ApiError('server', `Request failed (${response.status})`, response.status);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('invalid-response', 'Response was not JSON.');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError('invalid-response', 'Response did not match the expected shape.');
  }
  return parsed.data;
}
