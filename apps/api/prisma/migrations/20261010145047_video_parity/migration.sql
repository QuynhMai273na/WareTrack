-- AlterEnum
ALTER TYPE "SiteType" ADD VALUE 'DEPOT';

-- AlterTable
ALTER TABLE "location" ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "sku" ADD COLUMN     "category" TEXT;
