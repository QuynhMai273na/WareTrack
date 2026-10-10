-- CreateEnum
CREATE TYPE "StockStatus" AS ENUM ('AVAILABLE', 'QC_HOLD', 'QUARANTINE', 'DAMAGED');

-- CreateEnum
CREATE TYPE "AllocationStrategy" AS ENUM ('FIFO', 'FEFO');

-- CreateEnum
CREATE TYPE "HuLifecycle" AS ENUM ('RECEIVING', 'IN_STOCK', 'PICKED', 'STAGED', 'LOADED', 'DISPATCHED', 'EMPTY');

-- CreateEnum
CREATE TYPE "SerialStatus" AS ENUM ('IN_STOCK', 'PICKED', 'SHIPPED', 'QUARANTINE', 'SCRAPPED');

-- CreateEnum
CREATE TYPE "InventoryTxType" AS ENUM ('RECEIPT', 'RECEIPT_REVERSAL', 'MOVE', 'STATUS_CHANGE', 'ISSUE', 'ISSUE_REVERSAL', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- CreateEnum
CREATE TYPE "ReservationStatus" AS ENUM ('ACTIVE', 'PICKED', 'CONSUMED', 'RELEASED');

-- CreateEnum
CREATE TYPE "StockCountStatus" AS ENUM ('PLANNED', 'IN_PROGRESS', 'RECONCILING', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING_APPROVAL', 'APPLIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AdjustmentReason" AS ENUM ('COUNT_VARIANCE', 'DAMAGE', 'LOSS', 'FOUND', 'DATA_CORRECTION');

-- CreateEnum
CREATE TYPE "MovementSubject" AS ENUM ('HANDLING_UNIT', 'VEHICLE_STAY', 'TRUCK_VISIT', 'EQUIPMENT');

-- CreateTable
CREATE TABLE "sku" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "base_uom" TEXT NOT NULL DEFAULT 'EA',
    "uom_decimals" INTEGER NOT NULL DEFAULT 0,
    "lot_tracked" BOOLEAN NOT NULL DEFAULT false,
    "serial_tracked" BOOLEAN NOT NULL DEFAULT false,
    "expiry_tracked" BOOLEAN NOT NULL DEFAULT false,
    "qc_required" BOOLEAN NOT NULL DEFAULT false,
    "allocation_strategy" "AllocationStrategy" NOT NULL DEFAULT 'FIFO',
    "unit_weight_kg" DECIMAL(10,3),
    "low_stock_threshold" DECIMAL(18,3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "sku_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lot" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_number" TEXT NOT NULL,
    "manufactured_on" DATE,
    "expires_on" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "serial_unit" (
    "id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "serial_number" TEXT NOT NULL,
    "site_id" UUID,
    "location_id" UUID,
    "handling_unit_id" UUID,
    "status" "SerialStatus" NOT NULL DEFAULT 'IN_STOCK',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "serial_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handling_unit" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "sscc" TEXT,
    "lifecycle" "HuLifecycle" NOT NULL DEFAULT 'RECEIVING',
    "location_id" UUID,
    "position_source" "PositionSource",
    "position_confirmed_at" TIMESTAMPTZ(6),
    "gross_weight_kg" DECIMAL(10,2),
    "mixed_content" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "handling_unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_balance" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID,
    "handling_unit_id" UUID,
    "stock_status" "StockStatus" NOT NULL,
    "qty_on_hand" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "qty_reserved" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inventory_balance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_transaction" (
    "id" BIGSERIAL NOT NULL,
    "site_id" UUID NOT NULL,
    "tx_type" "InventoryTxType" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID,
    "handling_unit_id" UUID,
    "serial_unit_id" UUID,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "from_status" "StockStatus",
    "to_status" "StockStatus",
    "quantity" DECIMAL(18,3) NOT NULL,
    "reference_type" TEXT NOT NULL,
    "reference_id" TEXT NOT NULL,
    "reverses_tx_id" BIGINT,
    "actor_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "balance_id" UUID NOT NULL,
    "outbound_order_line_id" UUID NOT NULL,
    "shipment_id" UUID,
    "quantity" DECIMAL(18,3) NOT NULL,
    "status" "ReservationStatus" NOT NULL DEFAULT 'ACTIVE',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "reservation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "status" "StockCountStatus" NOT NULL DEFAULT 'PLANNED',
    "blind" BOOLEAN NOT NULL DEFAULT true,
    "freeze" BOOLEAN NOT NULL DEFAULT false,
    "scope" JSONB NOT NULL,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_count_line" (
    "id" UUID NOT NULL,
    "stock_count_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID,
    "handling_unit_id" UUID,
    "balance_id" UUID,
    "system_qty" DECIMAL(18,3) NOT NULL,
    "counted_qty" DECIMAL(18,3),
    "count_round" INTEGER NOT NULL DEFAULT 0,
    "counted_by_id" UUID,
    "counted_at" TIMESTAMPTZ(6),

    CONSTRAINT "stock_count_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_adjustment" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "balance_id" UUID NOT NULL,
    "stock_count_line_id" UUID,
    "qty_delta" DECIMAL(18,3) NOT NULL,
    "reason_code" "AdjustmentReason" NOT NULL,
    "note" TEXT,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "requires_manager" BOOLEAN NOT NULL DEFAULT false,
    "requested_by_id" UUID NOT NULL,
    "approved_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "applied_tx_id" BIGINT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stock_adjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movement_record" (
    "id" BIGSERIAL NOT NULL,
    "site_id" UUID NOT NULL,
    "subject_type" "MovementSubject" NOT NULL,
    "subject_id" UUID NOT NULL,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "position_source" "PositionSource" NOT NULL,
    "confidence" DECIMAL(3,2),
    "reason" TEXT NOT NULL,
    "actor_id" UUID,
    "task_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "movement_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lot_sku_id_lot_number_key" ON "lot"("sku_id", "lot_number");

-- CreateIndex
CREATE UNIQUE INDEX "serial_unit_sku_id_serial_number_key" ON "serial_unit"("sku_id", "serial_number");

-- CreateIndex
CREATE UNIQUE INDEX "handling_unit_code_key" ON "handling_unit"("code");

-- CreateIndex
CREATE UNIQUE INDEX "handling_unit_sscc_key" ON "handling_unit"("sscc");

-- CreateIndex
CREATE INDEX "handling_unit_site_id_lifecycle_idx" ON "handling_unit"("site_id", "lifecycle");

-- CreateIndex
CREATE INDEX "handling_unit_location_id_idx" ON "handling_unit"("location_id");

-- CreateIndex
CREATE INDEX "inventory_balance_site_id_sku_id_stock_status_idx" ON "inventory_balance"("site_id", "sku_id", "stock_status");

-- CreateIndex
CREATE INDEX "inventory_balance_site_id_location_id_idx" ON "inventory_balance"("site_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_balance_handling_unit_id_idx" ON "inventory_balance"("handling_unit_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_transaction_idempotency_key_key" ON "inventory_transaction"("idempotency_key");

-- CreateIndex
CREATE INDEX "inventory_transaction_site_id_occurred_at_idx" ON "inventory_transaction"("site_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "inventory_transaction_handling_unit_id_id_idx" ON "inventory_transaction"("handling_unit_id", "id");

-- CreateIndex
CREATE INDEX "inventory_transaction_reference_type_reference_id_idx" ON "inventory_transaction"("reference_type", "reference_id");

-- CreateIndex
CREATE INDEX "reservation_outbound_order_line_id_idx" ON "reservation"("outbound_order_line_id");

-- CreateIndex
CREATE INDEX "reservation_balance_id_status_idx" ON "reservation"("balance_id", "status");

-- CreateIndex
CREATE INDEX "stock_count_line_stock_count_id_idx" ON "stock_count_line"("stock_count_id");

-- CreateIndex
CREATE INDEX "stock_adjustment_site_id_status_idx" ON "stock_adjustment"("site_id", "status");

-- CreateIndex
CREATE INDEX "movement_record_subject_type_subject_id_occurred_at_idx" ON "movement_record"("subject_type", "subject_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "movement_record_site_id_occurred_at_idx" ON "movement_record"("site_id", "occurred_at" DESC);

-- AddForeignKey
ALTER TABLE "lot" ADD CONSTRAINT "lot_sku_id_fkey" FOREIGN KEY ("sku_id") REFERENCES "sku"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation" ADD CONSTRAINT "reservation_balance_id_fkey" FOREIGN KEY ("balance_id") REFERENCES "inventory_balance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_count_line" ADD CONSTRAINT "stock_count_line_stock_count_id_fkey" FOREIGN KEY ("stock_count_id") REFERENCES "stock_count"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Ràng buộc Inventory (mục 14.8)
-- ═══════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX ux_sku_code ON sku (code) WHERE deleted_at IS NULL;

-- BR-02: không âm, không reserve vượt on-hand, chỉ reserve hàng AVAILABLE
ALTER TABLE inventory_balance
  ADD CONSTRAINT ck_balance_non_negative CHECK (qty_on_hand >= 0 AND qty_reserved >= 0),
  ADD CONSTRAINT ck_balance_reserved_le_onhand CHECK (qty_reserved <= qty_on_hand),
  ADD CONSTRAINT ck_balance_reserved_only_available CHECK (stock_status = 'AVAILABLE' OR qty_reserved = 0);

-- Khóa duy nhất của balance (NULL-safe cho lot/HU) — PostgreSQL 15+
CREATE UNIQUE INDEX ux_balance_key
  ON inventory_balance (site_id, location_id, sku_id, lot_id, handling_unit_id, stock_status)
  NULLS NOT DISTINCT;

-- BR-20: số lượng giao dịch luôn dương; chiều theo tx_type
ALTER TABLE inventory_transaction
  ADD CONSTRAINT ck_tx_qty_positive CHECK (quantity > 0),
  ADD CONSTRAINT ck_tx_locations CHECK (
    (tx_type IN ('RECEIPT','ADJUSTMENT_IN','ISSUE_REVERSAL') AND to_location_id IS NOT NULL) OR
    (tx_type IN ('ISSUE','ADJUSTMENT_OUT','RECEIPT_REVERSAL') AND from_location_id IS NOT NULL) OR
    (tx_type = 'MOVE' AND from_location_id IS NOT NULL AND to_location_id IS NOT NULL AND from_location_id <> to_location_id) OR
    (tx_type = 'STATUS_CHANGE' AND from_status IS NOT NULL AND to_status IS NOT NULL AND from_status <> to_status));

ALTER TABLE reservation ADD CONSTRAINT ck_reservation_qty CHECK (quantity > 0);

-- Maker-checker ở mức DB (BR-26)
ALTER TABLE stock_adjustment
  ADD CONSTRAINT ck_adjust_maker_checker CHECK (approved_by_id IS NULL OR approved_by_id <> requested_by_id),
  ADD CONSTRAINT ck_adjust_delta_nonzero CHECK (qty_delta <> 0);

CREATE INDEX ix_balance_available ON inventory_balance (site_id, sku_id) WHERE stock_status = 'AVAILABLE' AND qty_on_hand > 0;

-- Ledger + movement append-only (BR-07)
CREATE TRIGGER trg_inventory_tx_append_only BEFORE UPDATE OR DELETE ON inventory_transaction
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_movement_append_only BEFORE UPDATE OR DELETE ON movement_record
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
