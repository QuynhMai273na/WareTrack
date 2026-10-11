import type { PublishBlueprintResult, PublishedLayout, SiteBlueprint } from '@waretrack/shared-schemas';
import { SiteBlueprint as SiteBlueprintSchema } from '@waretrack/shared-schemas';
import { ArrowLeft, BatteryCharging, Box, Building2, DoorOpen, Grid3x3, Rows3, Truck } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { previewBlueprint, useAdminSites, useBlueprint, usePublishBlueprint, useSaveBlueprint } from '@/lib/admin-queries';
import { describeError } from '@/lib/api';
import { BlueprintCanvas } from './BlueprintCanvas';
import { type BlueprintObjectKind, type BlueprintSelection, blueprintSummary, faceLength, newObjectId, nextFreeCode, nextFreePrefix } from './blueprint-geometry';
import { BlueprintProperties } from './BlueprintProperties';

const SiteScene = lazy(() => import('@/scene/SiteScene').then((module) => ({ default: module.SiteScene })));

type EditorView = 'plan' | 'preview';

/** Thêm đối tượng mới vào bản thiết kế, đặt cạnh các đối tượng hiện có và chọn luôn đối tượng đó. */
function addObject(draft: SiteBlueprint, kind: BlueprintObjectKind): { next: SiteBlueprint; selection: BlueprintSelection } {
  const mainBuilding = draft.buildings[0];
  switch (kind) {
    case 'building': {
      const code = nextFreeCode(draft.buildings.map((building) => building.code), 'BLD-', 1);
      const building = { id: newObjectId('building'), code, label: code, x: 20, z: Math.min(120, mainBuilding.z + mainBuilding.depth + 40), width: 40, depth: 30, height: 8, roof: 'gable' as const, roofColor: '#2f6fe4', wallColor: '#e8eef8' };
      return { next: { ...draft, buildings: [...draft.buildings, building] }, selection: { kind, id: building.id } };
    }
    case 'dock': {
      const sameFace = draft.docks.filter((dock) => dock.buildingCode === mainBuilding.code && dock.face === 'S');
      const offset = Math.min(faceLength(mainBuilding, 'S') - 4, (sameFace.length ? Math.max(...sameFace.map((dock) => dock.offset)) : 0) + 14);
      const dockNumber = draft.docks.length + 1;
      const dock = { id: newObjectId('dock'), code: nextFreeCode(draft.docks.map((existing) => existing.code), 'DOCK-', 1), label: `Bay ${dockNumber}`, buildingCode: mainBuilding.code, face: 'S' as const, offset, direction: 'BOTH' as const };
      return { next: { ...draft, docks: [...draft.docks, dock] }, selection: { kind, id: dock.id } };
    }
    case 'staging': {
      const codePrefix = nextFreePrefix(draft.stagingGrids.map((grid) => grid.codePrefix), ['S', 'T', 'U', 'V', 'W']);
      const grid = { id: newObjectId('staging'), codePrefix, labelPrefix: 'Staging', x: mainBuilding.x + mainBuilding.width + 10, z: mainBuilding.z + 4 + draft.stagingGrids.length * 12, rows: 2, columns: 4, capacityEach: 2, spacing: 3.4, startNumber: 1 };
      return { next: { ...draft, stagingGrids: [...draft.stagingGrids, grid] }, selection: { kind, id: grid.id } };
    }
    case 'rack': {
      const rack = { id: newObjectId('rack'), code: nextFreeCode(draft.racks.map((existing) => existing.code), 'R-'), x: mainBuilding.x + mainBuilding.width + 14 + (draft.racks.length % 4) * 8, z: mainBuilding.z + mainBuilding.depth - 6, rotation: 0 as const, levels: 3, bays: 2 };
      return { next: { ...draft, racks: [...draft.racks, rack] }, selection: { kind, id: rack.id } };
    }
    case 'yard': {
      const codePrefix = nextFreePrefix(draft.yardRows.map((row) => row.codePrefix), ['Y', 'P', 'Q']);
      const row = { id: newObjectId('yard'), codePrefix, x: 40, z: Math.min(150, mainBuilding.z + mainBuilding.depth + 50), count: 4, rotation: 0 as const, spacing: 6 };
      return { next: { ...draft, yardRows: [...draft.yardRows, row] }, selection: { kind, id: row.id } };
    }
    case 'charger': {
      const codePrefix = nextFreePrefix(draft.chargerRows.map((row) => row.codePrefix), ['C', 'K']);
      const row = { id: newObjectId('charger'), codePrefix, x: Math.max(-50, mainBuilding.x - 10), z: mainBuilding.z + 6, count: 2, rotation: 90 as const, spacing: 4 };
      return { next: { ...draft, chargerRows: [...draft.chargerRows, row] }, selection: { kind, id: row.id } };
    }
    case 'gate':
      return { next: draft, selection: { kind: 'gate', id: 'gate' } };
  }
}

