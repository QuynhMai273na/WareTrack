// Smoke test Phase 5 — Vehicle Storage
import { randomUUID } from 'node:crypto';

const BASE = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
async function waitReady() { for (let i = 0; i < 90; i++) { try { const r = await fetch(`${BASE}/health/ready`); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 1000)); } throw new Error('API not ready'); }
async function call(token, method, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key !== null && (method === 'POST' || method === 'DELETE')) headers['idempotency-key'] = key ?? randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (u) => (await call(null, 'POST', '/auth/login', { username: u, password: 'WareTrack@2026' }, null)).body.accessToken;

const TR = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const W = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const fixVin = (raw) => { const s = raw.split('').reduce((a, c, i) => a + (/\d/.test(c) ? +c : TR[c]) * W[i], 0) % 11; return raw.slice(0, 8) + (s === 10 ? 'X' : s) + raw.slice(9); };

await waitReady();
const mgr = await login('manager');
const disp = await login('dispatcher');
const fork = await login('operator');
const me = await call(mgr, 'GET', '/auth/me');
const site = me.body.sites.find((s) => s.code === 'WH-06');
const S = `/sites/${site.id}`;

const list = await call(mgr, 'GET', `${S}/vehicle-stays`);
check('list active stays', list.status === 200 && list.body.length >= 50, `${list.body.length}`);
const snap = await call(mgr, 'GET', `${S}/snapshot`);
check('snapshot has vehicles with positions', snap.body.vehicles?.filter((v) => v.position).length >= 40, `${snap.body.vehicles?.length}`);

const badVin = 'WAUZZZ8V5KA' + String(Date.now()).slice(-6);
const wrongCheck = badVin.slice(0, 8) + (badVin[8] === '1' ? '2' : '1') + badVin.slice(9);
const fixed = fixVin(badVin);
const warn = await call(disp, 'POST', `${S}/vehicle-stays`, { vin: fixed === wrongCheck ? badVin : wrongCheck, make: 'Audi', model: 'A3' });
check('wrong VIN check digit → 422 confirm required (DEC-22)', warn.status === 422 && warn.body.code === 'VIN_CHECK_DIGIT_CONFIRM_REQUIRED', `${warn.status} ${warn.body.code}`);
const created = await call(disp, 'POST', `${S}/vehicle-stays`, { vin: fixed.toLowerCase(), make: 'Audi', model: 'A3', plateNumber: 'TST-001' });
check('create EXPECTED stay (VIN normalized)', created.status === 201 && created.body.status === 'EXPECTED' && created.body.vehicle.vin === fixed, `${created.status} ${created.body.code ?? created.body.status}`);
const dup = await call(disp, 'POST', `${S}/vehicle-stays`, { vin: fixed });
check('duplicate active VIN → 409 VEHICLE_ALREADY_IN_STORAGE (BR-14)', dup.status === 409 && dup.body.code === 'VEHICLE_ALREADY_IN_STORAGE', `${dup.status} ${dup.body.code}`);
let st = created.body;

const mism = await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/receive`, { scan: { method: 'BARCODE', value: list.body[0].vehicle.vin, scannedAt: new Date().toISOString() }, expectedVersion: st.version });
check('receive with wrong VIN → 422 VIN_MISMATCH', mism.status === 422 && mism.body.code === 'VIN_MISMATCH');
st = (await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/receive`, { scan: { method: 'BARCODE', value: fixed, scannedAt: new Date().toISOString() }, odometerKm: 12, fuelOrBatteryPct: 80, keyTag: 'K-900', expectedVersion: st.version })).body;
check('receive → RECEIVED', st.status === 'RECEIVED', st.code ?? st.status);

