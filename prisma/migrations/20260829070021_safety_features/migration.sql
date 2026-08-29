-- CreateEnum
CREATE TYPE "WalletSecurityAction" AS ENUM ('FROZEN', 'UNFROZEN', 'MARKED_UNDER_REVIEW', 'REVIEW_CLEARED');

-- CreateEnum
CREATE TYPE "PotStatus" AS ENUM ('OPEN', 'FUNDED', 'SETTLED', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TransactionType" ADD VALUE 'POT_CONTRIBUTION';
ALTER TYPE "TransactionType" ADD VALUE 'POT_PAYOUT';

-- AlterEnum
ALTER TYPE "WalletStatus" ADD VALUE 'UNDER_REVIEW';

-- AlterEnum
ALTER TYPE "WalletType" ADD VALUE 'POT';

-- AlterTable
ALTER TABLE "wallets" ADD COLUMN     "freeze_reason" VARCHAR(200),
ADD COLUMN     "frozen_at" TIMESTAMPTZ(6),
ADD COLUMN     "frozen_by_user_id" UUID,
ADD COLUMN     "reserved_poisha" BIGINT NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "wallet_security_events" (
    "id" BIGSERIAL NOT NULL,
    "wallet_id" UUID NOT NULL,
    "action" "WalletSecurityAction" NOT NULL,
    "previous_status" "WalletStatus" NOT NULL,
    "new_status" "WalletStatus" NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "actor_user_id" UUID,
    "actor_type" "ActorType" NOT NULL DEFAULT 'USER',
    "ip_address" INET,
    "correlation_id" UUID,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pots" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "creator_user_id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "note" VARCHAR(280),
    "target_poisha" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'BDT',
    "status" "PotStatus" NOT NULL DEFAULT 'OPEN',
    "settlement_transaction_id" UUID,
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pot_members" (
    "id" UUID NOT NULL,
    "pot_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "contributed_poisha" BIGINT NOT NULL DEFAULT 0,
    "contribution_count" INTEGER NOT NULL DEFAULT 0,
    "joined_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_contributed_at" TIMESTAMPTZ(6),

    CONSTRAINT "pot_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_envelopes" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "category" VARCHAR(40),
    "icon" VARCHAR(16),
    "reserved_poisha" BIGINT NOT NULL DEFAULT 0,
    "target_poisha" BIGINT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "expense_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "wallet_security_events_wallet_id_occurred_at_idx" ON "wallet_security_events"("wallet_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pots_wallet_id_key" ON "pots"("wallet_id");

-- CreateIndex
CREATE UNIQUE INDEX "pots_settlement_transaction_id_key" ON "pots"("settlement_transaction_id");

-- CreateIndex
CREATE INDEX "pots_creator_user_id_created_at_idx" ON "pots"("creator_user_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pots_status_created_at_idx" ON "pots"("status", "created_at" DESC);

-- CreateIndex
CREATE INDEX "pot_members_user_id_joined_at_idx" ON "pot_members"("user_id", "joined_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "pot_members_pot_id_user_id_key" ON "pot_members"("pot_id", "user_id");

-- CreateIndex
CREATE INDEX "expense_envelopes_wallet_id_created_at_idx" ON "expense_envelopes"("wallet_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "expense_envelopes_wallet_id_name_key" ON "expense_envelopes"("wallet_id", "name");

-- AddForeignKey
ALTER TABLE "wallets" ADD CONSTRAINT "wallets_frozen_by_user_id_fkey" FOREIGN KEY ("frozen_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_security_events" ADD CONSTRAINT "wallet_security_events_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_security_events" ADD CONSTRAINT "wallet_security_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pots" ADD CONSTRAINT "pots_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pots" ADD CONSTRAINT "pots_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pot_members" ADD CONSTRAINT "pot_members_pot_id_fkey" FOREIGN KEY ("pot_id") REFERENCES "pots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pot_members" ADD CONSTRAINT "pot_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_envelopes" ADD CONSTRAINT "expense_envelopes_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "wallets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
