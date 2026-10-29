import type { RpcError } from './types';

export type RpcErrorCode = RpcError['code'];

const KNOWN_CODES: ReadonlySet<string> = new Set<RpcErrorCode>([
  'not_found', 'permission_denied', 'already_exists', 'not_a_directory', 'is_a_directory',
  'directory_not_empty', 'unsupported', 'invalid_input', 'auth_failed', 'host_key_rejected',
  'cancelled', 'connection_lost', 'timeout', 'protocol', 'io', 'locked', 'other',
  'unknown_method', 'unauthorized', 'forbidden',
]);

/** Error thrown by `call()`. Always carries a contract error code. */
export class RpcCallError extends Error implements RpcError {
  readonly code: RpcErrorCode;
  method?: string;

  constructor(code: RpcErrorCode, message: string, method?: string) {
    super(message);
    this.name = 'RpcCallError';
    this.code = code;
    this.method = method;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Turns whatever a transport rejected with (RpcError object, JSON string, plain string, Error) into an RpcCallError. */
export function normalizeError(e: unknown, method?: string): RpcCallError {
  if (e instanceof RpcCallError) {
    if (method && !e.method) e.method = method;
    return e;
  }
  if (typeof e === 'string') {
    const s = e.trim();
    if (s.startsWith('{')) {
      try {
        return normalizeError(JSON.parse(s), method);
      } catch {
        /* fall through */
      }
    }
    return new RpcCallError('other', s || 'Unknown error', method);
  }
  if (isRecord(e)) {
    // { error: {...} } wrappers
    if (isRecord(e.error) && !('code' in e)) return normalizeError(e.error, method);
    const code = typeof e.code === 'string' && KNOWN_CODES.has(e.code) ? (e.code as RpcErrorCode) : 'other';
    const message =
      typeof e.message === 'string'
        ? e.message
        : typeof e.error === 'string'
          ? e.error
          : e instanceof Error
            ? e.message
            : JSON.stringify(e);
    return new RpcCallError(code, message, method);
  }
  if (e instanceof Error) return new RpcCallError('other', e.message, method);
  return new RpcCallError('other', String(e), method);
}

export function isCancelled(e: unknown): boolean {
  return e instanceof RpcCallError && e.code === 'cancelled';
}
