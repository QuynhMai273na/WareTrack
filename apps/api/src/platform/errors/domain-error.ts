import { ErrorCode } from '@waretrack/shared-schemas';
import type { Blocker } from '@waretrack/shared-schemas';

/**
 * Lỗi nghiệp vụ / HTTP có mã ổn định (mục 16.2).
 * 409 = xung đột trạng thái/đồng thời; 422 = vi phạm quy tắc nghiệp vụ.
 */
export class DomainError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }

  static notFound(entity = 'Resource') {
    return new DomainError(404, ErrorCode.NOT_FOUND, `${entity} not found`);
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new DomainError(403, ErrorCode.FORBIDDEN, message);
  }

  static concurrent() {
    return new DomainError(
      409,
      ErrorCode.CONCURRENT_MODIFICATION,
      'The resource was modified by someone else. Reload and try again.',
    );
  }

  static invalidTransition(entity: string, from: string, to: string) {
    return new DomainError(409, ErrorCode.INVALID_STATE_TRANSITION, `${entity} cannot move from ${from} to ${to}`, {
      from,
      to,
    });
  }

  static conflict(code: string, message: string, details?: Record<string, unknown>) {
    return new DomainError(409, code, message, details);
  }

  static rule(code: string, message: string, details?: Record<string, unknown>) {
    return new DomainError(422, code, message, details);
  }

  static blocked(code: string, message: string, blockers: Blocker[]) {
    return new DomainError(422, code, message, { blockers });
  }
}
