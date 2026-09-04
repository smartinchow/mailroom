-- CreateEnum
CREATE TYPE "DomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'TEMPORARY_FAILURE');

-- AlterTable
ALTER TABLE "Carrier" ADD COLUMN     "isDefault" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "dnsRecords" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "lastCheckedAt" TIMESTAMP(3),
ADD COLUMN     "mailFromDomain" TEXT,
ADD COLUMN     "status" "DomainStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "verificationError" TEXT;

-- Data fix-up: every Domain that existed before this migration is a live
-- production sender (tx.amlify.au, tintinpos.com, maro.com.au). They were
-- verified out of band with the carrier, so they must not land in PENDING and
-- start failing the D-07 send gate.
UPDATE "Domain" SET "status" = 'VERIFIED', "verifiedAt" = COALESCE("verifiedAt", CURRENT_TIMESTAMP);

-- No carrier is default after this migration; the platform SES carrier is
-- flagged via PATCH /v1/admin/carriers/:id { "isDefault": true } as an ops step.
