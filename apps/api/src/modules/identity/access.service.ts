import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../platform/prisma/prisma.service';

export interface UserAccess {
  userId: string;
  username: string;
  fullName: string;
  status: string;
  permissionVersion: number;
  /** siteId null = role cấp doanh nghiệp, áp dụng mọi site. */
  assignments: Array<{ siteId: string | null; roleCode: string }>;
  loadedAt: number;
}

const USER_TTL_MS = 30_000;
const ROLE_TTL_MS = 60_000;

/**
 * Tính permission hiệu lực theo site (mục 10.1): hợp permission của mọi role user có tại site
 * và role cấp doanh nghiệp. Cache ngắn hạn; xóa cache khi đổi quyền (mục 19.2).
 */
@Injectable()
export class AccessService {
  private users = new Map<string, UserAccess>();
  private rolePerms: { map: Map<string, Set<string>>; loadedAt: number } | null = null;
  private siteIds: { ids: string[]; loadedAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  private readonly userChangedListeners: Array<(userId: string) => void> = [];

  /** Realtime gateway đăng ký để ngắt room khi quyền thay đổi (mục 17.1, UC-22-AC2). */
  onUserAccessChanged(listener: (userId: string) => void) {
    this.userChangedListeners.push(listener);
  }

  invalidateUser(userId: string) {
    this.users.delete(userId);
    for (const l of this.userChangedListeners) l(userId);
  }

  invalidateSites() {
    this.siteIds = null;
  }

  async getUserAccess(userId: string): Promise<UserAccess | null> {
    const cached = this.users.get(userId);
    if (cached && Date.now() - cached.loadedAt < USER_TTL_MS) return cached;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { siteRoles: { where: { revokedAt: null }, include: { role: true } } },
    });
    if (!user) return null;
    const access: UserAccess = {
      userId: user.id,
      username: user.username,
      fullName: user.fullName,
      status: user.status,
      permissionVersion: user.permissionVersion,
      assignments: user.siteRoles.map((r) => ({ siteId: r.siteId, roleCode: r.role.code })),
      loadedAt: Date.now(),
    };
    this.users.set(userId, access);
    return access;
  }

  private async rolePermissionMap(): Promise<Map<string, Set<string>>> {
    if (this.rolePerms && Date.now() - this.rolePerms.loadedAt < ROLE_TTL_MS) return this.rolePerms.map;
    const roles = await this.prisma.role.findMany({ include: { permissions: { include: { permission: true } } } });
    const map = new Map(roles.map((r) => [r.code, new Set(r.permissions.map((p) => p.permission.code))]));
    this.rolePerms = { map, loadedAt: Date.now() };
    return map;
  }

  private async allSiteIds(): Promise<string[]> {
    if (this.siteIds && Date.now() - this.siteIds.loadedAt < ROLE_TTL_MS) return this.siteIds.ids;
    const sites = await this.prisma.site.findMany({ where: { deletedAt: null }, select: { id: true } });
    this.siteIds = { ids: sites.map((s) => s.id), loadedAt: Date.now() };
    return this.siteIds.ids;
  }

  rolesAt(access: UserAccess, siteId: string | null): string[] {
    return [...new Set(access.assignments.filter((a) => a.siteId === null || a.siteId === siteId).map((a) => a.roleCode))];
  }

  async permissionsAt(access: UserAccess, siteId: string | null): Promise<Set<string>> {
    const map = await this.rolePermissionMap();
    const perms = new Set<string>();
    for (const role of this.rolesAt(access, siteId)) {
      for (const p of map.get(role) ?? []) perms.add(p);
    }
    return perms;
  }

  /** Hợp permission của mọi role user có (mọi site + doanh nghiệp). */
  async permissionsAnySite(access: UserAccess): Promise<Set<string>> {
    const map = await this.rolePermissionMap();
    const perms = new Set<string>();
    for (const a of access.assignments) for (const p of map.get(a.roleCode) ?? []) perms.add(p);
    return perms;
  }

  /** Site user được phép truy cập (role tại site hoặc role cấp doanh nghiệp). */
  async allowedSiteIds(access: UserAccess): Promise<string[]> {
    let all = await this.allSiteIds();
    const own = new Set(access.assignments.map((a) => a.siteId).filter((s): s is string => !!s));
    // Site mới tạo (hoặc DB vừa seed lại) chưa có trong cache → nạp lại một lần
    if ([...own].some((id) => !all.includes(id))) {
      this.invalidateSites();
      all = await this.allSiteIds();
    }
    if (access.assignments.some((a) => a.siteId === null)) return all;
    return all.filter((id) => own.has(id));
  }

  async canAccessSite(access: UserAccess, siteId: string): Promise<boolean> {
    return (await this.allowedSiteIds(access)).includes(siteId);
  }
}
