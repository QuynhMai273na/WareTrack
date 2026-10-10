/**
 * Seed dữ liệu demo (DEC-51) theo video tham chiếu: 5 site (Riverside Hub, Northgate DC, Eastport Cold Chain,
 * Southfield Cross-Dock, Westgate Robotics Hub), xe tải/tài xế/xe nâng/SKU/tồn kho/lịch sử KPI đúng số liệu video.
 * Trạng thái đang diễn ra (đơn đang xếp/dỡ) do DemoDirector dựng qua API khi API khởi động (DEMO_DIRECTOR=true).
 * Bãi lưu xe WH-06 (BRD UC-04→07) chỉ seed khi SEED_VEHICLE_YARD=true. Idempotent: TRUNCATE rồi tạo lại.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { ALL_PERMISSIONS, PERMISSION_MATRIX, Role, ROLE_LABELS } from '@waretrack/shared-schemas';
import * as argon2 from 'argon2';
import { uuidv7 } from 'uuidv7';
import { warehouseLayout } from './layout';
import { CARRIERS, EQUIPMENT, OPERATORS, OUTDOOR_PALLETS, PARTNERS, SITE_INVENTORY, SKUS, type SiteSeed, VIDEO_SITES, VISITS } from './video-data';

const prisma = new PrismaClient();
const DEMO_PASSWORD = 'WareTrack@2026';
const now = new Date();
const minutes = (m: number) => new Date(now.getTime() + m * 60_000);
const WITH_VEHICLE_YARD = process.env.SEED_VEHICLE_YARD === 'true';

const SITES: SiteSeed[] = [
  ...VIDEO_SITES,
  ...(WITH_VEHICLE_YARD
    ? [
        {
          code: 'WH-06',
          name: 'Harbor Vehicle Yard',
          siteType: 'VEHICLE_YARD' as const,
          address: '1 Port Rd, Bayonne NJ',
          map: { x: 600, z: 260 },
          layout: warehouseLayout({ label: 'WH-06 · Vehicle Yard', docks: [{ code: 'RAMP-1', direction: 'BOTH' }], rackRows: 1, rackBays: 4, yardSlots: 4, chargers: 1, parkingRows: 4, parkingCols: 20 }),
        },
      ]
    : []),
];
const SITE_CODES = SITES.map((s) => s.code);

const USERS: Array<{ username: string; fullName: string; grants: Array<{ role: Role; sites: string[] | null }> }> = [
  { username: 'admin', fullName: 'Morgan Lee', grants: [{ role: Role.ADMIN, sites: null }] },
  { username: 'manager', fullName: 'Alex Chen', grants: [{ role: Role.SITE_MANAGER, sites: SITE_CODES }] },
  { username: 'dispatcher', fullName: 'Sam Rivera', grants: [{ role: Role.YARD_DISPATCHER, sites: ['WH-01', 'WH-04', ...(WITH_VEHICLE_YARD ? ['WH-06'] : [])] }] },
  { username: 'gate', fullName: 'Jordan Park', grants: [{ role: Role.GATE_SECURITY, sites: ['WH-01', 'WH-04', ...(WITH_VEHICLE_YARD ? ['WH-06'] : [])] }] },
  { username: 'supervisor', fullName: 'Taylor Nguyen', grants: [{ role: Role.WAREHOUSE_SUPERVISOR, sites: ['WH-01', 'WH-02'] }] },
  { username: 'operator', fullName: 'Casey Tran', grants: [{ role: Role.WAREHOUSE_OPERATOR, sites: ['WH-01', ...(WITH_VEHICLE_YARD ? ['WH-06'] : [])] }] },
  { username: 'forklift', fullName: 'Sam Haddad', grants: [{ role: Role.FORKLIFT_OPERATOR, sites: ['WH-01'] }] },
  { username: 'inventory', fullName: 'Riley Pham', grants: [{ role: Role.INVENTORY_CONTROLLER, sites: ['WH-01', 'WH-02'] }] },
  { username: 'viewer', fullName: 'Avery Do', grants: [{ role: Role.VIEWER, sites: ['WH-01', 'WH-02', 'WH-03', 'WH-04', 'WH-05'] }] },
  ...OPERATORS.map((o) => ({ username: o.username, fullName: o.fullName, grants: [{ role: Role.FORKLIFT_OPERATOR, sites: [o.site] }] })),
];

type SiteRef = { id: string; locationIds: Map<string, string> };

async function chunked<T>(rows: T[], fn: (batch: T[]) => Promise<unknown>, size = 1000) {
  for (let i = 0; i < rows.length; i += size) await fn(rows.slice(i, i + size));
}

/** Đầu ngày theo giờ New York (timezone của site demo). */
function todayStartNy(): Date {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')!.value) % 24;
  const m = Number(parts.find((p) => p.type === 'minute')!.value);
  return new Date(now.getTime() - (h * 60 + m) * 60_000 - now.getSeconds() * 1000);
}

/** Số pallet DemoDirector sẽ nhận thêm lúc dựng cảnh (để KPI sau khi dựng khớp video). */
const DIRECTOR_RECEIPTS: Record<string, number> = { 'WH-02': 1, 'WH-03': 3, 'WH-04': 2 };

