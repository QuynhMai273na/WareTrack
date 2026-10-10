// Smoke test Phase 6 — equipment status/telemetry, exceptions, notifications
import { randomUUID } from 'node:crypto';

const BASE = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitReady() { for (let i = 0; i < 90; i++) { try { const r = await fetch(`${BASE}/health/ready`); if (r.ok) return; } catch {} await sleep(1000); } throw new Error('API not ready'); }
async function call(token, method, path, body, key) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (key !== null && (method === 'POST' || method === 'DELETE')) headers['idempotency-key'] = key ?? randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (u) => (await call(null, 'POST', '/auth/login', { username: u, password: 'WareTrack@2026' }, null)).body.accessToken;

await waitReady();
const mgr = await login('manager');
const sup = await login('supervisor');
const fork = await login('forklift');
const op = await login('operator');
const me = await call(mgr, 'GET', '/auth/me');
const wh1 = me.body.sites.find((s) => s.code === 'WH-01');
const S = `/sites/${wh1.id}`;
await call(mgr, 'POST', '/notifications/read-all', {});
await call(sup, 'POST', '/notifications/read-all', {});

const eq = (await call(mgr, 'GET', `${S}/equipment`)).body;
let f = eq.find((x) => x.status === 'AVAILABLE');
check('found AVAILABLE forklift', !!f, f?.code);
let r = await call(fork, 'POST', `${S}/equipment/${f.id}/status`, { toStatus: 'CHARGING', expectedVersion: f.version });
check('operator sends forklift to charging', r.status === 200 && r.body.status === 'CHARGING', `${r.status} ${r.body.code ?? r.body.status}`);
f = r.body;
r = await call(fork, 'POST', `${S}/equipment/${f.id}/status`, { toStatus: 'OFFLINE', expectedVersion: f.version });
check('CHARGING → OFFLINE rejected (state machine 9.7)', r.status === 409 && r.body.code === 'INVALID_STATE_TRANSITION', `${r.status} ${r.body.code}`);
r = await call(fork, 'POST', `${S}/equipment/${f.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: f.version - 1 });
check('stale version → 409 CONCURRENT_MODIFICATION', r.status === 409, `${r.status} ${r.body.code}`);
r = await call(fork, 'POST', `${S}/equipment/${f.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: f.version });
f = r.body;
check('charged → AVAILABLE', f.status === 'AVAILABLE');
r = await call(fork, 'POST', `${S}/equipment/${f.id}/status`, { toStatus: 'MAINTENANCE', reason: 'Hydraulic leak', expectedVersion: f.version });
check('forklift operator cannot start maintenance → 403', r.status === 403, `${r.status}`);
r = await call(sup, 'POST', `${S}/equipment/${f.id}/status`, { toStatus: 'MAINTENANCE', reason: 'Hydraulic leak', expectedVersion: f.version });
check('supervisor starts maintenance', r.status === 200 && r.body.status === 'MAINTENANCE', `${r.status} ${r.body.code ?? r.body.status}`);
f = r.body;

const busy = eq.find((x) => x.id !== f.id && (x.batteryPct ?? 0) >= 20);
r = await call(fork, 'POST', `${S}/equipment/${busy.id}/telemetry`, { batteryPct: 14 });
check('manual telemetry battery 14%', r.status === 200 && r.body.batteryPct === 14, `${r.status} ${r.body.batteryPct}`);

const exc = await call(op, 'POST', `${S}/exceptions`, { caseType: 'SAFETY', severity: 'CRITICAL', description: 'Spill near dock 3 — area cordoned' });
check('operator reports CRITICAL exception', exc.status === 201 && exc.body.status === 'OPEN', `${exc.status} ${exc.body.code}`);

await sleep(2500);
let n = (await call(mgr, 'GET', '/notifications?unread=true')).body;
const cats = n.items.map((x) => x.category + ':' + x.title);
check('manager got maintenance notification', cats.some((c) => c.startsWith('EQUIPMENT') && c.includes('Maintenance')), cats.join(' | '));
check('manager got low battery notification', cats.some((c) => c.includes('Battery 14%')));
check('manager got CRITICAL exception notification (UC-23-AC2)', n.items.some((x) => x.category === 'EXCEPTION' && x.severity === 'CRITICAL' && x.link?.includes('/exceptions?case=')));
const forkN = (await call(fork, 'GET', '/notifications?unread=true')).body;
check('forklift operator gets none of these (no permission)', forkN.items.length === 0, `${forkN.items.length}`);

const first = n.items[0];
r = await call(mgr, 'POST', `/notifications/${first.id}/read`, {});
check('mark one read → 204', r.status === 204);
const after = (await call(mgr, 'GET', '/notifications')).body;
check('unread count decremented', after.unreadCount === n.unreadCount - 1, `${n.unreadCount} → ${after.unreadCount}`);
r = await call(sup, 'POST', `/notifications/${first.id}/read`, {});
check("cannot read someone else's notification → 404", r.status === 404, `${r.status}`);
await call(mgr, 'POST', '/notifications/read-all', { siteId: wh1.id });
check('read-all → 0 unread', (await call(mgr, 'GET', '/notifications')).body.unreadCount === 0);

// Exception lifecycle
let c = exc.body;
r = await call(sup, 'POST', `${S}/exceptions/${c.id}/assign`, { expectedVersion: c.version });
check('supervisor takes exception → IN_REVIEW', r.body.status === 'IN_REVIEW' && r.body.assignee, `${r.body.status} ${r.body.assignee}`);
c = r.body;
r = await call(sup, 'POST', `${S}/exceptions/${c.id}/resolve`, { resolutionCode: 'CLEANED', note: 'Spill kit used', expectedVersion: c.version });
check('resolve exception', r.body.status === 'RESOLVED' && r.body.resolutionCode === 'CLEANED');
await sleep(1500);
const dup = (await call(mgr, 'GET', '/notifications')).body;
check('status changes of exception do not re-notify', !dup.items.some((x) => !x.readAt && x.category === 'EXCEPTION'), `${dup.unreadCount}`);

r = await call(sup, 'POST', `${S}/equipment/${f.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: f.version });
check('maintenance done → AVAILABLE', r.body.status === 'AVAILABLE');

console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
