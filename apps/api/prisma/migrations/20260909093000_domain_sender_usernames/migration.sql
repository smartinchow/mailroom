-- Per-domain sender addresses. ACS registers each one as a `senderUsernames`
-- child resource on the domain and refuses a send from anything else, so the
-- list has to be per domain (support@tintinpos.com, sales@maro.com.au) rather
-- than one platform-wide list on the carrier.
--
-- Entries are `{ "username": "support", "displayName": "TinTin POS Support" }`.
-- An empty array means "not configured": the carrier's own list is used and
-- nothing is removed at the provider.

-- AlterTable
ALTER TABLE "Domain" ADD COLUMN     "senderUsernames" JSONB NOT NULL DEFAULT '[]';