/**
 * Tồn kho: pallet ngoài trời theo video + pallet trong nhà (bulk) sao cho tổng pallet, số lượng SKU hiển thị
 * và "pallet nhận hôm nay" khớp số liệu video. Mỗi pallet có ledger RECEIPT + occupancy + movement.
 */
async function seedInventory(sites: Map<string, SiteRef>, userIds: Map<string, string>): Promise<number> {
  const skuIds = new Map<string, string>();
  for (const s of SKUS) {
    const created = await prisma.sku.create({
      data: { code: s.code, name: s.name, category: s.category, lotTracked: !!s.lot, expiryTracked: !!s.expiryDays, allocationStrategy: s.expiryDays ? 'FEFO' : 'FIFO', unitWeightKg: s.weight, lowStockThreshold: s.lowStock ?? null },
    });
    skuIds.set(s.code, created.id);
  }
  const lots = new Map<string, string>();
  const lotOf = async (skuCode: string, lotNumber?: string) => {
    const s = SKUS.find((x) => x.code === skuCode)!;
    if (!s.lot && !lotNumber) return null;
    const number = lotNumber ?? `L2509-${100 + (skuCode.length * 37) % 800}`;
    const key = `${skuCode}:${number}`;
    if (!lots.has(key)) {
      const l = await prisma.lot.create({ data: { skuId: skuIds.get(skuCode)!, lotNumber: number, manufacturedOn: minutes(-60 * 24 * 40), expiresOn: s.expiryDays ? minutes(60 * 24 * (s.expiryDays - 40)) : null } });
      lots.set(key, l.id);
    }
    return lots.get(key)!;
  };
  const todayStart = todayStartNy();
  const sinceToday = Math.max(10, (now.getTime() - todayStart.getTime()) / 60_000 - 5);

  let palletNo = 300000;
  let total = 0;
  for (const [code, site] of sites) {
    const inv = SITE_INVENTORY[code];
    if (!inv) continue;
    type Row = { code: string; sku: string; qty: number; loc: string; lot?: string; receivedAt: Date; lifecycle: 'IN_STOCK' | 'STAGED'; today?: boolean };
    const rows: Row[] = [];
    // 1) Pallet ngoài trời nhìn thấy trong scene
    let visibleNo = 1020 + (Number(code.slice(-1)) - 1) * 100;
    const nextVisible = () => {
      if (visibleNo === 1026) visibleNo++;
      return `PAL-${visibleNo++}`;
    };
    for (const p of OUTDOOR_PALLETS[code] ?? []) {
      for (let i = 0; i < (p.n ?? 1); i++) {
        rows.push({ code: p.code ?? nextVisible(), sku: p.sku, qty: p.qty, loc: p.loc, lot: p.lot, receivedAt: p.receivedAt ? new Date(p.receivedAt) : minutes(-60 * 24 * (3 + (i % 9))), lifecycle: p.lifecycle ?? 'IN_STOCK' });
      }
    }
    // 2) SKU hiển thị: bù phần còn thiếu bằng pallet trong nhà
    const indoor = [...site.locationIds.entries()].filter(([c]) => /^[A-Z]-\d{3}$/.test(c)).map(([, id]) => id);
    let slot = 0;
    const nextIndoor = () => indoor[Math.floor(slot++ / 28) % indoor.length];
    for (const [sku, units] of inv.featured) {
      let left = units - rows.filter((r) => r.sku === sku).reduce((s, r) => s + r.qty, 0);
      const per = SKUS.find((s) => s.code === sku)!.perPallet;
      while (left > 0) {
        const q = Math.min(per, left);
        rows.push({ code: `PAL-${palletNo++}`, sku, qty: q, loc: nextIndoor(), receivedAt: minutes(-60 * 24 * (2 + (rows.length % 25))), lifecycle: 'IN_STOCK' });
        left -= q;
      }
    }
    // 3) Hàng lấp đầy tới tổng pallet mục tiêu (trừ phần DemoDirector sẽ nhận thêm)
    const target = inv.pallets - (DIRECTOR_RECEIPTS[code] ?? 0);
    let f = 0;
    while (rows.length < target) {
      const sku = inv.filler[f++ % inv.filler.length];
      const per = SKUS.find((s) => s.code === sku)!.perPallet;
      rows.push({ code: `PAL-${palletNo++}`, sku, qty: per, loc: nextIndoor(), receivedAt: minutes(-60 * 24 * (2 + (f % 40))), lifecycle: 'IN_STOCK' });
    }
    // 4) Pallet nhận hôm nay = put-away hôm nay (KPI "+15 pallets") — trừ phần director nhận thêm
    const todayCount = inv.putawaysToday - (DIRECTOR_RECEIPTS[code] ?? 0);
    const todayRows = rows.filter((r) => /^[A-Z]-\d{3}$/.test([...site.locationIds.entries()].find(([, id]) => id === r.loc)?.[0] ?? '')).slice(-todayCount);
    todayRows.forEach((r, i) => {
      r.today = true;
      r.receivedAt = new Date(todayStart.getTime() + ((i + 1) / (todayCount + 1)) * sinceToday * 60_000);
    });

    const locId = (l: string) => site.locationIds.get(l) ?? l;
    const hu: Prisma.HandlingUnitCreateManyInput[] = [];
    const bal: Prisma.InventoryBalanceCreateManyInput[] = [];
    const tx: Prisma.InventoryTransactionCreateManyInput[] = [];
    const occ: Prisma.LocationOccupancyCreateManyInput[] = [];
    const mov: Prisma.MovementRecordCreateManyInput[] = [];
    const tasks: Prisma.OperationTaskCreateManyInput[] = [];
    let taskNo = 0;
    for (const r of rows) {
      const id = uuidv7();
      const sku = SKUS.find((s) => s.code === r.sku)!;
      const lotId = await lotOf(r.sku, r.lot);
      const location = locId(r.loc);
      hu.push({ id, siteId: site.id, code: r.code, lifecycle: r.lifecycle, locationId: location, positionSource: 'CONFIRMED_SCAN', positionConfirmedAt: r.receivedAt, grossWeightKg: Math.round(r.qty * sku.weight * 0.85 + 22), createdAt: r.receivedAt });
      bal.push({ siteId: site.id, locationId: location, skuId: skuIds.get(r.sku)!, lotId, handlingUnitId: id, stockStatus: 'AVAILABLE', qtyOnHand: r.qty, receivedAt: r.receivedAt });
      tx.push({ siteId: site.id, txType: 'RECEIPT', idempotencyKey: `seed:${code}:${r.code}`, skuId: skuIds.get(r.sku)!, lotId, handlingUnitId: id, toLocationId: location, toStatus: 'AVAILABLE', quantity: r.qty, referenceType: 'SEED', referenceId: id, occurredAt: r.receivedAt });
      occ.push({ siteId: site.id, locationId: location, occupantType: 'HANDLING_UNIT', occupantId: id, kind: 'OCCUPIED', singleOccupancy: false, occupiedAt: r.receivedAt, positionSource: 'CONFIRMED_SCAN', startedAt: r.receivedAt });
      mov.push({ siteId: site.id, subjectType: 'HANDLING_UNIT', subjectId: id, toLocationId: location, positionSource: 'CONFIRMED_SCAN', reason: r.today ? 'Put-away' : 'Initial stock (seed)', occurredAt: r.receivedAt });
      if (r.today) {
        taskNo++;
        tasks.push({ siteId: site.id, code: `TSK-${code.slice(-2)}${String(taskNo).padStart(4, '0')}`, taskType: 'PUTAWAY', status: 'COMPLETED', subjectType: 'HANDLING_UNIT', subjectId: id, toLocationId: location, sourceType: 'SEED', sourceId: id, completedAt: r.receivedAt, startedAt: new Date(r.receivedAt.getTime() - 4 * 60_000), createdAt: new Date(r.receivedAt.getTime() - 9 * 60_000), payload: { subjectCode: r.code } });
      }
    }
    // Put-away hôm nay của pallet director sẽ nhận (đã có sẵn trong số 35/20…) — bù bằng task của pallet hôm qua
    for (let i = 0; i < (DIRECTOR_RECEIPTS[code] ?? 0); i++) {
      const h = hu[hu.length - 1 - todayCount - i];
      taskNo++;
      tasks.push({ siteId: site.id, code: `TSK-${code.slice(-2)}${String(taskNo).padStart(4, '0')}`, taskType: 'PUTAWAY', status: 'COMPLETED', subjectType: 'HANDLING_UNIT', subjectId: h.id!, toLocationId: h.locationId!, sourceType: 'SEED', sourceId: h.id!, completedAt: new Date(todayStart.getTime() + 20 * 60_000), createdAt: new Date(todayStart.getTime() + 10 * 60_000), payload: { subjectCode: h.code } });
    }
    await chunked(hu, (b) => prisma.handlingUnit.createMany({ data: b }));
    await chunked(bal, (b) => prisma.inventoryBalance.createMany({ data: b }));
    await chunked(tx, (b) => prisma.inventoryTransaction.createMany({ data: b }));
    await chunked(occ, (b) => prisma.locationOccupancy.createMany({ data: b }));
    await chunked(mov, (b) => prisma.movementRecord.createMany({ data: b }));
    await chunked(tasks, (b) => prisma.operationTask.createMany({ data: b }));
    total += rows.length;
    void userIds;
  }
  await prisma.codeCounter.create({ data: { scope: 'PAL', value: 2000 } });
  return total;
}

