// Seed dữ liệu demo khi database chưa có user nào (bản demo — DEC-51). Không bao giờ ghi đè dữ liệu đang có.
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const users = await prisma.user.count();
await prisma.$disconnect();

if (users > 0) {
  console.log(`[seed] Database already has ${users} users — skipping demo seed`);
} else {
  console.log('[seed] Empty database — seeding demo data');
  // Chạy seed TypeScript qua tsx bằng chính tiến trình node (image runtime không có npx)
  const seed = spawnSync(process.execPath, ['--import', 'tsx', 'prisma/seed/index.ts'], { stdio: 'inherit' });
  if (seed.status !== 0) process.exit(seed.status ?? 1);
}