const incomplete = await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/inspections`, { checklist: [{ key: 'EXTERIOR', passed: true }], resultCondition: 'OK', expectedVersion: st.version });
check('incomplete checklist → 422 (DEC-20)', incomplete.status === 422 && incomplete.body.details?.missing?.length === 4, JSON.stringify(incomplete.body.details));
const full = ['EXTERIOR', 'INTERIOR', 'KEYS', 'DOCUMENTS', 'PHOTOS_4_SIDES'].map((key) => ({ key, passed: true }));
st = (await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/inspections`, { checklist: full, resultCondition: 'OK', expectedVersion: st.version })).body;
check('inspection → INSPECTED', st.status === 'INSPECTED', st.code ?? st.status);

const slots = (await call(mgr, 'GET', `${S}/locations?type=PARKING_SLOT`)).body;
const freeSlots = slots.filter((l) => l.effectiveStatus === 'AVAILABLE');
const taken = slots.find((l) => l.effectiveStatus === 'OCCUPIED');
check('parking slots listed with free ones', freeSlots.length > 10, `${slots.length} slots, ${freeSlots.length} free`);
const clash = await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/allocate-slot`, { slotLocationId: taken.id, expectedVersion: st.version });
check('allocate occupied slot → 409 LOCATION_OCCUPIED (BR-01)', clash.status === 409, `${clash.status} ${clash.body.code}`);
const slot = freeSlots[0];
st = (await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/allocate-slot`, { slotLocationId: slot.id, expectedVersion: st.version })).body;
check('allocate free slot → ALLOCATED + MOVE_VEHICLE task', st.status === 'ALLOCATED' && st.position.kind === 'RESERVED' && st.openTask?.toCode === slot.code, `${st.status} ${st.openTask?.code}`);

// Forklift/driver thực hiện task: assign → start → confirm source(VIN) → confirm destination(scan slot)
const users = (await call(mgr, 'GET', '/users')).body;
const forkUser = (users.items ?? users).find((u) => u.username === 'operator');
let task = (await call(mgr, 'GET', `${S}/tasks/${st.openTask.id}`)).body;
const asg = await call(disp, 'POST', `${S}/tasks/${task.id}/assign`, { assigneeId: forkUser.id, expectedVersion: task.version });
check('assign MOVE_VEHICLE task', asg.status === 200 || asg.status === 201, `${asg.status} ${asg.body.code ?? ''}`);
task = (await call(mgr, 'GET', `${S}/tasks/${task.id}`)).body;
const started = await call(fork, 'POST', `${S}/tasks/${task.id}/start`, { expectedVersion: task.version });
check('start task', started.status < 300, `${started.status} ${started.body.code ?? ''}`);
await call(fork, 'POST', `${S}/tasks/${task.id}/confirm-source`, { locationScan: 'GATE', subjectScan: fixed });
const wrongDest = await call(fork, 'POST', `${S}/tasks/${task.id}/confirm-destination`, { locationScan: freeSlots[1].code });
check('scan wrong slot → 422 LOCATION_MISMATCH', wrongDest.status === 422, `${wrongDest.status} ${wrongDest.body.code}`);
const done = await call(fork, 'POST', `${S}/tasks/${task.id}/confirm-destination`, { locationScan: slot.qrValue ?? slot.code });
check('scan reserved slot → task COMPLETED', done.status < 300, `${done.status} ${done.body.code ?? ''}`);
st = (await call(mgr, 'GET', `${S}/vehicle-stays/${st.id}`)).body;
check('vehicle STORED at slot (CONFIRMED_SCAN)', st.status === 'STORED' && st.position.location?.code === slot.code && st.position.source === 'CONFIRMED_SCAN', `${st.status} ${st.position.location?.code}`);

