import type { AdminEquipmentDto } from '@waretrack/shared-schemas';
import { EquipmentType } from '@waretrack/shared-schemas';
import { ArrowLeft, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { Badge, toneFor } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { useAdminSites, useAdminUsers, useEquipmentMutations, useSiteEquipment, useSiteLocations } from '@/lib/admin-queries';
import { describeError } from '@/lib/api';

function EquipmentDialog({ siteId, siteCode, equipment, onClose }: { siteId: string; siteCode: string; equipment: AdminEquipmentDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { create, update } = useEquipmentMutations(siteId);
  const { data: chargers } = useSiteLocations(siteId, 'CHARGER');
  const { data: users } = useAdminUsers();
  // Người lái: user có vai trò tại site này (hoặc cấp doanh nghiệp)
  const operators = (users ?? []).filter((user) => user.status === 'ACTIVE' && user.siteRoles.some((assignment) => assignment.siteCode === siteCode || assignment.siteId === null));
  const [code, setCode] = useState(equipment?.code ?? '');
  const [equipmentType, setEquipmentType] = useState(equipment?.equipmentType ?? 'FORKLIFT');
  const [model, setModel] = useState(equipment?.model ?? '');
  const [chargerLocationId, setChargerLocationId] = useState(equipment?.chargerLocationId ?? '');
  const [operatorUserId, setOperatorUserId] = useState(equipment?.operatorUserId ?? '');
  const mutation = equipment ? update : create;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={equipment ? `${equipment.code} · ${t('admin.equipment.edit')}` : t('admin.equipment.register')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (equipment) update.mutate({ equipmentId: equipment.id, body: { model: model || null, chargerLocationId: chargerLocationId || null, operatorUserId: operatorUserId || null } }, { onSuccess: onClose });
          else create.mutate({ code, equipmentType: equipmentType as EquipmentType, model: model || undefined, chargerLocationId: chargerLocationId || null, operatorUserId: operatorUserId || null }, { onSuccess: onClose });
        }}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="equipment-code">{t('common.code')}</Label>
            <Input id="equipment-code" value={code} disabled={!!equipment} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="FL-01" required />
          </div>
          <div>
            <Label htmlFor="equipment-type">{t('admin.equipment.type')}</Label>
            <Select id="equipment-type" value={equipmentType} disabled={!!equipment} onChange={(event) => setEquipmentType(event.target.value)}>
              {EquipmentType.options.map((option) => (
                <option key={option} value={option}>
                  {t(`admin.equipmentTypes.${option}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="equipment-model">{t('admin.equipment.model')}</Label>
          <Input id="equipment-model" value={model} onChange={(event) => setModel(event.target.value)} placeholder="Toyota 8FBE18" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="equipment-charger">{t('admin.equipment.charger')}</Label>
            <Select id="equipment-charger" value={chargerLocationId} onChange={(event) => setChargerLocationId(event.target.value)}>
              <option value="">{t('common.none')}</option>
              {chargers?.map((charger) => (
                <option key={charger.id} value={charger.id}>
                  {charger.name ?? charger.code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="equipment-operator">{t('admin.equipment.operator')}</Label>
            <Select id="equipment-operator" value={operatorUserId} onChange={(event) => setOperatorUserId(event.target.value)}>
              <option value="">{t('common.none')}</option>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.fullName} ({operator.username})
                </option>
              ))}
            </Select>
          </div>
        </div>
        {mutation.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(mutation.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={mutation.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Danh sách xe nâng của site: đăng ký xe mới, gán trạm sạc và người lái. */
export function SiteEquipmentPage() {
  const { t } = useTranslation();
  const { siteCode = '' } = useParams();
  const { data: sites } = useAdminSites();
  const site = sites?.find((candidate) => candidate.code === siteCode);
  const { data: equipmentList, isLoading } = useSiteEquipment(site?.id);
  const { data: chargers } = useSiteLocations(site?.id, 'CHARGER');
  const [editing, setEditing] = useState<AdminEquipmentDto | 'new' | null>(null);
  if (!site) return <p className="text-muted">{t('common.loading')}</p>;
  const chargerName = (chargerId: string | null) => chargers?.find((charger) => charger.id === chargerId)?.code ?? t('common.none');
  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-5 flex items-center gap-3">
        <Button asChild variant="ghost" size="icon">
          <Link to="/admin/sites" aria-label={t('admin.nav.sites')}>
            <ArrowLeft size={18} />
          </Link>
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold">
            {site.code} · {t('admin.equipment.title')}
          </h1>
          <p className="text-sm text-muted">{t('admin.equipment.subtitle')}</p>
        </div>
        <Button onClick={() => setEditing('new')} data-testid="register-forklift">
          <Plus size={16} /> {t('admin.equipment.register')}
        </Button>
      </div>
      {isLoading ? <p className="text-muted">{t('common.loading')}</p> : null}
      {equipmentList && equipmentList.length === 0 ? <div className="card p-8 text-center text-sm text-muted">{t('admin.equipment.empty')}</div> : null}
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2">{t('common.code')}</th>
              <th className="px-4 py-2">{t('admin.equipment.model')}</th>
              <th className="px-4 py-2">{t('common.status')}</th>
              <th className="px-4 py-2">{t('admin.equipment.operator')}</th>
              <th className="px-4 py-2">{t('admin.equipment.charger')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {equipmentList?.map((equipment) => (
              <tr key={equipment.id} className="border-t border-line">
                <td className="px-4 py-2.5 font-semibold">{equipment.code}</td>
                <td className="px-4 py-2.5">{equipment.model ?? t('common.none')}</td>
                <td className="px-4 py-2.5">
                  <Badge tone={toneFor(equipment.status)}>{t(`status.${equipment.status}`, { defaultValue: equipment.status })}</Badge>
                </td>
                <td className="px-4 py-2.5">{equipment.operator ?? t('common.none')}</td>
                <td className="px-4 py-2.5">{chargerName(equipment.chargerLocationId)}</td>
                <td className="px-4 py-2.5 text-right">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(equipment)}>
                    <Pencil size={14} /> {t('admin.equipment.edit')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? <EquipmentDialog siteId={site.id} siteCode={site.code} equipment={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}
