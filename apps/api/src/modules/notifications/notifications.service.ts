import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { NotificationDto, NotificationList, NotificationSeverity, RealtimeEnvelope } from '@waretrack/shared-schemas';
import { DomainError } from '../../platform/errors/domain-error';
import { PublishedEventBus, UserChannel } from '../../platform/outbox/event-bus';
import { PrismaService } from '../../platform/prisma/prisma.service';

interface Rule {
  permission: string;
  category: string;
  severity: NotificationSeverity;
  title: string;
  body?: string | null;
  link?: string | null;
}

const LOW_BATTERY_PCT = 20;

/**
 * Notifications (mục 13.2, FR-18): tiêu thụ event ĐÃ commit, sinh thông báo theo rule cho user có quyền tại site,
 * idempotent theo (eventId, userId) vì relay giao at-least-once. Không ghi ngược vào domain.
 */
@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);
  private siteCodes = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: PublishedEventBus,
    private readonly users: UserChannel,
  ) {}

  onModuleInit() {
    this.bus.subscribe((e) => this.handle(e));
  }

  private async siteCode(siteId: string) {
    if (!this.siteCodes.has(siteId)) {
      const s = await this.prisma.site.findUnique({ where: { id: siteId } });
      if (s) this.siteCodes.set(siteId, s.code);
    }
    return this.siteCodes.get(siteId) ?? null;
  }

  /** Rule FR-18.02 (phần MVP): exception, xe nâng hỏng / pin yếu, xe lưu bãi chờ duyệt xuất, xe tải tới cổng. */
  private async rules(e: RealtimeEnvelope): Promise<Rule[]> {
    const d = e.data as Record<string, any>;
    const code = await this.siteCode(e.siteId);
    const base = code ? `/sites/${code}` : '';
    switch (e.type) {
      case 'exception.raised':
        if (d.status !== 'OPEN') return [];
        return [
          {
            permission: 'exception.resolve',
            category: 'EXCEPTION',
            severity: d.severity === 'CRITICAL' ? 'CRITICAL' : d.severity === 'HIGH' ? 'HIGH' : 'WARNING',
            title: `${d.code} · ${d.caseType}`,
            body: d.description,
            link: `${base}/exceptions?case=${d.caseId}`,
          },
        ];
      case 'forklift.status_changed': {
        const f = d.forklift ?? {};
        const out: Rule[] = [];
        if (f.status === 'MAINTENANCE' && d.fromStatus !== 'MAINTENANCE') {
          out.push({ permission: 'equipment.manage', category: 'EQUIPMENT', severity: 'HIGH', title: `${f.code} · Maintenance`, body: d.reason ?? null, link: `${base}?select=forklift:${f.id}` });
        }
        if (d.lowBattery) {
          out.push({ permission: 'equipment.manage', category: 'EQUIPMENT', severity: 'WARNING', title: `${f.code} · Battery ${f.batteryPct}% (< ${LOW_BATTERY_PCT}%)`, body: null, link: `${base}?select=forklift:${f.id}` });
        }
        return out;
      }
      case 'vehicle.status_changed': {
        const v = d.vehicle ?? {};
        if (v.status === 'RELEASE_REQUESTED' && d.fromStatus === 'STORED') {
          return [{ permission: 'vehicle.release.approve', category: 'VEHICLE', severity: 'INFO', title: `Release request · ${v.vin}`, body: v.label ?? null, link: `${base}/vehicles?stay=${v.stayId}` }];
        }
        return [];
      }
      case 'truck.arrived': {
        const truck = d.visit?.truck ?? {};
        return [{ permission: 'yard.dock.assign', category: 'YARD', severity: 'INFO', title: `${truck.code ?? 'Truck'} at gate`, body: [truck.plateNumber, truck.carrier?.name].filter(Boolean).join(' · ') || null, link: `${base}/yard?visit=${d.visitId}` }];
      }
      default:
        return [];
    }
  }

  private async recipients(siteId: string, permission: string): Promise<string[]> {
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        siteRoles: { some: { revokedAt: null, OR: [{ siteId }, { siteId: null }], role: { permissions: { some: { permission: { code: permission } } } } } },
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private async handle(e: RealtimeEnvelope) {
    for (const rule of await this.rules(e)) {
      const userIds = await this.recipients(e.siteId, rule.permission);
      if (userIds.length === 0) continue;
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({ siteId: e.siteId, userId, eventId: `${e.eventId}:${rule.category}`, category: rule.category, severity: rule.severity, title: rule.title, body: rule.body ?? null, link: rule.link ?? null })),
        skipDuplicates: true,
      });
      const created = await this.prisma.notification.findMany({ where: { eventId: `${e.eventId}:${rule.category}`, userId: { in: userIds } } });
      for (const n of created) this.users.send(n.userId, 'notification.created', { notificationId: n.id, category: n.category, severity: n.severity, title: n.title, link: n.link });
    }
  }

  // ───────────── Queries / commands (#193–#195) ─────────────

  async list(userId: string, opts: { unread?: boolean; siteId?: string; limit?: number }): Promise<NotificationList> {
    const where = { userId, ...(opts.siteId ? { siteId: opts.siteId } : {}) };
    const [rows, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({ where: { ...where, ...(opts.unread ? { readAt: null } : {}) }, orderBy: { createdAt: 'desc' }, take: Math.min(opts.limit ?? 30, 100) }),
      this.prisma.notification.count({ where: { ...where, readAt: null } }),
    ]);
    const items: NotificationDto[] = [];
    for (const n of rows) {
      items.push({
        id: n.id,
        siteId: n.siteId,
        siteCode: n.siteId ? await this.siteCode(n.siteId) : null,
        category: n.category,
        severity: n.severity as NotificationSeverity,
        title: n.title,
        body: n.body,
        link: n.link,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      });
    }
    return { items, unreadCount };
  }

  async markRead(userId: string, id: string) {
    const res = await this.prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
    if (res.count === 0 && !(await this.prisma.notification.findFirst({ where: { id, userId } }))) throw DomainError.notFound('Notification');
  }

  async readAll(userId: string, siteId?: string) {
    await this.prisma.notification.updateMany({ where: { userId, readAt: null, ...(siteId ? { siteId } : {}) }, data: { readAt: new Date() } });
  }
}
