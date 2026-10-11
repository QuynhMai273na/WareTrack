import { useQuery } from '@tanstack/react-query';
import type {
  AdjustmentDto,
  AvailabilityDto,
  BalanceDto,
  HandlingUnitDetail,
  InboundOrderDetail,
  InventoryTxDto,
  LocationDto,
  OutboundOrderDetail,
  PublishedLayout,
  ReceiptDetail,
  ShipmentDetail,
  ShipmentRow,
  SiteSnapshot,
  SiteSummary,
  SkuDto,
  TaskDto,
  VehicleHistoryEntry,
  VehicleStayDto,
  VisitDetail,
  VisitRow,
} from '@waretrack/shared-schemas';
import { api } from './api';

/** Chế độ chạy của API: demo/live (màn đăng nhập) và auto/manual (xe nâng 3D chạy vòng hay chỉ chạy khi có thao tác). */
export type RunInfo = { mode: 'demo' | 'live'; motion: 'auto' | 'manual' };
export const useRunInfo = () => useQuery({ queryKey: ['health', 'info'], queryFn: () => api<RunInfo>('/health/info'), staleTime: Infinity });

/** Query key theo mục 17.7 — luôn có siteId để không lẫn dữ liệu giữa các site. */
export const useSites = () => useQuery({ queryKey: ['sites'], queryFn: () => api<SiteSummary[]>('/sites'), staleTime: 30_000 });

export const useSnapshot = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'snapshot'], queryFn: () => api<SiteSnapshot>(`/sites/${siteId}/snapshot`), enabled: !!siteId, staleTime: Infinity });

export const useLayout = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'layout'], queryFn: () => api<PublishedLayout>(`/sites/${siteId}/layout`), enabled: !!siteId, staleTime: Infinity, retry: false });

export const useVisits = (siteId: string | undefined, status?: string) =>
  useQuery({
    queryKey: ['site', siteId, 'visits', status ?? 'all'],
    queryFn: () => api<VisitRow[]>(`/sites/${siteId}/visits${status ? `?status=${status}` : ''}`),
    enabled: !!siteId,
  });

export const useVisit = (siteId: string | undefined, visitId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'visit', visitId], queryFn: () => api<VisitDetail>(`/sites/${siteId}/visits/${visitId}`), enabled: !!siteId && !!visitId });

export const useDockLocations = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'docks', 'locations'], queryFn: () => api<LocationDto[]>(`/sites/${siteId}/locations?type=DOCK`), enabled: !!siteId });

// Inventory — mọi key bắt đầu bằng ['site', siteId, 'inventory'] để event inventory.updated invalidate một lần (mục 17.7)
export const useAvailability = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'inventory', 'availability'], queryFn: () => api<AvailabilityDto[]>(`/sites/${siteId}/inventory/availability`), enabled: !!siteId });

export const useBalances = (siteId: string | undefined, searchQuery: string) =>
  useQuery({ queryKey: ['site', siteId, 'inventory', 'balances', searchQuery], queryFn: () => api<BalanceDto[]>(`/sites/${siteId}/inventory/balances${searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : ''}`), enabled: !!siteId });

export const usePallet = (siteId: string | undefined, huId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'inventory', 'pallet', huId], queryFn: () => api<HandlingUnitDetail>(`/sites/${siteId}/pallets/${huId}`), enabled: !!siteId && !!huId });

export const useLedger = (siteId: string | undefined, huId?: string) =>
  useQuery({ queryKey: ['site', siteId, 'inventory', 'ledger', huId ?? 'all'], queryFn: () => api<InventoryTxDto[]>(`/sites/${siteId}/inventory/transactions${huId ? `?huId=${huId}` : ''}`), enabled: !!siteId });

export const useAdjustments = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'inventory', 'adjustments'], queryFn: () => api<AdjustmentDto[]>(`/sites/${siteId}/inventory/adjustments`), enabled: !!siteId });

export const useStorageLocations = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'inventory', 'locations'], queryFn: () => api<LocationDto[]>(`/sites/${siteId}/locations?type=STORAGE,STAGING,QUARANTINE`), enabled: !!siteId });