/**
 * Trình vẽ sơ đồ site (UC-23): mặt bằng 2D kéo-thả → lưu nháp → xem trước 3D → publish.
 * Publish giữ nguyên mã vị trí đã có (tồn kho, nhãn QR dán ngoài hiện trường vẫn đúng); vị trí đang có hàng không xóa được.
 */
export function LayoutEditorPage() {
  const { t } = useTranslation();
  const { siteCode = '' } = useParams();
  const { data: sites } = useAdminSites();
  const site = sites?.find((candidate) => candidate.code === siteCode);
  const { data: blueprintState, isLoading } = useBlueprint(site?.id);
  const saveDraft = useSaveBlueprint(site?.id ?? '');
  const publish = usePublishBlueprint(site?.id ?? '');

  const [draft, setDraft] = useState<SiteBlueprint | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selection, setSelection] = useState<BlueprintSelection | null>(null);
  const [view, setView] = useState<EditorView>('plan');
  const [previewLayout, setPreviewLayout] = useState<PublishedLayout | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmingPublish, setConfirmingPublish] = useState(false);
  const [publishResult, setPublishResult] = useState<PublishBlueprintResult | null>(null);

  useEffect(() => {
    if (blueprintState && !draft) setDraft(blueprintState.blueprint);
  }, [blueprintState, draft]);

  const validation = useMemo(() => (draft ? SiteBlueprintSchema.safeParse(draft) : null), [draft]);
  const validationMessages = validation && !validation.success ? validation.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) : [];

  const updateDraft = (updater: (current: SiteBlueprint) => SiteBlueprint) => {
    setDraft((current) => (current ? updater(current) : current));
    setDirty(true);
    setPublishResult(null);
  };

  const openPreview = async () => {
    if (!draft || !site) return;
    setView('preview');
    setPreviewError(null);
    try {
      setPreviewLayout(await previewBlueprint(site.id, draft));
    } catch (error) {
      setPreviewError(describeError(error));
    }
  };

  if (!site || isLoading || !draft) return <p className="text-muted">{t('common.loading')}</p>;

  const summary = blueprintSummary(draft);
  const toolbar: Array<{ kind: BlueprintObjectKind; icon: typeof Building2 }> = [
    { kind: 'building', icon: Building2 },
    { kind: 'dock', icon: DoorOpen },
    { kind: 'staging', icon: Grid3x3 },
    { kind: 'rack', icon: Rows3 },
    { kind: 'yard', icon: Truck },
    { kind: 'charger', icon: BatteryCharging },
  ];
  const statusBadge = dirty ? (
    <Badge tone="warn">{t('admin.layout.unsaved')}</Badge>
  ) : blueprintState?.hasUnpublishedChanges ? (
    <Badge tone="info">{t('admin.layout.draftSaved')}</Badge>
  ) : (
    <Badge tone="ok">{t('admin.layout.published', { n: blueprintState?.publishedVersionNo ?? 0 })}</Badge>
  );

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="ghost" size="icon">
          <Link to="/admin/sites" aria-label={t('admin.nav.sites')}>
            <ArrowLeft size={18} />
          </Link>
        </Button>
        <div>
          <h1 className="text-xl font-bold">
            {site.code} · {t('admin.layout.title')}
          </h1>
          <p className="text-xs text-muted">{site.name}</p>
        </div>
        {statusBadge}
        <div className="flex-1" />
        <Tabs value={view} onValueChange={(value) => (value === 'preview' ? void openPreview() : setView('plan'))}>
          <TabsList>
            <TabsTrigger value="plan">{t('admin.layout.plan')}</TabsTrigger>
            <TabsTrigger value="preview" data-testid="preview-tab">
              {t('admin.layout.preview3d')}
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <Button
          variant="outline"
          disabled={!dirty || saveDraft.isPending || validationMessages.length > 0}
          data-testid="save-draft"
          onClick={() => saveDraft.mutate(draft, { onSuccess: () => setDirty(false) })}
        >
          {t('admin.layout.saveDraft')}
        </Button>
        <Button disabled={validationMessages.length > 0 || publish.isPending} onClick={() => setConfirmingPublish(true)} data-testid="publish-layout">
          {t('admin.layout.publish')}
        </Button>
      </div>

      {blueprintState?.isTemplate && blueprintState.publishedVersionNo ? (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" data-testid="template-warning">
          {t('admin.layout.templateWarning')}
        </p>
      ) : null}
      {saveDraft.isError ? <p className="rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(saveDraft.error)}</p> : null}
      {validationMessages.length ? <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{validationMessages.slice(0, 3).join(' · ')}</p> : null}
      {publishResult ? (
        <p className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok" data-testid="publish-result">
          {t('admin.layout.publishedResult', { n: publishResult.versionNo, created: publishResult.locationsCreated, updated: publishResult.locationsUpdated, retired: publishResult.locationsRetired })}{' '}
          <Link to={`/sites/${site.code}`} className="font-semibold underline">
            {t('admin.layout.openDashboard')}
          </Link>
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 gap-4">
        <div className="card flex w-44 shrink-0 flex-col gap-1.5 p-3">
          <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{t('admin.layout.add')}</div>
          {toolbar.map((tool) => (
            <Button
              key={tool.kind}
              variant="outline"
              size="sm"
              className="justify-start"
              data-testid={`add-${tool.kind}`}
              onClick={() => {
                const { next, selection: added } = addObject(draft, tool.kind);
                updateDraft(() => next);
                setSelection(added);
                setView('plan');
              }}
            >
              <tool.icon size={15} /> {t(`admin.layout.kinds.${tool.kind}`)}
            </Button>
          ))}
          <div className="mt-auto rounded-lg bg-slate-50 p-2 text-xs text-muted">
            <Box size={14} className="mb-1 text-brand" />
            {t('admin.layout.capacityLine', { docks: summary.docks, positions: summary.storagePositions.toLocaleString() })}
          </div>
        </div>

        <div className="card relative min-w-0 flex-1 overflow-hidden p-2">
          {view === 'plan' ? (
            <BlueprintCanvas blueprint={draft} selection={selection} onSelect={setSelection} onChange={updateDraft} />
          ) : previewError ? (
            <p className="p-6 text-sm text-bad">{previewError}</p>
          ) : previewLayout ? (
            <Suspense fallback={<p className="p-6 text-muted">{t('common.loading')}</p>}>
              <div className="h-full w-full overflow-hidden rounded-xl" data-testid="layout-preview">
                <SiteScene sites={[{ siteId: `preview-${site.id}`, code: site.code, name: site.name, offset: { x: 0, z: 0 }, layout: previewLayout, snapshot: undefined }]} currentSiteId={`preview-${site.id}`} framing="whole" />
              </div>
            </Suspense>
          ) : (
            <p className="p-6 text-muted">{t('common.loading')}</p>
          )}
        </div>

        <div className="card w-80 shrink-0 overflow-auto p-4">
          <BlueprintProperties blueprint={draft} selection={selection} onChange={updateDraft} onSelect={setSelection} />
        </div>
      </div>

      {confirmingPublish ? (
        <Dialog open onOpenChange={(open) => !open && setConfirmingPublish(false)} title={t('admin.layout.publishTitle', { code: site.code })} description={t('admin.layout.publishHint')}>
          <ul className="mb-4 space-y-1 text-sm">
            <li>{t('admin.layout.publishDocks', { n: summary.docks })}</li>
            <li>{t('admin.layout.publishStaging', { n: summary.stagingSlots })}</li>
            <li>{t('admin.layout.publishStorage', { n: summary.storagePositions.toLocaleString() })}</li>
          </ul>
          {publish.isError ? <p className="mb-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{describeError(publish.error)}</p> : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmingPublish(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="confirm-publish"
              disabled={publish.isPending}
              onClick={() =>
                publish.mutate(draft, {
                  onSuccess: (result) => {
                    setPublishResult(result);
                    setDirty(false);
                    setConfirmingPublish(false);
                  },
                })
              }
            >
              {t('admin.layout.publish')}
            </Button>
          </div>
        </Dialog>
      ) : null}
    </div>
  );
}
