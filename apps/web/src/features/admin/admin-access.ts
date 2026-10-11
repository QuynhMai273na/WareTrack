import { useAuth } from '@/stores/auth';

/** Quyền tối thiểu để vào khu quản trị (một trong các quyền quản trị danh mục / site / user). */
export const ADMIN_PERMISSIONS = ['site.manage', 'layout.manage', 'identity.user.manage', 'master.sku.manage', 'master.partner.manage', 'equipment.manage'] as const;

export function useCanAdminister() {
  const can = useAuth((state) => state.can);
  return ADMIN_PERMISSIONS.some((permission) => can(undefined, permission));
}
