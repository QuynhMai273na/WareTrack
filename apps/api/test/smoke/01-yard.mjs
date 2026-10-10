// Smoke test API Phase 0–2
import { randomUUID } from 'node:crypto';

const BASE = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function waitReady() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/health/ready`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('API not ready');
}

async function call(token, method, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key !== null && (method === 'POST' || method === 'DELETE')) headers['idempotency-key'] = key ?? randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

async function login(username) {
  const r = await call(null, 'POST', '/auth/login', { username, password: 'WareTrack@2026' }, null);
  return r.body.accessToken;
}

await waitReady();
const mgr = await login('manager');
check('login manager', !!mgr);
const bad = await call(null, 'POST', '/auth/login', { username: 'manager', password: 'wrong-password' }, null);
check('wrong password → 401 INVALID_CREDENTIALS', bad.status === 401 && bad.body.code === 'INVALID_CREDENTIALS');

const me = await call(mgr, 'GET', '/auth/me');
check('me lists 6 sites', me.body.sites?.length === 6, `${me.body.sites?.length}`);
const wh1 = me.body.sites.find((s) => s.code === 'WH-01');
const vy1 = me.body.sites.find((s) => s.code === 'WH-06');
// Luồng walk-in chạy ở WH-04: theo video WH-01 không còn dock trống, WH-04 có Out 1 / Out 3 trống (dock xuất)
const wh4 = me.body.sites.find((s) => s.code === 'WH-04');
const snap4 = await call(mgr, 'GET', `/sites/${wh4.id}/snapshot`);

const sites = await call(mgr, 'GET', '/sites');
check('sites with fill summary', sites.body[0]?.fill?.docksTotal >= 1, JSON.stringify(sites.body[0]?.fill));

const snap = await call(mgr, 'GET', `/sites/${wh1.id}/snapshot`);
check('snapshot WH-01', snap.status === 200 && snap.body.docks.length === 2 && snap.body.trucks.length >= 2, `docks=${snap.body.docks?.length} trucks=${snap.body.trucks?.length} forklifts=${snap.body.forklifts?.length}`);
check('snapshot KPIs present', snap.body.kpis?.some((k) => k.key === 'TRUCKS_ON_SITE'), JSON.stringify(snap.body.kpis?.find((k) => k.key === 'TRUCKS_ON_SITE')));

const layout = await call(mgr, 'GET', `/sites/${wh1.id}/layout`);
check('published layout', layout.status === 200 && layout.body.objects.length > 20, `${layout.body.objects?.length} objects`);

const viewer = await login('viewer');
const forbidden = await call(viewer, 'GET', `/sites/${vy1.id}/snapshot`);
check('viewer on WH-06 → 404 (BR-33)', forbidden.status === 404);
const noPerm = await call(viewer, 'POST', `/sites/${wh1.id}/visits/walk-in`, { direction: 'INBOUND', actualPlate: 'X1', reason: 'test', newTruck: { plateNumber: 'ZZ-1', truckType: 'BOX' } });
check('viewer walk-in → 403', noPerm.status === 403);

// Walk-in → verify → assign dock → arrive at dock → abort → gate-out
const plate = `T${Date.now().toString().slice(-6)}`;
const missingKey = await call(mgr, 'POST', `/sites/${wh4.id}/visits/walk-in`, {}, null);
check('missing Idempotency-Key → 428', missingKey.status === 428);
const walkKey = randomUUID();
const walk = await call(mgr, 'POST', `/sites/${wh4.id}/visits/walk-in`, { direction: 'OUTBOUND', actualPlate: plate, reason: 'No appointment, urgent delivery', newTruck: { plateNumber: plate, truckType: 'BOX' } }, walkKey);
check('walk-in → AT_GATE', walk.status === 201 && walk.body.status === 'AT_GATE', `${walk.status} ${walk.body.code ?? walk.body.status}`);
const replay = await call(mgr, 'POST', `/sites/${wh4.id}/visits/walk-in`, { direction: 'OUTBOUND', actualPlate: plate, reason: 'No appointment, urgent delivery', newTruck: { plateNumber: plate, truckType: 'BOX' } }, walkKey);
check('idempotent replay returns same visit', replay.body.id === walk.body.id && replay.headers.get('idempotent-replayed') === 'true');
const reused = await call(mgr, 'POST', `/sites/${wh4.id}/visits/walk-in`, { direction: 'INBOUND', actualPlate: plate, reason: 'different body', newTruck: { plateNumber: plate, truckType: 'BOX' } }, walkKey);
check('same key + different body → 422 IDEMPOTENCY_KEY_REUSED', reused.status === 422 && reused.body.code === 'IDEMPOTENCY_KEY_REUSED');

const v = walk.body;
const badVerify = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${v.id}/verify`, { documentChecks: [{ key: 'PLATE_MATCH', passed: true }], expectedVersion: v.version });
check('verify missing docs → 422 GATE_VERIFICATION_FAILED', badVerify.status === 422 && badVerify.body.code === 'GATE_VERIFICATION_FAILED', JSON.stringify(badVerify.body.details));
const verified = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${v.id}/verify`, {
  documentChecks: ['PLATE_MATCH', 'DRIVER_ID', 'TRANSPORT_ORDER'].map((key) => ({ key, passed: true })), expectedVersion: v.version,
});
check('verify → WAITING', verified.body.status === 'WAITING', verified.body.code);

// Race: hai dispatcher cùng gán Out 3 cho 2 visit khác nhau (CT-02)
const walk2 = await call(mgr, 'POST', `/sites/${wh4.id}/visits/walk-in`, { direction: 'OUTBOUND', actualPlate: plate + 'B', reason: 'Second truck for race test', newTruck: { plateNumber: plate + 'B', truckType: 'BOX' } });
const ver2 = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${walk2.body.id}/verify`, { documentChecks: ['PLATE_MATCH', 'DRIVER_ID', 'TRANSPORT_ORDER'].map((key) => ({ key, passed: true })), expectedVersion: walk2.body.version });
const bay2 = snap4.body.docks.find((d) => d.code === 'Out 3');
const [a, b] = await Promise.all([
  call(mgr, 'POST', `/sites/${wh4.id}/visits/${v.id}/assign-dock`, { dockLocationId: bay2.locationId, expectedVersion: verified.body.version }),
  call(mgr, 'POST', `/sites/${wh4.id}/visits/${ver2.body.id}/assign-dock`, { dockLocationId: bay2.locationId, expectedVersion: ver2.body.version }),
]);
const statuses = [a.status, b.status].sort();
check('concurrent assign same dock → exactly one 200, one 409 LOCATION_OCCUPIED', statuses[0] === 200 && statuses[1] === 409 && [a, b].some((r) => r.body.code === 'LOCATION_OCCUPIED'), `${a.status}/${b.status} ${a.body.code ?? ''}${b.body.code ?? ''}`);
const winner = a.status === 200 ? a.body : b.body;