// Phase 4 — shipments, đơn nhập/xuất, task
export const useShipment = (siteId: string | undefined, id: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'shipment', id], queryFn: () => api<ShipmentDetail>(`/sites/${siteId}/shipments/${id}`), enabled: !!siteId && !!id });

export const useShipments = (siteId: string | undefined, direction?: 'INBOUND' | 'OUTBOUND') =>
  useQuery({ queryKey: ['site', siteId, 'shipments', direction ?? 'all'], queryFn: () => api<ShipmentRow[]>(`/sites/${siteId}/shipments${direction ? `?direction=${direction}` : ''}`), enabled: !!siteId });

export const useInboundOrders = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'shipments', 'inbound-orders'], queryFn: () => api<InboundOrderDetail[]>(`/sites/${siteId}/inbound-orders`), enabled: !!siteId });

export const useOutboundOrders = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'shipments', 'outbound-orders'], queryFn: () => api<OutboundOrderDetail[]>(`/sites/${siteId}/outbound-orders`), enabled: !!siteId });

export const useReceipt = (siteId: string | undefined, id: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'shipments', 'receipt', id], queryFn: () => api<ReceiptDetail>(`/sites/${siteId}/receipts/${id}`), enabled: !!siteId && !!id });

export const useTasks = (siteId: string | undefined, filter = '') =>
  useQuery({ queryKey: ['site', siteId, 'tasks', filter], queryFn: () => api<TaskDto[]>(`/sites/${siteId}/tasks${filter ? `?${filter}` : ''}`), enabled: !!siteId });

export const useSkus = () => useQuery({ queryKey: ['skus'], queryFn: () => api<SkuDto[]>('/skus'), staleTime: 60_000 });

export const usePartners = (type?: string) =>
  useQuery({ queryKey: ['partners', type ?? 'all'], queryFn: () => api<{ items: Array<{ id: string; code: string; name: string; partnerTypes: string[] }> }>(`/partners${type ? `?type=${type}` : ''}`).then((response) => response.items), staleTime: 60_000 });

export interface EquipmentDetail {
  id: string;
  code: string;
  model: string | null;
  status: string;
  taskSummary: string | null;
  batteryPct: number | null;
  speedKmh: number | null;
  movesToday: number;
  chargerLocationId: string | null;
  operator?: string | null;
}

export const useEquipment = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'equipment'], queryFn: () => api<EquipmentDetail[]>(`/sites/${siteId}/equipment`), enabled: !!siteId });

// Phase 5 — Vehicle Storage
export const useVehicleStays = (siteId: string | undefined, status?: string) =>
  useQuery({ queryKey: ['site', siteId, 'vehicles', status ?? 'active'], queryFn: () => api<VehicleStayDto[]>(`/sites/${siteId}/vehicle-stays${status ? `?status=${status}` : ''}`), enabled: !!siteId });

export const useVehicleStay = (siteId: string | undefined, id: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'vehicles', 'stay', id], queryFn: () => api<VehicleStayDto>(`/sites/${siteId}/vehicle-stays/${id}`), enabled: !!siteId && !!id });

export const useVehicleHistory = (vin: string | undefined) =>
  useQuery({ queryKey: ['vehicle-history', vin], queryFn: () => api<VehicleHistoryEntry[]>(`/vehicles/${vin}/history`), enabled: !!vin });

export const useParkingSlots = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'vehicles', 'slots'], queryFn: () => api<LocationDto[]>(`/sites/${siteId}/locations?type=PARKING_SLOT`), enabled: !!siteId });

/** Cấu hình site (SKU hiển thị trên panel…) */
export const useSiteSettings = (siteId: string | undefined) =>
  useQuery({ queryKey: ['site', siteId, 'settings'], queryFn: () => api<{ dashboardSkus?: string[] } & Record<string, unknown>>(`/sites/${siteId}/settings`), enabled: !!siteId, staleTime: 60_000 });
