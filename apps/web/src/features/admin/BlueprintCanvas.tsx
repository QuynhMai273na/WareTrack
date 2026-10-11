import type { SiteBlueprint } from '@waretrack/shared-schemas';
import { SITE_PLOT } from '@waretrack/shared-schemas';
import { type PointerEvent as ReactPointerEvent, useMemo, useRef, useState } from 'react';
import {
  type BlueprintObjectKind,
  type BlueprintSelection,
  CHARGER_SIZE,
  DOCK_APRON_DEPTH,
  DOCK_DOOR_WIDTH,
  dockDoorPoint,
  faceOutward,
  GATE_SIZE,
  offsetAlongFace,
  rackFootprint,
  YARD_SLOT_SIZE,
} from './blueprint-geometry';

const PLOT_WIDTH = SITE_PLOT.maxX - SITE_PLOT.minX;
const GRID_STEP = 10;
const SELECTED_STROKE = '#f59e0b';
/** Lề quanh nội dung và kích thước khung tối thiểu (m) khi tự thu phóng mặt bằng. */
const VIEW_MARGIN = 16;
const MIN_VIEW = { width: 140, depth: 100 };

interface PlanViewBox {
  minX: number;
  minZ: number;
  width: number;
  depth: number;
}

/** Khung nhìn vừa nội dung bản thiết kế (nhà, dock, ô, cổng, đường nội khu), không vượt khu đất. */
function contentViewBox(blueprint: SiteBlueprint): PlanViewBox {
  const xs: number[] = [];
  const zs: number[] = [];
  const include = (x: number, z: number) => {
    xs.push(x);
    zs.push(z);
  };
  for (const building of blueprint.buildings) {
    include(building.x - DOCK_APRON_DEPTH, building.z - DOCK_APRON_DEPTH);
    include(building.x + building.width + DOCK_APRON_DEPTH, building.z + building.depth + DOCK_APRON_DEPTH);
  }
  for (const grid of blueprint.stagingGrids) {
    include(grid.x, grid.z);
    include(grid.x + grid.columns * grid.spacing, grid.z + grid.rows * grid.spacing);
  }
  for (const rack of blueprint.racks) include(rack.x, rack.z);
  for (const row of [...blueprint.yardRows, ...blueprint.chargerRows]) {
    include(row.x, row.z - YARD_SLOT_SIZE.depth / 2);
    include(row.x + row.count * row.spacing, row.z + YARD_SLOT_SIZE.depth / 2);
  }
  include(blueprint.gate.x, blueprint.gate.z - GATE_SIZE.depth);
  include(blueprint.gate.x, Math.min(SITE_PLOT.maxZ, blueprint.gate.z + 22));
  const minX = Math.max(SITE_PLOT.minX, Math.min(...xs) - VIEW_MARGIN);
  const minZ = Math.max(SITE_PLOT.minZ, Math.min(...zs) - VIEW_MARGIN);
  const maxX = Math.min(SITE_PLOT.maxX, Math.max(...xs) + VIEW_MARGIN);
  const maxZ = Math.min(SITE_PLOT.maxZ, Math.max(...zs) + VIEW_MARGIN);
  const width = Math.max(MIN_VIEW.width, maxX - minX);
  const depth = Math.max(MIN_VIEW.depth, maxZ - minZ);
  return { minX: Math.max(SITE_PLOT.minX, Math.min(minX, SITE_PLOT.maxX - width)), minZ: Math.max(SITE_PLOT.minZ, Math.min(minZ, SITE_PLOT.maxZ - depth)), width, depth };
}

interface DragState {
  kind: BlueprintObjectKind;
  id: string;
  pointerStart: { x: number; z: number };
  objectStart: { x: number; z: number };
  moved: boolean;
}

const clampToPlot = (point: { x: number; z: number }) => ({
  x: Math.max(SITE_PLOT.minX, Math.min(SITE_PLOT.maxX, point.x)),
  z: Math.max(SITE_PLOT.minZ, Math.min(SITE_PLOT.maxZ, point.z)),
});

/**
 * Mặt bằng 2D của bản thiết kế: lưới 10 m, kéo-thả để di chuyển (bắt điểm 1 m), dock trượt dọc theo tường.
 * Trục dọc của SVG là +Z (nam ở dưới) — đúng hướng bản đồ nhìn từ trên xuống.
 */
