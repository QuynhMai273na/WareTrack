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
          .filter((location) => location.locationType === 'DOCK')
          .map((location) => {
            const occupancies = occ.get(location.id) ?? [];
            const visitOccupancy = occupancies.find((occupancy) => occupancy.occupantType === 'TRUCK_VISIT');
            return { locationId: location.id, code: location.code, direction: location.dock?.direction ?? 'BOTH', effectiveStatus: effectiveStatus(location, occupancies).status, visitId: visitOccupancy?.occupantId ?? null, version: location.version };
          });
        const slots = locations
          .filter((location) => location.locationType !== 'DOCK')
          .map((location) => {
            const occupancies = occ.get(location.id) ?? [];
            const cur = occupancies.find((occupancy) => occupancy.kind === 'OCCUPIED') ?? occupancies[0];
            return { locationId: location.id, code: location.code, locationType: location.locationType, effectiveStatus: effectiveStatus(location, occupancies).status, occupantType: cur?.occupantType ?? null, occupantId: cur?.occupantId ?? null };
          });

        const visits = await tx.truckVisit.findMany({
          where: { siteId, status: { in: ['SCHEDULED', 'AT_GATE', 'WAITING', 'DOCK_ASSIGNED', 'AT_DOCK', 'HANDLING', 'READY_TO_LEAVE'] } },
          include: { truck: { include: { carrier: true } } },
          orderBy: { appointmentStart: 'asc' },
        });
        const truckOcc = await tx.locationOccupancy.findMany({
          where: { occupantType: 'TRUCK_VISIT', occupantId: { in: visits.map((visit) => visit.id) }, releasedAt: null, kind: 'OCCUPIED' },
        });
        const trucks: SnapshotTruck[] = visits.map((visit) => {
          const occupancy = truckOcc.find((truckOccupancy) => truckOccupancy.occupantId === visit.id);
          return {
            visitId: visit.id,
            code: visit.code,
            truckCode: visit.truck.code,
            plate: visit.truck.plateNumber,
            carrier: visit.truck.carrier?.name ?? null,
            truckType: visit.truck.truckType,
            direction: visit.direction,
            status: visit.status,
            dockLocationId: visit.dockLocationId,
            position: occupancy ? { locationId: occupancy.locationId, source: occupancy.positionSource ?? 'CONFIRMED_MANUAL', confirmedAt: (occupancy.occupiedAt ?? occupancy.startedAt).toISOString() } : null,
            etaAt: (visit.etaAt ?? visit.appointmentStart)?.toISOString() ?? null,
            version: visit.version,
          };
        });

        const forklifts = (await tx.equipment.findMany({ where: { siteId, deletedAt: null }, orderBy: { code: 'asc' } })).map((equipment) => this.equipment.toSnapshot(equipment));

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
        for (const contributor of this.contributors.snapshot) Object.assign(snapshot, await contributor(tx, siteId));
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
  async search(query: string, allowedSiteIds: string[], limit = 20): Promise<SearchResult[]> {
    const term = query.trim();
    if (term.length < 2) return [];
    const like = { contains: term, mode: 'insensitive' as const };
    const sites = await this.prisma.site.findMany({ where: { id: { in: allowedSiteIds }, OR: [{ code: like }, { name: like }] }, take: 5 });
    const siteCode = new Map((await this.prisma.site.findMany({ where: { id: { in: allowedSiteIds } } })).map((site) => [site.id, site.code]));
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
      ...sites.map((site) => ({ type: 'site' as const, id: site.id, code: site.code, label: site.name, siteId: site.id, siteCode: site.code })),
      ...visits.map((visit) => ({ type: 'truck' as const, id: visit.id, code: visit.truck.code, label: `${visit.truck.plateNumber} · ${visit.status}`, siteId: visit.siteId, siteCode: siteCode.get(visit.siteId) ?? null })),
      ...equipment.map((forklift) => ({ type: 'forklift' as const, id: forklift.id, code: forklift.code, label: forklift.model ?? forklift.equipmentType, siteId: forklift.siteId, siteCode: siteCode.get(forklift.siteId) ?? null })),
      ...stays.map((stay) => ({ type: 'vehicle' as const, id: stay.id, code: stay.vehicle.vin, label: [stay.vehicle.make, stay.vehicle.model, stay.status].filter(Boolean).join(' · '), siteId: stay.siteId, siteCode: siteCode.get(stay.siteId) ?? null })),
      ...locations.map((location) => ({ type: 'location' as const, id: location.id, code: location.code, label: location.locationType, siteId: location.siteId, siteCode: siteCode.get(location.siteId) ?? null })),
    ].slice(0, limit);
  }
}