/** Lịch sử: xe xuất đã rời site hôm nay (KPI Outbound today) + shipment đã giao 60 ngày (On-time delivery ±0.4%). */
async function seedHistory(sites: Map<string, SiteRef>, carriers: Map<string, string>, customers: string[]) {
  const todayStart = todayStartNy();
  const span = Math.max(30, (now.getTime() - todayStart.getTime()) / 60_000 - 20);
  let truckNo = 1100;
  let shpNo = 600000;
  const carrierIds = [...carriers.values()];
  for (const [code, site] of sites) {
    const inv = SITE_INVENTORY[code];
    if (!inv) continue;
    const pool: string[] = [];
    for (let i = 0; i < 12; i++) {
      const t = await prisma.truck.create({ data: { code: `TRK-${truckNo++}`, plateNumber: `HX${truckNo}${i}`, truckType: 'BOX', carrierId: carrierIds[i % carrierIds.length] } });
      pool.push(t.id);
    }
    const visits: Prisma.TruckVisitCreateManyInput[] = [];
    for (let i = 0; i < inv.outboundToday; i++) {
      const exitedAt = new Date(todayStart.getTime() + ((i + 1) / (inv.outboundToday + 1)) * span * 60_000);
      const arrivedAt = new Date(exitedAt.getTime() - 55 * 60_000);
      visits.push({
        siteId: site.id, code: `VIS-H${code.slice(-2)}-${String(i + 1).padStart(3, '0')}`, truckId: pool[i % pool.length], direction: 'OUTBOUND', status: 'EXITED',
        appointmentStart: arrivedAt, appointmentEnd: new Date(arrivedAt.getTime() + 3600_000), arrivedAt, verifiedAt: arrivedAt, dockedAt: arrivedAt, handlingStartedAt: arrivedAt, readyAt: exitedAt, exitedAt, exitReason: 'COMPLETED',
      });
    }
    await prisma.truckVisit.createMany({ data: visits });

    const ships: Prisma.ShipmentCreateManyInput[] = [];
    const window = (startDays: number, pct: number, n: number) => {
      const onTime = Math.round((pct / 100) * n);
      for (let i = 0; i < n; i++) {
        const promisedAt = minutes(-60 * 24 * (startDays + (i / n) * 29.5) - 60);
        const late = i >= onTime;
        const deliveredAt = new Date(promisedAt.getTime() + (late ? 40 : -25) * 60_000);
        const plannedDispatchAt = new Date(promisedAt.getTime() - 4 * 3600_000);
        ships.push({ siteId: site.id, code: `SHP-${shpNo++}`, direction: 'OUTBOUND', status: 'DELIVERED', partnerId: customers[i % customers.length], carrierId: carrierIds[i % carrierIds.length], plannedDispatchAt, dispatchedAt: new Date(plannedDispatchAt.getTime() + (late ? 20 : -5) * 60_000), promisedAt, deliveredAt, expectedHuCount: 6, createdAt: new Date(plannedDispatchAt.getTime() - 6 * 3600_000) });
      }
    };
    window(0.1, inv.onTime.pct30, inv.onTime.samples);
    window(30.2, inv.onTime.pctPrev, inv.onTime.samples);
    await chunked(ships, (b) => prisma.shipment.createMany({ data: b }));
  }
}
// ───────────── Vehicle Storage (WH-06) ─────────────
const MODELS: Array<{ wmi: string; make: string; model: string; colors: string[] }> = [
  { wmi: '1HG', make: 'Honda', model: 'Accord', colors: ['Pearl White', 'Lunar Silver'] },
  { wmi: '5YJ', make: 'Tesla', model: 'Model Y', colors: ['Midnight Black', 'Pearl White'] },
  { wmi: 'JTD', make: 'Toyota', model: 'Corolla', colors: ['Celestite Gray', 'Blueprint'] },
  { wmi: 'WBA', make: 'BMW', model: '330i', colors: ['Alpine White', 'Portimao Blue'] },
  { wmi: 'KMH', make: 'Hyundai', model: 'Ioniq 5', colors: ['Gravity Gold', 'Digital Teal'] },
  { wmi: '1FT', make: 'Ford', model: 'F-150 Lightning', colors: ['Antimatter Blue', 'Oxford White'] },
  { wmi: '3VW', make: 'Volkswagen', model: 'Jetta', colors: ['Pure Gray', 'Kings Red'] },
  { wmi: 'JN1', make: 'Nissan', model: 'Ariya', colors: ['Aurora Green', 'Everest White'] },
];
const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const VIN_TRANSLIT: Record<string, number> = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** VIN hư cấu nhưng hợp lệ (check digit đúng) để demo không bật cảnh báo DEC-22. */
function makeVin(wmi: string, n: number): string {
  const vds = Array.from({ length: 5 }, (_, i) => VIN_CHARS[(n * 7 + i * 11) % VIN_CHARS.length]).join('');
  const raw = `${wmi}${vds}0R${'ABCDEFGH'[n % 8]}${String(100000 + n * 137).slice(-6)}`;
  const sum = raw.split('').reduce((s, ch, i) => s + (/\d/.test(ch) ? Number(ch) : VIN_TRANSLIT[ch]) * VIN_WEIGHTS[i], 0);
  const check = sum % 11 === 10 ? 'X' : String(sum % 11);
  return raw.slice(0, 8) + check + raw.slice(9);
}

