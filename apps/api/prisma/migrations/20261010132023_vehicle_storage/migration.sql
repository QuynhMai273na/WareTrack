-- CreateEnum
CREATE TYPE "VehicleStayStatus" AS ENUM ('EXPECTED', 'RECEIVED', 'INSPECTED', 'ALLOCATED', 'STORED', 'RELEASE_REQUESTED', 'RELEASED', 'EXITED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "VehicleCondition" AS ENUM ('OK', 'MINOR_DAMAGE', 'MAJOR_DAMAGE', 'NEEDS_SERVICE');

-- CreateEnum
CREATE TYPE "ReleaseRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "stored_vehicle" (
    "id" UUID NOT NULL,
    "vin" TEXT NOT NULL,
    "make" TEXT,
    "model" TEXT,
    "model_year" INTEGER,
    "color" TEXT,
    "plate_number" TEXT,
    "owner_partner_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stored_vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_stay" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "vehicle_id" UUID NOT NULL,
    "status" "VehicleStayStatus" NOT NULL,
    "condition_status" "VehicleCondition" NOT NULL DEFAULT 'OK',
    "hold_flag" BOOLEAN NOT NULL DEFAULT false,
    "hold_reason" TEXT,
    "odometer_km" INTEGER,
    "fuel_or_battery_pct" INTEGER,
    "key_tag" TEXT,
    "expected_at" TIMESTAMPTZ(6),
    "received_at" TIMESTAMPTZ(6),
    "stored_at" TIMESTAMPTZ(6),
    "released_at" TIMESTAMPTZ(6),
    "exited_at" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "vehicle_stay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vehicle_inspection" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "vehicle_stay_id" UUID NOT NULL,
    "inspection_type" TEXT NOT NULL,
    "checklist" JSONB NOT NULL,
    "result_condition" "VehicleCondition" NOT NULL,
    "inspector_id" UUID,
    "inspected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vehicle_inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release_request" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "vehicle_stay_id" UUID NOT NULL,
    "status" "ReleaseRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "recipient_name" TEXT NOT NULL,
    "planned_at" TIMESTAMPTZ(6),
    "requested_by_id" UUID NOT NULL,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "decision_note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stored_vehicle_vin_key" ON "stored_vehicle"("vin");

-- CreateIndex
CREATE INDEX "vehicle_stay_site_id_status_idx" ON "vehicle_stay"("site_id", "status");

-- CreateIndex
CREATE INDEX "vehicle_inspection_vehicle_stay_id_idx" ON "vehicle_inspection"("vehicle_stay_id");

-- CreateIndex
CREATE INDEX "release_request_vehicle_stay_id_idx" ON "release_request"("vehicle_stay_id");

-- AddForeignKey
ALTER TABLE "vehicle_stay" ADD CONSTRAINT "vehicle_stay_vehicle_id_fkey" FOREIGN KEY ("vehicle_id") REFERENCES "stored_vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vehicle_inspection" ADD CONSTRAINT "vehicle_inspection_vehicle_stay_id_fkey" FOREIGN KEY ("vehicle_stay_id") REFERENCES "vehicle_stay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release_request" ADD CONSTRAINT "release_request_vehicle_stay_id_fkey" FOREIGN KEY ("vehicle_stay_id") REFERENCES "vehicle_stay"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BR-14: một xe lưu bãi tối đa một stay active (không double check-in)
CREATE UNIQUE INDEX ux_vehicle_stay_active ON vehicle_stay (vehicle_id) WHERE status NOT IN ('EXITED','CANCELLED');
-- Một yêu cầu release đang mở mỗi stay
CREATE UNIQUE INDEX ux_release_request_open ON release_request (vehicle_stay_id) WHERE status IN ('PENDING','APPROVED');
-- Maker-checker ở mức DB (DEC-19)
ALTER TABLE release_request ADD CONSTRAINT ck_release_maker_checker CHECK (decided_by_id IS NULL OR decided_by_id <> requested_by_id);
ALTER TABLE vehicle_stay ADD CONSTRAINT ck_vehicle_hold_reason CHECK (hold_flag = false OR hold_reason IS NOT NULL);
ALTER TABLE stored_vehicle ADD CONSTRAINT ck_vin_format CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$');
CREATE TRIGGER trg_vehicle_inspection_append_only BEFORE UPDATE OR DELETE ON vehicle_inspection
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
