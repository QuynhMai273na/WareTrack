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

function upsertBy<T extends Versioned>(list: T[], item: T, key: (entry: T) => string): T[] {
  const idx = list.findIndex((existingEntry) => key(existingEntry) === key(item));
  if (idx === -1) return [...list, item];
  if (list[idx].version > item.version) return list; // chỉ patch khi version mới hơn (mục 17.6)
  const next = list.slice();
  next[idx] = item;
  return next;
}

/** Patch snapshot trong cache theo event (state-carrying). Trả về snapshot mới (bất biến). */
export function applyEventToSnapshot(snap: SiteSnapshot, event: RealtimeEnvelope): SiteSnapshot {
  const payload = event.data as Record<string, any>;
  switch (event.type) {
    case 'truck.arrived':
    case 'truck.dock_assigned':
    case 'truck.docked':
    case 'truck.status_changed':
    case 'truck.departed': {
      const visit = payload.visit;
      if (!visit) return snap;
      if (['EXITED', 'REJECTED', 'NO_SHOW', 'CANCELLED'].includes(visit.status)) {
        return { ...snap, trucks: snap.trucks.filter((truck) => truck.visitId !== visit.id) };
      }
      const existing = snap.trucks.find((truck) => truck.visitId === visit.id);
      const docked = ['AT_DOCK', 'HANDLING'].includes(visit.status) && visit.dock;
      return {
        ...snap,
        trucks: upsertBy(
          snap.trucks,
          {
            visitId: visit.id,
            code: visit.code,
            truckCode: visit.truck.code,
            plate: visit.truck.plateNumber,
            carrier: visit.truck.carrier?.name ?? null,
            truckType: visit.truck.truckType,
            direction: visit.direction,
            status: visit.status,
            dockLocationId: visit.dock?.id ?? null,
            position: docked ? { locationId: visit.dock.id, source: 'CONFIRMED_SCAN', confirmedAt: visit.dockedAt ?? event.occurredAt } : (existing?.position && visit.status === 'READY_TO_LEAVE' ? existing.position : null),
            etaAt: visit.etaAt ?? visit.appointmentStart ?? null,
            version: visit.version,
          },
          (truck) => truck.visitId,
        ),
      };
    }
    case 'dock.status_changed':
      return {
        ...snap,
        docks: snap.docks.map((dk) =>
          dk.locationId === payload.locationId ? { ...dk, effectiveStatus: payload.effectiveStatus, visitId: payload.visitId ?? null, version: payload.locationVersion ?? dk.version } : dk,
        ),
      };
    case 'slot.status_changed':
      return {
        ...snap,
        slots: snap.slots.map((slot) => (slot.locationId === payload.locationId ? { ...slot, effectiveStatus: payload.effectiveStatus, occupantType: payload.occupantType, occupantId: payload.occupantId } : slot)),
      };
    case 'site.kpi_updated':
      return { ...snap, kpis: payload.kpis ?? snap.kpis };
    case 'forklift.status_changed':
    case 'forklift.task_updated':
      if (!payload.forklift) return snap;
      return { ...snap, forklifts: upsertBy(snap.forklifts, payload.forklift, (forklift) => forklift.id) };
    case 'pallet.moved':
      if (!payload.pallet) return snap;
      return {
        ...snap,
        pallets: ['DISPATCHED', 'EMPTY'].includes(payload.pallet.lifecycle) ? snap.pallets.filter((pallet) => pallet.id !== payload.pallet.id) : upsertBy(snap.pallets, payload.pallet, (pallet) => pallet.id),
      };
    case 'vehicle.status_changed':
    case 'vehicle.location_changed':
      if (!payload.vehicle) return snap;
      return {
        ...snap,
        vehicles: ['EXITED', 'CANCELLED'].includes(payload.vehicle.status) ? snap.vehicles.filter((vehicle) => vehicle.stayId !== payload.vehicle.stayId) : upsertBy(snap.vehicles, payload.vehicle, (vehicle) => vehicle.stayId),
      };
    case 'shipment.progress_updated':
      if (!payload.shipment) return snap;
      return {
        ...snap,
        activeShipments: ['DELIVERED', 'CANCELLED', 'CLOSED'].includes(payload.shipment.status)
          ? snap.activeShipments.filter((shipment) => shipment.id !== payload.shipment.id)
          : upsertBy(snap.activeShipments, payload.shipment, (shipment) => shipment.id),
      };
    default:
      return snap;
  }
}
