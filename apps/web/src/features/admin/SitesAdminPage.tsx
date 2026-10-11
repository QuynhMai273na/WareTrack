import type { AdminSiteDto, CreateSiteRequest } from '@waretrack/shared-schemas';
import { SiteType } from '@waretrack/shared-schemas';
import { ExternalLink, Forklift, Map as MapIcon, Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Label, Select } from '@/components/ui/input';
import { useAdminSites, useCreateSite, useUpdateSite } from '@/lib/admin-queries';
import { describeError } from '@/lib/api';
import { useAuth } from '@/stores/auth';

const TIME_ZONES = ['America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Ho_Chi_Minh', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney'];
const STATUS_TONE = { OPERATIONAL: 'ok', LIMITED: 'warn', CLOSED: 'bad' } as const;

function CreateSiteDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const createSite = useCreateSite();
  const [form, setForm] = useState<CreateSiteRequest>({ code: '', name: '', siteType: 'DISTRIBUTION_CENTER', addressLine: '', timezone: 'America/New_York' });
  const update = (patch: Partial<CreateSiteRequest>) => setForm((current) => ({ ...current, ...patch }));
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={t('admin.sites.createTitle')} description={t('admin.sites.createHint')} className="w-[min(92vw,520px)]">
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          createSite.mutate({ ...form, addressLine: form.addressLine || undefined }, { onSuccess: onClose });
        }}
      >
        <div className="grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="site-code">{t('common.code')}</Label>
            <Input id="site-code" value={form.code} onChange={(event) => update({ code: event.target.value.toUpperCase() })} placeholder="WH-07" required />
          </div>
          <div className="col-span-2">
            <Label htmlFor="site-name">{t('admin.sites.name')}</Label>
            <Input id="site-name" value={form.name} onChange={(event) => update({ name: event.target.value })} placeholder="Lakeview DC" required minLength={2} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="site-type">{t('admin.sites.type')}</Label>
            <Select id="site-type" value={form.siteType} onChange={(event) => update({ siteType: event.target.value as CreateSiteRequest['siteType'] })}>
              {SiteType.options.map((siteType) => (
                <option key={siteType} value={siteType}>
                  {t(`admin.siteTypes.${siteType}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="site-timezone">{t('admin.sites.timezone')}</Label>
            <Select id="site-timezone" value={form.timezone} onChange={(event) => update({ timezone: event.target.value })}>
              {TIME_ZONES.map((timeZone) => (
                <option key={timeZone}>{timeZone}</option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label htmlFor="site-address">{t('admin.sites.address')}</Label>
          <Input id="site-address" value={form.addressLine ?? ''} onChange={(event) => update({ addressLine: event.target.value })} placeholder="9 Lakeview Rd, Newark NJ" />
        </div>
        {createSite.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(createSite.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={createSite.isPending}>
            {t('admin.sites.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditSiteDialog({ site, onClose }: { site: AdminSiteDto; onClose: () => void }) {
  const { t } = useTranslation();
  const updateSite = useUpdateSite(site.id);
  const [name, setName] = useState(site.name);
  const [addressLine, setAddressLine] = useState(site.addressLine ?? '');
  const [operationalStatus, setOperationalStatus] = useState(site.operationalStatus);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={`${site.code} · ${t('admin.sites.edit')}`}>
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          updateSite.mutate({ name, addressLine: addressLine || null, operationalStatus }, { onSuccess: onClose });
        }}
      >
        <div>
          <Label htmlFor="edit-site-name">{t('admin.sites.name')}</Label>
          <Input id="edit-site-name" value={name} onChange={(event) => setName(event.target.value)} required minLength={2} />
        </div>
        <div>
          <Label htmlFor="edit-site-address">{t('admin.sites.address')}</Label>
          <Input id="edit-site-address" value={addressLine} onChange={(event) => setAddressLine(event.target.value)} />
        </div>
        <div>
          <Label htmlFor="edit-site-status">{t('common.status')}</Label>
          <Select id="edit-site-status" value={operationalStatus} onChange={(event) => setOperationalStatus(event.target.value as AdminSiteDto['operationalStatus'])}>
            {(['OPERATIONAL', 'LIMITED', 'CLOSED'] as const).map((status) => (
              <option key={status} value={status}>
                {t(`admin.siteStatus.${status}`)}
              </option>
            ))}
          </Select>
        </div>
        {updateSite.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(updateSite.error)}</p> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={updateSite.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Danh sách site (vận hành thật): tạo site, sửa thông tin, mở trình vẽ sơ đồ và danh sách xe nâng. */
export function SitesAdminPage() {
  const { t } = useTranslation();
  const { data: sites, isLoading } = useAdminSites();
  const can = useAuth((state) => state.can);
  const [creating, setCreating] = useState(false);
  const [editingSite, setEditingSite] = useState<AdminSiteDto | null>(null);
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{t('admin.sites.title')}</h1>
          <p className="text-sm text-muted">{t('admin.sites.subtitle')}</p>
        </div>
        {can(undefined, 'site.manage') ? (
          <Button onClick={() => setCreating(true)} data-testid="create-site">
            <Plus size={16} /> {t('admin.sites.create')}
          </Button>
        ) : null}
      </div>
      {isLoading ? <p className="text-muted">{t('common.loading')}</p> : null}
      {sites && sites.length === 0 ? (
        <div className="card flex flex-col items-center gap-3 p-10 text-center">
          <MapIcon size={36} className="text-brand" />
          <div className="text-lg font-semibold">{t('admin.sites.emptyTitle')}</div>
          <p className="max-w-md text-sm text-muted">{t('admin.sites.emptyHint')}</p>
          <Button onClick={() => setCreating(true)}>
            <Plus size={16} /> {t('admin.sites.create')}
          </Button>
        </div>
      ) : null}
      <div className="grid gap-3">
        {sites?.map((site) => (
          <div key={site.id} className="card flex flex-wrap items-center gap-4 p-4" data-testid={`site-row-${site.code}`}>
            <span className="flex h-12 w-16 shrink-0 items-center justify-center rounded-lg bg-brand text-sm font-bold text-white">{site.code}</span>
            <div className="min-w-[220px] flex-1">
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold">{site.name}</span>
                <Badge tone={STATUS_TONE[site.operationalStatus]}>{t(`admin.siteStatus.${site.operationalStatus}`)}</Badge>
              </div>
              <div className="text-xs text-muted">
                {t(`admin.siteTypes.${site.siteType}`)} · {site.addressLine ?? t('common.none')} · {site.timezone}
              </div>
            </div>
            <div className="text-sm">
              <div className="text-xs text-muted">{t('admin.sites.layout')}</div>
              <div className="font-medium">{site.publishedVersionNo ? t('admin.sites.versionNo', { n: site.publishedVersionNo }) : t('admin.sites.noLayout')}</div>
            </div>
            <div className="text-sm">
              <div className="text-xs text-muted">{t('admin.sites.locations')}</div>
              <div className="tabular font-medium">{site.locationCount}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {can(site.id, 'layout.manage') ? (
                <Button asChild size="sm" variant="secondary">
                  <Link to={`/admin/sites/${site.code}/layout`}>
                    <MapIcon size={14} /> {t('admin.sites.editLayout')}
                  </Link>
                </Button>
              ) : null}
              {can(site.id, 'equipment.manage') ? (
                <Button asChild size="sm" variant="outline">
                  <Link to={`/admin/sites/${site.code}/equipment`}>
                    <Forklift size={14} /> {t('admin.sites.forklifts')}
                  </Link>
                </Button>
              ) : null}
              {can(undefined, 'site.manage') ? (
                <Button size="sm" variant="outline" onClick={() => setEditingSite(site)}>
                  <Pencil size={14} /> {t('admin.sites.edit')}
                </Button>
              ) : null}
              <Button asChild size="sm" variant="ghost">
                <Link to={`/sites/${site.code}`}>
                  <ExternalLink size={14} /> {t('admin.sites.open')}
                </Link>
              </Button>
            </div>
          </div>
        ))}
      </div>
      {creating ? <CreateSiteDialog onClose={() => setCreating(false)} /> : null}
      {editingSite ? <EditSiteDialog site={editingSite} onClose={() => setEditingSite(null)} /> : null}
    </div>
  );
}
