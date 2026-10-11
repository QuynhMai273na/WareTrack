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
const minutes = (offsetMinutes: number) => new Date(now.getTime() + offsetMinutes * 60_000);
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
const SITE_CODES = SITES.map((site) => site.code);

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
  ...OPERATORS.map((operator) => ({ username: operator.username, fullName: operator.fullName, grants: [{ role: Role.FORKLIFT_OPERATOR, sites: [operator.site] }] })),
];

type SiteRef = { id: string; locationIds: Map<string, string> };

async function chunked<T>(rows: T[], fn: (batch: T[]) => Promise<unknown>, size = 1000) {
  for (let offset = 0; offset < rows.length; offset += size) await fn(rows.slice(offset, offset + size));
}

/** Đầu ngày theo giờ New York (timezone của site demo). */
function todayStartNy(): Date {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')!.value) % 24;
  const minute = Number(parts.find((part) => part.type === 'minute')!.value);
  return new Date(now.getTime() - (hour * 60 + minute) * 60_000 - now.getSeconds() * 1000);
}

/** Số pallet DemoDirector sẽ nhận thêm lúc dựng cảnh (để KPI sau khi dựng khớp video). */
const DIRECTOR_RECEIPTS: Record<string, number> = { 'WH-02': 1, 'WH-03': 3, 'WH-04': 2 };

/**
 * Tồn kho: pallet ngoài trời theo video + pallet trong nhà (bulk) sao cho tổng pallet, số lượng SKU hiển thị
 * và "pallet nhận hôm nay" khớp số liệu video. Mỗi pallet có ledger RECEIPT + occupancy + movement.
 */
