import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ALL_PERMISSIONS, PERMISSION_MATRIX, Role, ROLE_LABELS } from '@waretrack/shared-schemas';
import * as argon2 from 'argon2';
import { env } from '../../platform/config/env';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { AccessService } from './access.service';
import { ARGON2_OPTIONS } from './auth.service';

/**
 * Dữ liệu tham chiếu cho hệ thống chạy thật (không phụ thuộc seed demo):
 * - đồng bộ permission, role và ma trận role → permission từ PERMISSION_MATRIX mỗi lần khởi động (thêm quyền mới tự có);
 * - database chưa có user nào + có BOOTSTRAP_ADMIN_* → tạo admin cấp doanh nghiệp đầu tiên.
 */
@Injectable()
export class ReferenceDataService implements OnApplicationBootstrap {
  private readonly logger = new Logger(ReferenceDataService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  async onApplicationBootstrap() {
    try {
      await this.syncRolesAndPermissions();
      await this.bootstrapFirstAdmin();
    } catch (error) {
      this.logger.error(`Reference data sync failed: ${(error as Error).message}`);
    }
  }

  async syncRolesAndPermissions() {
    const permissionIds = new Map<string, string>();
    for (const permissionCode of ALL_PERMISSIONS) {
      const permission = await this.prisma.permission.upsert({
        where: { code: permissionCode },
        create: { code: permissionCode, module: permissionCode.split('.')[0] },
        update: {},
      });
      permissionIds.set(permissionCode, permission.id);
    }
    let grantsAdded = 0;
    for (const roleCode of Object.values(Role)) {
      const role = await this.prisma.role.upsert({ where: { code: roleCode }, create: { code: roleCode, name: ROLE_LABELS[roleCode].en }, update: {} });
      const expected = ALL_PERMISSIONS.filter((permissionCode) => (PERMISSION_MATRIX[permissionCode] as readonly string[]).includes(roleCode));
      const current = await this.prisma.rolePermission.findMany({ where: { roleId: role.id }, select: { permissionId: true } });
      const currentIds = new Set(current.map((grant) => grant.permissionId));
      const missing = expected.map((permissionCode) => permissionIds.get(permissionCode)!).filter((permissionId) => !currentIds.has(permissionId));
      if (missing.length) {
        await this.prisma.rolePermission.createMany({ data: missing.map((permissionId) => ({ roleId: role.id, permissionId })), skipDuplicates: true });
        grantsAdded += missing.length;
      }
    }
    if (grantsAdded > 0) {
      this.access.invalidateRolePermissions();
      this.logger.log(`Granted ${grantsAdded} new role permissions from the RBAC matrix`);
    }
  }

  private async bootstrapFirstAdmin() {
    const config = env();
    if (!config.BOOTSTRAP_ADMIN_USERNAME || !config.BOOTSTRAP_ADMIN_PASSWORD) return;
    if ((await this.prisma.user.count()) > 0) return;
    const adminRole = await this.prisma.role.findUniqueOrThrow({ where: { code: Role.ADMIN } });
    const passwordHash = await argon2.hash(config.BOOTSTRAP_ADMIN_PASSWORD, ARGON2_OPTIONS);
    const admin = await this.prisma.user.create({
      data: {
        username: config.BOOTSTRAP_ADMIN_USERNAME,
        email: config.BOOTSTRAP_ADMIN_EMAIL ?? `${config.BOOTSTRAP_ADMIN_USERNAME}@waretrack.local`,
        fullName: config.BOOTSTRAP_ADMIN_FULL_NAME ?? 'System Administrator',
        passwordHash,
        siteRoles: { create: { roleId: adminRole.id, siteId: null } },
      },
    });
    this.logger.log(`Created first administrator "${admin.username}" — change the password after signing in`);
  }
}