export function BlueprintCanvas({
  blueprint,
  selection,
  onSelect,
  onChange,
}: {
  blueprint: SiteBlueprint;
  selection: BlueprintSelection | null;
  onSelect: (selection: BlueprintSelection | null) => void;
  onChange: (updater: (draft: SiteBlueprint) => SiteBlueprint) => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  // Khung nhìn giữ nguyên trong lúc kéo (tránh mặt bằng tự thu phóng dưới con trỏ), cập nhật khi thả
  const frozenViewBox = useRef<PlanViewBox | null>(null);
  const fittedViewBox = useMemo(() => contentViewBox(blueprint), [blueprint]);
  if (!dragState) frozenViewBox.current = fittedViewBox;
  const viewBox = frozenViewBox.current ?? fittedViewBox;

  const toPlanPoint = (event: ReactPointerEvent) => {
    const svg = svgRef.current!;
    const screenPoint = svg.createSVGPoint();
    screenPoint.x = event.clientX;
    screenPoint.y = event.clientY;
    const planPoint = screenPoint.matrixTransform(svg.getScreenCTM()!.inverse());
    return { x: planPoint.x, z: planPoint.y };
  };

  const objectPosition = (kind: BlueprintObjectKind, id: string): { x: number; z: number } => {
    switch (kind) {
      case 'building':
        return blueprint.buildings.find((building) => building.id === id)!;
      case 'staging':
        return blueprint.stagingGrids.find((grid) => grid.id === id)!;
      case 'rack':
        return blueprint.racks.find((rack) => rack.id === id)!;
      case 'yard':
        return blueprint.yardRows.find((row) => row.id === id)!;
      case 'charger':
        return blueprint.chargerRows.find((row) => row.id === id)!;
      case 'gate':
        return blueprint.gate;
      case 'dock': {
        const dock = blueprint.docks.find((candidate) => candidate.id === id)!;
        const building = blueprint.buildings.find((candidate) => candidate.code === dock.buildingCode)!;
        return dockDoorPoint(building, dock.face, dock.offset);
      }
    }
  };

  const startDrag = (kind: BlueprintObjectKind, id: string) => (event: ReactPointerEvent) => {
    event.stopPropagation();
    (event.target as Element).setPointerCapture?.(event.pointerId);
    onSelect({ kind, id });
    setDragState({ kind, id, pointerStart: toPlanPoint(event), objectStart: { ...objectPosition(kind, id) }, moved: false });
  };

  const moveObject = (event: ReactPointerEvent) => {
    if (!dragState) return;
    const pointer = toPlanPoint(event);
    const target = clampToPlot({
      x: Math.round(dragState.objectStart.x + pointer.x - dragState.pointerStart.x),
      z: Math.round(dragState.objectStart.z + pointer.z - dragState.pointerStart.z),
    });
    if (!dragState.moved && Math.hypot(pointer.x - dragState.pointerStart.x, pointer.z - dragState.pointerStart.z) < 0.8) return;
    if (!dragState.moved) setDragState({ ...dragState, moved: true });
    const { kind, id } = dragState;
    onChange((draft) => {
      switch (kind) {
        case 'building':
          // Dock gắn theo mã nhà nên tự đi theo khi kéo nhà
          return { ...draft, buildings: draft.buildings.map((building) => (building.id === id ? { ...building, x: target.x, z: target.z } : building)) };
        case 'staging':
          return { ...draft, stagingGrids: draft.stagingGrids.map((grid) => (grid.id === id ? { ...grid, ...target } : grid)) };
        case 'rack':
          return { ...draft, racks: draft.racks.map((rack) => (rack.id === id ? { ...rack, ...target } : rack)) };
        case 'yard':
          return { ...draft, yardRows: draft.yardRows.map((row) => (row.id === id ? { ...row, ...target } : row)) };
        case 'charger':
          return { ...draft, chargerRows: draft.chargerRows.map((row) => (row.id === id ? { ...row, ...target } : row)) };
        case 'gate':
          return { ...draft, gate: { ...draft.gate, ...target } };
        case 'dock':
          return {
            ...draft,
            docks: draft.docks.map((dock) => {
              if (dock.id !== id) return dock;
              const building = draft.buildings.find((candidate) => candidate.code === dock.buildingCode)!;
              return { ...dock, offset: offsetAlongFace(building, dock.face, pointer) };
            }),
          };
      }
    });
  };

  const isSelected = (kind: BlueprintObjectKind, id: string) => selection?.kind === kind && selection.id === id;
  const strokeFor = (kind: BlueprintObjectKind, id: string, base: string) => (isSelected(kind, id) ? SELECTED_STROKE : base);
  const accessRoadZ = Math.min(SITE_PLOT.maxZ - 4, blueprint.gate.z + 14);

  const gridLines = [];
  for (let gridX = Math.ceil(SITE_PLOT.minX / GRID_STEP) * GRID_STEP; gridX <= SITE_PLOT.maxX; gridX += GRID_STEP) {
    gridLines.push(<line key={`grid-x-${gridX}`} x1={gridX} y1={SITE_PLOT.minZ} x2={gridX} y2={SITE_PLOT.maxZ} stroke={gridX === 0 ? '#b9c3dc' : '#e2e7f2'} strokeWidth={gridX === 0 ? 0.35 : 0.2} />);
  }
  for (let gridZ = Math.ceil(SITE_PLOT.minZ / GRID_STEP) * GRID_STEP; gridZ <= SITE_PLOT.maxZ; gridZ += GRID_STEP) {
    gridLines.push(<line key={`grid-z-${gridZ}`} x1={SITE_PLOT.minX} y1={gridZ} x2={SITE_PLOT.maxX} y2={gridZ} stroke={gridZ === 0 ? '#b9c3dc' : '#e2e7f2'} strokeWidth={gridZ === 0 ? 0.35 : 0.2} />);
  }

  return (
    <svg
      ref={svgRef}
      data-testid="blueprint-canvas"
      viewBox={`${viewBox.minX} ${viewBox.minZ} ${viewBox.width} ${viewBox.depth}`}
      preserveAspectRatio="xMidYMid meet"
      className="h-full w-full touch-none select-none rounded-xl bg-[#f6f8fd]"
      onPointerMove={moveObject}
      onPointerUp={() => setDragState(null)}
      onPointerLeave={() => setDragState(null)}
      onPointerDown={() => onSelect(null)}
    >
      {gridLines}
      {/* Đường nội khu (tự sinh theo vị trí cổng) */}
      <rect x={SITE_PLOT.minX} y={accessRoadZ - 7} width={PLOT_WIDTH} height={14} fill="#dfe3ec" />
      <line x1={SITE_PLOT.minX} y1={accessRoadZ} x2={SITE_PLOT.maxX} y2={accessRoadZ} stroke="#ffffff" strokeWidth={0.5} strokeDasharray="3 3" />

      {blueprint.yardRows.map((row) =>
        Array.from({ length: row.count }, (_, slotIndex) => {
          const vertical = Math.abs(row.rotation) !== 90;
          const width = vertical ? YARD_SLOT_SIZE.width : YARD_SLOT_SIZE.depth;
          const depth = vertical ? YARD_SLOT_SIZE.depth : YARD_SLOT_SIZE.width;
          const centerX = row.x + slotIndex * row.spacing;
          return (
            <rect
              key={`${row.id}-${slotIndex}`}
              x={centerX - width / 2}
              y={row.z - depth / 2}
              width={width}
              height={depth}
              fill="#eef1f6"
              stroke={strokeFor('yard', row.id, '#94a3b8')}
              strokeWidth={0.4}
              strokeDasharray="1.2 0.8"
              className="cursor-move"
              onPointerDown={startDrag('yard', row.id)}
            />
          );
        }),
      )}

      {blueprint.buildings.map((building) => (
        <g key={building.id} className="cursor-move" onPointerDown={startDrag('building', building.id)} data-testid={`canvas-building-${building.code}`}>
          <rect x={building.x} y={building.z} width={building.width} height={building.depth} fill={building.roofColor} fillOpacity={0.85} stroke={strokeFor('building', building.id, '#1f4fb8')} strokeWidth={isSelected('building', building.id) ? 0.9 : 0.4} rx={0.6} />
          <text x={building.x + building.width / 2} y={building.z + building.depth / 2} textAnchor="middle" dominantBaseline="middle" fontSize={3.2} fill="#ffffff" fontWeight={600} pointerEvents="none">
            {building.code}
          </text>
        </g>
      ))}

      {blueprint.docks.map((dock) => {
        const building = blueprint.buildings.find((candidate) => candidate.code === dock.buildingCode);
        if (!building) return null;
        const door = dockDoorPoint(building, dock.face, dock.offset);
        const outward = faceOutward(dock.face);
        const alongX = outward.x === 0;
        const apronWidth = alongX ? DOCK_DOOR_WIDTH : DOCK_APRON_DEPTH;
        const apronDepth = alongX ? DOCK_APRON_DEPTH : DOCK_DOOR_WIDTH;
        const apronX = alongX ? door.x - DOCK_DOOR_WIDTH / 2 : outward.x > 0 ? door.x : door.x - DOCK_APRON_DEPTH;
        const apronZ = alongX ? (outward.z > 0 ? door.z : door.z - DOCK_APRON_DEPTH) : door.z - DOCK_DOOR_WIDTH / 2;
        return (
          <g key={dock.id} className="cursor-ew-resize" onPointerDown={startDrag('dock', dock.id)} data-testid={`canvas-dock-${dock.code}`}>
            <rect x={apronX} y={apronZ} width={apronWidth} height={apronDepth} fill="#fde9b6" fillOpacity={0.6} stroke={strokeFor('dock', dock.id, '#d9a400')} strokeWidth={isSelected('dock', dock.id) ? 0.8 : 0.35} />
            <rect x={door.x - (alongX ? DOCK_DOOR_WIDTH / 2 : 0.6)} y={door.z - (alongX ? 0.6 : DOCK_DOOR_WIDTH / 2)} width={alongX ? DOCK_DOOR_WIDTH : 1.2} height={alongX ? 1.2 : DOCK_DOOR_WIDTH} fill="#1e3a8a" />
            <text x={door.x + outward.x * (DOCK_APRON_DEPTH * 0.55)} y={door.z + outward.z * (DOCK_APRON_DEPTH * 0.55)} textAnchor="middle" dominantBaseline="middle" fontSize={2.2} fill="#7a5a00" fontWeight={600} pointerEvents="none">
              {dock.label}
            </text>
          </g>
        );
      })}

      {blueprint.stagingGrids.map((grid) => {
        const width = (grid.columns - 1) * grid.spacing + 2.6;
        const depth = (grid.rows - 1) * grid.spacing + 2.6;
        return (
          <g key={grid.id} className="cursor-move" onPointerDown={startDrag('staging', grid.id)}>
            <rect x={grid.x - 1.8} y={grid.z - 1.8} width={width + 1} height={depth + 1} fill="#fff7e0" stroke={strokeFor('staging', grid.id, '#e3b33c')} strokeWidth={isSelected('staging', grid.id) ? 0.8 : 0.35} rx={0.4} />
            {Array.from({ length: grid.rows * grid.columns }, (_, slotIndex) => (
              <rect
                key={slotIndex}
                x={grid.x + (slotIndex % grid.columns) * grid.spacing - 1.3}
                y={grid.z + Math.floor(slotIndex / grid.columns) * grid.spacing - 1.3}
                width={2.6}
                height={2.6}
                fill="none"
                stroke="#e0a400"
                strokeWidth={0.3}
                pointerEvents="none"
              />
            ))}
          </g>
        );
      })}

      {blueprint.racks.map((rack) => {
        const footprint = rackFootprint(rack.bays, rack.rotation);
        return (
          <g key={rack.id} className="cursor-move" onPointerDown={startDrag('rack', rack.id)}>
            <rect x={rack.x - footprint.width / 2} y={rack.z - footprint.depth / 2} width={footprint.width} height={footprint.depth} fill="#2f6fe4" fillOpacity={0.35} stroke={strokeFor('rack', rack.id, '#1f4fb8')} strokeWidth={isSelected('rack', rack.id) ? 0.7 : 0.3} />
            <text x={rack.x} y={rack.z - footprint.depth / 2 - 1} textAnchor="middle" fontSize={1.8} fill="#1f4fb8" pointerEvents="none">
              {rack.code}
            </text>
          </g>
        );
      })}

      {blueprint.chargerRows.map((row) =>
        Array.from({ length: row.count }, (_, chargerIndex) => (
          <rect
            key={`${row.id}-${chargerIndex}`}
            x={row.x + chargerIndex * row.spacing - CHARGER_SIZE.width / 2}
            y={row.z - CHARGER_SIZE.depth / 2}
            width={CHARGER_SIZE.width}
            height={CHARGER_SIZE.depth}
            fill="#dcfce7"
            stroke={strokeFor('charger', row.id, '#16a34a')}
            strokeWidth={0.4}
            className="cursor-move"
            onPointerDown={startDrag('charger', row.id)}
          />
        )),
      )}

      <g className="cursor-move" onPointerDown={startDrag('gate', 'gate')} data-testid="canvas-gate">
        <rect x={blueprint.gate.x - GATE_SIZE.width / 2} y={blueprint.gate.z - GATE_SIZE.depth / 2} width={GATE_SIZE.width} height={GATE_SIZE.depth} fill="#e6f4ea" stroke={strokeFor('gate', 'gate', '#16a34a')} strokeWidth={isSelected('gate', 'gate') ? 0.8 : 0.4} />
        <text x={blueprint.gate.x} y={blueprint.gate.z - GATE_SIZE.depth / 2 - 1.2} textAnchor="middle" fontSize={2.2} fill="#15803d" fontWeight={600} pointerEvents="none">
          GATE
        </text>
      </g>
    </svg>
  );
}
