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
    this.bus.subscribe((event) => this.handle(event));
  }

  private async siteCode(siteId: string) {
    if (!this.siteCodes.has(siteId)) {
      const site = await this.prisma.site.findUnique({ where: { id: siteId } });
      if (site) this.siteCodes.set(siteId, site.code);
    }
    return this.siteCodes.get(siteId) ?? null;
  }

  /** Rule FR-18.02 (phần MVP): exception, xe nâng hỏng / pin yếu, xe lưu bãi chờ duyệt xuất, xe tải tới cổng. */
  private async rules(event: RealtimeEnvelope): Promise<Rule[]> {
    const payload = event.data as Record<string, any>;
    const code = await this.siteCode(event.siteId);
    const base = code ? `/sites/${code}` : '';
    switch (event.type) {
      case 'exception.raised':
        if (payload.status !== 'OPEN') return [];
        return [
          {
            permission: 'exception.resolve',
            category: 'EXCEPTION',
            severity: payload.severity === 'CRITICAL' ? 'CRITICAL' : payload.severity === 'HIGH' ? 'HIGH' : 'WARNING',
            title: `${payload.code} · ${payload.caseType}`,
            body: payload.description,
            link: `${base}/exceptions?case=${payload.caseId}`,
          },
        ];
      case 'forklift.status_changed': {
        const forklift = payload.forklift ?? {};
        const out: Rule[] = [];
        if (forklift.status === 'MAINTENANCE' && payload.fromStatus !== 'MAINTENANCE') {
          out.push({ permission: 'equipment.manage', category: 'EQUIPMENT', severity: 'HIGH', title: `${forklift.code} · Maintenance`, body: payload.reason ?? null, link: `${base}?select=forklift:${forklift.id}` });
        }
        if (payload.lowBattery) {
          out.push({ permission: 'equipment.manage', category: 'EQUIPMENT', severity: 'WARNING', title: `${forklift.code} · Battery ${forklift.batteryPct}% (< ${LOW_BATTERY_PCT}%)`, body: null, link: `${base}?select=forklift:${forklift.id}` });
        }
        return out;
      }
      case 'vehicle.status_changed': {
        const vehicle = payload.vehicle ?? {};
        if (vehicle.status === 'RELEASE_REQUESTED' && payload.fromStatus === 'STORED') {
          return [{ permission: 'vehicle.release.approve', category: 'VEHICLE', severity: 'INFO', title: `Release request · ${vehicle.vin}`, body: vehicle.label ?? null, link: `${base}/vehicles?stay=${vehicle.stayId}` }];
        }
        return [];
      }
      case 'truck.arrived': {
        const truck = payload.visit?.truck ?? {};
        return [{ permission: 'yard.dock.assign', category: 'YARD', severity: 'INFO', title: `${truck.code ?? 'Truck'} at gate`, body: [truck.plateNumber, truck.carrier?.name].filter(Boolean).join(' · ') || null, link: `${base}/yard?visit=${payload.visitId}` }];
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
    return users.map((user) => user.id);
  }

  private async handle(event: RealtimeEnvelope) {
    for (const rule of await this.rules(event)) {
      const userIds = await this.recipients(event.siteId, rule.permission);
      if (userIds.length === 0) continue;
      await this.prisma.notification.createMany({
        data: userIds.map((userId) => ({ siteId: event.siteId, userId, eventId: `${event.eventId}:${rule.category}`, category: rule.category, severity: rule.severity, title: rule.title, body: rule.body ?? null, link: rule.link ?? null })),
        skipDuplicates: true,
      });
      const created = await this.prisma.notification.findMany({ where: { eventId: `${event.eventId}:${rule.category}`, userId: { in: userIds } } });
      for (const notification of created) this.users.send(notification.userId, 'notification.created', { notificationId: notification.id, category: notification.category, severity: notification.severity, title: notification.title, link: notification.link });
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
    for (const notification of rows) {
      items.push({
        id: notification.id,
        siteId: notification.siteId,
        siteCode: notification.siteId ? await this.siteCode(notification.siteId) : null,
        category: notification.category,
        severity: notification.severity as NotificationSeverity,
        title: notification.title,
        body: notification.body,
        link: notification.link,
        readAt: notification.readAt?.toISOString() ?? null,
        createdAt: notification.createdAt.toISOString(),
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
