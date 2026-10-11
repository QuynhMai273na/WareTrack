// Smoke test Phase 3 — Inventory
import { randomUUID } from 'node:crypto';

const BASE = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
async function waitReady() { for (let attempt = 0; attempt < 90; attempt++) { try { const response = await fetch(`${BASE}/health/ready`); if (response.ok) return; } catch {} await new Promise((resolve) => setTimeout(resolve, 1000)); } throw new Error('API not ready'); }
async function call(token, method, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key !== null && (method === 'POST' || method === 'DELETE')) headers['idempotency-key'] = key ?? randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (username) => (await call(null, 'POST', '/auth/login', { username, password: 'WareTrack@2026' }, null)).body.accessToken;

await waitReady();
const mgr = await login('manager');
const sup = await login('supervisor');
const inv = await login('inventory');
const op = await login('operator');
const me = await call(mgr, 'GET', '/auth/me');
const wh1 = me.body.sites.find((site) => site.code === 'WH-01');
const sitePath = `/sites/${wh1.id}`;

const snap = await call(mgr, 'GET', `${sitePath}/snapshot`);
check('snapshot has pallets', snap.body.pallets?.length > 10, `${snap.body.pallets?.length}`);
const stockKpi = snap.body.kpis.find((kpi) => kpi.key === 'STOCK_ON_HAND_PALLETS');
check('KPI stock on hand (pallets / positions)', stockKpi && stockKpi.value > 0 && stockKpi.total > 0, JSON.stringify(stockKpi));

const avail = await call(mgr, 'GET', `${sitePath}/inventory/availability`);
check('availability per SKU', avail.body.length >= 4, avail.body.map((availability) => `${availability.sku.code}:${availability.available}${availability.lowStock ? '(LOW)' : ''}`).join(' '));

const pallets = await call(mgr, 'GET', `${sitePath}/pallets`);
const inStock = pallets.body.find((pallet) => pallet.lifecycle === 'IN_STOCK' && pallet.locationCode?.startsWith('R-'));
const locs = await call(mgr, 'GET', `${sitePath}/locations?type=STORAGE`);
const empty = locs.body.find((location) => location.unitsUsed === 0);
let full = locs.body.find((location) => location.unitsUsed >= location.capacityUnits && location.code !== inStock.locationCode);
if (!full) {
  // Seed theo video không có ô đầy sẵn → lấp đầy ô còn trống đúng 1 chỗ bằng một pallet khác
  const tight = locs.body.find((location) => location.unitsUsed > 0 && location.capacityUnits - location.unitsUsed === 1 && location.code !== inStock.locationCode);
  const filler = pallets.body.find((pallet) => pallet.lifecycle === 'IN_STOCK' && pallet.locationCode?.startsWith('A-'));
  const fill = await call(mgr, 'POST', `${sitePath}/pallets/${filler.id}/move`, { toLocationId: tight.id, reason: 'fill for capacity test', expectedVersion: filler.version });
  check('fill a location to capacity', fill.status === 200, `${fill.status} ${fill.body.code ?? ''}`);
  full = tight;
}
const detail = await call(mgr, 'GET', `${sitePath}/pallets/${inStock.id}`);

const tooFull = await call(op, 'POST', `${sitePath}/pallets/${inStock.id}/move`, { toLocationId: full.id, reason: 'test capacity', expectedVersion: detail.body.version });
check('move into full rack → 422 LOCATION_CAPACITY_EXCEEDED (BR-19)', tooFull.status === 422 && tooFull.body.code === 'LOCATION_CAPACITY_EXCEEDED', `${tooFull.status} ${tooFull.body.code}`);
const moved = await call(op, 'POST', `${sitePath}/pallets/${inStock.id}/move`, { toLocationId: empty.id, reason: 'Re-slotting', scanDestination: empty.qrValue, expectedVersion: detail.body.version });
check('operator moves pallet to empty rack (scan)', moved.status === 200 && moved.body.location.code === empty.code && moved.body.position.source === 'CONFIRMED_SCAN', `${moved.status} ${moved.body.code ?? moved.body.location?.code}`);
const hist = await call(mgr, 'GET', `${sitePath}/pallets/${inStock.id}/history`);
check('pallet history has MOVE ledger + movement', hist.body.some((historyEntry) => historyEntry.kind === 'MOVEMENT' && historyEntry.description === 'Re-slotting') && hist.body.some((historyEntry) => historyEntry.description.startsWith('MOVE')));

