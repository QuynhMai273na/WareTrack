import type { RealtimeEnvelope, SiteSnapshot } from '@waretrack/shared-schemas';

/**
 * Logic đồng bộ thuần (không phụ thuộc React/socket) theo thuật toán mục 17.6 — để unit test CT-11, CT-12.
 */
export class SiteSequencer {
  lastSeq = 0;
  private seen = new Set<string>();
  private seenOrder: string[] = [];
  private buffer = new Map<number, RealtimeEnvelope>();

  constructor(readonly siteId: string) {}

  reset(asOfSeq: number) {
    this.lastSeq = asOfSeq;
    for (const seq of [...this.buffer.keys()]) if (seq <= asOfSeq) this.buffer.delete(seq);
  }

  /** Trả về các event đã sẵn sàng áp dụng theo thứ tự và cờ gap nếu thiếu event ở giữa. */
  accept(event: RealtimeEnvelope): { ready: RealtimeEnvelope[]; gap: boolean } {
    if (event.siteId !== this.siteId) return { ready: [], gap: false }; // event site cũ đến muộn (UC-21-AC1)
    if (this.seen.has(event.eventId) || event.siteSeq <= this.lastSeq) return { ready: [], gap: false };
    this.buffer.set(event.siteSeq, event);
    const ready: RealtimeEnvelope[] = [];
    while (this.buffer.has(this.lastSeq + 1)) {
      const next = this.buffer.get(this.lastSeq + 1)!;
      this.buffer.delete(this.lastSeq + 1);
      this.lastSeq = next.siteSeq;
      this.markSeen(next.eventId);
      ready.push(next);
    }
    return { ready, gap: this.buffer.size > 0 };
  }

  private markSeen(id: string) {
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift()!);
  }
}

type Versioned = { version: number };

function upsertBy<T extends Versioned>(list: T[], item: T, key: (t: T) => string): T[] {
  const idx = list.findIndex((x) => key(x) === key(item));
  if (idx === -1) return [...list, item];
  if (list[idx].version > item.version) return list; // chỉ patch khi version mới hơn (mục 17.6)
  const next = list.slice();
  next[idx] = item;
  return next;
}

/** Patch snapshot trong cache theo event (state-carrying). Trả về snapshot mới (bất biến). */
export function applyEventToSnapshot(snap: SiteSnapshot, e: RealtimeEnvelope): SiteSnapshot {
  const d = e.data as Record<string, any>;
  switch (e.type) {
    case 'truck.arrived':
    case 'truck.dock_assigned':
    case 'truck.docked':
    case 'truck.status_changed':
    case 'truck.departed': {
      const v = d.visit;
      if (!v) return snap;
      if (['EXITED', 'REJECTED', 'NO_SHOW', 'CANCELLED'].includes(v.status)) {
        return { ...snap, trucks: snap.trucks.filter((t) => t.visitId !== v.id) };
      }
      const existing = snap.trucks.find((t) => t.visitId === v.id);
      const docked = ['AT_DOCK', 'HANDLING'].includes(v.status) && v.dock;
      return {
        ...snap,
        trucks: upsertBy(
          snap.trucks,
          {
            visitId: v.id,
            code: v.code,
            truckCode: v.truck.code,
            plate: v.truck.plateNumber,
            carrier: v.truck.carrier?.name ?? null,
            truckType: v.truck.truckType,
            direction: v.direction,
            status: v.status,
            dockLocationId: v.dock?.id ?? null,
            position: docked ? { locationId: v.dock.id, source: 'CONFIRMED_SCAN', confirmedAt: v.dockedAt ?? e.occurredAt } : (existing?.position && v.status === 'READY_TO_LEAVE' ? existing.position : null),
            etaAt: v.etaAt ?? v.appointmentStart ?? null,
            version: v.version,
          },
          (t) => t.visitId,
        ),
      };
    }
    case 'dock.status_changed':
      return {
        ...snap,
        docks: snap.docks.map((dk) =>
          dk.locationId === d.locationId ? { ...dk, effectiveStatus: d.effectiveStatus, visitId: d.visitId ?? null, version: d.locationVersion ?? dk.version } : dk,
        ),
      };
    case 'slot.status_changed':
      return {
        ...snap,
        slots: snap.slots.map((s) => (s.locationId === d.locationId ? { ...s, effectiveStatus: d.effectiveStatus, occupantType: d.occupantType, occupantId: d.occupantId } : s)),
      };
    case 'site.kpi_updated':
      return { ...snap, kpis: d.kpis ?? snap.kpis };
    case 'forklift.status_changed':
    case 'forklift.task_updated':
      if (!d.forklift) return snap;
      return { ...snap, forklifts: upsertBy(snap.forklifts, d.forklift, (f) => f.id) };
    case 'pallet.moved':
      if (!d.pallet) return snap;
      return {
        ...snap,
        pallets: ['DISPATCHED', 'EMPTY'].includes(d.pallet.lifecycle) ? snap.pallets.filter((p) => p.id !== d.pallet.id) : upsertBy(snap.pallets, d.pallet, (p) => p.id),
      };
    case 'vehicle.status_changed':
    case 'vehicle.location_changed':
      if (!d.vehicle) return snap;
      return {
        ...snap,
        vehicles: ['EXITED', 'CANCELLED'].includes(d.vehicle.status) ? snap.vehicles.filter((x) => x.stayId !== d.vehicle.stayId) : upsertBy(snap.vehicles, d.vehicle, (x) => x.stayId),
      };
    case 'shipment.progress_updated':
      if (!d.shipment) return snap;
      return {
        ...snap,
        activeShipments: ['DELIVERED', 'CANCELLED', 'CLOSED'].includes(d.shipment.status)
          ? snap.activeShipments.filter((s) => s.id !== d.shipment.id)
          : upsertBy(snap.activeShipments, d.shipment, (s) => s.id),
      };
    default:
      return snap;
  }
}
