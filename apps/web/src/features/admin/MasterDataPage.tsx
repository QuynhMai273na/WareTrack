import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PartnerDto, SkuDto } from '@waretrack/shared-schemas';
import { PartnerType, TruckType } from '@waretrack/shared-schemas';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminDrivers, useAdminPartners, useAdminTrucks, useFleetMutations, usePartnerMutations } from '@/lib/admin-queries';
import { api, describeError } from '@/lib/api';
import { useSkus } from '@/lib/queries';
import { useAuth } from '@/stores/auth';

function ErrorLine({ error }: { error: unknown }) {
  return error ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(error)}</p> : null;
}

function DialogActions({ onClose, pending, submitLabel }: { onClose: () => void; pending: boolean; submitLabel: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end gap-2">
      <Button type="button" variant="outline" onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" disabled={pending}>
        {submitLabel}
      </Button>
    </div>
  );
}

// ───────────── SKU ─────────────

function SkuDialog({ sku, onClose }: { sku: SkuDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [code, setCode] = useState(sku?.code ?? '');
  const [name, setName] = useState(sku?.name ?? '');
  const [category, setCategory] = useState(sku?.category ?? '');
  const [baseUom, setBaseUom] = useState(sku?.baseUom ?? 'EA');
  const [lotTracked, setLotTracked] = useState(sku?.lotTracked ?? false);
  const [expiryTracked, setExpiryTracked] = useState(sku?.expiryTracked ?? false);
  const [qcRequired, setQcRequired] = useState(sku?.qcRequired ?? false);
  const [lowStockThreshold, setLowStockThreshold] = useState(sku?.lowStockThreshold ?? '');
  const save = useMutation({
    mutationFn: () =>
      sku
        ? api(`/skus/${sku.id}`, { method: 'PATCH', body: { name, category: category || null, qcRequired, lowStockThreshold: lowStockThreshold || null, expectedVersion: sku.version } })
        : api('/skus', {
            method: 'POST',
            body: {
              code,
              name,
              category: category || undefined,
              baseUom,
              uomDecimals: 0,
              lotTracked: lotTracked || expiryTracked,
              expiryTracked,
              serialTracked: false,
              qcRequired,
              allocationStrategy: expiryTracked ? 'FEFO' : 'FIFO',
              ...(lowStockThreshold ? { lowStockThreshold } : {}),
            },
          }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['skus'] });
      onClose();
    },
  });
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={sku ? `${sku.code} · ${t('admin.master.editSku')}` : t('admin.master.createSku')} className="w-[min(92vw,520px)]">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="sku-code">{t('common.code')}</Label>
            <Input id="sku-code" value={code} disabled={!!sku} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="GRO-TOM-24" required pattern="[A-Z0-9-]{3,40}" />
          </div>
          <div className="col-span-2">
            <Label htmlFor="sku-name">{t('admin.master.skuName')}</Label>
            <Input id="sku-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="sku-category">{t('admin.master.category')}</Label>
            <Input id="sku-category" value={category} onChange={(event) => setCategory(event.target.value)} placeholder="Grocery" />
          </div>
          <div>
            <Label htmlFor="sku-uom">{t('admin.master.uom')}</Label>
            <Input id="sku-uom" value={baseUom} disabled={!!sku} onChange={(event) => setBaseUom(event.target.value.toUpperCase())} />
          </div>
          <div>
            <Label htmlFor="sku-low">{t('admin.master.lowStock')}</Label>
            <Input id="sku-low" value={lowStockThreshold} onChange={(event) => setLowStockThreshold(event.target.value.replace(/[^\d.]/g, ''))} placeholder="500" />
          </div>
        </div>
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={lotTracked || expiryTracked} disabled={!!sku || expiryTracked} onChange={(event) => setLotTracked(event.target.checked)} /> {t('admin.master.lotTracked')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={expiryTracked} disabled={!!sku} onChange={(event) => setExpiryTracked(event.target.checked)} /> {t('admin.master.expiryTracked')}
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={qcRequired} onChange={(event) => setQcRequired(event.target.checked)} /> {t('admin.master.qcRequired')}
          </label>
        </div>
        <ErrorLine error={save.error} />
        <DialogActions onClose={onClose} pending={save.isPending} submitLabel={t('common.save')} />
      </form>
    </Dialog>
  );
}