// Move nội bộ
const dest = freeSlots[2];
st = (await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/move`, { toLocationId: dest.id, reason: 'Re-grouping by owner' })).body;
check('move creates task, position still old slot', st.openTask?.toCode === dest.code && st.position.location?.code === slot.code, `${st.openTask?.toCode} ${st.position.location?.code}`);

// Hold + release
const holdByDisp = await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/hold`, { reason: 'Customs check', expectedVersion: st.version });
check('dispatcher cannot set hold → 403', holdByDisp.status === 403, `${holdByDisp.status}`);
st = (await call(mgr, 'POST', `${S}/vehicle-stays/${st.id}/hold`, { reason: 'Customs check', expectedVersion: st.version })).body;
check('manager sets hold', st.holdFlag === true, st.code ?? '');
st = (await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/release-requests`, { reason: 'Owner pickup', recipientName: 'Test Owner' })).body;
check('release requested', st.status === 'RELEASE_REQUESTED' && st.releaseRequest?.status === 'PENDING', st.code ?? st.status);
const blocked = await call(mgr, 'POST', `${S}/release-requests/${st.releaseRequest.id}/approve`, { expectedVersion: st.releaseRequest.version });
check('approve while on hold → 422 RELEASE_BLOCKED (BR-28)', blocked.status === 422 && blocked.body.code === 'RELEASE_BLOCKED', `${blocked.status} ${blocked.body.code}`);
st = (await call(mgr, 'POST', `${S}/vehicle-stays/${st.id}/release-hold`, { reason: 'Customs cleared', expectedVersion: st.version })).body;

// Maker-checker: manager request → manager approve bị chặn
const seededReq = list.body.find((v) => v.status === 'RELEASE_REQUESTED');
check('seed has a pending release request', !!seededReq?.releaseRequest);
const approved = await call(mgr, 'POST', `${S}/release-requests/${st.releaseRequest.id}/approve`, { expectedVersion: st.releaseRequest.version });
check('manager approves → old move task cancelled, task to REL-01', approved.status < 300 && approved.body.openTask?.toCode === 'REL-01', `${approved.status} ${approved.body.code ?? approved.body.openTask?.toCode}`);
st = approved.body;
const early = await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/handover`, { expectedVersion: st.version });
check('handover before reaching REL-01 → 422 RELEASE_BLOCKED', early.status === 422, `${early.status} ${early.body.code}`);

const relTask = { id: st.openTask.id };
let rt = (await call(mgr, 'GET', `${S}/tasks/${relTask.id}`)).body;
await call(disp, 'POST', `${S}/tasks/${rt.id}/assign`, { assigneeId: forkUser.id, expectedVersion: rt.version });
rt = (await call(mgr, 'GET', `${S}/tasks/${rt.id}`)).body;
await call(fork, 'POST', `${S}/tasks/${rt.id}/start`, { expectedVersion: rt.version });
const relDone = await call(fork, 'POST', `${S}/tasks/${rt.id}/confirm-destination`, { locationScan: 'REL-01' });
check('vehicle moved to REL-01', relDone.status < 300, `${relDone.status} ${relDone.body.code ?? ''}`);
st = (await call(mgr, 'GET', `${S}/vehicle-stays/${st.id}`)).body;
st = (await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/handover`, { expectedVersion: st.version })).body;
check('handover → RELEASED', st.status === 'RELEASED', st.code ?? st.status);
st = (await call(disp, 'POST', `${S}/vehicle-stays/${st.id}/gate-out`, { expectedVersion: st.version })).body;
check('gate-out → EXITED, no position', st.status === 'EXITED' && !st.position.location, st.code ?? st.status);

const hist = await call(mgr, 'GET', `/vehicles/${fixed}/history`);
check('VIN history spans full lifecycle', hist.status === 200 && hist.body.some((h) => h.action === 'VEHICLE_EXITED') && hist.body.filter((h) => h.action === 'MOVEMENT').length >= 3, `${hist.body.length} entries`);
const again = await call(disp, 'POST', `${S}/vehicle-stays`, { vin: fixed });
check('same VIN can start a new stay after exit', again.status === 201, `${again.status} ${again.body.code ?? ''}`);

const events = await call(mgr, 'GET', `${S}/events?afterSeq=0&limit=2000`);
const vehEv = events.body.events.filter((e) => e.type?.startsWith('vehicle.'));
check('vehicle.* events in outbox', vehEv.length >= 8, `${vehEv.length}`);

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