async function seedVehicles(site: { id: string; locationIds: Map<string, string> }): Promise<number> {
  const owners = await Promise.all(
    [
      { code: 'SAG', name: 'Summit Auto Group' },
      { code: 'CLR', name: 'Coastline Rentals' },
      { code: 'NPF', name: 'Northpoint Fleet Leasing' },
    ].map((p) => prisma.partner.create({ data: { code: p.code, name: p.name, partnerTypes: ['CUSTOMER'] } })),
  );
  const dispatcher = await prisma.user.findUniqueOrThrow({ where: { username: 'dispatcher' } });
  const checklist = ['EXTERIOR', 'INTERIOR', 'KEYS', 'DOCUMENTS', 'PHOTOS_4_SIDES'].map((key) => ({ key, passed: true }));

  // ~60% ô đỗ có xe; vài xe ở trạng thái khác để demo đủ vòng đời
  type Plan = { status: 'EXPECTED' | 'RECEIVED' | 'INSPECTED' | 'STORED' | 'RELEASE_REQUESTED'; slot?: string; condition?: 'OK' | 'MINOR_DAMAGE' | 'MAJOR_DAMAGE'; hold?: string };
  const plans: Plan[] = [];
  for (const row of ['A', 'B', 'C', 'D']) {
    for (let c = 1; c <= 20; c++) {
      if ((c * 7 + row.charCodeAt(0)) % 5 >= 3) continue;
      plans.push({ status: 'STORED', slot: `P-${row}-${String(c).padStart(3, '0')}` });
    }
  }
  plans[3].condition = 'MINOR_DAMAGE';
  plans[11].condition = 'MINOR_DAMAGE';
  plans[7] = { ...plans[7], hold: 'Title dispute — awaiting owner documents' };
  plans[19] = { ...plans[19], condition: 'MAJOR_DAMAGE', hold: 'Front-end collision damage — insurer review' };
  plans[24].status = 'RELEASE_REQUESTED';
  plans.push({ status: 'INSPECTED' }, { status: 'RECEIVED' }, { status: 'EXPECTED' }, { status: 'EXPECTED' }, { status: 'EXPECTED' });

  let n = 0;
  for (const p of plans) {
    n++;
    const m = MODELS[n % MODELS.length];
    const owner = owners[n % owners.length];
    const vehicle = await prisma.storedVehicle.create({
      data: { vin: makeVin(m.wmi, n), make: m.make, model: m.model, modelYear: 2023 + (n % 4), color: m.colors[n % m.colors.length], plateNumber: n % 3 === 0 ? null : `${owner.code}-${String(4000 + n * 13).slice(-4)}`, ownerPartnerId: owner.id },
    });
    const daysAgo = 1 + ((n * 5) % 40);
    const received = p.status === 'EXPECTED' ? null : minutes(-daysAgo * 1440);
    const stay = await prisma.vehicleStay.create({
      data: {
        siteId: site.id,
        vehicleId: vehicle.id,
        status: p.status,
        conditionStatus: p.condition ?? 'OK',
        holdFlag: !!p.hold,
        holdReason: p.hold ?? null,
        odometerKm: received ? 15 + ((n * 97) % 900) : null,
        fuelOrBatteryPct: received ? 30 + ((n * 13) % 60) : null,
        keyTag: received ? `K-${String(n).padStart(3, '0')}` : null,
        expectedAt: p.status === 'EXPECTED' ? minutes(60 + n * 15) : minutes(-daysAgo * 1440 - 60),
        receivedAt: received,
        storedAt: p.slot ? minutes(-daysAgo * 1440 + 45) : null,
      },
    });
    if (['INSPECTED', 'STORED', 'RELEASE_REQUESTED'].includes(p.status)) {
      await prisma.vehicleInspection.create({ data: { siteId: site.id, vehicleStayId: stay.id, inspectionType: 'RECEIVING', checklist, resultCondition: p.condition ?? 'OK', inspectorId: dispatcher.id, inspectedAt: minutes(-daysAgo * 1440 + 20) } });
    }
    if (p.slot) {
      const locationId = site.locationIds.get(p.slot)!;
      await prisma.locationOccupancy.create({
        data: { siteId: site.id, locationId, occupantType: 'VEHICLE_STAY', occupantId: stay.id, kind: 'OCCUPIED', singleOccupancy: true, occupiedAt: minutes(-daysAgo * 1440 + 45), positionSource: 'CONFIRMED_SCAN' },
      });
      await prisma.movementRecord.create({ data: { siteId: site.id, subjectType: 'VEHICLE_STAY', subjectId: stay.id, toLocationId: locationId, positionSource: 'CONFIRMED_SCAN', reason: 'Parked', actorId: dispatcher.id, occurredAt: minutes(-daysAgo * 1440 + 45) } });
    }
    // Nhật ký kiểm toán để lịch sử VIN có đủ mốc (AC-08)
    const base = -daysAgo * 1440;
    const audit = (action: string, offsetMin: number, reason?: string) => ({ siteId: site.id, actorType: 'USER' as const, actorId: dispatcher.id, action, entityType: 'VehicleStay', entityId: stay.id, reason: reason ?? null, occurredAt: minutes(offsetMin) });
    const entries = [audit('VEHICLE_STAY_CREATED', p.status === 'EXPECTED' ? -30 : base - 120)];
    if (received) entries.push(audit('VEHICLE_RECEIVED', base));
    if (['INSPECTED', 'STORED', 'RELEASE_REQUESTED'].includes(p.status)) entries.push(audit('VEHICLE_INSPECTED', base + 20));
    if (p.slot) entries.push(audit('SLOT_RESERVED', base + 25), audit('VEHICLE_STORED', base + 45));
    if (p.hold) entries.push({ ...audit('VEHICLE_HOLD_SET', base + 60, p.hold) });
    if (p.status === 'RELEASE_REQUESTED') entries.push(audit('VEHICLE_RELEASE_REQUESTED', -90, 'Sold — dealer pickup'));
    await prisma.auditLog.createMany({ data: entries });
    if (p.status === 'RELEASE_REQUESTED') {
      await prisma.releaseRequest.create({ data: { siteId: site.id, vehicleStayId: stay.id, reason: 'Sold — dealer pickup', recipientName: 'Jordan Blake (Summit Auto)', plannedAt: minutes(180), requestedById: dispatcher.id } });
    }
  }
  return plans.length;
}

