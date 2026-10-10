// Kịch bản demo chạy qua API thật (sau `pnpm db:seed` và khi API đang chạy): tạo đơn xuất/nhập,
// pick → staging → load một phần, nhận hàng một phần — để dashboard có "Loading 2/6", "Unloading 2/6" như video.
// Chạy: node apps/api/prisma/seed/scenario.mjs   (API_URL mặc định http://localhost:3000/api/v1)
import { randomUUID } from 'node:crypto';

const BASE = process.env.API_URL ?? 'http://localhost:3000/api/v1';
const PASSWORD = 'WareTrack@2026';

async function call(token, method, path, body) {
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (method === 'POST' || method === 'DELETE') headers['idempotency-key'] = randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.code ?? ''} ${json?.title ?? text}`);
  return json;
}
const login = async (u) => {
  const res = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: PASSWORD }) });
  return (await res.json()).accessToken;
};
const now = () => new Date().toISOString();

async function main() {
  const mgr = await login('manager');
  const fork = await login('forklift');
  const me = await call(mgr, 'GET', '/auth/me');
  const site = (code) => me.sites.find((s) => s.code === code);
  const skus = await call(mgr, 'GET', '/skus');
  const sku = (code) => skus.find((s) => s.code === code);
  const partners = (await call(mgr, 'GET', '/partners')).items;
  const partner = (name) => partners.find((p) => p.name === name)?.id;
  const users = (await call(mgr, 'GET', '/users')).items;
  const forkliftUser = users.find((u) => u.username === 'forklift');

  // ── WH-01: đơn xuất cho TRK-2051 (đang ở BAY-1) → pick → load 2 pallet ──
  {
    const S = `/sites/${site('WH-01').id}`;
    const visits = await call(mgr, 'GET', `${S}/visits?status=HANDLING`);
    const visit = visits.find((v) => v.truck.code === 'TRK-2051');
    const order = await call(mgr, 'POST', `${S}/outbound-orders`, {
      customerId: partner('Oakridge Market'),
      destinationText: 'Philadelphia, PA',
      plannedDispatchAt: new Date(Date.now() + 40 * 60_000).toISOString(),
      requestedDeliveryAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
      truckVisitId: visit.id,
      lines: [
        { skuId: sku('SKU-BOX-M').id, orderedQty: '320' },
        { skuId: sku('SKU-HELMET').id, orderedQty: '90' },
        { skuId: sku('SKU-LED-6060').id, orderedQty: '60' },
      ],
    });
    await call(mgr, 'POST', `${S}/outbound-orders/${order.id}/confirm`, { autoAllocate: true, expectedVersion: order.version });
    const equipment = await call(mgr, 'GET', `${S}/equipment`);
    const fl = equipment.find((e) => e.code === 'FL-02');
    const picks = await call(mgr, 'GET', `${S}/tasks?type=PICK&sourceId=${order.id}`);
    for (const t of picks) {
      let task = await call(mgr, 'POST', `${S}/tasks/${t.id}/assign`, { assigneeId: forkliftUser.id, equipmentId: fl.id, expectedVersion: t.version });
      task = await call(fork, 'POST', `${S}/tasks/${t.id}/start`, { expectedVersion: task.version });
      await call(fork, 'POST', `${S}/tasks/${t.id}/confirm-source`, { locationScan: task.from.qrValue, subjectScan: task.subject.code });
      await call(fork, 'POST', `${S}/tasks/${t.id}/confirm-destination`, { locationScan: task.to.qrValue });
    }
    let shipment = await call(mgr, 'GET', `${S}/shipments/${(await call(mgr, 'GET', `${S}/outbound-orders/${order.id}`)).shipment.id}`);
    shipment = await call(mgr, 'POST', `${S}/shipments/${shipment.id}/loading/start`, { expectedVersion: shipment.version });
    for (const item of shipment.items.slice(0, 2)) {
      await call(fork, 'POST', `${S}/shipments/${shipment.id}/load-scans`, {
        huScan: { method: 'BARCODE', value: item.code, scannedAt: now() },
        dockScan: { method: 'QR', value: 'WT:LOC:WH-01:BAY-1', scannedAt: now() },
      });
    }
    const final = await call(mgr, 'GET', `${S}/shipments/${shipment.id}`);
    console.log(`WH-01 ${final.code}: ${final.status} ${final.progress.done}/${final.progress.total} (picks: ${picks.length})`);
  }

  // ── WH-04: đơn nhập cho TRK-2205 (đang ở IN-1) → nhận 2/6 pallet ──
  {
    const S = `/sites/${site('WH-04').id}`;
    const visit = (await call(mgr, 'GET', `${S}/visits?status=HANDLING`)).find((v) => v.truck.code === 'TRK-2205');
    const order = await call(mgr, 'POST', `${S}/inbound-orders`, {
      supplierId: partner('Brightline Electronics'),
      truckVisitId: visit.id,
      lines: [
        { skuId: sku('SKU-LED-6060').id, expectedQty: '192', expectedHuCount: 4, expectedLotNumber: 'L2026-10-A' },
        { skuId: sku('SKU-HELMET').id, expectedQty: '120', expectedHuCount: 2 },
      ],
    });
    const receipt = await call(mgr, 'POST', `${S}/receipts`, { inboundOrderId: order.id });
    await call(mgr, 'POST', `${S}/receipts/${receipt.id}/lines`, { skuId: sku('SKU-LED-6060').id, lotNumber: 'L2026-10-A', quantity: '48' });
    await call(mgr, 'POST', `${S}/receipts/${receipt.id}/lines`, { skuId: sku('SKU-LED-6060').id, lotNumber: 'L2026-10-A', quantity: '48' });
    const r = await call(mgr, 'GET', `${S}/receipts/${receipt.id}`);
    console.log(`WH-04 ${r.code}: ${r.progress.receivedHu}/${r.progress.expectedHu}`);
  }

  // ── WH-02: đơn xuất cho TRK-2127 (BAY-3) đã xếp xong và đã dispatch → KPI on-time dispatch ──
  {
    const S = `/sites/${site('WH-02').id}`;
    const visit = (await call(mgr, 'GET', `${S}/visits?status=HANDLING`)).find((v) => v.truck.code === 'TRK-2127');
    const order = await call(mgr, 'POST', `${S}/outbound-orders`, {
      customerId: partner('Helix Retail'),
      destinationText: 'Hartford, CT',
      plannedDispatchAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      truckVisitId: visit.id,
      lines: [{ skuId: sku('SKU-CHAIR-OFF').id, orderedQty: '20' }],
    });
    await call(mgr, 'POST', `${S}/outbound-orders/${order.id}/confirm`, { autoAllocate: true, expectedVersion: order.version });
    const sup = await login('supervisor');
    const supId = users.find((u) => u.username === 'supervisor').id;
    for (const t of await call(mgr, 'GET', `${S}/tasks?type=PICK&sourceId=${order.id}`)) {
      let task = await call(mgr, 'POST', `${S}/tasks/${t.id}/assign`, { assigneeId: supId, expectedVersion: t.version });
      task = await call(sup, 'POST', `${S}/tasks/${t.id}/start`, { expectedVersion: task.version });
      await call(sup, 'POST', `${S}/tasks/${t.id}/confirm-destination`, { locationScan: task.to.qrValue });
    }
    const shipmentId = (await call(mgr, 'GET', `${S}/outbound-orders/${order.id}`)).shipment.id;
    let shipment = await call(mgr, 'GET', `${S}/shipments/${shipmentId}`);
    shipment = await call(mgr, 'POST', `${S}/shipments/${shipmentId}/loading/start`, { expectedVersion: shipment.version });
    for (const item of shipment.items) {
      await call(sup, 'POST', `${S}/shipments/${shipmentId}/load-scans`, { huScan: { method: 'BARCODE', value: item.code, scannedAt: now() }, dockScan: { method: 'QR', value: 'WT:LOC:WH-02:BAY-3', scannedAt: now() } });
    }
    shipment = await call(mgr, 'GET', `${S}/shipments/${shipmentId}`);
    shipment = await call(mgr, 'POST', `${S}/shipments/${shipmentId}/dispatch`, { sealNumber: 'SL-100233', expectedVersion: shipment.version });
    console.log(`WH-02 ${shipment.code}: ${shipment.status}`);
  }
  console.log('Scenario done.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
