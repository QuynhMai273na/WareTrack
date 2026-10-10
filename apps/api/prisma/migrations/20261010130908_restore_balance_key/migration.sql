-- Khóa duy nhất của balance (NULL-safe cho lot/HU). Dạng partial index để `prisma migrate dev`
-- không tự DROP (Prisma không biểu đạt được NULLS NOT DISTINCT). Predicate luôn đúng nhờ ck_balance_non_negative.
CREATE UNIQUE INDEX IF NOT EXISTS ux_balance_key
  ON inventory_balance (site_id, location_id, sku_id, lot_id, handling_unit_id, stock_status)
  NULLS NOT DISTINCT
  WHERE qty_on_hand >= 0;