/** Vài ngoại lệ đang mở + thông báo tương ứng để chuông và trang Ngoại lệ có dữ liệu demo (UC-23, FR-18). */
async function seedExceptionsAndNotifications(sites: Map<string, { id: string; locationIds: Map<string, string> }>) {
  const user = async (username: string) => (await prisma.user.findUniqueOrThrow({ where: { username } })).id;
  const [operator, supervisor, dispatcher, manager] = await Promise.all(['operator', 'supervisor', 'dispatcher', 'manager'].map(user));
  const wh1 = sites.get('WH-01')!.id;
  const wh6 = sites.get('WH-06')?.id;
  const damaged = wh6 ? await prisma.vehicleStay.findFirst({ where: { siteId: wh6, conditionStatus: 'MAJOR_DAMAGE' }, include: { vehicle: true } }) : null;
  const cases = [
    { siteId: wh1, code: 'EXC-00001', caseType: 'DAMAGE', severity: 'HIGH' as const, status: 'OPEN' as const, description: 'Pallet wrap torn and two cartons crushed at staging S02 — PKG-BOX-M', createdById: operator, createdAt: minutes(-95) },
    { siteId: wh1, code: 'EXC-00002', caseType: 'COUNT_VARIANCE', severity: 'MEDIUM' as const, status: 'IN_REVIEW' as const, description: 'Cycle count R-03-02: system 240, counted 236', createdById: operator, assigneeId: supervisor, createdAt: minutes(-240) },
    { siteId: wh1, code: 'EXC-00003', caseType: 'SAFETY', severity: 'LOW' as const, status: 'RESOLVED' as const, description: 'Blocked walkway near dock D3', createdById: dispatcher, assigneeId: supervisor, resolutionCode: 'CLEARED', resolutionNote: 'Empty pallets removed', createdAt: minutes(-1500) },
    ...(damaged && wh6 ? [{ siteId: wh6, code: 'EXC-00004', caseType: 'VEHICLE_DAMAGE', severity: 'HIGH' as const, status: 'OPEN' as const, subjectType: 'VEHICLE_STAY', subjectId: damaged.id, description: `Major damage on ${damaged.vehicle.vin} — front bumper and headlight`, createdById: dispatcher, createdAt: minutes(-60 * 24 * 3) }] : []),
  ];
  const created = [];
  for (const c of cases) created.push(await prisma.exceptionCase.create({ data: c }));
  await prisma.codeCounter.create({ data: { scope: 'EXC', value: cases.length } });

  const [exc1, , , exc4] = created;
  await prisma.notification.createMany({
    data: [
      { siteId: wh1, userId: manager, eventId: 'seed:1', category: 'EXCEPTION', severity: 'HIGH', title: `${exc1.code} · DAMAGE`, body: exc1.description, link: `/sites/WH-01/exceptions?case=${exc1.id}`, createdAt: minutes(-95) },
      { siteId: wh1, userId: manager, eventId: 'seed:2', category: 'EQUIPMENT', severity: 'WARNING', title: 'FL-07 · Battery 18% (< 20%)', link: '/sites/WH-01', createdAt: minutes(-40) },
      { siteId: wh1, userId: dispatcher, eventId: 'seed:3', category: 'YARD', severity: 'INFO', title: 'TRK-2051 at gate', body: 'WTF Freight', link: '/sites/WH-01/yard', createdAt: minutes(-12) },
      ...(exc4 && wh6 ? [{ siteId: wh6, userId: manager, eventId: 'seed:4', category: 'EXCEPTION', severity: 'HIGH', title: `${exc4.code} · VEHICLE_DAMAGE`, body: exc4.description, link: `/sites/WH-06/exceptions?case=${exc4.id}`, createdAt: minutes(-60 * 24 * 3), readAt: minutes(-60 * 24 * 2) }] : []),
    ],
  });
}

