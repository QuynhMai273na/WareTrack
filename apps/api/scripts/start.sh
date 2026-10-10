#!/bin/sh
# Khởi động API trong container (Render): áp migration, seed demo nếu DB trống (DEC-51), rồi chạy server.
set -e

npx prisma migrate deploy

if [ "$SEED_ON_EMPTY" = "true" ]; then
  node scripts/seed-if-empty.mjs
fi

exec node dist/main.js
