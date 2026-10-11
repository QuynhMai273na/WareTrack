import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ErrorCode, ResetPasswordRequest, Role, ROLE_LABELS, UpdateUserRequest } from '@waretrack/shared-schemas';
import * as argon2 from 'argon2';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AuditService } from '../../platform/audit/audit.service';
import { RequirePermission } from '../../platform/auth/decorators';
import { DomainError } from '../../platform/errors/domain-error';
import { PrismaService, TxRunner } from '../../platform/prisma/prisma.service';
import { AccessService } from './access.service';
import { ARGON2_OPTIONS } from './auth.service';

class CreateUserDto extends createZodDto(
  z
    .object({
      username: z.string().regex(/^[a-z0-9._-]{3,40}$/),
      email: z.string().email(),
      fullName: z.string().min(2).max(120),
      tempPassword: z.string().min(12).max(200),
    })
    .strict(),
) {}

class GrantRoleDto extends createZodDto(
  z.object({ siteId: z.string().uuid().nullable(), roleCode: z.nativeEnum(Role) }).strict(),
) {}

class ReasonDto extends createZodDto(z.object({ reason: z.string().min(3).max(300) }).strict()) {}
class UpdateUserDto extends createZodDto(UpdateUserRequest) {}
class ResetPasswordDto extends createZodDto(ResetPasswordRequest) {}

