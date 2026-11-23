// Request correlation: one id per request, shared by the proxy's access log,
// the application's error and security log lines, and the X-Request-Id response
// header a support person can quote. No server-only imports: the proxy loads it.

export const REQUEST_ID_HEADER = "x-request-id";
/** An id supplied by nginx ($request_id is 32 hex characters) or a caller. Anything else is replaced. */
const ACCEPTABLE = /^[A-Za-z0-9-]{8,64}$/;
export function requestIdFrom(supplied: string | null | undefined) {
  return supplied && ACCEPTABLE.test(supplied) ? supplied : crypto.randomUUID();
}
