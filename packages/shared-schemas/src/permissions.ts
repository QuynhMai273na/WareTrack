/**
 * Danh mục permission và ánh xạ role → permission theo ma trận RBAC (mục 10.2, DEC-35).
 * Ô "○" (có điều kiện) được cấp permission; điều kiện được kiểm tra bằng cấu hình site
 * trong application service (ví dụ warehouseCanAssignDock — DEC-32, selfAssign — DEC-33).
 */
export const Role = {
  ADMIN: 'ADMIN',
  SITE_MANAGER: 'SITE_MANAGER',
  YARD_DISPATCHER: 'YARD_DISPATCHER',
  GATE_SECURITY: 'GATE_SECURITY',
  WAREHOUSE_SUPERVISOR: 'WAREHOUSE_SUPERVISOR',
  WAREHOUSE_OPERATOR: 'WAREHOUSE_OPERATOR',
  FORKLIFT_OPERATOR: 'FORKLIFT_OPERATOR',
  INVENTORY_CONTROLLER: 'INVENTORY_CONTROLLER',
  VIEWER: 'VIEWER',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

const ADM = Role.ADMIN;
const SM = Role.SITE_MANAGER;
const YD = Role.YARD_DISPATCHER;
const GS = Role.GATE_SECURITY;
const WS = Role.WAREHOUSE_SUPERVISOR;
const WO = Role.WAREHOUSE_OPERATOR;
const FO = Role.FORKLIFT_OPERATOR;
const IC = Role.INVENTORY_CONTROLLER;
const VW = Role.VIEWER;
const ALL = [ADM, SM, YD, GS, WS, WO, FO, IC, VW];

export const PERMISSION_MATRIX = {
  'identity.user.read': [ADM, SM],
  'identity.user.manage': [ADM],
  'identity.role.manage': [ADM],
  'site.read': ALL,
  'site.manage': [ADM],
  'site.settings.manage': [ADM, SM],
  'location.manage': [ADM, SM],
  'location.block': [ADM, SM, YD, WS],
  'layout.manage': [ADM, SM],
  'master.sku.manage': [ADM, SM, WS, IC],
  'master.partner.manage': [ADM, SM, YD, WS],
  'yard.visit.read': [ADM, SM, YD, GS, WS, WO, FO, VW],
  'yard.appointment.manage': [ADM, SM, YD, WS],
  'yard.visit.gate_in': [SM, YD, GS],
  'yard.visit.create_walkin': [SM, YD, GS],
  'yard.visit.reject': [SM, YD, GS],
  'yard.dock.assign': [SM, YD, WS],
  'yard.visit.update': [SM, YD, WS, WO],
  'yard.visit.abort': [SM, YD],
  'yard.visit.gate_out': [SM, YD, GS],
  'yard.visit.force_exit': [SM],
  'vehicle.read': ALL,
  'vehicle.receive': [SM, YD, GS],
  'vehicle.inspect': [SM, YD],
  'vehicle.slot.assign': [SM, YD],
  'vehicle.move': [SM, YD, WO],
  'vehicle.release.request': [SM, YD],
  'vehicle.release.approve': [SM],
  'vehicle.hold.manage': [SM],
  'vehicle.gate_out': [SM, YD, GS],
  'inventory.read': [ADM, SM, YD, WS, WO, FO, IC, VW],
  'inventory.move': [SM, WS, WO, FO],
  'inventory.status.change': [SM, WS, IC],
  'inventory.status.release': [SM],
  'inventory.capacity.override': [SM, WS],
  'inventory.adjust.request': [SM, WS, IC],
  'inventory.adjust.approve': [SM, WS],
  'inventory.reversal': [SM],
  'inventory.count.manage': [SM, WS, IC],
  'inventory.count.execute': [WS, WO, IC],
  'inventory.opening.import': [ADM, SM, IC],
  'inbound.order.manage': [SM, WS],
  'inbound.receive': [SM, WS, WO],
  'inbound.qc': [SM, WS],
  'inbound.discrepancy.approve': [SM, WS],
  'outbound.order.manage': [SM, WS],
  'outbound.reserve': [SM, WS],
  'outbound.pick': [SM, WS, WO, FO],
  'outbound.load': [SM, WS, WO, FO],
  'outbound.dispatch': [SM, WS],
  'outbound.dispatch.reverse': [SM],
  'shipment.read': ALL,
  'shipment.manage': [SM, YD, WS],
  'shipment.deliver': [SM, WS],
  'equipment.read': [ADM, SM, YD, WS, WO, FO, VW],
  'equipment.manage': [ADM, SM, WS],
  'equipment.status.update': [SM, WS, FO],
  'device.manage': [ADM, SM],
  'task.read': [ADM, SM, YD, WS, WO, FO, IC, VW],
  'task.assign': [SM, YD, WS, FO],
  'task.execute': [YD, WS, WO, FO, IC],
  'task.cancel': [SM, YD, WS],
  'exception.read': ALL,
  'exception.create': [SM, YD, GS, WS, WO, FO, IC],
  'exception.resolve': [SM, YD, WS, IC],
  'dashboard.read': ALL,
  'audit.read': [ADM, SM],
  'report.export': [ADM, SM, YD, WS, IC],
  'notification.read': ALL,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSION_MATRIX;
export const ALL_PERMISSIONS = Object.keys(PERMISSION_MATRIX) as Permission[];

export function permissionsForRole(role: Role): Permission[] {
  return ALL_PERMISSIONS.filter((permission) => (PERMISSION_MATRIX[permission] as readonly Role[]).includes(role));
}

export const ROLE_LABELS: Record<Role, { vi: string; en: string }> = {
  ADMIN: { vi: 'Quản trị hệ thống', en: 'Admin' },
  SITE_MANAGER: { vi: 'Quản lý site', en: 'Site Manager' },
  YARD_DISPATCHER: { vi: 'Điều phối bãi', en: 'Yard Dispatcher' },
  GATE_SECURITY: { vi: 'Bảo vệ cổng', en: 'Gate Security' },
  WAREHOUSE_SUPERVISOR: { vi: 'Giám sát kho', en: 'Warehouse Supervisor' },
  WAREHOUSE_OPERATOR: { vi: 'Nhân viên kho', en: 'Warehouse Operator' },
  FORKLIFT_OPERATOR: { vi: 'Lái xe nâng', en: 'Forklift Operator' },
  INVENTORY_CONTROLLER: { vi: 'Kiểm soát tồn kho', en: 'Inventory Controller' },
  VIEWER: { vi: 'Người xem', en: 'Viewer' },
};
