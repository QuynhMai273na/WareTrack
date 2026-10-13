#!/bin/sh
# Khởi động API trong container (Render): áp migration, seed demo nếu DB trống (DEC-51), rồi chạy server.
set -e

# Gọi thẳng CLI trong node_modules (image runtime không có npm/npx)
node_modules/.bin/prisma migrate deploy

if [ "$SEED_ON_EMPTY" = "true" ]; then
  node scripts/seed-if-empty.mjs
fi

exec node dist/main.js
