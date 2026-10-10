import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { EventsReplayResponse, SearchResult, SiteSnapshot, SnapshotTruck } from '@waretrack/shared-schemas';
import { DomainError } from '../../platform/errors/domain-error';
import { toEnvelope } from '../../platform/outbox/outbox-relay.service';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { EquipmentService } from '../equipment/equipment.service';
import { effectiveStatus } from '../sites/sites.service';
import { OccupancyService } from '../yard/occupancy.service';
import { DashboardContributors } from './contributors';
import { KpiService } from './kpi.service';

const REPLAY_RETENTION_MS = 24 * 3600_000;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly occupancy: OccupancyService,
    private readonly equipment: EquipmentService,
    private readonly kpis: KpiService,
    private readonly contributors: DashboardContributors,
  ) {}

  /**
   * Snapshot toàn site cho scene + bảng (mục 16.5.8): đọc trong một transaction REPEATABLE READ READ ONLY,
   * asOfSeq lấy cùng snapshot để client áp dụng event có siteSeq > asOfSeq (mục 17.6).
   */
  async snapshot(siteId: string): Promise<SiteSnapshot> {
    const kpis = await this.kpis.get(siteId);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        const site = await tx.site.findFirst({ where: { id: siteId, deletedAt: null } });
        if (!site) throw DomainError.notFound('Site');
        const cursor = await tx.siteEventCursor.findUnique({ where: { siteId } });
        const layout = await tx.layoutVersion.findFirst({ where: { siteId, status: 'PUBLISHED' }, select: { id: true } });
        const locations = await tx.location.findMany({
          where: { siteId, deletedAt: null, locationType: { in: ['DOCK', 'PARKING_SLOT', 'YARD_SLOT'] } },
          include: { dock: true },
          orderBy: { code: 'asc' },
        });
        const occ = await this.occupancy.activeByLocations(siteId, undefined, tx);

        const docks = locations
          .filter((l) => l.locationType === 'DOCK')
          .map((l) => {
            const o = occ.get(l.id) ?? [];
            const v = o.find((x) => x.occupantType === 'TRUCK_VISIT');
            return { locationId: l.id, code: l.code, direction: l.dock?.direction ?? 'BOTH', effectiveStatus: effectiveStatus(l, o).status, visitId: v?.occupantId ?? null, version: l.version };
          });
        const slots = locations
          .filter((l) => l.locationType !== 'DOCK')
          .map((l) => {
            const o = occ.get(l.id) ?? [];
            const cur = o.find((x) => x.kind === 'OCCUPIED') ?? o[0];
            return { locationId: l.id, code: l.code, locationType: l.locationType, effectiveStatus: effectiveStatus(l, o).status, occupantType: cur?.occupantType ?? null, occupantId: cur?.occupantId ?? null };
          });

        const visits = await tx.truckVisit.findMany({
          where: { siteId, status: { in: ['SCHEDULED', 'AT_GATE', 'WAITING', 'DOCK_ASSIGNED', 'AT_DOCK', 'HANDLING', 'READY_TO_LEAVE'] } },
          include: { truck: { include: { carrier: true } } },
          orderBy: { appointmentStart: 'asc' },
        });
        const truckOcc = await tx.locationOccupancy.findMany({
          where: { occupantType: 'TRUCK_VISIT', occupantId: { in: visits.map((v) => v.id) }, releasedAt: null, kind: 'OCCUPIED' },
        });
        const trucks: SnapshotTruck[] = visits.map((v) => {
          const o = truckOcc.find((x) => x.occupantId === v.id);
          return {
            visitId: v.id,
            code: v.code,
            truckCode: v.truck.code,
            plate: v.truck.plateNumber,
            carrier: v.truck.carrier?.name ?? null,
            truckType: v.truck.truckType,
            direction: v.direction,
            status: v.status,
            dockLocationId: v.dockLocationId,
            position: o ? { locationId: o.locationId, source: o.positionSource ?? 'CONFIRMED_MANUAL', confirmedAt: (o.occupiedAt ?? o.startedAt).toISOString() } : null,
            etaAt: (v.etaAt ?? v.appointmentStart)?.toISOString() ?? null,
            version: v.version,
          };
        });

        const forklifts = (await tx.equipment.findMany({ where: { siteId, deletedAt: null }, orderBy: { code: 'asc' } })).map((e) => this.equipment.toSnapshot(e));

        const snapshot: SiteSnapshot = {
          site: { id: site.id, code: site.code, name: site.name, timezone: site.timezone, siteType: site.siteType },
          asOfSeq: Number(cursor?.lastSeq ?? 0),
          asOf: new Date().toISOString(),
          layoutVersionId: layout?.id ?? null,
          kpis,
          docks,
          slots,
          trucks,
          forklifts,
          pallets: [],
          vehicles: [],
          activeShipments: [],
        };
        for (const c of this.contributors.snapshot) Object.assign(snapshot, await c(tx, siteId));
        return snapshot;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15_000 },
    );
  }

  /** Replay event theo siteSeq (mục 17.6 bước 4) — retention 24h. */
  async events(siteId: string, afterSeq: number, limit = 500): Promise<EventsReplayResponse> {
    const cursor = await this.prisma.siteEventCursor.findUnique({ where: { siteId } });
    const latestSeq = Number(cursor?.lastSeq ?? 0);
    const rows = await this.prisma.outboxEvent.findMany({
      where: { siteId, siteSeq: { gt: BigInt(afterSeq) }, publishedAt: { not: null } },
      orderBy: { siteSeq: 'asc' },
      take: Math.min(limit, 1000),
    });
    const first = rows[0];
    const truncated =
      (first !== undefined && Number(first.siteSeq) !== afterSeq + 1) ||
      (rows.length === 0 && latestSeq > afterSeq) ||
      (first !== undefined && Date.now() - first.createdAt.getTime() > REPLAY_RETENTION_MS);
    return { events: rows.map(toEnvelope), latestSeq, truncated };
  }

  /** Tìm kiếm toàn cục trong các site được phép (#191). */
  async search(q: string, allowedSiteIds: string[], limit = 20): Promise<SearchResult[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    const like = { contains: term, mode: 'insensitive' as const };
    const sites = await this.prisma.site.findMany({ where: { id: { in: allowedSiteIds }, OR: [{ code: like }, { name: like }] }, take: 5 });
    const siteCode = new Map((await this.prisma.site.findMany({ where: { id: { in: allowedSiteIds } } })).map((s) => [s.id, s.code]));
    const visits = await this.prisma.truckVisit.findMany({
      where: { siteId: { in: allowedSiteIds }, status: { notIn: ['EXITED', 'CANCELLED', 'NO_SHOW', 'REJECTED'] }, OR: [{ code: like }, { truck: { code: like } }, { truck: { plateNumber: like } }] },
      include: { truck: true },
      take: limit,
    });
    const equipment = await this.prisma.equipment.findMany({ where: { siteId: { in: allowedSiteIds }, deletedAt: null, code: like }, take: limit });
    const locations = await this.prisma.location.findMany({ where: { siteId: { in: allowedSiteIds }, deletedAt: null, code: like }, take: 5 });
    const stays = await this.prisma.vehicleStay.findMany({
      where: { siteId: { in: allowedSiteIds }, status: { notIn: ['EXITED', 'CANCELLED'] }, vehicle: { OR: [{ vin: like }, { plateNumber: like }] } },
      include: { vehicle: true },
      take: limit,
    });
    return [
      ...sites.map((s) => ({ type: 'site' as const, id: s.id, code: s.code, label: s.name, siteId: s.id, siteCode: s.code })),
      ...visits.map((v) => ({ type: 'truck' as const, id: v.id, code: v.truck.code, label: `${v.truck.plateNumber} · ${v.status}`, siteId: v.siteId, siteCode: siteCode.get(v.siteId) ?? null })),
      ...equipment.map((e) => ({ type: 'forklift' as const, id: e.id, code: e.code, label: e.model ?? e.equipmentType, siteId: e.siteId, siteCode: siteCode.get(e.siteId) ?? null })),
      ...stays.map((v) => ({ type: 'vehicle' as const, id: v.id, code: v.vehicle.vin, label: [v.vehicle.make, v.vehicle.model, v.status].filter(Boolean).join(' · '), siteId: v.siteId, siteCode: siteCode.get(v.siteId) ?? null })),
      ...locations.map((l) => ({ type: 'location' as const, id: l.id, code: l.code, label: l.locationType, siteId: l.siteId, siteCode: siteCode.get(l.siteId) ?? null })),
    ].slice(0, limit);
  }
}
