-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED', 'LOCKED');

-- CreateEnum
CREATE TYPE "SiteType" AS ENUM ('DISTRIBUTION_CENTER', 'CROSS_DOCK', 'COLD_STORE', 'AUTOMATED_DC', 'VEHICLE_YARD', 'MIXED');

-- CreateEnum
CREATE TYPE "OperationalStatus" AS ENUM ('OPERATIONAL', 'LIMITED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ZoneType" AS ENUM ('YARD', 'WAREHOUSE', 'STAGING', 'QUARANTINE', 'VEHICLE_STORAGE', 'GATE_AREA', 'CHARGING');

-- CreateEnum
CREATE TYPE "LocationType" AS ENUM ('STORAGE', 'PARKING_SLOT', 'DOCK', 'GATE_LANE', 'STAGING', 'QUARANTINE', 'YARD_SLOT', 'CHARGER');

-- CreateEnum
CREATE TYPE "DockDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'BOTH');

-- CreateEnum
CREATE TYPE "LayoutStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "LayoutTargetType" AS ENUM ('ZONE', 'LOCATION', 'BUILDING', 'DECOR');

-- CreateEnum
CREATE TYPE "TruckType" AS ENUM ('BOX', 'REEFER', 'FLATBED', 'CAR_CARRIER', 'CONTAINER');

-- CreateEnum
CREATE TYPE "VisitDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'BOTH');

-- CreateEnum
CREATE TYPE "TruckVisitStatus" AS ENUM ('SCHEDULED', 'AT_GATE', 'WAITING', 'DOCK_ASSIGNED', 'AT_DOCK', 'HANDLING', 'READY_TO_LEAVE', 'EXITED', 'REJECTED', 'NO_SHOW', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExitReason" AS ENUM ('COMPLETED', 'ABORTED', 'REJECTED_GOODS', 'EMERGENCY');

-- CreateEnum
CREATE TYPE "GateEventType" AS ENUM ('IN_ARRIVAL', 'IN_VERIFIED', 'OUT', 'VEHICLE_IN', 'VEHICLE_OUT', 'REJECTED');

-- CreateEnum
CREATE TYPE "OccupantType" AS ENUM ('TRUCK_VISIT', 'VEHICLE_STAY', 'HANDLING_UNIT', 'EQUIPMENT');

-- CreateEnum
CREATE TYPE "OccupancyKind" AS ENUM ('RESERVED', 'OCCUPIED');

-- CreateEnum
CREATE TYPE "PositionSource" AS ENUM ('CONFIRMED_MANUAL', 'CONFIRMED_SCAN', 'SENSOR_OBSERVED', 'INFERRED');

-- CreateEnum
CREATE TYPE "EquipmentType" AS ENUM ('FORKLIFT', 'REACH_TRUCK', 'PALLET_JACK', 'TUG');

-- CreateEnum
CREATE TYPE "EquipmentStatus" AS ENUM ('OFFLINE', 'AVAILABLE', 'ASSIGNED', 'BUSY', 'CHARGING', 'MAINTENANCE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'DEVICE', 'SYSTEM');

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failed_login_count" INTEGER NOT NULL DEFAULT 0,
    "locked_until" TIMESTAMPTZ(6),
    "permission_version" INTEGER NOT NULL DEFAULT 0,
    "last_site_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "module" TEXT NOT NULL,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "user_site_role" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "site_id" UUID,
    "granted_by_id" UUID,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_site_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "replaced_by_id" UUID,
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "site_type" "SiteType" NOT NULL,
    "address_line" TEXT,
    "timezone" TEXT NOT NULL,
    "operational_status" "OperationalStatus" NOT NULL DEFAULT 'OPERATIONAL',
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_setting" (
    "site_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "site_setting_pkey" PRIMARY KEY ("site_id","key")
);

-- CreateTable
CREATE TABLE "zone" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "zone_type" "ZoneType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "zone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "zone_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "qr_value" TEXT NOT NULL,
    "location_type" "LocationType" NOT NULL,
    "capacity_units" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "max_weight_kg" DECIMAL(10,2),
    "single_occupancy" BOOLEAN NOT NULL DEFAULT true,
    "length_m" DECIMAL(6,2),
    "width_m" DECIMAL(6,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "blocked_at" TIMESTAMPTZ(6),
    "blocked_reason" TEXT,
    "frozen_by_count_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dock" (
    "location_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "direction" "DockDirection" NOT NULL,
    "door_number" TEXT,
    "max_truck_length_m" DECIMAL(6,2),

    CONSTRAINT "dock_pkey" PRIMARY KEY ("location_id")
);

-- CreateTable
CREATE TABLE "layout_version" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "version_no" INTEGER NOT NULL,
    "status" "LayoutStatus" NOT NULL DEFAULT 'DRAFT',
    "model_file_id" UUID,
    "bounds_min_x" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bounds_min_z" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bounds_max_x" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "bounds_max_z" DOUBLE PRECISION NOT NULL DEFAULT 100,
    "published_at" TIMESTAMPTZ(6),
    "published_by_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "layout_version_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "layout_object" (
    "id" UUID NOT NULL,
    "layout_version_id" UUID NOT NULL,
    "target_type" "LayoutTargetType" NOT NULL,
    "target_id" UUID,
    "mesh_ref" TEXT,
    "pos_x" DOUBLE PRECISION NOT NULL,
    "pos_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "pos_z" DOUBLE PRECISION NOT NULL,
    "rot_y" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "size_x" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "size_y" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "size_z" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "props" JSONB,

    CONSTRAINT "layout_object_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "partner" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "partner_types" TEXT[],
    "contact" JSONB,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "partner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "plate_number" TEXT NOT NULL,
    "carrier_id" UUID,
    "truck_type" "TruckType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "truck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver" (
    "id" UUID NOT NULL,
    "full_name" TEXT NOT NULL,
    "license_number" TEXT,
    "phone" TEXT,
    "carrier_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "truck_visit" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "truck_id" UUID NOT NULL,
    "driver_id" UUID,
    "direction" "VisitDirection" NOT NULL,
    "status" "TruckVisitStatus" NOT NULL,
    "unscheduled" BOOLEAN NOT NULL DEFAULT false,
    "appointment_start" TIMESTAMPTZ(6),
    "appointment_end" TIMESTAMPTZ(6),
    "eta_at" TIMESTAMPTZ(6),
    "arrived_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "docked_at" TIMESTAMPTZ(6),
    "handling_started_at" TIMESTAMPTZ(6),
    "ready_at" TIMESTAMPTZ(6),
    "exited_at" TIMESTAMPTZ(6),
    "dock_location_id" UUID,
    "actual_plate" TEXT,
    "seal_in" TEXT,
    "seal_out" TEXT,
    "exit_reason" "ExitReason",
    "reject_reason" TEXT,
    "late_reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by_id" UUID,

    CONSTRAINT "truck_visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_event" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "event_type" "GateEventType" NOT NULL,
    "truck_visit_id" UUID,
    "vehicle_stay_id" UUID,
    "gate_location_id" UUID,
    "plate_read" TEXT,
    "note" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_id" UUID,

    CONSTRAINT "gate_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_occupancy" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "occupant_type" "OccupantType" NOT NULL,
    "occupant_id" UUID NOT NULL,
    "kind" "OccupancyKind" NOT NULL,
    "single_occupancy" BOOLEAN NOT NULL,
    "units_used" DECIMAL(10,2) NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "occupied_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "position_source" "PositionSource",
    "created_by_id" UUID,

    CONSTRAINT "location_occupancy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "equipment_type" "EquipmentType" NOT NULL,
    "model" TEXT,
    "status" "EquipmentStatus" NOT NULL DEFAULT 'OFFLINE',
    "charger_location_id" UUID,
    "current_operator_id" UUID,
    "telemetry" JSONB,
    "telemetry_at" TIMESTAMPTZ(6),
    "telemetry_source" "PositionSource",
    "task_summary" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "site_id" UUID,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "diff" JSONB,
    "reason" TEXT,
    "correlation_id" TEXT,
    "ip" TEXT,
    "user_agent" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_version" INTEGER NOT NULL DEFAULT 1,
    "aggregate_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "payload" JSONB NOT NULL,
    "correlation_id" TEXT,
    "site_seq" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "site_event_cursor" (
    "site_id" UUID NOT NULL,
    "last_seq" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "site_event_cursor_pkey" PRIMARY KEY ("site_id")
);

-- CreateTable
CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "role_code_key" ON "role"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permission_code_key" ON "permission"("code");

-- CreateIndex
CREATE INDEX "user_site_role_user_id_idx" ON "user_site_role"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "zone_site_id_idx" ON "zone"("site_id");

-- CreateIndex
CREATE UNIQUE INDEX "location_qr_value_key" ON "location"("qr_value");

-- CreateIndex
CREATE INDEX "location_site_id_zone_id_location_type_idx" ON "location"("site_id", "zone_id", "location_type");

-- CreateIndex
CREATE UNIQUE INDEX "layout_version_site_id_version_no_key" ON "layout_version"("site_id", "version_no");

-- CreateIndex
CREATE INDEX "layout_object_layout_version_id_idx" ON "layout_object"("layout_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "truck_visit_code_key" ON "truck_visit"("code");

-- CreateIndex
CREATE INDEX "truck_visit_site_id_status_idx" ON "truck_visit"("site_id", "status");

-- CreateIndex
CREATE INDEX "truck_visit_site_id_appointment_start_idx" ON "truck_visit"("site_id", "appointment_start");

-- CreateIndex
CREATE INDEX "gate_event_site_id_occurred_at_idx" ON "gate_event"("site_id", "occurred_at");

-- CreateIndex
CREATE INDEX "location_occupancy_occupant_type_occupant_id_started_at_idx" ON "location_occupancy"("occupant_type", "occupant_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "equipment_site_id_status_idx" ON "equipment"("site_id", "status");

-- CreateIndex
CREATE INDEX "audit_log_site_id_occurred_at_idx" ON "audit_log"("site_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_log_entity_type_entity_id_occurred_at_idx" ON "audit_log"("entity_type", "entity_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "outbox_event_event_id_key" ON "outbox_event"("event_id");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_record_user_id_key_key" ON "idempotency_record"("user_id", "key");

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_site_role" ADD CONSTRAINT "user_site_role_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_site_role" ADD CONSTRAINT "user_site_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_site_role" ADD CONSTRAINT "user_site_role_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "site_setting" ADD CONSTRAINT "site_setting_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zone" ADD CONSTRAINT "zone_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "zone"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dock" ADD CONSTRAINT "dock_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_version" ADD CONSTRAINT "layout_version_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "layout_object" ADD CONSTRAINT "layout_object_layout_version_id_fkey" FOREIGN KEY ("layout_version_id") REFERENCES "layout_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck" ADD CONSTRAINT "truck_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "driver" ADD CONSTRAINT "driver_carrier_id_fkey" FOREIGN KEY ("carrier_id") REFERENCES "partner"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_visit" ADD CONSTRAINT "truck_visit_truck_id_fkey" FOREIGN KEY ("truck_id") REFERENCES "truck"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "truck_visit" ADD CONSTRAINT "truck_visit_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_event" ADD CONSTRAINT "gate_event_truck_visit_id_fkey" FOREIGN KEY ("truck_visit_id") REFERENCES "truck_visit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_occupancy" ADD CONSTRAINT "location_occupancy_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ═══════════════════════════════════════════════════════════════════
-- Ràng buộc bổ sung mà Prisma schema không biểu đạt được (mục 14.8)
-- ═══════════════════════════════════════════════════════════════════

-- Mã nghiệp vụ duy nhất, bỏ qua bản ghi soft-deleted
CREATE UNIQUE INDEX ux_site_code ON site (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_zone_code ON zone (site_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_location_code ON location (site_id, code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_partner_code ON partner (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_truck_code ON truck (code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_truck_plate ON truck (plate_number) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX ux_equipment_code ON equipment (site_id, code) WHERE deleted_at IS NULL;

-- Một role chỉ được gán một lần cho user tại một site (NULL = toàn doanh nghiệp)
CREATE UNIQUE INDEX ux_user_site_role_active ON user_site_role (user_id, role_id, site_id)
  NULLS NOT DISTINCT WHERE revoked_at IS NULL;

-- BR-01: location single-capacity chỉ có một occupancy active (RESERVED hoặc OCCUPIED)
CREATE UNIQUE INDEX ux_occupancy_single_location_active
  ON location_occupancy (location_id)
  WHERE released_at IS NULL AND single_occupancy = true;

-- BR-12: một đối tượng vật lý chỉ có một vị trí OCCUPIED và tối đa một chỗ RESERVED
CREATE UNIQUE INDEX ux_occupancy_occupant_active
  ON location_occupancy (occupant_type, occupant_id)
  WHERE released_at IS NULL AND kind = 'OCCUPIED';
CREATE UNIQUE INDEX ux_occupancy_occupant_reserved
  ON location_occupancy (occupant_type, occupant_id)
  WHERE released_at IS NULL AND kind = 'RESERVED';
CREATE INDEX ix_occupancy_location_active ON location_occupancy (site_id, location_id) WHERE released_at IS NULL;

-- BR-13: một truck tối đa một visit active (không double check-in)
CREATE UNIQUE INDEX ux_truck_visit_active
  ON truck_visit (truck_id)
  WHERE status NOT IN ('EXITED','REJECTED','NO_SHOW','CANCELLED');

-- Một layout PUBLISHED mỗi site (BR-37)
CREATE UNIQUE INDEX ux_layout_published ON layout_version (site_id) WHERE status = 'PUBLISHED';

-- Location: single-occupancy bắt buộc cho dock / ô đỗ; capacity dương; blocked phải có lý do
ALTER TABLE location
  ADD CONSTRAINT ck_location_capacity_positive CHECK (capacity_units > 0),
  ADD CONSTRAINT ck_location_single_types CHECK (
    location_type NOT IN ('DOCK','PARKING_SLOT','YARD_SLOT') OR single_occupancy = true),
  ADD CONSTRAINT ck_location_block_reason CHECK (blocked_at IS NULL OR blocked_reason IS NOT NULL);

-- Visit: lịch hẹn hợp lệ
ALTER TABLE truck_visit
  ADD CONSTRAINT ck_visit_appointment CHECK (
    appointment_start IS NULL OR appointment_end IS NULL OR appointment_end > appointment_start);

-- GateEvent: tham chiếu đúng một đối tượng
ALTER TABLE gate_event
  ADD CONSTRAINT ck_gate_event_ref CHECK (num_nonnulls(truck_visit_id, vehicle_stay_id) = 1);

-- Occupancy: OCCUPIED phải có nguồn bằng chứng (D-02)
ALTER TABLE location_occupancy
  ADD CONSTRAINT ck_occupancy_source CHECK (kind = 'RESERVED' OR position_source IS NOT NULL),
  ADD CONSTRAINT ck_occupancy_units CHECK (units_used > 0);

-- Outbox
CREATE INDEX ix_outbox_unpublished ON outbox_event (id) WHERE published_at IS NULL;
CREATE UNIQUE INDEX ux_outbox_site_seq ON outbox_event (site_id, site_seq) WHERE site_seq IS NOT NULL;

-- NOTIFY relay sau commit: NOTIFY trong transaction chỉ được giao khi COMMIT (BR-29)
CREATE FUNCTION notify_outbox() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('outbox_new', '');
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_outbox_notify AFTER INSERT ON outbox_event
  FOR EACH STATEMENT EXECUTE FUNCTION notify_outbox();

-- Bảng lịch sử append-only: chặn UPDATE/DELETE ở mức DB (BR-07, FR-14.04)
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Table % is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_gate_event_append_only BEFORE UPDATE OR DELETE ON gate_event
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
