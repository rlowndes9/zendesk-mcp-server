/**
 * Helpers that produce the standard response envelope shape documented in
 * docs/PRD.md "API contract, response envelope".
 *
 *   success: { ok: true, instance, fetched_at, cached_at, data }
 *   error:   { ok: false, instance, error: { code, message, ... } }
 *
 * Mapping HTTP/RateLimitedHttpClient errors → envelope error codes happens
 * via `fromError(err, instance)`.
 */

const VALID_CODES = new Set([
  'rate_limited',
  'not_found',
  'auth_failed',
  'instance_unknown',
  'bad_request',
  'upstream_error',
  'timeout',
  'validation_error',
  'scope_blocked',
]);

export function success(instance, data, { fetched_at, cached_at } = {}) {
  return {
    ok: true,
    instance: instance ?? null,
    fetched_at: fetched_at ?? new Date().toISOString(),
    cached_at: cached_at ?? null,
    data,
  };
}

export function error(instance, code, message, extras = {}) {
  const safeCode = VALID_CODES.has(code) ? code : 'upstream_error';
  return {
    ok: false,
    instance: instance ?? null,
    error: {
      code: safeCode,
      message: message || 'An error occurred',
      ...extras,
    },
  };
}

/**
 * Convert any thrown error into an envelope. Recognizes errors thrown by
 * RateLimitedHttpClient (which carry a `code`) and by InstanceSession
 * (`code = "instance_unknown"`). Falls back to `upstream_error`.
 */
export function fromError(err, instance) {
  if (!err) return error(instance, 'upstream_error', 'Unknown error');
  const code = VALID_CODES.has(err.code) ? err.code : 'upstream_error';
  const extras = {};
  if (err.http_status !== undefined) extras.http_status = err.http_status;
  if (err.retry_after !== undefined && err.retry_after !== null) {
    extras.retry_after = err.retry_after;
  }
  if (err.available !== undefined) extras.available = err.available;
  return error(instance, code, err.message, extras);
}