async function seedInventory(sites: Map<string, SiteRef>, userIds: Map<string, string>): Promise<number> {
  const skuIds = new Map<string, string>();
  for (const sku of SKUS) {
    const created = await prisma.sku.create({
      data: { code: sku.code, name: sku.name, category: sku.category, lotTracked: !!sku.lot, expiryTracked: !!sku.expiryDays, allocationStrategy: sku.expiryDays ? 'FEFO' : 'FIFO', unitWeightKg: sku.weight, lowStockThreshold: sku.lowStock ?? null },
    });
    skuIds.set(sku.code, created.id);
  }
  const lots = new Map<string, string>();
  const lotOf = async (skuCode: string, lotNumber?: string) => {
    const sku = SKUS.find((skuSeed) => skuSeed.code === skuCode)!;
    if (!sku.lot && !lotNumber) return null;
    const number = lotNumber ?? `L2509-${100 + (skuCode.length * 37) % 800}`;
    const key = `${skuCode}:${number}`;
    if (!lots.has(key)) {
      const lot = await prisma.lot.create({ data: { skuId: skuIds.get(skuCode)!, lotNumber: number, manufacturedOn: minutes(-60 * 24 * 40), expiresOn: sku.expiryDays ? minutes(60 * 24 * (sku.expiryDays - 40)) : null } });
      lots.set(key, lot.id);
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
    for (const pallet of OUTDOOR_PALLETS[code] ?? []) {
      for (let copyIndex = 0; copyIndex < (pallet.n ?? 1); copyIndex++) {
        rows.push({ code: pallet.code ?? nextVisible(), sku: pallet.sku, qty: pallet.qty, loc: pallet.loc, lot: pallet.lot, receivedAt: pallet.receivedAt ? new Date(pallet.receivedAt) : minutes(-60 * 24 * (3 + (copyIndex % 9))), lifecycle: pallet.lifecycle ?? 'IN_STOCK' });
      }
    }
    // 2) SKU hiển thị: bù phần còn thiếu bằng pallet trong nhà
    const indoor = [...site.locationIds.entries()].filter(([locationCode]) => /^[A-Z]-\d{3}$/.test(locationCode)).map(([, id]) => id);
    let slot = 0;
    const nextIndoor = () => indoor[Math.floor(slot++ / 28) % indoor.length];
    for (const [sku, units] of inv.featured) {
      let left = units - rows.filter((row) => row.sku === sku).reduce((sum, row) => sum + row.qty, 0);
      const per = SKUS.find((skuSeed) => skuSeed.code === sku)!.perPallet;
      while (left > 0) {
        const quantity = Math.min(per, left);
        rows.push({ code: `PAL-${palletNo++}`, sku, qty: quantity, loc: nextIndoor(), receivedAt: minutes(-60 * 24 * (2 + (rows.length % 25))), lifecycle: 'IN_STOCK' });
        left -= quantity;
      }
    }
    // 3) Hàng lấp đầy tới tổng pallet mục tiêu (trừ phần DemoDirector sẽ nhận thêm)
    const target = inv.pallets - (DIRECTOR_RECEIPTS[code] ?? 0);
    let fillerIndex = 0;
    while (rows.length < target) {
      const sku = inv.filler[fillerIndex++ % inv.filler.length];
      const per = SKUS.find((skuSeed) => skuSeed.code === sku)!.perPallet;
      rows.push({ code: `PAL-${palletNo++}`, sku, qty: per, loc: nextIndoor(), receivedAt: minutes(-60 * 24 * (2 + (fillerIndex % 40))), lifecycle: 'IN_STOCK' });
    }
    // 4) Pallet nhận hôm nay = put-away hôm nay (KPI "+15 pallets") — trừ phần director nhận thêm
    const todayCount = inv.putawaysToday - (DIRECTOR_RECEIPTS[code] ?? 0);
    const todayRows = rows.filter((row) => /^[A-Z]-\d{3}$/.test([...site.locationIds.entries()].find(([, id]) => id === row.loc)?.[0] ?? '')).slice(-todayCount);
    todayRows.forEach((row, rowIndex) => {
      row.today = true;
      row.receivedAt = new Date(todayStart.getTime() + ((rowIndex + 1) / (todayCount + 1)) * sinceToday * 60_000);
    });

    const locId = (locationCode: string) => site.locationIds.get(locationCode) ?? locationCode;
    const hu: Prisma.HandlingUnitCreateManyInput[] = [];
    const bal: Prisma.InventoryBalanceCreateManyInput[] = [];
    const tx: Prisma.InventoryTransactionCreateManyInput[] = [];
    const occ: Prisma.LocationOccupancyCreateManyInput[] = [];
    const mov: Prisma.MovementRecordCreateManyInput[] = [];
    const tasks: Prisma.OperationTaskCreateManyInput[] = [];
    let taskNo = 0;
    for (const row of rows) {
      const id = uuidv7();
      const sku = SKUS.find((skuSeed) => skuSeed.code === row.sku)!;
      const lotId = await lotOf(row.sku, row.lot);
      const location = locId(row.loc);
      hu.push({ id, siteId: site.id, code: row.code, lifecycle: row.lifecycle, locationId: location, positionSource: 'CONFIRMED_SCAN', positionConfirmedAt: row.receivedAt, grossWeightKg: Math.round(row.qty * sku.weight * 0.85 + 22), createdAt: row.receivedAt });
      bal.push({ siteId: site.id, locationId: location, skuId: skuIds.get(row.sku)!, lotId, handlingUnitId: id, stockStatus: 'AVAILABLE', qtyOnHand: row.qty, receivedAt: row.receivedAt });
      tx.push({ siteId: site.id, txType: 'RECEIPT', idempotencyKey: `seed:${code}:${row.code}`, skuId: skuIds.get(row.sku)!, lotId, handlingUnitId: id, toLocationId: location, toStatus: 'AVAILABLE', quantity: row.qty, referenceType: 'SEED', referenceId: id, occurredAt: row.receivedAt });
      occ.push({ siteId: site.id, locationId: location, occupantType: 'HANDLING_UNIT', occupantId: id, kind: 'OCCUPIED', singleOccupancy: false, occupiedAt: row.receivedAt, positionSource: 'CONFIRMED_SCAN', startedAt: row.receivedAt });
      mov.push({ siteId: site.id, subjectType: 'HANDLING_UNIT', subjectId: id, toLocationId: location, positionSource: 'CONFIRMED_SCAN', reason: row.today ? 'Put-away' : 'Initial stock (seed)', occurredAt: row.receivedAt });
      if (row.today) {
        taskNo++;
        tasks.push({ siteId: site.id, code: `TSK-${code.slice(-2)}${String(taskNo).padStart(4, '0')}`, taskType: 'PUTAWAY', status: 'COMPLETED', subjectType: 'HANDLING_UNIT', subjectId: id, toLocationId: location, sourceType: 'SEED', sourceId: id, completedAt: row.receivedAt, startedAt: new Date(row.receivedAt.getTime() - 4 * 60_000), createdAt: new Date(row.receivedAt.getTime() - 9 * 60_000), payload: { subjectCode: row.code } });
      }
    }
    // Put-away hôm nay của pallet director sẽ nhận (đã có sẵn trong số 35/20…) — bù bằng task của pallet hôm qua
    for (let extraIndex = 0; extraIndex < (DIRECTOR_RECEIPTS[code] ?? 0); extraIndex++) {
      const handlingUnit = hu[hu.length - 1 - todayCount - extraIndex];
      taskNo++;
      tasks.push({ siteId: site.id, code: `TSK-${code.slice(-2)}${String(taskNo).padStart(4, '0')}`, taskType: 'PUTAWAY', status: 'COMPLETED', subjectType: 'HANDLING_UNIT', subjectId: handlingUnit.id!, toLocationId: handlingUnit.locationId!, sourceType: 'SEED', sourceId: handlingUnit.id!, completedAt: new Date(todayStart.getTime() + 20 * 60_000), createdAt: new Date(todayStart.getTime() + 10 * 60_000), payload: { subjectCode: handlingUnit.code } });
    }
    await chunked(hu, (batch) => prisma.handlingUnit.createMany({ data: batch }));
    await chunked(bal, (batch) => prisma.inventoryBalance.createMany({ data: batch }));
    await chunked(tx, (batch) => prisma.inventoryTransaction.createMany({ data: batch }));
    await chunked(occ, (batch) => prisma.locationOccupancy.createMany({ data: batch }));
    await chunked(mov, (batch) => prisma.movementRecord.createMany({ data: batch }));
    await chunked(tasks, (batch) => prisma.operationTask.createMany({ data: batch }));
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
    for (let truckIndex = 0; truckIndex < 12; truckIndex++) {
      const truck = await prisma.truck.create({ data: { code: `TRK-${truckNo++}`, plateNumber: `HX${truckNo}${truckIndex}`, truckType: 'BOX', carrierId: carrierIds[truckIndex % carrierIds.length] } });
      pool.push(truck.id);
    }
    const visits: Prisma.TruckVisitCreateManyInput[] = [];
    for (let visitIndex = 0; visitIndex < inv.outboundToday; visitIndex++) {
      const exitedAt = new Date(todayStart.getTime() + ((visitIndex + 1) / (inv.outboundToday + 1)) * span * 60_000);
      const arrivedAt = new Date(exitedAt.getTime() - 55 * 60_000);
      visits.push({
        siteId: site.id, code: `VIS-H${code.slice(-2)}-${String(visitIndex + 1).padStart(3, '0')}`, truckId: pool[visitIndex % pool.length], direction: 'OUTBOUND', status: 'EXITED',
        appointmentStart: arrivedAt, appointmentEnd: new Date(arrivedAt.getTime() + 3600_000), arrivedAt, verifiedAt: arrivedAt, dockedAt: arrivedAt, handlingStartedAt: arrivedAt, readyAt: exitedAt, exitedAt, exitReason: 'COMPLETED',
      });
    }
    await prisma.truckVisit.createMany({ data: visits });

    const ships: Prisma.ShipmentCreateManyInput[] = [];
    const window = (startDays: number, pct: number, count: number) => {
      const onTime = Math.round((pct / 100) * count);
      for (let shipmentIndex = 0; shipmentIndex < count; shipmentIndex++) {
        const promisedAt = minutes(-60 * 24 * (startDays + (shipmentIndex / count) * 29.5) - 60);
        const late = shipmentIndex >= onTime;
        const deliveredAt = new Date(promisedAt.getTime() + (late ? 40 : -25) * 60_000);
        const plannedDispatchAt = new Date(promisedAt.getTime() - 4 * 3600_000);
        ships.push({ siteId: site.id, code: `SHP-${shpNo++}`, direction: 'OUTBOUND', status: 'DELIVERED', partnerId: customers[shipmentIndex % customers.length], carrierId: carrierIds[shipmentIndex % carrierIds.length], plannedDispatchAt, dispatchedAt: new Date(plannedDispatchAt.getTime() + (late ? 20 : -5) * 60_000), promisedAt, deliveredAt, expectedHuCount: 6, createdAt: new Date(plannedDispatchAt.getTime() - 6 * 3600_000) });
      }
    };
    window(0.1, inv.onTime.pct30, inv.onTime.samples);
    window(30.2, inv.onTime.pctPrev, inv.onTime.samples);
    await chunked(ships, (batch) => prisma.shipment.createMany({ data: batch }));
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
function makeVin(wmi: string, serial: number): string {
  const vds = Array.from({ length: 5 }, (_, charIndex) => VIN_CHARS[(serial * 7 + charIndex * 11) % VIN_CHARS.length]).join('');
  const raw = `${wmi}${vds}0R${'ABCDEFGH'[serial % 8]}${String(100000 + serial * 137).slice(-6)}`;
  const sum = raw.split('').reduce((weightedSum, character, position) => weightedSum + (/\d/.test(character) ? Number(character) : VIN_TRANSLIT[character]) * VIN_WEIGHTS[position], 0);
  const check = sum % 11 === 10 ? 'X' : String(sum % 11);
  return raw.slice(0, 8) + check + raw.slice(9);
}

async function seedVehicles(site: { id: string; locationIds: Map<string, string> }): Promise<number> {
  const owners = await Promise.all(
    [
      { code: 'SAG', name: 'Summit Auto Group' },
      { code: 'CLR', name: 'Coastline Rentals' },
      { code: 'NPF', name: 'Northpoint Fleet Leasing' },
    ].map((ownerSeed) => prisma.partner.create({ data: { code: ownerSeed.code, name: ownerSeed.name, partnerTypes: ['CUSTOMER'] } })),
  );
  const dispatcher = await prisma.user.findUniqueOrThrow({ where: { username: 'dispatcher' } });
  const checklist = ['EXTERIOR', 'INTERIOR', 'KEYS', 'DOCUMENTS', 'PHOTOS_4_SIDES'].map((key) => ({ key, passed: true }));

  // ~60% ô đỗ có xe; vài xe ở trạng thái khác để demo đủ vòng đời
  type Plan = { status: 'EXPECTED' | 'RECEIVED' | 'INSPECTED' | 'STORED' | 'RELEASE_REQUESTED'; slot?: string; condition?: 'OK' | 'MINOR_DAMAGE' | 'MAJOR_DAMAGE'; hold?: string };
  const plans: Plan[] = [];
  for (const row of ['A', 'B', 'C', 'D']) {
    for (let column = 1; column <= 20; column++) {
      if ((column * 7 + row.charCodeAt(0)) % 5 >= 3) continue;
      plans.push({ status: 'STORED', slot: `P-${row}-${String(column).padStart(3, '0')}` });
    }
  }
  plans[3].condition = 'MINOR_DAMAGE';
  plans[11].condition = 'MINOR_DAMAGE';
  plans[7] = { ...plans[7], hold: 'Title dispute — awaiting owner documents' };
  plans[19] = { ...plans[19], condition: 'MAJOR_DAMAGE', hold: 'Front-end collision damage — insurer review' };
  plans[24].status = 'RELEASE_REQUESTED';
  plans.push({ status: 'INSPECTED' }, { status: 'RECEIVED' }, { status: 'EXPECTED' }, { status: 'EXPECTED' }, { status: 'EXPECTED' });

  let vehicleNo = 0;
  for (const plan of plans) {
    vehicleNo++;
    const modelSpec = MODELS[vehicleNo % MODELS.length];
    const owner = owners[vehicleNo % owners.length];
    const vehicle = await prisma.storedVehicle.create({
      data: { vin: makeVin(modelSpec.wmi, vehicleNo), make: modelSpec.make, model: modelSpec.model, modelYear: 2023 + (vehicleNo % 4), color: modelSpec.colors[vehicleNo % modelSpec.colors.length], plateNumber: vehicleNo % 3 === 0 ? null : `${owner.code}-${String(4000 + vehicleNo * 13).slice(-4)}`, ownerPartnerId: owner.id },
    });
    const daysAgo = 1 + ((vehicleNo * 5) % 40);
    const received = plan.status === 'EXPECTED' ? null : minutes(-daysAgo * 1440);
    const stay = await prisma.vehicleStay.create({
      data: {
        siteId: site.id,
        vehicleId: vehicle.id,
        status: plan.status,
        conditionStatus: plan.condition ?? 'OK',
        holdFlag: !!plan.hold,
        holdReason: plan.hold ?? null,
        odometerKm: received ? 15 + ((vehicleNo * 97) % 900) : null,
        fuelOrBatteryPct: received ? 30 + ((vehicleNo * 13) % 60) : null,
        keyTag: received ? `K-${String(vehicleNo).padStart(3, '0')}` : null,
        expectedAt: plan.status === 'EXPECTED' ? minutes(60 + vehicleNo * 15) : minutes(-daysAgo * 1440 - 60),
        receivedAt: received,
        storedAt: plan.slot ? minutes(-daysAgo * 1440 + 45) : null,
      },
    });
    if (['INSPECTED', 'STORED', 'RELEASE_REQUESTED'].includes(plan.status)) {
      await prisma.vehicleInspection.create({ data: { siteId: site.id, vehicleStayId: stay.id, inspectionType: 'RECEIVING', checklist, resultCondition: plan.condition ?? 'OK', inspectorId: dispatcher.id, inspectedAt: minutes(-daysAgo * 1440 + 20) } });
    }
    if (plan.slot) {
      const locationId = site.locationIds.get(plan.slot)!;
      await prisma.locationOccupancy.create({
        data: { siteId: site.id, locationId, occupantType: 'VEHICLE_STAY', occupantId: stay.id, kind: 'OCCUPIED', singleOccupancy: true, occupiedAt: minutes(-daysAgo * 1440 + 45), positionSource: 'CONFIRMED_SCAN' },
      });
      await prisma.movementRecord.create({ data: { siteId: site.id, subjectType: 'VEHICLE_STAY', subjectId: stay.id, toLocationId: locationId, positionSource: 'CONFIRMED_SCAN', reason: 'Parked', actorId: dispatcher.id, occurredAt: minutes(-daysAgo * 1440 + 45) } });
    }
    // Nhật ký kiểm toán để lịch sử VIN có đủ mốc (AC-08)
    const base = -daysAgo * 1440;
    const audit = (action: string, offsetMin: number, reason?: string) => ({ siteId: site.id, actorType: 'USER' as const, actorId: dispatcher.id, action, entityType: 'VehicleStay', entityId: stay.id, reason: reason ?? null, occurredAt: minutes(offsetMin) });
    const entries = [audit('VEHICLE_STAY_CREATED', plan.status === 'EXPECTED' ? -30 : base - 120)];
    if (received) entries.push(audit('VEHICLE_RECEIVED', base));
    if (['INSPECTED', 'STORED', 'RELEASE_REQUESTED'].includes(plan.status)) entries.push(audit('VEHICLE_INSPECTED', base + 20));
    if (plan.slot) entries.push(audit('SLOT_RESERVED', base + 25), audit('VEHICLE_STORED', base + 45));
    if (plan.hold) entries.push({ ...audit('VEHICLE_HOLD_SET', base + 60, plan.hold) });
    if (plan.status === 'RELEASE_REQUESTED') entries.push(audit('VEHICLE_RELEASE_REQUESTED', -90, 'Sold — dealer pickup'));
    await prisma.auditLog.createMany({ data: entries });
    if (plan.status === 'RELEASE_REQUESTED') {
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
  for (const caseData of cases) created.push(await prisma.exceptionCase.create({ data: caseData }));
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
  const list = tables.map((table) => `"${table.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

async function seedRoles() {
  const permissions = new Map<string, string>();
  for (const code of ALL_PERMISSIONS) {
    const permission = await prisma.permission.create({ data: { code, module: code.split('.')[0] } });
    permissions.set(code, permission.id);
  }
  const roles = new Map<string, string>();
  for (const role of Object.values(Role)) {
    const roleRecord = await prisma.role.create({ data: { code: role, name: ROLE_LABELS[role].en } });
    roles.set(role, roleRecord.id);
    const perms = ALL_PERMISSIONS.filter((permissionCode) => (PERMISSION_MATRIX[permissionCode] as readonly string[]).includes(role));
    await prisma.rolePermission.createMany({ data: perms.map((permissionCode) => ({ roleId: roleRecord.id, permissionId: permissions.get(permissionCode)! })) });
  }
  return roles;
}

async function seedSite(siteSeed: SiteSeed) {
  const site = await prisma.site.create({
    data: { code: siteSeed.code, name: siteSeed.name, siteType: siteSeed.siteType, addressLine: siteSeed.address, timezone: 'America/New_York', mapX: siteSeed.map?.x ?? 0, mapZ: siteSeed.map?.z ?? 0 },
  });
  const zoneIds = new Map<string, string>();
  for (const zoneSpec of siteSeed.layout.zones) {
    const zone = await prisma.zone.create({ data: { siteId: site.id, code: zoneSpec.code, name: zoneSpec.name, zoneType: zoneSpec.zoneType } });
    zoneIds.set(zoneSpec.code, zone.id);
  }
  const locationIds = new Map<string, string>();
  const locRows: Prisma.LocationCreateManyInput[] = [];
  const dockRows: Prisma.DockCreateManyInput[] = [];
  for (const locationSpec of siteSeed.layout.locations) {
    const id = uuidv7();
    locRows.push({
      id,
      siteId: site.id,
      zoneId: zoneIds.get(locationSpec.zone)!,
      code: locationSpec.code,
      name: locationSpec.label ?? null,
      qrValue: `WT:LOC:${siteSeed.code}:${locationSpec.code}`,
      locationType: locationSpec.type,
      capacityUnits: locationSpec.capacity,
      singleOccupancy: locationSpec.single,
      lengthM: locationSpec.lengthM,
      widthM: locationSpec.widthM,
    });
    locationIds.set(locationSpec.code, id);
    if (locationSpec.type === 'DOCK') dockRows.push({ locationId: id, siteId: site.id, direction: locationSpec.dockDirection ?? 'BOTH', doorNumber: locationSpec.doorNumber, maxTruckLengthM: locationSpec.lengthM });
  }
  await prisma.location.createMany({ data: locRows });
  if (dockRows.length) await prisma.dock.createMany({ data: dockRows });
  const bounds = siteSeed.layout.bounds;
  const layout = await prisma.layoutVersion.create({
    data: { siteId: site.id, versionNo: 1, status: 'PUBLISHED', boundsMinX: bounds.minX, boundsMinZ: bounds.minZ, boundsMaxX: bounds.maxX, boundsMaxZ: bounds.maxZ, publishedAt: now },
  });
  const objects: Prisma.LayoutObjectCreateManyInput[] = [
    ...siteSeed.layout.zones
      .filter((zoneSpec) => zoneSpec.color !== 'transparent')
      .map((zoneSpec) => ({
        layoutVersionId: layout.id,
        targetType: 'ZONE' as const,
        targetId: zoneIds.get(zoneSpec.code)!,
        posX: zoneSpec.rect.x + zoneSpec.rect.w / 2,
        posZ: zoneSpec.rect.z + zoneSpec.rect.d / 2,
        sizeX: zoneSpec.rect.w,
        sizeY: 0.02,
        sizeZ: zoneSpec.rect.d,
        props: { color: zoneSpec.color, name: zoneSpec.name, zoneType: zoneSpec.zoneType },
      })),
    ...siteSeed.layout.locations
      .filter((locationSpec) => !locationSpec.noLayout)
      .map((locationSpec) => ({
        layoutVersionId: layout.id,
        targetType: 'LOCATION' as const,
        targetId: locationIds.get(locationSpec.code)!,
        meshRef: `LOC:${locationSpec.code}`,
        posX: locationSpec.pos.x,
        posZ: locationSpec.pos.z,
        rotY: locationSpec.pos.rotY,
        sizeX: locationSpec.size.x,
        sizeY: 0.05,
        sizeZ: locationSpec.size.z,
        props: { code: locationSpec.code, locationType: locationSpec.type, label: locationSpec.label ?? locationSpec.code, display: locationSpec.display ?? null, levels: locationSpec.levels ?? null, bays: locationSpec.bays ?? null },
      })),
    ...siteSeed.layout.buildings.map((buildingSpec) => ({
      layoutVersionId: layout.id,
      targetType: 'BUILDING' as const,
      posX: buildingSpec.rect.x + buildingSpec.rect.w / 2,
      posZ: buildingSpec.rect.z + buildingSpec.rect.d / 2,
      sizeX: buildingSpec.rect.w,
      sizeY: buildingSpec.height,
      sizeZ: buildingSpec.rect.d,
      props: { label: buildingSpec.label, roofColor: buildingSpec.roofColor, wallColor: buildingSpec.wallColor, code: buildingSpec.code, style: (buildingSpec.style ?? null) as unknown as Prisma.InputJsonValue },
    })),
    ...siteSeed.layout.decor.map((decorSpec) => ({
      layoutVersionId: layout.id,
      targetType: 'DECOR' as const,
      posX: decorSpec.x,
      posZ: decorSpec.z,
      rotY: decorSpec.rotY ?? 0,
      sizeX: decorSpec.w ?? 1,
      sizeY: decorSpec.h ?? 1,
      sizeZ: decorSpec.d ?? 1,
      props: { kind: decorSpec.kind, color: decorSpec.color ?? null, label: decorSpec.label ?? null, ...(decorSpec.props ?? {}) } as Prisma.InputJsonValue,
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
  for (const siteSeed of SITES) {
    const { site, locationIds } = await seedSite(siteSeed);
    sites.set(siteSeed.code, { id: site.id, locationIds });
  }
  // Panel site hiển thị đúng 4 SKU theo thứ tự video
  for (const [code, site] of sites) {
    const inv = SITE_INVENTORY[code];
    if (inv) await prisma.siteSetting.create({ data: { siteId: site.id, key: 'dashboardSkus', value: inv.featured.map(([skuCode]) => skuCode) } });
  }

  const carriers = new Map<string, string>();
  for (const carrier of CARRIERS) {
    const partner = await prisma.partner.create({ data: { code: carrier.code, name: carrier.name, partnerTypes: ['CARRIER'] } });
    carriers.set(carrier.code, partner.id);
  }
  const customers: string[] = [];
  for (const partner of PARTNERS) {
    const created = await prisma.partner.create({ data: { code: partner.code, name: partner.name, partnerTypes: partner.types } });
    if (partner.types.includes('CUSTOMER')) customers.push(created.id);
  }

  const passwordHash = await argon2.hash(DEMO_PASSWORD, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
  const userIds = new Map<string, string>();
  for (const userSeed of USERS) {
    const user = await prisma.user.create({ data: { username: userSeed.username, email: `${userSeed.username}@waretrack.demo`, fullName: userSeed.fullName, passwordHash } });
    userIds.set(userSeed.username, user.id);
    for (const grant of userSeed.grants) {
      const siteIds = grant.sites ? grant.sites.filter((siteCode) => sites.has(siteCode)).map((siteCode) => sites.get(siteCode)!.id) : [null];
      for (const siteId of siteIds) await prisma.userSiteRole.create({ data: { userId: user.id, roleId: roles.get(grant.role)!, siteId } });
    }
  }

  // Xe tải + lượt xe theo video
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, '');
  let visitSeq = 0;
  for (const visitSeed of VISITS) {
    const site = sites.get(visitSeed.site);
    if (!site) continue;
    const truck = await prisma.truck.create({ data: { code: visitSeed.truck, plateNumber: visitSeed.plate, truckType: visitSeed.type, carrierId: carriers.get(visitSeed.carrier)! } });
    const driver = await prisma.driver.create({ data: { fullName: visitSeed.driver, carrierId: carriers.get(visitSeed.carrier)! } });
    const arrivedAt = visitSeed.arrivedMinAgo !== undefined ? minutes(-visitSeed.arrivedMinAgo) : null;
    const at = (offsetMinutes: number) => (arrivedAt ? new Date(arrivedAt.getTime() + offsetMinutes * 60_000) : null);
    const onSite = visitSeed.status !== 'SCHEDULED';
    const dockId = visitSeed.dock ? site.locationIds.get(visitSeed.dock)! : null;
    const appt = arrivedAt ?? minutes(visitSeed.etaMin ?? 30);
    const visit = await prisma.truckVisit.create({
      data: {
        siteId: site.id,
        code: `VIS-${ymd}-${String(++visitSeq).padStart(4, '0')}`,
        truckId: truck.id,
        driverId: driver.id,
        direction: visitSeed.direction,
        status: visitSeed.status,
        appointmentStart: appt,
        appointmentEnd: new Date(appt.getTime() + 3600_000),
        etaAt: visitSeed.etaMin !== undefined ? minutes(visitSeed.etaMin) : null,
        arrivedAt,
        verifiedAt: onSite && visitSeed.status !== 'AT_GATE' ? at(2) : null,
        dockedAt: ['AT_DOCK', 'HANDLING'].includes(visitSeed.status) ? at(5) : null,
        handlingStartedAt: visitSeed.status === 'HANDLING' ? at(7) : null,
        dockLocationId: dockId,
        actualPlate: arrivedAt ? visitSeed.plate.replace(/[^A-Za-z0-9]/g, '').toUpperCase() : null,
      },
    });
    if (dockId) {
      const occupied = ['AT_DOCK', 'HANDLING'].includes(visitSeed.status);
      await prisma.locationOccupancy.create({
        data: { siteId: site.id, locationId: dockId, occupantType: 'TRUCK_VISIT', occupantId: visit.id, kind: occupied ? 'OCCUPIED' : 'RESERVED', singleOccupancy: true, occupiedAt: occupied ? at(5) : null, positionSource: occupied ? 'CONFIRMED_SCAN' : null },
      });
    }
  }
  await prisma.codeCounter.create({ data: { scope: `VIS-${ymd}`, value: visitSeq } });
  await prisma.codeCounter.create({ data: { scope: 'TRK', value: 2700 } });

  for (const equipment of EQUIPMENT) {
    const site = sites.get(equipment.site);
    if (!site) continue;
    await prisma.equipment.create({
      data: {
        siteId: site.id,
        code: equipment.code,
        equipmentType: 'FORKLIFT',
        model: equipment.model,
        status: equipment.status,
        chargerLocationId: site.locationIds.get(equipment.charger) ?? null,
        currentOperatorId: userIds.get(equipment.operator) ?? null,
        taskSummary: equipment.task ?? (equipment.status === 'CHARGING' ? 'Charging at bay' : equipment.status === 'AVAILABLE' ? 'Waiting for work' : null),
        telemetry: { batteryPct: equipment.battery, speedKmh: equipment.speed ?? 0, movesToday: equipment.moves },
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
