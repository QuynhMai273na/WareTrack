import type { SiteBlueprint } from '@waretrack/shared-schemas';
import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input, Label, Select } from '@/components/ui/input';
import { type BlueprintSelection, blueprintSummary, faceLength } from './blueprint-geometry';

type BlueprintUpdater = (updater: (draft: SiteBlueprint) => SiteBlueprint) => void;

function NumberField({ label, value, onChange, min, max, step = 1, testId }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; step?: number; testId?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        data-testid={testId}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (event.target.value !== '' && Number.isFinite(parsed)) onChange(parsed);
        }}
      />
    </div>
  );
}

function TextField({ label, value, onChange, testId }: { label: string; value: string; onChange: (value: string) => void; testId?: string }) {
  return (
    <div>
      <Label>{label}</Label>
      <Input value={value} data-testid={testId} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function RotationField({ label, value, onChange }: { label: string; value: number; onChange: (value: 0 | 90 | 180 | -90) => void }) {
  return (
    <div>
      <Label>{label}</Label>
      <Select value={value} onChange={(event) => onChange(Number(event.target.value) as 0 | 90 | 180 | -90)}>
        {[0, 90, 180, -90].map((degrees) => (
          <option key={degrees} value={degrees}>
            {degrees}°
          </option>
        ))}
      </Select>
    </div>
  );
}

function Panel({ title, onDelete, children }: { title: string; onDelete?: () => void; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        {onDelete ? (
          <Button size="sm" variant="ghost" className="text-bad" onClick={onDelete} data-testid="delete-object">
            <Trash2 size={14} /> {t('admin.layout.delete')}
          </Button>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/** Thuộc tính của đối tượng đang chọn; không chọn gì → thiết lập chung của site (cổng, kho trong nhà, tóm tắt). */
export function BlueprintProperties({ blueprint, selection, onChange, onSelect }: { blueprint: SiteBlueprint; selection: BlueprintSelection | null; onChange: BlueprintUpdater; onSelect: (selection: BlueprintSelection | null) => void }) {
  const { t } = useTranslation();

  if (selection?.kind === 'building') {
    const building = blueprint.buildings.find((candidate) => candidate.id === selection.id);
    if (!building) return null;
    const patch = (fields: Partial<typeof building>) =>
      onChange((draft) => ({
        ...draft,
        buildings: draft.buildings.map((candidate) => (candidate.id === building.id ? { ...candidate, ...fields } : candidate)),
        // Đổi mã nhà → dock của nhà đó đổi theo
        docks: fields.code ? draft.docks.map((dock) => (dock.buildingCode === building.code ? { ...dock, buildingCode: fields.code! } : dock)) : draft.docks,
      }));
    const removable = blueprint.buildings.length > 1;
    return (
      <Panel
        title={t('admin.layout.kinds.building')}
        onDelete={
          removable
            ? () => {
                onChange((draft) => ({ ...draft, buildings: draft.buildings.filter((candidate) => candidate.id !== building.id), docks: draft.docks.filter((dock) => dock.buildingCode !== building.code) }));
                onSelect(null);
              }
            : undefined
        }
      >
        <div className="grid grid-cols-2 gap-2">
          <TextField label={t('common.code')} value={building.code} onChange={(code) => patch({ code: code.toUpperCase() })} />
          <TextField label={t('admin.layout.label')} value={building.label} onChange={(label) => patch({ label })} />
          <NumberField label={t('admin.layout.width')} value={building.width} min={10} max={200} onChange={(width) => patch({ width })} testId="building-width" />
          <NumberField label={t('admin.layout.depth')} value={building.depth} min={10} max={160} onChange={(depth) => patch({ depth })} />
          <NumberField label={t('admin.layout.height')} value={building.height} min={4} max={24} onChange={(height) => patch({ height })} />
          <div>
            <Label>{t('admin.layout.roof')}</Label>
            <Select value={building.roof} onChange={(event) => patch({ roof: event.target.value as typeof building.roof })}>
              {(['gable', 'flat', 'sawtooth'] as const).map((roof) => (
                <option key={roof} value={roof}>
                  {t(`admin.layout.roofs.${roof}`)}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('admin.layout.roofColor')}</Label>
            <Input type="color" value={building.roofColor} onChange={(event) => patch({ roofColor: event.target.value })} className="h-9 p-1" />
          </div>
          <div>
            <Label>{t('admin.layout.wallColor')}</Label>
            <Input type="color" value={building.wallColor} onChange={(event) => patch({ wallColor: event.target.value })} className="h-9 p-1" />
          </div>
          <NumberField label="X (m)" value={building.x} onChange={(x) => patch({ x })} />
          <NumberField label="Z (m)" value={building.z} onChange={(z) => patch({ z })} />
        </div>
      </Panel>
    );
  }

  if (selection?.kind === 'dock') {
    const dock = blueprint.docks.find((candidate) => candidate.id === selection.id);
    if (!dock) return null;
    const building = blueprint.buildings.find((candidate) => candidate.code === dock.buildingCode);
    const patch = (fields: Partial<typeof dock>) => onChange((draft) => ({ ...draft, docks: draft.docks.map((candidate) => (candidate.id === dock.id ? { ...candidate, ...fields } : candidate)) }));
    return (
      <Panel
        title={t('admin.layout.kinds.dock')}
        onDelete={() => {
          onChange((draft) => ({ ...draft, docks: draft.docks.filter((candidate) => candidate.id !== dock.id) }));
          onSelect(null);
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <TextField label={t('common.code')} value={dock.code} onChange={(code) => patch({ code: code.toUpperCase() })} />
          <TextField label={t('admin.layout.label')} value={dock.label} onChange={(label) => patch({ label })} testId="dock-label" />
          <div>
            <Label>{t('admin.layout.building')}</Label>
            <Select value={dock.buildingCode} onChange={(event) => patch({ buildingCode: event.target.value })}>
              {blueprint.buildings.map((candidate) => (
                <option key={candidate.id} value={candidate.code}>
                  {candidate.code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>{t('admin.layout.face')}</Label>
            <Select value={dock.face} onChange={(event) => patch({ face: event.target.value as typeof dock.face })}>
              {(['S', 'E', 'N', 'W'] as const).map((face) => (
                <option key={face} value={face}>
                  {t(`admin.layout.faces.${face}`)}
                </option>
              ))}
            </Select>
          </div>
          <NumberField label={t('admin.layout.offset')} value={dock.offset} min={3} max={building ? faceLength(building, dock.face) - 3 : 200} onChange={(offset) => patch({ offset })} />
          <div>
            <Label>{t('admin.layout.direction')}</Label>
            <Select value={dock.direction} onChange={(event) => patch({ direction: event.target.value as typeof dock.direction })}>
              {(['BOTH', 'INBOUND', 'OUTBOUND'] as const).map((direction) => (
                <option key={direction} value={direction}>
                  {t(`direction.${direction}`)}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <p className="text-xs text-muted">{t('admin.layout.dockHint')}</p>
      </Panel>
    );
  }

  if (selection?.kind === 'staging') {
    const grid = blueprint.stagingGrids.find((candidate) => candidate.id === selection.id);
    if (!grid) return null;
    const patch = (fields: Partial<typeof grid>) => onChange((draft) => ({ ...draft, stagingGrids: draft.stagingGrids.map((candidate) => (candidate.id === grid.id ? { ...candidate, ...fields } : candidate)) }));
    return (
      <Panel
        title={t('admin.layout.kinds.staging')}
        onDelete={() => {
          onChange((draft) => ({ ...draft, stagingGrids: draft.stagingGrids.filter((candidate) => candidate.id !== grid.id) }));
          onSelect(null);
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <TextField label={t('admin.layout.codePrefix')} value={grid.codePrefix} onChange={(codePrefix) => patch({ codePrefix: codePrefix.toUpperCase() })} />
          <TextField label={t('admin.layout.labelPrefix')} value={grid.labelPrefix} onChange={(labelPrefix) => patch({ labelPrefix })} />
          <NumberField label={t('admin.layout.rows')} value={grid.rows} min={1} max={10} onChange={(rows) => patch({ rows })} />
          <NumberField label={t('admin.layout.columns')} value={grid.columns} min={1} max={20} onChange={(columns) => patch({ columns })} testId="staging-columns" />
          <NumberField label={t('admin.layout.capacityEach')} value={grid.capacityEach} min={1} max={12} onChange={(capacityEach) => patch({ capacityEach })} />
          <NumberField label={t('admin.layout.spacing')} value={grid.spacing} min={2.6} max={8} step={0.2} onChange={(spacing) => patch({ spacing })} />
          <NumberField label={t('admin.layout.startNumber')} value={grid.startNumber} min={1} max={900} onChange={(startNumber) => patch({ startNumber })} />
        </div>
        <p className="text-xs text-muted">{t('admin.layout.slotCodes', { first: `${grid.codePrefix}${String(grid.startNumber).padStart(2, '0')}`, last: `${grid.codePrefix}${String(grid.startNumber + grid.rows * grid.columns - 1).padStart(2, '0')}` })}</p>
      </Panel>
    );
  }

  if (selection?.kind === 'rack') {
    const rack = blueprint.racks.find((candidate) => candidate.id === selection.id);
    if (!rack) return null;
    const patch = (fields: Partial<typeof rack>) => onChange((draft) => ({ ...draft, racks: draft.racks.map((candidate) => (candidate.id === rack.id ? { ...candidate, ...fields } : candidate)) }));
    return (
      <Panel
        title={t('admin.layout.kinds.rack')}
        onDelete={() => {
          onChange((draft) => ({ ...draft, racks: draft.racks.filter((candidate) => candidate.id !== rack.id) }));
          onSelect(null);
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <TextField label={t('common.code')} value={rack.code} onChange={(code) => patch({ code: code.toUpperCase() })} />
          <RotationField label={t('admin.layout.rotation')} value={rack.rotation} onChange={(rotation) => patch({ rotation })} />
          <NumberField label={t('admin.layout.levels')} value={rack.levels} min={1} max={6} onChange={(levels) => patch({ levels })} />
          <NumberField label={t('admin.layout.bays')} value={rack.bays} min={1} max={8} onChange={(bays) => patch({ bays })} />
        </div>
        <p className="text-xs text-muted">{t('admin.layout.rackCapacity', { n: rack.levels * rack.bays })}</p>
      </Panel>
    );
  }

  if (selection?.kind === 'yard' || selection?.kind === 'charger') {
    const listKey = selection.kind === 'yard' ? 'yardRows' : 'chargerRows';
    const row = blueprint[listKey].find((candidate) => candidate.id === selection.id);
    if (!row) return null;
    const patch = (fields: Partial<typeof row>) => onChange((draft) => ({ ...draft, [listKey]: draft[listKey].map((candidate) => (candidate.id === row.id ? { ...candidate, ...fields } : candidate)) }));
    return (
      <Panel
        title={t(`admin.layout.kinds.${selection.kind}`)}
        onDelete={() => {
          onChange((draft) => ({ ...draft, [listKey]: draft[listKey].filter((candidate) => candidate.id !== row.id) }));
          onSelect(null);
        }}
      >
        <div className="grid grid-cols-2 gap-2">
          <TextField label={t('admin.layout.codePrefix')} value={row.codePrefix} onChange={(codePrefix) => patch({ codePrefix: codePrefix.toUpperCase() })} />
          <NumberField label={t('admin.layout.count')} value={row.count} min={1} max={20} onChange={(count) => patch({ count })} />
          <NumberField label={t('admin.layout.spacing')} value={row.spacing} min={3} max={12} step={0.5} onChange={(spacing) => patch({ spacing })} />
          <RotationField label={t('admin.layout.rotation')} value={row.rotation} onChange={(rotation) => patch({ rotation })} />
        </div>
      </Panel>
    );
  }

  if (selection?.kind === 'gate') {
    return (
      <Panel title={t('admin.layout.kinds.gate')}>
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="X (m)" value={blueprint.gate.x} onChange={(x) => onChange((draft) => ({ ...draft, gate: { ...draft.gate, x } }))} />
          <NumberField label="Z (m)" value={blueprint.gate.z} onChange={(z) => onChange((draft) => ({ ...draft, gate: { ...draft.gate, z } }))} />
        </div>
        <p className="text-xs text-muted">{t('admin.layout.gateHint')}</p>
      </Panel>
    );
  }

  const summary = blueprintSummary(blueprint);
  return (
    <Panel title={t('admin.layout.siteSettings')}>
      <div className="grid grid-cols-2 gap-2">
        <TextField
          label={t('admin.layout.indoorPrefix')}
          value={blueprint.indoorStorage.codePrefix}
          onChange={(codePrefix) => onChange((draft) => ({ ...draft, indoorStorage: { ...draft.indoorStorage, codePrefix: codePrefix.toUpperCase() } }))}
        />
        <NumberField
          label={t('admin.layout.indoorCapacityEach')}
          value={blueprint.indoorStorage.capacityEach}
          min={1}
          max={200}
          onChange={(capacityEach) => onChange((draft) => ({ ...draft, indoorStorage: { ...draft.indoorStorage, capacityEach } }))}
        />
        <div className="col-span-2">
          <NumberField
            label={t('admin.layout.totalPallets')}
            value={blueprint.indoorStorage.totalPallets}
            min={0}
            max={100000}
            step={50}
            testId="total-pallets"
            onChange={(totalPallets) => onChange((draft) => ({ ...draft, indoorStorage: { ...draft.indoorStorage, totalPallets } }))}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={blueprint.landscaping} onChange={(event) => onChange((draft) => ({ ...draft, landscaping: event.target.checked }))} />
        {t('admin.layout.landscaping')}
      </label>
      <div className="rounded-xl bg-slate-50 p-3 text-sm">
        <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{t('admin.layout.summary')}</div>
        <dl className="grid grid-cols-2 gap-y-1">
          <dt className="text-muted">{t('admin.layout.kinds.dock')}</dt>
          <dd className="tabular text-right font-medium">{summary.docks}</dd>
          <dt className="text-muted">{t('admin.layout.kinds.staging')}</dt>
          <dd className="tabular text-right font-medium">{summary.stagingSlots}</dd>
          <dt className="text-muted">{t('admin.layout.kinds.yard')}</dt>
          <dd className="tabular text-right font-medium">{summary.yardSlots}</dd>
          <dt className="text-muted">{t('admin.layout.kinds.charger')}</dt>
          <dd className="tabular text-right font-medium">{summary.chargers}</dd>
          <dt className="text-muted">{t('admin.layout.storagePositions')}</dt>
          <dd className="tabular text-right font-medium">{summary.storagePositions.toLocaleString()}</dd>
        </dl>
      </div>
      <p className="text-xs text-muted">{t('admin.layout.selectHint')}</p>
    </Panel>
  );
}
