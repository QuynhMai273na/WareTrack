-- CreateEnum
CREATE TYPE "InboundOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'RECEIVING', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReceiptStatus" AS ENUM ('IN_PROGRESS', 'PARTIALLY_RECEIVED', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DiscrepancyType" AS ENUM ('SHORT', 'OVER', 'DAMAGED', 'UNEXPECTED_SKU', 'LOT_MISMATCH');

-- CreateEnum
CREATE TYPE "DiscrepancyStatus" AS ENUM ('OPEN', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "QcResult" AS ENUM ('PASS', 'FAIL', 'PARTIAL');

-- CreateEnum
CREATE TYPE "OutboundOrderStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'ALLOCATING', 'PICKING', 'SHIPPED', 'PARTIALLY_SHIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OrderLineStatus" AS ENUM ('OPEN', 'PARTIALLY_ALLOCATED', 'ALLOCATED', 'PARTIALLY_PICKED', 'PICKED', 'SHIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ShipmentStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'PICKING', 'STAGED', 'LOADING', 'DISPATCHED', 'DELIVERED', 'EXPECTED', 'ARRIVED', 'UNLOADING', 'RECEIVED', 'CLOSED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ShipmentItemType" AS ENUM ('HANDLING_UNIT', 'VEHICLE');

-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('PUTAWAY', 'PICK', 'LOAD', 'UNLOAD', 'MOVE_PALLET', 'MOVE_VEHICLE', 'QC', 'COUNT', 'RETURN_TO_STOCK');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'ASSIGNED', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExceptionStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExceptionSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- DropIndex
DROP INDEX "ux_balance_key";

-- CreateTable
CREATE TABLE "inbound_order" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "supplier_id" UUID,
    "status" "InboundOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "expected_on" DATE,
    "shipment_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "inbound_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_order_line" (
    "id" UUID NOT NULL,
    "inbound_order_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "expected_lot_number" TEXT,
    "expected_qty" DECIMAL(18,3) NOT NULL,
    "expected_hu_count" INTEGER,
    "received_qty" DECIMAL(18,3) NOT NULL DEFAULT 0,

    CONSTRAINT "inbound_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "inbound_order_id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "dock_location_id" UUID NOT NULL,
    "status" "ReceiptStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_line" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "inbound_order_line_id" UUID,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID,
    "handling_unit_id" UUID NOT NULL,
    "quantity" DECIMAL(18,3) NOT NULL,
    "stock_status" "StockStatus" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "voided" BOOLEAN NOT NULL DEFAULT false,
    "void_reason" TEXT,
    "inventory_tx_id" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "receipt_discrepancy" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "discrepancy_type" "DiscrepancyType" NOT NULL,
    "sku_id" UUID,
    "qty_delta" DECIMAL(18,3) NOT NULL,
    "status" "DiscrepancyStatus" NOT NULL DEFAULT 'OPEN',
    "note" TEXT,
    "exception_case_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "receipt_discrepancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qc_inspection" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "handling_unit_id" UUID NOT NULL,
    "result" "QcResult" NOT NULL,
    "qty_passed" DECIMAL(18,3) NOT NULL,
    "qty_failed" DECIMAL(18,3) NOT NULL,
    "fail_status" "StockStatus",
    "note" TEXT,
    "inspector_id" UUID,
    "inspected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_order" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "customer_id" UUID,
    "status" "OutboundOrderStatus" NOT NULL DEFAULT 'DRAFT',
    "requested_delivery_at" TIMESTAMPTZ(6),
    "shipment_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "outbound_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_order_line" (
    "id" UUID NOT NULL,
    "outbound_order_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "sku_id" UUID NOT NULL,
    "lot_id" UUID,
    "ordered_qty" DECIMAL(18,3) NOT NULL,
    "allocated_qty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "picked_qty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "shipped_qty" DECIMAL(18,3) NOT NULL DEFAULT 0,
    "status" "OrderLineStatus" NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "outbound_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "direction" "ShipmentDirection" NOT NULL,
    "status" "ShipmentStatus" NOT NULL,
    "carrier_id" UUID,
    "partner_id" UUID,
    "truck_visit_id" UUID,
    "staging_location_id" UUID,
    "destination_text" TEXT,
    "planned_dispatch_at" TIMESTAMPTZ(6),
    "promised_at" TIMESTAMPTZ(6),
    "eta_at" TIMESTAMPTZ(6),
    "arrived_at" TIMESTAMPTZ(6),
    "dispatched_at" TIMESTAMPTZ(6),
    "delivered_at" TIMESTAMPTZ(6),
    "seal_number" TEXT,
    "expected_hu_count" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_item" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "item_type" "ShipmentItemType" NOT NULL,
    "handling_unit_id" UUID,
    "vehicle_stay_id" UUID,
    "loaded_at" TIMESTAMPTZ(6),
    "unloaded_at" TIMESTAMPTZ(6),

    CONSTRAINT "shipment_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shipment_milestone" (
    "id" UUID NOT NULL,
    "shipment_id" UUID NOT NULL,
    "milestone" TEXT NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" TEXT NOT NULL DEFAULT 'SYSTEM',
    "actor_id" UUID,

    CONSTRAINT "shipment_milestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operation_task" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "task_type" "TaskType" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 3,
    "subject_type" TEXT NOT NULL,
    "subject_id" UUID NOT NULL,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "source_type" TEXT NOT NULL,
    "source_id" UUID NOT NULL,
    "assignee_id" UUID,
    "equipment_id" UUID,
    "payload" JSONB,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "block_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "operation_task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_event" (
    "id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "from_status" "TaskStatus",
    "to_status" "TaskStatus" NOT NULL,
    "actor_id" UUID,
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exception_case" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "case_type" TEXT NOT NULL,
    "severity" "ExceptionSeverity" NOT NULL DEFAULT 'MEDIUM',
    "status" "ExceptionStatus" NOT NULL DEFAULT 'OPEN',
    "subject_type" TEXT,
    "subject_id" UUID,
    "description" TEXT NOT NULL,
    "assignee_id" UUID,
    "resolution_code" TEXT,
    "resolution_note" TEXT,
    "created_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "exception_case_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inbound_order_site_id_status_idx" ON "inbound_order"("site_id", "status");

-- CreateIndex
CREATE INDEX "receipt_site_id_status_idx" ON "receipt"("site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "receipt_line_idempotency_key_key" ON "receipt_line"("idempotency_key");

-- CreateIndex
CREATE INDEX "receipt_line_receipt_id_idx" ON "receipt_line"("receipt_id");

-- CreateIndex
CREATE INDEX "receipt_discrepancy_receipt_id_idx" ON "receipt_discrepancy"("receipt_id");

-- CreateIndex
CREATE INDEX "outbound_order_site_id_status_idx" ON "outbound_order"("site_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "shipment_code_key" ON "shipment"("code");

-- CreateIndex
CREATE INDEX "shipment_site_id_status_idx" ON "shipment"("site_id", "status");

-- CreateIndex
CREATE INDEX "shipment_truck_visit_id_idx" ON "shipment"("truck_visit_id");

-- CreateIndex
CREATE INDEX "shipment_item_shipment_id_idx" ON "shipment_item"("shipment_id");

-- CreateIndex
CREATE INDEX "shipment_milestone_shipment_id_idx" ON "shipment_milestone"("shipment_id");

-- CreateIndex
CREATE INDEX "operation_task_site_id_status_priority_idx" ON "operation_task"("site_id", "status", "priority");

-- CreateIndex
CREATE INDEX "operation_task_site_id_task_type_completed_at_idx" ON "operation_task"("site_id", "task_type", "completed_at");

-- CreateIndex
CREATE INDEX "operation_task_source_type_source_id_idx" ON "operation_task"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "task_event_task_id_idx" ON "task_event"("task_id");

-- CreateIndex
CREATE INDEX "exception_case_site_id_status_idx" ON "exception_case"("site_id", "status");

-- AddForeignKey
ALTER TABLE "inbound_order_line" ADD CONSTRAINT "inbound_order_line_inbound_order_id_fkey" FOREIGN KEY ("inbound_order_id") REFERENCES "inbound_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipt_line" ADD CONSTRAINT "receipt_line_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_order_line" ADD CONSTRAINT "outbound_order_line_outbound_order_id_fkey" FOREIGN KEY ("outbound_order_id") REFERENCES "outbound_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_item" ADD CONSTRAINT "shipment_item_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shipment_milestone" ADD CONSTRAINT "shipment_milestone_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "shipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Ràng buộc Phase 4 (mục 14.8)
-- ═══════════════════════════════════════════════════════════════════

CREATE UNIQUE INDEX ux_inbound_order_code ON inbound_order (site_id, code);
CREATE UNIQUE INDEX ux_outbound_order_code ON outbound_order (site_id, code);
CREATE UNIQUE INDEX ux_task_code ON operation_task (site_id, code);

-- BR-27: một forklift / một operator tối đa một task IN_PROGRESS
CREATE UNIQUE INDEX ux_task_equipment_in_progress
  ON operation_task (equipment_id) WHERE status = 'IN_PROGRESS' AND equipment_id IS NOT NULL;
CREATE UNIQUE INDEX ux_task_assignee_in_progress
  ON operation_task (assignee_id) WHERE status = 'IN_PROGRESS' AND assignee_id IS NOT NULL;

-- ShipmentItem: đúng một loại tham chiếu; một HU chỉ thuộc một shipment
ALTER TABLE shipment_item ADD CONSTRAINT ck_shipment_item_ref CHECK (
  (item_type = 'HANDLING_UNIT' AND handling_unit_id IS NOT NULL AND vehicle_stay_id IS NULL) OR
  (item_type = 'VEHICLE' AND vehicle_stay_id IS NOT NULL AND handling_unit_id IS NULL));
CREATE UNIQUE INDEX ux_shipment_item_hu ON shipment_item (shipment_id, handling_unit_id) WHERE handling_unit_id IS NOT NULL;

-- Shipment: trạng thái thuộc đúng tập của chiều (mục 15.11)
ALTER TABLE shipment ADD CONSTRAINT ck_shipment_status_direction CHECK (
  (direction = 'OUTBOUND' AND status IN ('DRAFT','CONFIRMED','PICKING','STAGED','LOADING','DISPATCHED','DELIVERED','CANCELLED')) OR
  (direction = 'INBOUND' AND status IN ('EXPECTED','ARRIVED','UNLOADING','RECEIVED','CLOSED','CANCELLED')));

ALTER TABLE receipt_line ADD CONSTRAINT ck_receipt_line_qty CHECK (quantity > 0);
ALTER TABLE outbound_order_line ADD CONSTRAINT ck_outbound_line_qty CHECK (
  ordered_qty > 0 AND allocated_qty >= 0 AND picked_qty >= 0 AND shipped_qty >= 0);

-- Lịch sử append-only
CREATE TRIGGER trg_shipment_milestone_append_only BEFORE UPDATE OR DELETE ON shipment_milestone
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_task_event_append_only BEFORE UPDATE OR DELETE ON task_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
