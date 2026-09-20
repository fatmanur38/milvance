/**
 * HTTP hardening for the API process.
 *
 * Kept out of `main.ts` because that module boots the server as a side effect:
 * anything importing it starts listening, which makes these rules untestable
 * and makes a stray import a running process.
 */

/**
 * Response headers for a JSON API.
 *
 * No Content-Security-Policy here: this origin serves no HTML, and the web app
 * is a separate deployment whose own CSP must not be weakened to accommodate a
 * wallet extension.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-site',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

/**
 * Which browser origins may call this API.
 *
 * Defaults to local development. In production the deployment supplies the
 * real web origin, or several, separated by commas. A wildcard is deliberately
 * impossible: the value is always an explicit list.
 */
export function allowedOrigins(configured: string | undefined): string[] {
  const listed = (configured ?? 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '' && origin !== '*');
  const valid = listed.filter((origin) => {
    try {
      const url = new URL(origin);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin;
    } catch {
      return false;
    }
  });
  return valid.length > 0 ? valid : ['http://localhost:3000'];
}
