// Smoke test Phase 6 — equipment status/telemetry, exceptions, notifications
import { randomUUID } from 'node:crypto';

const BASE = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitReady() { for (let attempt = 0; attempt < 90; attempt++) { try { const response = await fetch(`${BASE}/health/ready`); if (response.ok) return; } catch {} await sleep(1000); } throw new Error('API not ready'); }
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
const fork = await login('forklift');
const op = await login('operator');
const me = await call(mgr, 'GET', '/auth/me');
const wh1 = me.body.sites.find((site) => site.code === 'WH-01');
const sitePath = `/sites/${wh1.id}`;
await call(mgr, 'POST', '/notifications/read-all', {});
await call(sup, 'POST', '/notifications/read-all', {});

const eq = (await call(mgr, 'GET', `${sitePath}/equipment`)).body;
let forklift = eq.find((equipment) => equipment.status === 'AVAILABLE');
check('found AVAILABLE forklift', !!forklift, forklift?.code);
let result = await call(fork, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'CHARGING', expectedVersion: forklift.version });
check('operator sends forklift to charging', result.status === 200 && result.body.status === 'CHARGING', `${result.status} ${result.body.code ?? result.body.status}`);
forklift = result.body;
result = await call(fork, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'OFFLINE', expectedVersion: forklift.version });
check('CHARGING → OFFLINE rejected (state machine 9.7)', result.status === 409 && result.body.code === 'INVALID_STATE_TRANSITION', `${result.status} ${result.body.code}`);
result = await call(fork, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: forklift.version - 1 });
check('stale version → 409 CONCURRENT_MODIFICATION', result.status === 409, `${result.status} ${result.body.code}`);
result = await call(fork, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: forklift.version });
forklift = result.body;
check('charged → AVAILABLE', forklift.status === 'AVAILABLE');
result = await call(fork, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'MAINTENANCE', reason: 'Hydraulic leak', expectedVersion: forklift.version });
check('forklift operator cannot start maintenance → 403', result.status === 403, `${result.status}`);
result = await call(sup, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'MAINTENANCE', reason: 'Hydraulic leak', expectedVersion: forklift.version });
check('supervisor starts maintenance', result.status === 200 && result.body.status === 'MAINTENANCE', `${result.status} ${result.body.code ?? result.body.status}`);
forklift = result.body;

const busy = eq.find((equipment) => equipment.id !== forklift.id && (equipment.batteryPct ?? 0) >= 20);
result = await call(fork, 'POST', `${sitePath}/equipment/${busy.id}/telemetry`, { batteryPct: 14 });
check('manual telemetry battery 14%', result.status === 200 && result.body.batteryPct === 14, `${result.status} ${result.body.batteryPct}`);

const exc = await call(op, 'POST', `${sitePath}/exceptions`, { caseType: 'SAFETY', severity: 'CRITICAL', description: 'Spill near dock 3 — area cordoned' });
check('operator reports CRITICAL exception', exc.status === 201 && exc.body.status === 'OPEN', `${exc.status} ${exc.body.code}`);

await sleep(2500);
let unread = (await call(mgr, 'GET', '/notifications?unread=true')).body;
const cats = unread.items.map((notification) => notification.category + ':' + notification.title);
check('manager got maintenance notification', cats.some((categoryTitle) => categoryTitle.startsWith('EQUIPMENT') && categoryTitle.includes('Maintenance')), cats.join(' | '));
check('manager got low battery notification', cats.some((categoryTitle) => categoryTitle.includes('Battery 14%')));
check('manager got CRITICAL exception notification (UC-23-AC2)', unread.items.some((notification) => notification.category === 'EXCEPTION' && notification.severity === 'CRITICAL' && notification.link?.includes('/exceptions?case=')));
const forkN = (await call(fork, 'GET', '/notifications?unread=true')).body;
check('forklift operator gets none of these (no permission)', forkN.items.length === 0, `${forkN.items.length}`);

const first = unread.items[0];
result = await call(mgr, 'POST', `/notifications/${first.id}/read`, {});
check('mark one read → 204', result.status === 204);
const after = (await call(mgr, 'GET', '/notifications')).body;
check('unread count decremented', after.unreadCount === unread.unreadCount - 1, `${unread.unreadCount} → ${after.unreadCount}`);
result = await call(sup, 'POST', `/notifications/${first.id}/read`, {});
check("cannot read someone else's notification → 404", result.status === 404, `${result.status}`);
await call(mgr, 'POST', '/notifications/read-all', { siteId: wh1.id });
check('read-all → 0 unread', (await call(mgr, 'GET', '/notifications')).body.unreadCount === 0);

// Exception lifecycle
let exceptionCase = exc.body;
result = await call(sup, 'POST', `${sitePath}/exceptions/${exceptionCase.id}/assign`, { expectedVersion: exceptionCase.version });
check('supervisor takes exception → IN_REVIEW', result.body.status === 'IN_REVIEW' && result.body.assignee, `${result.body.status} ${result.body.assignee}`);
exceptionCase = result.body;
result = await call(sup, 'POST', `${sitePath}/exceptions/${exceptionCase.id}/resolve`, { resolutionCode: 'CLEANED', note: 'Spill kit used', expectedVersion: exceptionCase.version });
check('resolve exception', result.body.status === 'RESOLVED' && result.body.resolutionCode === 'CLEANED');
await sleep(1500);
const dup = (await call(mgr, 'GET', '/notifications')).body;
check('status changes of exception do not re-notify', !dup.items.some((notification) => !notification.readAt && notification.category === 'EXCEPTION'), `${dup.unreadCount}`);

result = await call(sup, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: forklift.version });
check('maintenance done → AVAILABLE', result.body.status === 'AVAILABLE');

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
