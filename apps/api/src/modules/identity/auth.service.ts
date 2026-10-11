import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { User } from '@prisma/client';
import { ErrorCode, type MeResponse } from '@waretrack/shared-schemas';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { uuidv7 } from 'uuidv7';
import { AuditService } from '../../platform/audit/audit.service';
import { env } from '../../platform/config/env';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, TxRunner } from '../../platform/prisma/prisma.service';
import { AccessService } from './access.service';

const MAX_FAILED = 5; // DEC-37
const LOCK_MINUTES = 15; // DEC-37

export const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;

export interface IssuedTokens {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

function hashToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

@Injectable()
export class AuthService {
  private dummy: Promise<string> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async login(username: string, password: string, meta: ClientMeta): Promise<{ user: User; tokens: IssuedTokens }> {
    const user = await this.prisma.user.findFirst({ where: { OR: [{ username }, { email: username.toLowerCase() }] } });
    if (!user) {
      await argon2.verify(await this.dummyHash(), password).catch(() => false); // cân bằng thời gian phản hồi
      throw new DomainError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid username or password');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new DomainError(403, ErrorCode.ACCOUNT_LOCKED, 'Account is temporarily locked', {
        lockedUntil: user.lockedUntil.toISOString(),
      });
    }
    const ok = user.status !== 'DISABLED' && (await argon2.verify(user.passwordHash, password));
    if (!ok) {
      await this.tx.run(async (tx) => {
        const failed = user.failedLoginCount + 1;
        const lock = failed >= MAX_FAILED;
        await tx.user.update({
          where: { id: user.id },
          data: {
            failedLoginCount: lock ? 0 : failed,
            lockedUntil: lock ? new Date(Date.now() + LOCK_MINUTES * 60_000) : user.lockedUntil,
          },
        });
        await this.audit.record(tx, {
          siteId: null,
          action: lock ? 'ACCOUNT_LOCKED' : 'LOGIN_FAILED',
          entityType: 'User',
          entityId: user.id,
          actorType: 'SYSTEM',
        });
      });
      throw new DomainError(401, ErrorCode.INVALID_CREDENTIALS, 'Invalid username or password');
    }
    const tokens = await this.tx.run(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
      await this.audit.record(tx, { siteId: null, action: 'LOGIN_SUCCEEDED', entityType: 'User', entityId: user.id, actorId: user.id, actorType: 'USER' });
      return this.issue(tx, user, uuidv7(), meta);
    });
    return { user, tokens };
  }

  async refresh(raw: string | undefined, meta: ClientMeta): Promise<{ user: User; tokens: IssuedTokens }> {
    if (!raw) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Missing refresh token');
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(raw) }, include: { user: true } });
    if (!existing) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Invalid refresh token');
    if (existing.revokedAt) {
      // Token đã xoay bị dùng lại → nghi bị đánh cắp: thu hồi cả family (mục 19.1)
      await this.tx.run(async (tx) => {
        await tx.refreshToken.updateMany({ where: { familyId: existing.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
        await this.audit.record(tx, { siteId: null, action: 'REFRESH_TOKEN_REUSE_DETECTED', entityType: 'User', entityId: existing.userId, actorType: 'SYSTEM' });
      });
      throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Refresh token was already used');
    }
    if (existing.expiresAt < new Date()) throw new DomainError(401, ErrorCode.TOKEN_EXPIRED, 'Refresh token expired');
    if (existing.user.status !== 'ACTIVE') throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Account is not active');

    const tokens = await this.tx.run(async (tx) => {
      const revoked = await tx.refreshToken.updateMany({ where: { id: existing.id, revokedAt: null }, data: { revokedAt: new Date() } });
      if (revoked.count === 0) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Refresh token was already used');
      const issued = await this.issue(tx, existing.user, existing.familyId, meta);
      return issued;
    });
    return { user: existing.user, tokens };
  }

  async logout(raw: string | undefined) {
    if (!raw) return;
    await this.prisma.refreshToken.updateMany({ where: { tokenHash: hashToken(raw), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async logoutAll(userId: string) {
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async me(userId: string): Promise<MeResponse> {
    const access = await this.access.getUserAccess(userId);
    if (!access) throw new DomainError(401, ErrorCode.UNAUTHENTICATED, 'Account not found');
    const siteIds = await this.access.allowedSiteIds(access);
    const sites = await this.prisma.site.findMany({ where: { id: { in: siteIds } }, orderBy: { code: 'asc' } });
    const enterpriseRoles = access.assignments.filter((assignment) => assignment.siteId === null).map((assignment) => assignment.roleCode);
    return {
      user: { id: access.userId, username: access.username, fullName: access.fullName },
      enterpriseRoles,
      enterprisePermissions: [...(await this.access.permissionsAt({ ...access, assignments: access.assignments.filter((assignment) => assignment.siteId === null) }, null))],
      sites: await Promise.all(
        sites.map(async (site) => ({
          id: site.id,
          code: site.code,
          name: site.name,
          roles: this.access.rolesAt(access, site.id),
          permissions: [...(await this.access.permissionsAt(access, site.id))],
        })),
      ),
      permissionVersion: access.permissionVersion,
    };
  }

  private dummyHash(): Promise<string> {
    this.dummy ??= argon2.hash('waretrack-dummy-password', ARGON2_OPTIONS);
    return this.dummy;
  }

  private async issue(tx: Parameters<Parameters<TxRunner['run']>[0]>[0], user: User, familyId: string, meta: ClientMeta): Promise<IssuedTokens> {
    const environment = env();
    const accessToken = await this.jwt.signAsync({ sub: user.id, pv: user.permissionVersion, sid: familyId });
    const refreshToken = randomBytes(32).toString('base64url');
    const refreshExpiresAt = new Date(Date.now() + environment.REFRESH_TOKEN_TTL_DAYS * 86_400_000);
    await tx.refreshToken.create({
      data: { userId: user.id, tokenHash: hashToken(refreshToken), familyId, expiresAt: refreshExpiresAt, ip: meta.ip, userAgent: meta.userAgent },
    });
    return { accessToken, expiresIn: environment.ACCESS_TOKEN_TTL_SECONDS, refreshToken, refreshExpiresAt };
  }
}