async function truncateAll() {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

async function seedRoles() {
  const permissions = new Map<string, string>();
  for (const code of ALL_PERMISSIONS) {
    const p = await prisma.permission.create({ data: { code, module: code.split('.')[0] } });
    permissions.set(code, p.id);
  }
  const roles = new Map<string, string>();
  for (const role of Object.values(Role)) {
    const r = await prisma.role.create({ data: { code: role, name: ROLE_LABELS[role].en } });
    roles.set(role, r.id);
    const perms = ALL_PERMISSIONS.filter((p) => (PERMISSION_MATRIX[p] as readonly string[]).includes(role));
    await prisma.rolePermission.createMany({ data: perms.map((p) => ({ roleId: r.id, permissionId: permissions.get(p)! })) });
  }
  return roles;
}

async function seedSite(s: SiteSeed) {
  const site = await prisma.site.create({
    data: { code: s.code, name: s.name, siteType: s.siteType, addressLine: s.address, timezone: 'America/New_York', mapX: s.map?.x ?? 0, mapZ: s.map?.z ?? 0 },
  });
  const zoneIds = new Map<string, string>();
  for (const z of s.layout.zones) {
    const zone = await prisma.zone.create({ data: { siteId: site.id, code: z.code, name: z.name, zoneType: z.zoneType } });
    zoneIds.set(z.code, zone.id);
  }
  const locationIds = new Map<string, string>();
  const locRows: Prisma.LocationCreateManyInput[] = [];
  const dockRows: Prisma.DockCreateManyInput[] = [];
  for (const l of s.layout.locations) {
    const id = uuidv7();
    locRows.push({
      id,
      siteId: site.id,
      zoneId: zoneIds.get(l.zone)!,
      code: l.code,
      name: l.label ?? null,
      qrValue: `WT:LOC:${s.code}:${l.code}`,
      locationType: l.type,
      capacityUnits: l.capacity,
      singleOccupancy: l.single,
      lengthM: l.lengthM,
      widthM: l.widthM,
    });
    locationIds.set(l.code, id);
    if (l.type === 'DOCK') dockRows.push({ locationId: id, siteId: site.id, direction: l.dockDirection ?? 'BOTH', doorNumber: l.doorNumber, maxTruckLengthM: l.lengthM });
  }
  await prisma.location.createMany({ data: locRows });
  if (dockRows.length) await prisma.dock.createMany({ data: dockRows });
  const b = s.layout.bounds;
  const layout = await prisma.layoutVersion.create({
    data: { siteId: site.id, versionNo: 1, status: 'PUBLISHED', boundsMinX: b.minX, boundsMinZ: b.minZ, boundsMaxX: b.maxX, boundsMaxZ: b.maxZ, publishedAt: now },
  });
  const objects: Prisma.LayoutObjectCreateManyInput[] = [
    ...s.layout.zones
      .filter((z) => z.color !== 'transparent')
      .map((z) => ({
        layoutVersionId: layout.id,
        targetType: 'ZONE' as const,
        targetId: zoneIds.get(z.code)!,
        posX: z.rect.x + z.rect.w / 2,
        posZ: z.rect.z + z.rect.d / 2,
        sizeX: z.rect.w,
        sizeY: 0.02,
        sizeZ: z.rect.d,
        props: { color: z.color, name: z.name, zoneType: z.zoneType },
      })),
    ...s.layout.locations
      .filter((l) => !l.noLayout)
      .map((l) => ({
        layoutVersionId: layout.id,
        targetType: 'LOCATION' as const,
        targetId: locationIds.get(l.code)!,
        meshRef: `LOC:${l.code}`,
        posX: l.pos.x,
        posZ: l.pos.z,
        rotY: l.pos.rotY,
        sizeX: l.size.x,
        sizeY: 0.05,
        sizeZ: l.size.z,
        props: { code: l.code, locationType: l.type, label: l.label ?? l.code, display: l.display ?? null, levels: l.levels ?? null, bays: l.bays ?? null },
      })),
    ...s.layout.buildings.map((bd) => ({
      layoutVersionId: layout.id,
      targetType: 'BUILDING' as const,
      posX: bd.rect.x + bd.rect.w / 2,
      posZ: bd.rect.z + bd.rect.d / 2,
      sizeX: bd.rect.w,
      sizeY: bd.height,
      sizeZ: bd.rect.d,
      props: { label: bd.label, roofColor: bd.roofColor, wallColor: bd.wallColor, code: bd.code, style: (bd.style ?? null) as unknown as Prisma.InputJsonValue },
    })),
    ...s.layout.decor.map((d) => ({
      layoutVersionId: layout.id,
      targetType: 'DECOR' as const,
      posX: d.x,
      posZ: d.z,
      rotY: d.rotY ?? 0,
      sizeX: d.w ?? 1,
      sizeY: d.h ?? 1,
      sizeZ: d.d ?? 1,
      props: { kind: d.kind, color: d.color ?? null, label: d.label ?? null, ...(d.props ?? {}) } as Prisma.InputJsonValue,
    })),
  ];
  await prisma.layoutObject.createMany({ data: objects });
  return { site, locationIds };
}

async function main() {
  console.log('Seeding WareTrack demo data (video parity)…');
  await truncateAll();
  const roles = await seedRoles();

  const sites = new Map<string, SiteRef>();
  for (const s of SITES) {
    const { site, locationIds } = await seedSite(s);
    sites.set(s.code, { id: site.id, locationIds });
  }
  // Panel site hiển thị đúng 4 SKU theo thứ tự video
  for (const [code, site] of sites) {
    const inv = SITE_INVENTORY[code];
    if (inv) await prisma.siteSetting.create({ data: { siteId: site.id, key: 'dashboardSkus', value: inv.featured.map(([s]) => s) } });
  }

  const carriers = new Map<string, string>();
  for (const c of CARRIERS) {
    const p = await prisma.partner.create({ data: { code: c.code, name: c.name, partnerTypes: ['CARRIER'] } });
    carriers.set(c.code, p.id);
  }
  const customers: string[] = [];
  for (const p of PARTNERS) {
    const created = await prisma.partner.create({ data: { code: p.code, name: p.name, partnerTypes: p.types } });
    if (p.types.includes('CUSTOMER')) customers.push(created.id);
  }

  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  const userIds = new Map<string, string>();
  for (const u of USERS) {
    const user = await prisma.user.create({ data: { username: u.username, email: `${u.username}@waretrack.demo`, fullName: u.fullName, passwordHash } });
    userIds.set(u.username, user.id);
    for (const g of u.grants) {
      const siteIds = g.sites ? g.sites.filter((c) => sites.has(c)).map((c) => sites.get(c)!.id) : [null];
      for (const siteId of siteIds) await prisma.userSiteRole.create({ data: { userId: user.id, roleId: roles.get(g.role)!, siteId } });
    }
  }

  // Xe tải + lượt xe theo video
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
  let visitSeq = 0;
  for (const v of VISITS) {
    const site = sites.get(v.site);
    if (!site) continue;
    const truck = await prisma.truck.create({ data: { code: v.truck, plateNumber: v.plate, truckType: v.type, carrierId: carriers.get(v.carrier)! } });
    const driver = await prisma.driver.create({ data: { fullName: v.driver, carrierId: carriers.get(v.carrier)! } });
    const arrivedAt = v.arrivedMinAgo !== undefined ? minutes(-v.arrivedMinAgo) : null;
    const at = (m: number) => (arrivedAt ? new Date(arrivedAt.getTime() + m * 60_000) : null);
    const onSite = v.status !== 'SCHEDULED';
    const dockId = v.dock ? site.locationIds.get(v.dock)! : null;
    const appt = arrivedAt ?? minutes(v.etaMin ?? 30);
    const visit = await prisma.truckVisit.create({
      data: {
        siteId: site.id,
        code: `VIS-${ymd}-${String(++visitSeq).padStart(4, '0')}`,
        truckId: truck.id,
        driverId: driver.id,
        direction: v.direction,
        status: v.status,
        appointmentStart: appt,
        appointmentEnd: new Date(appt.getTime() + 3600_000),
        etaAt: v.etaMin !== undefined ? minutes(v.etaMin) : null,
        arrivedAt,
        verifiedAt: onSite && v.status !== 'AT_GATE' ? at(2) : null,
        dockedAt: ['AT_DOCK', 'HANDLING'].includes(v.status) ? at(5) : null,
        handlingStartedAt: v.status === 'HANDLING' ? at(7) : null,
        dockLocationId: dockId,
        actualPlate: arrivedAt ? v.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : null,
      },
    });
    if (dockId) {
      const occupied = ['AT_DOCK', 'HANDLING'].includes(v.status);
      await prisma.locationOccupancy.create({
        data: { siteId: site.id, locationId: dockId, occupantType: 'TRUCK_VISIT', occupantId: visit.id, kind: occupied ? 'OCCUPIED' : 'RESERVED', singleOccupancy: true, occupiedAt: occupied ? at(5) : null, positionSource: occupied ? 'CONFIRMED_SCAN' : null },
      });
    }
  }
  await prisma.codeCounter.create({ data: { scope: `VIS-${ymd}`, value: visitSeq } });
  await prisma.codeCounter.create({ data: { scope: 'TRK', value: 2700 } });

  for (const e of EQUIPMENT) {
    const site = sites.get(e.site);
    if (!site) continue;
    await prisma.equipment.create({
      data: {
        siteId: site.id,
        code: e.code,
        equipmentType: 'FORKLIFT',
        model: e.model,
        status: e.status,
        chargerLocationId: site.locationIds.get(e.charger) ?? null,
        currentOperatorId: userIds.get(e.operator) ?? null,
        taskSummary: e.task ?? (e.status === 'CHARGING' ? 'Charging at bay' : e.status === 'AVAILABLE' ? 'Waiting for work' : null),
        telemetry: { batteryPct: e.battery, speedKmh: e.speed ?? 0, movesToday: e.moves },
        telemetryAt: now,
        telemetrySource: 'CONFIRMED_MANUAL',
      },
    });
  }

  const pallets = await seedInventory(sites, userIds);
  await seedHistory(sites, carriers, customers);
  const vehicles = sites.has('WH-06') ? await seedVehicles(sites.get('WH-06')!) : 0;
  await seedExceptionsAndNotifications(sites);
  // Cờ cho DemoDirector: dữ liệu đã nạp đủ, có thể dựng cảnh
  await prisma.siteSetting.create({ data: { siteId: sites.get('WH-01')!.id, key: 'seed.completedAt', value: now.toISOString() } });

  console.log(`Done. ${SITES.length} sites, ${VISITS.length} live visits, ${EQUIPMENT.length} forklifts, ${USERS.length} users, ${pallets} pallets, ${vehicles} stored vehicles.`);
  console.log(`Demo login: manager / ${DEMO_PASSWORD} (and admin, dispatcher, gate, supervisor, operator, forklift, inventory, viewer)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
