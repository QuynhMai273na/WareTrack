import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminEquipmentDto,
  AdminSiteDto,
  AdminUserDto,
  BlueprintState,
  CreateEquipmentRequest,
  CreatePartnerRequest,
  CreateSiteRequest,
  LocationDto,
  OpeningStockRequest,
  OpeningStockResult,
  PartnerDto,
  PublishBlueprintResult,
  PublishedLayout,
  SiteBlueprint,
  UpdateEquipmentRequest,
  UpdatePartnerRequest,
  UpdateSiteRequest,
  UpdateUserRequest,
} from '@waretrack/shared-schemas';
import { useAuth } from '@/stores/auth';
import { api } from './api';

/** Hook gọi API quản trị vận hành thật: site + sơ đồ, user, danh mục, xe nâng, tồn đầu kỳ. */

export const useAdminSites = () => useQuery({ queryKey: ['admin', 'sites'], queryFn: () => api<AdminSiteDto[]>('/admin/sites') });

export function useCreateSite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateSiteRequest) => api<AdminSiteDto>('/sites', { method: 'POST', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sites'] });
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
      // Danh sách site được phép trong phiên (site switcher, quyền theo site) gồm cả site mới
      void useAuth.getState().reloadMe();
    },
  });
}

export function useUpdateSite(siteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSiteRequest) => api<AdminSiteDto>(`/sites/${siteId}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin', 'sites'] });
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
    },
  });
}

export const useBlueprint = (siteId: string | undefined) =>
  useQuery({ queryKey: ['admin', 'blueprint', siteId], queryFn: () => api<BlueprintState>(`/sites/${siteId}/blueprint`), enabled: !!siteId, staleTime: Infinity });

export function useSaveBlueprint(siteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blueprint: SiteBlueprint) => api<BlueprintState>(`/sites/${siteId}/blueprint`, { method: 'PUT', body: { blueprint } }),
    onSuccess: (state) => queryClient.setQueryData(['admin', 'blueprint', siteId], state),
  });
}

export const previewBlueprint = (siteId: string, blueprint: SiteBlueprint) => api<PublishedLayout>(`/sites/${siteId}/blueprint/preview`, { method: 'POST', body: { blueprint } });

export function usePublishBlueprint(siteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (blueprint: SiteBlueprint) => api<PublishBlueprintResult>(`/sites/${siteId}/blueprint/publish`, { method: 'POST', body: { blueprint } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['admin'] });
      void queryClient.invalidateQueries({ queryKey: ['site', siteId] });
      void queryClient.invalidateQueries({ queryKey: ['sites'] });
    },
  });
}

export const useAdminUsers = () => useQuery({ queryKey: ['admin', 'users'], queryFn: () => api<{ items: AdminUserDto[] }>('/users').then((page) => page.items) });

export const useRoles = () =>
  useQuery({ queryKey: ['admin', 'roles'], queryFn: () => api<Array<{ code: string; label: { vi: string; en: string }; permissions: string[] }>>('/roles'), staleTime: Infinity });

export function useUserMutations() {
  const queryClient = useQueryClient();
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
  return {
    create: useMutation({
      mutationFn: (body: { username: string; email: string; fullName: string; tempPassword: string }) => api<AdminUserDto>('/users', { method: 'POST', body }),
      onSuccess: refresh,
    }),
    update: useMutation({
      mutationFn: ({ userId, body }: { userId: string; body: UpdateUserRequest }) => api<AdminUserDto>(`/users/${userId}`, { method: 'PATCH', body }),
      onSuccess: refresh,
    }),
    resetPassword: useMutation({
      mutationFn: ({ userId, tempPassword }: { userId: string; tempPassword: string }) => api<void>(`/users/${userId}/reset-password`, { method: 'POST', body: { tempPassword } }),
    }),
    grant: useMutation({
      mutationFn: ({ userId, siteId, roleCode }: { userId: string; siteId: string | null; roleCode: string }) => api(`/users/${userId}/site-roles`, { method: 'POST', body: { siteId, roleCode } }),
      onSuccess: refresh,
    }),
    revoke: useMutation({
      mutationFn: ({ userId, assignmentId, reason }: { userId: string; assignmentId: string; reason: string }) => api<void>(`/users/${userId}/site-roles/${assignmentId}`, { method: 'DELETE', body: { reason } }),
      onSuccess: refresh,
    }),
  };
}

export const useAdminPartners = () => useQuery({ queryKey: ['admin', 'partners'], queryFn: () => api<{ items: PartnerDto[] }>('/partners').then((page) => page.items) });

export function usePartnerMutations() {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'partners'] });
    void queryClient.invalidateQueries({ queryKey: ['partners'] });
  };
  return {
    create: useMutation({ mutationFn: (body: CreatePartnerRequest) => api<PartnerDto>('/partners', { method: 'POST', body }), onSuccess: refresh }),
    update: useMutation({ mutationFn: ({ partnerId, body }: { partnerId: string; body: UpdatePartnerRequest }) => api<PartnerDto>(`/partners/${partnerId}`, { method: 'PATCH', body }), onSuccess: refresh }),
  };
}

export interface TruckRow {
  id: string;
  code: string;
  plateNumber: string;
  truckType: string;
  carrier: { id: string; code: string; name: string } | null;
}
export interface DriverRow {
  id: string;
  fullName: string;
  licenseNumber: string | null;
  phone: string | null;
}

export const useAdminTrucks = () => useQuery({ queryKey: ['admin', 'trucks'], queryFn: () => api<{ items: TruckRow[] }>('/trucks').then((page) => page.items) });
export const useAdminDrivers = () => useQuery({ queryKey: ['admin', 'drivers'], queryFn: () => api<{ items: DriverRow[] }>('/drivers').then((page) => page.items) });

export function useFleetMutations() {
  const queryClient = useQueryClient();
  return {
    createTruck: useMutation({
      mutationFn: (body: { plateNumber: string; truckType: string; carrierId?: string }) => api('/trucks', { method: 'POST', body }),
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'trucks'] }),
    }),
    createDriver: useMutation({
      mutationFn: (body: { fullName: string; licenseNumber?: string; phone?: string; carrierId?: string }) => api('/drivers', { method: 'POST', body }),
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['admin', 'drivers'] }),
    }),
  };
}

export const useSiteEquipment = (siteId: string | undefined) =>
  useQuery({ queryKey: ['admin', 'equipment', siteId], queryFn: () => api<AdminEquipmentDto[]>(`/sites/${siteId}/equipment`), enabled: !!siteId });

export function useEquipmentMutations(siteId: string) {
  const queryClient = useQueryClient();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['admin', 'equipment', siteId] });
    void queryClient.invalidateQueries({ queryKey: ['site', siteId] });
  };
  return {
    create: useMutation({ mutationFn: (body: CreateEquipmentRequest) => api<AdminEquipmentDto>(`/sites/${siteId}/equipment`, { method: 'POST', body }), onSuccess: refresh }),
    update: useMutation({
      mutationFn: ({ equipmentId, body }: { equipmentId: string; body: UpdateEquipmentRequest }) => api<AdminEquipmentDto>(`/sites/${siteId}/equipment/${equipmentId}`, { method: 'PATCH', body }),
      onSuccess: refresh,
    }),
  };
}

export const useSiteLocations = (siteId: string | undefined, locationType?: string) =>
  useQuery({
    queryKey: ['admin', 'locations', siteId, locationType ?? 'all'],
    queryFn: () => api<LocationDto[]>(`/sites/${siteId}/locations${locationType ? `?type=${locationType}` : ''}`),
    enabled: !!siteId,
  });

export function useOpeningStock(siteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: OpeningStockRequest) => api<OpeningStockResult>(`/sites/${siteId}/inventory/opening-stock`, { method: 'POST', body }),
    onSuccess: (result) => {
      if (!result.dryRun && result.importedPallets > 0) void queryClient.invalidateQueries({ queryKey: ['site', siteId] });
    },
  });
}
