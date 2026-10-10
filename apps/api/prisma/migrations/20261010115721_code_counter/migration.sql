-- CreateTable
CREATE TABLE "code_counter" (
    "scope" TEXT NOT NULL,
    "value" BIGINT NOT NULL DEFAULT 0,

    CONSTRAINT "code_counter_pkey" PRIMARY KEY ("scope")
);
