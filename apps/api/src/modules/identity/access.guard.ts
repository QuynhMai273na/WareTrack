import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ErrorCode } from '@waretrack/shared-schemas';
import type { Request } from 'express';
import { IS_PUBLIC, REQUIRED_PERMISSION } from '../../platform/auth/decorators';
import { currentContext } from '../../platform/context/request-context';
import { DomainError } from '../../platform/errors/domain-error';
import { AccessService } from './access.service';

export interface AccessTokenPayload {
  sub: string;
  pv: number;
  sid: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guard toàn cục, gộp JwtAuthGuard → SiteScopeGuard → PermissionGuard (mục 10.4, 19.2).
 * Site không có quyền hoặc không tồn tại → 404 (không lộ sự tồn tại — BR-33).
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly access: AccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Authentication required');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token);
    } catch (err) {
      const expired = (err as Error).name === 'TokenExpiredError';
      throw new DomainError(401, expired ? ErrorCode.TOKEN_EXPIRED : ErrorCode.UNAUTHENTICATED, expired ? 'Access token expired' : 'Invalid access token');
    }

    const access = await this.access.getUserAccess(payload.sub);
    if (!access || access.status !== 'ACTIVE') {
      throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Account is not active');
    }
    if (payload.pv !== access.permissionVersion) {
      throw new DomainError(403, ErrorCode.PERMISSION_VERSION_STALE, 'Permissions changed — refresh your session');
    }

    const siteId = (req.params?.siteId as string | undefined) ?? null;
    if (siteId !== null) {
      if (!UUID_RE.test(siteId) || !(await this.access.canAccessSite(access, siteId))) throw DomainError.notFound('Site');
    }
    // Endpoint cấp doanh nghiệp (không có :siteId): permission tính là hợp quyền ở mọi site được phép
    // ("có quyền ở ≥ 1 site" — mục 16.4.8); site-scoped vẫn chỉ xét site của route.
    const permissions = siteId !== null ? await this.access.permissionsAt(access, siteId) : await this.access.permissionsAnySite(access);
    const required = this.reflector.getAllAndOverride<string>(REQUIRED_PERMISSION, targets);
    if (required && !permissions.has(required)) throw DomainError.forbidden();

    const ctx = currentContext();
    if (ctx) {
      ctx.principal = {
        userId: access.userId,
        username: access.username,
        fullName: access.fullName,
        siteId,
        permissions,
        roles: this.access.rolesAt(access, siteId),
      };
    }
    return true;
  }
}
