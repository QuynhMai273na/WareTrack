import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import type { TruckVisit, TruckVisitStatus } from '@prisma/client';
import { DEFAULT_GATE_DOCUMENT_CHECKLIST } from '@waretrack/shared-schemas';
import { PrismaService, TxRunner } from '../platform/prisma/prisma.service';
import { EquipmentService } from '../modules/equipment/equipment.service';
import { DEMO_PASSWORD, DEMO_SCENES, type SiteScene } from './demo-script';

const ACTIVE: TruckVisitStatus[] = ['SCHEDULED', 'AT_GATE', 'WAITING', 'DOCK_ASSIGNED', 'AT_DOCK', 'HANDLING', 'READY_TO_LEAVE'];
const sec = 1000;
/** Nhịp điều phối (ms): đủ chậm để thấy xe lùi vào bay, xe nâng chở từng pallet. */
const DWELL = { gate: 12 * sec, docking: 26 * sec, atDock: 6 * sec, step: 24 * sec, ready: 10 * sec, putaway: 14 * sec, spawnEta: 140 * sec };

interface Mem {
  status: TruckVisitStatus;
  since: number;
  lastStep: number;
}

/**
 * DemoDirector (DEC-51, chỉ bật khi DEMO_DIRECTOR=true): dựng trạng thái mở màn giống video qua API thật,
 * rồi liên tục điều phối — xe tới cổng, lùi vào bay, xếp/dỡ từng pallet, rời site, xe mới tới.
 * Mọi thay đổi nghiệp vụ đi qua HTTP API (đủ RBAC, idempotency, outbox → realtime); chỉ đọc trạng thái từ DB.
 * Trạng thái hoạt động của xe nâng (đang xếp/dỡ cho xe nào) đặt qua EquipmentService — tương đương operator báo trên thiết bị.
 */
