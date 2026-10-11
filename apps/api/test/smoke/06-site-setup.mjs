// Smoke test vận hành thật: tạo site → sơ đồ (nháp/xem trước/publish) → danh mục → user/vai trò → xe nâng → tồn đầu kỳ
import { randomUUID } from 'node:crypto';

const BASE = (process.env.API_URL ?? 'http://localhost:3000') + '/api/v1';
let passCount = 0;
let failCount = 0;
const check = (name, condition, detail = '') => {
  condition ? passCount++ : failCount++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function waitReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${BASE}/health/ready`);
      if (response.ok) return;
    } catch {
      /* API chưa sẵn sàng */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('API not ready');
}

async function call(token, method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (method !== 'GET') headers['idempotency-key'] = randomUUID();
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = text;
  }
  return { status: response.status, body: payload };
}

const login = async (username, password = 'WareTrack@2026') => (await call(null, 'POST', '/auth/login', { username, password })).body?.accessToken;

await waitReady();
const adminToken = await login('admin');
const managerToken = await login('manager');
const viewerToken = await login('viewer');
check('admin and manager sign in', !!adminToken && !!managerToken);

const info = await call(null, 'GET', '/health/info');
check('run mode endpoint is public', info.status === 200 && ['demo', 'live'].includes(info.body.mode), JSON.stringify(info.body));

const forbiddenCreate = await call(managerToken, 'POST', '/sites', { code: 'ZZ-01', name: 'Nope', siteType: 'DEPOT', timezone: 'America/New_York' });
check('site manager cannot create sites (site.manage = admin)', forbiddenCreate.status === 403);

const siteCode = `ST-${String(Date.now()).slice(-4)}`;
const created = await call(adminToken, 'POST', '/sites', { code: siteCode, name: 'Smoke Test DC', siteType: 'DISTRIBUTION_CENTER', timezone: 'America/New_York' });
check('admin creates site with default layout', created.status === 201 && created.body.publishedVersionNo === 1 && created.body.locationCount > 10, `${created.status} v${created.body?.publishedVersionNo}`);
const siteId = created.body.id;
const duplicate = await call(adminToken, 'POST', '/sites', { code: siteCode, name: 'Again', siteType: 'DEPOT', timezone: 'America/New_York' });
check('duplicate site code rejected', duplicate.status === 422 && duplicate.body.code === 'CODE_ALREADY_EXISTS');

const adminSites = await call(adminToken, 'GET', '/admin/sites');
check('new site listed for admin and placed on a free map cell', adminSites.body.some((site) => site.code === siteCode && (site.map.x !== 0 || site.map.z !== 0)));
const viewerSites = await call(viewerToken, 'GET', '/admin/sites');
check('viewer only sees own sites in admin list', viewerSites.status === 200 && !viewerSites.body.some((site) => site.code === siteCode));

const state = await call(adminToken, 'GET', `/sites/${siteId}/blueprint`);
const blueprint = structuredClone(state.body.blueprint);
blueprint.docks.push({ id: 'dock-extra', code: 'DOCK-9', label: 'Bay 9', buildingCode: 'BLD-1', face: 'E', offset: 18, direction: 'INBOUND' });
blueprint.indoorStorage.totalPallets = 900;
const preview = await call(adminToken, 'POST', `/sites/${siteId}/blueprint/preview`, { blueprint });
check('preview contains the new dock', preview.status === 200 && preview.body.objects.some((object) => object.props?.code === 'DOCK-9'));
const published = await call(adminToken, 'POST', `/sites/${siteId}/blueprint/publish`, { blueprint });
check('publish creates version 2 and keeps existing locations', published.status === 200 && published.body.versionNo === 2 && published.body.locationsUpdated > 0, JSON.stringify(published.body));

const skuCode = `SMK-${String(Date.now()).slice(-5)}`;
const sku = await call(adminToken, 'POST', '/skus', { code: skuCode, name: 'Smoke Widget', category: 'Test', baseUom: 'EA' });
check('create SKU with category', sku.status === 201 && sku.body.category === 'Test');
const partner = await call(managerToken, 'POST', '/partners', { code: `P-${skuCode}`, name: 'Smoke Partner', partnerTypes: ['CUSTOMER'] });
check('site manager creates partner (master.partner.manage)', partner.status === 201);

const operatorName = `smoke.${String(Date.now()).slice(-6)}`;
const operator = await call(adminToken, 'POST', '/users', { username: operatorName, email: `${operatorName}@example.com`, fullName: 'Smoke Operator', tempPassword: 'SmokePassword#1' });
await call(adminToken, 'POST', `/users/${operator.body.id}/site-roles`, { siteId, roleCode: 'FORKLIFT_OPERATOR' });
const chargers = await call(adminToken, 'GET', `/sites/${siteId}/locations?type=CHARGER`);
const forklift = await call(adminToken, 'POST', `/sites/${siteId}/equipment`, { code: 'FL-01', chargerLocationId: chargers.body[0].id, operatorUserId: operator.body.id });
check('register forklift with charger and operator', forklift.status === 201 && forklift.body.status === 'OFFLINE', `${forklift.status}`);
const badCharger = await call(adminToken, 'POST', `/sites/${siteId}/equipment`, { code: 'FL-02', chargerLocationId: published.body && (await call(adminToken, 'GET', `/sites/${siteId}/locations?type=DOCK`)).body[0].id });
check('forklift charger must be a charging bay', badCharger.status === 422);

const rows = [
  { skuCode, locationCode: 'A-001', quantity: '50' },
  { skuCode, locationCode: 'S01', quantity: '10', palletCode: `PAL-${skuCode}` },
];
const dryRun = await call(adminToken, 'POST', `/sites/${siteId}/inventory/opening-stock`, { rows: [...rows, { skuCode, locationCode: 'DOCK-1', quantity: '1' }], dryRun: true });
check('dry run flags stock on a dock', dryRun.status === 200 && dryRun.body.errorCount === 1 && dryRun.body.importedPallets === 0);
const imported = await call(adminToken, 'POST', `/sites/${siteId}/inventory/opening-stock`, { rows, dryRun: false });
check('import opening stock', imported.status === 200 && imported.body.importedPallets === 2, JSON.stringify(imported.body).slice(0, 160));
const reimport = await call(adminToken, 'POST', `/sites/${siteId}/inventory/opening-stock`, { rows: [rows[1]], dryRun: true });
check('pallet code cannot be imported twice', reimport.body.errorCount === 1);
const viewerImport = await call(viewerToken, 'POST', `/sites/${siteId}/inventory/opening-stock`, { rows, dryRun: true });
const managerImport = await call(managerToken, 'POST', `/sites/${siteId}/inventory/opening-stock`, { rows, dryRun: true });
check('manager of other sites cannot reach the new site (BR-33 → 404)', managerImport.status === 404);
check('viewer cannot import (404 — no access to the new site)', viewerImport.status === 404 || viewerImport.status === 403);

const shrunk = structuredClone(blueprint);
shrunk.stagingGrids = [];
const blockedRetire = await call(adminToken, 'POST', `/sites/${siteId}/blueprint/publish`, { blueprint: shrunk });
check('cannot remove a staging slot that holds stock', blockedRetire.status === 422 && blockedRetire.body.code === 'LOCATION_IN_USE', `${blockedRetire.status} ${blockedRetire.body?.detail ?? ''}`);

const disabled = await call(adminToken, 'PATCH', `/users/${operator.body.id}`, { status: 'DISABLED' });
check('disable user', disabled.status === 200 && disabled.body.status === 'DISABLED');
check('disabled user cannot sign in', !(await login(operatorName, 'SmokePassword#1')));

console.log(`\n${passCount} passed, ${failCount} failed`);
process.exit(failCount ? 1 : 0);