// Adjustment: ngưỡng DEC-14 + maker-checker
const boxPallet = (await call(mgr, 'GET', `${sitePath}/inventory/balances?q=PKG-BOX-M`)).body.find((balance) => balance.handlingUnit && Number(balance.qtyOnHand) >= 150 && balance.stockStatus === 'AVAILABLE');
const bal = { balanceId: boxPallet.id };
const small = await call(sup, 'POST', `${sitePath}/inventory/adjustments`, { balanceId: bal.balanceId, qtyDelta: '-1', reasonCode: 'DAMAGE', note: 'Broken unit' });
check('small adjustment does not need manager', small.status === 201 && small.body.requiresManager === false, `${small.status} ${small.body.code ?? ''}`);
const self = await call(sup, 'POST', `${sitePath}/inventory/adjustments/${small.body.id}/approve`, { expectedVersion: small.body.version });
check('requester cannot approve own adjustment → 403 MAKER_CHECKER_VIOLATION', self.status === 403 && self.body.code === 'MAKER_CHECKER_VIOLATION');
const approved = await call(mgr, 'POST', `${sitePath}/inventory/adjustments/${small.body.id}/approve`, { expectedVersion: small.body.version });
check('another approver (manager) approves → APPLIED', approved.body?.status === 'APPLIED', `${approved.status} ${approved.body?.code ?? approved.body?.status}`);
const big = await call(inv, 'POST', `${sitePath}/inventory/adjustments`, { balanceId: bal.balanceId, qtyDelta: '-20', reasonCode: 'LOSS', note: 'Missing' });
check('large adjustment requires manager (DEC-14)', big.body.requiresManager === true);
const supBig = await call(sup, 'POST', `${sitePath}/inventory/adjustments/${big.body.id}/approve`, { expectedVersion: big.body.version });
check('supervisor cannot approve above threshold → 403', supBig.status === 403, `${supBig.status} ${supBig.body.title}`);
const mgrBig = await call(mgr, 'POST', `${sitePath}/inventory/adjustments/${big.body.id}/approve`, { expectedVersion: big.body.version });
check('manager approves large adjustment', mgrBig.body?.status === 'APPLIED', `${mgrBig.status} ${mgrBig.body?.code ?? ''}`);
const tooMuch = await call(inv, 'POST', `${sitePath}/inventory/adjustments`, { balanceId: bal.balanceId, qtyDelta: '-100000', reasonCode: 'LOSS' });
const neg = await call(mgr, 'POST', `${sitePath}/inventory/adjustments/${tooMuch.body.id}/approve`, { expectedVersion: tooMuch.body.version });
check('adjustment making stock negative → 422 NEGATIVE_STOCK', neg.status === 422 && neg.body.code === 'NEGATIVE_STOCK');

// Ledger + reversal
const ledger = await call(mgr, 'GET', `${sitePath}/inventory/transactions?huId=${boxPallet.handlingUnit.id}`);
const adjTx = ledger.body.find((transaction) => transaction.txType === 'ADJUSTMENT_OUT');
const rev = await call(mgr, 'POST', `${sitePath}/inventory/transactions/${adjTx.id}/reverse`, { reason: 'Found the missing unit' });
check('reverse adjustment → compensating tx', rev.status === 201 && rev.body.txType === 'ADJUSTMENT_IN', `${rev.status} ${rev.body.txType ?? rev.body.code}`);
const rev2 = await call(mgr, 'POST', `${sitePath}/inventory/transactions/${adjTx.id}/reverse`, { reason: 'again' });
check('reverse twice → 409 ALREADY_REVERSED', rev2.status === 409 && rev2.body.code === 'ALREADY_REVERSED');

// Status change → QUARANTINE, rồi release cần Site Manager
const sc = await call(sup, 'POST', `${sitePath}/inventory/status-changes`, { balanceId: bal.balanceId, quantity: '5', toStatus: 'QUARANTINE', reason: 'Suspected damage' });
check('status change to QUARANTINE', sc.status === 200 && sc.body.some((changedBalance) => changedBalance.stockStatus === 'QUARANTINE'), `${sc.status} ${sc.body.code ?? ''}`);
const qBal = (await call(mgr, 'GET', `${sitePath}/inventory/balances?huId=${boxPallet.handlingUnit.id}&status=QUARANTINE`)).body[0];
const rel = await call(sup, 'POST', `${sitePath}/inventory/status-changes`, { balanceId: qBal.id, quantity: '5', toStatus: 'AVAILABLE', reason: 'OK after inspection' });
check('supervisor releasing quarantine → 403 (needs inventory.status.release)', rel.status === 403);

// Stock count blind (UC-16-AC1) + freeze
const cnt = await call(inv, 'POST', `${sitePath}/stock-counts`, { scope: { locationIds: [empty.id] }, blind: true, freeze: true });
await call(inv, 'POST', `${sitePath}/stock-counts/${cnt.body.id}/start`, {});
const opView = await call(op, 'GET', `${sitePath}/stock-counts/${cnt.body.id}`);
check('blind count hides systemQty from operator', opView.body.lines?.length > 0 && opView.body.lines.every((countLine) => countLine.systemQty === null), `${opView.status} lines=${opView.body.lines?.length}`);
const frozenMove = await call(op, 'POST', `${sitePath}/pallets/${inStock.id}/move`, { toLocationId: locs.body.find((location) => location.unitsUsed === 0 && location.id !== empty.id).id, reason: 'during count', expectedVersion: moved.body.version + 99 });
const p2 = await call(mgr, 'GET', `${sitePath}/pallets/${inStock.id}`);
const frozen = await call(op, 'POST', `${sitePath}/pallets/${inStock.id}/move`, { toLocationId: locs.body.find((location) => location.unitsUsed === 0 && location.id !== empty.id).id, reason: 'during count', expectedVersion: p2.body.version });
check('move out of frozen location → 422 LOCATION_FROZEN', frozen.status === 422 && frozen.body.code === 'LOCATION_FROZEN', `${frozen.status} ${frozen.body.code}`);
check('stale pallet version → 409', frozenMove.status === 409);
const line = opView.body.lines[0];
await call(op, 'PUT', `${sitePath}/stock-counts/${cnt.body.id}/lines/${line.id}`, { countedQty: '3' });
await call(inv, 'POST', `${sitePath}/stock-counts/${cnt.body.id}/close`, {});
const done = await call(inv, 'POST', `${sitePath}/stock-counts/${cnt.body.id}/complete`, { createAdjustments: true });
check('complete count creates variance adjustment + unfreezes', done.body.status === 'COMPLETED' && done.body.adjustmentsCreated >= 1, `${done.status} ${done.body.adjustmentsCreated}`);

await new Promise((resolve) => setTimeout(resolve, 2500));
const ev = await call(mgr, 'GET', `${sitePath}/events?afterSeq=0&limit=1000`);
check('inventory.updated + pallet.moved events', ['inventory.updated', 'pallet.moved'].every((eventType) => ev.body.events.some((event) => event.type === eventType)));

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