@Injectable()
export class DemoDirector implements OnApplicationShutdown {
  private readonly logger = new Logger('DemoDirector');
  private base = '';
  private tokens = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private mem = new Map<string, Mem>();
  private forkliftOf = new Map<string, string>();
  private siteIds = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tx: TxRunner,
    private readonly equipment: EquipmentService,
  ) {}

  enabled() {
    return process.env.DEMO_DIRECTOR === 'true';
  }

  start(port: number) {
    if (!this.enabled()) return;
    this.base = `http://127.0.0.1:${port}/api/v1`;
    setTimeout(() => void this.run(), 1500);
  }

  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }

  private async run() {
    // Chờ seed nạp xong (cờ seed.completedAt) — tránh dựng cảnh trên dữ liệu dở dang
    for (;;) {
      const done = await this.prisma.siteSetting.findFirst({ where: { key: 'seed.completedAt' } }).catch(() => null);
      if (done) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    try {
      const sites = await this.prisma.site.findMany({ where: { deletedAt: null } });
      for (const s of sites) this.siteIds.set(s.code, s.id);
      await this.bootstrap();
    } catch (err) {
      this.logger.error(`Bootstrap failed: ${(err as Error).message}`);
    }
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      void this.tick()
        .catch((err) => this.logger.warn(`Tick: ${(err as Error).message}`))
        .finally(() => (this.busy = false));
    }, 3000);
    this.logger.log('Demo director running');
  }

  // ───────────── HTTP tới chính API ─────────────

  private async token(user: string) {
    const hit = this.tokens.get(user);
    if (hit) return hit;
    const res = await fetch(`${this.base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: DEMO_PASSWORD }) });
    if (!res.ok) throw new Error(`login ${user} → ${res.status}`);
    const t = ((await res.json()) as { accessToken: string }).accessToken;
    this.tokens.set(user, t);
    return t;
  }

  private async call<T = Record<string, unknown>>(user: string, method: 'GET' | 'POST', path: string, body?: unknown, retry = true): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${await this.token(user)}` };
    if (method === 'POST') headers['idempotency-key'] = randomUUID();
    const res = await fetch(`${this.base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401 && retry) {
      this.tokens.delete(user);
      return this.call(user, method, path, body, false);
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.code ?? ''} ${json.detail ?? json.title ?? ''}`);
    return json as T;
  }

  private S(code: string) {
    return `/sites/${this.siteIds.get(code)}`;
  }

  private async setShipmentCode(next: number) {
    await this.prisma.codeCounter.upsert({ where: { scope: 'SHP' }, update: { value: next - 1 }, create: { scope: 'SHP', value: next - 1 } });
  }

  /**
   * Mã lô hàng theo video được đặt không theo thứ tự (78442…78472) → sau khi dựng cảnh, bộ đếm phải vượt số lớn nhất,
   * nếu không lô hàng mới sẽ trùng mã (CODE_ALREADY_EXISTS) và mọi xe kẹt ở dock.
   */
  private async syncShipmentCounter() {
    const scripted = DEMO_SCENES.flatMap((sc) => [...sc.outbound, ...sc.inbound].map((x) => x.shipment));
    const top = Math.max(0, ...scripted);
    const current = await this.prisma.codeCounter.findUnique({ where: { scope: 'SHP' } });
    if (!current || current.value < top) await this.setShipmentCode(top + 1);
  }

  private async partnerId(name: string) {
    return (await this.prisma.partner.findFirst({ where: { name } }))?.id;
  }

  private async sku(code: string) {
    return this.prisma.sku.findFirstOrThrow({ where: { code } });
  }

  private perPallet(code: string) {
    return { 'GEN-RETAIL': 40, 'FRZ-BERRY': 96, 'PKG-FILM': 60, 'ELE-CABLE': 80, 'OFF-PAPER': 50, 'BEV-JUICE': 70 }[code] ?? 40;
  }

  private async visitOf(site: string, truck: string) {
    return this.prisma.truckVisit.findFirst({ where: { siteId: this.siteIds.get(site), truck: { code: truck }, status: { in: ACTIVE } }, include: { truck: true } });
  }

  /** Người lái của xe nâng (để làm assignee task). */
  private async operatorFor(siteId: string, forkliftCode?: string) {
    // Người lái không đang dở task nào (BR-27: một người chỉ một task IN_PROGRESS)
    const busy = new Set((await this.prisma.operationTask.findMany({ where: { status: 'IN_PROGRESS', assigneeId: { not: null } }, select: { assigneeId: true } })).map((t) => t.assigneeId!));
    const fleet = await this.prisma.equipment.findMany({ where: { siteId, currentOperatorId: { not: null } }, orderBy: { code: 'asc' } });
    const preferred = forkliftCode ? fleet.find((e) => e.code === forkliftCode) : undefined;
    const pick = [preferred, ...fleet].find((e) => e && !busy.has(e.currentOperatorId!));
    return pick ? this.prisma.user.findUnique({ where: { id: pick.currentOperatorId! } }) : null;
  }

  /** Thực hiện một task (assign → start → xác nhận nguồn → xác nhận đích) bằng tài khoản người lái. */
  private async runTask(site: string, taskId: string, operator: { id: string; username: string }, destCode?: string) {
    const S = this.S(site);
    let task = await this.call<{ id: string; version: number; status: string; from: { qrValue: string } | null; to: { qrValue: string; code: string } | null; subject: { code: string } }>('manager', 'GET', `${S}/tasks/${taskId}`);
    // Task dở dang của người khác → để người đó làm tiếp
    if (task.status === 'IN_PROGRESS') {
      const t = await this.prisma.operationTask.findUnique({ where: { id: taskId } });
      const assignee = t?.assigneeId ? await this.prisma.user.findUnique({ where: { id: t.assigneeId } }) : null;
      if (assignee) operator = assignee;
    }
    if (task.status === 'PENDING') task = await this.call('manager', 'POST', `${S}/tasks/${taskId}/assign`, { assigneeId: operator.id, expectedVersion: task.version });
    if (task.status === 'ASSIGNED') task = await this.call(operator.username, 'POST', `${S}/tasks/${taskId}/start`, { expectedVersion: task.version });
    if (task.from) await this.call(operator.username, 'POST', `${S}/tasks/${taskId}/confirm-source`, { locationScan: task.from.qrValue, subjectScan: task.subject.code });
    const dest = destCode ? await this.prisma.location.findFirst({ where: { siteId: this.siteIds.get(site), code: destCode } }) : null;
    await this.call(operator.username, 'POST', `${S}/tasks/${taskId}/confirm-destination`, { locationScan: dest?.qrValue ?? task.to!.qrValue });
  }

  /**
   * Mốc tracking như video: outbound lùi giờ Order Confirmed/Picked; inbound bổ sung mốc phía kho gửi
   * (Order Confirmed, Picked, Loaded, In Transit — nguồn ASN của nhà cung cấp).
   */
  private async backdateMilestones(visitId: string, direction: 'INBOUND' | 'OUTBOUND') {
    const ship = await this.prisma.shipment.findFirst({ where: { truckVisitId: visitId, direction }, orderBy: { createdAt: 'desc' } });
    if (!ship) return;
    const ago = (m: number) => new Date(Date.now() - m * 60_000);
    const jitter = () => Math.floor(Math.random() * 12);
    // Bảng milestone là append-only → chỉ THÊM mốc sớm hơn (đơn tạo ở ERP, soạn xong trước giờ demo); stepper lấy mốc sớm nhất
    if (direction === 'OUTBOUND') {
      if (await this.prisma.shipmentMilestone.count({ where: { shipmentId: ship.id, source: 'ERP' } })) return;
      await this.prisma.shipmentMilestone.createMany({
        data: [
          { shipmentId: ship.id, milestone: 'CREATED', occurredAt: ago(165 + jitter()), source: 'ERP' },
          ...(['DRAFT', 'CONFIRMED', 'PICKING'].includes(ship.status) ? [] : [{ shipmentId: ship.id, milestone: 'STAGED', occurredAt: ago(78 + jitter()), source: 'ERP' }]),
        ],
      });
      return;
    }
    const exists = await this.prisma.shipmentMilestone.count({ where: { shipmentId: ship.id, milestone: 'ORDER_CONFIRMED' } });
    if (exists) return;
    await this.prisma.shipmentMilestone.createMany({
      data: [
        { shipmentId: ship.id, milestone: 'ORDER_CONFIRMED', occurredAt: ago(160 + jitter()), source: 'ASN' },
        { shipmentId: ship.id, milestone: 'PICKED', occurredAt: ago(75 + jitter()), source: 'ASN' },
        { shipmentId: ship.id, milestone: 'LOADED', occurredAt: ago(30 + jitter()), source: 'ASN' },
        { shipmentId: ship.id, milestone: 'IN_TRANSIT', occurredAt: ago(6 + jitter() / 3), source: 'ASN' },
      ],
    });
  }

  private now() {
    return new Date().toISOString();
  }

  // ───────────── Dựng cảnh mở màn ─────────────

  private async bootstrap() {
    const wh1 = this.siteIds.get('WH-01');
    if (!wh1) return;
    const marker = await this.prisma.siteSetting.findUnique({ where: { siteId_key: { siteId: wh1, key: 'demo.bootstrapped' } } });
    if (marker) {
      await this.syncShipmentCounter();
      this.logger.log('Scene already bootstrapped — continuing simulation');
      return;
    }
    this.logger.log('Bootstrapping video scene…');
    for (const scene of DEMO_SCENES) {
      const siteId = this.siteIds.get(scene.code);
      if (!siteId) continue;
      // ETA của xe đang tới tính lại theo giờ khởi động
      for (const [truck, min] of Object.entries(scene.etas)) {
        const v = await this.visitOf(scene.code, truck);
        if (v) await this.prisma.truckVisit.update({ where: { id: v.id }, data: { etaAt: new Date(Date.now() + min * 60_000), appointmentStart: new Date(Date.now() + min * 60_000), appointmentEnd: new Date(Date.now() + (min + 60) * 60_000) } });
      }
      for (const o of scene.outbound) await this.safe(`${scene.code} ${o.truck}`, () => this.setupOutbound(scene, o));
      for (const i of scene.inbound) await this.safe(`${scene.code} ${i.truck}`, () => this.setupInbound(scene, i));
      for (const [truck, fl] of Object.entries(scene.forklifts)) {
        const v = await this.visitOf(scene.code, truck);
        const eq = await this.prisma.equipment.findFirst({ where: { siteId, code: fl } });
        if (v && eq) this.forkliftOf.set(v.id, eq.id);
      }
    }
    await this.syncShipmentCounter();
    await this.prisma.siteSetting.create({ data: { siteId: wh1, key: 'demo.bootstrapped', value: true } });
    this.logger.log('Video scene ready');
  }

  private async safe(label: string, fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (err) {
      const e = err as Error;
      this.logger.warn(`${label}: ${e.message || String(err)} ${(e.stack ?? '').split(String.fromCharCode(10)).slice(1, 3).join(' | ')}`);
    }
  }

  private async setupOutbound(scene: SiteScene, o: SiteScene['outbound'][number]) {
    const S = this.S(scene.code);
    const siteId = this.siteIds.get(scene.code)!;
    const visit = await this.visitOf(scene.code, o.truck);
    if (!visit) return;
    const sku = await this.sku(scene.sku);
    await this.setShipmentCode(o.shipment);
    const order = await this.call<{ id: string; version: number }>('manager', 'POST', `${S}/outbound-orders`, {
      customerId: await this.partnerId(o.customer),
      destinationText: o.destination,
      plannedDispatchAt: new Date(Date.now() + o.dispatchInMin * 60_000).toISOString(),
      requestedDeliveryAt: new Date(Date.now() + (o.dispatchInMin + 32) * 60_000).toISOString(),
      truckVisitId: visit.id,
      lines: [{ skuId: sku.id, orderedQty: String(o.pallets * this.perPallet(scene.sku)) }],
    });
    await this.call('manager', 'POST', `${S}/outbound-orders/${order.id}/confirm`, { autoAllocate: true, expectedVersion: order.version });
    const picks = await this.prisma.operationTask.findMany({ where: { siteId, sourceType: 'OUTBOUND_ORDER', sourceId: order.id, taskType: 'PICK', status: 'PENDING' }, orderBy: { code: 'asc' } });
    const operator = await this.operatorFor(siteId, scene.forklifts[o.truck]);
    if (!operator) return;
    // Pallet nguyên → mỗi pick một pallet; nếu cấp phát tách nhiều pallet hơn thì pick hết khi cần bắt đầu xếp
    const n = o.picked !== undefined && !o.startLoading ? o.picked : picks.length;
    for (let i = 0; i < Math.min(n, picks.length); i++) await this.runTask(scene.code, picks[i].id, operator, await this.freeSlot(scene));
    await this.backdateMilestones(visit.id, 'OUTBOUND');
    if (!o.startLoading) return;
    const ship = await this.prisma.shipment.findFirstOrThrow({ where: { truckVisitId: visit.id, direction: 'OUTBOUND', status: { notIn: ['DELIVERED', 'CANCELLED'] } } });
    await this.call('manager', 'POST', `${S}/shipments/${ship.id}/loading/start`, { expectedVersion: ship.version });
    const dock = await this.prisma.location.findUniqueOrThrow({ where: { id: visit.dockLocationId! } });
    const items = await this.prisma.shipmentItem.findMany({ where: { shipmentId: ship.id, loadedAt: null }, include: {} });
    for (const item of items.slice(0, o.loaded)) {
      const hu = await this.prisma.handlingUnit.findUniqueOrThrow({ where: { id: item.handlingUnitId! } });
      await this.call(operator.username, 'POST', `${S}/shipments/${ship.id}/load-scans`, { huScan: { method: 'BARCODE', value: hu.code, scannedAt: this.now() }, dockScan: { method: 'QR', value: dock.qrValue, scannedAt: this.now() } });
    }
  }

  /** Làn staging còn chỗ (sức chứa theo occupancy) trong danh sách của kịch bản. */
  private async freeSlot(scene: SiteScene): Promise<string | undefined> {
    if (!scene.stagingSlots.length) return undefined;
    const siteId = this.siteIds.get(scene.code)!;
    const locs = await this.prisma.location.findMany({ where: { siteId, code: { in: scene.stagingSlots } } });
    const used = await this.prisma.locationOccupancy.groupBy({ by: ['locationId'], where: { releasedAt: null, locationId: { in: locs.map((l) => l.id) } }, _sum: { unitsUsed: true } });
    const usedBy = new Map(used.map((u) => [u.locationId, Number(u._sum.unitsUsed ?? 0)]));
    const ordered = scene.stagingSlots.map((c) => locs.find((l) => l.code === c)!).filter(Boolean);
    const free = ordered.filter((l) => (usedBy.get(l.id) ?? 0) < Number(l.capacityUnits));
    return (free.length ? free[Math.floor(Math.random() * Math.min(free.length, 3))] : ordered[0])?.code;
  }

  private async setupInbound(scene: SiteScene, i: SiteScene['inbound'][number]) {
    const S = this.S(scene.code);
    const visit = await this.visitOf(scene.code, i.truck);
    if (!visit) return;
    const sku = await this.sku(scene.sku);
    await this.setShipmentCode(i.shipment);
    const order = await this.call<{ id: string }>('manager', 'POST', `${S}/inbound-orders`, {
      supplierId: await this.partnerId(i.partner),
      truckVisitId: visit.id,
      lines: [{ skuId: sku.id, expectedQty: String(i.pallets * this.perPallet(scene.sku)), expectedHuCount: i.pallets }],
    });
    await this.backdateMilestones(visit.id, 'INBOUND');
    if (!i.startReceipt) return;
    const receipt = await this.call<{ id: string }>('manager', 'POST', `${S}/receipts`, { inboundOrderId: order.id });
    for (let k = 0; k < i.received; k++) await this.call('manager', 'POST', `${S}/receipts/${receipt.id}/lines`, this.receiptLine(sku));
  }

  private receiptLine(sku: { id: string; code: string; lotTracked: boolean; expiryTracked: boolean }) {
    const d = new Date(Date.now() + 200 * 86_400_000);
    return {
      skuId: sku.id,
      quantity: String(this.perPallet(sku.code)),
      ...(sku.lotTracked ? { lotNumber: `L2510-${String(Math.floor(Math.random() * 900) + 100)}` } : {}),
      ...(sku.expiryTracked ? { expiresOn: d.toISOString().slice(0, 10) } : {}),
    };
  }

  // ───────────── Điều phối liên tục ─────────────

  private async tick() {
    const wh1 = await this.prisma.site.findFirst({ where: { code: 'WH-01', deletedAt: null } });
    if (!wh1) return;
    if (wh1.id !== this.siteIds.get('WH-01')) {
      // Dữ liệu vừa được seed lại → đợi cờ seed rồi dựng cảnh lại từ đầu
      if (!(await this.prisma.siteSetting.findFirst({ where: { key: 'seed.completedAt' } }))) return;
      this.siteIds.clear();
      this.mem.clear();
      this.forkliftOf.clear();
      this.tokens.clear();
      for (const s of await this.prisma.site.findMany({ where: { deletedAt: null } })) this.siteIds.set(s.code, s.id);
      await this.bootstrap();
    }
    for (const scene of DEMO_SCENES) {
      const siteId = this.siteIds.get(scene.code);
      if (!siteId) continue;
      await this.safe(`${scene.code} tick`, () => this.tickSite(scene, siteId));
    }
  }

  private memOf(v: TruckVisit): Mem {
    const m = this.mem.get(v.id);
    if (!m || m.status !== v.status) {
      const fresh = { status: v.status, since: Date.now(), lastStep: Date.now() };
      this.mem.set(v.id, fresh);
      return fresh;
    }
    return m;
  }

  private async tickSite(scene: SiteScene, siteId: string) {
    const S = this.S(scene.code);
    const visits = await this.prisma.truckVisit.findMany({ where: { siteId, status: { in: ACTIVE } }, include: { truck: true }, orderBy: { createdAt: 'asc' } });
    const now = Date.now();
    for (const v of visits) {
      const m = this.memOf(v);
      const age = now - m.since;
      try {
        switch (v.status) {
          case 'SCHEDULED':
            if (v.etaAt && v.etaAt.getTime() <= now) await this.call('manager', 'POST', `${S}/visits/${v.id}/arrive`, { actualPlate: v.truck.plateNumber, expectedVersion: v.version });
            break;
          case 'AT_GATE':
            if (age > DWELL.gate) await this.call('manager', 'POST', `${S}/visits/${v.id}/verify`, { documentChecks: DEFAULT_GATE_DOCUMENT_CHECKLIST.map((c) => ({ key: c.key, passed: true })), expectedVersion: v.version });
            break;
          case 'WAITING': {
            const dock = await this.freeDock(siteId, v.direction);
            if (dock) await this.call('manager', 'POST', `${S}/visits/${v.id}/assign-dock`, { dockLocationId: dock, expectedVersion: v.version });
            break;
          }
          case 'DOCK_ASSIGNED':
            if (age > DWELL.docking && v.dockLocationId) {
              const dock = await this.prisma.location.findUniqueOrThrow({ where: { id: v.dockLocationId } });
              await this.call('manager', 'POST', `${S}/visits/${v.id}/arrive-at-dock`, { scan: { method: 'QR', value: dock.qrValue, scannedAt: this.now() }, expectedVersion: v.version });
            }
            break;
          case 'AT_DOCK':
            if (age > DWELL.atDock) await this.startHandling(scene, siteId, v);
            break;
          case 'HANDLING':
            if (now - m.lastStep > DWELL.step) {
              m.lastStep = now;
              await this.handleStep(scene, siteId, v);
            }
            break;
          case 'READY_TO_LEAVE':
            if (age > DWELL.ready) {
              await this.call('manager', 'POST', `${S}/visits/${v.id}/gate-out`, { expectedVersion: v.version });
              await this.releaseForklift(siteId, v.id);
            }
            break;
        }
      } catch (err) {
        this.logger.warn(`${scene.code} ${v.truck.code} ${v.status}: ${(err as Error).message}`);
        m.lastStep = now;
      }
    }
    await this.safe(`${scene.code} putaway`, () => this.putawayOne(scene, siteId));
    await this.safe(`${scene.code} spawn`, () => this.spawnIfIdle(scene, siteId, visits));
  }

  private async freeDock(siteId: string, direction: string) {
    const docks = await this.prisma.location.findMany({ where: { siteId, locationType: 'DOCK', deletedAt: null, blockedAt: null }, include: { dock: true }, orderBy: { code: 'asc' } });
    const busy = new Set((await this.prisma.locationOccupancy.findMany({ where: { siteId, releasedAt: null, locationId: { in: docks.map((d) => d.id) } } })).map((o) => o.locationId));
    const fit = docks.filter((d) => !busy.has(d.id) && (d.dock?.direction === 'BOTH' || d.dock?.direction === direction));
    return fit[0]?.id ?? null;
  }

  /** Xe nâng phục vụ xe tải: ưu tiên xe nâng theo kịch bản, sau đó xe đang rảnh. */
  private async claimForklift(siteId: string, visit: TruckVisit & { truck: { code: string } }, verb: 'Loading' | 'Unloading') {
    let eqId = this.forkliftOf.get(visit.id);
    if (!eqId) {
      const taken = new Set(this.forkliftOf.values());
      const free = await this.prisma.equipment.findMany({ where: { siteId, status: { in: ['AVAILABLE', 'CHARGING'] }, deletedAt: null }, orderBy: [{ status: 'asc' }, { code: 'asc' }] });
      const eq = free.find((e) => !taken.has(e.id) && e.status === 'AVAILABLE') ?? free.find((e) => !taken.has(e.id));
      if (!eq) return null;
      eqId = eq.id;
      this.forkliftOf.set(visit.id, eqId);
    }
    const eq = await this.prisma.equipment.findUnique({ where: { id: eqId } });
    const dock = visit.dockLocationId ? await this.prisma.location.findUnique({ where: { id: visit.dockLocationId } }) : null;
    const summary = `${verb} ${visit.truck.code} at ${dock?.name ?? dock?.code ?? 'dock'}`;
    if (eq && (eq.status !== 'BUSY' || eq.taskSummary !== summary)) {
      await this.tx.run((tx) => this.equipment.setStatus(tx, siteId, eq.id, 'BUSY', { taskSummary: summary, incrementMoves: eq.status === 'BUSY' }));
    } else if (eq) {
      await this.tx.run((tx) => this.equipment.setStatus(tx, siteId, eq.id, 'BUSY', { taskSummary: summary, incrementMoves: true }));
    }
    return eq;
  }

  private async releaseForklift(siteId: string, visitId: string) {
    const eqId = this.forkliftOf.get(visitId);
    this.forkliftOf.delete(visitId);
    if (!eqId) return;
    const eq = await this.prisma.equipment.findUnique({ where: { id: eqId } });
    if (eq?.status === 'BUSY') await this.tx.run((tx) => this.equipment.setStatus(tx, siteId, eq.id, 'AVAILABLE', { taskSummary: 'Waiting for work' }));
  }

  private async startHandling(scene: SiteScene, siteId: string, v: TruckVisit & { truck: { code: string } }) {
    const S = this.S(scene.code);
    if (v.direction === 'OUTBOUND') {
      let ship = await this.prisma.shipment.findFirst({ where: { truckVisitId: v.id, direction: 'OUTBOUND', status: { notIn: ['DELIVERED', 'CANCELLED'] } } });
      if (!ship) {
        const sku = await this.sku(scene.sku);
        const pallets = 4 + Math.floor(Math.random() * 3);
        const order = await this.call<{ id: string; version: number }>('manager', 'POST', `${S}/outbound-orders`, {
          customerId: await this.partnerId(['Oakridge Market', 'Harbor & Co.', 'Sunvale Grocers', 'Halcyon Retail'][Math.floor(Math.random() * 4)]),
          destinationText: ['Philadelphia, PA', 'Providence, RI', 'Hartford, CT', 'Stamford, CT', 'Trenton, NJ'][Math.floor(Math.random() * 5)],
          plannedDispatchAt: new Date(Date.now() + 25 * 60_000).toISOString(),
          requestedDeliveryAt: new Date(Date.now() + 90 * 60_000).toISOString(),
          truckVisitId: v.id,
          lines: [{ skuId: sku.id, orderedQty: String(pallets * this.perPallet(scene.sku)) }],
        });
        await this.call('manager', 'POST', `${S}/outbound-orders/${order.id}/confirm`, { autoAllocate: true, expectedVersion: order.version });
        await this.backdateMilestones(v.id, 'OUTBOUND');
        return;
      }
      if (ship.status === 'PICKING' || ship.status === 'CONFIRMED') return this.pickOne(scene, siteId, v, ship.id);
      if (ship.status === 'STAGED') await this.call('manager', 'POST', `${S}/shipments/${ship.id}/loading/start`, { expectedVersion: ship.version });
      return;
    }
    // Nhập: đảm bảo có đơn nhập + mở phiếu nhận
    let ship = await this.prisma.shipment.findFirst({ where: { truckVisitId: v.id, direction: 'INBOUND', status: { notIn: ['CLOSED', 'CANCELLED'] } } });
    if (!ship) {
      const sku = await this.sku(scene.sku);
      const pallets = 4 + Math.floor(Math.random() * 4);
      await this.call('manager', 'POST', `${S}/inbound-orders`, { supplierId: await this.partnerId(['Northwind Supply', 'Brightline Electronics', 'Sunvale Grocers'][Math.floor(Math.random() * 3)]), truckVisitId: v.id, lines: [{ skuId: sku.id, expectedQty: String(pallets * this.perPallet(scene.sku)), expectedHuCount: pallets }] });
      ship = await this.prisma.shipment.findFirst({ where: { truckVisitId: v.id, direction: 'INBOUND' } });
      await this.backdateMilestones(v.id, 'INBOUND');
    }
    const order = await this.prisma.inboundOrder.findFirst({ where: { shipmentId: ship!.id } });
    if (order) await this.call('manager', 'POST', `${S}/receipts`, { inboundOrderId: order.id });
  }

  private async pickOne(scene: SiteScene, siteId: string, v: TruckVisit & { truck: { code: string } }, shipmentId: string) {
    const order = await this.prisma.outboundOrder.findFirst({ where: { shipmentId } });
    if (!order) return;
    const task = await this.prisma.operationTask.findFirst({ where: { siteId, sourceType: 'OUTBOUND_ORDER', sourceId: order.id, taskType: 'PICK', status: { in: ['PENDING', 'ASSIGNED', 'IN_PROGRESS'] } }, orderBy: { code: 'asc' } });
    if (!task) return;
    const eq = await this.claimForklift(siteId, v, 'Loading');
    const operator = await this.operatorFor(siteId, eq?.code);
    if (!operator) return;
    await this.runTask(scene.code, task.id, operator, await this.freeSlot(scene));
  }

  private async handleStep(scene: SiteScene, siteId: string, v: TruckVisit & { truck: { code: string } }) {
    const S = this.S(scene.code);
    if (v.direction === 'OUTBOUND') {
      const ship = await this.prisma.shipment.findFirst({ where: { truckVisitId: v.id, direction: 'OUTBOUND', status: { notIn: ['DELIVERED', 'CANCELLED', 'DISPATCHED'] } } });
      if (!ship) return;
      if (ship.status === 'PICKING') return this.pickOne(scene, siteId, v, ship.id);
      if (ship.status === 'STAGED') return void (await this.call('manager', 'POST', `${S}/shipments/${ship.id}/loading/start`, { expectedVersion: ship.version }));
      if (ship.status !== 'LOADING') return;
      const eq = await this.claimForklift(siteId, v, 'Loading');
      const operator = (await this.operatorFor(siteId, eq?.code)) ?? { username: 'manager' };
      const next = await this.prisma.shipmentItem.findFirst({ where: { shipmentId: ship.id, loadedAt: null }, orderBy: { id: 'asc' } });
      if (next) {
        const hu = await this.prisma.handlingUnit.findUniqueOrThrow({ where: { id: next.handlingUnitId! } });
        const dock = await this.prisma.location.findUniqueOrThrow({ where: { id: v.dockLocationId! } });
        await this.call(operator.username, 'POST', `${S}/shipments/${ship.id}/load-scans`, { huScan: { method: 'BARCODE', value: hu.code, scannedAt: this.now() }, dockScan: { method: 'QR', value: dock.qrValue, scannedAt: this.now() } });
        return;
      }
      await this.call('manager', 'POST', `${S}/shipments/${ship.id}/dispatch`, { sealNumber: `SL-${Math.floor(Math.random() * 900000 + 100000)}`, expectedVersion: ship.version });
      return;
    }
    // Nhập: quét từng pallet; đủ thì hoàn tất phiếu nhận (xe READY_TO_LEAVE)
    const ship = await this.prisma.shipment.findFirst({ where: { truckVisitId: v.id, direction: 'INBOUND', status: { notIn: ['CLOSED', 'CANCELLED', 'RECEIVED'] } } });
    if (!ship) return;
    const receipt = await this.prisma.receipt.findFirst({ where: { shipmentId: ship.id, status: 'IN_PROGRESS' } });
    if (!receipt) return;
    await this.claimForklift(siteId, v, 'Unloading');
    const lines = await this.prisma.receiptLine.count({ where: { receiptId: receipt.id, voided: false } });
    if (lines < ship.expectedHuCount) {
      await this.call('manager', 'POST', `${S}/receipts/${receipt.id}/lines`, this.receiptLine(await this.sku(scene.sku)));
      return;
    }
    await this.call('manager', 'POST', `${S}/receipts/${receipt.id}/complete`, {});
  }

  /** Cất hàng: mỗi nhịp một pallet nhận xong → kho trong nhà (biến khỏi scene) hoặc làn staging (cross-dock). */
  private async putawayOne(scene: SiteScene, siteId: string) {
    const task = await this.prisma.operationTask.findFirst({ where: { siteId, taskType: 'PUTAWAY', status: 'PENDING', createdAt: { lt: new Date(Date.now() - DWELL.putaway) } }, orderBy: { createdAt: 'asc' } });
    if (!task) return;
    const operator = await this.operatorFor(siteId);
    if (!operator) return;
    let dest: string | undefined;
    if (scene.putaway === 'staging' && scene.stagingSlots.length) dest = await this.freeSlot(scene);
    else {
      const loc = await this.prisma.location.findFirst({ where: { siteId, code: { startsWith: scene.indoorPrefix }, locationType: 'STORAGE' }, orderBy: { code: 'desc' } });
      dest = loc?.code;
    }
    await this.runTask(scene.code, task.id, operator, dest);
  }

  /** Còn dock trống và không có xe nào sắp tới → sinh lượt xe mới (ETA ~100 s) chạy vào từ đường ngoài. */
  private async spawnIfIdle(scene: SiteScene, siteId: string, visits: Array<TruckVisit & { truck: { code: string } }>) {
    const soon = visits.filter((v) => v.status === 'SCHEDULED' && v.etaAt && v.etaAt.getTime() - Date.now() < 6 * 60_000);
    if (soon.length > 0) return;
    const onSite = visits.filter((v) => v.status !== 'SCHEDULED').length;
    const docks = await this.prisma.location.count({ where: { siteId, locationType: 'DOCK', deletedAt: null } });
    if (onSite >= docks) return;
    const direction = scene.flow === 'both' ? (Math.random() < 0.5 ? 'INBOUND' : 'OUTBOUND') : scene.flow === 'inbound' ? 'INBOUND' : 'OUTBOUND';
    const dock = await this.freeDock(siteId, direction);
    if (!dock) return;
    const activeTrucks = new Set((await this.prisma.truckVisit.findMany({ where: { status: { in: ACTIVE } }, select: { truckId: true } })).map((v) => v.truckId));
    const trucks = await this.prisma.truck.findMany({ where: { deletedAt: null, code: { startsWith: 'TRK-2' } }, orderBy: { updatedAt: 'asc' } });
    const truck = trucks.find((t) => !activeTrucks.has(t.id));
    if (!truck) return;
    const eta = new Date(Date.now() + DWELL.spawnEta);
    const visit = await this.call<{ id: string; version: number }>('manager', 'POST', `${this.S(scene.code)}/visits`, {
      truckId: truck.id,
      direction,
      appointmentStart: eta.toISOString(),
      appointmentEnd: new Date(eta.getTime() + 3600_000).toISOString(),
      etaAt: eta.toISOString(),
    });
    await this.prisma.truck.update({ where: { id: truck.id }, data: { updatedAt: new Date() } });
    await this.call('manager', 'POST', `${this.S(scene.code)}/visits/${visit.id}/assign-dock`, { dockLocationId: dock, expectedVersion: visit.version }).catch(() => undefined);
  }
}
