-- CreateTable
CREATE TABLE "notification" (
    "id" UUID NOT NULL,
    "site_id" UUID,
    "user_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'INFO',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "read_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_user_id_created_at_idx" ON "notification"("user_id", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "ux_notification_event_user" ON "notification"("event_id", "user_id");
