import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Permission } from '@waretrack/shared-schemas';
import { currentContext, type Principal } from '../context/request-context';
import { DomainError } from '../errors/domain-error';

export const IS_PUBLIC = 'wt:isPublic';
export const REQUIRED_PERMISSION = 'wt:permission';
export const SKIP_IDEMPOTENCY = 'wt:skipIdempotency';

/** Endpoint không cần đăng nhập. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Permission bắt buộc tại site của route (mục 10.4). */
export const RequirePermission = (permission: Permission) => SetMetadata(REQUIRED_PERMISSION, permission);

/** Bỏ yêu cầu header Idempotency-Key cho một POST/DELETE (ví dụ auth). */
export const SkipIdempotency = () => SetMetadata(SKIP_IDEMPOTENCY, true);

export const CurrentUser = createParamDecorator((_data: unknown, _ctx: ExecutionContext): Principal => {
  const principal = currentContext()?.principal;
  if (!principal) throw new DomainError(401, 'UNAUTHENTICATED', 'Authentication required');
  return principal;
});

export function requirePrincipal(): Principal {
  const principal = currentContext()?.principal;
  if (!principal) throw new DomainError(401, 'UNAUTHENTICATED', 'Authentication required');
  return principal;
}