const mismatch = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${winner.id}/arrive-at-dock`, { scan: { method: 'QR', value: 'Out 1', scannedAt: new Date().toISOString() }, expectedVersion: winner.version });
check('scan wrong dock → 422 DOCK_MISMATCH', mismatch.status === 422 && mismatch.body.code === 'DOCK_MISMATCH');
const docked = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${winner.id}/arrive-at-dock`, { scan: { method: 'QR', value: 'Out 3', scannedAt: new Date().toISOString() }, expectedVersion: winner.version });
check('arrive at dock → AT_DOCK', docked.body.status === 'AT_DOCK', docked.body.code);
const stale = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${winner.id}/abort`, { reason: 'stale version test', expectedVersion: winner.version });
check('stale expectedVersion → 409 CONCURRENT_MODIFICATION', stale.status === 409 && stale.body.code === 'CONCURRENT_MODIFICATION');
const gateEarly = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${winner.id}/gate-out`, { expectedVersion: docked.body.version });
check('gate-out before ready → 409 INVALID_STATE_TRANSITION', gateEarly.status === 409 && gateEarly.body.code === 'INVALID_STATE_TRANSITION');
const aborted = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${winner.id}/abort`, { reason: 'Goods refused by QA', expectedVersion: docked.body.version });
check('abort → READY_TO_LEAVE, dock released', aborted.body.status === 'READY_TO_LEAVE');
const out = await call(mgr, 'POST', `/sites/${wh4.id}/visits/${winner.id}/gate-out`, { expectedVersion: aborted.body.version });
check('gate-out → EXITED', out.body.status === 'EXITED', out.body.code);
check('timeline has audit entries', out.body.timeline?.length >= 5, `${out.body.timeline?.length}`);

// Truck đang có visit active → walk-in lần nữa bị chặn (BR-13)
const loser = a.status === 200 ? ver2.body : verified.body;
const dup = await call(mgr, 'POST', `/sites/${wh4.id}/visits/walk-in`, { truckId: loser.truck.id, direction: 'OUTBOUND', actualPlate: loser.truck.plateNumber, reason: 'duplicate check-in' });
check('double check-in → 409 VISIT_ALREADY_ACTIVE', dup.status === 409 && dup.body.code === 'VISIT_ALREADY_ACTIVE', `${dup.status} ${dup.body.code}`);

await new Promise((r) => setTimeout(r, 2500));
const ev = await call(mgr, 'GET', `/sites/${wh4.id}/events?afterSeq=0`);
check('events published with contiguous siteSeq', ev.body.events?.length > 0 && ev.body.events.every((e, i) => e.siteSeq === i + 1), `count=${ev.body.events?.length} latest=${ev.body.latestSeq}`);
check('event types include truck.arrived & dock.status_changed', ['truck.arrived', 'dock.status_changed', 'truck.departed'].every((t) => ev.body.events.some((e) => e.type === t)));

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
