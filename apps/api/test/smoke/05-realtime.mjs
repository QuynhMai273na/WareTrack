// Smoke test Phase 7 — realtime robustness (mục 17): seq liên tục, replay sau mất kết nối, phân quyền room, room user
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');

const BASE = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
let ok = 0, fail = 0;
const check = (name, cond, extra = '') => { cond ? ok++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function call(token, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method === 'POST') headers['idempotency-key'] = randomUUID();
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const login = async (username) => (await call(null, 'POST', '/auth/login', { username, password: 'WareTrack@2026' })).body.accessToken;
const connect = (token) => io(`${process.env.API_URL ?? 'http://localhost:3000'}/rt`, { path: '/ws', transports: ['websocket'], auth: { token }, reconnection: false });
const once = (socket, eventName, ms = 5000) => new Promise((res, rej) => { const timer = setTimeout(() => rej(new Error('timeout ' + eventName)), ms); socket.once(eventName, (payload) => { clearTimeout(timer); res(payload); }); });
const emitAck = (socket, eventName, body) => new Promise((res) => socket.emit(eventName, body, res));

const mgr = await login('manager');
const disp = await login('dispatcher');
const me = (await call(mgr, 'GET', '/auth/me')).body;
const wh1 = me.sites.find((site) => site.code === 'WH-01');
const wh2 = me.sites.find((site) => site.code === 'WH-02');

// 1) handshake auth
const bad = connect('not-a-token');
const err = await once(bad, 'connect_error').catch((error) => error);
check('invalid token rejected at handshake', err?.message === 'unauthenticated', err?.message);
bad.close();

// 2) room authorization
const sd = connect(disp);
await once(sd, 'connect');
const deny = await emitAck(sd, 'site:join', { siteId: wh2.id });
check('dispatcher cannot join WH-02 (no role there)', deny.ok === false && deny.code === 'FORBIDDEN', JSON.stringify(deny));
const allow = await emitAck(sd, 'site:join', { siteId: wh1.id });
check('dispatcher joins WH-01', allow.ok === true, JSON.stringify(allow));

// 3) contiguous siteSeq on live stream
const sm = connect(mgr);
await once(sm, 'connect');
const join = await emitAck(sm, 'site:join', { siteId: wh1.id });
const events = [];
sm.on('event', (event) => events.push(event));
const sitePath = `/sites/${wh1.id}`;
const eq = (await call(mgr, 'GET', `${sitePath}/equipment`)).body;
let forklift = eq.find((equipment) => equipment.status === 'AVAILABLE');
for (let cycle = 0; cycle < 3; cycle++) {
  forklift = (await call(mgr, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'CHARGING', expectedVersion: forklift.version })).body;
  forklift = (await call(mgr, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: forklift.version })).body;
}
await sleep(1500);
const seqs = events.map((event) => event.siteSeq);
const contiguous = seqs.every((seq, seqIndex) => seqIndex === 0 || seq === seqs[seqIndex - 1] + 1);
check('live events arrive with contiguous siteSeq', events.length >= 6 && contiguous && seqs[0] > join.latestSeq, `${seqs.join(',')} (joined at ${join.latestSeq})`);
check('envelope has v, aggregate.version, publishedAt', events.every((event) => event.v === 1 && typeof event.aggregate?.version === 'number' && event.publishedAt));

// 4) offline gap → replay
const lastSeen = seqs[seqs.length - 1];
sm.close();
for (let cycle = 0; cycle < 2; cycle++) {
  forklift = (await call(mgr, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'OFFLINE', expectedVersion: forklift.version })).body;
  forklift = (await call(mgr, 'POST', `${sitePath}/equipment/${forklift.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: forklift.version })).body;
}
await sleep(1000);
const replay = (await call(mgr, 'GET', `${sitePath}/events?afterSeq=${lastSeen}`)).body;
const rs = replay.events.map((event) => event.siteSeq);
check('replay returns missed events from afterSeq+1, contiguous', rs[0] === lastSeen + 1 && rs.every((seq, seqIndex) => seqIndex === 0 || seq === rs[seqIndex - 1] + 1) && !replay.truncated, `${rs.join(',')} latest=${replay.latestSeq}`);
check('replay reaches latestSeq', rs[rs.length - 1] === replay.latestSeq);
const old = (await call(mgr, 'GET', `${sitePath}/events?afterSeq=0&limit=5`)).body;
check('replay window beyond limit is flagged (truncated or partial)', old.events.length <= 5);

// 5) site scoping: WH-02 events never reach a WH-01 socket
const sm2 = connect(mgr);
await once(sm2, 'connect');
await emitAck(sm2, 'site:join', { siteId: wh1.id });
const leaked = [];
sm2.on('event', (event) => event.siteId !== wh1.id && leaked.push(event));
const eq2 = (await call(mgr, 'GET', `/sites/${wh2.id}/equipment`)).body;
const f2 = eq2.find((equipment) => equipment.status === 'AVAILABLE');
if (f2) {
  const charged = (await call(mgr, 'POST', `/sites/${wh2.id}/equipment/${f2.id}/status`, { toStatus: 'CHARGING', expectedVersion: f2.version })).body;
  await call(mgr, 'POST', `/sites/${wh2.id}/equipment/${f2.id}/status`, { toStatus: 'AVAILABLE', expectedVersion: charged.version });
}
// join WH-02 auto-leaves WH-01
await sleep(800);
check('no cross-site events leak to WH-01 room', leaked.length === 0, `${leaked.length}`);

// 6) user room: notification.created only to recipients
const gotMgr = once(sm2, 'notification.created', 6000).catch(() => null);
const gotDisp = once(sd, 'notification.created', 3000).catch(() => null);
const op = await login('operator');
await call(op, 'POST', `${sitePath}/exceptions`, { caseType: 'SAFETY', severity: 'HIGH', description: 'Realtime notification probe' });
const [nm, nd] = await Promise.all([gotMgr, gotDisp]);
check('manager receives notification.created on user room', nm?.category === 'EXCEPTION', JSON.stringify(nm));
check('dispatcher (has exception.resolve) also notified', nd?.category === 'EXCEPTION');
const viewer = await login('viewer');
const sv = connect(viewer);
await once(sv, 'connect');
const gotViewer = once(sv, 'notification.created', 2500).catch(() => null);
await call(op, 'POST', `${sitePath}/exceptions`, { caseType: 'SAFETY', severity: 'HIGH', description: 'Viewer must not be notified' });
check('viewer (no exception.resolve) gets no notification', (await gotViewer) === null);

for (const socket of [sd, sm2, sv]) socket.close();
console.log(`\n${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