/** Quản lý user và gán role theo site (UC-22). */
@ApiTags('Users & Roles')
@Controller()
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  @Get('users')
  @RequirePermission('identity.user.read')
  async list(@Query('q') q?: string) {
    const users = await this.prisma.user.findMany({
      where: q ? { OR: [{ username: { contains: q, mode: 'insensitive' } }, { fullName: { contains: q, mode: 'insensitive' } }] } : {},
      include: { siteRoles: { where: { revokedAt: null }, include: { role: true, site: true } } },
      orderBy: { username: 'asc' },
      take: 200,
    });
    return {
      items: users.map((u) => ({
        id: u.id,
        username: u.username,
        email: u.email,
        fullName: u.fullName,
        status: u.status,
        siteRoles: u.siteRoles.map((r) => ({ id: r.id, roleCode: r.role.code, siteId: r.siteId, siteCode: r.site?.code ?? null })),
      })),
      nextCursor: null,
    };
  }

  @Post('users')
  @RequirePermission('identity.user.manage')
  async create(@Body() body: CreateUserDto) {
    const passwordHash = await argon2.hash(body.tempPassword, ARGON2_OPTIONS);
    return this.tx.run(async (tx) => {
      const user = await tx.user.create({
        data: { username: body.username, email: body.email.toLowerCase(), fullName: body.fullName, passwordHash },
      });
      await this.audit.record(tx, { siteId: null, action: 'USER_CREATED', entityType: 'User', entityId: user.id, diff: { after: { username: user.username, email: user.email } } });
      return { id: user.id, username: user.username, email: user.email, fullName: user.fullName, status: user.status };
    });
  }

  @Patch('users/:userId')
  @RequirePermission('identity.user.manage')
  async update(@Param('userId') userId: string, @Body() body: UpdateUserDto) {
    const result = await this.tx.run(async (tx) => {
      const before = await tx.user.findUnique({ where: { id: userId }, include: { siteRoles: { where: { revokedAt: null }, include: { role: true } } } });
      if (!before) throw DomainError.notFound('User');
      const disablingAdmin = body.status === 'DISABLED' && before.siteRoles.some((assignment) => assignment.role.code === Role.ADMIN);
      if (disablingAdmin) {
        const activeAdmins = await tx.userSiteRole.count({ where: { revokedAt: null, role: { code: Role.ADMIN }, user: { status: 'ACTIVE' } } });
        if (activeAdmins <= 1) throw DomainError.rule(ErrorCode.LAST_ADMIN_PROTECTED, 'Cannot disable the last active admin');
      }
      const after = await tx.user.update({
        where: { id: userId },
        data: {
          ...(body.fullName ? { fullName: body.fullName } : {}),
          ...(body.email ? { email: body.email.toLowerCase() } : {}),
          ...(body.status ? { status: body.status, permissionVersion: { increment: 1 } } : {}),
          version: { increment: 1 },
        },
      });
      // Khóa tài khoản → thu hồi mọi phiên đang mở
      if (body.status === 'DISABLED') await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, {
        siteId: null,
        action: 'USER_UPDATED',
        entityType: 'User',
        entityId: userId,
        diff: { before: { fullName: before.fullName, email: before.email, status: before.status }, after: { fullName: after.fullName, email: after.email, status: after.status } },
      });
      return { id: after.id, username: after.username, email: after.email, fullName: after.fullName, status: after.status };
    });
    this.access.invalidateUser(userId);
    return result;
  }

  @Post('users/:userId/reset-password')
  @RequirePermission('identity.user.manage')
  @HttpCode(204)
  async resetPassword(@Param('userId') userId: string, @Body() body: ResetPasswordDto) {
    const passwordHash = await argon2.hash(body.tempPassword, ARGON2_OPTIONS);
    await this.tx.run(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw DomainError.notFound('User');
      await tx.user.update({ where: { id: userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null, status: user.status === 'LOCKED' ? 'ACTIVE' : user.status } });
      await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.record(tx, { siteId: null, action: 'USER_PASSWORD_RESET', entityType: 'User', entityId: userId });
    });
    this.access.invalidateUser(userId);
  }

  @Post('users/:userId/site-roles')
  @RequirePermission('identity.role.manage')
  async grant(@Param('userId') userId: string, @Body() body: GrantRoleDto) {
    const result = await this.tx.run(async (tx) => {
      const role = await tx.role.findUnique({ where: { code: body.roleCode } });
      if (!role) throw DomainError.notFound('Role');
      if (body.siteId && !(await tx.site.findFirst({ where: { id: body.siteId, deletedAt: null } }))) throw DomainError.notFound('Site');
      const assignment = await tx.userSiteRole.create({ data: { userId, roleId: role.id, siteId: body.siteId } });
      await tx.user.update({ where: { id: userId }, data: { permissionVersion: { increment: 1 } } });
      await this.audit.record(tx, {
        siteId: body.siteId,
        action: 'ROLE_GRANTED',
        entityType: 'User',
        entityId: userId,
        diff: { after: { roleCode: body.roleCode, siteId: body.siteId } },
        // DEC-34: gán Admin không cần duyệt kép nhưng ghi audit mức cao
        reason: body.roleCode === Role.ADMIN ? 'HIGH_SEVERITY: admin role granted' : null,
      });
      return { id: assignment.id, roleCode: role.code, siteId: assignment.siteId };
    });
    this.access.invalidateUser(userId);
    return result;
  }

  @Delete('users/:userId/site-roles/:assignmentId')
  @RequirePermission('identity.role.manage')
  @HttpCode(204)
  async revoke(@Param('userId') userId: string, @Param('assignmentId') assignmentId: string, @Body() body: ReasonDto) {
    await this.tx.run(async (tx) => {
      const assignment = await tx.userSiteRole.findFirst({ where: { id: assignmentId, userId, revokedAt: null }, include: { role: true } });
      if (!assignment) throw DomainError.notFound('Role assignment');
      if (assignment.role.code === Role.ADMIN) {
        const admins = await tx.userSiteRole.count({ where: { revokedAt: null, role: { code: Role.ADMIN }, user: { status: 'ACTIVE' } } });
        if (admins <= 1) throw DomainError.rule(ErrorCode.LAST_ADMIN_PROTECTED, 'Cannot revoke the last active admin');
      }
      await tx.userSiteRole.update({ where: { id: assignmentId }, data: { revokedAt: new Date() } });
      await tx.user.update({ where: { id: userId }, data: { permissionVersion: { increment: 1 } } });
      await this.audit.record(tx, {
        siteId: assignment.siteId,
        action: 'ROLE_REVOKED',
        entityType: 'User',
        entityId: userId,
        diff: { before: { roleCode: assignment.role.code, siteId: assignment.siteId } },
        reason: body.reason,
      });
    });
    this.access.invalidateUser(userId);
  }

  @Get('roles')
  @RequirePermission('identity.user.read')
  async roles() {
    const roles = await this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } }, orderBy: { code: 'asc' } });
    return roles.map((r) => ({
      code: r.code,
      name: r.name,
      label: ROLE_LABELS[r.code as Role] ?? { vi: r.name, en: r.name },
      permissions: r.permissions.map((p) => p.permission.code).sort(),
    }));
  }
}
