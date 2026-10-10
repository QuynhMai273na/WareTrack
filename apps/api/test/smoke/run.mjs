// Chạy toàn bộ smoke test API theo thứ tự, mỗi bộ trên một DB vừa seed lại (API phải đang chạy).
// Dùng: pnpm --filter @waretrack/api test:smoke   (API_URL mặc định http://localhost:3000)
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..', '..');
const suites = readdirSync(here).filter((f) => /^\d+-.*\.mjs$/.test(f)).sort();
const shell = process.platform === 'win32';
let failed = 0;

for (const suite of suites) {
  const seed = spawnSync('npx', ['tsx', 'prisma/seed/index.ts'], { cwd: apiRoot, stdio: 'pipe', shell });
  if (seed.status !== 0) {
    console.error(seed.stderr?.toString());
    process.exit(1);
  }
  console.log(`\n=== ${suite}`);
  const r = spawnSync(process.execPath, [join(here, suite)], { stdio: 'inherit', env: process.env });
  if (r.status !== 0) failed++;
}

console.log(failed ? `\n${failed} suite(s) failed` : `\nAll ${suites.length} suites passed`);
process.exit(failed ? 1 : 0);
