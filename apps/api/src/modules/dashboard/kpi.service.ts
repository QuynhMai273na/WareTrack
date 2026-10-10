import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { KpiDto } from '@waretrack/shared-schemas';
import { ON_SITE_VISIT_STATUSES } from '@waretrack/shared-schemas';
import { PublishedEventBus } from '../../platform/outbox/event-bus';
import { OutboxService } from '../../platform/outbox/outbox.service';
import { PrismaService } from '../../platform/prisma/prisma.service';
import { startOfTodayInTz } from '../../platform/time/site-time';
import { OccupancyService } from '../yard/occupancy.service';
import { DashboardContributors } from './contributors';

const CACHE_MS = 15_000;
const DEBOUNCE_MS = 2_000;

/**
 * KPI theo mục 11: tính trực tiếp trên bảng nghiệp vụ, cache 15s theo site, invalidate khi có event liên quan
 * và phát site.kpi_updated (debounce 2s/site). Mỗi KPI có đơn vị riêng — không cộng gộp (BR-31).
 */
@Injectable()
export class KpiService implements OnModuleInit {
  private cache = new Map<string, { at: number; kpis: KpiDto[] }>();
  private timers = new Map<string, NodeJS.Timeout>();
  private readonly log = new Logger(KpiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly occupancy: OccupancyService,
    private readonly contributors: DashboardContributors,
    private readonly bus: PublishedEventBus,
    private readonly outbox: OutboxService,
  ) {}

  onModuleInit() {
    this.bus.subscribe((event) => {
      if (event.type === 'site.kpi_updated' || event.type === 'layout.published') return;
      this.cache.delete(event.siteId);
      this.scheduleBroadcast(event.siteId);
    });
  }

  private scheduleBroadcast(siteId: string) {
    if (this.timers.has(siteId)) return;
    this.timers.set(
      siteId,
      setTimeout(async () => {
        this.timers.delete(siteId);
        // Lỗi trong timer không có ai bắt → phải tự nuốt, nếu không sẽ làm sập tiến trình (vd. site vừa bị xóa khi seed lại)
        try {
          const kpis = await this.get(siteId);
          await this.prisma.$transaction((tx) =>
            this.outbox.publish(tx, {
              siteId,
              type: 'site.kpi_updated',
              aggregateType: 'Site',
              aggregateId: siteId,
              // KPI là read model: version = epoch giây (tăng đơn điệu) để client bỏ bản cũ hơn
              aggregateVersion: Math.floor(Date.now() / 1000),
              data: { kpis, asOf: new Date().toISOString() },
            }),
          );
        } catch (e) {
          this.log.warn(`KPI broadcast for site ${siteId} skipped: ${(e as Error).message.trim().split('\n').pop()}`);
        }
      }, DEBOUNCE_MS),
    );
  }

  async get(siteId: string): Promise<KpiDto[]> {
    const hit = this.cache.get(siteId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.kpis;
    const kpis = await this.compute(siteId);
    this.cache.set(siteId, { at: Date.now(), kpis });
    return kpis;
  }

  private async compute(siteId: string): Promise<KpiDto[]> {
    const site = await this.prisma.site.findUniqueOrThrow({ where: { id: siteId } });
    const now = new Date();
    const todayStart = startOfTodayInTz(site.timezone, now);
    const asOf = now.toISOString();

    // K-03 Trucks on site (BR-32) — arriving (SCHEDULED, hẹn trong 2 giờ tới) hiển thị tách, không cộng vào on site
    const onSite = await this.prisma.truckVisit.count({ where: { siteId, status: { in: ON_SITE_VISIT_STATUSES } } });
    const arriving = await this.prisma.truckVisit.count({
      where: { siteId, status: 'SCHEDULED', appointmentStart: { lte: new Date(now.getTime() + 2 * 3600_000) } },
    });
    const docked = await this.prisma.truckVisit.count({ where: { siteId, status: { in: ['AT_DOCK', 'HANDLING'] } } });
    const arrivedLastHour = await this.prisma.truckVisit.count({ where: { siteId, status: { in: ON_SITE_VISIT_STATUSES }, arrivedAt: { gte: new Date(now.getTime() - 3600_000) } } });
    const inbound = await this.prisma.truckVisit.count({ where: { siteId, status: 'SCHEDULED', etaAt: { gte: todayStart, lte: new Date(now.getTime() + 2 * 3600_000) } } });

    // K-04a Dock utilization tức thời
    const docks = await this.prisma.location.findMany({ where: { siteId, locationType: 'DOCK', deletedAt: null, isActive: true } });
    const occ = await this.occupancy.activeByLocations(siteId);
    const docksAvailableTotal = docks.filter((d) => !d.blockedAt).length;
    const docksOccupied = docks.filter((d) => (occ.get(d.id) ?? []).some((o) => o.kind === 'OCCUPIED')).length;

    // K-02 Yard occupancy — ô đỗ xe lưu bãi (parking slots), loại slot bị block khỏi mẫu số
    const slots = await this.prisma.location.findMany({ where: { siteId, locationType: 'PARKING_SLOT', deletedAt: null, isActive: true } });
    const slotsActive = slots.filter((s) => !s.blockedAt);
    const slotsUsed = slotsActive.filter((s) => (occ.get(s.id) ?? []).length > 0).length;

    // K-07 Outbound today — xe tải xuất đã rời site hôm nay (không tính visit abort)
    const outboundToday = await this.prisma.truckVisit.count({
      where: { siteId, direction: 'OUTBOUND', status: 'EXITED', exitedAt: { gte: todayStart }, exitReason: { not: 'ABORTED' } },
    });

    // K-09 Forklift availability
    const forklifts = await this.prisma.equipment.findMany({ where: { siteId, deletedAt: null, equipmentType: 'FORKLIFT' } });
    const fleet = forklifts.filter((f) => f.status !== 'OFFLINE').length;
    const working = forklifts.filter((f) => f.status === 'ASSIGNED' || f.status === 'BUSY').length;
    const available = forklifts.filter((f) => f.status === 'AVAILABLE').length;

    const pct = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 10);

    const kpis: KpiDto[] = [
      { key: 'TRUCKS_ON_SITE', value: onSite, unit: 'trucks', sub: { arriving, docked, inbound }, delta: arrivedLastHour, deltaPeriod: 'last hour', asOf },
      { key: 'DOCK_UTILIZATION', value: pct(docksOccupied, docksAvailableTotal), unit: '%', total: docksAvailableTotal, sub: { occupied: docksOccupied, outOfService: docks.length - docksAvailableTotal }, asOf },
      { key: 'YARD_OCCUPANCY', value: pct(slotsUsed, slotsActive.length), unit: '%', total: slotsActive.length, sub: { used: slotsUsed, blocked: slots.length - slotsActive.length }, asOf },
      { key: 'OUTBOUND_TODAY', value: outboundToday, unit: 'trucks', deltaPeriod: 'today', asOf },
      { key: 'FORKLIFT_AVAILABILITY', value: pct(working + available, fleet), unit: '%', total: fleet, sub: { working, available }, asOf },
    ];
    for (const c of this.contributors.kpis) kpis.push(...(await c(siteId, { todayStart, now })));
    return kpis;
  }
}