function SkusTab() {
  const { t } = useTranslation();
  const { data: skus } = useSkus();
  const can = useAuth((state) => state.can);
  const [editing, setEditing] = useState<SkuDto | 'new' | null>(null);
  return (
    <div>
      <div className="mb-3 flex justify-end">
        {can(undefined, 'master.sku.manage') ? (
          <Button onClick={() => setEditing('new')} data-testid="create-sku">
            <Plus size={16} /> {t('admin.master.createSku')}
          </Button>
        ) : null}
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2">{t('common.code')}</th>
              <th className="px-4 py-2">{t('admin.master.skuName')}</th>
              <th className="px-4 py-2">{t('admin.master.category')}</th>
              <th className="px-4 py-2">{t('admin.master.tracking')}</th>
              <th className="px-4 py-2">{t('admin.master.lowStock')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {skus?.map((sku) => (
              <tr key={sku.id} className="border-t border-line">
                <td className="px-4 py-2 font-mono text-xs font-semibold">{sku.code}</td>
                <td className="px-4 py-2">{sku.name}</td>
                <td className="px-4 py-2">{sku.category ?? t('common.none')}</td>
                <td className="px-4 py-2">
                  <div className="flex gap-1">
                    {sku.lotTracked ? <Badge tone="info">{t('admin.master.lot')}</Badge> : null}
                    {sku.expiryTracked ? <Badge tone="warn">{t('admin.master.expiry')}</Badge> : null}
                    {sku.qcRequired ? <Badge>QC</Badge> : null}
                  </div>
                </td>
                <td className="tabular px-4 py-2">{sku.lowStockThreshold ? Number(sku.lowStockThreshold).toLocaleString() : t('common.none')}</td>
                <td className="px-4 py-2 text-right">
                  {can(undefined, 'master.sku.manage') ? (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(sku)}>
                      <Pencil size={14} />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? <SkuDialog sku={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

// ───────────── Đối tác ─────────────

function PartnerDialog({ partner, onClose }: { partner: PartnerDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { create, update } = usePartnerMutations();
  const [code, setCode] = useState(partner?.code ?? '');
  const [name, setName] = useState(partner?.name ?? '');
  const [partnerTypes, setPartnerTypes] = useState<string[]>(partner?.partnerTypes ?? ['CUSTOMER']);
  const [contactEmail, setContactEmail] = useState(partner?.contactEmail ?? '');
  const [contactPhone, setContactPhone] = useState(partner?.contactPhone ?? '');
  const mutation = partner ? update : create;
  const toggleType = (partnerType: string) => setPartnerTypes((current) => (current.includes(partnerType) ? current.filter((existing) => existing !== partnerType) : [...current, partnerType]));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={partner ? `${partner.code} · ${t('admin.master.editPartner')}` : t('admin.master.createPartner')}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          const types = partnerTypes as PartnerDto['partnerTypes'] as Array<'CUSTOMER' | 'SUPPLIER' | 'CARRIER'>;
          if (partner) update.mutate({ partnerId: partner.id, body: { name, partnerTypes: types, contactEmail: contactEmail || null, contactPhone: contactPhone || null } }, { onSuccess: onClose });
          else create.mutate({ code, name, partnerTypes: types, contactEmail: contactEmail || undefined, contactPhone: contactPhone || undefined }, { onSuccess: onClose });
        }}
      >
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="partner-code">{t('common.code')}</Label>
            <Input id="partner-code" value={code} disabled={!!partner} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="ACME" required />
          </div>
          <div className="col-span-2">
            <Label htmlFor="partner-name">{t('admin.master.partnerName')}</Label>
            <Input id="partner-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
          </div>
        </div>
        <div className="flex gap-4 text-sm">
          {PartnerType.options.map((partnerType) => (
            <label key={partnerType} className="flex items-center gap-2">
              <input type="checkbox" checked={partnerTypes.includes(partnerType)} onChange={() => toggleType(partnerType)} /> {t(`admin.partnerTypes.${partnerType}`)}
            </label>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="partner-email">{t('admin.users.email')}</Label>
            <Input id="partner-email" type="email" value={contactEmail} onChange={(event) => setContactEmail(event.target.value)} />
          </div>
          <div>
            <Label htmlFor="partner-phone">{t('admin.master.phone')}</Label>
            <Input id="partner-phone" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} />
          </div>
        </div>
        <ErrorLine error={mutation.error} />
        <DialogActions onClose={onClose} pending={mutation.isPending || partnerTypes.length === 0} submitLabel={t('common.save')} />
      </form>
    </Dialog>
  );
}

function PartnersTab() {
  const { t } = useTranslation();
  const { data: partners } = useAdminPartners();
  const can = useAuth((state) => state.can);
  const [editing, setEditing] = useState<PartnerDto | 'new' | null>(null);
  return (
    <div>
      <div className="mb-3 flex justify-end">
        {can(undefined, 'master.partner.manage') ? (
          <Button onClick={() => setEditing('new')} data-testid="create-partner">
            <Plus size={16} /> {t('admin.master.createPartner')}
          </Button>
        ) : null}
      </div>
      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs text-muted">
            <tr>
              <th className="px-4 py-2">{t('common.code')}</th>
              <th className="px-4 py-2">{t('admin.master.partnerName')}</th>
              <th className="px-4 py-2">{t('admin.master.partnerTypes')}</th>
              <th className="px-4 py-2">{t('admin.master.contact')}</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {partners?.map((partner) => (
              <tr key={partner.id} className="border-t border-line">
                <td className="px-4 py-2 font-mono text-xs font-semibold">{partner.code}</td>
                <td className="px-4 py-2">{partner.name}</td>
                <td className="px-4 py-2">
                  <div className="flex gap-1">
                    {partner.partnerTypes.map((partnerType) => (
                      <Badge key={partnerType} tone="info">
                        {t(`admin.partnerTypes.${partnerType}`, { defaultValue: partnerType })}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2 text-xs text-muted">{[partner.contactEmail, partner.contactPhone].filter(Boolean).join(' · ') || t('common.none')}</td>
                <td className="px-4 py-2 text-right">
                  {can(undefined, 'master.partner.manage') ? (
                    <Button size="sm" variant="ghost" onClick={() => setEditing(partner)}>
                      <Pencil size={14} />
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing ? <PartnerDialog partner={editing === 'new' ? null : editing} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

// ───────────── Xe tải & tài xế ─────────────

function FleetTab() {
  const { t } = useTranslation();
  const { data: trucks } = useAdminTrucks();
  const { data: drivers } = useAdminDrivers();
  const { data: partners } = useAdminPartners();
  const { createTruck, createDriver } = useFleetMutations();
  const carriers = (partners ?? []).filter((partner) => partner.partnerTypes.includes('CARRIER'));
  const [plateNumber, setPlateNumber] = useState('');
  const [truckType, setTruckType] = useState('BOX');
  const [truckCarrierId, setTruckCarrierId] = useState('');
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [driverCarrierId, setDriverCarrierId] = useState('');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-4">
        <h3 className="mb-3 font-semibold">{t('admin.master.trucks')}</h3>
        <form
          className="mb-3 grid grid-cols-[1fr_auto_auto_auto] gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            createTruck.mutate({ plateNumber, truckType, ...(truckCarrierId ? { carrierId: truckCarrierId } : {}) }, { onSuccess: () => setPlateNumber('') });
          }}
        >
          <Input value={plateNumber} onChange={(event) => setPlateNumber(event.target.value.toUpperCase())} placeholder={t('admin.master.plate')} required minLength={2} data-testid="truck-plate" />
          <Select value={truckType} onChange={(event) => setTruckType(event.target.value)}>
            {TruckType.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
          <Select value={truckCarrierId} onChange={(event) => setTruckCarrierId(event.target.value)}>
            <option value="">{t('admin.master.noCarrier')}</option>
            {carriers.map((carrier) => (
              <option key={carrier.id} value={carrier.id}>
                {carrier.name}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={createTruck.isPending}>
            <Plus size={15} />
          </Button>
        </form>
        <ErrorLine error={createTruck.error} />
        <ul className="divide-y divide-line text-sm">
          {trucks?.map((truck) => (
            <li key={truck.id} className="flex items-center justify-between py-2">
              <span className="font-mono text-xs font-semibold">{truck.code}</span>
              <span>{truck.plateNumber}</span>
              <span className="text-xs text-muted">
                {truck.truckType} · {truck.carrier?.name ?? t('admin.master.noCarrier')}
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="card p-4">
        <h3 className="mb-3 font-semibold">{t('admin.master.drivers')}</h3>
        <form
          className="mb-3 grid grid-cols-[1fr_1fr_auto_auto] gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            createDriver.mutate({ fullName: driverName, ...(driverPhone ? { phone: driverPhone } : {}), ...(driverCarrierId ? { carrierId: driverCarrierId } : {}) }, { onSuccess: () => setDriverName('') });
          }}
        >
          <Input value={driverName} onChange={(event) => setDriverName(event.target.value)} placeholder={t('admin.users.fullName')} required minLength={2} />
          <Input value={driverPhone} onChange={(event) => setDriverPhone(event.target.value)} placeholder={t('admin.master.phone')} />
          <Select value={driverCarrierId} onChange={(event) => setDriverCarrierId(event.target.value)}>
            <option value="">{t('admin.master.noCarrier')}</option>
            {carriers.map((carrier) => (
              <option key={carrier.id} value={carrier.id}>
                {carrier.name}
              </option>
            ))}
          </Select>
          <Button type="submit" disabled={createDriver.isPending}>
            <Plus size={15} />
          </Button>
        </form>
        <ErrorLine error={createDriver.error} />
        <ul className="divide-y divide-line text-sm">
          {drivers?.map((driver) => (
            <li key={driver.id} className="flex items-center justify-between py-2">
              <span className="font-medium">{driver.fullName}</span>
              <span className="text-xs text-muted">{driver.phone ?? t('common.none')}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Danh mục dùng chung toàn doanh nghiệp: SKU, đối tác (khách hàng / nhà cung cấp / hãng vận tải), xe tải, tài xế. */
export function MasterDataPage() {
  const { t } = useTranslation();
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5">
        <h1 className="text-2xl font-bold">{t('admin.master.title')}</h1>
        <p className="text-sm text-muted">{t('admin.master.subtitle')}</p>
      </div>
      <Tabs defaultValue="skus">
        <TabsList className="mb-4">
          <TabsTrigger value="skus">{t('admin.master.skus')}</TabsTrigger>
          <TabsTrigger value="partners" data-testid="partners-tab">
            {t('admin.master.partners')}
          </TabsTrigger>
          <TabsTrigger value="fleet">{t('admin.master.fleet')}</TabsTrigger>
        </TabsList>
        <TabsContent value="skus">
          <SkusTab />
        </TabsContent>
        <TabsContent value="partners">
          <PartnersTab />
        </TabsContent>
        <TabsContent value="fleet">
          <FleetTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
