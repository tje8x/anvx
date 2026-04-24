export type ErrorKind =
  | 'anvx_unavailable' | 'policy_exceeded' | 'upstream_error' | 'upstream_timeout'
  | 'upstream_rate_limit' | 'invalid_model' | 'authentication_failed' | 'malformed_request'

export type ErrorEnvelope = {
  error: ErrorKind
  message: string
  request_id: string
  detail?: Record<string, unknown>
}

const KIND_TO_STATUS: Record<ErrorKind, number> = {
  anvx_unavailable: 503,
  policy_exceeded: 429,
  upstream_error: 502,
  upstream_timeout: 504,
  upstream_rate_limit: 429,
  invalid_model: 400,
  authentication_failed: 401,
  malformed_request: 400,
}

export function errorResponse(
  kind: ErrorKind, message: string, request_id: string, detail?: Record<string, unknown>
): { status: number; body: ErrorEnvelope } {
  return { status: KIND_TO_STATUS[kind], body: { error: kind, message, request_id, detail } }
}

export function safeMessage(kind: ErrorKind): string {
  switch (kind) {
    case 'anvx_unavailable': return 'ANVX is temporarily unavailable. Your request was not processed.'
    case 'policy_exceeded': return 'A policy limit was exceeded. See detail.policy_id.'
    case 'upstream_error': return 'The upstream provider returned an error.'
    case 'upstream_timeout': return 'The upstream provider did not respond within 60 seconds.'
    case 'upstream_rate_limit': return 'The upstream provider rate limit was hit.'
    case 'invalid_model': return 'The requested model is not in our catalog.'
    case 'authentication_failed': return 'The provided token is invalid, expired, or revoked.'
    case 'malformed_request': return 'Request body does not match the expected schema.'
  }
}
